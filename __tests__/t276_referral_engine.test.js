'use strict';

// T276: referral_engine
const {
  buildReferralProgramRecord, buildReferralRecord, qualifyReferral, rewardReferral,
  expireReferral, applyProgramStats, isProgramActive, computeConversionRate,
  generateReferralCode, buildReferralProgramText,
  saveReferralProgram, getReferralProgram, saveReferral, getReferral,
  updateReferral, listReferralsByStatus,
  REFERRAL_STATUSES, REWARD_TRIGGERS, CODE_LENGTH,
  __setFirestoreForTests,
} = require('../core/referral_engine');

const UID = 'testRefUid';
const REFERRER = '+5491155550001';
const REFERRED = '+5491155550002';

function makeMockDb({ stored = {}, refStored = {}, throwGet = false, throwSet = false } = {}) {
  const stores = { stored, refStored };
  function getStore(subCol) {
    return subCol === 'referrals' ? stores.refStored : stores.stored;
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
  test('REFERRAL_STATUSES frozen 5 valores', () => {
    expect(REFERRAL_STATUSES).toHaveLength(5);
    expect(REFERRAL_STATUSES).toContain('pending');
    expect(REFERRAL_STATUSES).toContain('rewarded');
    expect(Object.isFrozen(REFERRAL_STATUSES)).toBe(true);
  });
  test('REWARD_TRIGGERS frozen 5 valores', () => {
    expect(REWARD_TRIGGERS).toHaveLength(5);
    expect(REWARD_TRIGGERS).toContain('first_purchase');
    expect(Object.isFrozen(REWARD_TRIGGERS)).toBe(true);
  });
  test('CODE_LENGTH es 6', () => {
    expect(CODE_LENGTH).toBe(6);
  });
});

// ─── generateReferralCode ─────────────────────────────────────────────────────
describe('generateReferralCode', () => {
  test('genera codigo de longitud CODE_LENGTH', () => {
    const code = generateReferralCode(UID);
    expect(code.length).toBe(CODE_LENGTH);
  });
  test('con mismo seed genera mismo codigo', () => {
    const c1 = generateReferralCode(UID, 'seed123');
    const c2 = generateReferralCode(UID, 'seed123');
    expect(c1).toBe(c2);
  });
  test('con seed distinto genera codigo distinto', () => {
    const c1 = generateReferralCode(UID, 'seed_A');
    const c2 = generateReferralCode(UID, 'seed_B');
    expect(c1).not.toBe(c2);
  });
  test('codigo no contiene caracteres confusos (O, 0, I, 1)', () => {
    const code = generateReferralCode(UID, 'testseed');
    expect(code).not.toMatch(/[OI01]/);
  });
});

// ─── buildReferralProgramRecord ───────────────────────────────────────────────
describe('buildReferralProgramRecord', () => {
  test('defaults correctos', () => {
    const p = buildReferralProgramRecord(UID, {});
    expect(p.uid).toBe(UID);
    expect(p.referredCount).toBe(0);
    expect(p.active).toBe(true);
    expect(p.code.length).toBe(CODE_LENGTH);
    expect(p.rewardTrigger).toBe('first_purchase');
    expect(p.currency).toBe('ARS');
  });
  test('code personalizado se respeta', () => {
    const p = buildReferralProgramRecord(UID, { code: 'MIIA30' });
    expect(p.code).toBe('MIIA30');
  });
  test('rewardAmounts se clampa a 0..MAX', () => {
    const p = buildReferralProgramRecord(UID, { referrerRewardAmount: 999999, referredRewardAmount: -10 });
    expect(p.referrerRewardAmount).toBe(100000);
    expect(p.referredRewardAmount).toBe(0);
  });
  test('rewardTrigger invalido cae a first_purchase', () => {
    const p = buildReferralProgramRecord(UID, { rewardTrigger: 'INVALID' });
    expect(p.rewardTrigger).toBe('first_purchase');
  });
});

// ─── buildReferralRecord ──────────────────────────────────────────────────────
describe('buildReferralRecord', () => {
  test('defaults correctos', () => {
    const r = buildReferralRecord(UID, REFERRER, REFERRED, { code: 'MIIA30', referrerRewardAmount: 500 });
    expect(r.uid).toBe(UID);
    expect(r.referrerPhone).toBe(REFERRER);
    expect(r.referredPhone).toBe(REFERRED);
    expect(r.status).toBe('pending');
    expect(r.code).toBe('MIIA30');
    expect(r.referrerRewardAmount).toBe(500);
    expect(r.referrerRewarded).toBe(false);
    expect(r.referralId).toContain('_ref_');
  });
});

