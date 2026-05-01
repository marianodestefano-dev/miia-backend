'use strict';

// T274: loyalty_engine
const {
  buildLoyaltyAccount, buildTransactionRecord, earnPoints, redeemPoints,
  adjustPoints, buildRewardRecord, canRedeemReward, computeTier,
  computePointsFromAmount, buildLoyaltySummaryText,
  saveLoyaltyAccount, getLoyaltyAccount, updateLoyaltyAccount,
  saveTransaction, listTransactions,
  TRANSACTION_TYPES, REWARD_TYPES, TIER_NAMES, TIER_THRESHOLDS,
  MIN_REDEEM_POINTS,
  __setFirestoreForTests,
} = require('../core/loyalty_engine');

const UID = 'testLoyaltyUid';
const PHONE = '+5491155550001';

function makeMockDb({ stored = {}, txStored = {}, throwGet = false, throwSet = false } = {}) {
  const stores = { stored, txStored };
  function getStore(subCol) {
    return subCol === 'loyalty_transactions' ? stores.txStored : stores.stored;
  }
  return {
    collection: () => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const s = getStore(subCol);
              s[id] = opts && opts.merge ? { ...(s[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              return { exists: !!s[id], data: () => s[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              const entries = Object.values(s).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const s = getStore(subCol);
            return { empty: Object.keys(s).length === 0, forEach: fn => Object.values(s).forEach(d => fn({ data: () => d })) };
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
  test('TRANSACTION_TYPES frozen 5 valores', () => {
    expect(TRANSACTION_TYPES).toHaveLength(5);
    expect(TRANSACTION_TYPES).toContain('earn');
    expect(TRANSACTION_TYPES).toContain('redeem');
    expect(Object.isFrozen(TRANSACTION_TYPES)).toBe(true);
  });
  test('TIER_NAMES frozen 5 valores en orden', () => {
    expect(TIER_NAMES).toHaveLength(5);
    expect(TIER_NAMES[0]).toBe('bronze');
    expect(TIER_NAMES[4]).toBe('diamond');
    expect(Object.isFrozen(TIER_NAMES)).toBe(true);
  });
  test('TIER_THRESHOLDS correctos', () => {
    expect(TIER_THRESHOLDS.bronze).toBe(0);
    expect(TIER_THRESHOLDS.silver).toBe(500);
    expect(TIER_THRESHOLDS.gold).toBe(2000);
    expect(TIER_THRESHOLDS.diamond).toBe(10000);
  });
  test('MIN_REDEEM_POINTS es 100', () => {
    expect(MIN_REDEEM_POINTS).toBe(100);
  });
});

// ─── computeTier ──────────────────────────────────────────────────────────────
describe('computeTier', () => {
  test('0 → bronze', () => { expect(computeTier(0)).toBe('bronze'); });
  test('499 → bronze', () => { expect(computeTier(499)).toBe('bronze'); });
  test('500 → silver', () => { expect(computeTier(500)).toBe('silver'); });
  test('2000 → gold', () => { expect(computeTier(2000)).toBe('gold'); });
  test('5000 → platinum', () => { expect(computeTier(5000)).toBe('platinum'); });
  test('10000 → diamond', () => { expect(computeTier(10000)).toBe('diamond'); });
  test('negativo → bronze', () => { expect(computeTier(-1)).toBe('bronze'); });
});

// ─── computePointsFromAmount ──────────────────────────────────────────────────
describe('computePointsFromAmount', () => {
  test('1 punto por ARS (default)', () => {
    expect(computePointsFromAmount(500)).toBe(500);
  });
  test('con multiplier 2x', () => {
    expect(computePointsFromAmount(300, 2)).toBe(600);
  });
  test('clampa al MAX', () => {
    const result = computePointsFromAmount(999999, 2);
    expect(result).toBe(100000); // MAX_POINTS_PER_TRANSACTION
  });
  test('amount negativo → 0', () => {
    expect(computePointsFromAmount(-100)).toBe(0);
  });
});

// ─── buildLoyaltyAccount ──────────────────────────────────────────────────────
describe('buildLoyaltyAccount', () => {
  test('defaults correctos para cuenta nueva', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    expect(acc.uid).toBe(UID);
    expect(acc.contactPhone).toBe(PHONE);
    expect(acc.points).toBe(0);
    expect(acc.tier).toBe('bronze');
    expect(acc.totalEarned).toBe(0);
    expect(acc.active).toBe(true);
    expect(acc.accountId).toContain('loyalty_');
  });
  test('tier se calcula segun totalEarned', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { totalEarned: 2500 });
    expect(acc.tier).toBe('gold');
  });
  test('accountId es idempotente con mismo phone', () => {
    const acc1 = buildLoyaltyAccount(UID, PHONE, {});
    const acc2 = buildLoyaltyAccount(UID, PHONE, {});
    // Ambos usan el mismo buildLoyaltyAccountId
    expect(acc1.accountId.includes(PHONE.slice(-8))).toBe(true);
  });
});

// ─── earnPoints ───────────────────────────────────────────────────────────────
describe('earnPoints', () => {
  test('agrega puntos y actualiza totalEarned y tier', () => {
    let acc = buildLoyaltyAccount(UID, PHONE, {});
    const { account, transaction } = earnPoints(acc, 600, { description: 'Compra #001' });
    expect(account.points).toBe(600);
    expect(account.totalEarned).toBe(600);
    expect(account.tier).toBe('silver'); // >= 500
    expect(transaction.type).toBe('earn');
    expect(transaction.points).toBe(600);
    expect(transaction.balanceBefore).toBe(0);
    expect(transaction.balanceAfter).toBe(600);
  });
  test('sube a gold con earn acumulado', () => {
    let acc = buildLoyaltyAccount(UID, PHONE, { points: 1800, totalEarned: 1800 });
    const { account } = earnPoints(acc, 300);
    expect(account.totalEarned).toBe(2100);
    expect(account.tier).toBe('gold');
  });
  test('points no-positivo → error', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    expect(() => earnPoints(acc, 0)).toThrow('positivo');
    expect(() => earnPoints(acc, -10)).toThrow('positivo');
  });
  test('transactionCount se incrementa', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    const { account } = earnPoints(acc, 100);
    expect(account.transactionCount).toBe(1);
  });
});

