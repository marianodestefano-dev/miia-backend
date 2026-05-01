'use strict';

const {
  validateMediaMessage, buildMediaRef, saveMediaRef, getMediaRef,
  markMediaProcessed, getMediaRefsByPhone, deleteExpiredMediaRefs,
  isMediaExpired, buildMediaContextText, getMediaCategory,
  isValidImageType, isValidDocumentType, isValidAudioType,
  SUPPORTED_IMAGE_TYPES, SUPPORTED_DOCUMENT_TYPES, SUPPORTED_AUDIO_TYPES,
  MEDIA_CATEGORIES, MAX_IMAGE_SIZE_BYTES, MAX_DOCUMENT_SIZE_BYTES,
  DEFAULT_EXPIRY_HOURS, MEDIA_STORAGE_COLLECTION,
  __setFirestoreForTests,
} = require('../core/media_handler');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

const IMG_MSG = { mimeType: 'image/jpeg', sizeBytes: 1024 * 100, fileName: 'foto.jpg', caption: 'Mi producto' };
const DOC_MSG = { mimeType: 'application/pdf', sizeBytes: 1024 * 500, fileName: 'catalogo.pdf' };
const AUDIO_MSG = { mimeType: 'audio/ogg', sizeBytes: 1024 * 200 };

function makeMockDb({ stored = {}, throwGet = false, throwSet = false, throwDelete = false, whereResults = [] } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => ({
              exists: !!db_stored[id],
              data: () => db_stored[id],
            }),
            delete: async () => {
              if (throwDelete) throw new Error('delete error');
              delete db_stored[id];
            },
            ref: {
              delete: async () => { delete db_stored[id]; },
            },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              return {
                forEach: fn => whereResults.forEach((data, i) => fn({ data: () => data })),
              };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({
                data: () => data,
                ref: { delete: async () => { delete db_stored[id]; } },
              })),
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
  test('SUPPORTED_IMAGE_TYPES tiene 4 tipos', () => { expect(SUPPORTED_IMAGE_TYPES.length).toBe(4); });
  test('frozen SUPPORTED_IMAGE_TYPES', () => { expect(() => { SUPPORTED_IMAGE_TYPES.push('x'); }).toThrow(); });
  test('SUPPORTED_DOCUMENT_TYPES tiene 4 tipos', () => { expect(SUPPORTED_DOCUMENT_TYPES.length).toBe(4); });
  test('SUPPORTED_AUDIO_TYPES tiene 4 tipos', () => { expect(SUPPORTED_AUDIO_TYPES.length).toBe(4); });
  test('MEDIA_CATEGORIES tiene 5 categorias', () => { expect(MEDIA_CATEGORIES.length).toBe(5); });
  test('frozen MEDIA_CATEGORIES', () => { expect(() => { MEDIA_CATEGORIES.push('x'); }).toThrow(); });
  test('MAX_IMAGE_SIZE_BYTES es 5MB', () => { expect(MAX_IMAGE_SIZE_BYTES).toBe(5 * 1024 * 1024); });
  test('MAX_DOCUMENT_SIZE_BYTES es 20MB', () => { expect(MAX_DOCUMENT_SIZE_BYTES).toBe(20 * 1024 * 1024); });
  test('DEFAULT_EXPIRY_HOURS es 24', () => { expect(DEFAULT_EXPIRY_HOURS).toBe(24); });
});

describe('isValid* / getMediaCategory', () => {
  test('image/jpeg es imagen valida', () => { expect(isValidImageType('image/jpeg')).toBe(true); });
  test('image/tiff no es valida', () => { expect(isValidImageType('image/tiff')).toBe(false); });
  test('application/pdf es documento valido', () => { expect(isValidDocumentType('application/pdf')).toBe(true); });
  test('audio/ogg es audio valido', () => { expect(isValidAudioType('audio/ogg')).toBe(true); });
  test('getMediaCategory imagen', () => { expect(getMediaCategory('image/jpeg')).toBe('image'); });
  test('getMediaCategory audio', () => { expect(getMediaCategory('audio/mpeg')).toBe('audio'); });
  test('getMediaCategory pdf', () => { expect(getMediaCategory('application/pdf')).toBe('document'); });
  test('getMediaCategory null', () => { expect(getMediaCategory(null)).toBeNull(); });
  test('getMediaCategory desconocido', () => { expect(getMediaCategory('application/xyz')).toBeNull(); });
});

describe('validateMediaMessage', () => {
  test('lanza si mediaMsg undefined', () => {
    expect(() => validateMediaMessage(undefined)).toThrow('requerido');
  });
  test('lanza si mimeType undefined', () => {
    expect(() => validateMediaMessage({})).toThrow('mimeType requerido');
  });
  test('lanza si mimeType no soportado', () => {
    expect(() => validateMediaMessage({ mimeType: 'application/xyz' })).toThrow('no soportado');
  });
  test('imagen valida retorna categoria', () => {
    const r = validateMediaMessage(IMG_MSG);
    expect(r.category).toBe('image');
    expect(r.mimeType).toBe('image/jpeg');
  });
  test('lanza si imagen muy grande', () => {
    expect(() => validateMediaMessage({ mimeType: 'image/jpeg', sizeBytes: MAX_IMAGE_SIZE_BYTES + 1 }))
      .toThrow('demasiado grande');
  });
  test('documento valido retorna categoria', () => {
    const r = validateMediaMessage(DOC_MSG);
    expect(r.category).toBe('document');
  });
  test('audio valido retorna categoria', () => {
    const r = validateMediaMessage(AUDIO_MSG);
    expect(r.category).toBe('audio');
  });
});

