'use strict';

const {
  buildCouponRecord, saveCoupon, getCoupon,
  validateCoupon, redeemCoupon, listActiveCoupons,
  disableCoupon, computeDiscount, buildCouponText,
  isValidType, isValidStatus, isValidCouponCode,
  COUPON_TYPES, COUPON_STATUSES, COUPON_CURRENCIES,
  MAX_COUPON_CODE_LENGTH, MIN_DISCOUNT_VALUE,
  MAX_DISCOUNT_PERCENTAGE, MAX_USES_DEFAULT,
  __setFirestoreForTests,
} = require('../core/coupon_engine');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ stored = {}, usageStored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  const usage_stored = { ...usageStored };
  return {
    collection: () => ({
      doc: () => ({
        collection: (col) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const target = col === 'coupon_usages' ? usage_stored : db_stored;
              target[id] = opts && opts.merge ? { ...(target[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('COUPON_TYPES tiene 4', () => { expect(COUPON_TYPES.length).toBe(4); });
  test('frozen COUPON_TYPES', () => { expect(() => { COUPON_TYPES.push('x'); }).toThrow(); });
  test('COUPON_STATUSES tiene 4', () => { expect(COUPON_STATUSES.length).toBe(4); });
  test('frozen COUPON_STATUSES', () => { expect(() => { COUPON_STATUSES.push('x'); }).toThrow(); });
  test('COUPON_CURRENCIES tiene 7', () => { expect(COUPON_CURRENCIES.length).toBe(7); });
  test('frozen COUPON_CURRENCIES', () => { expect(() => { COUPON_CURRENCIES.push('x'); }).toThrow(); });
  test('MAX_USES_DEFAULT es 100', () => { expect(MAX_USES_DEFAULT).toBe(100); });
  test('MAX_DISCOUNT_PERCENTAGE es 100', () => { expect(MAX_DISCOUNT_PERCENTAGE).toBe(100); });
});

describe('isValidCouponCode', () => {
  test('codigo valido uppercase', () => { expect(isValidCouponCode('PROMO20')).toBe(true); });
  test('codigo con guion valido', () => { expect(isValidCouponCode('PROMO-20')).toBe(true); });
  test('codigo con underscore valido', () => { expect(isValidCouponCode('PROMO_20')).toBe(true); });
  test('codigo lowercase invalido', () => { expect(isValidCouponCode('promo20')).toBe(false); });
  test('codigo muy largo invalido', () => { expect(isValidCouponCode('A'.repeat(21))).toBe(false); });
  test('codigo muy corto invalido', () => { expect(isValidCouponCode('A')).toBe(false); });
  test('null invalido', () => { expect(isValidCouponCode(null)).toBe(false); });
  test('con espacios invalido', () => { expect(isValidCouponCode('PROMO 20')).toBe(false); });
});

describe('buildCouponRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildCouponRecord(undefined, 'PROMO20', 'percentage', 20)).toThrow('uid requerido');
  });
  test('lanza si codigo invalido', () => {
    expect(() => buildCouponRecord(UID, 'promo lower', 'percentage', 20)).toThrow('codigo invalido');
  });
  test('lanza si type invalido', () => {
    expect(() => buildCouponRecord(UID, 'PROMO20', 'bad_type', 20)).toThrow('type invalido');
  });
  test('lanza si value no es numero', () => {
    expect(() => buildCouponRecord(UID, 'PROMO20', 'percentage', 'veinte')).toThrow('value debe ser numero');
  });
  test('lanza si percentage > 100', () => {
    expect(() => buildCouponRecord(UID, 'PROMO20', 'percentage', 101)).toThrow('porcentaje no puede superar 100');
  });
  test('construye record percentage correctamente', () => {
    const r = buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { description: 'Descuento mayo' });
    expect(r.code).toBe('PROMO20');
    expect(r.type).toBe('percentage');
    expect(r.value).toBe(20);
    expect(r.status).toBe('active');
    expect(r.usedCount).toBe(0);
    expect(r.description).toBe('Descuento mayo');
  });
  test('construye record fixed correctamente', () => {
    const r = buildCouponRecord(UID, 'DESCUENTO10', 'fixed', 10, { currency: 'ARS', minOrderAmount: 50 });
    expect(r.type).toBe('fixed');
    expect(r.currency).toBe('ARS');
    expect(r.minOrderAmount).toBe(50);
  });
  test('currency invalida cae a USD', () => {
    const r = buildCouponRecord(UID, 'PROMO1', 'percentage', 10, { currency: 'EUR' });
    expect(r.currency).toBe('USD');
  });
  test('maxUses custom', () => {
    const r = buildCouponRecord(UID, 'PROMO1', 'percentage', 10, { maxUses: 5 });
    expect(r.maxUses).toBe(5);
  });
  test('maxUses default si no se provee', () => {
    const r = buildCouponRecord(UID, 'PROMO1', 'percentage', 10);
    expect(r.maxUses).toBe(MAX_USES_DEFAULT);
  });
});

describe('computeDiscount', () => {
  test('null coupon retorna 0', () => { expect(computeDiscount(null, 100)).toBe(0); });
  test('orderAmount 0 retorna 0', () => {
    const c = buildCouponRecord(UID, 'P20', 'percentage', 20);
    expect(computeDiscount(c, 0)).toBe(0);
  });
  test('percentage calcula correctamente', () => {
    const c = buildCouponRecord(UID, 'P20', 'percentage', 20);
    expect(computeDiscount(c, 100)).toBe(20);
  });
  test('percentage redondea a 2 decimales', () => {
    const c = buildCouponRecord(UID, 'P15', 'percentage', 15);
    expect(computeDiscount(c, 33.33)).toBe(5);
  });
  test('fixed calcula correctamente', () => {
    const c = buildCouponRecord(UID, 'F10', 'fixed', 10);
    expect(computeDiscount(c, 50)).toBe(10);
  });
  test('fixed no excede orderAmount', () => {
    const c = buildCouponRecord(UID, 'F50', 'fixed', 50);
    expect(computeDiscount(c, 30)).toBe(30);
  });
  test('minOrderAmount no aplica si orden es menor', () => {
    const c = buildCouponRecord(UID, 'P10', 'percentage', 10, { minOrderAmount: 100 });
    expect(computeDiscount(c, 50)).toBe(0);
  });
  test('free_item retorna valor del item', () => {
    const c = buildCouponRecord(UID, 'FREE1', 'free_item', 25);
    expect(computeDiscount(c, 100)).toBe(25);
  });
});

describe('saveCoupon / getCoupon', () => {
  test('saveCoupon lanza si uid undefined', async () => {
    await expect(saveCoupon(undefined, { couponId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('saveCoupon lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveCoupon(UID, null)).rejects.toThrow('record invalido');
  });
  test('saveCoupon guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = buildCouponRecord(UID, 'PROMO20', 'percentage', 20);
    const id = await saveCoupon(UID, r);
    expect(id).toBe(r.couponId);
  });
  test('getCoupon lanza si uid undefined', async () => {
    await expect(getCoupon(undefined, 'PROMO20')).rejects.toThrow('uid requerido');
  });
  test('getCoupon retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getCoupon(UID, 'PROMO20')).toBeNull();
  });
  test('getCoupon retorna coupon existente', async () => {
    const r = buildCouponRecord(UID, 'PROMO20', 'percentage', 20);
    __setFirestoreForTests(makeMockDb({ stored: { [r.couponId]: r } }));
    const loaded = await getCoupon(UID, 'PROMO20');
    expect(loaded.code).toBe('PROMO20');
    expect(loaded.value).toBe(20);
  });
  test('getCoupon fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getCoupon(UID, 'PROMO20')).toBeNull();
  });
});

describe('validateCoupon', () => {
  test('lanza si uid undefined', async () => {
    await expect(validateCoupon(undefined, 'PROMO20', 100)).rejects.toThrow('uid requerido');
  });
  test('retorna invalid si coupon no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await validateCoupon(UID, 'NOEXISTE', 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('coupon_not_found');
  });
  test('retorna valid con descuento correcto', async () => {
    const coupon = buildCouponRecord(UID, 'PROMO20', 'percentage', 20);
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon } }));
    const r = await validateCoupon(UID, 'PROMO20', 100);
    expect(r.valid).toBe(true);
    expect(r.discount).toBe(20);
  });
  test('retorna invalid si status no es active', async () => {
    const coupon = { ...buildCouponRecord(UID, 'PROMO20', 'percentage', 20), status: 'disabled' };
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon } }));
    const r = await validateCoupon(UID, 'PROMO20', 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('coupon_disabled');
  });
  test('retorna invalid si expiresAt en el pasado', async () => {
    const coupon = { ...buildCouponRecord(UID, 'PROMO20', 'percentage', 20), expiresAt: 1000 };
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon } }));
    const r = await validateCoupon(UID, 'PROMO20', 100, Date.now());
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('coupon_expired');
  });
  test('retorna invalid si usedCount >= maxUses', async () => {
    const coupon = { ...buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { maxUses: 5 }), usedCount: 5 };
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon } }));
    const r = await validateCoupon(UID, 'PROMO20', 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('coupon_depleted');
  });
  test('retorna invalid si orden menor al minimo', async () => {
    const coupon = buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { minOrderAmount: 200 });
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon } }));
    const r = await validateCoupon(UID, 'PROMO20', 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('order_below_minimum');
  });
});

