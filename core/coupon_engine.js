'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const COUPON_TYPES = Object.freeze(['percent', 'fixed', 'free_shipping', 'bogo', 'custom']);
const COUPON_STATUSES = Object.freeze(['active', 'inactive', 'expired', 'exhausted', 'scheduled']);
const REDEMPTION_STATUSES = Object.freeze(['applied', 'validated', 'used', 'reversed', 'expired']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O, 0, I, 1

const MAX_CODE_LENGTH = 12;
const MIN_CODE_LENGTH = 4;
const MAX_DISCOUNT_PERCENT = 100;
const MAX_USES_DEFAULT = 1000;
const EXPIRY_DAYS_DEFAULT = 30;

function isValidType(t) { return COUPON_TYPES.includes(t); }
function isValidStatus(s) { return COUPON_STATUSES.includes(s); }

function generateCouponCode(length, seed) {
  length = typeof length === 'number' ? Math.min(MAX_CODE_LENGTH, Math.max(MIN_CODE_LENGTH, length)) : 8;
  let code = '';
  let hash = seed ? String(seed).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : Math.random() * 99999;
  for (let i = 0; i < length; i++) {
    hash = (hash * 1664525 + 1013904223) & 0xFFFFFFFF;
    code += CODE_CHARS[Math.abs(hash) % CODE_CHARS.length];
  }
  return code;
}

function buildCouponId(uid, code) {
  return uid.slice(0, 8) + '_coup_' + code.toUpperCase();
}

function buildCouponRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const type = isValidType(data.type) ? data.type : 'percent';
  const code = typeof data.code === 'string' && data.code.trim().length >= MIN_CODE_LENGTH
    ? data.code.trim().toUpperCase().slice(0, MAX_CODE_LENGTH)
    : generateCouponCode(8, data.codeSeed);
  const couponId = data.couponId || buildCouponId(uid, code);
  const discountPercent = type === 'percent'
    ? Math.min(MAX_DISCOUNT_PERCENT, Math.max(0, typeof data.discountPercent === 'number' ? data.discountPercent : 0))
    : 0;
  const discountAmount = type === 'fixed'
    ? Math.max(0, typeof data.discountAmount === 'number' ? data.discountAmount : 0)
    : 0;
  const scheduledAt = typeof data.scheduledAt === 'number' && data.scheduledAt > now
    ? data.scheduledAt : null;
  const status = scheduledAt ? 'scheduled' : (isValidStatus(data.status) ? data.status : 'active');
  return {
    couponId,
    uid,
    code,
    type,
    status,
    name: typeof data.name === 'string' ? data.name.trim().slice(0, 100) : 'Cupon ' + code,
    description: typeof data.description === 'string' ? data.description.slice(0, 300) : '',
    discountPercent,
    discountAmount,
    minOrderAmount: typeof data.minOrderAmount === 'number' ? Math.max(0, data.minOrderAmount) : 0,
    maxDiscountAmount: typeof data.maxDiscountAmount === 'number' ? data.maxDiscountAmount : null,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    maxUses: typeof data.maxUses === 'number' ? data.maxUses : MAX_USES_DEFAULT,
    usesPerContact: typeof data.usesPerContact === 'number' ? data.usesPerContact : 1,
    currentUses: 0,
    scheduledAt,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : (now + EXPIRY_DAYS_DEFAULT * 24 * 60 * 60 * 1000),
    applicableProducts: Array.isArray(data.applicableProducts) ? data.applicableProducts.slice(0, 50) : [],
    excludedProducts: Array.isArray(data.excludedProducts) ? data.excludedProducts.slice(0, 50) : [],
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function validateCoupon(coupon, orderAmount, opts) {
  opts = opts || {};
  const now = Date.now();
  const errors = [];
  if (!coupon) { errors.push('coupon_not_found'); return { valid: false, errors }; }
  if (coupon.status === 'expired' || coupon.expiresAt < now) errors.push('coupon_expired');
  if (coupon.status === 'inactive') errors.push('coupon_inactive');
  if (coupon.status === 'exhausted' || coupon.currentUses >= coupon.maxUses) errors.push('coupon_exhausted');
  if (coupon.status === 'scheduled' && coupon.scheduledAt > now) errors.push('coupon_not_yet_active');
  if (typeof orderAmount === 'number' && coupon.minOrderAmount > 0 && orderAmount < coupon.minOrderAmount) {
    errors.push('order_below_minimum');
  }
  if (typeof opts.contactUses === 'number' && opts.contactUses >= coupon.usesPerContact) {
    errors.push('contact_use_limit_reached');
  }
  return { valid: errors.length === 0, errors };
}

function computeDiscount(coupon, orderAmount) {
  if (!coupon || typeof orderAmount !== 'number' || orderAmount <= 0) return 0;
  let discount = 0;
  if (coupon.type === 'percent') {
    discount = Math.round(orderAmount * coupon.discountPercent / 100 * 100) / 100;
    if (coupon.maxDiscountAmount !== null && discount > coupon.maxDiscountAmount) {
      discount = coupon.maxDiscountAmount;
    }
  } else if (coupon.type === 'fixed') {
    discount = Math.min(coupon.discountAmount, orderAmount);
  } else if (coupon.type === 'free_shipping') {
    discount = typeof orderAmount === 'number' ? 0 : 0; // shipping se calcula externamente
  }
  return Math.max(0, Math.round(discount * 100) / 100);
}

function applyRedemption(coupon) {
  const newUses = coupon.currentUses + 1;
  const now = Date.now();
  const status = newUses >= coupon.maxUses ? 'exhausted' : coupon.status;
  return {
    ...coupon,
    currentUses: newUses,
    status,
    updatedAt: now,
  };
}

function buildRedemptionRecord(uid, couponId, data) {
  data = data || {};
  const now = Date.now();
  const redemptionId = uid.slice(0, 8) + '_red_' + couponId.slice(0, 8) + '_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 4);
  return {
    redemptionId,
    uid,
    couponId,
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone.trim() : null,
    contactName: typeof data.contactName === 'string' ? data.contactName.trim() : null,
    orderId: data.orderId || null,
    orderAmount: typeof data.orderAmount === 'number' ? data.orderAmount : 0,
    discountApplied: typeof data.discountApplied === 'number' ? data.discountApplied : 0,
    finalAmount: typeof data.finalAmount === 'number' ? data.finalAmount : 0,
    status: 'applied',
    appliedAt: now,
    usedAt: null,
    reversedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
  };
}

function buildCouponSummaryText(coupon) {
  if (!coupon) return 'Cupon no encontrado.';
  const lines = [];
  const icon = coupon.status === 'active' ? '\u{1F3F7}\u{FE0F}' : coupon.status === 'expired' ? '\u{274C}' : '\u{1F4AC}';
  lines.push(icon + ' *' + coupon.code + '* — ' + coupon.name);
  lines.push('Tipo: ' + coupon.type + ' | Estado: ' + coupon.status);
  if (coupon.type === 'percent') {
    lines.push('Descuento: ' + coupon.discountPercent + '%');
    if (coupon.maxDiscountAmount) lines.push('Maximo: ' + coupon.currency + ' ' + coupon.maxDiscountAmount);
  } else if (coupon.type === 'fixed') {
    lines.push('Descuento: ' + coupon.currency + ' ' + coupon.discountAmount);
  } else {
    lines.push('Tipo especial: ' + coupon.type);
  }
  if (coupon.minOrderAmount > 0) lines.push('Pedido minimo: ' + coupon.currency + ' ' + coupon.minOrderAmount);
  lines.push('Usos: ' + coupon.currentUses + '/' + coupon.maxUses);
  lines.push('Vence: ' + new Date(coupon.expiresAt).toISOString().slice(0, 10));
  return lines.join('\n');
}

async function saveCoupon(uid, coupon) {
  console.log('[COUPON] Guardando uid=' + uid + ' code=' + coupon.code + ' status=' + coupon.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('coupons').doc(coupon.couponId)
      .set(coupon, { merge: false });
    return coupon.couponId;
  } catch (err) {
    console.error('[COUPON] Error guardando cupon:', err.message);
    throw err;
  }
}

async function getCoupon(uid, couponId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('coupons').doc(couponId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[COUPON] Error obteniendo cupon:', err.message);
    return null;
  }
}

async function getCouponByCode(uid, code) {
  try {
    const couponId = uid.slice(0, 8) + '_coup_' + code.toUpperCase();
    return await getCoupon(uid, couponId);
  } catch (err) {
    console.error('[COUPON] Error buscando cupon por codigo:', err.message);
    return null;
  }
}

async function updateCoupon(uid, couponId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('coupons').doc(couponId)
      .set(update, { merge: true });
    return couponId;
  } catch (err) {
    console.error('[COUPON] Error actualizando cupon:', err.message);
    throw err;
  }
}

async function saveRedemption(uid, redemption) {
  console.log('[COUPON] Guardando redemption id=' + redemption.redemptionId);
  try {
    await db().collection('owners').doc(uid)
      .collection('coupon_redemptions').doc(redemption.redemptionId)
      .set(redemption, { merge: false });
    return redemption.redemptionId;
  } catch (err) {
    console.error('[COUPON] Error guardando redemption:', err.message);
    throw err;
  }
}

async function listActiveCoupons(uid) {
  try {
    const snap = await db().collection('owners').doc(uid).collection('coupons')
      .where('status', '==', 'active').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[COUPON] Error listando cupones activos:', err.message);
    return [];
  }
}

module.exports = {
  buildCouponRecord,
  validateCoupon,
  computeDiscount,
  applyRedemption,
  buildRedemptionRecord,
  generateCouponCode,
  buildCouponSummaryText,
  saveCoupon,
  getCoupon,
  getCouponByCode,
  updateCoupon,
  saveRedemption,
  listActiveCoupons,
  COUPON_TYPES,
  COUPON_STATUSES,
  REDEMPTION_STATUSES,
  MAX_DISCOUNT_PERCENT,
  MAX_USES_DEFAULT,
  EXPIRY_DAYS_DEFAULT,
  __setFirestoreForTests,
};
