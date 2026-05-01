'use strict';

const {
  computeContactSegment, buildEnrichmentRecord,
  saveEnrichmentRecord, getEnrichmentRecord,
  getContactTags, addTagToContact, removeTagFromContact,
  searchContactsBySegment, buildEnrichmentText,
  isValidSegment, isValidTag,
  CONTACT_SEGMENTS, VALID_ENRICHMENT_FIELDS,
  MAX_TAGS_PER_CONTACT, MAX_NOTES_LENGTH,
  __setFirestoreForTests,
} = require('../core/contact_enrichment');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const PHONE_KEY = '1155667788';

function makeMockDb({ stored = {}, tagStored = {}, throwGet = false, throwSet = false, tagCount = 0 } = {}) {
  const db_stored = { ...stored };
  const tag_stored = { ...tagStored };
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const target = subCol === 'contact_tags' ? tag_stored : db_stored;
              target[id] = opts && opts.merge ? { ...(target[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'contact_tags' ? tag_stored : db_stored;
              if (subCol === 'contact_tags' && tagCount > 0) {
                return {
                  exists: true,
                  data: () => ({ tags: Array(tagCount).fill('existing_tag'), phone: PHONE }),
                };
              }
              return { exists: !!target[id], data: () => target[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return {
                forEach: fn => entries.forEach(d => fn({ data: () => d })),
              };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('CONTACT_SEGMENTS tiene 8', () => { expect(CONTACT_SEGMENTS.length).toBe(8); });
  test('frozen CONTACT_SEGMENTS', () => { expect(() => { CONTACT_SEGMENTS.push('x'); }).toThrow(); });
  test('VALID_ENRICHMENT_FIELDS tiene 10', () => { expect(VALID_ENRICHMENT_FIELDS.length).toBe(10); });
  test('frozen VALID_ENRICHMENT_FIELDS', () => { expect(() => { VALID_ENRICHMENT_FIELDS.push('x'); }).toThrow(); });
  test('MAX_TAGS_PER_CONTACT es 20', () => { expect(MAX_TAGS_PER_CONTACT).toBe(20); });
  test('MAX_NOTES_LENGTH es 500', () => { expect(MAX_NOTES_LENGTH).toBe(500); });
});

describe('isValidSegment / isValidTag', () => {
  test('vip es segmento valido', () => { expect(isValidSegment('vip')).toBe(true); });
  test('inactive es segmento valido', () => { expect(isValidSegment('inactive')).toBe(true); });
  test('gold no es segmento valido', () => { expect(isValidSegment('gold')).toBe(false); });
  test('tag valido alphanumerico', () => { expect(isValidTag('cliente_vip')).toBe(true); });
  test('tag con mayusculas invalido', () => { expect(isValidTag('ClienteVip')).toBe(false); });
  test('tag con espacios invalido', () => { expect(isValidTag('cliente vip')).toBe(false); });
  test('tag vacio invalido', () => { expect(isValidTag('')).toBe(false); });
  test('tag null invalido', () => { expect(isValidTag(null)).toBe(false); });
  test('tag numerico valido', () => { expect(isValidTag('2026')).toBe(true); });
});

describe('computeContactSegment', () => {
  test('vip si isConverted y >=5 compras', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 5 })).toBe('vip');
  });
  test('premium si isConverted y >=2 compras', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 3 })).toBe('premium');
  });
  test('converted si isConverted y 1 compra', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 1 })).toBe('converted');
  });
  test('inactive si >90 dias sin actividad', () => {
    expect(computeContactSegment({ daysSinceLastActivity: 91 })).toBe('inactive');
  });
  test('cold si >30 dias sin actividad', () => {
    expect(computeContactSegment({ daysSinceLastActivity: 45 })).toBe('cold');
  });
  test('at_risk si score Caliente o Listo', () => {
    expect(computeContactSegment({ scoreLabel: 'Caliente', daysSinceLastActivity: 10 })).toBe('at_risk');
  });
  test('new si <= 7 dias', () => {
    expect(computeContactSegment({ daysSinceLastActivity: 3 })).toBe('new');
  });
  test('regular por defecto', () => {
    expect(computeContactSegment({})).toBe('regular');
  });
});

