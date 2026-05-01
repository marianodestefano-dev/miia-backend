'use strict';

const {
  buildReviewRequestMessage, shouldRequestReview, scheduleReviewRequest,
  markRequestSent, recordResponse, getPendingRequests,
  REQUEST_STATES, DEFAULT_MESSAGES, MIN_SCORE_FOR_REQUEST,
  COOLDOWN_DAYS, REQUEST_EXPIRY_DAYS,
  __setFirestoreForTests,
} = require('../core/review_requester');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;
  var phoneDocExists = opts.phoneDocExists || false;
  var phoneDocData = opts.phoneDocData || null;

  var innerPendingColl = {
    doc: function() {
      return {
        set: async function(data, setOpts) {
          if (throwSet) throw new Error('set error');
        },
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { exists: false, data: function() { return null; } };
        },
      };
    },
    where: function() {
      return {
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'doc' + i }); }); } };
        },
      };
    },
  };

  var innerByPhoneColl = {
    doc: function() {
      return {
        set: async function(data, setOpts) {
          if (throwSet) throw new Error('set error');
        },
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { exists: phoneDocExists, data: function() { return phoneDocData; } };
        },
      };
    },
  };

  var collMap = { pending: innerPendingColl, by_phone: innerByPhoneColl };
  var uidDoc = { collection: function(name) { return collMap[name] || innerPendingColl; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('buildReviewRequestMessage', function() {
  test('retorna mensaje en espanol por default', function() {
    expect(buildReviewRequestMessage()).toBe(DEFAULT_MESSAGES.es);
    expect(buildReviewRequestMessage('es')).toBe(DEFAULT_MESSAGES.es);
  });
  test('retorna mensaje en ingles', function() {
    expect(buildReviewRequestMessage('en')).toBe(DEFAULT_MESSAGES.en);
  });
  test('fallback a espanol para idioma desconocido', function() {
    expect(buildReviewRequestMessage('fr')).toBe(DEFAULT_MESSAGES.es);
  });
  test('customMessage tiene prioridad sobre idioma', function() {
    expect(buildReviewRequestMessage('es', 'Mensaje personalizado')).toBe('Mensaje personalizado');
  });
  test('customMessage vacio usa default', function() {
    const blank = '   ';
    expect(buildReviewRequestMessage('es', blank)).toBe(DEFAULT_MESSAGES.es);
  });
});

describe('REQUEST_STATES y constants', function() {
  test('tiene pending sent responded declined expired', function() {
    expect(REQUEST_STATES).toContain('pending');
    expect(REQUEST_STATES).toContain('sent');
    expect(REQUEST_STATES).toContain('responded');
    expect(REQUEST_STATES).toContain('declined');
    expect(REQUEST_STATES).toContain('expired');
  });
  test('frozen', function() { expect(function() { REQUEST_STATES[0] = 'x'; }).toThrow(); });
  test('MIN_SCORE_FOR_REQUEST es 30', function() { expect(MIN_SCORE_FOR_REQUEST).toBe(30); });
  test('COOLDOWN_DAYS es 90', function() { expect(COOLDOWN_DAYS).toBe(90); });
});

describe('shouldRequestReview', function() {
  test('lanza si uid undefined', async function() {
    await expect(shouldRequestReview(undefined, PHONE, 50)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(shouldRequestReview(UID, undefined, 50)).rejects.toThrow('phone requerido');
  });
  test('lanza si score no es numero', async function() {
    await expect(shouldRequestReview(UID, PHONE, 'alto')).rejects.toThrow('numero');
  });
  test('should false si score bajo', async function() {
    const r = await shouldRequestReview(UID, PHONE, 10);
    expect(r.should).toBe(false);
    expect(r.reason).toBe('score_too_low');
  });
  test('should true si score ok y sin cooldown', async function() {
    __setFirestoreForTests(makeMockDb({ phoneDocExists: false }));
    const r = await shouldRequestReview(UID, PHONE, 50);
    expect(r.should).toBe(true);
    expect(r.reason).toBe('eligible');
  });
  test('should false si en cooldown', async function() {
    var recent = new Date(Date.now() - 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ phoneDocExists: true, phoneDocData: { lastSentAt: recent } }));
    const r = await shouldRequestReview(UID, PHONE, 80);
    expect(r.should).toBe(false);
    expect(r.reason).toBe('in_cooldown');
  });
  test('fail-soft retorna should false si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await shouldRequestReview(UID, PHONE, 80);
    expect(r.should).toBe(false);
    expect(r.reason).toBe('error');
  });
});

describe('scheduleReviewRequest', function() {
  test('lanza si uid undefined', async function() {
    await expect(scheduleReviewRequest(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(scheduleReviewRequest(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna requestId y message', async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await scheduleReviewRequest(UID, PHONE);
    expect(r.requestId).toBeDefined();
    expect(r.message).toBeDefined();
    expect(r.scheduledAt).toBeDefined();
  });
  test('usa customMessage si se provee', async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await scheduleReviewRequest(UID, PHONE, { customMessage: 'mensaje custom' });
    expect(r.message).toBe('mensaje custom');
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(scheduleReviewRequest(UID, PHONE)).rejects.toThrow('set error');
  });
});

describe('markRequestSent', function() {
  test('lanza si uid undefined', async function() {
    await expect(markRequestSent(undefined, 'req1')).rejects.toThrow('uid requerido');
  });
  test('lanza si requestId undefined', async function() {
    await expect(markRequestSent(UID, undefined)).rejects.toThrow('requestId requerido');
  });
  test('marca sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(markRequestSent(UID, 'req1')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(markRequestSent(UID, 'req1')).rejects.toThrow('set error');
  });
});

describe('recordResponse', function() {
  test('lanza si uid undefined', async function() {
    await expect(recordResponse(undefined, 'req1', true)).rejects.toThrow('uid requerido');
  });
  test('lanza si requestId undefined', async function() {
    await expect(recordResponse(UID, undefined, true)).rejects.toThrow('requestId requerido');
  });
  test('retorna state responded', async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await recordResponse(UID, 'req1', true);
    expect(r.state).toBe('responded');
  });
  test('retorna state declined', async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await recordResponse(UID, 'req1', false);
    expect(r.state).toBe('declined');
  });
});

describe('getPendingRequests', function() {
  test('lanza si uid undefined', async function() {
    await expect(getPendingRequests(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay pendientes', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getPendingRequests(UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna array vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getPendingRequests(UID);
    expect(r).toEqual([]);
  });
});
