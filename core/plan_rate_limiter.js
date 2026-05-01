'use strict';

/**
 * MIIA - Plan Rate Limiter (T209)
 * Rate limiting avanzado por plan del owner.
 */

const PLANS = Object.freeze({
  free: { messagesPerDay: 100, broadcastsPerDay: 1, contactsMax: 200, aiCallsPerHour: 20 },
  starter: { messagesPerDay: 500, broadcastsPerDay: 3, contactsMax: 1000, aiCallsPerHour: 60 },
  pro: { messagesPerDay: 2000, broadcastsPerDay: 10, contactsMax: 5000, aiCallsPerHour: 200 },
  enterprise: { messagesPerDay: 20000, broadcastsPerDay: 50, contactsMax: 50000, aiCallsPerHour: 1000 },
});

const DEFAULT_PLAN = 'free';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function getPlanLimits(plan) {
  return PLANS[plan] || PLANS[DEFAULT_PLAN];
}

function isValidPlan(plan) {
  return plan in PLANS;
}

async function getUsageToday(uid, metric) {
  if (!uid) throw new Error('uid requerido');
  if (!metric) throw new Error('metric requerido');
  var today = new Date().toISOString().slice(0, 10);
  try {
    var snap = await db().collection('tenants').doc(uid).collection('rate_usage').doc(today).get();
    if (!snap.exists) return 0;
    var data = snap.data();
    return data[metric] || 0;
  } catch (e) {
    console.error('[PLAN_RATE_LIMITER] Error leyendo usage: ' + e.message);
    return 0;
  }
}

async function incrementUsage(uid, metric, amount) {
  if (!uid) throw new Error('uid requerido');
  if (!metric) throw new Error('metric requerido');
  var n = (typeof amount === 'number' && amount > 0) ? amount : 1;
  var today = new Date().toISOString().slice(0, 10);
  try {
    var ref = db().collection('tenants').doc(uid).collection('rate_usage').doc(today);
    var inc = {};
    inc[metric] = n;
    await ref.set(inc, { merge: true });
  } catch (e) {
    console.error('[PLAN_RATE_LIMITER] Error incrementando usage: ' + e.message);
    throw e;
  }
}

async function checkLimit(uid, plan, metric) {
  if (!uid) throw new Error('uid requerido');
  if (!plan) throw new Error('plan requerido');
  if (!metric) throw new Error('metric requerido');
  var limits = getPlanLimits(plan);
  var limit = limits[metric];
  if (limit === undefined) throw new Error('metric desconocida: ' + metric);
  var used = await getUsageToday(uid, metric);
  var allowed = used < limit;
  return { allowed, used, limit, plan, metric, remaining: Math.max(0, limit - used) };
}

async function checkAndConsume(uid, plan, metric) {
  var result = await checkLimit(uid, plan, metric);
  if (!result.allowed) return { ...result, consumed: false };
  await incrementUsage(uid, metric, 1);
  return { ...result, consumed: true, remaining: result.remaining - 1 };
}

async function getFullUsageSummary(uid, plan) {
  if (!uid) throw new Error('uid requerido');
  if (!plan) throw new Error('plan requerido');
  var limits = getPlanLimits(plan);
  var metrics = Object.keys(limits);
  var summary = { uid, plan, date: new Date().toISOString().slice(0, 10), metrics: {} };
  for (var i = 0; i < metrics.length; i++) {
    var m = metrics[i];
    var used = await getUsageToday(uid, m);
    summary.metrics[m] = { used, limit: limits[m], remaining: Math.max(0, limits[m] - used) };
  }
  return summary;
}

module.exports = {
  getPlanLimits,
  isValidPlan,
  getUsageToday,
  incrementUsage,
  checkLimit,
  checkAndConsume,
  getFullUsageSummary,
  PLANS,
  DEFAULT_PLAN,
  __setFirestoreForTests,
};
