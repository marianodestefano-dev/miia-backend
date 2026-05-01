'use strict';

// T273: subscription_engine
const {
  buildSubscriptionRecord, computeSubscriptionPrice, computeNextBillingDate,
  pauseSubscription, resumeSubscription, cancelSubscription, recordBilling,
  isInGracePeriod, buildSubscriptionSummaryText,
  saveSubscription, getSubscription, updateSubscription,
  listSubscriptions, listDueBillings,
  SUBSCRIPTION_STATUSES, BILLING_CYCLES, SUBSCRIPTION_TYPES,
  CYCLE_DAYS, GRACE_PERIOD_DAYS,
  __setFirestoreForTests,
} = require('../core/subscription_engine');

const UID = 'testSubUid';
const PHONE = '+5491155550001';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
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
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { empty: Object.keys(db_stored).length === 0, forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
describe('constants', () => {
  test('SUBSCRIPTION_STATUSES frozen 6 valores', () => {
    expect(SUBSCRIPTION_STATUSES).toHaveLength(6);
    expect(SUBSCRIPTION_STATUSES).toContain('active');
    expect(SUBSCRIPTION_STATUSES).toContain('trial');
    expect(Object.isFrozen(SUBSCRIPTION_STATUSES)).toBe(true);
  });
  test('BILLING_CYCLES frozen 5 valores', () => {
    expect(BILLING_CYCLES).toHaveLength(5);
    expect(BILLING_CYCLES).toContain('monthly');
    expect(BILLING_CYCLES).toContain('annual');
    expect(Object.isFrozen(BILLING_CYCLES)).toBe(true);
  });
  test('CYCLE_DAYS tiene valores correctos', () => {
    expect(CYCLE_DAYS.weekly).toBe(7);
    expect(CYCLE_DAYS.monthly).toBe(30);
    expect(CYCLE_DAYS.quarterly).toBe(90);
    expect(CYCLE_DAYS.annual).toBe(365);
  });
  test('GRACE_PERIOD_DAYS es 3', () => {
    expect(GRACE_PERIOD_DAYS).toBe(3);
  });
});

// ─── computeNextBillingDate ───────────────────────────────────────────────────
describe('computeNextBillingDate', () => {
  test('mensual agrega 30 dias en ms', () => {
    const from = 1000000;
    const next = computeNextBillingDate(from, 'monthly');
    expect(next).toBe(from + 30 * 24 * 60 * 60 * 1000);
  });
  test('annual agrega 365 dias', () => {
    const from = 1000000;
    expect(computeNextBillingDate(from, 'annual')).toBe(from + 365 * 24 * 60 * 60 * 1000);
  });
  test('cycle invalido → error', () => {
    expect(() => computeNextBillingDate(1000, 'INVALID')).toThrow('invalido');
  });
});

// ─── buildSubscriptionRecord ──────────────────────────────────────────────────
describe('buildSubscriptionRecord', () => {
  test('defaults correctos sin trial', () => {
    const s = buildSubscriptionRecord(UID, { name: 'Plan Basico', price: 1000 });
    expect(s.uid).toBe(UID);
    expect(s.status).toBe('active');
    expect(s.billingCycle).toBe('monthly');
    expect(s.currency).toBe('ARS');
    expect(s.price).toBe(1000);
    expect(s.trialDays).toBe(0);
    expect(s.trialEndsAt).toBeNull();
    expect(s.billingCount).toBe(0);
  });

  test('con trialDays → status trial y trialEndsAt', () => {
    const now = Date.now();
    const s = buildSubscriptionRecord(UID, { name: 'Plan VIP', price: 2000, trialDays: 7 });
    expect(s.status).toBe('trial');
    expect(s.trialEndsAt).toBeGreaterThan(now);
    expect(s.trialDays).toBe(7);
  });

  test('discountPercent se clampa 0-100', () => {
    const s1 = buildSubscriptionRecord(UID, { name: 'A', discountPercent: 150 });
    const s2 = buildSubscriptionRecord(UID, { name: 'B', discountPercent: -10 });
    expect(s1.discountPercent).toBe(100);
    expect(s2.discountPercent).toBe(0);
  });

  test('subscriptionId personalizado se respeta', () => {
    const s = buildSubscriptionRecord(UID, { subscriptionId: 'sub_custom_001', name: 'X' });
    expect(s.subscriptionId).toBe('sub_custom_001');
  });

  test('metadata se copia defensivamente', () => {
    const meta = { plan: 'gold' };
    const s = buildSubscriptionRecord(UID, { name: 'X', metadata: meta });
    meta.extra = 'mutated';
    expect(s.metadata.extra).toBeUndefined();
  });

  test('currency se normaliza a mayusculas 3 chars', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X', currency: 'usd' });
    expect(s.currency).toBe('USD');
  });
});

