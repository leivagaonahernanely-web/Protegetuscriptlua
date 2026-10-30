import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPostgresBridge } from '../lib/db-engine.js';

const backend = new URL('./fake-pg.js', import.meta.url).href;

test('puente síncrono: get/all/run devuelven resultados traducidos', () => {
  const db = openPostgresBridge('postgres://fake', { backend });
  try {
    const row = db.prepare('SELECT ? AS v').get(5);
    assert.equal(row.sql_seen, 'SELECT $1 AS v');
    assert.deepEqual(row.p, [5]);

    const rows = db.prepare('SELECT ? AS v, ? AS w').all([1, 'x']);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].p, [1, 'x']);

    const info = db.prepare('INSERT INTO scripts (name) VALUES (?)').run('demo');
    assert.equal(info.lastInsertRowid, 7);
    assert.equal(info.changes, 1);
  } finally {
    db.close();
  }
});

test('transacciones y exec con varias sentencias', () => {
  const db = openPostgresBridge('postgres://fake', { backend });
  try {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT); SELECT 1;');
    const out = db.transaction((x) => db.prepare('SELECT ? AS v').get(x).p[0])(42);
    assert.equal(out, 42);
  } finally {
    db.close();
  }
});

test('un error de disco lleno llega con código SQLITE_FULL', () => {
  const db = openPostgresBridge('postgres://fake', { backend });
  try {
    assert.throws(() => db.prepare('SELECT boom').get(), (err) => err.code === 'SQLITE_FULL');
    // Después del error el puente sigue funcionando
    assert.equal(db.prepare('SELECT ? AS v').get(9).p[0], 9);
  } finally {
    db.close();
  }
});