// ─── qualifyReferral ─────────────────────────────────────────────────────────
describe('qualifyReferral', () => {
  test('pending → qualified con qualifiedAt', () => {
    const r = buildReferralRecord(UID, REFERRER, REFERRED, {});
    const q = qualifyReferral(r);
    expect(q.status).toBe('qualified');
    expect(q.qualifiedAt).toBeDefined();
  });
  test('no-pending → error', () => {
    const r = { ...buildReferralRecord(UID, REFERRER, REFERRED, {}), status: 'qualified' };
    expect(() => qualifyReferral(r)).toThrow('pending');
  });
  test('expirado → error', () => {
    const r = { ...buildReferralRecord(UID, REFERRER, REFERRED, {}), expiresAt: 1 };
    expect(() => qualifyReferral(r)).toThrow('expirado');
  });
});

// ─── rewardReferral ───────────────────────────────────────────────────────────
describe('rewardReferral', () => {
  test('qualified → rewarded con rewardedAt', () => {
    const r = buildReferralRecord(UID, REFERRER, REFERRED, {});
    const q = qualifyReferral(r);
    const rew = rewardReferral(q);
    expect(rew.status).toBe('rewarded');
    expect(rew.referrerRewarded).toBe(true);
    expect(rew.referredRewarded).toBe(true);
    expect(rew.rewardedAt).toBeDefined();
  });
  test('no-qualified → error', () => {
    const r = buildReferralRecord(UID, REFERRER, REFERRED, {});
    expect(() => rewardReferral(r)).toThrow('qualified');
  });
});

// ─── expireReferral ───────────────────────────────────────────────────────────
describe('expireReferral', () => {
  test('pending → expired', () => {
    const r = buildReferralRecord(UID, REFERRER, REFERRED, {});
    const exp = expireReferral(r);
    expect(exp.status).toBe('expired');
  });
  test('rewarded → error', () => {
    let r = buildReferralRecord(UID, REFERRER, REFERRED, {});
    r = rewardReferral(qualifyReferral(r));
    expect(() => expireReferral(r)).toThrow('expirar');
  });
});

// ─── applyProgramStats ────────────────────────────────────────────────────────
describe('applyProgramStats', () => {
  test('referred incrementa referredCount', () => {
    const p = buildReferralProgramRecord(UID, {});
    const updated = applyProgramStats(p, 'referred');
    expect(updated.referredCount).toBe(1);
  });
  test('qualified incrementa qualifiedCount', () => {
    const p = buildReferralProgramRecord(UID, {});
    const updated = applyProgramStats(p, 'qualified');
    expect(updated.qualifiedCount).toBe(1);
  });
  test('rewarded incrementa rewardedCount', () => {
    const p = buildReferralProgramRecord(UID, {});
    const updated = applyProgramStats(p, 'rewarded');
    expect(updated.rewardedCount).toBe(1);
  });
});

// ─── isProgramActive / computeConversionRate ──────────────────────────────────
describe('isProgramActive', () => {
  test('activo por defecto', () => {
    const p = buildReferralProgramRecord(UID, {});
    expect(isProgramActive(p)).toBe(true);
  });
  test('activo=false → inactivo', () => {
    const p = { ...buildReferralProgramRecord(UID, {}), active: false };
    expect(isProgramActive(p)).toBe(false);
  });
  test('expiresAt pasado → inactivo', () => {
    const p = { ...buildReferralProgramRecord(UID, {}), expiresAt: 1 };
    expect(isProgramActive(p)).toBe(false);
  });
  test('referredCount >= maxReferrals → inactivo', () => {
    const p = { ...buildReferralProgramRecord(UID, { maxReferrals: 5 }), referredCount: 5 };
    expect(isProgramActive(p)).toBe(false);
  });
});

describe('computeConversionRate', () => {
  test('sin referidos → 0', () => {
    const p = buildReferralProgramRecord(UID, {});
    expect(computeConversionRate(p)).toBe(0);
  });
  test('calcula porcentaje correctamente', () => {
    const p = { ...buildReferralProgramRecord(UID, {}), referredCount: 10, qualifiedCount: 3 };
    expect(computeConversionRate(p)).toBe(30);
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveReferralProgram + getReferralProgram', () => {
  test('round-trip', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const p = buildReferralProgramRecord(UID, { code: 'TEST01', referrerRewardAmount: 300 });
    await saveReferralProgram(UID, p);
    __setFirestoreForTests(db);
    const loaded = await getReferralProgram(UID, p.programId);
    expect(loaded).not.toBeNull();
    expect(loaded.code).toBe('TEST01');
    expect(loaded.referrerRewardAmount).toBe(300);
  });
  test('getReferralProgram null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    expect(await getReferralProgram(UID, 'nonexistent')).toBeNull();
  });
  test('saveReferralProgram lanza con throwSet', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const p = buildReferralProgramRecord(UID, {});
    await expect(saveReferralProgram(UID, p)).rejects.toThrow('set error');
  });
});