// ─── computeSubscriptionPrice ─────────────────────────────────────────────────
describe('computeSubscriptionPrice', () => {
  test('sin descuento retorna precio base', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X', price: 500 });
    expect(computeSubscriptionPrice(s)).toBe(500);
  });
  test('con descuento 20% calcula correctamente', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X', price: 1000, discountPercent: 20 });
    expect(computeSubscriptionPrice(s)).toBe(800);
  });
  test('con descuento 100% → 0', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X', price: 500, discountPercent: 100 });
    expect(computeSubscriptionPrice(s)).toBe(0);
  });
});

// ─── pauseSubscription ────────────────────────────────────────────────────────
describe('pauseSubscription', () => {
  test('activa → paused', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    const paused = pauseSubscription(s, Date.now() + 604800000);
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).toBeDefined();
    expect(paused.pausedUntil).toBeGreaterThan(Date.now());
  });
  test('cancelada → error', () => {
    const s = { ...buildSubscriptionRecord(UID, { name: 'X' }), status: 'cancelled' };
    expect(() => pauseSubscription(s)).toThrow('cancelada');
  });
  test('ya pausada → error', () => {
    const s = { ...buildSubscriptionRecord(UID, { name: 'X' }), status: 'paused' };
    expect(() => pauseSubscription(s)).toThrow('pausada');
  });
});

// ─── resumeSubscription ───────────────────────────────────────────────────────
describe('resumeSubscription', () => {
  test('paused → active, limpia campos pause', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    const paused = pauseSubscription(s, Date.now() + 1000);
    const resumed = resumeSubscription(paused);
    expect(resumed.status).toBe('active');
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.pausedUntil).toBeNull();
  });
  test('no-paused → error', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    expect(() => resumeSubscription(s)).toThrow('no esta pausada');
  });
});

// ─── cancelSubscription ───────────────────────────────────────────────────────
describe('cancelSubscription', () => {
  test('activa → cancelled con cancelledAt', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    const cancelled = cancelSubscription(s);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBeDefined();
  });
  test('ya cancelada → error', () => {
    const s = { ...buildSubscriptionRecord(UID, { name: 'X' }), status: 'cancelled' };
    expect(() => cancelSubscription(s)).toThrow('ya esta cancelada');
  });
});

// ─── recordBilling ────────────────────────────────────────────────────────────
describe('recordBilling', () => {
  test('cobro exitoso incrementa billingCount y avanza nextBillingAt', () => {
    // nextBillingAt pasado conocido para que despues del cobro sea claramente mayor
    const pastTs = 1000;
    const s = buildSubscriptionRecord(UID, { name: 'X', price: 500, billingCycle: 'monthly', nextBillingAt: pastTs });
    const billed = recordBilling(s, true);
    expect(billed.billingCount).toBe(1);
    expect(billed.lastBilledAt).toBeDefined();
    expect(billed.nextBillingAt).toBeGreaterThan(pastTs);
    expect(billed.status).toBe('active');
  });
  test('cobro fallido incrementa failedBillingCount', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    const failed = recordBilling(s, false);
    expect(failed.failedBillingCount).toBe(1);
  });
  test('3 fallos → status expired', () => {
    let s = buildSubscriptionRecord(UID, { name: 'X' });
    s = recordBilling(s, false);
    s = recordBilling(s, false);
    s = recordBilling(s, false);
    expect(s.status).toBe('expired');
    expect(s.failedBillingCount).toBe(3);
  });
});

