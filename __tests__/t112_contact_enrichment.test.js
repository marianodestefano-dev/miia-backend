'use strict';
const { getEnrichment, setEnrichment, deleteEnrichment, ALLOWED_FIELDS, __setFirestoreForTests } = require('../core/contact_enrichment');

function makeMockDb({ data=null, throwGet=false, throwSet=false }={}) {
  let store = data;
  const docFn = () => ({
    get: async () => {
      if (throwGet) throw new Error('get err');
      if (store) return { exists: true, data: () => store };
      return { exists: false };
    },
    set: async (d, opts) => {
      if (throwSet) throw new Error('set err');
      store = (opts && opts.merge) ? Object.assign({}, store || {}, d) : d;
    }
  });
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: docFn
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('ALLOWED_FIELDS', () => {
  test('tiene los campos esperados y es frozen', () => {
    expect(ALLOWED_FIELDS).toContain('name');
    expect(ALLOWED_FIELDS).toContain('email');
    expect(ALLOWED_FIELDS).toContain('tags');
    expect(() => { ALLOWED_FIELDS.push('x'); }).toThrow();
  });
});

describe('getEnrichment', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getEnrichment('', '+573001')).rejects.toThrow('uid requerido');
  });
  test('retorna enrichment null si doc no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getEnrichment('uid1', '+573001');
    expect(r.enrichment).toBeNull();
  });
  test('retorna enrichment si existe', async () => {
    __setFirestoreForTests(makeMockDb({ data: { enrichment: { name: 'Juan', email: 'j@test.com' } } }));
    const r = await getEnrichment('uid1', '+573001');
    expect(r.enrichment.name).toBe('Juan');
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getEnrichment('uid1', '+573001');
    expect(r.enrichment).toBeNull();
    expect(r.error).toBeDefined();
  });
});

describe('setEnrichment', () => {
  test('lanza error si campo no permitido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setEnrichment('uid1', '+573001', { hackField: 'x' })).rejects.toThrow('no permitidos');
  });
  test('guarda correctamente y retorna updatedFields', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await setEnrichment('uid1', '+573001', { name: 'Pedro', email: 'p@test.com' });
    expect(r.updatedFields).toContain('name');
    expect(r.updatedFields).toContain('email');
  });
  test('lanza error si fields es array', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setEnrichment('uid1', '+573001', ['name'])).rejects.toThrow('objeto');
  });
  test('lanza error si no hay campos validos', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(setEnrichment('uid1', '+573001', {})).rejects.toThrow('No hay campos válidos');
  });
});

describe('deleteEnrichment', () => {
  test('elimina enriquecimiento', async () => {
    __setFirestoreForTests(makeMockDb({ data: { enrichment: { name: 'A' } } }));
    const r = await deleteEnrichment('uid1', '+573001');
    expect(r.deleted).toBe(true);
  });
  test('lanza error si uid o phone vacios', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deleteEnrichment('', '+573001')).rejects.toThrow('uid y phone requeridos');
  });
});
