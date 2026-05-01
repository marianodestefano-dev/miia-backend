'use strict';

const {
  buildLineItem, computeInvoiceTotals, buildInvoiceRecord,
  applyPayment, cancelInvoice, checkOverdue, buildInvoiceNumber,
  INVOICE_STATUSES, INVOICE_TYPES, LINE_ITEM_TYPES,
  MAX_LINE_ITEMS, DEFAULT_TAX_RATE, DUE_DAYS_DEFAULT,
} = require('../core/invoice_engine');

const {
  buildProductRecord, validateProductData,
  PRODUCT_STATUSES, CATALOG_CATEGORIES, CATALOG_CURRENCIES,
  MAX_PRODUCTS_PER_CATALOG, MAX_DESCRIPTION_LENGTH,
} = require('../core/catalog_manager');

const {
  isBusinessOpen, validateSchedule, addHoliday, addSpecialDay,
  DAYS_OF_WEEK, DAY_INDEX, DEFAULT_SCHEDULE,
} = require('../core/business_hours_v2');

const UID = 'uid_t358';

// Monday Jan 5 2026 10:00:00 UTC
const MON_10AM_UTC = new Date('2026-01-05T10:00:00Z').getTime();
// Saturday Jan 3 2026 10:00:00 UTC
const SAT_10AM_UTC = new Date('2026-01-03T10:00:00Z').getTime();
// Monday Jan 5 2026 08:00:00 UTC (before open)
const MON_8AM_UTC = new Date('2026-01-05T08:00:00Z').getTime();

const BASE_SCHEDULE = {
  ...DEFAULT_SCHEDULE,
  timezone: 'UTC',
  holidays: [],
  specialDays: [],
};

