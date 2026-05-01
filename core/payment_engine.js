'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const PAYMENT_METHODS = Object.freeze([
  'cash', 'card_credit', 'card_debit', 'transfer', 'qr_code',
  'mercadopago', 'paypal', 'stripe', 'crypto', 'gift_card', 'other',
]);

const PAYMENT_STATUSES = Object.freeze([
  'pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded', 'cancelled', 'disputed',
]);

const REFUND_STATUSES = Object.freeze(['pending', 'processing', 'completed', 'failed', 'cancelled']);

const MAX_INSTALLMENTS = 48;
const MAX_PAYMENT_AMOUNT = 100000000; // 100M
const PAYMENT_EXPIRY_MS = 24 * 3600 * 1000; // 24h default

function isValidMethod(m) { return PAYMENT_METHODS.includes(m); }
function isValidStatus(s) { return PAYMENT_STATUSES.includes(s); }

function buildPaymentId(uid) {
  const now = Date.now();
  return uid.slice(0, 8) + '_pay_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5);
}

function buildPaymentRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const amount = typeof data.amount === 'number' ? Math.min(MAX_PAYMENT_AMOUNT, Math.max(0, data.amount)) : 0;
  const installments = typeof data.installments === 'number'
    ? Math.min(MAX_INSTALLMENTS, Math.max(1, Math.floor(data.installments)))
    : 1;
  const installmentAmount = installments > 1 ? Math.round(amount / installments * 100) / 100 : amount;

  return {
    paymentId: data.paymentId || buildPaymentId(uid),
    uid,
    orderId: data.orderId || null,
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone.trim() : null,
    contactName: typeof data.contactName === 'string' ? data.contactName.trim().slice(0, 100) : null,
    method: isValidMethod(data.method) ? data.method : 'other',
    status: isValidStatus(data.status) ? data.status : 'pending',
    amount,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    installments,
    installmentAmount,
    amountReceived: 0,
    amountRefunded: 0,
    description: typeof data.description === 'string' ? data.description.slice(0, 500) : '',
    externalId: typeof data.externalId === 'string' ? data.externalId.slice(0, 200) : null, // ID del proveedor de pagos
    externalUrl: typeof data.externalUrl === 'string' ? data.externalUrl.slice(0, 500) : null,
    errorCode: null,
    errorMessage: null,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : (now + PAYMENT_EXPIRY_MS),
    paidAt: null,
    failedAt: null,
    refundedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function processPayment(payment, result) {
  result = result || {};
  const now = Date.now();
  if (result.success) {
    const received = typeof result.amountReceived === 'number' ? result.amountReceived : payment.amount;
    return {
      ...payment,
      status: 'completed',
      amountReceived: received,
      externalId: result.externalId || payment.externalId,
      paidAt: now,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    };
  } else {
    return {
      ...payment,
      status: 'failed',
      errorCode: typeof result.errorCode === 'string' ? result.errorCode.slice(0, 50) : 'unknown_error',
      errorMessage: typeof result.errorMessage === 'string' ? result.errorMessage.slice(0, 500) : 'Payment failed',
      failedAt: now,
      updatedAt: now,
    };
  }
}

function markProcessing(payment) {
  if (payment.status !== 'pending') throw new Error('only_pending_can_start_processing');
  return { ...payment, status: 'processing', updatedAt: Date.now() };
}

function cancelPayment(payment) {
  if (['completed', 'refunded', 'cancelled'].includes(payment.status)) {
    throw new Error('cannot_cancel_' + payment.status);
  }
  return { ...payment, status: 'cancelled', updatedAt: Date.now() };
}

function buildRefundId(uid, paymentId) {
  const now = Date.now();
  return uid.slice(0, 6) + '_ref_' + paymentId.slice(-6) + '_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 4);
}

function buildRefundRecord(uid, paymentId, data) {
  data = data || {};
  const now = Date.now();
  return {
    refundId: data.refundId || buildRefundId(uid, paymentId),
    uid,
    paymentId,
    amount: typeof data.amount === 'number' ? Math.max(0, data.amount) : 0,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    reason: typeof data.reason === 'string' ? data.reason.slice(0, 300) : '',
    status: REFUND_STATUSES.includes(data.status) ? data.status : 'pending',
    externalRefundId: typeof data.externalRefundId === 'string' ? data.externalRefundId : null,
    processedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
  };
}

function applyRefund(payment, refundAmount) {
  if (payment.status !== 'completed' && payment.status !== 'partially_refunded') {
    throw new Error('cannot_refund_' + payment.status);
  }
  if (typeof refundAmount !== 'number' || refundAmount <= 0) throw new Error('invalid_refund_amount');
  const newRefunded = payment.amountRefunded + refundAmount;
  if (newRefunded > payment.amountReceived) throw new Error('refund_exceeds_amount_received');
  const now = Date.now();
  const isFullRefund = newRefunded >= payment.amountReceived;
  return {
    ...payment,
    amountRefunded: Math.round(newRefunded * 100) / 100,
    status: isFullRefund ? 'refunded' : 'partially_refunded',
    refundedAt: isFullRefund ? now : payment.refundedAt,
    updatedAt: now,
  };
}

function isExpired(payment) {
  return payment.status === 'pending' && Date.now() > payment.expiresAt;
}

function computePaymentStats(payments) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return {
      total: 0, completedCount: 0, failedCount: 0, successRate: 0,
      totalCollected: 0, totalRefunded: 0, byMethod: {}, avgAmount: 0,
    };
  }
  let completedCount = 0, failedCount = 0, totalCollected = 0, totalRefunded = 0, totalAmount = 0;
  const byMethod = {};
  for (const p of payments) {
    if (p.status === 'completed' || p.status === 'partially_refunded') completedCount++;
    if (p.status === 'failed') failedCount++;
    if (p.status === 'refunded') completedCount++; // contado como completado (fue procesado)
    totalCollected += p.amountReceived;
    totalRefunded += p.amountRefunded;
    totalAmount += p.amount;
    byMethod[p.method] = (byMethod[p.method] || 0) + 1;
  }
  const attempted = completedCount + failedCount;
  const successRate = attempted > 0 ? Math.round(completedCount / attempted * 100 * 100) / 100 : 0;
  const avgAmount = Math.round(totalAmount / payments.length * 100) / 100;
  return {
    total: payments.length,
    completedCount,
    failedCount,
    successRate,
    totalCollected: Math.round(totalCollected * 100) / 100,
    totalRefunded: Math.round(totalRefunded * 100) / 100,
    byMethod,
    avgAmount,
  };
}

