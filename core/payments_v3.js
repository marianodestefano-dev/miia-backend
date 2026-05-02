'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const INVOICE_STATUS = Object.freeze(['pending', 'paid', 'cancelled', 'refunded']);
const REFUND_STATUS = Object.freeze(['pending_owner_approval', 'approved', 'rejected']);

async function generateInvoice(uid, opts) {
  const { phone, items, total, currency } = opts;
  const invoice = { id: randomUUID(), uid, phone, items: items || [], total, currency, status: 'pending', createdAt: new Date().toISOString() };
  await getDb().collection('owners').doc(uid).collection('invoices').doc(invoice.id).set(invoice);
  return invoice;
}

async function markInvoicePaid(uid, invoiceId, paymentData) {
  const ref = getDb().collection('owners').doc(uid).collection('invoices').doc(invoiceId);
  const data = { status: 'paid', paidAt: new Date().toISOString(), paymentRef: paymentData.ref || null };
  await ref.set(data, { merge: true });
  return { invoiceId, ...data };
}

async function getPaymentHistory(uid, phone) {
  const snap = await getDb().collection('owners').doc(uid).collection('invoices').where('phone', '==', phone).get();
  const invoices = [];
  snap.forEach(doc => invoices.push(doc.data()));
  return invoices;
}

async function initiateRefund(uid, invoiceId, opts) {
  const refund = { id: randomUUID(), uid, invoiceId, reason: opts.reason, status: 'pending_owner_approval', createdAt: new Date().toISOString() };
  await getDb().collection('owners').doc(uid).collection('refunds').doc(refund.id).set(refund);
  return refund;
}

async function approveRefund(uid, refundId) {
  const ref = getDb().collection('owners').doc(uid).collection('refunds').doc(refundId);
  await ref.set({ status: 'approved', approvedAt: new Date().toISOString() }, { merge: true });
  return { refundId, status: 'approved' };
}

async function createSplitPayment(uid, opts) {
  const items = opts.items || [];
  const split = { id: randomUUID(), uid, items, totalAmount: items.reduce((s, i) => s + (i.amount || 0), 0), status: 'pending', createdAt: new Date().toISOString() };
  await getDb().collection('split_payments').doc(split.id).set(split);
  return split;
}

module.exports = { __setFirestoreForTests, INVOICE_STATUS, REFUND_STATUS,
  generateInvoice, markInvoicePaid, getPaymentHistory, initiateRefund, approveRefund, createSplitPayment };