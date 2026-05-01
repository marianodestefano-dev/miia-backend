'use strict';

const {
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
  MAX_DISCOUNT_PERCENT,
  MAX_USES_DEFAULT,
  EXPIRY_DAYS_DEFAULT,
  __setFirestoreForTests,
} = require('../core/coupon_engine');

function makeMockDb() {
  const stored = {};
  return {
    stored,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!stored[uid]) stored[uid] = {};
                if (!stored[uid][subCol]) stored[uid][subCol] = {};
                stored[uid][subCol][id] = { ...data };
              },
              get: async () => {
                const rec = stored[uid] && stored[uid][subCol] && stored[uid][subCol][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.get = async () => {
                const all = Object.values((stored[uid] || {})[subCol] || {});
                const filtered = all.filter(r => r[field] === val);
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              };
              return chain;
            },
            get: async () => {
              const all = Object.values((stored[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'usr_coupon_test_001';

describe('T287 — coupon_engine', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // ─── Constantes ───────────────────────────────────────────────────────────

  describe('Constantes exportadas', () => {
    test('COUPON_TYPES es frozen', () => {
      expect(Object.isFrozen(COUPON_TYPES)).toBe(true);
      expect(COUPON_TYPES).toContain('percent');
      expect(COUPON_TYPES).toContain('fixed');
      expect(COUPON_TYPES).toContain('free_shipping');
      expect(COUPON_TYPES).toContain('bogo');
    });

    test('COUPON_STATUSES es frozen', () => {
      expect(Object.isFrozen(COUPON_STATUSES)).toBe(true);
      expect(COUPON_STATUSES).toContain('active');
      expect(COUPON_STATUSES).toContain('expired');
      expect(COUPON_STATUSES).toContain('exhausted');
    });

    test('MAX_DISCOUNT_PERCENT=100, MAX_USES_DEFAULT=1000, EXPIRY_DAYS_DEFAULT=30', () => {
      expect(MAX_DISCOUNT_PERCENT).toBe(100);
      expect(MAX_USES_DEFAULT).toBe(1000);
      expect(EXPIRY_DAYS_DEFAULT).toBe(30);
    });
  });

  // ─── generateCouponCode ───────────────────────────────────────────────────

  describe('generateCouponCode', () => {
    test('genera codigo de 8 caracteres por default', () => {
      const code = generateCouponCode();
      expect(code.length).toBe(8);
    });

    test('genera codigo del largo solicitado', () => {
      expect(generateCouponCode(6).length).toBe(6);
      expect(generateCouponCode(12).length).toBe(12);
    });

    test('clampea a MIN_CODE_LENGTH y MAX_CODE_LENGTH', () => {
      expect(generateCouponCode(1).length).toBe(4); // minimo 4
      expect(generateCouponCode(20).length).toBe(12); // maximo 12
    });

    test('no contiene caracteres confundibles (0, O, I, 1)', () => {
      const code = generateCouponCode(12, 42);
      expect(code).not.toMatch(/[0OI1]/);
    });
  });

  // ─── buildCouponRecord ────────────────────────────────────────────────────

  describe('buildCouponRecord', () => {
    test('construye cupon percent con defaults', () => {
      const c = buildCouponRecord(UID, {
        code: 'PROMO20',
        type: 'percent',
        discountPercent: 20,
        name: 'Promo verano 20%',
      });

      expect(c.uid).toBe(UID);
      expect(c.code).toBe('PROMO20');
      expect(c.type).toBe('percent');
      expect(c.discountPercent).toBe(20);
      expect(c.status).toBe('active');
      expect(c.currentUses).toBe(0);
      expect(c.maxUses).toBe(MAX_USES_DEFAULT);
    });

    test('type invalido cae a percent', () => {
      const c = buildCouponRecord(UID, { type: 'super_mega' });
      expect(c.type).toBe('percent');
    });

    test('discountPercent se clampea a 0-100', () => {
      const c1 = buildCouponRecord(UID, { type: 'percent', discountPercent: 150 });
      expect(c1.discountPercent).toBe(100);
      const c2 = buildCouponRecord(UID, { type: 'percent', discountPercent: -10 });
      expect(c2.discountPercent).toBe(0);
    });

    test('tipo fixed guarda discountAmount, discountPercent es 0', () => {
      const c = buildCouponRecord(UID, { type: 'fixed', discountAmount: 500 });
      expect(c.discountAmount).toBe(500);
      expect(c.discountPercent).toBe(0);
    });

    test('code se genera si no se provee', () => {
      const c = buildCouponRecord(UID, { type: 'percent' });
      expect(typeof c.code).toBe('string');
      expect(c.code.length).toBeGreaterThanOrEqual(4);
    });

    test('code personalizado se normaliza a mayusculas', () => {
      const c = buildCouponRecord(UID, { code: 'verano2026' });
      expect(c.code).toBe('VERANO2026');
    });

    test('scheduledAt futuro genera status scheduled', () => {
      const futureTs = Date.now() + 3600000;
      const c = buildCouponRecord(UID, { scheduledAt: futureTs });
      expect(c.status).toBe('scheduled');
    });

    test('minOrderAmount se guarda correctamente', () => {
      const c = buildCouponRecord(UID, { minOrderAmount: 2000 });
      expect(c.minOrderAmount).toBe(2000);
    });

    test('expiresAt es 30 dias por defecto', () => {
      const before = Date.now();
      const c = buildCouponRecord(UID, {});
      const after = Date.now();
      const thirtyDaysMs = EXPIRY_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
      expect(c.expiresAt).toBeGreaterThanOrEqual(before + thirtyDaysMs);
      expect(c.expiresAt).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
    });
  });

  // ─── validateCoupon ───────────────────────────────────────────────────────

  describe('validateCoupon', () => {
    test('cupon valido sin restricciones', () => {
      const c = buildCouponRecord(UID, { type: 'percent', discountPercent: 15 });
      const result = validateCoupon(c, 1000);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test('cupon null retorna coupon_not_found', () => {
      const result = validateCoupon(null, 1000);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('coupon_not_found');
    });

    test('cupon expirado', () => {
      const c = { ...buildCouponRecord(UID, {}), expiresAt: Date.now() - 1000 };
      const result = validateCoupon(c, 1000);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('coupon_expired');
    });

    test('cupon inactivo', () => {
      const c = { ...buildCouponRecord(UID, {}), status: 'inactive' };
      const result = validateCoupon(c, 1000);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('coupon_inactive');
    });

    test('cupon agotado', () => {
      const c = { ...buildCouponRecord(UID, { maxUses: 10 }), currentUses: 10, status: 'exhausted' };
      const result = validateCoupon(c, 1000);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('coupon_exhausted');
    });

    test('pedido por debajo del minimo', () => {
      const c = buildCouponRecord(UID, { minOrderAmount: 3000 });
      const result = validateCoupon(c, 1000);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('order_below_minimum');
    });

    test('limite de usos por contacto alcanzado', () => {
      const c = buildCouponRecord(UID, { usesPerContact: 1 });
      const result = validateCoupon(c, 1000, { contactUses: 1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('contact_use_limit_reached');
    });
  });

  // ─── computeDiscount ──────────────────────────────────────────────────────

  describe('computeDiscount', () => {
    test('percent: 20% sobre 1000 = 200', () => {
      const c = buildCouponRecord(UID, { type: 'percent', discountPercent: 20 });
      expect(computeDiscount(c, 1000)).toBe(200);
    });

    test('percent con maxDiscountAmount clampea el descuento', () => {
      const c = buildCouponRecord(UID, { type: 'percent', discountPercent: 50, maxDiscountAmount: 300 });
      expect(computeDiscount(c, 1000)).toBe(300); // 500 clampea a 300
    });

    test('fixed: 500 sobre 2000 = 500', () => {
      const c = buildCouponRecord(UID, { type: 'fixed', discountAmount: 500 });
      expect(computeDiscount(c, 2000)).toBe(500);
    });

    test('fixed no puede superar el monto del pedido', () => {
      const c = buildCouponRecord(UID, { type: 'fixed', discountAmount: 1000 });
      expect(computeDiscount(c, 500)).toBe(500); // no puede ser mas que el pedido
    });

    test('coupon null retorna 0', () => {
      expect(computeDiscount(null, 1000)).toBe(0);
    });

    test('orderAmount 0 o negativo retorna 0', () => {
      const c = buildCouponRecord(UID, { type: 'percent', discountPercent: 20 });
      expect(computeDiscount(c, 0)).toBe(0);
    });
  });

  // ─── applyRedemption ──────────────────────────────────────────────────────

  describe('applyRedemption', () => {
    test('incrementa currentUses', () => {
      const c = buildCouponRecord(UID, { maxUses: 10 });
      const updated = applyRedemption(c);
      expect(updated.currentUses).toBe(1);
      expect(updated.status).toBe('active');
    });

    test('ultimo uso cambia status a exhausted', () => {
      const c = { ...buildCouponRecord(UID, { maxUses: 2 }), currentUses: 1 };
      const updated = applyRedemption(c);
      expect(updated.currentUses).toBe(2);
      expect(updated.status).toBe('exhausted');
    });

    test('dos redenciones consecutivas', () => {
      let c = buildCouponRecord(UID, { maxUses: 5 });
      c = applyRedemption(c);
      c = applyRedemption(c);
      expect(c.currentUses).toBe(2);
    });
  });

  // ─── buildRedemptionRecord ────────────────────────────────────────────────

  describe('buildRedemptionRecord', () => {
    test('construye registro de redencion correctamente', () => {
      const coupon = buildCouponRecord(UID, { type: 'percent', discountPercent: 20 });
      const discount = computeDiscount(coupon, 5000);
      const red = buildRedemptionRecord(UID, coupon.couponId, {
        contactPhone: '+541155551234',
        orderId: 'order_abc',
        orderAmount: 5000,
        discountApplied: discount,
        finalAmount: 5000 - discount,
      });

      expect(red.uid).toBe(UID);
      expect(red.couponId).toBe(coupon.couponId);
      expect(red.contactPhone).toBe('+541155551234');
      expect(red.discountApplied).toBe(1000); // 20% de 5000
      expect(red.finalAmount).toBe(4000);
      expect(red.status).toBe('applied');
    });

    test('redemptionId es unico', () => {
      const coupon = buildCouponRecord(UID, {});
      const r1 = buildRedemptionRecord(UID, coupon.couponId, {});
      const r2 = buildRedemptionRecord(UID, coupon.couponId, {});
      expect(r1.redemptionId).not.toBe(r2.redemptionId);
    });
  });

  // ─── buildCouponSummaryText ───────────────────────────────────────────────

  describe('buildCouponSummaryText', () => {
    test('genera texto para cupon percent activo', () => {
      const c = buildCouponRecord(UID, {
        code: 'VERANO30',
        type: 'percent',
        discountPercent: 30,
        name: 'Promo Verano',
        minOrderAmount: 1000,
      });
      const text = buildCouponSummaryText(c);
      expect(text).toContain('VERANO30');
      expect(text).toContain('Promo Verano');
      expect(text).toContain('30%');
      expect(text).toContain('active');
      expect(text).toContain('1000');
    });

    test('genera texto para cupon fixed', () => {
      const c = buildCouponRecord(UID, { code: 'DESC500', type: 'fixed', discountAmount: 500 });
      const text = buildCouponSummaryText(c);
      expect(text).toContain('500');
      expect(text).toContain('fixed');
    });

    test('retorna mensaje si cupon es null', () => {
      expect(buildCouponSummaryText(null)).toBe('Cupon no encontrado.');
    });
  });

  // ─── Firestore CRUD ───────────────────────────────────────────────────────

  describe('Operaciones Firestore', () => {
    test('saveCoupon + getCoupon funciona', async () => {
      const c = buildCouponRecord(UID, { code: 'TEST001', type: 'percent', discountPercent: 10 });
      await saveCoupon(UID, c);
      const retrieved = await getCoupon(UID, c.couponId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.code).toBe('TEST001');
    });

    test('getCouponByCode busca por codigo directamente', async () => {
      const c = buildCouponRecord(UID, { code: 'DIRECTO', type: 'fixed', discountAmount: 200 });
      await saveCoupon(UID, c);
      const retrieved = await getCouponByCode(UID, 'DIRECTO');
      expect(retrieved).not.toBeNull();
      expect(retrieved.discountAmount).toBe(200);
    });

    test('getCoupon retorna null si no existe', async () => {
      const result = await getCoupon(UID, 'coup_inexistente');
      expect(result).toBeNull();
    });

    test('updateCoupon hace merge', async () => {
      const c = buildCouponRecord(UID, {});
      await saveCoupon(UID, c);
      await updateCoupon(UID, c.couponId, { status: 'inactive', currentUses: 5 });
      const retrieved = await getCoupon(UID, c.couponId);
      expect(retrieved.status).toBe('inactive');
      expect(retrieved.currentUses).toBe(5);
    });

    test('saveRedemption guarda la redencion', async () => {
      const c = buildCouponRecord(UID, { code: 'RED001' });
      const red = buildRedemptionRecord(UID, c.couponId, { orderAmount: 1000 });
      await saveRedemption(UID, red);
      // Verificar que fue guardado en el store
      expect(mock.stored[UID]).toBeDefined();
    });

    test('listActiveCoupons retorna cupones activos', async () => {
      const c1 = buildCouponRecord(UID, { code: 'ACT001', status: 'active' });
      const c2 = buildCouponRecord(UID, { code: 'INA001', status: 'active' });
      await saveCoupon(UID, c1);
      await saveCoupon(UID, c2);
      const actives = await listActiveCoupons(UID);
      expect(actives.every(c => c.status === 'active')).toBe(true);
    });

    test('listActiveCoupons retorna vacio si no hay activos', async () => {
      const result = await listActiveCoupons('uid_sin_cupones');
      expect(result).toEqual([]);
    });
  });
});