// ─── isInGracePeriod ─────────────────────────────────────────────────────────
describe('isInGracePeriod', () => {
  test('expired reciente → en gracia', () => {
    const s = { ...buildSubscriptionRecord(UID, { name: 'X' }), status: 'expired', updatedAt: Date.now() - 1000 };
    expect(isInGracePeriod(s)).toBe(true);
  });
  test('expired hace 4 dias → fuera de gracia', () => {
    const s = { ...buildSubscriptionRecord(UID, { name: 'X' }), status: 'expired', updatedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 };
    expect(isInGracePeriod(s)).toBe(false);
  });
  test('active → false', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    expect(isInGracePeriod(s)).toBe(false);
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveSubscription + getSubscription round-trip', () => {
  test('guarda y recupera suscripcion', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const s = buildSubscriptionRecord(UID, {
      name: 'Membresia Oro', price: 5000, billingCycle: 'monthly',
      contactPhone: PHONE, contactName: 'Laura',
    });
    await saveSubscription(UID, s);
    __setFirestoreForTests(db);
    const loaded = await getSubscription(UID, s.subscriptionId);
    expect(loaded).not.toBeNull();
    expect(loaded.name).toBe('Membresia Oro');
    expect(loaded.price).toBe(5000);
    expect(loaded.contactPhone).toBe(PHONE);
  });

  test('getSubscription retorna null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await getSubscription(UID, 'nonexistent_sub');
    expect(result).toBeNull();
  });

  test('saveSubscription lanza error con throwSet', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const s = buildSubscriptionRecord(UID, { name: 'X' });
    await expect(saveSubscription(UID, s)).rejects.toThrow('set error');
  });
});

describe('updateSubscription', () => {
  test('actualiza campos con merge', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const s = buildSubscriptionRecord(UID, { name: 'Plan A', subscriptionId: 'sub_upd_001' });
    await saveSubscription(UID, s);
    __setFirestoreForTests(db);
    await updateSubscription(UID, 'sub_upd_001', { status: 'paused', pausedAt: Date.now() });
    __setFirestoreForTests(db);
    const loaded = await getSubscription(UID, 'sub_upd_001');
    expect(loaded.status).toBe('paused');
    expect(loaded.name).toBe('Plan A');
  });
});

describe('listSubscriptions', () => {
  test('filtra por status', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const s1 = buildSubscriptionRecord(UID, { name: 'A', subscriptionId: 'sub_a', status: 'active' });
    const s2 = buildSubscriptionRecord(UID, { name: 'B', subscriptionId: 'sub_b' });
    const s2c = cancelSubscription(s2);
    s2c.subscriptionId = 'sub_b';
    await saveSubscription(UID, s1);
    await saveSubscription(UID, s2c);
    __setFirestoreForTests(db);
    const active = await listSubscriptions(UID, { status: 'active' });
    expect(active.every(s => s.status === 'active')).toBe(true);
  });
});

describe('listDueBillings', () => {
  test('retorna suscripciones con nextBillingAt vencido', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const past = Date.now() - 1000;
    const future = Date.now() + 86400000;
    const s1 = buildSubscriptionRecord(UID, { name: 'Vencida', nextBillingAt: past, subscriptionId: 'sub_due' });
    const s2 = buildSubscriptionRecord(UID, { name: 'Futura', nextBillingAt: future, subscriptionId: 'sub_ok' });
    await saveSubscription(UID, s1);
    await saveSubscription(UID, s2);
    __setFirestoreForTests(db);
    const due = await listDueBillings(UID, Date.now());
    expect(due.some(s => s.subscriptionId === 'sub_due')).toBe(true);
    expect(due.some(s => s.subscriptionId === 'sub_ok')).toBe(false);
  });
});

