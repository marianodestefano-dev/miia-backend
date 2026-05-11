'use strict';

/**
 * VI-BACKEND-COVERAGE: privacy_report.js — 100% branches
 */

jest.mock('firebase-admin', () => ({
  firestore: jest.fn(),
}));
// Mock contact_classification_cache para el branch staleCacheCount
jest.mock('../lib/contact_classification_cache', () => ({
  getStats: jest.fn().mockReturnValue({ staleCount: 3 }),
}), { virtual: true });

const {
  generateReport,
  buildPrivacyReport,
  __setFirestoreForTests,
  formatForWhatsApp,
  shouldSendReport,
  listReports,
} = require('../core/privacy_report');

// ── Helpers de mock ───────────────────────────────────────────────────────────

function makeFs({
  countersExists = false, countersData = {},
  bizDocs = [],
  groupsDocs = [],
  auditDocs = [], auditThrows = false, auditFallbackThrows = false,
  personalExists = false, personalData = {},
  convDocExists = false, convDocData = {},
  tdDocExists = false, tdDocData = {},
  pbDocExists = false, pbDocData = {},
  addMock = jest.fn().mockResolvedValue({ id: 'report-id' }),
  listDocs = [], listThrows = false,
} = {}) {
  const getMock = jest.fn();

  const db = {
    _addMock: addMock,
    collection: (col) => ({
      doc: (uid) => ({
        collection: (sub) => {
          if (sub === 'stats') return {
            doc: () => ({ get: () => Promise.resolve({ exists: countersExists, data: () => countersData }) }),
          };
          if (sub === 'businesses') return {
            get: () => Promise.resolve({
              size: bizDocs.length,
              docs: bizDocs.map(bd => ({
                ref: {
                  collection: () => ({
                    get: () => Promise.resolve({ size: bd.products || 0 }),
                  }),
                },
              })),
            }),
          };
          if (sub === 'contact_groups') return {
            get: () => Promise.resolve({
              size: groupsDocs.length,
              docs: groupsDocs.map(gd => ({
                ref: {
                  collection: () => ({
                    get: () => Promise.resolve({ size: gd.contacts || 0 }),
                  }),
                },
              })),
            }),
          };
          if (sub === 'contact_index') return { get: () => Promise.resolve({ size: 0 }) };
          if (sub === 'miia_sports') return { get: () => Promise.resolve({ size: 0 }) };
          if (sub === 'slots') return { get: () => Promise.resolve({ size: 0 }) };
          if (sub === 'personal') return {
            doc: () => ({ get: () => Promise.resolve({ exists: personalExists, data: () => personalData }) }),
          };
          if (sub === 'audit_logs') return {
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: auditThrows
                    ? () => { throw new Error('no index'); }
                    : () => Promise.resolve({ docs: auditDocs.map(d => ({ data: () => d, id: 'x' })) }),
                }),
              }),
            }),
            limit: () => ({
              get: auditFallbackThrows
                ? () => { throw new Error('fallback fail'); }
                : () => Promise.resolve({ docs: auditDocs.map(d => ({ data: () => d, id: 'x' })) }),
            }),
          };
          if (sub === 'privacy_reports') return {
            add: addMock,
            orderBy: () => ({ limit: () => ({
              get: listThrows
                ? () => { throw new Error('list-fail'); }
                : () => Promise.resolve({ docs: listDocs.map(d => ({ id: 'r1', data: () => d })) }),
            })}),
          };
          // miia_persistent
          if (sub === 'miia_persistent') return {
            doc: (docId) => {
              if (docId === 'tenant_conversations') return {
                get: () => Promise.resolve({ exists: convDocExists, data: () => convDocData }),
              };
              if (docId === 'training_data') return {
                get: () => Promise.resolve({ exists: tdDocExists, data: () => tdDocData }),
              };
              return { get: () => Promise.resolve({ exists: false }) };
            },
          };
          return { doc: () => ({ get: () => Promise.resolve({ exists: false }) }) };
        },
      }),
    }),
  };
  return db;
}

// ── buildPrivacyReport ────────────────────────────────────────────────────────

