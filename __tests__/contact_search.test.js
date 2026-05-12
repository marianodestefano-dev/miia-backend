'use strict';
/**
 * R17-B — contact_search.test.js
 * 100% branch coverage: searchContacts + _scoreContact
 */

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockContactDocs = [];
let mockContactsGetThrows = false;

const mockFs = {
  collection: () => ({
    doc: () => ({
      collection: () => ({
        get: () => {
          if (mockContactsGetThrows) return Promise.reject(new Error('CONTACTS-FAIL'));
          return Promise.resolve({ forEach: (fn) => mockContactDocs.forEach(fn) });
        },
      }),
    }),
  }),
};

const {
  searchContacts,
  _scoreContact,
  MAX_RESULTS,
  SCORE_EXACT_NAME,
  SCORE_PREFIX_NAME,
  SCORE_CONTAINS_NAME,
  SCORE_EXACT_PHONE,
  SCORE_CONTAINS_PHONE,
  SCORE_KEYWORD,
  __setFirestoreForTests,
} = require('../core/contact_search');
__setFirestoreForTests(mockFs);

function makeDoc(id, data) {
  return { id, data: () => data };
}

beforeEach(() => {
  mockContactDocs = [];
  mockContactsGetThrows = false;
});

// ── _scoreContact ─────────────────────────────────────────────────────────────
describe('_scoreContact', () => {
  function makeContact(overrides) {
    return Object.assign({ phone: '111', name: 'Ana Garcia', keywords: [] }, overrides);
  }

  test('exact name match => SCORE_EXACT_NAME', () => {
    const s = _scoreContact(makeContact({ name: 'ana garcia' }), 'ana garcia');
    expect(s).toBe(SCORE_EXACT_NAME);
  });

  test('prefix name match => SCORE_PREFIX_NAME', () => {
    const s = _scoreContact(makeContact({ name: 'Ana Garcia Lopez' }), 'Ana Garcia');
    expect(s).toBe(SCORE_PREFIX_NAME);
  });

  test('contains name match => SCORE_CONTAINS_NAME', () => {
    const s = _scoreContact(makeContact({ name: 'Dr. Ana Garcia' }), 'Ana');
    expect(s).toBe(SCORE_CONTAINS_NAME);
  });

  test('exact phone match => SCORE_EXACT_PHONE', () => {
    const s = _scoreContact(makeContact({ name: 'X', phone: '5571234567' }), '5571234567');
    expect(s).toBe(SCORE_EXACT_PHONE);
  });

  test('contains phone match => SCORE_CONTAINS_PHONE', () => {
    const s = _scoreContact(makeContact({ name: 'X', phone: '5571234567' }), '71234');
    expect(s).toBe(SCORE_CONTAINS_PHONE);
  });

  test('keyword match => SCORE_KEYWORD', () => {
    const s = _scoreContact(makeContact({ name: 'X', keywords: ['cliente vip', 'premium'] }), 'vip');
    expect(s).toBe(SCORE_KEYWORD);
  });

  test('no match => 0', () => {
    const s = _scoreContact(makeContact({ name: 'Carlos', phone: '999' }), 'xyz123');
    expect(s).toBe(0);
  });

  test('exact name + exact phone => suma ambos scores', () => {
    const s = _scoreContact(makeContact({ name: 'test', phone: 'test' }), 'test');
    expect(s).toBe(SCORE_EXACT_NAME + SCORE_EXACT_PHONE);
  });

  test('keywords no-array usa []', () => {
    const s = _scoreContact(makeContact({ name: 'X', keywords: null }), 'vip');
    expect(s).toBe(0);
  });

  test('name null usa empty string', () => {
    const s = _scoreContact(makeContact({ name: null, phone: '111' }), 'xyz');
    expect(s).toBe(0);
  });

  test('phone null usa empty string', () => {
    const s = _scoreContact(makeContact({ name: 'Ana', phone: null }), 'ana');
    expect(s).toBeGreaterThan(0);
  });

  test('solo keyword break despues de primer match', () => {
    const s = _scoreContact(makeContact({ keywords: ['vip', 'vip2'] }), 'vip');
    expect(s).toBe(SCORE_KEYWORD);
  });

  test('keyword en loop no matchea (kw.includes false branch)', () => {
    const s = _scoreContact({ phone: '111', name: 'X', keywords: ['fidelidad'] }, 'xyz');
    expect(s).toBe(0);
  });
});

