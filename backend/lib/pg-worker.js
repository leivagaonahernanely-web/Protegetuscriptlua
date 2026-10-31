// Hilo de trabajo: mantiene la conexión a PostgreSQL y atiende las consultas que llegan
// desde el hilo principal por memoria compartida (ver lib/db-engine.js).
import { workerData } from 'node:worker_threads';
import { translateSql, translateScript } from './sql-translate.js';

const { sab, url, backend } = workerData;
// Mantiene vivo el hilo: una espera asíncrona pendiente no cuenta como actividad para Node
const keepAlive = setInterval(() => {}, 1 << 30);
const ctrl = new Int32Array(sab, 0, 4);   // [0]=estado, [1]=largo petición, [2]=largo respuesta, [3]=listo (0/1/2)
const data = new Uint8Array(sab, 16);
const enc = new TextEncoder();
const dec = new TextDecoder();

// Estados de ctrl[0]: 0 = libre, 1 = petición lista, 2 = respuesta lista
const IDLE = 0, REQUEST = 1, RESPONSE = 2;

let client;
let schema = { pk: new Map(), idTables: new Set() };

async function loadSchema() {
  const ids = await client.query(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'");
  schema.idTables = new Set(ids.rows.map(r => r.table_name));
  const pks = await client.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema()
    ORDER BY kcu.ordinal_position`);
  const pk = new Map();
  for (const r of pks.rows) {
    if (!pk.has(r.table_name)) pk.set(r.table_name, []);
    pk.get(r.table_name).push(r.column_name);
  }
  schema.pk = pk;
}

function errorCode(err) {
  // 53100 = disco lleno en PostgreSQL. Se expone con el mismo código que usaba SQLite para que el servidor responda igual.
  if (err.code === '53100') return 'SQLITE_FULL';
  return err.code ? `PG_${err.code}` : 'PG_ERROR';
}

async function handle(req) {
  if (req.op === 'exec') {
    for (const st of translateScript(req.sql, schema)) await client.query(st);
    if (/\b(CREATE|ALTER|DROP)\b/i.test(req.sql)) await loadSchema();
    return null;
  }
  const pgSql = translateSql(req.sql, schema);
  if (pgSql === null) {
    if (req.op === 'all') return [];
    if (req.op === 'run') return { changes: 0, lastInsertRowid: 0 };
    return undefined;
  }
  const params = (req.params || []).map(v => (v === undefined ? null : v));
  const r = await client.query(pgSql, params);
  if (req.op === 'get') return r.rows[0];
  if (req.op === 'all') return r.rows;
  // run: lastInsertRowid = id devuelto (solo tablas con columna id)
  const id = r.rows && r.rows[0] ? r.rows[0].id : undefined;
  return { changes: r.rowCount || 0, lastInsertRowid: id != null ? Number(id) : 0 };
}

async function serve() {
  for (;;) {
    const st = Atomics.load(ctrl, 0);
    if (st !== REQUEST) {
      await Atomics.waitAsync(ctrl, 0, st).value;
      continue;
    }
    const len = Atomics.load(ctrl, 1);
    const req = JSON.parse(dec.decode(data.subarray(0, len)));
    let out;
    try {
      out = { result: await handle(req) };
    } catch (err) {
      out = { error: { message: err.message, code: errorCode(err) } };
    }
    let bytes = enc.encode(JSON.stringify(out));
    if (bytes.length > data.length) {
      bytes = enc.encode(JSON.stringify({ error: { message: 'Respuesta demasiado grande para el puente de base de datos', code: 'PG_TOO_LARGE' } }));
    }
    data.set(bytes, 0);
    Atomics.store(ctrl, 2, bytes.length);
    Atomics.store(ctrl, 0, RESPONSE);
    Atomics.notify(ctrl, 0);
  }
}

function reportStartupError(err) {
  const bytes = enc.encode(String(err && err.message ? err.message : err)).subarray(0, data.length);
  data.set(bytes, 0);
  Atomics.store(ctrl, 2, bytes.length);
  Atomics.store(ctrl, 3, 2);
  Atomics.notify(ctrl, 3);
}

(async () => {
  try {
    const mod = backend ? await import(backend) : await import('pg');
    const pg = mod.default && mod.default.Client ? mod.default : mod;
    if (pg.types && pg.types.setTypeParser) {
      pg.types.setTypeParser(20, v => Number(v));    // int8 (COUNT(*)) → número, como SQLite
      pg.types.setTypeParser(1700, v => Number(v));  // numeric → número
    }
    client = new pg.Client({
      connectionString: url,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    // Un corte de conexión no debe tumbar el hilo: la siguiente consulta devolverá un error
    client.on('error', err => console.error('[pg] conexión perdida:', err.message));
    await client.connect();
    await loadSchema();
    Atomics.store(ctrl, 3, 1);
    Atomics.notify(ctrl, 3);
    await serve();
  } catch (err) {
    reportStartupError(err);
  }
})();