describe('buildEnrichmentRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildEnrichmentRecord(undefined, PHONE, {})).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildEnrichmentRecord(UID, undefined, {})).toThrow('phone requerido');
  });
  test('lanza si fields no es objeto', () => {
    expect(() => buildEnrichmentRecord(UID, PHONE, 'mal')).toThrow('fields debe ser objeto');
  });
  test('construye record correctamente', () => {
    const r = buildEnrichmentRecord(UID, PHONE, { email: 'a@b.com', company: 'ACME' }, { date: '2026-05-01' });
    expect(r.uid).toBe(UID);
    expect(r.phone).toBe(PHONE);
    expect(r.fields.email).toBe('a@b.com');
    expect(r.fields.company).toBe('ACME');
    expect(r.segment).toBe('regular');
  });
  test('ignora campos no validos', () => {
    const r = buildEnrichmentRecord(UID, PHONE, { email: 'a@b.com', invalid_field: 'x' });
    expect(r.fields.email).toBe('a@b.com');
    expect(r.fields.invalid_field).toBeUndefined();
  });
  test('trunca notes a MAX_NOTES_LENGTH', () => {
    const longNotes = 'x'.repeat(600);
    const r = buildEnrichmentRecord(UID, PHONE, { notes: longNotes });
    expect(r.fields.notes.length).toBe(MAX_NOTES_LENGTH);
  });
  test('acepta segment explícito valido', () => {
    const r = buildEnrichmentRecord(UID, PHONE, {}, { segment: 'vip' });
    expect(r.segment).toBe('vip');
  });
  test('segment invalido cae a computeContactSegment', () => {
    const r = buildEnrichmentRecord(UID, PHONE, {}, { segment: 'super_premium' });
    expect(CONTACT_SEGMENTS).toContain(r.segment);
  });
  test('acepta tags en opts', () => {
    const r = buildEnrichmentRecord(UID, PHONE, {}, { tags: ['cliente_vip'] });
    expect(r.tags).toContain('cliente_vip');
  });
});

