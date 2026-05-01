'use strict';

const {
  isValidSection, calculateHealthScore, getLeadsSummary,
  buildDashboardSnapshot, getDashboardAlerts, formatDashboardForDisplay,
  DASHBOARD_SECTIONS, HEALTH_LEVELS,
  __setFirestoreForTests,
} = require('../core/owner_dashboard_builder');

const UID = 'testUid1234567890';

function makeMockDb({ contactDocs = [], anomalyDocs = [], throwGet = false } = {}) {
  const contactsSnap = { forEach: fn => contactDocs.forEach((d, i) => fn({ id: 'c' + i, data: () => d })) };
  const anomaliesSnap = { forEach: fn => anomalyDocs.forEach((d, i) => fn({ id: 'a' + i, data: () => d })) };
  return {
    collection: () => ({
      doc: () => ({
        collection: (name) => ({
          get: async () => {
            if (throwGet) throw new Error('get error');
            if (name === 'contacts') return contactsSnap;
            return anomaliesSnap;
          },
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return anomaliesSnap;
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('DASHBOARD_SECTIONS / HEALTH_LEVELS', () => {
  test('tiene secciones comunes', () => {
    expect(DASHBOARD_SECTIONS).toContain('summary');
    expect(DASHBOARD_SECTIONS).toContain('leads');
    expect(DASHBOARD_SECTIONS).toContain('growth');
  });
  test('DASHBOARD_SECTIONS es frozen', () => {
    expect(() => { DASHBOARD_SECTIONS.push('secret'); }).toThrow();
  });
  test('HEALTH_LEVELS tiene OK WARNING CRITICAL', () => {
    expect(HEALTH_LEVELS.OK).toBe('ok');
    expect(HEALTH_LEVELS.WARNING).toBe('warning');
    expect(HEALTH_LEVELS.CRITICAL).toBe('critical');
  });
});

describe('isValidSection', () => {
  test('true para secciones validas', () => {
    expect(isValidSection('summary')).toBe(true);
    expect(isValidSection('growth')).toBe(true);
  });
  test('false para seccion invalida', () => {
    expect(isValidSection('secrets')).toBe(false);
  });
});

describe('calculateHealthScore', () => {
  test('100 sin anomalias ni problemas', () => {
    const r = calculateHealthScore({ openAnomalies: 0, failedBroadcasts: 0, p95ResponseMs: 500, responseRate: 0.9 });
    expect(r.score).toBe(100);
    expect(r.level).toBe(HEALTH_LEVELS.OK);
  });
  test('nivel warning con anomalias moderadas', () => {
    const r = calculateHealthScore({ openAnomalies: 3, failedBroadcasts: 2, p95ResponseMs: 1500, responseRate: 0.7 });
    expect(r.level).toBe(HEALTH_LEVELS.WARNING);
  });
  test('nivel critical con muchos problemas', () => {
    const r = calculateHealthScore({ openAnomalies: 10, failedBroadcasts: 10, p95ResponseMs: 5000, responseRate: 0.2 });
    expect(r.level).toBe(HEALTH_LEVELS.CRITICAL);
    expect(r.score).toBeLessThan(50);
  });
  test('retorna critico para metrics undefined', () => {
    const r = calculateHealthScore(undefined);
    expect(r.level).toBe(HEALTH_LEVELS.CRITICAL);
  });
});

describe('getLeadsSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getLeadsSummary(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna conteo correcto', async () => {
    __setFirestoreForTests(makeMockDb({ contactDocs: [{}, {}, {}] }));
    const r = await getLeadsSummary(UID);
    expect(r.total).toBe(3);
  });
  test('fail-open retorna 0 si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getLeadsSummary(UID);
    expect(r.total).toBe(0);
  });
});

describe('buildDashboardSnapshot', () => {
  test('lanza si uid undefined', async () => {
    await expect(buildDashboardSnapshot(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si secciones invalidas', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(buildDashboardSnapshot(UID, ['secrets'])).rejects.toThrow('secciones invalidas');
  });
  test('retorna snapshot con generatedAt', async () => {
    __setFirestoreForTests(makeMockDb({ contactDocs: [{}, {}] }));
    const r = await buildDashboardSnapshot(UID, ['summary']);
    expect(r.uid).toBe(UID);
    expect(r.generatedAt).toBeDefined();
    expect(r.sections.summary).toBeDefined();
    expect(r.sections.summary.totalContacts).toBe(2);
  });
});

describe('getDashboardAlerts', () => {
  test('lanza si uid undefined', async () => {
    await expect(getDashboardAlerts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna alertas ordenadas por timestamp', async () => {
    const docs = [
      { type: 'new_device', severity: 'medium', timestamp: '2026-05-04T14:00:00Z' },
      { type: 'unusual_hour', severity: 'low', timestamp: '2026-05-04T10:00:00Z' },
    ];
    __setFirestoreForTests(makeMockDb({ anomalyDocs: docs }));
    const r = await getDashboardAlerts(UID);
    expect(r.length).toBe(2);
    expect(new Date(r[0].timestamp).getTime()).toBeGreaterThan(new Date(r[1].timestamp).getTime());
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getDashboardAlerts(UID);
    expect(r).toEqual([]);
  });
});

describe('formatDashboardForDisplay', () => {
  test('retorna null para snapshot undefined', () => {
    expect(formatDashboardForDisplay(undefined)).toBeNull();
  });
  test('formatea correctamente', () => {
    const snapshot = {
      uid: UID, generatedAt: new Date().toISOString(),
      sections: { summary: { totalContacts: 10 } },
    };
    const f = formatDashboardForDisplay(snapshot);
    expect(f.uid).toBe(UID);
    expect(f.hasSummary).toBe(true);
    expect(f.totalContacts).toBe(10);
    expect(f.sectionsCount).toBe(1);
  });
});
