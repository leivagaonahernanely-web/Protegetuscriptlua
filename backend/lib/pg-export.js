// Copia una base PostgreSQL a un archivo SQLite con el mismo esquema y los mismos datos.
// El archivo sirve como respaldo descargable y, en modo SQLite, se restaura con /api/owner/import-db.
//
// query(sql) devuelve las filas de una consulta de solo lectura (en producción: op 'raw' del puente).
// Database es el constructor de better-sqlite3 (en las pruebas se usa node:sqlite).
// Las filas se leen por páginas para no superar el tamaño máximo de respuesta del puente.

const PAGE = 2000;
// Tablas de caché: se regeneran solas y no entran al respaldo
const SKIP_TABLES = new Set(['obf_cache']);

const ident = name => `"${String(name).replace(/"/g, '""')}"`;
const literal = value => `'${String(value).replace(/'/g, "''")}'`;

// PostgreSQL -> afinidad de SQLite
function affinity(pgType) {
  const t = String(pgType || '').toLowerCase();
  // Las fechas de la app son milisegundos enteros: se guardan como INTEGER, no como texto
  if (/int|serial|bool|timestamp|date/.test(t)) return 'INTEGER';
  if (/double|real|numeric|float/.test(t)) return 'REAL';
  return 'TEXT';
}

// Valor de PostgreSQL -> valor que acepta SQLite
function toSqlite(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function listTables(query) {
  return query(`SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)
    .map(r => r.name)
    .filter(name => !SKIP_TABLES.has(name));
}

function listColumns(query, table) {
  return query(`SELECT column_name AS name, data_type AS type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${literal(table)} ORDER BY ordinal_position`);
}

// Columnas de cada restricción (PRIMARY KEY o UNIQUE), agrupadas por nombre de restricción
function listConstraints(query, table, type) {
  const rows = query(`SELECT tc.constraint_name AS constraint, kcu.column_name AS column, kcu.ordinal_position AS pos
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = ${literal(table)} AND tc.constraint_type = ${literal(type)}
    ORDER BY tc.constraint_name, kcu.ordinal_position`);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.constraint)) groups.set(r.constraint, []);
    groups.get(r.constraint).push(r.column);
  }
  return [...groups.values()];
}

function createTable(out, table, columns, primaryKeys, uniques) {
  const defs = columns.map(c => `${ident(c.name)} ${affinity(c.type)}`);
  if (primaryKeys.length === 1) {
    const idx = columns.findIndex(c => c.name === primaryKeys[0]);
    defs[idx] += ' PRIMARY KEY';
  } else if (primaryKeys.length > 1) {
    defs.push(`PRIMARY KEY (${primaryKeys.map(ident).join(', ')})`);
  }
  for (const cols of uniques) defs.push(`UNIQUE (${cols.map(ident).join(', ')})`);
  out.exec(`CREATE TABLE ${ident(table)} (${defs.join(', ')})`);
}

function copyRows(query, out, table, columns, primaryKeys) {
  const names = columns.map(c => c.name);
  const insert = out.prepare(`INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
  // Orden estable para paginar: la clave primaria, o ctid si la tabla no tiene
  const order = primaryKeys.length ? primaryKeys.map(ident).join(', ') : 'ctid';
  for (let offset = 0; ; offset += PAGE) {
    const rows = query(`SELECT * FROM ${ident(table)} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`);
    for (const row of rows) insert.run(...names.map(n => toSqlite(row[n])));
    if (rows.length < PAGE) break;
  }
}

export function exportToSqlite(query, file, Database) {
  const out = new Database(file);
  try {
    out.exec('BEGIN');
    for (const table of listTables(query)) {
      const columns = listColumns(query, table);
      const primaryKeys = listConstraints(query, table, 'PRIMARY KEY')[0] || [];
      const uniques = listConstraints(query, table, 'UNIQUE');
      createTable(out, table, columns, primaryKeys, uniques);
      copyRows(query, out, table, columns, primaryKeys);
    }
    out.exec('COMMIT');
  } catch (err) {
    try { out.exec('ROLLBACK'); } catch { /* sin transacción abierta */ }
    out.close();
    throw err;
  }
  out.close();
  return file;
}