// ─── buildSubscriptionSummaryText ─────────────────────────────────────────────
describe('buildSubscriptionSummaryText', () => {
  test('null retorna defecto', () => {
    expect(buildSubscriptionSummaryText(null)).toContain('no encontrada');
  });
  test('activa incluye datos clave', () => {
    const s = buildSubscriptionRecord(UID, {
      name: 'Plan Oro', price: 3000, billingCycle: 'monthly',
      contactName: 'Maria', discountPercent: 10,
    });
    const text = buildSubscriptionSummaryText(s);
    expect(text).toContain('Plan Oro');
    expect(text).toContain('active');
    expect(text).toContain('monthly');
    expect(text).toContain('2700'); // 3000 * 0.9
    expect(text).toContain('10%');
    expect(text).toContain('Maria');
  });
  test('trial incluye fecha fin trial', () => {
    const s = buildSubscriptionRecord(UID, { name: 'Trial VIP', price: 0, trialDays: 14 });
    const text = buildSubscriptionSummaryText(s);
    expect(text).toContain('trial');
    expect(text).toContain('Trial hasta');
  });
});

// ─── PIPELINE: ciclo de vida completo ─────────────────────────────────────────
describe('Pipeline: ciclo de vida suscripcion', () => {
  test('alta → trial → pago → pausa → reanuda → cancela', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    // 1. Crear suscripcion con trial
    let sub = buildSubscriptionRecord(UID, {
      name: 'Membresia Premium', price: 2000,
      billingCycle: 'monthly', currency: 'ARS',
      contactPhone: PHONE, contactName: 'Ricardo',
      trialDays: 7,
    });
    expect(sub.status).toBe('trial');
    expect(sub.trialEndsAt).toBeGreaterThan(Date.now());

    await saveSubscription(UID, sub);
    __setFirestoreForTests(db);
    const loaded = await getSubscription(UID, sub.subscriptionId);
    expect(loaded.status).toBe('trial');

    // 2. Primer cobro exitoso
    sub = recordBilling(sub, true);
    expect(sub.status).toBe('active');
    expect(sub.billingCount).toBe(1);
    expect(sub.lastBilledAt).toBeDefined();
    __setFirestoreForTests(db);
    await updateSubscription(UID, sub.subscriptionId, {
      status: sub.status, billingCount: sub.billingCount,
      lastBilledAt: sub.lastBilledAt, nextBillingAt: sub.nextBillingAt,
    });

    // 3. Verificar precio con descuento 0%
    expect(computeSubscriptionPrice(sub)).toBe(2000);

    // 4. Pausar suscripcion
    const pauseUntil = Date.now() + 14 * 24 * 60 * 60 * 1000;
    sub = pauseSubscription(sub, pauseUntil);
    expect(sub.status).toBe('paused');
    __setFirestoreForTests(db);
    await updateSubscription(UID, sub.subscriptionId, { status: sub.status, pausedAt: sub.pausedAt });

    // 5. Reanudar
    sub = resumeSubscription(sub);
    expect(sub.status).toBe('active');
    expect(sub.pausedAt).toBeNull();
    __setFirestoreForTests(db);
    await updateSubscription(UID, sub.subscriptionId, { status: sub.status, pausedAt: null });

    // 6. Segundo cobro exitoso
    sub = recordBilling(sub, true);
    expect(sub.billingCount).toBe(2);

    // 7. Cancelar
    sub = cancelSubscription(sub);
    expect(sub.status).toBe('cancelled');
    expect(sub.cancelledAt).toBeDefined();
    __setFirestoreForTests(db);
    await updateSubscription(UID, sub.subscriptionId, { status: sub.status, cancelledAt: sub.cancelledAt });

    // 8. Verificar estado final en Firestore
    __setFirestoreForTests(db);
    const final = await getSubscription(UID, sub.subscriptionId);
    expect(final.status).toBe('cancelled');

    // 9. Texto final
    const text = buildSubscriptionSummaryText(sub);
    expect(text).toContain('cancelled');
    expect(text).toContain('Membresia Premium');
  });
});