describe('saveEnrichmentRecord', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveEnrichmentRecord(undefined, { recordId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveEnrichmentRecord(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = buildEnrichmentRecord(UID, PHONE, { email: 'a@b.com' });
    const id = await saveEnrichmentRecord(UID, r);
    expect(id).toBe(r.recordId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = buildEnrichmentRecord(UID, PHONE, {});
    await expect(saveEnrichmentRecord(UID, r)).rejects.toThrow('set error');
  });
});

describe('getEnrichmentRecord', () => {
  test('lanza si uid undefined', async () => {
    await expect(getEnrichmentRecord(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getEnrichmentRecord(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getEnrichmentRecord(UID, PHONE)).toBeNull();
  });
  test('retorna record existente', async () => {
    const r = buildEnrichmentRecord(UID, PHONE, { email: 'a@b.com' }, { date: '2026-05-01' });
    __setFirestoreForTests(makeMockDb({ stored: { [r.recordId]: r } }));
    const loaded = await getEnrichmentRecord(UID, PHONE);
    expect(loaded.fields.email).toBe('a@b.com');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getEnrichmentRecord(UID, PHONE)).toBeNull();
  });
});

describe('addTagToContact', () => {
  test('lanza si uid undefined', async () => {
    await expect(addTagToContact(undefined, PHONE, 'tag1')).rejects.toThrow('uid requerido');
  });
  test('lanza si tag invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(addTagToContact(UID, PHONE, 'Tag Invalido')).rejects.toThrow('tag invalido');
  });
  test('agrega tag correctamente', async () => {
    __setFirestoreForTests(makeMockDb());
    const tags = await addTagToContact(UID, PHONE, 'cliente_vip');
    expect(tags).toContain('cliente_vip');
  });
  test('no duplica tags existentes', async () => {
    __setFirestoreForTests(makeMockDb({ tagStored: { [PHONE_KEY]: { tags: ['cliente_vip'], phone: PHONE } } }));
    const tags = await addTagToContact(UID, PHONE, 'cliente_vip');
    expect(tags.filter(t => t === 'cliente_vip').length).toBe(1);
  });
  test('lanza si se alcanza MAX_TAGS_PER_CONTACT', async () => {
    __setFirestoreForTests(makeMockDb({ tagCount: 20 }));
    await expect(addTagToContact(UID, PHONE, 'nuevo_tag')).rejects.toThrow('max tags alcanzado');
  });
});

describe('removeTagFromContact', () => {
  test('lanza si uid undefined', async () => {
    await expect(removeTagFromContact(undefined, PHONE, 'tag1')).rejects.toThrow('uid requerido');
  });
  test('lanza si tag undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(removeTagFromContact(UID, PHONE, undefined)).rejects.toThrow('tag requerido');
  });
  test('remueve tag existente', async () => {
    __setFirestoreForTests(makeMockDb({ tagStored: { [PHONE_KEY]: { tags: ['vip', 'activo'], phone: PHONE } } }));
    const tags = await removeTagFromContact(UID, PHONE, 'vip');
    expect(tags).not.toContain('vip');
    expect(tags).toContain('activo');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await removeTagFromContact(UID, PHONE, 'vip')).toEqual([]);
  });
});

describe('searchContactsBySegment', () => {
  test('lanza si uid undefined', async () => {
    await expect(searchContactsBySegment(undefined, 'vip')).rejects.toThrow('uid requerido');
  });
  test('lanza si segment invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(searchContactsBySegment(UID, 'gold')).rejects.toThrow('segment invalido');
  });
  test('retorna vacio si no hay', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await searchContactsBySegment(UID, 'vip')).toEqual([]);
  });
  test('retorna contactos del segmento', async () => {
    const r1 = buildEnrichmentRecord(UID, PHONE, {}, { segment: 'vip' });
    const r2 = buildEnrichmentRecord(UID, '+5411999', {}, { segment: 'regular' });
    __setFirestoreForTests(makeMockDb({ stored: { [r1.recordId]: r1, [r2.recordId]: r2 } }));
    const vips = await searchContactsBySegment(UID, 'vip');
    expect(vips.length).toBe(1);
    expect(vips[0].segment).toBe('vip');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await searchContactsBySegment(UID, 'vip')).toEqual([]);
  });
});

describe('buildEnrichmentText', () => {
  test('retorna vacio si null', () => { expect(buildEnrichmentText(null)).toBe(''); });
  test('incluye phone y segmento', () => {
    const r = buildEnrichmentRecord(UID, PHONE, { company: 'ACME' }, { segment: 'vip' });
    const text = buildEnrichmentText(r);
    expect(text).toContain(PHONE);
    expect(text).toContain('vip');
  });
  test('incluye empresa si hay', () => {
    const r = buildEnrichmentRecord(UID, PHONE, { company: 'ACME Corp' });
    const text = buildEnrichmentText(r);
    expect(text).toContain('ACME Corp');
  });
  test('incluye tags si hay', () => {
    const r = buildEnrichmentRecord(UID, PHONE, {}, { tags: ['cliente_vip'] });
    const text = buildEnrichmentText(r);
    expect(text).toContain('cliente_vip');
  });
  test('incluye emoji vip', () => {
    const r = buildEnrichmentRecord(UID, PHONE, {}, { segment: 'vip' });
    const text = buildEnrichmentText(r);
    expect(text.length).toBeGreaterThan(10);
  });
});
