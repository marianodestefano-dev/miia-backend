'use strict';

const {
  exportToCsv, sendToCrm,
  CSV_FIELDS, SUPPORTED_CRM, _buildCrmPayload, _csvEscape,
  __setFirestoreForTests, __setHttpClientForTests,
} = require('../core/crm_exporter');

const UID = 'testUid1234567890';
const SAMPLE_CONTACTS = [
  { phone: '+541155001', name: 'Ana Lopez', email: 'ana@test.com', tags: ['cliente'], score: 50, status: 'qualified', firstContact: '2026-01-01', lastContact: '2026-05-01', messageCount: 10, sector: 'retail', notes: '' },
  { phone: '+541155002', name: 'Bob "Smith"', email: '', tags: [], score: 10, status: 'new', firstContact: '2026-02-01', lastContact: '2026-04-01', messageCount: 3, sector: '', notes: 'tiene, coma' },
];

function makeMockDb({ contacts = [], throwGet = false } = {}) {
  const docs = contacts.map(c => ({ id: c.phone, data: () => c }));
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      get: async () => {
        if (throwGet) throw new Error('get error');
        return { forEach: fn => docs.forEach(fn) };
      },
    })})})
  };
}

function makeMockHttp({ statusCode = 200, throwErr = null } = {}) {
  return {
    post: async (url, payload, opts) => {
      if (throwErr) throw new Error(throwErr);
      return statusCode;
    },
  };
}

beforeEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setHttpClientForTests(null);
});

describe('CSV_FIELDS y SUPPORTED_CRM', () => {
  test('CSV_FIELDS es frozen con campos comunes', () => {
    expect(CSV_FIELDS).toContain('phone');
    expect(CSV_FIELDS).toContain('name');
    expect(CSV_FIELDS).toContain('email');
    expect(() => { CSV_FIELDS.push('x'); }).toThrow();
  });
  test('SUPPORTED_CRM es frozen', () => {
    expect(SUPPORTED_CRM).toContain('hubspot');
    expect(SUPPORTED_CRM).toContain('salesforce');
    expect(() => { SUPPORTED_CRM.push('x'); }).toThrow();
  });
});

describe('exportToCsv', () => {
  test('lanza si uid undefined', async () => {
    await expect(exportToCsv(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si campo invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(exportToCsv(UID, { fields: ['phone', 'campo_falso'] })).rejects.toThrow('invalidos');
  });
  test('retorna CSV con header y rows', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: SAMPLE_CONTACTS }));
    const r = await exportToCsv(UID);
    expect(r.rowCount).toBe(2);
    expect(r.csv).toContain('phone,name');
    expect(r.csv).toContain('Ana Lopez');
  });
  test('escapa comillas dobles en nombre', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: SAMPLE_CONTACTS }));
    const r = await exportToCsv(UID);
    expect(r.csv).toContain('"Bob ""Smith"""');
  });
  test('escapa comas en notas', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: SAMPLE_CONTACTS }));
    const r = await exportToCsv(UID, { fields: ['phone', 'notes'] });
    expect(r.csv).toContain('"tiene, coma"');
  });
  test('tags se unen con punto y coma', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: '+1', tags: ['a', 'b'] }] }));
    const r = await exportToCsv(UID, { fields: ['phone', 'tags'] });
    expect(r.csv).toContain('a;b');
  });
  test('propaga error si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    await expect(exportToCsv(UID)).rejects.toThrow('get error');
  });
});

describe('_csvEscape', () => {
  test('no escapa valor simple', () => { expect(_csvEscape('hola')).toBe('hola'); });
  test('escapa si contiene coma', () => { expect(_csvEscape('a,b')).toBe('"a,b"'); });
  test('escapa y duplica comillas', () => { expect(_csvEscape('di "hola"')).toBe('"di ""hola"""'); });
  test('null da vacio', () => { expect(_csvEscape(null)).toBe(''); });
  test('undefined da vacio', () => { expect(_csvEscape(undefined)).toBe(''); });
});

describe('sendToCrm - validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(sendToCrm(undefined, {}, 'hubspot', 'https://a.com')).rejects.toThrow('uid requerido');
  });
  test('lanza si contact undefined', async () => {
    await expect(sendToCrm(UID, undefined, 'hubspot', 'https://a.com')).rejects.toThrow('contact requerido');
  });
  test('lanza si crmType invalido', async () => {
    await expect(sendToCrm(UID, {}, 'zoho', 'https://a.com')).rejects.toThrow('crmType invalido');
  });
  test('lanza si webhookUrl no es HTTPS', async () => {
    await expect(sendToCrm(UID, {}, 'hubspot', 'http://a.com')).rejects.toThrow('HTTPS');
  });
});

describe('sendToCrm - resultado', () => {
  test('envia a HubSpot correctamente', async () => {
    __setHttpClientForTests(makeMockHttp({ statusCode: 200 }));
    const r = await sendToCrm(UID, SAMPLE_CONTACTS[0], 'hubspot', 'https://api.hubspot.com/crm/v3/objects/contacts');
    expect(r.sent).toBe(true);
    expect(r.crmType).toBe('hubspot');
    expect(r.statusCode).toBe(200);
  });
  test('propaga error si HTTP falla', async () => {
    __setHttpClientForTests(makeMockHttp({ throwErr: 'timeout' }));
    await expect(sendToCrm(UID, {}, 'generic', 'https://a.com')).rejects.toThrow('timeout');
  });
});

describe('_buildCrmPayload', () => {
  const contact = { phone: '+541', name: 'Ana Lopez', email: 'ana@test.com', status: 'qualified', notes: 'nota' };

  test('HubSpot schema tiene properties', () => {
    const p = _buildCrmPayload(contact, 'hubspot');
    expect(p.properties).toBeDefined();
    expect(p.properties.phone).toBe('+541');
    expect(p.properties.firstname).toBe('Ana');
  });
  test('Salesforce schema tiene LastName y LeadSource', () => {
    const p = _buildCrmPayload(contact, 'salesforce');
    expect(p.LastName).toBe('Ana Lopez');
    expect(p.LeadSource).toBe('WhatsApp');
    expect(p.Phone).toBe('+541');
  });
  test('generic schema agrega source miia', () => {
    const p = _buildCrmPayload(contact, 'generic');
    expect(p.source).toBe('miia');
    expect(p.phone).toBe('+541');
  });
});
