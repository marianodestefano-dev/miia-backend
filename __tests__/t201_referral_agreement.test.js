'use strict';

const {
  validateCommission, proposeAgreement, updateAgreementState,
  getAgreement, getMyAgreements, isAgreementActive,
  AGREEMENT_STATES, COMMISSION_TYPES, MAX_COMMISSION_PERCENT,
  __setFirestoreForTests,
} = require('../core/referral_agreement');

const FROM_UID = 'fromUid1234567890';
const TO_UID = 'toUid0987654321ab';

function makeMockDb(opts) {
  opts = opts || {};
  var agreementDoc = opts.agreementDoc || null;
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var singleDoc = {
    set: async function(data, setOpts) { if (throwSet) throw new Error('set error'); },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { exists: !!agreementDoc, data: function() { return agreementDoc; } };
    },
  };

  var coll = {
    doc: function() { return singleDoc; },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'a' + i }); }); } };
    },
  };

  var tenantUidDoc = { collection: function() { return coll; } };

  return {
    collection: function(name) {
      if (name === 'tenants') return { doc: function() { return tenantUidDoc; } };
      return { doc: function() { return singleDoc; } };
    },
  };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('AGREEMENT_STATES y constants', function() {
  test('tiene proposed active paused terminated', function() {
    expect(AGREEMENT_STATES).toContain('proposed');
    expect(AGREEMENT_STATES).toContain('active');
    expect(AGREEMENT_STATES).toContain('terminated');
  });
  test('frozen', function() { expect(function() { AGREEMENT_STATES[0] = 'x'; }).toThrow(); });
  test('MAX_COMMISSION_PERCENT es 50', function() { expect(MAX_COMMISSION_PERCENT).toBe(50); });
});

describe('validateCommission', function() {
  test('lanza si commissionType invalido', function() {
    expect(function() { validateCommission('divisa', 10); }).toThrow('invalido');
  });
  test('lanza si percentage > 50', function() {
    expect(function() { validateCommission('percentage', 51); }).toThrow('50');
  });
  test('lanza si percentage negativo', function() {
    expect(function() { validateCommission('percentage', -1); }).toThrow();
  });
  test('acepta percentage valido', function() {
    expect(function() { validateCommission('percentage', 20); }).not.toThrow();
  });
  test('acepta reciprocal sin valor', function() {
    expect(function() { validateCommission('reciprocal', 0); }).not.toThrow();
  });
});

describe('proposeAgreement', function() {
  test('lanza si fromUid undefined', async function() {
    await expect(proposeAgreement(undefined, TO_UID)).rejects.toThrow('fromUid requerido');
  });
  test('lanza si toUid undefined', async function() {
    await expect(proposeAgreement(FROM_UID, undefined)).rejects.toThrow('toUid requerido');
  });
  test('lanza si fromUid igual toUid', async function() {
    await expect(proposeAgreement(FROM_UID, FROM_UID)).rejects.toThrow('iguales');
  });
  test('lanza si commissionType invalido', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(proposeAgreement(FROM_UID, TO_UID, { commissionType: 'barter' })).rejects.toThrow('invalido');
  });
  test('crea propuesta correctamente', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await proposeAgreement(FROM_UID, TO_UID);
    expect(r.agreementId).toBeDefined();
    expect(r.state).toBe('proposed');
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(proposeAgreement(FROM_UID, TO_UID)).rejects.toThrow('set error');
  });
});

describe('updateAgreementState', function() {
  test('lanza si agreementId undefined', async function() {
    await expect(updateAgreementState(undefined, 'active')).rejects.toThrow('agreementId requerido');
  });
  test('lanza si state invalido', async function() {
    await expect(updateAgreementState('a1', 'firmado')).rejects.toThrow('invalido');
  });
  test('actualiza a active', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await updateAgreementState('a1', 'active');
    expect(r.state).toBe('active');
  });
  test('actualiza a terminated', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await updateAgreementState('a1', 'terminated');
    expect(r.state).toBe('terminated');
  });
});

describe('getAgreement', function() {
  test('lanza si agreementId undefined', async function() {
    await expect(getAgreement(undefined)).rejects.toThrow('agreementId requerido');
  });
  test('retorna null si no existe', async function() {
    __setFirestoreForTests(makeMockDb({ agreementDoc: null }));
    var r = await getAgreement('a1');
    expect(r).toBeNull();
  });
  test('retorna acuerdo si existe', async function() {
    __setFirestoreForTests(makeMockDb({ agreementDoc: { agreementId: 'a1', state: 'active' } }));
    var r = await getAgreement('a1');
    expect(r.state).toBe('active');
  });
});

describe('getMyAgreements', function() {
  test('lanza si uid undefined', async function() {
    await expect(getMyAgreements(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay acuerdos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getMyAgreements(FROM_UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getMyAgreements(FROM_UID);
    expect(r).toEqual([]);
  });
});

describe('isAgreementActive', function() {
  test('lanza si fromUid undefined', async function() {
    await expect(isAgreementActive(undefined, TO_UID)).rejects.toThrow('fromUid requerido');
  });
  test('retorna false si acuerdo no existe', async function() {
    __setFirestoreForTests(makeMockDb({ agreementDoc: null }));
    var r = await isAgreementActive(FROM_UID, TO_UID);
    expect(r).toBe(false);
  });
  test('retorna false si acuerdo no esta active', async function() {
    __setFirestoreForTests(makeMockDb({ agreementDoc: { state: 'proposed' } }));
    var r = await isAgreementActive(FROM_UID, TO_UID);
    expect(r).toBe(false);
  });
  test('retorna true si acuerdo esta active', async function() {
    __setFirestoreForTests(makeMockDb({ agreementDoc: { state: 'active' } }));
    var r = await isAgreementActive(FROM_UID, TO_UID);
    expect(r).toBe(true);
  });
  test('fail-open retorna false si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await isAgreementActive(FROM_UID, TO_UID);
    expect(r).toBe(false);
  });
});
