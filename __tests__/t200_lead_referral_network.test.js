'use strict';

const {
  buildReferralMessage, createReferral, updateReferralState,
  getSentReferrals, getReceivedReferrals, getReferralStats,
  REFERRAL_STATES, REFERRAL_TYPES, DEFAULT_EXPIRY_DAYS,
  __setFirestoreForTests,
} = require('../core/lead_referral_network');

const FROM_UID = 'fromUid1234567890';
const TO_UID = 'toUid0987654321ab';
const PHONE = '+541155667788';

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var singleDoc = {
    set: async function(data, setOpts) { if (throwSet) throw new Error('set error'); },
  };

  var coll = {
    doc: function() { return singleDoc; },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'r' + i }); }); } };
    },
  };

  var tenantUidDoc = { collection: function() { return coll; } };
  var globalColl = { doc: function() { return singleDoc; } };

  return {
    collection: function(name) {
      if (name === 'tenants') return { doc: function() { return tenantUidDoc; } };
      return globalColl;
    },
  };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('REFERRAL_STATES y constants', function() {
  test('tiene pending accepted rejected converted expired', function() {
    expect(REFERRAL_STATES).toContain('pending');
    expect(REFERRAL_STATES).toContain('accepted');
    expect(REFERRAL_STATES).toContain('converted');
  });
  test('frozen', function() { expect(function() { REFERRAL_STATES[0] = 'x'; }).toThrow(); });
  test('DEFAULT_EXPIRY_DAYS es 14', function() { expect(DEFAULT_EXPIRY_DAYS).toBe(14); });
});

describe('buildReferralMessage', function() {
  test('retorna mensaje en espanol', function() {
    var r = buildReferralMessage('Mi Negocio', 'Negocio B', null, 'es');
    expect(r).toContain('Negocio B');
  });
  test('retorna mensaje en ingles', function() {
    var r = buildReferralMessage('My Biz', 'Biz B', null, 'en');
    expect(r).toContain('Biz B');
  });
});

describe('createReferral', function() {
  test('lanza si fromUid undefined', async function() {
    await expect(createReferral(undefined, TO_UID, PHONE)).rejects.toThrow('fromUid requerido');
  });
  test('lanza si toUid undefined', async function() {
    await expect(createReferral(FROM_UID, undefined, PHONE)).rejects.toThrow('toUid requerido');
  });
  test('lanza si leadPhone undefined', async function() {
    await expect(createReferral(FROM_UID, TO_UID, undefined)).rejects.toThrow('leadPhone requerido');
  });
  test('lanza si fromUid igual a toUid', async function() {
    await expect(createReferral(FROM_UID, FROM_UID, PHONE)).rejects.toThrow('iguales');
  });
  test('lanza si type invalido', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(createReferral(FROM_UID, TO_UID, PHONE, { type: 'tipo_raro' })).rejects.toThrow('invalido');
  });
  test('crea referido correctamente', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await createReferral(FROM_UID, TO_UID, PHONE);
    expect(r.referralId).toBeDefined();
    expect(r.state).toBe('pending');
    expect(r.expiresAt).toBeDefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(createReferral(FROM_UID, TO_UID, PHONE)).rejects.toThrow('set error');
  });
});

describe('updateReferralState', function() {
  test('lanza si referralId undefined', async function() {
    await expect(updateReferralState(undefined, 'accepted')).rejects.toThrow('referralId requerido');
  });
  test('lanza si state invalido', async function() {
    await expect(updateReferralState('r1', 'aceptado_mal')).rejects.toThrow('invalido');
  });
  test('actualiza state correctamente', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await updateReferralState('r1', 'accepted');
    expect(r.state).toBe('accepted');
    expect(r.referralId).toBe('r1');
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(updateReferralState('r1', 'accepted')).rejects.toThrow('set error');
  });
});

describe('getSentReferrals', function() {
  test('lanza si uid undefined', async function() {
    await expect(getSentReferrals(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay enviados', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getSentReferrals(FROM_UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getSentReferrals(FROM_UID);
    expect(r).toEqual([]);
  });
});

describe('getReceivedReferrals', function() {
  test('lanza si uid undefined', async function() {
    await expect(getReceivedReferrals(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay recibidos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getReceivedReferrals(TO_UID);
    expect(r).toEqual([]);
  });
});

describe('getReferralStats', function() {
  test('lanza si uid undefined', async function() {
    await expect(getReferralStats(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna estructura correcta', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getReferralStats(FROM_UID);
    expect(r).toHaveProperty('sentTotal');
    expect(r).toHaveProperty('receivedTotal');
    expect(r).toHaveProperty('conversionRate');
  });
  test('conversionRate 0 si no hay enviados', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getReferralStats(FROM_UID);
    expect(r.conversionRate).toBe(0);
  });
});