describe('saveReferral + getReferral + listReferralsByStatus', () => {
  test('round-trip y listado por status', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r = buildReferralRecord(UID, REFERRER, REFERRED, { code: 'MIIA30' });
    await saveReferral(UID, r);
    __setFirestoreForTests(db);
    const loaded = await getReferral(UID, r.referralId);
    expect(loaded.referrerPhone).toBe(REFERRER);
    __setFirestoreForTests(db);
    const pending = await listReferralsByStatus(UID, 'pending');
    expect(pending.some(x => x.referralId === r.referralId)).toBe(true);
  });

  test('updateReferral con merge', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const r = buildReferralRecord(UID, REFERRER, REFERRED, {});
    await saveReferral(UID, r);
    __setFirestoreForTests(db);
    await updateReferral(UID, r.referralId, { status: 'qualified', qualifiedAt: Date.now() });
    __setFirestoreForTests(db);
    const loaded = await getReferral(UID, r.referralId);
    expect(loaded.status).toBe('qualified');
    expect(loaded.referrerPhone).toBe(REFERRER);
  });
});

// ─── buildReferralProgramText ─────────────────────────────────────────────────
describe('buildReferralProgramText', () => {
  test('null retorna defecto', () => {
    expect(buildReferralProgramText(null)).toContain('no encontrado');
  });
  test('activo incluye datos clave', () => {
    const p = buildReferralProgramRecord(UID, {
      code: 'VERANO', referrerRewardAmount: 500, referredRewardAmount: 200, rewardTrigger: 'subscription',
    });
    const text = buildReferralProgramText(p);
    expect(text).toContain('VERANO');
    expect(text).toContain('activo');
    expect(text).toContain('500');
    expect(text).toContain('subscription');
  });
  test('inactivo muestra rojo', () => {
    const p = { ...buildReferralProgramRecord(UID, { code: 'OLD' }), active: false };
    const text = buildReferralProgramText(p);
    expect(text).toContain('inactivo');
  });
});

// ─── PIPELINE: ciclo completo de referido ─────────────────────────────────────
describe('Pipeline: referido pendiente → califica → recompensado', () => {
  test('flujo completo de programa de referidos', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    // 1. Crear programa de referidos
    let program = buildReferralProgramRecord(UID, {
      code: 'MIIA50',
      referrerRewardAmount: 500,
      referredRewardAmount: 300,
      rewardTrigger: 'first_purchase',
      maxReferrals: 10,
    });
    expect(isProgramActive(program)).toBe(true);
    await saveReferralProgram(UID, program);

    // 2. Referidor comparte codigo → referido se registra
    program = applyProgramStats(program, 'referred');
    let referral = buildReferralRecord(UID, REFERRER, REFERRED, {
      code: 'MIIA50',
      referrerRewardAmount: 500,
      referredRewardAmount: 300,
      rewardTrigger: 'first_purchase',
    });
    expect(referral.status).toBe('pending');
    __setFirestoreForTests(db);
    await saveReferral(UID, referral);

    // 3. Referido hace primera compra → califica
    referral = qualifyReferral(referral);
    expect(referral.status).toBe('qualified');
    program = applyProgramStats(program, 'qualified');
    __setFirestoreForTests(db);
    await updateReferral(UID, referral.referralId, { status: referral.status, qualifiedAt: referral.qualifiedAt });

    // 4. Verificar listado qualified
    __setFirestoreForTests(db);
    const qualifiedList = await listReferralsByStatus(UID, 'qualified');
    expect(qualifiedList.some(r => r.referralId === referral.referralId)).toBe(true);

    // 5. Dar recompensa
    referral = rewardReferral(referral);
    program = applyProgramStats(program, 'rewarded');
    expect(referral.status).toBe('rewarded');
    expect(referral.referrerRewarded).toBe(true);
    __setFirestoreForTests(db);
    await updateReferral(UID, referral.referralId, {
      status: referral.status, referrerRewarded: true, referredRewarded: true, rewardedAt: referral.rewardedAt,
    });

    // 6. Actualizar stats del programa
    __setFirestoreForTests(db);
    await saveReferralProgram(UID, program);

    // 7. Verificar estado final
    expect(program.referredCount).toBe(1);
    expect(program.qualifiedCount).toBe(1);
    expect(program.rewardedCount).toBe(1);
    expect(computeConversionRate(program)).toBe(100);

    __setFirestoreForTests(db);
    const finalReferral = await getReferral(UID, referral.referralId);
    expect(finalReferral.status).toBe('rewarded');

    // 8. Texto del programa
    const text = buildReferralProgramText(program);
    expect(text).toContain('MIIA50');
    expect(text).toContain('100%');
  });
});
