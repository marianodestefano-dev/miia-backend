'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const TRANSACTION_TYPES = Object.freeze(['earn', 'redeem', 'expire', 'adjust', 'bonus']);
const REWARD_TYPES = Object.freeze(['discount', 'free_product', 'upgrade', 'cashback', 'custom']);
const TIER_NAMES = Object.freeze(['bronze', 'silver', 'gold', 'platinum', 'diamond']);

const POINTS_PER_CURRENCY_UNIT = 1; // 1 punto por cada 1 ARS gastado por defecto
const MIN_REDEEM_POINTS = 100;
const POINTS_EXPIRY_DAYS = 365;
const MAX_POINTS_PER_TRANSACTION = 100000;

const TIER_THRESHOLDS = Object.freeze({
  bronze: 0, silver: 500, gold: 2000, platinum: 5000, diamond: 10000,
});

function isValidTransactionType(t) { return TRANSACTION_TYPES.includes(t); }
function isValidRewardType(t) { return REWARD_TYPES.includes(t); }
function isValidTier(t) { return TIER_NAMES.includes(t); }

function computeTier(totalEarned) {
  if (typeof totalEarned !== 'number' || totalEarned < 0) return 'bronze';
  if (totalEarned >= TIER_THRESHOLDS.diamond) return 'diamond';
  if (totalEarned >= TIER_THRESHOLDS.platinum) return 'platinum';
  if (totalEarned >= TIER_THRESHOLDS.gold) return 'gold';
  if (totalEarned >= TIER_THRESHOLDS.silver) return 'silver';
  return 'bronze';
}

function computePointsFromAmount(amount, multiplier) {
  if (typeof amount !== 'number' || amount < 0) return 0;
  const m = typeof multiplier === 'number' && multiplier > 0 ? multiplier : POINTS_PER_CURRENCY_UNIT;
  return Math.min(Math.round(amount * m), MAX_POINTS_PER_TRANSACTION);
}

function buildLoyaltyAccountId(uid, contactPhone) {
  return uid.slice(0, 8) + '_loyalty_' + contactPhone.replace(/[^0-9]/g, '').slice(-8);
}

