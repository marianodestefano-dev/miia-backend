'use strict';

const {
  contactsToCSV, conversationsToCSV,
  exportContacts, exportConversations, generateExportManifest,
  EXPORT_FORMATS, MAX_EXPORT_CONTACTS,
  __setFirestoreForTests,
} = require('../core/data_exporter');

const UID = 'testUid1234567890';

function makeMockDb({ contacts = [], conversations = [], throwGet = false } = {}) {
  const makeSnap = (items) => ({
    forEach: fn => items.forEach((data, idx) => fn({ id: 'doc' + idx, data: () => data })),
  });
  const contactsSnap = makeSnap(contacts);
  const convsSnap = makeSnap(conversations);
  return {
    collection: () => ({
      doc: () => ({
        collection: (name) => ({
          limit: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (name === 'contacts') return contactsSnap;
              return convsSnap;
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            if (name === 'contacts') return contactsSnap;
            return convsSnap;
          },
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('EXPORT_FORMATS y MAX_EXPORT_CONTACTS', () => {
  test('EXPORT_FORMATS tiene csv y json', () => {
    expect(EXPORT_FORMATS).toContain('csv');
    expect(EXPORT_FORMATS).toContain('json');
  });
  test('es frozen', () => {
    expect(() => { EXPORT_FORMATS.push('xml'); }).toThrow();
  });
  test('MAX_EXPORT_CONTACTS es 10000', () => {
    expect(MAX_EXPORT_CONTACTS).toBe(10000);
  });
});

describe('contactsToCSV', () => {
  test('lanza si contacts no es array', () => {
    expect(() => contactsToCSV('no')).toThrow('debe ser array');
  });
  test('retorna header con array vacio', () => {
    const csv = contactsToCSV([]);
    expect(csv).toContain('phone');
  });
  test('incluye datos del contacto', () => {
    const csv = contactsToCSV([{ phone: '+541155667788', name: 'Juan', tags: ['a','b'], score: 42 }]);
    expect(csv).toContain('+541155667788');
    expect(csv).toContain('Juan');
    expect(csv).toContain('a|b');
  });
  test('multiples filas', () => {
    const contacts = [
      { phone: '+1', name: 'A' },
      { phone: '+2', name: 'B' },
    ];
    const lines = contactsToCSV(contacts).split('\n');
    expect(lines.length).toBe(3);
  });
  test('escapa comas en valores', () => {
    const csv = contactsToCSV([{ phone: '+1', name: 'Doe, John' }]);
    expect(csv).toContain('"Doe, John"');
  });
});

describe('conversationsToCSV', () => {
  test('lanza si conversations no es array', () => {
    expect(() => conversationsToCSV('no')).toThrow('debe ser array');
  });
  test('retorna header con array vacio', () => {
    const csv = conversationsToCSV([]);
    expect(csv).toContain('phone');
  });
  test('incluye datos de la conversacion', () => {
    const csv = conversationsToCSV([{ phone: '+541155667788', role: 'lead', text: 'hola', timestamp: '2026-05-04T12:00:00Z' }]);
    expect(csv).toContain('+541155667788');
    expect(csv).toContain('hola');
  });
});

describe('exportContacts', () => {
  test('lanza si uid undefined', async () => {
    await expect(exportContacts(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza formato invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(exportContacts(UID, { format: 'xml' })).rejects.toThrow('formato invalido');
  });
  test('retorna csv por default', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: '+1', name: 'X' }] }));
    const r = await exportContacts(UID);
    expect(r.format).toBe('csv');
    expect(r.data).toContain('+1');
    expect(r.count).toBe(1);
  });
  test('retorna json si se pide', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: '+1', name: 'X' }] }));
    const r = await exportContacts(UID, { format: 'json' });
    expect(r.format).toBe('json');
    const parsed = JSON.parse(r.data);
    expect(Array.isArray(parsed)).toBe(true);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await exportContacts(UID);
    expect(r.count).toBe(0);
  });
});

describe('exportConversations', () => {
  test('lanza si uid undefined', async () => {
    await expect(exportConversations(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna csv por default', async () => {
    __setFirestoreForTests(makeMockDb({ conversations: [{ phone: '+1', role: 'lead', text: 'hola', timestamp: '2026-05-04T12:00:00Z' }] }));
    const r = await exportConversations(UID);
    expect(r.format).toBe('csv');
    expect(r.data).toContain('+1');
    expect(r.count).toBe(1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await exportConversations(UID);
    expect(r.count).toBe(0);
  });
});

describe('generateExportManifest', () => {
  test('lanza si uid undefined', () => {
    expect(() => generateExportManifest(undefined, [])).toThrow('uid requerido');
  });
  test('lanza si exports no es array', () => {
    expect(() => generateExportManifest(UID, 'no')).toThrow('debe ser array');
  });
  test('retorna manifest con metadata', () => {
    const exports = [
      { type: 'contacts', format: 'csv', count: 10 },
      { type: 'conversations', format: 'json', count: 50 },
    ];
    const m = generateExportManifest(UID, exports);
    expect(m.uid).toBe(UID);
    expect(m.totalRecords).toBe(60);
    expect(m.exports.length).toBe(2);
    expect(m.generatedAt).toBeDefined();
  });
  test('manifest con array vacio', () => {
    const m = generateExportManifest(UID, []);
    expect(m.totalRecords).toBe(0);
  });
});