describe('T358 -- invoice_engine + catalog_manager + business_hours_v2 (32 tests)', () => {

  // ── INVOICE ENGINE ───────────────────────────────────────────────────────────

  test('INVOICE_STATUSES/TYPES/LINE_ITEM_TYPES frozen', () => {
    expect(() => { INVOICE_STATUSES.push('hack'); }).toThrow();
    expect(INVOICE_STATUSES).toContain('draft');
    expect(INVOICE_STATUSES).toContain('paid');
    expect(INVOICE_STATUSES).toContain('cancelled');
    expect(() => { INVOICE_TYPES.push('hack'); }).toThrow();
    expect(INVOICE_TYPES).toContain('invoice');
    expect(INVOICE_TYPES).toContain('quote');
    expect(() => { LINE_ITEM_TYPES.push('hack'); }).toThrow();
    expect(LINE_ITEM_TYPES).toContain('product');
    expect(LINE_ITEM_TYPES).toContain('service');
  });

  test('MAX_LINE_ITEMS=50, DEFAULT_TAX_RATE=0.21, DUE_DAYS_DEFAULT=30', () => {
    expect(MAX_LINE_ITEMS).toBe(50);
    expect(DEFAULT_TAX_RATE).toBe(0.21);
    expect(DUE_DAYS_DEFAULT).toBe(30);
  });

  test('buildLineItem: qty/price/subtotal/total calculados', () => {
    const li = buildLineItem({ description: 'Consulta', quantity: 2, unitPrice: 100 });
    expect(li.quantity).toBe(2);
    expect(li.unitPrice).toBe(100);
    expect(li.subtotal).toBe(200);
    expect(li.total).toBe(200); // sin descuento
  });

  test('buildLineItem: con descuento 10% sobre subtotal 200 -> total 180', () => {
    const li = buildLineItem({ quantity: 2, unitPrice: 100, discountPercent: 10 });
    expect(li.discountAmount).toBeCloseTo(20, 1);
    expect(li.total).toBeCloseTo(180, 1);
  });

  test('buildLineItem: defaults qty=1, type=service', () => {
    const li = buildLineItem({});
    expect(li.quantity).toBe(1);
    expect(li.type).toBe('service');
    expect(li.subtotal).toBe(0);
  });

  test('computeInvoiceTotals: empty -> zeros', () => {
    const t = computeInvoiceTotals([]);
    expect(t.subtotal).toBe(0);
    expect(t.total).toBe(0);
    expect(t.itemCount).toBe(0);
  });

  test('computeInvoiceTotals: items con taxRate -> taxTotal incluido', () => {
    const items = [
      buildLineItem({ quantity: 1, unitPrice: 100, taxRate: 0.21 }),
    ];
    const t = computeInvoiceTotals(items);
    expect(t.subtotal).toBe(100);
    expect(t.taxTotal).toBeCloseTo(21, 1);
    expect(t.total).toBeCloseTo(121, 1);
  });

  test('buildInvoiceRecord: defaults type=invoice, status=draft', () => {
    const inv = buildInvoiceRecord(UID, {});
    expect(inv.uid).toBe(UID);
    expect(inv.type).toBe('invoice');
    expect(inv.status).toBe('draft');
    expect(inv.invoiceId).toBeDefined();
    expect(inv.invoiceNumber).toBeDefined();
  });

  test('buildInvoiceRecord: con lineItems -> totales computados', () => {
    const inv = buildInvoiceRecord(UID, {
      lineItems: [
        { description: 'Servicio A', quantity: 2, unitPrice: 150 },
      ],
      clientName: 'Ana Lopez',
    });
    expect(inv.total).toBe(300);
    expect(inv.clientName).toBe('Ana Lopez');
    expect(inv.lineItems.length).toBe(1);
  });

  test('applyPayment: pago parcial -> amountDue reduce, pago total -> status=paid', () => {
    const inv = buildInvoiceRecord(UID, {
      lineItems: [{ quantity: 1, unitPrice: 500 }],
    });
    expect(inv.total).toBe(500);
    const partial = applyPayment(inv, 200);
    expect(partial.amountPaid).toBe(200);
    expect(partial.amountDue).toBe(300);
    expect(partial.status).toBe('draft'); // no pagado completo

    const paid = applyPayment(partial, 300);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);
  });

  test('cancelInvoice: paid lanza; draft OK', () => {
    const inv = buildInvoiceRecord(UID, {
      lineItems: [{ quantity: 1, unitPrice: 100 }],
    });
    const paidInv = applyPayment(inv, 100);
    expect(() => cancelInvoice(paidInv)).toThrow('No se puede cancelar una factura pagada');
    const cancelled = cancelInvoice(inv);
    expect(cancelled.status).toBe('cancelled');
  });

  test('checkOverdue: paid/cancelled=false; past dueDate + amountDue > 0 = true', () => {
    const paidInv = buildInvoiceRecord(UID, { lineItems: [{ quantity: 1, unitPrice: 100 }] });
    const paidFull = applyPayment(paidInv, 100);
    expect(checkOverdue(paidFull)).toBe(false);

    // Factura con dueDate en el pasado
    const overdueInv = buildInvoiceRecord(UID, {
      lineItems: [{ quantity: 1, unitPrice: 200 }],
      dueDate: Date.now() - 1000000,
    });
    expect(checkOverdue(overdueInv)).toBe(true);
  });

  // ── CATALOG MANAGER ──────────────────────────────────────────────────────────

  test('PRODUCT_STATUSES/CATALOG_CATEGORIES/CATALOG_CURRENCIES frozen', () => {
    expect(() => { PRODUCT_STATUSES.push('hack'); }).toThrow();
    expect(PRODUCT_STATUSES).toContain('available');
    expect(PRODUCT_STATUSES).toContain('out_of_stock');
    expect(() => { CATALOG_CATEGORIES.push('hack'); }).toThrow();
    expect(CATALOG_CATEGORIES).toContain('servicios');
    expect(CATALOG_CATEGORIES).toContain('productos_fisicos');
    expect(() => { CATALOG_CURRENCIES.push('hack'); }).toThrow();
    expect(CATALOG_CURRENCIES).toContain('ARS');
    expect(CATALOG_CURRENCIES).toContain('COP');
  });

  test('MAX_PRODUCTS_PER_CATALOG=500', () => {
    expect(MAX_PRODUCTS_PER_CATALOG).toBe(500);
  });

  test('buildProductRecord: defaults currency=ARS, status=available, category=otros', () => {
    const p = buildProductRecord(UID, { name: 'Test' });
    expect(p.uid).toBe(UID);
    expect(p.name).toBe('Test');
    expect(p.currency).toBe('ARS');
    expect(p.status).toBe('available');
    expect(p.category).toBe('otros');
    expect(p.price).toBe(0);
  });

  test('buildProductRecord: valores validos respetados', () => {
    const p = buildProductRecord(UID, {
      name: 'Consulta Premium',
      price: 299.99,
      currency: 'COP',
      category: 'servicios',
      status: 'available',
    });
    expect(p.price).toBe(299.99);
    expect(p.currency).toBe('COP');
    expect(p.category).toBe('servicios');
  });

  test('validateProductData: sin name -> error', () => {
    const r = validateProductData({});
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('name');
  });

  test('validateProductData: precio negativo -> error', () => {
    const r = validateProductData({ name: 'Test', price: -10 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('price'))).toBe(true);
  });

  test('validateProductData: currency invalida -> error', () => {
    const r = validateProductData({ name: 'Test', currency: 'XYZ' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('currency'))).toBe(true);
  });

  test('validateProductData: datos validos -> { valid: true, errors: [] }', () => {
    const r = validateProductData({ name: 'Servicio OK', price: 100, currency: 'USD' });
    expect(r.valid).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  // ── BUSINESS HOURS V2 ────────────────────────────────────────────────────────

  test('DAYS_OF_WEEK frozen con 7 dias en orden', () => {
    expect(() => { DAYS_OF_WEEK.push('hack'); }).toThrow();
    expect(DAYS_OF_WEEK.length).toBe(7);
    expect(DAYS_OF_WEEK[0]).toBe('sunday');
    expect(DAYS_OF_WEEK[1]).toBe('monday');
    expect(DAYS_OF_WEEK[6]).toBe('saturday');
  });

  test('DAY_INDEX frozen: sunday=0, monday=1, saturday=6', () => {
    expect(() => { DAY_INDEX.hack = 1; }).toThrow();
    expect(DAY_INDEX.sunday).toBe(0);
    expect(DAY_INDEX.monday).toBe(1);
    expect(DAY_INDEX.saturday).toBe(6);
  });

  test('validateSchedule: schedule valido -> []', () => {
    const errors = validateSchedule(BASE_SCHEDULE);
    expect(errors).toEqual([]);
  });

  test('validateSchedule: hora invalida -> error', () => {
    const bad = { monday: [{ open: '9:00', close: '18:00' }] };
    const errors = validateSchedule(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('monday');
  });

  test('validateSchedule: open >= close -> error', () => {
    const bad = { monday: [{ open: '18:00', close: '09:00' }] };
    const errors = validateSchedule(bad);
    expect(errors.some(e => e.includes('open debe ser antes'))).toBe(true);
  });

  test('addHoliday: fecha invalida lanza', () => {
    expect(() => addHoliday(BASE_SCHEDULE, '05/01/2026')).toThrow('fecha invalida');
  });

  test('addHoliday: fecha valida -> agregada a holidays sin duplicados', () => {
    const updated = addHoliday(BASE_SCHEDULE, '2026-01-05');
    expect(updated.holidays).toContain('2026-01-05');
    // No duplicados
    const again = addHoliday(updated, '2026-01-05');
    expect(again.holidays.filter(d => d === '2026-01-05').length).toBe(1);
  });

  test('addSpecialDay: fecha invalida lanza; slots no-array lanza', () => {
    expect(() => addSpecialDay(BASE_SCHEDULE, 'bad-date', [])).toThrow('fecha invalida');
    expect(() => addSpecialDay(BASE_SCHEDULE, '2026-01-05', 'not-array')).toThrow('slots debe ser array');
  });

  test('isBusinessOpen: lunes 10am UTC -> isOpen=true', () => {
    const result = isBusinessOpen(BASE_SCHEDULE, MON_10AM_UTC);
    expect(result.isOpen).toBe(true);
    expect(result.reason).toBe('open');
  });

  test('isBusinessOpen: sabado 10am UTC -> isOpen=false, reason=closed_day', () => {
    const result = isBusinessOpen(BASE_SCHEDULE, SAT_10AM_UTC);
    expect(result.isOpen).toBe(false);
    expect(result.reason).toBe('closed_day');
  });

  test('isBusinessOpen: lunes = feriado -> isOpen=false, reason=holiday', () => {
    const withHoliday = addHoliday(BASE_SCHEDULE, '2026-01-05');
    const result = isBusinessOpen(withHoliday, MON_10AM_UTC);
    expect(result.isOpen).toBe(false);
    expect(result.reason).toBe('holiday');
  });

  test('isBusinessOpen: lunes 8am UTC (antes de apertura) -> isOpen=false, reason=outside_hours', () => {
    const result = isBusinessOpen(BASE_SCHEDULE, MON_8AM_UTC);
    expect(result.isOpen).toBe(false);
    expect(result.reason).toBe('outside_hours');
  });
});