describe('buildMediaRef', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildMediaRef(undefined, PHONE, IMG_MSG)).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildMediaRef(UID, undefined, IMG_MSG)).toThrow('phone requerido');
  });
  test('construye ref correctamente', () => {
    const ref = buildMediaRef(UID, PHONE, IMG_MSG);
    expect(ref.refId).toMatch(/^media_/);
    expect(ref.uid).toBe(UID);
    expect(ref.phone).toBe(PHONE);
    expect(ref.category).toBe('image');
    expect(ref.mimeType).toBe('image/jpeg');
    expect(ref.caption).toBe('Mi producto');
    expect(ref.fileName).toBe('foto.jpg');
    expect(ref.processed).toBe(false);
    expect(ref.expiresAt).toBeDefined();
    expect(ref.createdAt).toBeDefined();
  });
  test('expiry personalizado', () => {
    const ref = buildMediaRef(UID, PHONE, IMG_MSG, { expiryHours: 48 });
    const diff = new Date(ref.expiresAt).getTime() - new Date(ref.createdAt).getTime();
    expect(diff).toBeGreaterThanOrEqual(47 * 60 * 60 * 1000);
  });
  test('context default es conversation', () => {
    const ref = buildMediaRef(UID, PHONE, IMG_MSG);
    expect(ref.context).toBe('conversation');
  });
});

describe('saveMediaRef', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveMediaRef(undefined, { refId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si mediaRef invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveMediaRef(UID, null)).rejects.toThrow('mediaRef invalido');
  });
  test('guarda ref sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const ref = buildMediaRef(UID, PHONE, IMG_MSG);
    const refId = await saveMediaRef(UID, ref);
    expect(refId).toBe(ref.refId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const ref = buildMediaRef(UID, PHONE, IMG_MSG);
    await expect(saveMediaRef(UID, ref)).rejects.toThrow('set error');
  });
});

describe('getMediaRef', () => {
  test('lanza si uid undefined', async () => {
    await expect(getMediaRef(undefined, 'ref1')).rejects.toThrow('uid requerido');
  });
  test('lanza si refId undefined', async () => {
    await expect(getMediaRef(UID, undefined)).rejects.toThrow('refId requerido');
  });
  test('retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getMediaRef(UID, 'noexiste')).toBeNull();
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getMediaRef(UID, 'ref1')).toBeNull();
  });
});

describe('markMediaProcessed', () => {
  test('lanza si uid undefined', async () => {
    await expect(markMediaProcessed(undefined, 'ref1')).rejects.toThrow('uid requerido');
  });
  test('lanza si refId undefined', async () => {
    await expect(markMediaProcessed(UID, undefined)).rejects.toThrow('refId requerido');
  });
  test('marca procesado sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(markMediaProcessed(UID, 'ref1', '/storage/path/img.jpg')).resolves.toBeUndefined();
  });
});

describe('getMediaRefsByPhone', () => {
  test('lanza si uid undefined', async () => {
    await expect(getMediaRefsByPhone(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(getMediaRefsByPhone(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna refs del where', async () => {
    const fakeRef = { refId: 'ref1', phone: PHONE, category: 'image' };
    __setFirestoreForTests(makeMockDb({ whereResults: [fakeRef] }));
    const refs = await getMediaRefsByPhone(UID, PHONE);
    expect(refs.length).toBe(1);
    expect(refs[0].phone).toBe(PHONE);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getMediaRefsByPhone(UID, PHONE)).toEqual([]);
  });
});

describe('deleteExpiredMediaRefs', () => {
  test('lanza si uid undefined', async () => {
    await expect(deleteExpiredMediaRefs(undefined)).rejects.toThrow('uid requerido');
  });
  test('elimina refs expirados', async () => {
    const pastTime = new Date(Date.now() - 1000).toISOString();
    const futureTime = new Date(Date.now() + 100000).toISOString();
    const stored = {
      'ref_old': { refId: 'ref_old', expiresAt: pastTime },
      'ref_new': { refId: 'ref_new', expiresAt: futureTime },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const count = await deleteExpiredMediaRefs(UID);
    expect(count).toBe(1);
  });
  test('fail-open retorna 0 si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await deleteExpiredMediaRefs(UID)).toBe(0);
  });
});

describe('isMediaExpired', () => {
  test('retorna false si mediaRef null', () => {
    expect(isMediaExpired(null)).toBe(false);
  });
  test('retorna true si expirado', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isMediaExpired({ expiresAt: past })).toBe(true);
  });
  test('retorna false si no expirado', () => {
    const future = new Date(Date.now() + 100000).toISOString();
    expect(isMediaExpired({ expiresAt: future })).toBe(false);
  });
});

describe('buildMediaContextText', () => {
  test('retorna vacio si null', () => {
    expect(buildMediaContextText(null)).toBe('');
  });
  test('incluye categoria', () => {
    const ref = { category: 'image', fileName: 'foto.jpg', caption: 'test', sizeBytes: 2048 };
    const text = buildMediaContextText(ref);
    expect(text).toContain('image');
    expect(text).toContain('foto.jpg');
    expect(text).toContain('test');
    expect(text).toContain('2KB');
  });
  test('funciona sin campos opcionales', () => {
    const ref = { category: 'audio' };
    const text = buildMediaContextText(ref);
    expect(text).toContain('audio');
  });
});