describe('redeemCoupon', () => {
  test('lanza si uid undefined', async () => {
    await expect(redeemCoupon(undefined, 'PROMO20', PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si coupon no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(redeemCoupon(UID, 'NOEXISTE', PHONE)).rejects.toThrow('coupon no encontrado');
  });
  test('canjea y actualiza usedCount', async () => {
    const coupon = buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { maxUses: 3 });
    const db = makeMockDb({ stored: { [coupon.couponId]: coupon } });
    __setFirestoreForTests(db);
    const result = await redeemCoupon(UID, 'PROMO20', PHONE);
    expect(result.newCount).toBe(1);
    expect(result.newStatus).toBe('active');
  });
  test('status pasa a depleted al llegar al max', async () => {
    const coupon = { ...buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { maxUses: 1 }), usedCount: 0 };
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon } }));
    const result = await redeemCoupon(UID, 'PROMO20', PHONE);
    expect(result.newStatus).toBe('depleted');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const coupon = buildCouponRecord(UID, 'PROMO20', 'percentage', 20);
    // throwGet prevents finding coupon first
    __setFirestoreForTests(makeMockDb({ stored: { [coupon.couponId]: coupon }, throwSet: true }));
    await expect(redeemCoupon(UID, 'PROMO20', PHONE)).rejects.toThrow('set error');
  });
});

