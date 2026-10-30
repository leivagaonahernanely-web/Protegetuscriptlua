import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateSql, translateScript } from '../lib/sql-translate.js';

const schema = {
  pk: new Map([
    ['obf_cache', ['hash']],
    ['bot_blacklist', ['script_id', 'discord_id']],
    ['bot_settings', ['owner', 'name']],
  ]),
  idTables: new Set(['scripts', 'keys']),
};

test('convierte los ? en $1, $2... sin tocar literales', () => {
  const s = translateSql("SELECT * FROM keys WHERE script_id = ? AND note = 'a?b' AND x = ?", schema);
  assert.equal(s, "SELECT * FROM keys WHERE script_id = $1 AND note = 'a?b' AND x = $2");
});

test('INSERT OR REPLACE usa ON CONFLICT con la clave primaria', () => {
  const s = translateSql('INSERT OR REPLACE INTO obf_cache (hash, content, created_at) VALUES (?, ?, ?)', schema);
  assert.equal(s, 'INSERT INTO obf_cache (hash, content, created_at) VALUES ($1, $2, $3) ON CONFLICT (hash) DO UPDATE SET content = EXCLUDED.content, created_at = EXCLUDED.created_at');
});

test('INSERT OR REPLACE con clave compuesta', () => {
  const s = translateSql('INSERT OR REPLACE INTO bot_blacklist (script_id, discord_id, reason, created_at) VALUES (?, ?, ?, ?)', schema);
  assert.match(s, /ON CONFLICT \(script_id, discord_id\) DO UPDATE SET reason = EXCLUDED\.reason, created_at = EXCLUDED\.created_at$/);
});

test('INSERT OR IGNORE → ON CONFLICT DO NOTHING', () => {
  const s = translateSql('INSERT OR IGNORE INTO web_chat_words (word) VALUES (?)', schema);
  assert.equal(s, 'INSERT INTO web_chat_words (word) VALUES ($1) ON CONFLICT DO NOTHING');
});

test('INSERT en tabla con id pide RETURNING id', () => {
  assert.equal(translateSql('INSERT INTO scripts (name) VALUES (?)', schema), 'INSERT INTO scripts (name) VALUES ($1) RETURNING id');
  assert.equal(translateSql('INSERT INTO bot_settings (owner, name, value) VALUES (?, ?, ?)', schema),
    'INSERT INTO bot_settings (owner, name, value) VALUES ($1, $2, $3)');
});

test('PRAGMA table_info se traduce a information_schema', () => {
  const s = translateSql('PRAGMA table_info(scripts)', schema);
  assert.match(s, /information_schema\.columns/);
  assert.match(s, /table_name = 'scripts'/);
});

test('pragma_table_info dentro de un SELECT', () => {
  const s = translateSql("SELECT 1 FROM pragma_table_info('keys') WHERE name = 'exec_count'", schema);
  assert.match(s, /^SELECT 1 FROM \(SELECT column_name AS name FROM information_schema\.columns .*table_name = 'keys'\) WHERE name = 'exec_count'$/);
});

test('otros PRAGMA se ignoran', () => {
  assert.deepEqual(translateScript('PRAGMA journal_mode = WAL;', schema), []);
});

test('strftime con desplazamiento de zona horaria', () => {
  const s = translateSql("SELECT strftime('%Y-%m-%d', created_at, 'unixepoch', '-5 hours') AS day FROM script_logs", schema);
  assert.equal(s, "SELECT to_char((to_timestamp(created_at) AT TIME ZONE 'UTC') + interval '-5 hours', 'YYYY-MM-DD') AS day FROM script_logs");
});

test('strftime sin desplazamiento', () => {
  const s = translateSql("SELECT strftime('%Y-%m', used_at, 'unixepoch') AS month FROM plan_keys", schema);
  assert.equal(s, "SELECT to_char((to_timestamp(used_at) AT TIME ZONE 'UTC'), 'YYYY-MM') AS month FROM plan_keys");
});

test('LIKE pasa a ILIKE (SQLite es insensible a mayúsculas)', () => {
  const s = translateSql("SELECT * FROM webhooks WHERE events LIKE ? AND text LIKE '%Script ejecutado%'", schema);
  assert.equal(s, "SELECT * FROM webhooks WHERE events ILIKE $1 AND text ILIKE '%Script ejecutado%'");
});

test('AUTOINCREMENT en CREATE TABLE → SERIAL', () => {
  const s = translateScript('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);', schema);
  assert.equal(s[0], 'CREATE TABLE IF NOT EXISTS t (id SERIAL PRIMARY KEY, name TEXT)');
});

test('db.exec con varias sentencias y INSERT OR IGNORE ... SELECT', () => {
  const script = `
    CREATE TABLE IF NOT EXISTS x (a INTEGER);
    INSERT OR IGNORE INTO execution_daily (script_id, day, n)
    SELECT script_id, strftime('%Y-%m-%d', created_at, 'unixepoch', '-5 hours'), COUNT(*) FROM script_logs
    WHERE text LIKE '%Script ejecutado%' GROUP BY script_id, strftime('%Y-%m-%d', created_at, 'unixepoch', '-5 hours');
  `;
  const out = translateScript(script, schema);
  assert.equal(out.length, 2);
  assert.match(out[1], /ON CONFLICT DO NOTHING$/);
  assert.match(out[1], /ILIKE/);
});

test('valores con comillas escapadas no rompen el conteo de ?', () => {
  const s = translateSql("SELECT 'it''s ?' , ? FROM keys", schema);
  assert.equal(s, "SELECT 'it''s ?' , $1 FROM keys");
});

test('ON CONFLICT DO UPDATE SET n = n + 1 califica la columna de la tabla', () => {
  const s = translateSql('INSERT INTO execution_daily (script_id, day, n) VALUES (?, ?, 1) ON CONFLICT(script_id, day) DO UPDATE SET n = n + 1', schema);
  assert.equal(s, 'INSERT INTO execution_daily (script_id, day, n) VALUES ($1, $2, 1) ON CONFLICT(script_id, day) DO UPDATE SET n = execution_daily.n + 1');
});
