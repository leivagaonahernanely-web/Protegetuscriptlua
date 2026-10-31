// Traduce las consultas escritas en dialecto SQLite (así está todo el código de Vantarmor)
// al dialecto de PostgreSQL. Solo se usa cuando DB_ENGINE=postgres.
//
// schema = {
//   pk:      Map(tabla -> [columnas de la clave primaria]),
//   idTables: Set(tablas que tienen columna "id"),
// }

// Divide el SQL en trozos: los literales entre comillas simples no se tocan.
function mapUnquoted(sql, fn) {
  let out = '';
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (!inQuote) {
        out += fn(buf);
        buf = '';
        inQuote = true;
        out += "'";
      } else {
        // '' dentro de un literal es una comilla escapada
        if (sql[i + 1] === "'") { out += "''"; i++; continue; }
        inQuote = false;
        out += buf + "'";
        buf = '';
      }
      continue;
    }
    if (inQuote) out += ch;
    else buf += ch;
  }
  out += inQuote ? buf : fn(buf);
  return out;
}

const STRF_FMT = { '%Y': 'YYYY', '%m': 'MM', '%d': 'DD', '%H': 'HH24', '%M': 'MI', '%S': 'SS' };

// strftime('%Y-%m-%d', columna, 'unixepoch'[, '-5 hours'])  →  to_char(...)
function translateStrftime(sql) {
  return sql.replace(/strftime\(\s*'([^']*)'\s*,\s*([^,()]+?)\s*,\s*'unixepoch'(?:\s*,\s*'([+-]?\d+)\s+hours')?\s*\)/gi,
    (_, fmt, col, hours) => {
      const pgFmt = fmt.replace(/%[YmdHMS]/g, m => STRF_FMT[m] || m).replace(/-/g, '-');
      const shift = hours ? ` + interval '${Number(hours)} hours'` : '';
      // to_timestamp(...) AT TIME ZONE 'UTC' evita depender de la zona horaria de la sesión
      return `to_char((to_timestamp(${col}) AT TIME ZONE 'UTC')${shift}, '${pgFmt}')`;
    });
}

// pragma_table_info('tabla') dentro de un SELECT
function translatePragmaFunction(sql) {
  return sql.replace(/pragma_table_info\(\s*'(\w+)'\s*\)/gi,
    (_, table) => `(SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}')`);
}

// Pasa un valor de sql a la forma de pg. Devuelve null para sentencias que se ignoran (PRAGMA de SQLite).
function translateOne(sql, schema) {
  let s = sql.trim().replace(/;+\s*$/, '');

  // PRAGMA table_info(tabla) → lista de columnas
  const pragma = s.match(/^PRAGMA\s+table_info\(\s*(\w+)\s*\)$/i);
  if (pragma) {
    return `SELECT column_name AS name, ordinal_position - 1 AS cid FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${pragma[1]}' ORDER BY ordinal_position`;
  }
  // Otros PRAGMA (journal_mode, foreign_keys...) no aplican a PostgreSQL
  if (/^PRAGMA\b/i.test(s)) return null;

  s = translatePragmaFunction(s);
  s = translateStrftime(s);

  s = mapUnquoted(s, seg => {
    let t = seg;
    t = t.replace(/\bLIKE\b/gi, 'ILIKE');
    t = t.replace(/\bINTEGER\s+PRIMARY\s+KEY(\s+AUTOINCREMENT)?/gi, 'SERIAL PRIMARY KEY');
    return t;
  });

  // INSERT OR IGNORE → ON CONFLICT DO NOTHING
  if (/^INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    s = s + ' ON CONFLICT DO NOTHING';
  }

  // INSERT OR REPLACE → ON CONFLICT (clave) DO UPDATE SET ...
  const rep = s.match(/^INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  if (rep) {
    const table = rep[1];
    const cols = rep[2].split(',').map(c => c.trim()).filter(Boolean);
    const pk = schema.pk.get(table);
    if (!pk || !pk.length) throw new Error(`[pg] la tabla ${table} no tiene clave primaria para INSERT OR REPLACE`);
    s = s.replace(/^INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO');
    const updates = cols.filter(c => !pk.includes(c)).map(c => `${c} = EXCLUDED.${c}`);
    s = s + ` ON CONFLICT (${pk.join(', ')}) ` + (updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING');
  }

  // En ON CONFLICT ... DO UPDATE SET n = n + 1, PostgreSQL necesita calificar la columna de la tabla
  const upd = s.match(/^INSERT\s+INTO\s+(\w+)[\s\S]*?DO\s+UPDATE\s+SET\s+([\s\S]*)$/i);
  if (upd) {
    const table = upd[1];
    const head = s.slice(0, s.length - upd[2].length);
    const assigns = upd[2].split(',').map(a => a.trim());
    const targets = assigns.map(a => (a.match(/^(\w+)\s*=/) || [])[1]).filter(Boolean);
    const qualified = assigns.map(a => {
      const [lhs, ...rest] = a.split('=');
      let rhs = rest.join('=');
      for (const col of targets) rhs = rhs.replace(new RegExp(`(^|[^.\\w])${col}\\b`, 'g'), `$1${table}.${col}`);
      return `${lhs.trim()} = ${rhs.trim()}`;
    });
    s = head + qualified.join(', ');
  }

  // INSERT sin RETURNING: pedimos el id para emular lastInsertRowid
  const ins = s.match(/^INSERT\s+(?:INTO\s+)?(\w+)/i);
  if (ins && !/\bRETURNING\b/i.test(s) && schema.idTables.has(ins[1])) {
    s = s + ' RETURNING id';
  }

  // ? → $1, $2, ... (solo fuera de literales)
  let n = 0;
  s = mapUnquoted(s, seg => seg.replace(/\?/g, () => `$${++n}`));

  return s;
}

// Parte un script en sentencias (para db.exec con varias sentencias)
export function splitStatements(script) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "'") inQuote = !inQuote;
    if (ch === ';' && !inQuote) { if (cur.trim()) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function translateSql(sql, schema) {
  return translateOne(sql, schema);
}

// Devuelve la lista de sentencias pg para un script de db.exec()
export function translateScript(script, schema) {
  return splitStatements(script)
    .map(st => translateOne(st, schema))
    .filter(st => st !== null);
}

// Cuenta los parámetros ? de una consulta traducida (sanity check)
export function countPlaceholders(pgSql) {
  return (pgSql.match(/\$\d+/g) || []).length;
}
