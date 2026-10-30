// Abre la base de datos. Por defecto SQLite (better-sqlite3).
// Con DB_ENGINE=postgres usa PostgreSQL mediante un hilo de trabajo (lib/pg-worker.js).
//
// La API es la misma que better-sqlite3 (prepare().get/all/run, exec, transaction), así que
// el resto del código no cambia. Las consultas a PostgreSQL son asíncronas, por eso el hilo
// principal espera cada resultado con Atomics.wait sobre memoria compartida.
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SAB_BYTES = 64 * 1024 * 1024;   // tamaño máximo de una petición o respuesta
const DATA_OFFSET = 16;               // bytes reservados para el control (4 Int32)
const CONNECT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 120000;

export function openPostgresBridge(url, { backend } = {}) {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const ctrl = new Int32Array(sab, 0, 4);
  const data = new Uint8Array(sab, DATA_OFFSET);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const worker = new Worker(new URL('./pg-worker.js', import.meta.url), {
    workerData: { sab, url, backend },
  });
  worker.on('error', err => console.error('[pg] error en el hilo de base de datos:', err.message));

  // Espera a que el hilo conecte y cargue el esquema
  const startDeadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Atomics.load(ctrl, 3) === 0) {
    if (Date.now() > startDeadline) throw new Error('[pg] tiempo agotado al conectar con PostgreSQL');
    Atomics.wait(ctrl, 3, 0, 500);
  }
  if (Atomics.load(ctrl, 3) === 2) {
    const len = Atomics.load(ctrl, 2);
    throw new Error(`[pg] no se pudo conectar con PostgreSQL: ${dec.decode(data.subarray(0, len))}`);
  }

  // Una llamada síncrona: escribe la petición, despierta al hilo y espera la respuesta
  function call(op, sql, params = []) {
    const bytes = enc.encode(JSON.stringify({ op, sql, params }));
    if (bytes.length > data.length) throw new Error('[pg] la consulta supera el tamaño máximo del puente');
    data.set(bytes, 0);
    Atomics.store(ctrl, 1, bytes.length);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);

    const deadline = Date.now() + CALL_TIMEOUT_MS;
    while (Atomics.load(ctrl, 0) !== 2) {
      if (Date.now() > deadline) throw new Error('[pg] tiempo agotado esperando a PostgreSQL');
      Atomics.wait(ctrl, 0, 1, 1000);
    }
    const len = Atomics.load(ctrl, 2);
    const out = JSON.parse(dec.decode(data.subarray(0, len)));
    Atomics.store(ctrl, 0, 0);
    Atomics.notify(ctrl, 0);

    if (out.error) {
      const err = new Error(out.error.message);
      err.code = out.error.code;
      throw err;
    }
    return out.result;
  }

  const flat = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);

  const db = {
    exec(sql) {
      call('exec', sql);
      return this;
    },
    prepare(sql) {
      return {
        get: (...args) => call('get', sql, flat(args)),
        all: (...args) => call('all', sql, flat(args)),
        run: (...args) => call('run', sql, flat(args)),
      };
    },
    transaction(fn) {
      return (...args) => {
        call('exec', 'BEGIN');
        try {
          const result = fn(...args);
          call('exec', 'COMMIT');
          return result;
        } catch (err) {
          try { call('exec', 'ROLLBACK'); } catch { /* la conexión ya no existe */ }
          throw err;
        }
      };
    },
    pragma() { return []; },
    close() { worker.terminate(); },
  };
  return db;
}

export function openDatabase(sqlitePath) {
  if (process.env.DB_ENGINE === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DB_ENGINE=postgres requiere la variable DATABASE_URL');
    console.log('🗄️  Base de datos: PostgreSQL');
    return openPostgresBridge(process.env.DATABASE_URL);
  }
  // better-sqlite3 se carga solo aquí, así el modo PostgreSQL no lo necesita
  const Database = require('better-sqlite3');
  console.log(`🗄️  Base de datos: SQLite (${sqlitePath})`);
  return new Database(sqlitePath);
}
