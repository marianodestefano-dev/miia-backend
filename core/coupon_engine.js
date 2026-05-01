'use strict';

const COUPON_TYPES = Object.freeze(['percentage', 'fixed', 'free_item', 'buy_x_get_y']);
const COUPON_STATUSES = Object.freeze(['active', 'expired', 'depleted', 'disabled']);
const COUPON_CURRENCIES = Object.freeze(['USD', 'ARS', 'COP', 'MXN', 'CLP', 'PEN', 'BRL']);

const MAX_COUPON_CODE_LENGTH = 20;
const MIN_DISCOUNT_VALUE = 0.01;
const MAX_DISCOUNT_PERCENTAGE = 100;
const MAX_USES_DEFAULT = 100;
const COUPON_COLLECTION = 'coupons';
const COUPON_USAGE_COLLECTION = 'coupon_usages';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidType(t) { return COUPON_TYPES.includes(t); }
function isValidStatus(s) { return COUPON_STATUSES.includes(s); }

function isValidCouponCode(code) {
  if (!code || typeof code !== 'string') return false;
  if (code.length > MAX_COUPON_CODE_LENGTH) return false;
  return /^[A-Z0-9_-]{2,20}$/.test(code);
}

function buildCouponRecord(uid, code, type, value, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!isValidCouponCode(code)) throw new Error('codigo invalido (A-Z0-9_-, 2-20 chars)');
  if (!isValidType(type)) throw new Error('type invalido');
  if (typeof value !== 'number' || value < MIN_DISCOUNT_VALUE) {
    throw new Error('value debe ser numero >= ' + MIN_DISCOUNT_VALUE);
  }
  if (type === 'percentage' && value > MAX_DISCOUNT_PERCENTAGE) {
    throw new Error('porcentaje no puede superar 100');
  }
  const currency = COUPON_CURRENCIES.includes(opts.currency) ? opts.currency : 'USD';
  const now = Date.now();
  return {
    couponId: uid.slice(0, 8) + '_' + code,
    uid,
    code,
    type,
    value,
    currency,
    status: 'active',
    maxUses: typeof opts.maxUses === 'number' && opts.maxUses > 0 ? opts.maxUses : MAX_USES_DEFAULT,
    usedCount: 0,
    minOrderAmount: typeof opts.minOrderAmount === 'number' ? opts.minOrderAmount : 0,
    expiresAt: opts.expiresAt || null,
    description: opts.description || null,
    applicableItems: Array.isArray(opts.applicableItems) ? opts.applicableItems : [],
    createdAt: opts.createdAt || now,
  };
}

async function saveCoupon(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.couponId) throw new Error('record invalido');
  await db()
    .collection('owners').doc(uid)
    .collection(COUPON_COLLECTION).doc(record.couponId)
    .set(record, { merge: true });
  console.log('[COUPON] Guardado uid=' + uid + ' code=' + record.code + ' type=' + record.type);
  return record.couponId;
}

async function getCoupon(uid, code) {
  if (!uid) throw new Error('uid requerido');
  if (!code) throw new Error('code requerido');
  try {
    const couponId = uid.slice(0, 8) + '_' + code;
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(COUPON_COLLECTION).doc(couponId)
      .get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[COUPON] Error getCoupon: ' + e.message);
    return null;
  }
}

function computeDiscount(coupon, orderAmount) {
  if (!coupon || typeof orderAmount !== 'number' || orderAmount <= 0) return 0;
  if (coupon.minOrderAmount && orderAmount < coupon.minOrderAmount) return 0;
  if (coupon.type === 'percentage') {
    return Math.round((orderAmount * coupon.value / 100) * 100) / 100;
  }
  if (coupon.type === 'fixed') {
    return Math.min(coupon.value, orderAmount);
  }
  if (coupon.type === 'free_item') {
    return coupon.value;
  }
  return 0;
}