function buildLoyaltyAccount(uid, contactPhone, data) {
  data = data || {};
  const now = Date.now();
  const accountId = data.accountId || buildLoyaltyAccountId(uid, contactPhone);
  return {
    accountId,
    uid,
    contactPhone: contactPhone.trim(),
    contactName: typeof data.contactName === 'string' ? data.contactName.trim().slice(0, 100) : null,
    points: typeof data.points === 'number' && data.points >= 0 ? data.points : 0,
    totalEarned: typeof data.totalEarned === 'number' ? data.totalEarned : 0,
    totalRedeemed: typeof data.totalRedeemed === 'number' ? data.totalRedeemed : 0,
    totalExpired: typeof data.totalExpired === 'number' ? data.totalExpired : 0,
    tier: computeTier(data.totalEarned || 0),
    transactionCount: 0,
    lastTransactionAt: null,
    expiresAt: data.expiresAt || (now + POINTS_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    active: data.active !== false,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function buildTransactionRecord(accountId, uid, type, points, data) {
  data = data || {};
  if (!isValidTransactionType(type)) throw new Error('type invalido: ' + type);
  if (typeof points !== 'number' || points < 0) throw new Error('points debe ser numero >= 0');
  const now = Date.now();
  const txId = accountId.slice(0, 12) + '_tx_' + type.slice(0, 4) + '_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  return {
    txId,
    accountId,
    uid,
    type,
    points,
    balanceBefore: typeof data.balanceBefore === 'number' ? data.balanceBefore : 0,
    balanceAfter: typeof data.balanceAfter === 'number' ? data.balanceAfter : 0,
    description: typeof data.description === 'string' ? data.description.trim().slice(0, 200) : '',
    referenceId: data.referenceId || null,
    expiresAt: data.expiresAt || null,
    createdAt: now,
  };
}

function earnPoints(account, points, opts) {
  opts = opts || {};
  if (typeof points !== 'number' || points <= 0) throw new Error('points debe ser numero positivo');
  const clamped = Math.min(points, MAX_POINTS_PER_TRANSACTION);
  const now = Date.now();
  const newPoints = account.points + clamped;
  const newTotalEarned = account.totalEarned + clamped;
  const newTier = computeTier(newTotalEarned);
  const tx = buildTransactionRecord(account.accountId, account.uid, 'earn', clamped, {
    balanceBefore: account.points,
    balanceAfter: newPoints,
    description: opts.description || 'Puntos ganados',
    referenceId: opts.referenceId,
  });
  const updatedAccount = {
    ...account,
    points: newPoints,
    totalEarned: newTotalEarned,
    tier: newTier,
    transactionCount: account.transactionCount + 1,
    lastTransactionAt: now,
    updatedAt: now,
  };
  return { account: updatedAccount, transaction: tx };
}

function redeemPoints(account, points, opts) {
  opts = opts || {};
  if (typeof points !== 'number' || points <= 0) throw new Error('points debe ser numero positivo');
  if (points < MIN_REDEEM_POINTS) throw new Error('Minimo ' + MIN_REDEEM_POINTS + ' puntos para canjear');
  if (account.points < points) throw new Error('Saldo insuficiente: tiene ' + account.points + ', pide ' + points);
  const now = Date.now();
  const newPoints = account.points - points;
  const tx = buildTransactionRecord(account.accountId, account.uid, 'redeem', points, {
    balanceBefore: account.points,
    balanceAfter: newPoints,
    description: opts.description || 'Puntos canjeados',
    referenceId: opts.referenceId,
  });
  const updatedAccount = {
    ...account,
    points: newPoints,
    totalRedeemed: account.totalRedeemed + points,
    transactionCount: account.transactionCount + 1,
    lastTransactionAt: now,
    updatedAt: now,
  };
  return { account: updatedAccount, transaction: tx };
}

function adjustPoints(account, delta, opts) {
  opts = opts || {};
  const now = Date.now();
  const newPoints = Math.max(0, account.points + delta);
  const tx = buildTransactionRecord(account.accountId, account.uid, 'adjust', Math.abs(delta), {
    balanceBefore: account.points,
    balanceAfter: newPoints,
    description: opts.description || ('Ajuste: ' + (delta >= 0 ? '+' : '') + delta),
    referenceId: opts.referenceId,
  });
  const updatedAccount = {
    ...account,
    points: newPoints,
    transactionCount: account.transactionCount + 1,
    lastTransactionAt: now,
    updatedAt: now,
  };
  return { account: updatedAccount, transaction: tx };
}

function buildRewardRecord(uid, type, data) {
  data = data || {};
  if (!isValidRewardType(type)) throw new Error('rewardType invalido: ' + type);
  const now = Date.now();
  return {
    rewardId: uid.slice(0, 8) + '_reward_' + type.slice(0, 8) + '_' + now.toString(36).slice(-4),
    uid,
    type,
    name: typeof data.name === 'string' ? data.name.trim().slice(0, 100) : type,
    pointsCost: typeof data.pointsCost === 'number' && data.pointsCost >= 0 ? data.pointsCost : 0,
    value: typeof data.value === 'number' ? data.value : 0,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    requiredTier: isValidTier(data.requiredTier) ? data.requiredTier : 'bronze',
    active: data.active !== false,
    maxRedemptions: typeof data.maxRedemptions === 'number' ? data.maxRedemptions : null,
    redemptionCount: 0,
    expiresAt: data.expiresAt || null,
    description: typeof data.description === 'string' ? data.description.trim().slice(0, 200) : '',
    createdAt: now,
    updatedAt: now,
  };
}

function canRedeemReward(account, reward) {
  const errors = [];
  if (!reward.active) errors.push('recompensa inactiva');
  if (account.points < reward.pointsCost) {
    errors.push('puntos insuficientes: tiene ' + account.points + ', necesita ' + reward.pointsCost);
  }
  const tierOrder = TIER_NAMES;
  if (tierOrder.indexOf(account.tier) < tierOrder.indexOf(reward.requiredTier)) {
    errors.push('tier insuficiente: tiene ' + account.tier + ', requiere ' + reward.requiredTier);
  }
  if (reward.maxRedemptions !== null && reward.redemptionCount >= reward.maxRedemptions) {
    errors.push('recompensa agotada');
  }
  if (reward.expiresAt && reward.expiresAt < Date.now()) {
    errors.push('recompensa expirada');
  }
  return { canRedeem: errors.length === 0, errors };
}

function buildLoyaltySummaryText(account) {
  if (!account) return 'Cuenta de fidelidad no encontrada.';
  const parts = [];
  const tierIcons = { bronze: '\u{1F7EB}', silver: '\u{C2B7}\u{FE0F}', gold: '\u{1F947}', platinum: '\u{1FA10}', diamond: '\u{1F48E}' };
  const icon = tierIcons[account.tier] || '\u{2B50}';
  parts.push(icon + ' *Programa de Fidelidad*');
  parts.push('Tier: ' + account.tier.toUpperCase() + ' | Puntos: ' + account.points);
  if (account.contactName) parts.push('Cliente: ' + account.contactName);
  parts.push('Ganados: ' + account.totalEarned + ' | Canjeados: ' + account.totalRedeemed);
  const nextTierIdx = TIER_NAMES.indexOf(account.tier) + 1;
  if (nextTierIdx < TIER_NAMES.length) {
    const nextTierName = TIER_NAMES[nextTierIdx];
    const needed = TIER_THRESHOLDS[nextTierName] - account.totalEarned;
    if (needed > 0) parts.push('Faltan ' + needed + ' pts para ' + nextTierName.toUpperCase());
  }
  return parts.join('\n');
}

async function saveLoyaltyAccount(uid, account) {
  console.log('[LOYALTY] Guardando cuenta uid=' + uid + ' accountId=' + account.accountId + ' tier=' + account.tier);
  try {
    await db().collection('owners').doc(uid)
      .collection('loyalty_accounts').doc(account.accountId)
      .set(account, { merge: false });
    return account.accountId;
  } catch (err) {
    console.error('[LOYALTY] Error guardando cuenta:', err.message);
    throw err;
  }
}

async function getLoyaltyAccount(uid, accountId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('loyalty_accounts').doc(accountId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[LOYALTY] Error obteniendo cuenta:', err.message);
    return null;
  }
}

async function updateLoyaltyAccount(uid, accountId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('loyalty_accounts').doc(accountId)
      .set(update, { merge: true });
    return accountId;
  } catch (err) {
    console.error('[LOYALTY] Error actualizando cuenta:', err.message);
    throw err;
  }
}

async function saveTransaction(uid, tx) {
  console.log('[LOYALTY] Guardando transaccion uid=' + uid + ' id=' + tx.txId + ' type=' + tx.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('loyalty_transactions').doc(tx.txId)
      .set(tx, { merge: false });
    return tx.txId;
  } catch (err) {
    console.error('[LOYALTY] Error guardando transaccion:', err.message);
    throw err;
  }
}

async function listTransactions(uid, accountId, opts) {
  opts = opts || {};
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('loyalty_transactions')
      .where('accountId', '==', accountId).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.type && rec.type !== opts.type) return;
      results.push(rec);
    });
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, opts.limit || 100);
  } catch (err) {
    console.error('[LOYALTY] Error listando transacciones:', err.message);
    return [];
  }
}

module.exports = {
  buildLoyaltyAccount,
  buildTransactionRecord,
  earnPoints,
  redeemPoints,
  adjustPoints,
  buildRewardRecord,
  canRedeemReward,
  computeTier,
  computePointsFromAmount,
  buildLoyaltySummaryText,
  saveLoyaltyAccount,
  getLoyaltyAccount,
  updateLoyaltyAccount,
  saveTransaction,
  listTransactions,
  TRANSACTION_TYPES,
  REWARD_TYPES,
  TIER_NAMES,
  TIER_THRESHOLDS,
  MIN_REDEEM_POINTS,
  POINTS_EXPIRY_DAYS,
  POINTS_PER_CURRENCY_UNIT,
  __setFirestoreForTests,
};