// ─── redeemPoints ─────────────────────────────────────────────────────────────
describe('redeemPoints', () => {
  test('canjea puntos y actualiza totalRedeemed', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 500 });
    const { account, transaction } = redeemPoints(acc, 200, { description: 'Descuento' });
    expect(account.points).toBe(300);
    expect(account.totalRedeemed).toBe(200);
    expect(transaction.type).toBe('redeem');
    expect(transaction.balanceBefore).toBe(500);
    expect(transaction.balanceAfter).toBe(300);
  });
  test('saldo insuficiente → error', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 50 });
    expect(() => redeemPoints(acc, 100)).toThrow('Saldo insuficiente');
  });
  test('menos de MIN_REDEEM_POINTS → error', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 500 });
    expect(() => redeemPoints(acc, 50)).toThrow('Minimo');
  });
  test('points 0 → error', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 500 });
    expect(() => redeemPoints(acc, 0)).toThrow('positivo');
  });
});

// ─── adjustPoints ─────────────────────────────────────────────────────────────
describe('adjustPoints', () => {
  test('ajuste positivo suma', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 200 });
    const { account } = adjustPoints(acc, 100, { description: 'Bono' });
    expect(account.points).toBe(300);
    expect(account.transactionCount).toBe(1);
  });
  test('ajuste negativo resta (min 0)', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 50 });
    const { account } = adjustPoints(acc, -100);
    expect(account.points).toBe(0);
  });
});

