'use strict';
const { buildConsentSummary, getConsentTrend, getConsentAnalytics, CONSENT_STATES, __setFirestoreForTests } = require('../core/consent_analytics');

const UID = 'consentAnalyticsUid1234';
const NOW = Date.now();

function makeMockDb({ consentMap = {}, throwGet = false } = {}) {
  return {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
      get: async () => {
        if (throwGet) throw new Error('get failed');
        return Object.keys(consentMap).length > 0
          ? { exists: true, data: () => ({ consentMap }) }
          : { exists: false };
      }
    }) }) }) })
  };
}

afterEach(() => __setFirestoreForTests(null));

describe('CONSENT_STATES', () => {
  test('contiene granted/revoked/pending/unknown', () => {
    expect(CONSENT_STATES).toContain('granted');
    expect(CONSENT_STATES).toContain('revoked');
    expect(CONSENT_STATES).toContain('pending');
    expect(CONSENT_STATES).toContain('unknown');
  });
});

describe('buildConsentSummary — validacion', () => {
  test('lanza si uid falta', () => {
    expect(() => buildConsentSummary(null)).toThrow('uid requerido');
  });
  test('mapa vacio retorna total=0', () => {
    const r = buildConsentSummary(UID, {});
    expect(r.total).toBe(0);
    expect(r.granted).toBe(0);
    expect(r.grantRate).toBe(0);
  });
});

describe('buildConsentSummary — conteos', () => {
  const map = {
    '+1': { status: 'granted' },
    '+2': { status: 'granted' },
    '+3': { status: 'revoked' },
    '+4': { status: 'pending' },
    '+5': { status: 'invalido' },
    '+6': null,
  };

  test('cuenta correctamente', () => {
    const r = buildConsentSummary(UID, map);
    expect(r.total).toBe(6);
    expect(r.granted).toBe(2);
    expect(r.revoked).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.unknown).toBe(2); // invalido + null
  });
  test('grantRate correcto', () => {
    const r = buildConsentSummary(UID, map);
    expect(r.grantRate).toBeCloseTo(2/6, 2);
  });
  test('revokeRate correcto', () => {
    const r = buildConsentSummary(UID, map);
    expect(r.revokeRate).toBeCloseTo(1/6, 2);
  });
  test('retorna generatedAt string', () => {
    const r = buildConsentSummary(UID, map);
    expect(typeof r.generatedAt).toBe('string');
  });
});

describe('getConsentTrend', () => {
  test('mapa vacio retorna 0 en todo', () => {
    const r = getConsentTrend({});
    expect(r.recentGrants).toBe(0);
    expect(r.recentRevokes).toBe(0);
  });
  test('cuenta grants recientes', () => {
    const map = {
      '+1': { status: 'granted', grantedAt: new Date(NOW - 5 * 86400000).toISOString() },
      '+2': { status: 'granted', grantedAt: new Date(NOW - 60 * 86400000).toISOString() },
    };
    const r = getConsentTrend(map, 30, NOW);
    expect(r.recentGrants).toBe(1);
  });
  test('cuenta revokes recientes', () => {
    const map = {
      '+1': { status: 'revoked', revokedAt: new Date(NOW - 3 * 86400000).toISOString() },
    };
    const r = getConsentTrend(map, 30, NOW);
    expect(r.recentRevokes).toBe(1);
  });
  test('retorna days correcto', () => {
    expect(getConsentTrend({}, 7, NOW).days).toBe(7);
  });
});

describe('getConsentAnalytics', () => {
  test('lanza si uid falta', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getConsentAnalytics(null)).rejects.toThrow('uid requerido');
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getConsentAnalytics(UID);
    expect(r.total).toBe(0);
    expect(r.uid).toBe(UID);
  });
  test('retorna summary + trend', async () => {
    const consentMap = { '+1': { status: 'granted', grantedAt: new Date().toISOString() } };
    __setFirestoreForTests(makeMockDb({ consentMap }));
    const r = await getConsentAnalytics(UID);
    expect(r.granted).toBe(1);
    expect(r.trend).toBeDefined();
    expect(typeof r.trend.recentGrants).toBe('number');
  });
});
