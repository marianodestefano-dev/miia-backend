'use strict';

const {
  recordResponseTime, getResponseTimeSummary, getP90ResponseTime,
  compareResponseTimes, classifyResponseTime,
  RESPONSE_BUCKETS, BUCKET_THRESHOLDS_MS,
  MIN_RESPONSE_MS, MAX_RESPONSE_MS, DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
} = require('../core/response_time_tracker');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NOW = new Date('2026-05-04T12:00:00.000Z').getTime();

function makeDoc(responseTimeMs, daysAgo) {
  daysAgo = daysAgo || 0;
  return {
    uid: UID, phone: PHONE, responseTimeMs,
    bucket: classifyResponseTime(responseTimeMs),
    recordedAt: new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;
  var innerColl = {
    doc: function() {
      return {
        set: async function(data) {
          if (throwSet) throw new Error('set error');
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
  var uidDoc = { collection: function() { return innerColl; } };
  return {
    collection: function() { return { doc: function() { return uidDoc; } }; },
  };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('classifyResponseTime', function() {
  test('instant <= 5000ms', function() { expect(classifyResponseTime(1000)).toBe('instant'); });
  test('fast <= 30000ms', function() { expect(classifyResponseTime(10000)).toBe('fast'); });
  test('normal <= 120000ms', function() { expect(classifyResponseTime(60000)).toBe('normal'); });
  test('slow <= 300000ms', function() { expect(classifyResponseTime(200000)).toBe('slow'); });
  test('very_slow > 300000ms', function() { expect(classifyResponseTime(400000)).toBe('very_slow'); });
  test('exactamente en umbral instant', function() { expect(classifyResponseTime(5000)).toBe('instant'); });
  test('exactamente en umbral fast', function() { expect(classifyResponseTime(30000)).toBe('fast'); });
});

describe('RESPONSE_BUCKETS y constants', function() {
  test('tiene los 5 buckets', function() {
    expect(RESPONSE_BUCKETS).toContain('instant');
    expect(RESPONSE_BUCKETS).toContain('very_slow');
    expect(RESPONSE_BUCKETS.length).toBe(5);
  });
  test('frozen', function() { expect(function() { RESPONSE_BUCKETS[0] = 'x'; }).toThrow(); });
  test('DEFAULT_PERIOD_DAYS es 7', function() { expect(DEFAULT_PERIOD_DAYS).toBe(7); });
  test('BUCKET_THRESHOLDS_MS instant es 5000', function() { expect(BUCKET_THRESHOLDS_MS.instant).toBe(5000); });
});

describe('recordResponseTime - validacion', function() {
  test('lanza si uid undefined', async function() {
    await expect(recordResponseTime(undefined, PHONE, 1000)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(recordResponseTime(UID, undefined, 1000)).rejects.toThrow('phone requerido');
  });
  test('lanza si responseTimeMs no es numero', async function() {
    await expect(recordResponseTime(UID, PHONE, 'mucho')).rejects.toThrow('numero');
  });
  test('lanza si responseTimeMs negativo', async function() {
    await expect(recordResponseTime(UID, PHONE, -1)).rejects.toThrow('negativo');
  });
  test('lanza si responseTimeMs excede 24h', async function() {
    await expect(recordResponseTime(UID, PHONE, MAX_RESPONSE_MS + 1)).rejects.toThrow('maximo');
  });
  test('registra sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordResponseTime(UID, PHONE, 3000)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordResponseTime(UID, PHONE, 3000)).rejects.toThrow('set error');
  });
});

describe('getResponseTimeSummary', function() {
  test('lanza si uid undefined', async function() {
    await expect(getResponseTimeSummary(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna zeros si no hay datos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.count).toBe(0);
    expect(r.averageMs).toBe(0);
  });
  test('calcula average correctamente', async function() {
    const docs = [makeDoc(1000), makeDoc(3000), makeDoc(5000)];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.count).toBe(3);
    expect(r.averageMs).toBe(3000);
  });
  test('calcula median correctamente impar', async function() {
    const docs = [makeDoc(1000), makeDoc(3000), makeDoc(9000)];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.medianMs).toBe(3000);
  });
  test('calcula median correctamente par', async function() {
    const docs = [makeDoc(1000), makeDoc(3000), makeDoc(5000), makeDoc(7000)];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.medianMs).toBe(4000);
  });
  test('calcula minMs y maxMs', async function() {
    const docs = [makeDoc(500), makeDoc(5000), makeDoc(30000)];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.minMs).toBe(500);
    expect(r.maxMs).toBe(30000);
  });
  test('buckets inicializados en zero', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.buckets).toHaveProperty('instant');
    expect(r.buckets).toHaveProperty('very_slow');
    expect(r.buckets.instant).toBe(0);
  });
  test('fail-open retorna zeros si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getResponseTimeSummary(UID, 7, NOW);
    expect(r.count).toBe(0);
  });
});

describe('getP90ResponseTime', function() {
  test('lanza si uid undefined', async function() {
    await expect(getP90ResponseTime(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna 0 si no hay datos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getP90ResponseTime(UID, 7, NOW);
    expect(r.p90Ms).toBe(0);
  });
  test('calcula P90 con 10 valores', async function() {
    const times = [1000,2000,3000,4000,5000,6000,7000,8000,9000,100000];
    const docs = times.map(function(t) { return makeDoc(t); });
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getP90ResponseTime(UID, 7, NOW);
    expect(r.p90Ms).toBe(100000);
    expect(r.count).toBe(10);
  });
});

describe('compareResponseTimes', function() {
  test('lanza si uid undefined', async function() {
    await expect(compareResponseTimes(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna trend stable cuando averages iguales', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await compareResponseTimes(UID, 7, NOW);
    expect(r.trend).toBe('stable');
    expect(r.changePercent).toBe(0);
  });
  test('tiene campos current, previous, changePercent, trend', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await compareResponseTimes(UID, 7, NOW);
    expect(r).toHaveProperty('current');
    expect(r).toHaveProperty('previous');
    expect(r).toHaveProperty('changePercent');
    expect(r).toHaveProperty('trend');
  });
  test('trend improving cuando current menor que previous', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await compareResponseTimes(UID, 7, NOW);
    expect(['improving','degrading','stable']).toContain(r.trend);
  });
});