function buildPaymentSummaryText(payment) {
  if (!payment) return 'Pago no encontrado.';
  const statusIcons = {
    pending: '\u{23F3}', processing: '\u{1F504}', completed: '\u{2705}',
    failed: '\u{274C}', refunded: '\u{1F4B8}', partially_refunded: '\u{1F4B5}',
    cancelled: '\u{1F6AB}', disputed: '\u{2696}\u{FE0F}',
  };
  const icon = statusIcons[payment.status] || '\u{1F4B3}';
  const lines = [];
  lines.push(icon + ' Pago ' + payment.paymentId.slice(-8).toUpperCase() + ' — ' + payment.status.toUpperCase());
  lines.push('Monto: ' + payment.currency + ' ' + payment.amount.toLocaleString('es-AR'));
  lines.push('Metodo: ' + payment.method);
  if (payment.installments > 1) lines.push('Cuotas: ' + payment.installments + 'x ' + payment.currency + ' ' + payment.installmentAmount.toLocaleString('es-AR'));
  if (payment.amountReceived > 0) lines.push('Recibido: ' + payment.currency + ' ' + payment.amountReceived.toLocaleString('es-AR'));
  if (payment.amountRefunded > 0) lines.push('Reintegrado: ' + payment.currency + ' ' + payment.amountRefunded.toLocaleString('es-AR'));
  if (payment.errorMessage) lines.push('Error: ' + payment.errorMessage);
  if (payment.contactName) lines.push('Cliente: ' + payment.contactName);
  if (payment.paidAt) lines.push('Pagado: ' + new Date(payment.paidAt).toISOString().slice(0, 10));
  return lines.join('\n');
}

// ─── Firestore CRUD ──────────────────────────────────────────────────────────

async function savePayment(uid, payment) {
  console.log('[PAYMENT] Guardando pago uid=' + uid + ' paymentId=' + payment.paymentId + ' status=' + payment.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('payments').doc(payment.paymentId)
      .set(payment, { merge: false });
    return payment.paymentId;
  } catch (err) {
    console.error('[PAYMENT] Error guardando pago:', err.message);
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
    console.error('[PAYMENT] Error obteniendo pago:', err.message);
    return null;
  }
}

async function updatePayment(uid, paymentId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('payments').doc(paymentId)
      .set(update, { merge: true });
    return paymentId;
  } catch (err) {
    console.error('[PAYMENT] Error actualizando pago:', err.message);
    throw err;
  }
}

async function saveRefund(uid, refund) {
  console.log('[PAYMENT] Guardando reintegro id=' + refund.refundId + ' amount=' + refund.amount);
  try {
    await db().collection('owners').doc(uid)
      .collection('payment_refunds').doc(refund.refundId)
      .set(refund, { merge: false });
    return refund.refundId;
  } catch (err) {
    console.error('[PAYMENT] Error guardando reintegro:', err.message);
    throw err;
  }
}

async function listPaymentsByContact(uid, contactPhone) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('payments').where('contactPhone', '==', contactPhone).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[PAYMENT] Error listando pagos por contacto:', err.message);
    return [];
  }
}

async function listPaymentsByStatus(uid, status) {
  try {
    const ref = db().collection('owners').doc(uid).collection('payments');
    const snap = status
      ? await ref.where('status', '==', status).get()
      : await ref.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[PAYMENT] Error listando pagos por status:', err.message);
    return [];
  }
}

module.exports = {
  buildPaymentRecord,
  processPayment,
  markProcessing,
  cancelPayment,
  buildRefundRecord,
  applyRefund,
  isExpired,
  computePaymentStats,
  buildPaymentSummaryText,
  savePayment,
  getPayment,
  updatePayment,
  saveRefund,
  listPaymentsByContact,
  listPaymentsByStatus,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  MAX_INSTALLMENTS,
  PAYMENT_EXPIRY_MS,
  __setFirestoreForTests,
};
