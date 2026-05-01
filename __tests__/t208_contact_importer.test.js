'use strict';

const {
  parseCSV, validateContact, normalizeContact,
  importContacts, importFromCSV,
  REQUIRED_FIELDS, ALLOWED_FIELDS, MAX_IMPORT_CONTACTS,
  __setFirestoreForTests,
} = require('../core/contact_importer');

const UID = 'testUid1234567890';

function makeMockDb({ throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async () => { if (throwSet) throw new Error('set error'); },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('REQUIRED_FIELDS / ALLOWED_FIELDS / MAX_IMPORT_CONTACTS', () => {
  test('REQUIRED_FIELDS contiene phone', () => {
    expect(REQUIRED_FIELDS).toContain('phone');
  });
  test('ALLOWED_FIELDS contiene phone y name', () => {
    expect(ALLOWED_FIELDS).toContain('phone');
    expect(ALLOWED_FIELDS).toContain('name');
  });
  test('es frozen', () => {
    expect(() => { REQUIRED_FIELDS.push('x'); }).toThrow();
  });
  test('MAX_IMPORT_CONTACTS es 5000', () => {
    expect(MAX_IMPORT_CONTACTS).toBe(5000);
  });
});

describe('parseCSV', () => {
  test('lanza si csvText no es string', () => {
    expect(() => parseCSV(123)).toThrow('debe ser string');
  });
  test('retorna array vacio para string vacio', () => {
    expect(parseCSV('')).toEqual([]);
  });
  test('parsea CSV simple', () => {
    const csv = 'phone,name\n+541155667788,Juan';
    const rows = parseCSV(csv);
    expect(rows.length).toBe(1);
    expect(rows[0].phone).toBe('+541155667788');
    expect(rows[0].name).toBe('Juan');
  });
  test('parsea CSV con comillas', () => {
    const csv = 'phone,name\n+1,"Doe, John"';
    const rows = parseCSV(csv);
    expect(rows[0].name).toBe('Doe, John');
  });
  test('parsea multiples filas', () => {
    const csv = 'phone,name\n+1,A\n+2,B\n+3,C';
    expect(parseCSV(csv).length).toBe(3);
  });
  test('ignora lineas vacias', () => {
    const csv = 'phone,name\n+1,A\n\n+2,B';
    expect(parseCSV(csv).length).toBe(2);
  });
});

describe('validateContact', () => {
  test('valido con phone correcto', () => {
    expect(validateContact({ phone: '+541155667788' }).valid).toBe(true);
  });
  test('invalido sin phone', () => {
    const r = validateContact({ name: 'Juan' });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('phone');
  });
  test('invalido con phone corto', () => {
    const r = validateContact({ phone: '123' });
    expect(r.valid).toBe(false);
  });
  test('valido sin prefijo +', () => {
    expect(validateContact({ phone: '541155667788' }).valid).toBe(true);
  });
});

describe('normalizeContact', () => {
  test('normaliza phone (quita espacios)', () => {
    const c = normalizeContact({ phone: '+54 11 5566 7788' });
    expect(c.phone).toBe('+541155667788');
  });
  test('convierte tags de string pipe a array', () => {
    const c = normalizeContact({ phone: '+1', tags: 'a|b|c' });
    expect(c.tags).toEqual(['a', 'b', 'c']);
  });
  test('clampea score a 0-100', () => {
    const c = normalizeContact({ phone: '+1', score: '150' });
    expect(c.score).toBe(100);
  });
  test('ignora campos no permitidos', () => {
    const c = normalizeContact({ phone: '+1', secretField: 'x' });
    expect(c.secretField).toBeUndefined();
  });
  test('omite campos vacios', () => {
    const c = normalizeContact({ phone: '+1', name: '' });
    expect(c.name).toBeUndefined();
  });
});

describe('importContacts', () => {
  test('lanza si uid undefined', async () => {
    await expect(importContacts(undefined, [])).rejects.toThrow('uid requerido');
  });
  test('lanza si contacts no es array', async () => {
    await expect(importContacts(UID, 'no')).rejects.toThrow('debe ser array');
  });
  test('importa contactos validos', async () => {
    __setFirestoreForTests(makeMockDb());
    const contacts = [{ phone: '+541155667788', name: 'Juan' }];
    const r = await importContacts(UID, contacts);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors.length).toBe(0);
  });
  test('salta contactos invalidos', async () => {
    __setFirestoreForTests(makeMockDb());
    const contacts = [{ phone: 'bad' }, { phone: '+541155667788' }];
    const r = await importContacts(UID, contacts);
    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(1);
    expect(r.errors.length).toBe(1);
  });
  test('retorna error si Firestore falla (sigue procesando)', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const contacts = [{ phone: '+541155667788' }, { phone: '+541155667799' }];
    const r = await importContacts(UID, contacts);
    expect(r.skipped).toBe(2);
    expect(r.errors.length).toBe(2);
  });
  test('respeta MAX_IMPORT_CONTACTS', async () => {
    __setFirestoreForTests(makeMockDb());
    const contacts = Array.from({ length: MAX_IMPORT_CONTACTS + 5 }, (_, i) => ({ phone: '+5411' + String(i).padStart(10, '0') }));
    const r = await importContacts(UID, contacts);
    expect(r.total).toBe(MAX_IMPORT_CONTACTS);
  });
});

describe('importFromCSV', () => {
  test('lanza si uid undefined', async () => {
    await expect(importFromCSV(undefined, 'phone\n+1')).rejects.toThrow('uid requerido');
  });
  test('lanza si csvText undefined', async () => {
    await expect(importFromCSV(UID, undefined)).rejects.toThrow('csvText requerido');
  });
  test('importa desde CSV correctamente', async () => {
    __setFirestoreForTests(makeMockDb());
    const csv = 'phone,name\n+541155667788,Juan';
    const r = await importFromCSV(UID, csv);
    expect(r.imported).toBe(1);
  });
  test('CSV vacio retorna 0 importados', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await importFromCSV(UID, 'phone,name');
    expect(r.imported).toBe(0);
    expect(r.total).toBe(0);
  });
});
