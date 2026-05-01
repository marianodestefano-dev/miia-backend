'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const INVOICE_STATUSES = Object.freeze(['draft', 'issued', 'sent', 'paid', 'overdue', 'cancelled', 'credited']);
const INVOICE_TYPES = Object.freeze(['invoice', 'receipt', 'credit_note', 'quote', 'proforma']);
const LINE_ITEM_TYPES = Object.freeze(['product', 'service', 'shipping', 'discount', 'tax', 'custom']);

const MAX_LINE_ITEMS = 50;
const MAX_NOTES_LENGTH = 1000;
const MAX_PAYMENT_TERMS_LENGTH = 200;
const DEFAULT_TAX_RATE = 0.21; // 21% IVA Argentina por defecto
const DUE_DAYS_DEFAULT = 30;

function isValidStatus(s) { return INVOICE_STATUSES.includes(s); }
function isValidType(t) { return INVOICE_TYPES.includes(t); }
function isValidLineType(t) { return LINE_ITEM_TYPES.includes(t); }

function buildInvoiceNumber(uid, sequence) {
  const prefix = uid.slice(0, 4).toUpperCase();
  const seq = String(typeof sequence === 'number' ? sequence : Date.now() % 100000).padStart(5, '0');
  return prefix + '-' + seq;
}

function buildLineItem(data) {
  data = data || {};
  const qty = typeof data.quantity === 'number' && data.quantity > 0 ? data.quantity : 1;
  const unitPrice = typeof data.unitPrice === 'number' && data.unitPrice >= 0 ? data.unitPrice : 0;
  const discountPct = typeof data.discountPercent === 'number' ? Math.min(100, Math.max(0, data.discountPercent)) : 0;
  const subtotal = qty * unitPrice;
  const discountAmount = Math.round(subtotal * discountPct) / 100;
  const total = Math.max(0, subtotal - discountAmount);
  return {
    description: typeof data.description === 'string' ? data.description.trim().slice(0, 200) : '',
    type: isValidLineType(data.type) ? data.type : 'service',
    quantity: qty,
    unit: typeof data.unit === 'string' ? data.unit.trim().slice(0, 20) : 'unidad',
    unitPrice,
    discountPercent: discountPct,
    discountAmount,
    subtotal,
    total,
    taxRate: typeof data.taxRate === 'number' ? data.taxRate : 0,
    taxAmount: typeof data.taxRate === 'number' ? Math.round(total * data.taxRate * 100) / 100 : 0,
    productId: data.productId || null,
    sku: typeof data.sku === 'string' ? data.sku.trim() : '',
  };
}

function computeInvoiceTotals(lineItems, opts) {
  opts = opts || {};
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0, itemCount: 0 };
  }
  const subtotal = lineItems.reduce((acc, item) => acc + (item.subtotal || 0), 0);
  const discountTotal = lineItems.reduce((acc, item) => acc + (item.discountAmount || 0), 0);
  const netBeforeTax = lineItems.reduce((acc, item) => acc + (item.total || 0), 0);
  const taxTotal = lineItems.reduce((acc, item) => acc + (item.taxAmount || 0), 0);
  const extraDiscount = typeof opts.globalDiscountAmount === 'number' ? opts.globalDiscountAmount : 0;
  const total = Math.max(0, netBeforeTax + taxTotal - extraDiscount);
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discountTotal: Math.round((discountTotal + extraDiscount) * 100) / 100,
    taxTotal: Math.round(taxTotal * 100) / 100,
    total: Math.round(total * 100) / 100,
    itemCount: lineItems.length,
  };
}

function buildInvoiceRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const invoiceType = isValidType(data.type) ? data.type : 'invoice';
  const lineItems = Array.isArray(data.lineItems)
    ? data.lineItems.map(li => buildLineItem(li)).slice(0, MAX_LINE_ITEMS)
    : [];
  const totals = computeInvoiceTotals(lineItems, { globalDiscountAmount: data.globalDiscountAmount });
  const dueDate = data.dueDate || (now + DUE_DAYS_DEFAULT * 24 * 60 * 60 * 1000);
  return {
    invoiceId: data.invoiceId || (uid.slice(0, 8) + '_inv_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5)),
    uid,
    invoiceNumber: data.invoiceNumber || buildInvoiceNumber(uid, data.sequence),
    type: invoiceType,
    status: isValidStatus(data.status) ? data.status : 'draft',
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    issueDate: data.issueDate || now,
    dueDate,
    clientName: typeof data.clientName === 'string' ? data.clientName.trim().slice(0, 100) : '',
    clientEmail: typeof data.clientEmail === 'string' ? data.clientEmail.trim() : null,
    clientPhone: typeof data.clientPhone === 'string' ? data.clientPhone.trim() : null,
    clientAddress: typeof data.clientAddress === 'string' ? data.clientAddress.trim().slice(0, 300) : '',
    clientTaxId: typeof data.clientTaxId === 'string' ? data.clientTaxId.trim() : '',
    lineItems,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    amountPaid: 0,
    amountDue: totals.total,
    paymentId: data.paymentId || null,
    appointmentId: data.appointmentId || null,
    notes: typeof data.notes === 'string' ? data.notes.slice(0, MAX_NOTES_LENGTH) : '',
    paymentTerms: typeof data.paymentTerms === 'string' ? data.paymentTerms.slice(0, MAX_PAYMENT_TERMS_LENGTH) : '',
    paidAt: null,
    sentAt: null,
    cancelledAt: null,
    creditedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function applyPayment(invoice, amountPaid) {
  if (typeof amountPaid !== 'number' || amountPaid < 0) throw new Error('amountPaid debe ser numero >= 0');
  const newAmountPaid = Math.min(invoice.total, (invoice.amountPaid || 0) + amountPaid);
  const newAmountDue = Math.max(0, invoice.total - newAmountPaid);
  const now = Date.now();
  const newStatus = newAmountDue <= 0 ? 'paid' : invoice.status;
  return {
    ...invoice,
    amountPaid: Math.round(newAmountPaid * 100) / 100,
    amountDue: Math.round(newAmountDue * 100) / 100,
    status: newStatus,
    paidAt: newStatus === 'paid' ? now : invoice.paidAt,
    updatedAt: now,
  };
}

function cancelInvoice(invoice) {
  if (invoice.status === 'paid') throw new Error('No se puede cancelar una factura pagada');
  if (invoice.status === 'cancelled') throw new Error('La factura ya esta cancelada');
  const now = Date.now();
  return { ...invoice, status: 'cancelled', cancelledAt: now, updatedAt: now };
}

function checkOverdue(invoice) {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') return false;
  return invoice.dueDate < Date.now() && invoice.amountDue > 0;
}

function buildInvoiceText(invoice) {
  if (!invoice) return 'Factura no encontrada.';
  const parts = [];
  const icons = {
    draft: '\u{1F4DD}', issued: '\u{1F4C4}', sent: '\u{1F4E4}',
    paid: '\u{2705}', overdue: '\u{1F534}', cancelled: '\u{274C}', credited: '\u{1F4B0}',
  };
  const icon = icons[invoice.status] || '\u{1F4CB}';
  parts.push(icon + ' *' + invoice.invoiceNumber + '* (' + invoice.type + ')');
  parts.push('Cliente: ' + (invoice.clientName || 'N/A'));
  parts.push('Estado: ' + invoice.status + ' | Moneda: ' + invoice.currency);
  if (invoice.lineItems && invoice.lineItems.length > 0) {
    parts.push('Items: ' + invoice.lineItems.length);
    invoice.lineItems.slice(0, 3).forEach(li => {
      parts.push('  - ' + li.description + ' x' + li.quantity + ': ' + li.total);
    });
  }
  if (invoice.discountTotal > 0) parts.push('Descuento: -' + invoice.discountTotal);
  if (invoice.taxTotal > 0) parts.push('IVA: +' + invoice.taxTotal);
  parts.push('TOTAL: ' + invoice.total + ' ' + invoice.currency);
  if (invoice.amountDue > 0 && invoice.status !== 'cancelled') {
    parts.push('Saldo pendiente: ' + invoice.amountDue);
  }
  return parts.join('\n');
}

async function saveInvoice(uid, invoice) {
  console.log('[INVOICE] Guardando factura uid=' + uid + ' id=' + invoice.invoiceId + ' n=' + invoice.invoiceNumber);
  try {
    await db().collection('owners').doc(uid)
      .collection('invoices').doc(invoice.invoiceId)
      .set(invoice, { merge: false });
    return invoice.invoiceId;
  } catch (err) {
    console.error('[INVOICE] Error guardando factura:', err.message);
    throw err;
  }
}

async function getInvoice(uid, invoiceId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('invoices').doc(invoiceId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[INVOICE] Error obteniendo factura:', err.message);
    return null;
  }
}

async function updateInvoice(uid, invoiceId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('invoices').doc(invoiceId)
      .set(update, { merge: true });
    return invoiceId;
  } catch (err) {
    console.error('[INVOICE] Error actualizando factura:', err.message);
    throw err;
  }
}

async function listInvoices(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('invoices');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.clientPhone && rec.clientPhone !== opts.clientPhone) return;
      results.push(rec);
    });
    results.sort((a, b) => b.issueDate - a.issueDate);
    return results.slice(0, opts.limit || 100);
  } catch (err) {
    console.error('[INVOICE] Error listando facturas:', err.message);
    return [];
  }
}

module.exports = {
  buildInvoiceRecord,
  buildLineItem,
  computeInvoiceTotals,
  applyPayment,
  cancelInvoice,
  checkOverdue,
  buildInvoiceText,
  buildInvoiceNumber,
  saveInvoice,
  getInvoice,
  updateInvoice,
  listInvoices,
  INVOICE_STATUSES,
  INVOICE_TYPES,
  LINE_ITEM_TYPES,
  MAX_LINE_ITEMS,
  DEFAULT_TAX_RATE,
  DUE_DAYS_DEFAULT,
  __setFirestoreForTests,
};