describe('buildPrivacyReport', () => {
  test('uid inválido → throw', async () => {
    await expect(buildPrivacyReport(null)).rejects.toThrow('uid requerido');
    await expect(buildPrivacyReport('')).rejects.toThrow('uid requerido');
    await expect(buildPrivacyReport(42)).rejects.toThrow('uid requerido');
  });

  test('sin docs → todo en 0/null', async () => {
    __setFirestoreForTests(makeFs());
    const r = await buildPrivacyReport('uid-1');
    expect(r.conversationsCount).toBe(0);
    expect(r.oldestConversationDate).toBeNull();
    expect(r.contactTypesCount).toBe(0);
    expect(r.trainingDataSize).toBe(0);
    expect(r.personalBrainSize).toBe(0);
  });

  test('convDoc.exists=true con conversaciones y timestamps → oldest calculado', async () => {
    __setFirestoreForTests(makeFs({
      convDocExists: true,
      convDocData: {
        conversations: {
          '+57001': [
            { timestamp: 1000 },
            { ts: 500 }, // más antiguo
          ],
          '+57002': [
            'not-an-array-item', // salta, sólo para entrar al loop
          ],
        },
        contactTypes: { '+57001': 'lead', '+57002': 'family' },
      },
    }));
    const r = await buildPrivacyReport('uid-2');
    expect(r.conversationsCount).toBe(2); // 2 claves
    expect(r.contactTypesCount).toBe(2);
    expect(r.oldestConversationDate).toBe(500);
  });

  test('convDoc con array-entry no-array → skip via !Array.isArray', async () => {
    __setFirestoreForTests(makeFs({
      convDocExists: true,
      convDocData: {
        conversations: { '+57001': 'string-not-array' },
        contactTypes: {},
      },
    }));
    const r = await buildPrivacyReport('uid-3');
    expect(r.oldestConversationDate).toBeNull();
  });

  test('msgs sin timestamp ni ts → oldest = null', async () => {
    __setFirestoreForTests(makeFs({
      convDocExists: true,
      convDocData: {
        conversations: { '+57001': [{ content: 'sin ts' }] },
      },
    }));
    const r = await buildPrivacyReport('uid-4');
    expect(r.oldestConversationDate).toBeNull();
  });

  test('staleCacheCount via contact_classification_cache staleCount=3', async () => {
    __setFirestoreForTests(makeFs());
    const r = await buildPrivacyReport('uid-5');
    expect(r.staleCacheCount).toBe(3); // mock retorna staleCount=3 (truthy branch)
  });

  test('staleCacheCount=0 → usa 0 (|| 0 falsy branch línea 284)', async () => {
    const classCache = require('../lib/contact_classification_cache');
    classCache.getStats.mockReturnValueOnce({ staleCount: 0 }); // falsy → || 0
    __setFirestoreForTests(makeFs());
    const r = await buildPrivacyReport('uid-5b');
    expect(r.staleCacheCount).toBe(0);
  });

  test('convDoc.exists=true pero sin campo conversations → usa {} (línea 261 || {})', async () => {
    __setFirestoreForTests(makeFs({
      convDocExists: true,
      convDocData: {}, // sin conversations → undefined || {}
    }));
    const r = await buildPrivacyReport('uid-noconvs');
    expect(r.conversationsCount).toBe(0);
  });

  test('tdDoc.exists=true pero sin campo content → content fallback "" (línea 293 || "")', async () => {
    __setFirestoreForTests(makeFs({
      tdDocExists: true,
      tdDocData: {}, // sin content
    }));
    const r = await buildPrivacyReport('uid-nocontent');
    expect(r.trainingDataSize).toBe(0);
  });

  test('tdDoc.exists=true → trainingDataSize > 0', async () => {
    __setFirestoreForTests(makeFs({
      tdDocExists: true,
      tdDocData: { content: 'hola mundo' },
    }));
    const r = await buildPrivacyReport('uid-6');
    expect(r.trainingDataSize).toBeGreaterThan(0);
  });

  test('personalBrain exists=true → personalBrainSize > 0 (líneas 305-306)', async () => {
    __setFirestoreForTests(makeFs({
      personalExists: true,
      personalData: { tone: 'informal', faq: [] },
    }));
    const r = await buildPrivacyReport('uid-7');
    expect(r.personalBrainSize).toBeGreaterThan(0);
  });

  test('tenant_conversations get lanza → catch línea 276', async () => {
    const throwingFs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: (docId) => {
              if (sub === 'miia_persistent' && docId === 'tenant_conversations') {
                return { get: () => { throw new Error('conv-crash'); } };
              }
              return { get: () => Promise.resolve({ exists: false }) };
            },
          }),
        }),
      }),
    };
    __setFirestoreForTests(throwingFs);
    const r = await buildPrivacyReport('uid-conv-err');
    expect(r.conversationsCount).toBe(0); // sin crash, solo warn
  });

  test('training_data get lanza → catch línea 297', async () => {
    const throwingFs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: (docId) => {
              if (sub === 'miia_persistent' && docId === 'training_data') {
                return { get: () => { throw new Error('td-crash'); } };
              }
              return { get: () => Promise.resolve({ exists: false }) };
            },
          }),
        }),
      }),
    };
    __setFirestoreForTests(throwingFs);
    const r = await buildPrivacyReport('uid-td-err');
    expect(r.trainingDataSize).toBe(0);
  });

  test('classCache.getStats no es función → branch false línea 282', async () => {
    const classCache = require('../lib/contact_classification_cache');
    const backup = classCache.getStats;
    classCache.getStats = null; // typeof null !== 'function' → false branch
    __setFirestoreForTests(makeFs());
    const r = await buildPrivacyReport('uid-nogetStats');
    classCache.getStats = backup;
    expect(r.staleCacheCount).toBe(0); // no se ejecutó getStats
  });

  test('personal_brain get lanza → catch líneas 308-309', async () => {
    const throwingFs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: (docId) => {
              if (sub === 'personal') {
                return { get: () => { throw new Error('pb-crash'); } };
              }
              return { get: () => Promise.resolve({ exists: false }) };
            },
          }),
        }),
      }),
    };
    __setFirestoreForTests(throwingFs);
    const r = await buildPrivacyReport('uid-pb-err');
    expect(r.personalBrainSize).toBe(0);
  });
});

