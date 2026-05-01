'use strict';

const {
  buildPrivacyReport, requestErasure, getErasureRequests, buildGDPRExportPackage,
  getConversationStats, getContactStats, getMemoryStats, isValidCategory,
  ERASURE_CATEGORIES, REPORT_SECTIONS, GDPR_VERSION, DATA_RETENTION_DAYS, MAX_REPORT_CONTACTS,
  __setFirestoreForTests,
} = require('../core/privacy_report_builder');

const UID = 'testUid1234567890';

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => {
            if (throwGet) throw new Error('get error');
            const items = docs.map((d, i) => ({ id: 'doc_' + i, data: () => d }));
            return { forEach: fn => items.forEach(fn) };
          },
          doc: () => ({
            set: async (data) => { if (throwSet) throw new Error('set error'); },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('Constantes', () => {
  test('ERASURE_CATEGORIES tiene 8 categorias', () => { expect(ERASURE_CATEGORIES.length).toBe(8); });
  test('frozen ERASURE_CATEGORIES', () => { expect(() => { ERASURE_CATEGORIES.push('x'); }).toThrow(); });
  test('REPORT_SECTIONS tiene 7 secciones', () => { expect(REPORT_SECTIONS.length).toBe(7); });
  test('GDPR_VERSION es 1.0', () => { expect(GDPR_VERSION).toBe('1.0'); });
  test('DATA_RETENTION_DAYS es 365', () => { expect(DATA_RETENTION_DAYS).toBe(365); });
  test('MAX_REPORT_CONTACTS es 1000', () => { expect(MAX_REPORT_CONTACTS).toBe(1000); });
  test('all es categoria valida', () => { expect(isValidCategory('all')).toBe(true); });
  test('unknown no es categoria valida', () => { expect(isValidCategory('unknown')).toBe(false); });
});

describe('getConversationStats', () => {
  test('lanza si uid undefined', async () => {
    await expect(getConversationStats(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna count 0 si no hay conversaciones', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getConversationStats(UID);
    expect(r.count).toBe(0);
  });
  test('cuenta conversaciones existentes', async () => {
    const docs = [{ lastMessageAt: '2026-05-01' }, { lastMessageAt: '2026-04-01' }];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getConversationStats(UID);
    expect(r.count).toBe(2);
  });
  test('fail-open retorna count 0 si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getConversationStats(UID);
    expect(r.count).toBe(0);
  });
});

describe('getContactStats', () => {
  test('lanza si uid undefined', async () => {
    await expect(getContactStats(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna total 0 sin contactos', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getContactStats(UID);
    expect(r.total).toBe(0);
  });
  test('agrupa por tipo', async () => {
    const docs = [{ type: 'lead' }, { type: 'lead' }, { type: 'client' }];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getContactStats(UID);
    expect(r.total).toBe(3);
    expect(r.byType.lead).toBe(2);
    expect(r.byType.client).toBe(1);
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getContactStats(UID);
    expect(r.total).toBe(0);
  });
});

describe('getMemoryStats', () => {
  test('lanza si uid undefined', async () => {
    await expect(getMemoryStats(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna episodeCount 0 sin memorias', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getMemoryStats(UID);
    expect(r.episodeCount).toBe(0);
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getMemoryStats(UID);
    expect(r.episodeCount).toBe(0);
  });
});

describe('buildPrivacyReport', () => {
  test('lanza si uid undefined', async () => {
    await expect(buildPrivacyReport(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna reporte con estructura correcta', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await buildPrivacyReport(UID);
    expect(r.uid).toBe(UID);
    expect(r.gdprVersion).toBe(GDPR_VERSION);
    expect(r.generatedAt).toBeDefined();
    expect(r.conversations).toBeDefined();
    expect(r.contacts).toBeDefined();
    expect(r.memory).toBeDefined();
    expect(r.erasureCategories).toBe(ERASURE_CATEGORIES);
  });
  test('dataRetentionDays es 365', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await buildPrivacyReport(UID);
    expect(r.dataRetentionDays).toBe(365);
  });
});

describe('requestErasure', () => {
  test('lanza si uid undefined', async () => {
    await expect(requestErasure(undefined, 'conversations')).rejects.toThrow('uid requerido');
  });
  test('lanza si category undefined', async () => {
    await expect(requestErasure(UID, undefined)).rejects.toThrow('category requerido');
  });
  test('lanza si category invalida', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(requestErasure(UID, 'sms_data')).rejects.toThrow('categoria invalida');
  });
  test('crea solicitud sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await requestErasure(UID, 'conversations', { reason: 'privacidad' });
    expect(r.requestId).toMatch(/^erasure_/);
    expect(r.record.status).toBe('pending');
    expect(r.record.category).toBe('conversations');
  });
  test('acepta category all', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await requestErasure(UID, 'all');
    expect(r.record.category).toBe('all');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(requestErasure(UID, 'memory')).rejects.toThrow('set error');
  });
});

describe('getErasureRequests', () => {
  test('lanza si uid undefined', async () => {
    await expect(getErasureRequests(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio sin solicitudes', async () => {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getErasureRequests(UID);
    expect(r).toEqual([]);
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getErasureRequests(UID);
    expect(r).toEqual([]);
  });
});

describe('buildGDPRExportPackage', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildGDPRExportPackage(undefined, {})).toThrow('uid requerido');
  });
  test('retorna paquete con estructura GDPR', () => {
    const pkg = buildGDPRExportPackage(UID, { conversations: { count: 10 } }, [{ phone: '+54111' }]);
    expect(pkg.exportVersion).toBe(GDPR_VERSION);
    expect(pkg.subject).toBe(UID);
    expect(pkg.contacts.length).toBe(1);
    expect(pkg.rightsAvailable.length).toBeGreaterThan(0);
    expect(pkg.contactDpo).toBe('privacy@miia-app.com');
  });
  test('limita contactos a MAX_REPORT_CONTACTS', () => {
    const contacts = Array.from({ length: 1500 }, (_, i) => ({ phone: '+' + i }));
    const pkg = buildGDPRExportPackage(UID, {}, contacts);
    expect(pkg.contactsIncluded).toBe(MAX_REPORT_CONTACTS);
    expect(pkg.contacts.length).toBe(MAX_REPORT_CONTACTS);
  });
  test('maneja contactList vacio', () => {
    const pkg = buildGDPRExportPackage(UID, {});
    expect(pkg.contactsIncluded).toBe(0);
  });
});