async function validateCoupon(uid, code, orderAmount, now) {
  if (!uid) throw new Error('uid requerido');
  if (!code) throw new Error('code requerido');
  const coupon = await getCoupon(uid, code);
  if (!coupon) return { valid: false, reason: 'coupon_not_found', discount: 0 };
  if (coupon.status !== 'active') return { valid: false, reason: 'coupon_' + coupon.status, discount: 0 };
  if (coupon.expiresAt && (now || Date.now()) > coupon.expiresAt) {
    return { valid: false, reason: 'coupon_expired', discount: 0 };
  }
  if (coupon.usedCount >= coupon.maxUses) {
    return { valid: false, reason: 'coupon_depleted', discount: 0 };
  }
  if (typeof orderAmount === 'number' && coupon.minOrderAmount && orderAmount < coupon.minOrderAmount) {
    return { valid: false, reason: 'order_below_minimum', discount: 0, minOrderAmount: coupon.minOrderAmount };
  }
  const discount = computeDiscount(coupon, orderAmount || 0);
  return { valid: true, discount, coupon };
}

async function redeemCoupon(uid, code, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!code) throw new Error('code requerido');
  if (!phone) throw new Error('phone requerido');
  const couponId = uid.slice(0, 8) + '_' + code;
  const snap = await db()
    .collection('owners').doc(uid)
    .collection(COUPON_COLLECTION).doc(couponId)
    .get();
  if (!snap.exists) throw new Error('coupon no encontrado');
  const coupon = snap.data();
  const newCount = (coupon.usedCount || 0) + 1;
  const newStatus = newCount >= coupon.maxUses ? 'depleted' : 'active';
  await db()
    .collection('owners').doc(uid)
    .collection(COUPON_COLLECTION).doc(couponId)
    .set({ usedCount: newCount, status: newStatus, updatedAt: Date.now() }, { merge: true });
  const usageId = couponId + '_' + phone.replace(/\D/g, '').slice(-8) + '_' + Date.now();
  await db()
    .collection('owners').doc(uid)
    .collection(COUPON_USAGE_COLLECTION).doc(usageId)
    .set({ couponId, code, phone, redeemedAt: Date.now(), uid });
  console.log('[COUPON] Canjeado uid=' + uid + ' code=' + code + ' phone=' + phone + ' count=' + newCount);
  return { usageId, newCount, newStatus };
}

async function listActiveCoupons(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(COUPON_COLLECTION)
      .where('status', '==', 'active')
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    return docs;
  } catch (e) {
    console.error('[COUPON] Error listActiveCoupons: ' + e.message);
    return [];
  }
}

async function disableCoupon(uid, code) {
  if (!uid) throw new Error('uid requerido');
  if (!code) throw new Error('code requerido');
  const couponId = uid.slice(0, 8) + '_' + code;
  await db()
    .collection('owners').doc(uid)
    .collection(COUPON_COLLECTION).doc(couponId)
    .set({ status: 'disabled', updatedAt: Date.now() }, { merge: true });
  console.log('[COUPON] Desactivado uid=' + uid + ' code=' + code);
  return couponId;
}

function buildCouponText(coupon) {
  if (!coupon) return '';
  const typeLabel = {
    percentage: coupon.value + '% de descuento',
    fixed: coupon.value + ' ' + coupon.currency + ' de descuento',
    free_item: 'Item gratis (valor: ' + coupon.value + ' ' + coupon.currency + ')',
    buy_x_get_y: 'Promo especial',
  };
  const label = typeLabel[coupon.type] || '';
  const expiry = coupon.expiresAt
    ? '\nVence: ' + new Date(coupon.expiresAt).toISOString().slice(0, 10)
    : '';
  const min = coupon.minOrderAmount > 0
    ? '\nCompra minima: ' + coupon.minOrderAmount + ' ' + coupon.currency
    : '';
  const uses = '\nUsos: ' + (coupon.usedCount || 0) + '/' + coupon.maxUses;
  return '\u{1F3AB} *Cupon: ' + coupon.code + '*\n' + label + min + expiry + uses;
}

module.exports = {
  buildCouponRecord, saveCoupon, getCoupon,
  validateCoupon, redeemCoupon, listActiveCoupons,
  disableCoupon, computeDiscount, buildCouponText,
  isValidType, isValidStatus, isValidCouponCode,
  COUPON_TYPES, COUPON_STATUSES, COUPON_CURRENCIES,
  MAX_COUPON_CODE_LENGTH, MIN_DISCOUNT_VALUE,
  MAX_DISCOUNT_PERCENTAGE, MAX_USES_DEFAULT,
  __setFirestoreForTests,
};
