'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const PAYMENT_STATUSES = Object.freeze(['pending', 'processing', 'confirmed', 'failed', 'refunded', 'cancelled', 'disputed']);
const PAYMENT_METHODS = Object.freeze(['cash', 'transfer', 'card', 'mercadopago', 'paypal', 'stripe', 'other']);
const PAYMENT_CURRENCIES = Object.freeze(['ARS', 'USD', 'COP', 'MXN', 'CLP', 'PEN', 'BRL']);
const PAYMENT_TYPES = Object.freeze(['sale', 'subscription', 'deposit', 'refund', 'tip', 'other']);

const MAX_PAYMENT_NOTES_LENGTH = 500;
const MAX_REFERENCE_LENGTH = 100;
const MIN_PAYMENT_AMOUNT = 0;

function isValidStatus(s) { return PAYMENT_STATUSES.includes(s); }
function isValidMethod(m) { return PAYMENT_METHODS.includes(m); }
function isValidCurrency(c) { return PAYMENT_CURRENCIES.includes(c); }
function isValidType(t) { return PAYMENT_TYPES.includes(t); }
function isValidAmount(a) { return typeof a === 'number' && isFinite(a) && a >= MIN_PAYMENT_AMOUNT; }

function buildPaymentId(uid, type) {
  const ts = Date.now().toString(36);
  const typeSlug = (type || 'other').replace(/_/g, '').slice(0, 6);
  return uid.slice(0, 8) + '_pay_' + typeSlug + '_' + ts;
}

function buildPaymentRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const paymentId = data.paymentId || buildPaymentId(uid, data.type || 'sale');
  return {
    paymentId,
    uid,
    amount: isValidAmount(data.amount) ? data.amount : 0,
    currency: isValidCurrency(data.currency) ? data.currency : 'ARS',
    method: isValidMethod(data.method) ? data.method : 'other',
    type: isValidType(data.type) ? data.type : 'sale',
    status: isValidStatus(data.status) ? data.status : 'pending',
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone.trim() : null,
    contactName: typeof data.contactName === 'string' ? data.contactName.trim().slice(0, 100) : null,
    description: typeof data.description === 'string' ? data.description.trim().slice(0, MAX_PAYMENT_NOTES_LENGTH) : '',
    externalReference: typeof data.externalReference === 'string'
      ? data.externalReference.trim().slice(0, MAX_REFERENCE_LENGTH) : null,
    invoiceId: typeof data.invoiceId === 'string' ? data.invoiceId.trim() : null,
    appointmentId: typeof data.appointmentId === 'string' ? data.appointmentId.trim() : null,
    couponId: typeof data.couponId === 'string' ? data.couponId.trim() : null,
    discountAmount: isValidAmount(data.discountAmount) ? data.discountAmount : 0,
    taxAmount: isValidAmount(data.taxAmount) ? data.taxAmount : 0,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
    confirmedAt: null,
    failedAt: null,
    refundedAt: null,
  };
}

function computePaymentTotal(payment) {
  if (!payment) return 0;
  const base = payment.amount || 0;
  const tax = payment.taxAmount || 0;
  const discount = payment.discountAmount || 0;
  return Math.max(0, base + tax - discount);
}

function validatePaymentData(data) {
  const errors = [];
  if (!isValidAmount(data.amount)) {
    errors.push('amount debe ser numero no negativo');
  }
  if (data.currency && !isValidCurrency(data.currency)) {
    errors.push('currency invalida: ' + data.currency);
  }
  if (data.method && !isValidMethod(data.method)) {
    errors.push('method invalido: ' + data.method);
  }
  if (data.type && !isValidType(data.type)) {
    errors.push('type invalido: ' + data.type);
  }
  if (data.status && !isValidStatus(data.status)) {
    errors.push('status invalido: ' + data.status);
  }
  return { valid: errors.length === 0, errors };
}

async function savePayment(uid, payment) {
  console.log('[PAYMENT] Guardando uid=' + uid + ' id=' + payment.paymentId + ' amount=' + payment.amount + ' ' + payment.currency);
  try {
    await db().collection('owners').doc(uid)
      .collection('payments').doc(payment.paymentId)
      .set(payment, { merge: false });
    return payment.paymentId;
  } catch (err) {
    console.error('[PAYMENT] Error guardando:', err.message);
    throw err;
  }
}

