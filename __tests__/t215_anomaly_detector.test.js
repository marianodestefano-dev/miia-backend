'use strict';

const {
  isUnusualHour, classifyAnomaly, recordAnomaly,
  getOpenAnomalies, resolveAnomaly, checkFailedLogins,
  ANOMALY_TYPES, SEVERITY, MAX_FAILED_LOGINS,
  UNUSUAL_HOUR_START, UNUSUAL_HOUR_END,
  __setFirestoreForTests,
} = require('../core/anomaly_detector');

const UID = 'testUid1234567890';

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  const snap = {
    forEach: fn => docs.forEach((d, i) => fn({ id: 'anom' + i, data: () => d })),
  };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async () => { if (throwSet) throw new Error('set error'); },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return snap;
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('ANOMALY_TYPES / SEVERITY / consts', () => {
  test('tiene tipos de anomalia comunes', () => {
    expect(ANOMALY_TYPES).toContain('multiple_failed_logins');
    expect(ANOMALY_TYPES).toContain('new_device');
    expect(ANOMALY_TYPES).toContain('api_key_multiple_rotations');
  });
  test('ANOMALY_TYPES es frozen', () => {
    expect(() => { ANOMALY_TYPES.push('nuevo'); }).toThrow();
  });
  test('SEVERITY tiene los niveles', () => {
    expect(SEVERITY.LOW).toBe('low');
    expect(SEVERITY.CRITICAL).toBe('critical');
  });
  test('MAX_FAILED_LOGINS es 5', () => {
    expect(MAX_FAILED_LOGINS).toBe(5);
  });
});

describe('isUnusualHour', () => {
  test('detecta hora inusual (3am UTC)', () => {
    const ts = new Date('2026-05-04T03:00:00.000Z').getTime();
    expect(isUnusualHour(ts)).toBe(true);
  });
  test('no detecta hora normal (14pm UTC)', () => {
    const ts = new Date('2026-05-04T14:00:00.000Z').getTime();
    expect(isUnusualHour(ts)).toBe(false);
  });
  test('medianoche es inusual', () => {
    const ts = new Date('2026-05-04T00:00:00.000Z').getTime();
    expect(isUnusualHour(ts)).toBe(true);
  });
});

describe('classifyAnomaly', () => {
  test('lanza si type invalido', () => {
    expect(() => classifyAnomaly('hackear')).toThrow('type invalido');
  });
  test('failed logins retorna HIGH/CRITICAL segun count', () => {
    const r1 = classifyAnomaly('multiple_failed_logins', { count: 5 });
    expect(r1.severity).toBe(SEVERITY.HIGH);
    const r2 = classifyAnomaly('multiple_failed_logins', { count: MAX_FAILED_LOGINS * 2 });
    expect(r2.severity).toBe(SEVERITY.CRITICAL);
  });
  test('api_key_multiple_rotations es CRITICAL', () => {
    const r = classifyAnomaly('api_key_multiple_rotations', {});
    expect(r.severity).toBe(SEVERITY.CRITICAL);
  });
  test('unusual_hour es LOW', () => {
    const r = classifyAnomaly('unusual_hour', {});
    expect(r.severity).toBe(SEVERITY.LOW);
  });
});

describe('recordAnomaly', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordAnomaly(undefined, 'new_device')).rejects.toThrow('uid requerido');
  });
  test('lanza si type invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordAnomaly(UID, 'malo')).rejects.toThrow('type invalido');
  });
  test('retorna anomalyId y severity', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await recordAnomaly(UID, 'new_device', {});
    expect(r.anomalyId).toBeDefined();
    expect(r.severity).toBe(SEVERITY.MEDIUM);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordAnomaly(UID, 'new_device')).rejects.toThrow('set error');
  });
});

describe('getOpenAnomalies', () => {
  test('lanza si uid undefined', async () => {
    await expect(getOpenAnomalies(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna lista de anomalias abiertas', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [{ type: 'new_device', resolved: false, timestamp: new Date().toISOString() }] }));
    const r = await getOpenAnomalies(UID);
    expect(r.length).toBe(1);
    expect(r[0].anomalyId).toBeDefined();
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getOpenAnomalies(UID);
    expect(r).toEqual([]);
  });
});

describe('resolveAnomaly', () => {
  test('lanza si uid undefined', async () => {
    await expect(resolveAnomaly(undefined, 'anom1')).rejects.toThrow('uid requerido');
  });
  test('lanza si anomalyId undefined', async () => {
    await expect(resolveAnomaly(UID, undefined)).rejects.toThrow('anomalyId requerido');
  });
  test('resuelve sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(resolveAnomaly(UID, 'anom1')).resolves.toBeUndefined();
  });
});

describe('checkFailedLogins', () => {
  test('lanza si uid undefined', async () => {
    await expect(checkFailedLogins(undefined, 3)).rejects.toThrow('uid requerido');
  });
  test('lanza si recentCount no es numero', async () => {
    await expect(checkFailedLogins(UID, 'mucho')).rejects.toThrow('numero');
  });
  test('retorna null si bajo el limite', async () => {
    const r = await checkFailedLogins(UID, MAX_FAILED_LOGINS - 1);
    expect(r).toBeNull();
  });
  test('registra anomalia si supera el limite', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await checkFailedLogins(UID, MAX_FAILED_LOGINS + 1);
    expect(r).not.toBeNull();
    expect(r.anomalyId).toBeDefined();
  });
});