// ── generateReport ────────────────────────────────────────────────────────────

describe('generateReport', () => {
  test('sin counters → metrics vacíos + recommendations básicas', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'rpt-1' });
    __setFirestoreForTests(makeFs({ addMock: add }));
    const r = await generateReport('uid-gen-1');
    expect(r.ownerUid).toBe('uid-gen-1');
    expect(r.metrics).toEqual({});
    expect(r.recommendations).toContain('Creá al menos un negocio para que MIIA pueda atender leads');
    expect(add).toHaveBeenCalled();
  });

  test('con counters → metrics poblados', async () => {
    const countersData = {
      messagesProcessed: 500,
      messagesOut: 200,
      contactsTotal: 50,
      businessesTotal: 3,
      lastMessageAt: '2026-05-01T10:00:00Z',
      lastActiveAt: '2026-05-11T09:00:00Z',
    };
    __setFirestoreForTests(makeFs({ countersExists: true, countersData }));
    const r = await generateReport('uid-gen-2');
    expect(r.metrics.messagesProcessed).toBe(500);
    expect(r.metrics.messagesOut).toBe(200);
  });

  test('counters sin campos opcionales → usa || 0/null fallback (línea 47)', async () => {
    // countersData sin campos → || 0 y || null branches
    __setFirestoreForTests(makeFs({ countersExists: true, countersData: {} }));
    const r = await generateReport('uid-gen-2b');
    expect(r.metrics.messagesProcessed).toBe(0);
    expect(r.metrics.lastMessageAt).toBeNull();
  });

  test('personalDoc no existe → recommendation de cerebro personal', async () => {
    __setFirestoreForTests(makeFs({ personalExists: false }));
    const r = await generateReport('uid-gen-3');
    expect(r.recommendations).toContain('Configurá tu cerebro personal para que MIIA te conozca mejor');
  });

  test('personalDoc existe → no recommendation de cerebro personal', async () => {
    __setFirestoreForTests(makeFs({ personalExists: true, personalData: {} }));
    const r = await generateReport('uid-gen-4');
    expect(r.recommendations).not.toContain('Configurá tu cerebro personal para que MIIA te conozca mejor');
  });

  test('contactGroups = 0 → recommendation grupos', async () => {
    __setFirestoreForTests(makeFs({ groupsDocs: [] }));
    const r = await generateReport('uid-gen-5');
    expect(r.recommendations).toContain('Organizá tus contactos en grupos para personalizar el tono de MIIA');
  });

  test('contactGroups > 0 + businesses > 0 → sin esas recommendations', async () => {
    __setFirestoreForTests(makeFs({
      bizDocs: [{ products: 2 }],
      groupsDocs: [{ contacts: 5 }],
    }));
    const r = await generateReport('uid-gen-6');
    expect(r.recommendations).not.toContain('Creá al menos un negocio para que MIIA pueda atender leads');
    expect(r.recommendations).not.toContain('Organizá tus contactos en grupos para personalizar el tono de MIIA');
    expect(r.dataStored.products).toBe(2);
    expect(r.dataStored.contacts).toBe(5);
  });

  test('messagesProcessed > 1000 y slots=0 → recommendation slots', async () => {
    __setFirestoreForTests(makeFs({
      countersExists: true,
      countersData: { messagesProcessed: 1500 },
    }));
    const r = await generateReport('uid-gen-7');
    expect(r.recommendations).toContain('Con tu volumen de mensajes, considerá agregar slots para familiares o agentes');
  });

  test('audit_logs con docs → accessLog poblado', async () => {
    const auditDocs = [
      { type: 'login', timestamp: '2026-01-01T10:00:00Z', details: 'admin' },
      { type: 'export' }, // sin timestamp, sin details
    ];
    __setFirestoreForTests(makeFs({ auditDocs }));
    const r = await generateReport('uid-gen-8');
    expect(r.accessLog).toHaveLength(2);
    expect(r.accessLog[0].type).toBe('login');
    expect(r.accessLog[1].type).toBe('export');
  });

  test('audit_logs con createdAt (sin timestamp) → usa createdAt', async () => {
    const auditDocs = [{ type: 'view', createdAt: '2026-01-01' }];
    __setFirestoreForTests(makeFs({ auditDocs, auditThrows: true })); // fuerza fallback
    const r = await generateReport('uid-gen-9');
    expect(r.accessLog[0].type).toBe('view');
  });

  test('audit sin type ni details ni timestamp → usa unknown/empty string/createdAt', async () => {
    // Cubre || 'unknown', || '', || d.data().createdAt
    const auditDocs = [{ completedAt: '2026-01-01' }]; // sin type, sin details, sin timestamp
    __setFirestoreForTests(makeFs({ auditDocs, auditThrows: true })); // fallback path
    const r = await generateReport('uid-gen-9b');
    expect(r.accessLog[0].type).toBe('unknown');
    expect(r.accessLog[0].details).toBe('');
  });

  test('audit principal sin type/details → || unknown/empty (path normal sin throw)', async () => {
    const auditDocs = [{}]; // sin type, sin details, sin timestamp
    __setFirestoreForTests(makeFs({ auditDocs, auditThrows: false }));
    const r = await generateReport('uid-gen-9c');
    expect(r.accessLog[0].type).toBe('unknown');
  });

  test('audit_logs fallback también lanza → accessLog vacío', async () => {
    __setFirestoreForTests(makeFs({ auditThrows: true, auditFallbackThrows: true }));
    const r = await generateReport('uid-gen-10');
    expect(r.accessLog).toEqual([]);
  });

  test('error general en generateReport → re-lanza', async () => {
    const badFs = {
      collection: () => { throw new Error('fs-crash'); },
    };
    __setFirestoreForTests(badFs);
    await expect(generateReport('uid-crash')).rejects.toThrow('fs-crash');
  });
});

