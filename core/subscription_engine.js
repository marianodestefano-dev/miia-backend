'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const SUBSCRIPTION_STATUSES = Object.freeze(['active', 'paused', 'cancelled', 'expired', 'trial', 'pending']);
const BILLING_CYCLES = Object.freeze(['weekly', 'monthly', 'quarterly', 'biannual', 'annual']);
const SUBSCRIPTION_TYPES = Object.freeze([
  'service', 'product', 'membership', 'plan', 'custom',
]);

const MAX_SUBSCRIPTIONS_PER_OWNER = 1000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_NAME_LENGTH = 120;
const TRIAL_DAYS_DEFAULT = 7;
const GRACE_PERIOD_DAYS = 3;

const CYCLE_DAYS = Object.freeze({
  weekly: 7, monthly: 30, quarterly: 90, biannual: 180, annual: 365,
});

function isValidStatus(s) { return SUBSCRIPTION_STATUSES.includes(s); }
function isValidCycle(c) { return BILLING_CYCLES.includes(c); }
function isValidType(t) { return SUBSCRIPTION_TYPES.includes(t); }

function buildSubscriptionId(uid, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  return uid.slice(0, 8) + '_sub_' + slug + '_' + Date.now().toString(36).slice(-4);
}

function computeNextBillingDate(fromTs, cycle) {
  if (!isValidCycle(cycle)) throw new Error('cycle invalido: ' + cycle);
  const days = CYCLE_DAYS[cycle];
  return fromTs + days * 24 * 60 * 60 * 1000;
}

function buildSubscriptionRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const subType = isValidType(data.type) ? data.type : 'custom';
  const cycle = isValidCycle(data.billingCycle) ? data.billingCycle : 'monthly';
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, MAX_NAME_LENGTH) : 'Suscripcion';
  const subscriptionId = data.subscriptionId || buildSubscriptionId(uid, name);
  const price = typeof data.price === 'number' && data.price >= 0 ? data.price : 0;
  const startDate = data.startDate || now;
  const trialDays = typeof data.trialDays === 'number' && data.trialDays >= 0 ? data.trialDays : 0;
  const trialEndsAt = trialDays > 0 ? startDate + trialDays * 24 * 60 * 60 * 1000 : null;
  const initialStatus = trialDays > 0 ? 'trial' : (isValidStatus(data.status) ? data.status : 'active');
  const nextBillingAt = data.nextBillingAt || (trialEndsAt ? trialEndsAt : computeNextBillingDate(startDate, cycle));
  return {
    subscriptionId,
    uid,
    type: subType,
    name,
    description: typeof data.description === 'string' ? data.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : '',
    status: initialStatus,
    billingCycle: cycle,
    price,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone.trim() : null,
    contactName: typeof data.contactName === 'string' ? data.contactName.trim().slice(0, 100) : null,
    productId: data.productId || null,
    couponId: data.couponId || null,
    discountPercent: typeof data.discountPercent === 'number' ? Math.min(100, Math.max(0, data.discountPercent)) : 0,
    trialDays,
    trialEndsAt,
    startDate,
    nextBillingAt,
    lastBilledAt: null,
    cancelledAt: null,
    pausedAt: null,
    pausedUntil: null,
    billingCount: 0,
    failedBillingCount: 0,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string').slice(0, 10) : [],
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function computeSubscriptionPrice(subscription) {
  const base = subscription.price || 0;
  if (subscription.discountPercent > 0) {
    return Math.max(0, Math.round(base * (1 - subscription.discountPercent / 100) * 100) / 100);
  }
  return base;
}

function pauseSubscription(subscription, pausedUntil) {
  if (subscription.status === 'cancelled') throw new Error('No se puede pausar una suscripcion cancelada');
  if (subscription.status === 'paused') throw new Error('La suscripcion ya esta pausada');
  const now = Date.now();
  return {
    ...subscription,
    status: 'paused',
    pausedAt: now,
    pausedUntil: typeof pausedUntil === 'number' && pausedUntil > now ? pausedUntil : null,
    updatedAt: now,
  };
}

function resumeSubscription(subscription) {
  if (subscription.status !== 'paused') throw new Error('La suscripcion no esta pausada');
  const now = Date.now();
  return {
    ...subscription,
    status: 'active',
    pausedAt: null,
    pausedUntil: null,
    updatedAt: now,
  };
}

function cancelSubscription(subscription) {
  if (subscription.status === 'cancelled') throw new Error('La suscripcion ya esta cancelada');
  const now = Date.now();
  return {
    ...subscription,
    status: 'cancelled',
    cancelledAt: now,
    updatedAt: now,
  };
}

function recordBilling(subscription, success) {
  const now = Date.now();
  if (success) {
    const next = computeNextBillingDate(now, subscription.billingCycle);
    return {
      ...subscription,
      status: 'active',
      lastBilledAt: now,
      nextBillingAt: next,
      billingCount: (subscription.billingCount || 0) + 1,
      failedBillingCount: subscription.failedBillingCount || 0,
      updatedAt: now,
    };
  } else {
    const failed = (subscription.failedBillingCount || 0) + 1;
    const newStatus = failed >= 3 ? 'expired' : subscription.status;
    return {
      ...subscription,
      status: newStatus,
      failedBillingCount: failed,
      updatedAt: now,
    };
  }
}

function isInGracePeriod(subscription) {
  if (subscription.status !== 'expired') return false;
  const now = Date.now();
  const gracePeriodMs = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  return subscription.updatedAt && (now - subscription.updatedAt) <= gracePeriodMs;
}

function buildSubscriptionSummaryText(subscription) {
  if (!subscription) return 'Suscripcion no encontrada.';
  const parts = [];
  const icons = {
    active: '\u{2705}', paused: '\u{23F8}\uFE0F', cancelled: '\u{274C}',
    expired: '\u{1F534}', trial: '\u{1F7E1}', pending: '\u{23F3}',
  };
  const icon = icons[subscription.status] || '\u{1F4CB}';
  const price = computeSubscriptionPrice(subscription);
  parts.push(icon + ' *' + subscription.name + '* (' + subscription.type + ')');
  parts.push('Estado: ' + subscription.status + ' | Ciclo: ' + subscription.billingCycle);
  parts.push('Precio: ' + price + ' ' + subscription.currency + (subscription.discountPercent > 0 ? ' (desc. ' + subscription.discountPercent + '%)' : ''));
  if (subscription.contactName) parts.push('Cliente: ' + subscription.contactName);
  if (subscription.trialEndsAt) parts.push('Trial hasta: ' + new Date(subscription.trialEndsAt).toISOString().slice(0, 10));
  if (subscription.nextBillingAt && subscription.status === 'active') {
    parts.push('Prox. cobro: ' + new Date(subscription.nextBillingAt).toISOString().slice(0, 10));
  }
  if (subscription.billingCount > 0) parts.push('Cobros exitosos: ' + subscription.billingCount);
  return parts.join('\n');
}

async function saveSubscription(uid, subscription) {
  console.log('[SUB] Guardando suscripcion uid=' + uid + ' id=' + subscription.subscriptionId + ' status=' + subscription.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('subscriptions').doc(subscription.subscriptionId)
      .set(subscription, { merge: false });
    return subscription.subscriptionId;
  } catch (err) {
    console.error('[SUB] Error guardando suscripcion:', err.message);
    throw err;
  }
}

async function getSubscription(uid, subscriptionId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('subscriptions').doc(subscriptionId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[SUB] Error obteniendo suscripcion:', err.message);
    return null;
  }
}

async function updateSubscription(uid, subscriptionId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  console.log('[SUB] Actualizando suscripcion id=' + subscriptionId + ' status=' + (fields.status || '?'));
  try {
    await db().collection('owners').doc(uid)
      .collection('subscriptions').doc(subscriptionId)
      .set(update, { merge: true });
    return subscriptionId;
  } catch (err) {
    console.error('[SUB] Error actualizando suscripcion:', err.message);
    throw err;
  }
}

async function listSubscriptions(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('subscriptions');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.contactPhone && rec.contactPhone !== opts.contactPhone) return;
      if (opts.productId && rec.productId !== opts.productId) return;
      results.push(rec);
    });
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, opts.limit || 100);
  } catch (err) {
    console.error('[SUB] Error listando suscripciones:', err.message);
    return [];
  }
}

async function listDueBillings(uid, beforeTs) {
  const ts = typeof beforeTs === 'number' ? beforeTs : Date.now();
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('subscriptions').where('status', '==', 'active').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (rec.nextBillingAt && rec.nextBillingAt <= ts) results.push(rec);
    });
    return results;
  } catch (err) {
    console.error('[SUB] Error listando cobros pendientes:', err.message);
    return [];
  }
}

module.exports = {
  buildSubscriptionRecord,
  computeSubscriptionPrice,
  computeNextBillingDate,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  recordBilling,
  isInGracePeriod,
  buildSubscriptionSummaryText,
  saveSubscription,
  getSubscription,
  updateSubscription,
  listSubscriptions,
  listDueBillings,
  SUBSCRIPTION_STATUSES,
  BILLING_CYCLES,
  SUBSCRIPTION_TYPES,
  CYCLE_DAYS,
  TRIAL_DAYS_DEFAULT,
  GRACE_PERIOD_DAYS,
  __setFirestoreForTests,
};