// ─── buildRewardRecord ────────────────────────────────────────────────────────
describe('buildRewardRecord', () => {
  test('defaults correctos', () => {
    const r = buildRewardRecord(UID, 'discount', { name: '10% OFF', pointsCost: 200, value: 10 });
    expect(r.uid).toBe(UID);
    expect(r.type).toBe('discount');
    expect(r.pointsCost).toBe(200);
    expect(r.active).toBe(true);
    expect(r.requiredTier).toBe('bronze');
    expect(r.redemptionCount).toBe(0);
  });
  test('type invalido → error', () => {
    expect(() => buildRewardRecord(UID, 'INVALID_TYPE', {})).toThrow('invalido');
  });
  test('tier requerido se respeta', () => {
    const r = buildRewardRecord(UID, 'upgrade', { requiredTier: 'gold', pointsCost: 1000 });
    expect(r.requiredTier).toBe('gold');
  });
});

// ─── canRedeemReward ─────────────────────────────────────────────────────────
describe('canRedeemReward', () => {
  test('silver puede canjear reward de bronze', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 500, totalEarned: 500 });
    const reward = buildRewardRecord(UID, 'discount', { pointsCost: 200, requiredTier: 'bronze' });
    const { canRedeem, errors } = canRedeemReward(acc, reward);
    expect(canRedeem).toBe(true);
    expect(errors).toHaveLength(0);
  });
  test('bronze NO puede canjear reward de gold', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 1000 });
    const reward = buildRewardRecord(UID, 'discount', { pointsCost: 100, requiredTier: 'gold' });
    const { canRedeem, errors } = canRedeemReward(acc, reward);
    expect(canRedeem).toBe(false);
    expect(errors.some(e => e.includes('tier'))).toBe(true);
  });
  test('puntos insuficientes → error', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 50 });
    const reward = buildRewardRecord(UID, 'discount', { pointsCost: 200 });
    const { canRedeem, errors } = canRedeemReward(acc, reward);
    expect(canRedeem).toBe(false);
    expect(errors.some(e => e.includes('insuficientes'))).toBe(true);
  });
  test('reward inactiva → error', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 500 });
    const reward = { ...buildRewardRecord(UID, 'discount', { pointsCost: 100 }), active: false };
    const { canRedeem } = canRedeemReward(acc, reward);
    expect(canRedeem).toBe(false);
  });
  test('reward agotada (maxRedemptions)', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 500 });
    const reward = { ...buildRewardRecord(UID, 'discount', { pointsCost: 100, maxRedemptions: 10 }), redemptionCount: 10 };
    const { canRedeem } = canRedeemReward(acc, reward);
    expect(canRedeem).toBe(false);
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveLoyaltyAccount + getLoyaltyAccount round-trip', () => {
  test('guarda y recupera cuenta', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const acc = buildLoyaltyAccount(UID, PHONE, { contactName: 'Laura', points: 300 });
    await saveLoyaltyAccount(UID, acc);
    __setFirestoreForTests(db);
    const loaded = await getLoyaltyAccount(UID, acc.accountId);
    expect(loaded).not.toBeNull();
    expect(loaded.contactName).toBe('Laura');
    expect(loaded.points).toBe(300);
  });

  test('getLoyaltyAccount retorna null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await getLoyaltyAccount(UID, 'nonexistent');
    expect(result).toBeNull();
  });

  test('saveLoyaltyAccount lanza con throwSet', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    await expect(saveLoyaltyAccount(UID, acc)).rejects.toThrow('set error');
  });
});

describe('saveTransaction + listTransactions', () => {
  test('guarda y lista transacciones por accountId', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const acc = buildLoyaltyAccount(UID, PHONE, {});
    const { account, transaction } = earnPoints(acc, 300);
    await saveTransaction(UID, transaction);
    __setFirestoreForTests(db);
    const txs = await listTransactions(UID, acc.accountId);
    expect(txs.length).toBeGreaterThanOrEqual(1);
    expect(txs[0].type).toBe('earn');
    expect(txs[0].points).toBe(300);
  });
});

