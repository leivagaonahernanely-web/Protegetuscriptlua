import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createQuota, FREE_RESET_SECONDS, MONTH_SECONDS } from '../lib/quota.js';

function setup(plan, extra = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, plan TEXT, obf_used INTEGER DEFAULT 0,
    scripts_period INTEGER DEFAULT 0, keys_period INTEGER DEFAULT 0, quota_reset_at INTEGER)`);
  db.prepare('INSERT INTO users (id, plan, quota_reset_at) VALUES (?, ?, ?)').run('u1', plan, 1e12);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE users SET ${k} = ? WHERE id = 'u1'`).run(v);
  let t = 1_000_000;
  const quota = createQuota(db, { now: () => t });
  return { db, quota, advance: s => { t += s; } };
}

test('Free: 100 keys por periodo, la 101 se rechaza', () => {
  const { quota } = setup('free');
  assert.equal(quota.reserveKeys('u1', 100), true);
  assert.equal(quota.reserveKeys('u1', 1), false);
  assert.equal(quota.keysLeft('u1'), 0);
});

test('Free: al reiniciar el periodo vuelven a cero keys, ofuscaciones y scripts', () => {
  const { db, quota, advance } = setup('free', { keys_period: 100, obf_used: 5, scripts_period: 2, quota_reset_at: 1_000_000 + 10 });
  advance(11);
  assert.equal(quota.reserveKeys('u1', 100), true);
  const row = db.prepare('SELECT obf_used, scripts_period, quota_reset_at FROM users WHERE id = ?').get('u1');
  assert.equal(row.obf_used, 0);
  assert.equal(row.scripts_period, 0);
  assert.equal(row.quota_reset_at, 1_000_011 + FREE_RESET_SECONDS);
});

test('Free: el periodo dura 15 días, pagos un mes', () => {
  const free = setup('free', { quota_reset_at: null });
  free.quota.resetIfDue('u1');
  assert.equal(free.db.prepare('SELECT quota_reset_at FROM users WHERE id = ?').get('u1').quota_reset_at, 1_000_000 + FREE_RESET_SECONDS);
  const premium = setup('premium', { quota_reset_at: null });
  premium.quota.resetIfDue('u1');
  assert.equal(premium.db.prepare('SELECT quota_reset_at FROM users WHERE id = ?').get('u1').quota_reset_at, 1_000_000 + MONTH_SECONDS);
});

test('Free: máximo 2 scripts por periodo y 5 ofuscaciones', () => {
  assert.match(setup('free', { scripts_period: 5 }).quota.quotaError('u1', { isNewScript: true, isFfa: false }), /5 scripts/);
  assert.equal(setup('free', { scripts_period: 4 }).quota.quotaError('u1', { isNewScript: true, isFfa: false }), null);
  assert.match(setup('free', { obf_used: 5 }).quota.quotaError('u1', { isNewScript: false, isFfa: false }), /5 ofuscaciones/);
  assert.equal(setup('free', { obf_used: 5 }).quota.quotaError('u1', { isNewScript: false, isFfa: true }), null);
});

test('Premium Plus: sin límites y sin contar keys', () => {
  const { db, quota } = setup('plus', { obf_used: 999, scripts_period: 999 });
  assert.equal(quota.quotaError('u1', { isNewScript: true, isFfa: false }), null);
  assert.equal(quota.reserveKeys('u1', 500), true);
  assert.equal(db.prepare('SELECT keys_period FROM users WHERE id = ?').get('u1').keys_period, 0);
});

test('Premium: keys ilimitadas', () => {
  const { quota } = setup('premium');
  assert.equal(quota.reserveKeys('u1', 50), true);
  assert.equal(quota.keysLeft('u1'), Infinity);
});

test('noteScript suma al contador del periodo', () => {
  const { db, quota } = setup('free');
  quota.noteScript('u1');
  assert.equal(db.prepare('SELECT scripts_period FROM users WHERE id = ?').get('u1').scripts_period, 1);
});
