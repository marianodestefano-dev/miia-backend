'use strict';

/**
 * R30 — core/admin_metrics_alerts.js (Piso 6 P6.2)
 * Admin Panel + Enterprise Metrics + CEO Alerts.
 * Funciones:
 *   - getEnterpriseMetrics: KPIs por enterprise (members, ARR, churn signal, activity)
 *   - getGlobalMetrics: KPIs globales (total enterprises, total users, MRR estimado)
 *   - emitCeoAlert: registra alertas criticas para el CEO (churn risk, billing fallo, etc)
 *   - listActiveAlerts: lista alertas no resueltas
 *   - resolveAlert: marca alerta resuelta
 * Schema:
 *   - admin_metrics/global -> snapshot cacheado
 *   - admin_metrics/enterprises/{enterpriseId}
 *   - ceo_alerts/{alertId}
 */

const ALERT_LEVELS = Object.freeze({ INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' });
const ALERT_TYPES = Object.freeze([
  'churn_risk', 'billing_failure', 'usage_spike', 'support_overload',
  'fraud_detected', 'integration_down', 'milestone_reached',
]);

const PLAN_MRR_USD = Object.freeze({
  starter: 29,
  pro: 79,
  enterprise: 199,
});

const CHURN_INACTIVITY_DAYS = 14;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _enterprisesCol() { return db().collection('enterprises'); }
function _alertsCol() { return db().collection('ceo_alerts'); }
function _adminMetricsDoc(id) { return db().collection('admin_metrics').doc(id); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function _daysBetween(isoDate) {
  if (!isoDate) return Infinity;
  const t = new Date(isoDate).getTime();
  if (isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

// ── Enterprise metrics ────────────────────────────────────────────────────────
/**
 * Calcula KPIs de una enterprise.
 * @param {string} enterpriseId
 */
async function getEnterpriseMetrics(enterpriseId) {
  if (!enterpriseId) throw new Error('enterpriseId_requerido');
  const entSnap = await _enterprisesCol().doc(enterpriseId).get();
  if (!entSnap.exists) throw new Error('enterprise_no_encontrada');
  const ent = entSnap.data();
  const membersSnap = await _enterprisesCol().doc(enterpriseId).collection('members').get();
  let activeMembers = 0;
  let lastActivity = null;
  membersSnap.forEach(function (doc) {
    const m = doc.data();
    if (m.active !== false) activeMembers++;
    if (m.lastSeenAt) {
      if (!lastActivity || new Date(m.lastSeenAt) > new Date(lastActivity)) {
        lastActivity = m.lastSeenAt;
      }
    }
  });
  const daysSinceActivity = _daysBetween(lastActivity);
  const churnRisk = daysSinceActivity >= CHURN_INACTIVITY_DAYS;
  const mrr = PLAN_MRR_USD[ent.plan] || 0;
  const arr = mrr * 12;
  return {
    enterpriseId,
    name: ent.name || null,
    plan: ent.plan || null,
    active: ent.active !== false,
    activeMembers,
    lastActivity,
    daysSinceActivity,
    churnRisk,
    mrr_usd: mrr,
    arr_usd: arr,
  };
}

// ── Global metrics ────────────────────────────────────────────────────────────
/**
 * Calcula KPIs globales (snapshot).
 */
async function getGlobalMetrics() {
  const snap = await _enterprisesCol().get();
  let totalEnterprises = 0;
  let activeEnterprises = 0;
  let totalMrr = 0;
  const byPlan = { starter: 0, pro: 0, enterprise: 0 };
  snap.forEach(function (doc) {
    const data = doc.data();
    totalEnterprises++;
    if (data.active !== false) activeEnterprises++;
    if (byPlan[data.plan] !== undefined) byPlan[data.plan]++;
    if (data.active !== false) totalMrr += (PLAN_MRR_USD[data.plan] || 0);
  });
  return {
    totalEnterprises,
    activeEnterprises,
    mrr_usd: totalMrr,
    arr_usd: totalMrr * 12,
    byPlan,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Guarda el snapshot global en admin_metrics/global.
 */
async function persistGlobalMetrics() {
  const metrics = await getGlobalMetrics();
  await _adminMetricsDoc('global').set(metrics, { merge: true });
  return metrics;
}

// ── CEO alerts ────────────────────────────────────────────────────────────────
/**
 * Emite una alerta para el CEO.
 * @param {{ type, level, message, enterpriseId, payload }} alert
 */
async function emitCeoAlert(alert) {
  if (!alert || !alert.type) throw new Error('alert_type_requerido');
  if (!ALERT_TYPES.includes(alert.type)) throw new Error('alert_type_invalido: ' + alert.type);
  if (!alert.message) throw new Error('message_requerido');
  const level = (alert.level && Object.values(ALERT_LEVELS).includes(alert.level))
    ? alert.level
    : ALERT_LEVELS.WARNING;
  const alertId = 'alt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    alertId,
    type: alert.type,
    level,
    message: String(alert.message).slice(0, 500),
    enterpriseId: alert.enterpriseId || null,
    payload: alert.payload || null,
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  await _alertsCol().doc(alertId).set(record);
  console.log('[CEO-ALERT] ' + level.toUpperCase() + ' type=' + alert.type + ' id=' + alertId);
  return { ok: true, alertId, ...record };
}

/**
 * Lista alertas activas (no resueltas), ordenadas por criticidad y fecha.
 */
async function listActiveAlerts(opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit) || 50, 200);
  const snap = await _alertsCol().get();
  const alerts = [];
  snap.forEach(function (doc) {
    const data = doc.data();
    if (!data.resolved) alerts.push(data);
  });
  const levelOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort(function (a, b) {
    const la = levelOrder[a.level] !== undefined ? levelOrder[a.level] : 3;
    const lb = levelOrder[b.level] !== undefined ? levelOrder[b.level] : 3;
    if (la !== lb) return la - lb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return alerts.slice(0, limit);
}

/**
 * Marca una alerta como resuelta.
 */
async function resolveAlert(alertId, opts) {
  if (!alertId) throw new Error('alertId_requerido');
  const o = opts || {};
  const ref = _alertsCol().doc(alertId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('alerta_no_encontrada');
  const data = snap.data();
  if (data.resolved) throw new Error('alerta_ya_resuelta');
  await ref.set({
    resolved: true,
    resolvedAt: new Date().toISOString(),
    resolvedBy: o.resolvedBy || null,
    resolution: o.resolution ? String(o.resolution).slice(0, 500) : null,
  }, { merge: true });
  return { ok: true };
}

module.exports = {
  getEnterpriseMetrics,
  getGlobalMetrics,
  persistGlobalMetrics,
  emitCeoAlert,
  listActiveAlerts,
  resolveAlert,
  ALERT_LEVELS,
  ALERT_TYPES,
  PLAN_MRR_USD,
  CHURN_INACTIVITY_DAYS,
  __setFirestoreForTests,
};