async function getPayment(uid, paymentId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('payments').doc(paymentId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[PAYMENT] Error obteniendo:', err.message);
    return null;
  }
}

async function updatePaymentStatus(uid, paymentId, status, extraFields) {
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  const update = { status, updatedAt: Date.now(), ...(extraFields || {}) };
  if (status === 'confirmed') update.confirmedAt = Date.now();
  if (status === 'failed') update.failedAt = Date.now();
  if (status === 'refunded') update.refundedAt = Date.now();
  console.log('[PAYMENT] Actualizando status uid=' + uid + ' id=' + paymentId + ' -> ' + status);
  try {
    await db().collection('owners').doc(uid)
      .collection('payments').doc(paymentId)
      .set(update, { merge: true });
    return paymentId;
  } catch (err) {
    console.error('[PAYMENT] Error actualizando status:', err.message);
    throw err;
  }
}

async function listPayments(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('payments');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.contactPhone && rec.contactPhone !== opts.contactPhone) return;
      results.push(rec);
    });
    results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
    return results.slice(0, limit);
  } catch (err) {
    console.error('[PAYMENT] Error listando:', err.message);
    return [];
  }
}

function computePaymentSummary(payments) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return { total: 0, confirmed: 0, pending: 0, failed: 0, refunded: 0, count: 0, avgAmount: 0 };
  }
  const confirmed = payments.filter(p => p.status === 'confirmed');
  const pending = payments.filter(p => p.status === 'pending');
  const failed = payments.filter(p => p.status === 'failed');
  const refunded = payments.filter(p => p.status === 'refunded');
  const total = confirmed.reduce((sum, p) => sum + computePaymentTotal(p), 0);
  const avg = payments.length > 0 ? Math.round(total / (confirmed.length || 1)) : 0;
  return {
    total,
    confirmed: confirmed.length,
    pending: pending.length,
    failed: failed.length,
    refunded: refunded.length,
    count: payments.length,
    avgAmount: avg,
  };
}

function buildPaymentText(payment) {
  if (!payment) return '';
  const parts = [];
  const statusIcon = { confirmed: '\u{2705}', pending: '\u{23F3}', failed: '\u{274C}', refunded: '\u{1F504}' };
  const icon = statusIcon[payment.status] || '\u{1F4B3}';
  parts.push(icon + ' *Pago #' + payment.paymentId.slice(-8) + '*');
  parts.push('Monto: ' + computePaymentTotal(payment) + ' ' + payment.currency);
  parts.push('Metodo: ' + payment.method);
  parts.push('Estado: ' + payment.status);
  if (payment.contactName) parts.push('Cliente: ' + payment.contactName);
  if (payment.description) parts.push('Detalle: ' + payment.description);
  if (payment.couponId) parts.push('\u{1F3AB} Cupon aplicado: ' + payment.couponId);
  if (payment.discountAmount > 0) parts.push('Descuento: -' + payment.discountAmount + ' ' + payment.currency);
  return parts.join('\n');
}

function buildPaymentSummaryText(payments, opts) {
  opts = opts || {};
  const summary = computePaymentSummary(payments);
  const currency = (payments && payments[0] && payments[0].currency) || 'ARS';
  const parts = [];
  parts.push('\u{1F4CA} *Resumen de Pagos*');
  if (opts.timeframe) parts.push('Periodo: ' + opts.timeframe);
  parts.push('Total recaudado: ' + summary.total + ' ' + currency);
  parts.push('Confirmados: ' + summary.confirmed + ' | Pendientes: ' + summary.pending + ' | Fallidos: ' + summary.failed);
  parts.push('Total transacciones: ' + summary.count);
  if (summary.confirmed > 0) parts.push('Promedio: ' + summary.avgAmount + ' ' + currency);
  return parts.join('\n');
}

module.exports = {
  buildPaymentRecord,
  validatePaymentData,
  computePaymentTotal,
  savePayment,
  getPayment,
  updatePaymentStatus,
  listPayments,
  computePaymentSummary,
  buildPaymentText,
  buildPaymentSummaryText,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_CURRENCIES,
  PAYMENT_TYPES,
  __setFirestoreForTests,
};