describe('listActiveCoupons', () => {
  test('lanza si uid undefined', async () => {
    await expect(listActiveCoupons(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay activos', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await listActiveCoupons(UID)).toEqual([]);
  });
  test('retorna solo activos', async () => {
    const c1 = buildCouponRecord(UID, 'PROMO1', 'percentage', 10);
    const c2 = { ...buildCouponRecord(UID, 'PROMO2', 'fixed', 5), status: 'disabled' };
    __setFirestoreForTests(makeMockDb({ stored: { [c1.couponId]: c1, [c2.couponId]: c2 } }));
    const activos = await listActiveCoupons(UID);
    expect(activos.length).toBe(1);
    expect(activos[0].code).toBe('PROMO1');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await listActiveCoupons(UID)).toEqual([]);
  });
});

describe('disableCoupon', () => {
  test('lanza si uid undefined', async () => {
    await expect(disableCoupon(undefined, 'PROMO20')).rejects.toThrow('uid requerido');
  });
  test('lanza si code undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(disableCoupon(UID, undefined)).rejects.toThrow('code requerido');
  });
  test('desactiva sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const id = await disableCoupon(UID, 'PROMO20');
    expect(id).toContain('PROMO20');
  });
});

describe('buildCouponText', () => {
  test('retorna vacio si null', () => { expect(buildCouponText(null)).toBe(''); });
  test('incluye codigo', () => {
    const c = buildCouponRecord(UID, 'PROMO20', 'percentage', 20);
    const text = buildCouponText(c);
    expect(text).toContain('PROMO20');
  });
  test('incluye tipo y valor para percentage', () => {
    const c = buildCouponRecord(UID, 'PROMO20', 'percentage', 20);
    const text = buildCouponText(c);
    expect(text).toContain('20%');
  });
  test('incluye valor para fixed', () => {
    const c = buildCouponRecord(UID, 'DESC10', 'fixed', 10, { currency: 'ARS' });
    const text = buildCouponText(c);
    expect(text).toContain('10');
    expect(text).toContain('ARS');
  });
  test('incluye fecha de vencimiento si hay', () => {
    const c = buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { expiresAt: new Date('2026-12-31').getTime() });
    const text = buildCouponText(c);
    expect(text).toContain('Vence');
    expect(text).toContain('2026-12-31');
  });
  test('incluye usos', () => {
    const c = buildCouponRecord(UID, 'PROMO20', 'percentage', 20, { maxUses: 50 });
    const text = buildCouponText(c);
    expect(text).toContain('0/50');
  });
});