// ── searchContacts ────────────────────────────────────────────────────────────
describe('searchContacts', () => {
  test('uid vacio retorna []', async () => {
    expect(await searchContacts('', 'ana')).toEqual([]);
  });

  test('query vacio retorna []', async () => {
    expect(await searchContacts('uid-abc', '')).toEqual([]);
  });

  test('query solo espacios retorna []', async () => {
    expect(await searchContacts('uid-abc', '   ')).toEqual([]);
  });

  test('Firestore error retorna []', async () => {
    mockContactsGetThrows = true;
    expect(await searchContacts('uid-abc', 'ana')).toEqual([]);
  });

  test('sin resultados => []', async () => {
    mockContactDocs = [makeDoc('111', { name: 'Carlos', keywords: [] })];
    const r = await searchContacts('uid-abc', 'xyz999');
    expect(r).toHaveLength(0);
  });

  test('exact name match retorna contacto con score', async () => {
    mockContactDocs = [makeDoc('555', { name: 'Ana Garcia', contextType: 'cliente', lastActivity: '2026-05-10' })];
    const r = await searchContacts('uid-abc', 'Ana Garcia');
    expect(r).toHaveLength(1);
    expect(r[0].phone).toBe('555');
    expect(r[0]._score).toBe(SCORE_EXACT_NAME);
  });

  test('ordena por score descendente', async () => {
    mockContactDocs = [
      makeDoc('111', { name: 'Maria Lopez', keywords: [] }),
      makeDoc('222', { name: 'Maria', keywords: [] }),
    ];
    const r = await searchContacts('uid-abc', 'Maria');
    expect(r[0].phone).toBe('222');
  });

  test('mismo score ordena por lastActivity (mas reciente primero)', async () => {
    mockContactDocs = [
      makeDoc('111', { name: 'Dr. Ana', lastActivity: '2026-01-01', keywords: [] }),
      makeDoc('222', { name: 'Sr. Ana', lastActivity: '2026-05-12', keywords: [] }),
    ];
    const r = await searchContacts('uid-abc', 'Ana');
    expect(r[0].phone).toBe('222');
  });

  test('mismo score: elemento[0] mas reciente => bTs < aTs => -1 (mantiene orden)', async () => {
    mockContactDocs = [
      makeDoc('111', { name: 'Dr. Ana', lastActivity: '2026-05-12', keywords: [] }),
      makeDoc('222', { name: 'Sr. Ana', lastActivity: '2026-01-01', keywords: [] }),
    ];
    const r = await searchContacts('uid-abc', 'Ana');
    expect(r[0].phone).toBe('111');
  });

  test('mismo score mismo lastActivity => orden estable', async () => {
    mockContactDocs = [
      makeDoc('111', { name: 'Dr. Ana', lastActivity: null, keywords: [] }),
      makeDoc('222', { name: 'Sr. Ana', lastActivity: null, keywords: [] }),
    ];
    const r = await searchContacts('uid-abc', 'Ana');
    expect(r).toHaveLength(2);
  });

  test('limita a MAX_RESULTS resultados', async () => {
    mockContactDocs = Array.from({ length: 25 }, function (_, i) {
      return makeDoc('5' + i, { name: 'Ana ' + i, keywords: [] });
    });
    const r = await searchContacts('uid-abc', 'Ana');
    expect(r).toHaveLength(MAX_RESULTS);
  });

  test('contacto sin name usa phone como name', async () => {
    mockContactDocs = [makeDoc('5571234567', {})];
    const r = await searchContacts('uid-abc', '5571234567');
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('5571234567');
  });

  test('contacto sin keywords usa []', async () => {
    mockContactDocs = [makeDoc('111', { name: 'Ana', keywords: null })];
    const r = await searchContacts('uid-abc', 'Ana');
    expect(r[0].keywords).toEqual([]);
  });

  test('contacto sin lastActivity usa null', async () => {
    mockContactDocs = [makeDoc('111', { name: 'Ana' })];
    const r = await searchContacts('uid-abc', 'Ana');
    expect(r[0].lastActivity).toBeNull();
  });

  test('busqueda por keyword', async () => {
    mockContactDocs = [makeDoc('111', { name: 'Carlos', keywords: ['premium', 'vip'] })];
    const r = await searchContacts('uid-abc', 'premium');
    expect(r).toHaveLength(1);
    expect(r[0]._score).toBe(SCORE_KEYWORD);
  });
});

// ── constantes exportadas ─────────────────────────────────────────────────────
describe('constantes', () => {
  test('MAX_RESULTS=20, scores correctos', () => {
    expect(MAX_RESULTS).toBe(20);
    expect(SCORE_EXACT_NAME).toBeGreaterThan(SCORE_PREFIX_NAME);
    expect(SCORE_PREFIX_NAME).toBeGreaterThan(SCORE_CONTAINS_NAME);
    expect(SCORE_EXACT_PHONE).toBeGreaterThan(SCORE_CONTAINS_PHONE);
  });
});
