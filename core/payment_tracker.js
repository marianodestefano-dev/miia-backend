'use strict';

/**
 * MIIA - Payment Tracker (T247)
 * P4.3 ROADMAP: seguimiento de pagos y transacciones de clientes del owner.
 * Registra pagos recibidos, pendientes, y genera reportes financieros basicos.
 */

const PAYMENT_STATUSES = Object.freeze([
  'pending', 'confirmed', 'partial', 'failed', 'refunded', 'cancelled',
]);

const PAYMENT_METHODS = Object.freeze([
  'cash', 'transfer', 'card', 'mercadopago', 'paypal', 'crypto', 'other',
]);

const PAYMENT_CURRENCIES = Object.freeze([
  'USD', 'ARS', 'COP', 'MXN', 'CLP', 'PEN', 'BRL',
]);

const MAX_PAYMENTS_PER_QUERY = 100;
const PAYMENT_COLLECTION = 'payments';
const OVERDUE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidStatus(status) {
  return PAYMENT_STATUSES.includes(status);
}

function isValidMethod(method) {
  return PAYMENT_METHODS.includes(method);
}

function isValidCurrency(currency) {
  return PAYMENT_CURRENCIES.includes(currency);
}

function buildPaymentRecord(uid, contactPhone, amount, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!contactPhone) throw new Error('contactPhone requerido');
  if (typeof amount !== 'number' || amount < 0) throw new Error('amount invalido: debe ser numero >= 0');
  var method = (opts && opts.method && isValidMethod(opts.method)) ? opts.method : 'other';
  var currency = (opts && opts.currency && isValidCurrency(opts.currency)) ? opts.currency : 'USD';
  var paymentId = 'pay_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  return {
    paymentId,
    uid,
    contactPhone,
    amount,
    currency,
    method,
    status: (opts && opts.status && isValidStatus(opts.status)) ? opts.status : 'pending',
    description: (opts && opts.description) ? String(opts.description).slice(0, 300) : null,
    reference: (opts && opts.reference) ? String(opts.reference) : null,
    dueDate: (opts && opts.dueDate) ? opts.dueDate : null,
    paidAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: (opts && opts.notes) ? String(opts.notes).slice(0, 500) : null,
  };
}

async function savePayment(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.paymentId) throw new Error('record invalido');
  await db().collection('tenants').doc(uid).collection(PAYMENT_COLLECTION).doc(record.paymentId).set(record);
  console.log('[PAYMENT] Guardado uid=' + uid + ' id=' + record.paymentId + ' amount=' + record.amount + ' ' + record.currency);
  return record.paymentId;
}

async function updatePaymentStatus(uid, paymentId, status, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!paymentId) throw new Error('paymentId requerido');
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  var update = { status, updatedAt: new Date().toISOString() };
  if (status === 'confirmed' || status === 'partial') {
    update.paidAt = new Date().toISOString();
  }
  if (opts && opts.notes) update.notes = String(opts.notes).slice(0, 500);
  if (opts && opts.reference) update.reference = opts.reference;
  await db().collection('tenants').doc(uid).collection(PAYMENT_COLLECTION).doc(paymentId).set(update, { merge: true });
  console.log('[PAYMENT] Status actualizado uid=' + uid + ' id=' + paymentId + ' status=' + status);
}

async function getPayments(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(PAYMENT_COLLECTION).get();
    var payments = [];
    snap.forEach(function(doc) { payments.push(doc.data()); });
    if (opts && opts.status) payments = payments.filter(function(p) { return p.status === opts.status; });
    if (opts && opts.phone) payments = payments.filter(function(p) { return p.contactPhone === opts.phone; });
    if (opts && opts.currency) payments = payments.filter(function(p) { return p.currency === opts.currency; });
    payments.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    return payments.slice(0, MAX_PAYMENTS_PER_QUERY);
  } catch (e) {
    console.error('[PAYMENT] Error leyendo pagos: ' + e.message);
    return [];
  }
}

async function getPaymentsByPhone(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  return await getPayments(uid, { phone });
}

function computePaymentSummary(payments) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return { total: 0, confirmed: 0, pending: 0, failed: 0, currencies: {} };
  }
  var summary = { total: 0, confirmed: 0, pending: 0, failed: 0, refunded: 0, currencies: {} };
  payments.forEach(function(p) {
    summary.total++;
    if (p.status === 'confirmed' || p.status === 'partial') summary.confirmed++;
    if (p.status === 'pending') summary.pending++;
    if (p.status === 'failed') summary.failed++;
    if (p.status === 'refunded') summary.refunded++;
    var cur = p.currency || 'USD';
    if (!summary.currencies[cur]) summary.currencies[cur] = { total: 0, confirmed: 0, pending: 0 };
    summary.currencies[cur].total += (p.amount || 0);
    if (p.status === 'confirmed' || p.status === 'partial') summary.currencies[cur].confirmed += (p.amount || 0);
    if (p.status === 'pending') summary.currencies[cur].pending += (p.amount || 0);
  });
  return summary;
}

function isOverdue(payment, nowMs) {
  if (!payment || !payment.dueDate) return false;
  if (payment.status === 'confirmed' || payment.status === 'refunded') return false;
  var now = nowMs || Date.now();
  return new Date(payment.dueDate).getTime() < now;
}

function getOverduePayments(payments, nowMs) {
  if (!Array.isArray(payments)) return [];
  return payments.filter(function(p) { return isOverdue(p, nowMs); });
}

function buildPaymentStatusText(payment) {
  if (!payment) return '';
  var emoji = {
    pending: '⏳', confirmed: '✅', partial: '⚠️', failed: '❌', refunded: '↩️', cancelled: '🚫',
  }[payment.status] || '❓';
  var lines = [
    emoji + ' *Pago ' + payment.paymentId + '*',
    'Cliente: ' + payment.contactPhone,
    'Monto: ' + payment.amount.toLocaleString('es') + ' ' + payment.currency,
    'Método: ' + payment.method,
    'Estado: ' + payment.status,
  ];
  if (payment.description) lines.push('Concepto: ' + payment.description);
  if (payment.dueDate) lines.push('Vencimiento: ' + new Date(payment.dueDate).toLocaleDateString('es'));
  return lines.join('\n');
}

function buildPaymentSummaryText(uid, summary) {
  if (!summary) return '';
  var lines = ['💰 *Resumen de Pagos*'];
  lines.push('Total: ' + summary.total + ' | Confirmados: ' + summary.confirmed + ' | Pendientes: ' + summary.pending);
  if (summary.failed > 0) lines.push('Fallidos: ' + summary.failed);
  Object.keys(summary.currencies).forEach(function(cur) {
    var c = summary.currencies[cur];
    lines.push(cur + ': cobrado ' + c.confirmed.toLocaleString('es') + ' / pendiente ' + c.pending.toLocaleString('es'));
  });
  return lines.join('\n');
}

module.exports = {
  buildPaymentRecord,
  savePayment,
  updatePaymentStatus,
  getPayments,
  getPaymentsByPhone,
  computePaymentSummary,
  isOverdue,
  getOverduePayments,
  buildPaymentStatusText,
  buildPaymentSummaryText,
  isValidStatus,
  isValidMethod,
  isValidCurrency,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_CURRENCIES,
  MAX_PAYMENTS_PER_QUERY,
  OVERDUE_THRESHOLD_MS,
  __setFirestoreForTests,
};
