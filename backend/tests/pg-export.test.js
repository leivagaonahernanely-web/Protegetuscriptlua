// Prueba la copia PostgreSQL -> SQLite con un "PostgreSQL" simulado en memoria.
// Usa node:sqlite como constructor porque better-sqlite3 no está en este entorno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportToSqlite } from '../lib/pg-export.js';

// Tablas con la forma que devuelve information_schema
const TABLES = {
  scripts: {
    columns: [['id', 'bigint'], ['name', 'text'], ['slug', 'text'], ['ffa', 'integer'], ['meta', 'jsonb'], ['created_at', 'timestamp with time zone']],
    pk: ['id'],
    unique: [['slug']],
    rows: Array.from({ length: 5 }, (_, i) => ({
      id: i + 1, name: `Script ${i + 1}`, slug: `script-${i + 1}`, ffa: i % 2, meta: { n: i }, created_at: new Date(1700000000000 + i),
    })),
  },
  flags: {
    columns: [['enabled', 'boolean'], ['owner', 'text'], ['count', 'bigint']],
    pk: ['owner', 'enabled'],
    unique: [],
    rows: [{ enabled: true, owner: 'a', count: 7n }, { enabled: false, owner: 'b', count: null }],
  },
  logs: {
    columns: [['text', 'text'], ['n', 'integer']],
    pk: [],
    unique: [],
    rows: Array.from({ length: 4500 }, (_, i) => ({ text: `línea ${i}`, n: i })),
  },
  obf_cache: {
    columns: [['hash', 'text']], pk: ['hash'], unique: [], rows: [{ hash: 'x' }],
  },
};

// Simula el puente: responde las consultas que usa pg-export.js
function fakeQuery(sql) {
  if (sql.includes('information_schema.tables')) {
    return Object.keys(TABLES).map(name => ({ name }));
  }
  if (sql.includes('information_schema.columns')) {
    const table = sql.match(/table_name = '((?:[^']|'')*)'/)[1].replace(/''/g, "'");
    return TABLES[table].columns.map(([name, type], i) => ({ name, type, ordinal: i + 1 }));
  }
  if (sql.includes('table_constraints')) {
    const table = sql.match(/table_name = '((?:[^']|'')*)'/)[1].replace(/''/g, "'");
    const type = sql.match(/constraint_type = '([A-Z ]+)'/)[1];
    const t = TABLES[table];
    const groups = type === 'PRIMARY KEY' ? (t.pk.length ? [t.pk] : []) : t.unique;
    return groups.flatMap((cols, g) => cols.map((column, i) => ({ constraint: `${table}_${type}_${g}`, column, pos: i + 1 })));
  }
  const m = sql.match(/^SELECT \* FROM "((?:[^"]|"")*)" ORDER BY .* LIMIT (\d+) OFFSET (\d+)$/);
  if (m) {
    const table = m[1].replace(/""/g, '"');
    const limit = Number(m[2]);
    const offset = Number(m[3]);
    return TABLES[table].rows.slice(offset, offset + limit);
  }
  throw new Error(`consulta no simulada: ${sql}`);
}

test('copia tablas, datos, claves y tipos a un archivo SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgexp-'));
  const file = path.join(dir, 'copia.db');
  try {
    exportToSqlite(fakeQuery, file, DatabaseSync);
    const db = new DatabaseSync(file, { readOnly: true });

    // obf_cache se omite (caché)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
    assert.deepEqual(tables, ['flags', 'logs', 'scripts']);

    // Filas y conteos
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scripts').get().n, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n, 4500);

    // Paginación: la última fila de logs está completa y en orden
    assert.equal(db.prepare('SELECT text FROM logs WHERE n = 4499').get().text, 'línea 4499');

    // Booleanos a 0/1, bigint a número, nulos
    const flag = db.prepare("SELECT enabled, count FROM flags WHERE owner = 'a'").get();
    assert.equal(flag.enabled, 1);
    assert.equal(flag.count, 7);
    assert.equal(db.prepare("SELECT count FROM flags WHERE owner = 'b'").get().count, null);

    // JSON como texto y fechas como milisegundos
    assert.equal(db.prepare('SELECT meta FROM scripts WHERE id = 3').get().meta, '{"n":2}');
    assert.equal(db.prepare('SELECT created_at FROM scripts WHERE id = 1').get().created_at, 1700000000000);

    // La clave primaria existe: insertar duplicado debe fallar
    assert.throws(() => db.prepare("INSERT INTO scripts (id, name) VALUES (1, 'dup')").run());
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('si falla a mitad, no deja un archivo a medias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgexp-'));
  const file = path.join(dir, 'roto.db');
  const failing = (sql) => {
    if (sql.includes('"logs"') && sql.startsWith('SELECT * FROM')) throw new Error('boom');
    return fakeQuery(sql);
  };
  try {
    assert.throws(() => exportToSqlite(failing, file, DatabaseSync), /boom/);
    // Lo que quedó escrito no debe tener tablas completas: la transacción se revierte
    const db = new DatabaseSync(file, { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    db.close();
    assert.equal(n, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
