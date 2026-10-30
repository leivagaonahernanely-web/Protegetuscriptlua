// Driver falso con la misma forma que `pg.Client`, solo para probar el puente síncrono sin PostgreSQL.
export class Client {
  constructor() { this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; return this; }
  async connect() {}
  async query(sql, params = []) {
    if (/boom/.test(sql)) {
      const err = new Error('disk full');
      err.code = '53100';
      throw err;
    }
    if (/information_schema/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^INSERT/i.test(sql)) return { rows: [{ id: 7 }], rowCount: 1 };
    return { rows: [{ sql_seen: sql, p: params }], rowCount: 1 };
  }
}