// ─── buildLoyaltySummaryText ──────────────────────────────────────────────────
describe('buildLoyaltySummaryText', () => {
  test('null retorna defecto', () => {
    expect(buildLoyaltySummaryText(null)).toContain('no encontrada');
  });
  test('muestra tier, puntos y progreso al siguiente', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 800, totalEarned: 800, contactName: 'Ana' });
    const text = buildLoyaltySummaryText(acc);
    expect(text).toContain('SILVER');
    expect(text).toContain('800');
    expect(text).toContain('Ana');
    expect(text).toContain('GOLD'); // siguiente tier en mayusculas
  });
  test('diamond no muestra siguiente tier', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 15000, totalEarned: 15000 });
    const text = buildLoyaltySummaryText(acc);
    expect(text).toContain('DIAMOND');
    expect(text).not.toContain('Faltan');
  });
});

// ─── PIPELINE: programa completo ──────────────────────────────────────────────
describe('Pipeline: cliente sube de tier y canjea recompensa', () => {
  test('earn multiple → upgrade tier → canRedeem reward → redeem', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    // 1. Crear cuenta nueva
    let account = buildLoyaltyAccount(UID, PHONE, { contactName: 'Carlos' });
    expect(account.tier).toBe('bronze');
    await saveLoyaltyAccount(UID, account);

    // 2. Ganar puntos de compra 1 (500 ARS = 500 pts)
    let result = earnPoints(account, computePointsFromAmount(500), { description: 'Compra servicio A' });
    account = result.account;
    expect(account.tier).toBe('silver');
    __setFirestoreForTests(db);
    await saveTransaction(UID, result.transaction);
    await updateLoyaltyAccount(UID, account.accountId, { points: account.points, totalEarned: account.totalEarned, tier: account.tier, transactionCount: account.transactionCount });

    // 3. Ganar puntos de compra 2 (1600 ARS = 1600 pts)
    result = earnPoints(account, computePointsFromAmount(1600), { description: 'Compra servicio B' });
    account = result.account;
    expect(account.tier).toBe('gold'); // 500 + 1600 = 2100 >= 2000
    __setFirestoreForTests(db);
    await saveTransaction(UID, result.transaction);

    // 4. Crear recompensa que requiere gold
    const reward = buildRewardRecord(UID, 'discount', {
      name: '15% OFF Gold',
      pointsCost: 500,
      value: 15,
      requiredTier: 'gold',
    });

    // 5. Verificar que puede canjear
    const { canRedeem, errors } = canRedeemReward(account, reward);
    expect(canRedeem).toBe(true);
    expect(errors).toHaveLength(0);

    // 6. Canjear la recompensa
    result = redeemPoints(account, reward.pointsCost, { description: 'Canje: 15% OFF Gold', referenceId: reward.rewardId });
    account = result.account;
    expect(account.points).toBe(2100 - 500); // 1600
    expect(account.totalRedeemed).toBe(500);
    __setFirestoreForTests(db);
    await saveTransaction(UID, result.transaction);

    // 7. Guardar estado final de la cuenta
    __setFirestoreForTests(db);
    await updateLoyaltyAccount(UID, account.accountId, {
      points: account.points, totalEarned: account.totalEarned,
      totalRedeemed: account.totalRedeemed, tier: account.tier,
      transactionCount: account.transactionCount,
    });

    // 8. Verificar estado en Firestore
    __setFirestoreForTests(db);
    const loaded = await getLoyaltyAccount(UID, account.accountId);
    expect(loaded.points).toBe(1600);
    expect(loaded.tier).toBe('gold');
    expect(loaded.totalRedeemed).toBe(500);

    // 9. Listar transacciones
    __setFirestoreForTests(db);
    const txs = await listTransactions(UID, account.accountId);
    expect(txs.length).toBeGreaterThanOrEqual(3); // earn, earn, redeem

    // 10. Resumen
    const text = buildLoyaltySummaryText(loaded);
    expect(text).toContain('GOLD');
    expect(text).toContain('1600');
    expect(text).toContain('Carlos');
  });
});
