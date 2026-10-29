// Cuotas por plan y contadores por periodo (Free cada 15 días; Premium y Premium Plus cada mes).
// Al reiniciarse un periodo vuelven a cero: ofuscaciones, scripts creados y keys generadas.

export const PLAN_DAYS_DEFAULT = 30;
export const MONTH_SECONDS = PLAN_DAYS_DEFAULT * 86400;
export const FREE_RESET_SECONDS = 15 * 86400;

// Las mismas cuotas que muestran la página de planes y el dashboard
export const PLAN_QUOTAS = {
  free:    { scripts: 5,        obfuscations: 5,        keys: 100 },
  premium: { scripts: 10,       obfuscations: 30,       keys: Infinity },
  plus:    { scripts: Infinity, obfuscations: Infinity, keys: Infinity },
};

export function createQuota(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const dueStmt = db.prepare('SELECT plan, quota_reset_at FROM users WHERE id = ?');
  const resetStmt = db.prepare('UPDATE users SET obf_used = 0, scripts_period = 0, keys_period = 0, quota_reset_at = ? WHERE id = ?');
  const rowStmt = db.prepare('SELECT plan, obf_used, scripts_period, keys_period FROM users WHERE id = ?');
  const addKeysStmt = db.prepare('UPDATE users SET keys_period = COALESCE(keys_period, 0) + ? WHERE id = ?');
  const addScriptStmt = db.prepare('UPDATE users SET scripts_period = COALESCE(scripts_period, 0) + 1 WHERE id = ?');

  const quotaOf = plan => PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.free;
  // Solo el plan Free tiene límite de keys por periodo; los pagos no
  const capOf = plan => (plan === 'premium' || plan === 'plus' ? Infinity : PLAN_QUOTAS.free.keys);

  function resetIfDue(userId) {
    const row = dueStmt.get(userId);
    if (!row) return;
    const t = now();
    const every = row.plan === 'free' ? FREE_RESET_SECONDS : MONTH_SECONDS;
    if (!row.quota_reset_at || row.quota_reset_at <= t) resetStmt.run(t + every, userId);
  }

  // Mensaje de error si el usuario no puede crear un script o generar más ofuscaciones
  function quotaError(userId, { isNewScript, isFfa }) {
    resetIfDue(userId);
    const row = rowStmt.get(userId) || {};
    const quota = quotaOf(row.plan);
    if (isNewScript && (row.scripts_period ?? 0) >= quota.scripts) {
      return `Tu plan permite ${quota.scripts} scripts por periodo. Mejora tu plan para crear más.`;
    }
    if (!isFfa && (row.obf_used ?? 0) >= quota.obfuscations) {
      return `Ya usaste tus ${quota.obfuscations} ofuscaciones del plan. Mejora tu plan para seguir.`;
    }
    return null;
  }

  // Reserva keys del periodo: comprueba y suma en una sola operación. Devuelve false si no alcanza.
  function reserveKeys(userId, amount) {
    resetIfDue(userId);
    const row = rowStmt.get(userId) || {};
    const cap = capOf(row.plan);
    if (cap === Infinity) return true;
    if ((row.keys_period ?? 0) + amount > cap) return false;
    addKeysStmt.run(amount, userId);
    return true;
  }

  function keysLeft(userId) {
    resetIfDue(userId);
    const row = rowStmt.get(userId) || {};
    const cap = capOf(row.plan);
    if (cap === Infinity) return Infinity;
    return Math.max(0, cap - (row.keys_period ?? 0));
  }

  function capFor(userId) {
    return capOf(rowStmt.get(userId)?.plan);
  }

  function noteScript(userId) {
    addScriptStmt.run(userId);
  }

  return { resetIfDue, quotaError, reserveKeys, keysLeft, capFor, noteScript };
}