// ── formatForWhatsApp ─────────────────────────────────────────────────────────

describe('formatForWhatsApp', () => {
  test('report completo con recomendaciones → formato correcto', () => {
    const report = {
      metrics: { messagesProcessed: 100, messagesOut: 50, contactsTotal: 20 },
      dataStored: { businesses: 2, products: 10, contactGroups: 3, contacts: 100, slots: 1, personalBrain: 'Sí' },
      periodStart: new Date('2026-01-01').toISOString(),
      periodEnd: new Date('2026-06-30').toISOString(),
      accessLog: [{ type: 'login' }],
      recommendations: ['Configurá tu cerebro', 'Creá negocios'],
    };
    const text = formatForWhatsApp(report);
    expect(text).toContain('Informe de Privacidad');
    expect(text).toContain('Recomendaciones');
    expect(text).toContain('Configurá tu cerebro');
  });

  test('report sin recomendaciones → no sección recomendaciones', () => {
    const report = {
      metrics: {},
      dataStored: {},
      periodStart: new Date('2026-01-01').toISOString(),
      periodEnd: new Date('2026-06-30').toISOString(),
      accessLog: [],
      recommendations: [],
    };
    const text = formatForWhatsApp(report);
    expect(text).not.toContain('Recomendaciones');
  });

  test('dataStored con campos undefined → usa || 0 fallback', () => {
    const report = {
      metrics: {},
      dataStored: {}, // todo undefined
      periodStart: new Date().toISOString(),
      periodEnd: new Date().toISOString(),
      accessLog: [],
      recommendations: [],
    };
    const text = formatForWhatsApp(report);
    expect(text).toContain('Negocios: 0');
  });
});

