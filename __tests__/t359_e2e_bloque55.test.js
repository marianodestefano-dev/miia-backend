'use strict';

/**
 * T359 -- E2E Bloque 55
 * Pipeline: invoice_engine -> catalog_manager -> business_hours_v2
 */

const {
  buildLineItem, computeInvoiceTotals, buildInvoiceRecord,
  applyPayment, cancelInvoice,
} = require('../core/invoice_engine');

const {
  buildProductRecord, validateProductData,
  CATALOG_CATEGORIES,
} = require('../core/catalog_manager');

const {
  isBusinessOpen, validateSchedule, addHoliday, addSpecialDay,
  DEFAULT_SCHEDULE,
} = require('../core/business_hours_v2');

const UID = 'owner_bloque55_001';

const MON_10AM_UTC = new Date('2026-01-05T10:00:00Z').getTime();
const SAT_10AM_UTC = new Date('2026-01-03T10:00:00Z').getTime();

const BASE_SCHEDULE = {
  ...DEFAULT_SCHEDULE,
  timezone: 'UTC',
  holidays: [],
  specialDays: [],
};

describe('T359 -- E2E Bloque 55: invoice_engine + catalog_manager + business_hours_v2', () => {

  test('Paso 1 -- crear producto en catalogo', () => {
    const p = buildProductRecord(UID, {
      name: 'Consulta Online',
      price: 75,
      currency: 'USD',
      category: 'servicios',
    });
    expect(p.name).toBe('Consulta Online');
    expect(p.price).toBe(75);
    expect(p.status).toBe('available');
  });

  test('Paso 2 -- validar datos del producto', () => {
    const r = validateProductData({ name: 'Plan Premium', price: 199, currency: 'COP' });
    expect(r.valid).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  test('Paso 3 -- crear factura con items del catalogo', () => {
    const inv = buildInvoiceRecord(UID, {
      clientName: 'Juan Perez',
      lineItems: [
        { description: 'Consulta Online', quantity: 1, unitPrice: 75 },
        { description: 'Seguimiento', quantity: 2, unitPrice: 30 },
      ],
    });
    expect(inv.total).toBe(135); // 75 + 60
    expect(inv.lineItems.length).toBe(2);
    expect(inv.status).toBe('draft');
  });

  test('Paso 4 -- aplicar pago a la factura', () => {
    const inv = buildInvoiceRecord(UID, {
      lineItems: [{ quantity: 1, unitPrice: 200 }],
    });
    const paid = applyPayment(inv, 200);
    expect(paid.status).toBe('paid');
    expect(paid.amountDue).toBe(0);
  });

  test('Paso 5 -- verificar horario de atencion lunes', () => {
    const r = isBusinessOpen(BASE_SCHEDULE, MON_10AM_UTC);
    expect(r.isOpen).toBe(true);
  });

  test('Paso 6 -- agregar dia especial y verificar', () => {
    const withSpecial = addSpecialDay(BASE_SCHEDULE, '2026-01-05', [
      { open: '10:00', close: '12:00' },
    ]);
    // Lunes 10:00 UTC en dia especial (slot 10:00-12:00) -> deberia abrir
    const r = isBusinessOpen(withSpecial, MON_10AM_UTC);
    expect(r.isOpen).toBe(true);
    expect(r.reason).toBe('special_open');
  });

  test('Pipeline completo -- catalogo + factura + horario', () => {
    // A: Validar producto antes de publicar
    const validation = validateProductData({ name: 'Pack Anual', price: 999, currency: 'USD' });
    expect(validation.valid).toBe(true);

    // B: Producto publicado
    const prod = buildProductRecord(UID, { name: 'Pack Anual', price: 999, currency: 'USD' });
    expect(prod.status).toBe('available');

    // C: Crear factura por el producto
    const inv = buildInvoiceRecord(UID, {
      lineItems: [{ description: prod.name, quantity: 1, unitPrice: prod.price }],
      clientName: 'Maria Garcia',
    });
    expect(inv.total).toBe(999);

    // D: Verificar horario antes de atender
    const r = isBusinessOpen(BASE_SCHEDULE, MON_10AM_UTC);
    expect(r.isOpen).toBe(true);

    // E: Sabado cerrado -> no atender
    const sat = isBusinessOpen(BASE_SCHEDULE, SAT_10AM_UTC);
    expect(sat.isOpen).toBe(false);
    expect(sat.nextOpen).toBeDefined();

    // F: Pagar factura si atienden
    const paid = applyPayment(inv, 999);
    expect(paid.status).toBe('paid');

    // G: Factura cancelada no se puede cancelar de nuevo
    const draft = buildInvoiceRecord(UID, {});
    const cancelled = cancelInvoice(draft);
    expect(cancelled.status).toBe('cancelled');
    expect(() => cancelInvoice(cancelled)).toThrow('ya esta cancelada');
  });
});
