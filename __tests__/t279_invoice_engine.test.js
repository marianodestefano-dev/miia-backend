'use strict';

const {
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
} = require('../core/invoice_engine');

function makeMockDb() {
  const stored = {};
  const db = {
    collection: () => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data) => {
              if (!stored[uid]) stored[uid] = {};
              stored[uid][id] = { ...data };
            },
            get: async () => {
              const rec = stored[uid] && stored[uid][id];
              return { exists: !!rec, data: () => rec };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              const all = Object.values(stored[uid] || {});
              const filtered = all.filter(r => {
                if (op === '==') return r[field] === val;
                if (op === '<=') return r[field] <= val;
                return true;
              });
              return {
                empty: filtered.length === 0,
                forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
              };
            },
          }),
          get: async () => {
            const all = Object.values(stored[uid] || {});
            return {
              empty: all.length === 0,
              forEach: (fn) => all.forEach(d => fn({ data: () => d })),
            };
          },
        }),
      }),
    }),
  };
  return { db, stored };
}

const UID = 'usr_inv_test_001';

describe('T279 — invoice_engine', () => {
  let mockDb, stored;

  beforeEach(() => {
    const m = makeMockDb();
    mockDb = m.db;
    stored = m.stored;
    __setFirestoreForTests(mockDb);
  });

  // ─── Constantes ───────────────────────────────────────────────────────────

  describe('Constantes exportadas', () => {
    test('INVOICE_STATUSES es frozen y contiene todos los estados', () => {
      expect(Object.isFrozen(INVOICE_STATUSES)).toBe(true);
      expect(INVOICE_STATUSES).toContain('draft');
      expect(INVOICE_STATUSES).toContain('paid');
      expect(INVOICE_STATUSES).toContain('overdue');
      expect(INVOICE_STATUSES).toContain('cancelled');
      expect(INVOICE_STATUSES).toContain('credited');
    });

    test('INVOICE_TYPES es frozen y contiene tipos esperados', () => {
      expect(Object.isFrozen(INVOICE_TYPES)).toBe(true);
      expect(INVOICE_TYPES).toContain('invoice');
      expect(INVOICE_TYPES).toContain('credit_note');
      expect(INVOICE_TYPES).toContain('quote');
    });

    test('LINE_ITEM_TYPES es frozen', () => {
      expect(Object.isFrozen(LINE_ITEM_TYPES)).toBe(true);
      expect(LINE_ITEM_TYPES).toContain('product');
      expect(LINE_ITEM_TYPES).toContain('service');
      expect(LINE_ITEM_TYPES).toContain('discount');
    });

    test('DEFAULT_TAX_RATE es 0.21 y DUE_DAYS_DEFAULT es 30', () => {
      expect(DEFAULT_TAX_RATE).toBe(0.21);
      expect(DUE_DAYS_DEFAULT).toBe(30);
    });

    test('MAX_LINE_ITEMS es 50', () => {
      expect(MAX_LINE_ITEMS).toBe(50);
    });
  });

  // ─── buildInvoiceNumber ───────────────────────────────────────────────────

  describe('buildInvoiceNumber', () => {
    test('genera formato XXXX-NNNNN con UID y sequence', () => {
      const num = buildInvoiceNumber('abcdef1234', 42);
      expect(num).toMatch(/^ABCD-\d{5}$/);
      expect(num).toBe('ABCD-00042');
    });

    test('sin sequence usa timestamp fallback', () => {
      const num = buildInvoiceNumber('zyx9876', undefined);
      expect(num).toMatch(/^ZYX9-\d{5}$/);
    });
  });

  // ─── buildLineItem ─────────────────────────────────────────────────────────

  describe('buildLineItem', () => {
    test('calcula subtotal, discountAmount y total correctamente', () => {
      const item = buildLineItem({ description: 'Servicio A', quantity: 3, unitPrice: 100, discountPercent: 10 });
      expect(item.quantity).toBe(3);
      expect(item.unitPrice).toBe(100);
      expect(item.subtotal).toBe(300);
      expect(item.discountAmount).toBe(30);
      expect(item.total).toBe(270);
    });

    test('taxAmount calculado cuando taxRate es numero', () => {
      const item = buildLineItem({ quantity: 2, unitPrice: 50, taxRate: 0.21 });
      expect(item.taxAmount).toBeCloseTo(21);
    });

    test('defaults cuando data esta vacia', () => {
      const item = buildLineItem({});
      expect(item.quantity).toBe(1);
      expect(item.unitPrice).toBe(0);
      expect(item.type).toBe('service');
      expect(item.unit).toBe('unidad');
      expect(item.taxAmount).toBe(0);
    });

    test('type invalido cae a service', () => {
      const item = buildLineItem({ type: 'invalido' });
      expect(item.type).toBe('service');
    });

    test('type valido se respeta', () => {
      const item = buildLineItem({ type: 'product' });
      expect(item.type).toBe('product');
    });

    test('discountPercent se clampea entre 0 y 100', () => {
      const item1 = buildLineItem({ quantity: 1, unitPrice: 100, discountPercent: 150 });
      expect(item1.discountPercent).toBe(100);
      const item2 = buildLineItem({ quantity: 1, unitPrice: 100, discountPercent: -5 });
      expect(item2.discountPercent).toBe(0);
    });

    test('total nunca negativo', () => {
      const item = buildLineItem({ quantity: 1, unitPrice: 0, discountPercent: 100 });
      expect(item.total).toBeGreaterThanOrEqual(0);
    });

    test('description truncada a 200 chars', () => {
      const long = 'x'.repeat(300);
      const item = buildLineItem({ description: long });
      expect(item.description.length).toBe(200);
    });
  });

  // ─── computeInvoiceTotals ──────────────────────────────────────────────────

  describe('computeInvoiceTotals', () => {
    test('suma subtotal, discountTotal, taxTotal y total correctamente', () => {
      const items = [
        buildLineItem({ quantity: 2, unitPrice: 100, discountPercent: 0, taxRate: 0.21 }),
        buildLineItem({ quantity: 1, unitPrice: 50, discountPercent: 10, taxRate: 0 }),
      ];
      const totals = computeInvoiceTotals(items);
      expect(totals.subtotal).toBeCloseTo(250);
      expect(totals.itemCount).toBe(2);
      expect(totals.taxTotal).toBeGreaterThan(0);
    });

    test('sin items retorna ceros', () => {
      const totals = computeInvoiceTotals([]);
      expect(totals.subtotal).toBe(0);
      expect(totals.total).toBe(0);
      expect(totals.itemCount).toBe(0);
    });

    test('globalDiscountAmount se descuenta del total', () => {
      const items = [buildLineItem({ quantity: 1, unitPrice: 200 })];
      const totals = computeInvoiceTotals(items, { globalDiscountAmount: 50 });
      expect(totals.total).toBe(150);
      expect(totals.discountTotal).toBe(50);
    });

    test('total nunca negativo con globalDiscount mayor al total', () => {
      const items = [buildLineItem({ quantity: 1, unitPrice: 10 })];
      const totals = computeInvoiceTotals(items, { globalDiscountAmount: 1000 });
      expect(totals.total).toBe(0);
    });
  });

  // ─── buildInvoiceRecord ────────────────────────────────────────────────────

  describe('buildInvoiceRecord', () => {
    test('construye factura con campos requeridos', () => {
      const inv = buildInvoiceRecord(UID, {
        clientName: 'Carlos Garcia',
        lineItems: [{ quantity: 1, unitPrice: 500 }],
      });
      expect(inv.uid).toBe(UID);
      expect(inv.clientName).toBe('Carlos Garcia');
      expect(inv.status).toBe('draft');
      expect(inv.type).toBe('invoice');
      expect(inv.currency).toBe('ARS');
      expect(inv.lineItems.length).toBe(1);
      expect(inv.total).toBeGreaterThan(0);
      expect(inv.amountDue).toBe(inv.total);
      expect(inv.amountPaid).toBe(0);
    });

    test('status e type invalidos caen a defaults', () => {
      const inv = buildInvoiceRecord(UID, { status: 'zombie', type: 'invoice_x' });
      expect(inv.status).toBe('draft');
      expect(inv.type).toBe('invoice');
    });

    test('status valido se respeta', () => {
      const inv = buildInvoiceRecord(UID, { status: 'issued' });
      expect(inv.status).toBe('issued');
    });

    test('currency se normaliza a mayuscula 3 chars', () => {
      const inv = buildInvoiceRecord(UID, { currency: 'usd' });
      expect(inv.currency).toBe('USD');
    });

    test('limita lineItems a MAX_LINE_ITEMS', () => {
      const items = Array.from({ length: 60 }, (_, i) => ({ quantity: 1, unitPrice: i }));
      const inv = buildInvoiceRecord(UID, { lineItems: items });
      expect(inv.lineItems.length).toBe(MAX_LINE_ITEMS);
    });

    test('invoiceId generado si no se provee', () => {
      const inv = buildInvoiceRecord(UID, {});
      expect(typeof inv.invoiceId).toBe('string');
      expect(inv.invoiceId.length).toBeGreaterThan(5);
    });

    test('dueDate por defecto es 30 dias desde ahora', () => {
      const before = Date.now();
      const inv = buildInvoiceRecord(UID, {});
      const after = Date.now();
      const thirtyDaysMs = DUE_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
      expect(inv.dueDate).toBeGreaterThanOrEqual(before + thirtyDaysMs);
      expect(inv.dueDate).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });

    test('clientEmail null si no se provee', () => {
      const inv = buildInvoiceRecord(UID, {});
      expect(inv.clientEmail).toBeNull();
    });

    test('notes truncadas a 1000 chars', () => {
      const inv = buildInvoiceRecord(UID, { notes: 'n'.repeat(2000) });
      expect(inv.notes.length).toBe(1000);
    });
  });

  // ─── applyPayment ──────────────────────────────────────────────────────────

  describe('applyPayment', () => {
    test('pago parcial actualiza amountPaid y amountDue, status sigue igual', () => {
      const inv = buildInvoiceRecord(UID, { status: 'issued', lineItems: [{ quantity: 1, unitPrice: 1000 }] });
      const updated = applyPayment(inv, 400);
      expect(updated.amountPaid).toBeCloseTo(400);
      expect(updated.amountDue).toBeCloseTo(600);
      expect(updated.status).toBe('issued');
      expect(updated.paidAt).toBeNull();
    });

    test('pago completo cambia status a paid y setea paidAt', () => {
      const inv = buildInvoiceRecord(UID, { status: 'issued', lineItems: [{ quantity: 1, unitPrice: 500 }] });
      const updated = applyPayment(inv, 500);
      expect(updated.amountPaid).toBeCloseTo(500);
      expect(updated.amountDue).toBe(0);
      expect(updated.status).toBe('paid');
      expect(updated.paidAt).toBeGreaterThan(0);
    });

    test('pago mayor al total no excede total', () => {
      const inv = buildInvoiceRecord(UID, { lineItems: [{ quantity: 1, unitPrice: 100 }] });
      const updated = applyPayment(inv, 9999);
      expect(updated.amountPaid).toBeCloseTo(inv.total);
      expect(updated.amountDue).toBe(0);
    });

    test('lanza error si amountPaid no es numero', () => {
      const inv = buildInvoiceRecord(UID, {});
      expect(() => applyPayment(inv, 'cien')).toThrow();
    });

    test('lanza error si amountPaid es negativo', () => {
      const inv = buildInvoiceRecord(UID, {});
      expect(() => applyPayment(inv, -50)).toThrow();
    });

    test('pago acumulativo: dos pagos parciales', () => {
      const inv = buildInvoiceRecord(UID, { lineItems: [{ quantity: 1, unitPrice: 300 }] });
      const p1 = applyPayment(inv, 100);
      const p2 = applyPayment(p1, 200);
      expect(p2.amountPaid).toBeCloseTo(300);
      expect(p2.amountDue).toBe(0);
      expect(p2.status).toBe('paid');
    });
  });

  // ─── cancelInvoice ─────────────────────────────────────────────────────────

  describe('cancelInvoice', () => {
    test('cancela una factura en estado issued', () => {
      const inv = buildInvoiceRecord(UID, { status: 'issued' });
      const cancelled = cancelInvoice(inv);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancelledAt).toBeGreaterThan(0);
    });

    test('lanza error si ya está pagada', () => {
      const inv = { ...buildInvoiceRecord(UID, {}), status: 'paid' };
      expect(() => cancelInvoice(inv)).toThrow();
    });

    test('lanza error si ya está cancelada', () => {
      const inv = { ...buildInvoiceRecord(UID, {}), status: 'cancelled' };
      expect(() => cancelInvoice(inv)).toThrow();
    });
  });

  // ─── checkOverdue ──────────────────────────────────────────────────────────

  describe('checkOverdue', () => {
    test('retorna true si dueDate paso y hay saldo pendiente', () => {
      const inv = {
        ...buildInvoiceRecord(UID, {}),
        dueDate: Date.now() - 1000,
        amountDue: 100,
        status: 'issued',
      };
      expect(checkOverdue(inv)).toBe(true);
    });

    test('retorna false si status es paid', () => {
      const inv = { ...buildInvoiceRecord(UID, {}), dueDate: Date.now() - 1000, amountDue: 0, status: 'paid' };
      expect(checkOverdue(inv)).toBe(false);
    });

    test('retorna false si status es cancelled', () => {
      const inv = { ...buildInvoiceRecord(UID, {}), dueDate: Date.now() - 1000, amountDue: 100, status: 'cancelled' };
      expect(checkOverdue(inv)).toBe(false);
    });

    test('retorna false si dueDate es futuro', () => {
      const inv = { ...buildInvoiceRecord(UID, {}), dueDate: Date.now() + 99999, amountDue: 100, status: 'issued' };
      expect(checkOverdue(inv)).toBe(false);
    });
  });

  // ─── buildInvoiceText ─────────────────────────────────────────────────────

  describe('buildInvoiceText', () => {
    test('retorna texto con numero, cliente y total', () => {
      const inv = buildInvoiceRecord(UID, {
        clientName: 'Maria Lopez',
        lineItems: [{ description: 'Consulta', quantity: 1, unitPrice: 800 }],
        invoiceNumber: 'TEST-00001',
      });
      const text = buildInvoiceText(inv);
      expect(text).toContain('TEST-00001');
      expect(text).toContain('Maria Lopez');
      expect(text).toContain('800');
    });

    test('retorna mensaje si invoice es null', () => {
      expect(buildInvoiceText(null)).toBe('Factura no encontrada.');
    });

    test('incluye descuento e IVA si son mayores a 0', () => {
      const inv = buildInvoiceRecord(UID, {
        lineItems: [{ quantity: 1, unitPrice: 1000, discountPercent: 10, taxRate: 0.21 }],
      });
      const text = buildInvoiceText(inv);
      expect(text).toContain('Descuento');
      expect(text).toContain('IVA');
    });

    test('incluye saldo pendiente si amountDue > 0 y no cancelado', () => {
      const inv = { ...buildInvoiceRecord(UID, { lineItems: [{ quantity: 1, unitPrice: 500 }] }), amountDue: 300, status: 'issued' };
      const text = buildInvoiceText(inv);
      expect(text).toContain('Saldo pendiente');
    });
  });

  // ─── saveInvoice / getInvoice / updateInvoice / listInvoices ──────────────

  describe('Operaciones Firestore', () => {
    test('saveInvoice guarda y getInvoice recupera', async () => {
      const inv = buildInvoiceRecord(UID, { clientName: 'Cliente Test' });
      await saveInvoice(UID, inv);
      const retrieved = await getInvoice(UID, inv.invoiceId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.clientName).toBe('Cliente Test');
    });

    test('getInvoice retorna null si no existe', async () => {
      const result = await getInvoice(UID, 'no_existe_999');
      expect(result).toBeNull();
    });

    test('updateInvoice hace merge de campos', async () => {
      const inv = buildInvoiceRecord(UID, {});
      await saveInvoice(UID, inv);
      await updateInvoice(UID, inv.invoiceId, { status: 'sent', sentAt: Date.now() });
      const retrieved = await getInvoice(UID, inv.invoiceId);
      expect(retrieved.status).toBe('sent');
    });

    test('listInvoices retorna facturas guardadas', async () => {
      const inv1 = buildInvoiceRecord(UID, { status: 'draft', issueDate: 1000 });
      const inv2 = buildInvoiceRecord(UID, { status: 'issued', issueDate: 2000 });
      await saveInvoice(UID, inv1);
      await saveInvoice(UID, inv2);
      const all = await listInvoices(UID);
      expect(all.length).toBe(2);
    });

    test('listInvoices filtra por status', async () => {
      const inv1 = buildInvoiceRecord(UID, { status: 'draft' });
      const inv2 = buildInvoiceRecord(UID, { status: 'paid' });
      await saveInvoice(UID, inv1);
      await saveInvoice(UID, inv2);
      const paid = await listInvoices(UID, { status: 'paid' });
      expect(paid.every(i => i.status === 'paid')).toBe(true);
    });

    test('listInvoices filtra por clientPhone', async () => {
      const inv1 = buildInvoiceRecord(UID, { clientPhone: '+541155551234' });
      const inv2 = buildInvoiceRecord(UID, { clientPhone: '+541166669999' });
      await saveInvoice(UID, inv1);
      await saveInvoice(UID, inv2);
      const filtered = await listInvoices(UID, { clientPhone: '+541155551234' });
      expect(filtered.length).toBe(1);
      expect(filtered[0].clientPhone).toBe('+541155551234');
    });

    test('listInvoices retorna array vacio si no hay facturas', async () => {
      const result = await listInvoices('uid_sin_facturas');
      expect(result).toEqual([]);
    });

    test('listInvoices respeta limit', async () => {
      for (let i = 0; i < 5; i++) {
        const inv = buildInvoiceRecord(UID, {});
        await saveInvoice(UID, inv);
      }
      const limited = await listInvoices(UID, { limit: 3 });
      expect(limited.length).toBeLessThanOrEqual(3);
    });
  });
});