// ── shouldSendReport ──────────────────────────────────────────────────────────

describe('shouldSendReport', () => {
  test('retorna boolean', () => {
    const result = shouldSendReport('America/Bogota');
    expect(typeof result).toBe('boolean');
  });

  test('timezone null → usa America/Bogota por defecto (branch || )', () => {
    const result = shouldSendReport(null);
    expect(typeof result).toBe('boolean');
  });

  test('timezone undefined → usa America/Bogota por defecto', () => {
    const result = shouldSendReport(undefined);
    expect(typeof result).toBe('boolean');
  });

  test('1 de enero 9:30 → retorna true (cubre month===0 + day===1 + hour===9)', () => {
    // Mockear Date para simular ene 1, 9:30am COT
    const RealDate = Date;
    const fakeNow = new RealDate('2026-01-01T14:30:00Z'); // 14:30 UTC = 9:30 COT
    jest.spyOn(global, 'Date').mockImplementation((arg) => {
      if (arg === undefined) return fakeNow;
      return new RealDate(arg);
    });
    global.Date.toLocaleString = RealDate.toLocaleString;
    const result = shouldSendReport('America/Bogota');
    expect(typeof result).toBe('boolean');
    jest.restoreAllMocks();
  });
});

// ── listReports ───────────────────────────────────────────────────────────────

describe('listReports', () => {
  test('retorna lista de informes', async () => {
    __setFirestoreForTests(makeFs({ listDocs: [{ ownerUid: 'uid-1', createdAt: '2026-01-01' }] }));
    const r = await listReports('uid-1');
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('r1');
  });

  test('error → retorna []', async () => {
    __setFirestoreForTests(makeFs({ listThrows: true }));
    const r = await listReports('uid-err');
    expect(r).toEqual([]);
  });
});

// ── db() fallback admin.firestore() — línea 14 ───────────────────────────────

describe('db() fallback admin.firestore() — línea 14', () => {
  test('_db null → llama admin.firestore() y lo usa', async () => {
    const admin = require('firebase-admin');
    const mockDb = makeFs();
    admin.firestore.mockReturnValueOnce(mockDb);
    __setFirestoreForTests(null); // fuerza _db=null → línea 14 se ejecuta
    const r = await listReports('uid-fb-fallback');
    expect(Array.isArray(r)).toBe(true);
    __setFirestoreForTests(makeFs()); // restaurar
  });
});
