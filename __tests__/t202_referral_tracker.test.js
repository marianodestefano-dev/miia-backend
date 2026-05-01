'use strict';

const {
  trackReferralEvent, getReferralStatus, getReferralHistory,
  getConversionStats, getNextSuggestedStage,
  LEAD_STAGES, DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
} = require('../core/referral_tracker');

const UID = 'testUid1234567890';
const REF_ID = 'ref_abc123';
const PHONE = '+541155667788';

function makeMockDb(opts) {
  opts = opts || {};
  var statusDoc = opts.statusDoc || null;
  var historyDocs = opts.historyDocs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var innerEventsDoc = {
    set: async function(data) { if (throwSet) throw new Error('set error'); },
  };

  var eventsColl = {
    doc: function() { return innerEventsDoc; },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { forEach: function(fn) { historyDocs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'e' + i }); }); } };
    },
  };

  var statusDocObj = {
    set: async function(data, setOpts) { if (throwSet) throw new Error('set error'); },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { exists: !!statusDoc, data: function() { return statusDoc; } };
    },
    collection: function() { return eventsColl; },
  };

  return { collection: function() { return { doc: function() { return statusDocObj; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('LEAD_STAGES y constants', function() {
  test('tiene referred contacted converted lost', function() {
    expect(LEAD_STAGES).toContain('referred');
    expect(LEAD_STAGES).toContain('contacted');
    expect(LEAD_STAGES).toContain('converted');
    expect(LEAD_STAGES).toContain('lost');
  });
  test('frozen', function() { expect(function() { LEAD_STAGES[0] = 'x'; }).toThrow(); });
  test('DEFAULT_PERIOD_DAYS es 30', function() { expect(DEFAULT_PERIOD_DAYS).toBe(30); });
});

describe('getNextSuggestedStage', function() {
  test('retorna siguiente etapa despues de referred', function() {
    var next = getNextSuggestedStage('referred');
    expect(next).toBe('contacted');
  });
  test('retorna null si stage es lost', function() {
    expect(getNextSuggestedStage('lost')).toBeNull();
  });
  test('retorna null si stage invalido', function() {
    expect(getNextSuggestedStage('etapa_rara')).toBeNull();
  });
});

describe('trackReferralEvent', function() {
  test('lanza si referralId undefined', async function() {
    await expect(trackReferralEvent(undefined, PHONE, 'referred')).rejects.toThrow('referralId requerido');
  });
  test('lanza si leadPhone undefined', async function() {
    await expect(trackReferralEvent(REF_ID, undefined, 'referred')).rejects.toThrow('leadPhone requerido');
  });
  test('lanza si stage invalido', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(trackReferralEvent(REF_ID, PHONE, 'etapa_rara')).rejects.toThrow('invalido');
  });
  test('registra sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(trackReferralEvent(REF_ID, PHONE, 'referred')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(trackReferralEvent(REF_ID, PHONE, 'referred')).rejects.toThrow('set error');
  });
});

describe('getReferralStatus', function() {
  test('lanza si referralId undefined', async function() {
    await expect(getReferralStatus(undefined)).rejects.toThrow('referralId requerido');
  });
  test('retorna null si no existe', async function() {
    __setFirestoreForTests(makeMockDb({ statusDoc: null }));
    var r = await getReferralStatus(REF_ID);
    expect(r).toBeNull();
  });
  test('retorna status si existe', async function() {
    var doc = { referralId: REF_ID, currentStage: 'interested' };
    __setFirestoreForTests(makeMockDb({ statusDoc: doc }));
    var r = await getReferralStatus(REF_ID);
    expect(r.currentStage).toBe('interested');
  });
  test('fail-open retorna null si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getReferralStatus(REF_ID);
    expect(r).toBeNull();
  });
});

describe('getReferralHistory', function() {
  test('lanza si referralId undefined', async function() {
    await expect(getReferralHistory(undefined)).rejects.toThrow('referralId requerido');
  });
  test('retorna array vacio si no hay eventos', async function() {
    __setFirestoreForTests(makeMockDb({ historyDocs: [] }));
    var r = await getReferralHistory(REF_ID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getReferralHistory(REF_ID);
    expect(r).toEqual([]);
  });
});

describe('getConversionStats', function() {
  test('lanza si uid undefined', async function() {
    await expect(getConversionStats(undefined, [])).rejects.toThrow('uid requerido');
  });
  test('lanza si referralIds no es array', async function() {
    await expect(getConversionStats(UID, 'no-array')).rejects.toThrow('array');
  });
  test('retorna zeros si array vacio', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await getConversionStats(UID, []);
    expect(r.total).toBe(0);
    expect(r.conversionRate).toBe(0);
  });
  test('calcula conversion correctamente', async function() {
    var converted = { referralId: 'r1', currentStage: 'converted' };
    __setFirestoreForTests(makeMockDb({ statusDoc: converted }));
    var r = await getConversionStats(UID, ['r1']);
    expect(r.total).toBe(1);
    expect(r.converted).toBe(1);
    expect(r.conversionRate).toBe(100);
  });
});
