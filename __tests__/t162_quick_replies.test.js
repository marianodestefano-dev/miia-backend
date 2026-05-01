'use strict';

const {
  saveQuickReply, getQuickReplies, deleteQuickReply, suggestReplies, findByShortcut,
  BUILT_IN_CATEGORIES, MAX_REPLIES_PER_OWNER, MAX_SHORTCUT_LENGTH, MAX_TEXT_LENGTH,
  __setFirestoreForTests,
} = require('../core/quick_replies');

const UID = 'testUid1234567890';
const SAMPLE_REPLIES = [
  { id: 'r1', shortcut: 'precio', text: 'Precios desde $50.', category: 'pricing', tags: ['precio', 'costo'], active: true },
  { id: 'r2', shortcut: 'horario', text: 'Atendemos de 9 a 18.', category: 'hours', tags: ['horario', 'hora'], active: true },
  { id: 'r3', shortcut: 'hola', text: 'Hola! Bienvenido!', category: 'greeting', tags: ['saludo'], active: true },
  { id: 'r4', shortcut: 'inactivo', text: 'No deberias ver esto.', category: 'general', tags: [], active: false },
];

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({ set: async () => { if (throwSet) throw new Error('set error'); } }),
      where: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          const items = docs.map((d, i) => ({ id: d.id || 'r' + i, data: () => d }));
          return { forEach: fn => items.forEach(fn) };
        },
      }),
    })})})
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('BUILT_IN_CATEGORIES y constants', () => {
  test('tiene 6 categorias', () => { expect(BUILT_IN_CATEGORIES.length).toBe(6); });
  test('contiene greeting y pricing', () => {
    expect(BUILT_IN_CATEGORIES).toContain('greeting');
    expect(BUILT_IN_CATEGORIES).toContain('pricing');
  });
  test('es frozen', () => { expect(() => { BUILT_IN_CATEGORIES.push('x'); }).toThrow(); });
  test('MAX_REPLIES_PER_OWNER es 200', () => { expect(MAX_REPLIES_PER_OWNER).toBe(200); });
});

describe('saveQuickReply - validacion', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveQuickReply(undefined, { shortcut: 'hola', text: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si reply undefined', async () => {
    await expect(saveQuickReply(UID, undefined)).rejects.toThrow('reply requerido');
  });
  test('lanza si shortcut undefined', async () => {
    await expect(saveQuickReply(UID, { text: 'x' })).rejects.toThrow('shortcut requerido');
  });
  test('lanza si shortcut muy largo', async () => {
    await expect(saveQuickReply(UID, { shortcut: 'a'.repeat(MAX_SHORTCUT_LENGTH + 1), text: 'x' })).rejects.toThrow('largo');
  });
  test('lanza si text undefined', async () => {
    await expect(saveQuickReply(UID, { shortcut: 'hola' })).rejects.toThrow('text requerido');
  });
  test('lanza si text muy largo', async () => {
    await expect(saveQuickReply(UID, { shortcut: 'hola', text: 'a'.repeat(MAX_TEXT_LENGTH + 1) })).rejects.toThrow('largo');
  });
});

describe('saveQuickReply - resultado', () => {
  test('guarda con defaults correctos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await saveQuickReply(UID, { shortcut: 'Precio', text: 'Desde $50.' });
    expect(r.shortcut).toBe('precio');
    expect(r.category).toBe('general');
    expect(r.active).toBe(true);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveQuickReply(UID, { shortcut: 'hola', text: 'x' })).rejects.toThrow('set error');
  });
});

describe('getQuickReplies', () => {
  test('lanza si uid undefined', async () => {
    await expect(getQuickReplies(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna replies del db', async () => {
    __setFirestoreForTests(makeMockDb({ docs: SAMPLE_REPLIES }));
    const r = await getQuickReplies(UID);
    expect(r.length).toBe(4);
  });
  test('fail-open retorna vacio', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getQuickReplies(UID)).toEqual([]);
  });
});

describe('deleteQuickReply', () => {
  test('lanza si uid undefined', async () => {
    await expect(deleteQuickReply(undefined, 'r1')).rejects.toThrow('uid');
  });
  test('lanza si id undefined', async () => {
    await expect(deleteQuickReply(UID, undefined)).rejects.toThrow('id');
  });
  test('desactiva sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deleteQuickReply(UID, 'r1')).resolves.toBeUndefined();
  });
});

describe('suggestReplies', () => {
  test('lanza si replies no es array', () => {
    expect(() => suggestReplies('nope', 'hola')).toThrow('debe ser array');
  });
  test('retorna vacio para mensaje vacio', () => {
    expect(suggestReplies(SAMPLE_REPLIES, '')).toEqual([]);
  });
  test('sugiere reply por shortcut exacto', () => {
    const r = suggestReplies(SAMPLE_REPLIES, 'cual es el precio?');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].shortcut).toBe('precio');
  });
  test('sugiere reply por tags', () => {
    const r = suggestReplies(SAMPLE_REPLIES, 'que horario tienen?');
    expect(r.some(x => x.shortcut === 'horario')).toBe(true);
  });
  test('no incluye replies inactivos', () => {
    const r = suggestReplies(SAMPLE_REPLIES, 'inactivo');
    expect(r.some(x => x.shortcut === 'inactivo')).toBe(false);
  });
  test('retorna maximo 5', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      shortcut: 'r' + i, text: 'hola texto', tags: ['hola'], active: true,
    }));
    expect(suggestReplies(many, 'hola como estas').length).toBeLessThanOrEqual(5);
  });
  test('no incluye _score en resultado', () => {
    const r = suggestReplies(SAMPLE_REPLIES, 'precio');
    r.forEach(item => expect(item._score).toBeUndefined());
  });
});

describe('findByShortcut', () => {
  test('lanza si replies no es array', () => {
    expect(() => findByShortcut('nope', 'hola')).toThrow('debe ser array');
  });
  test('retorna null si shortcut undefined', () => {
    expect(findByShortcut(SAMPLE_REPLIES, undefined)).toBeNull();
  });
  test('encuentra por shortcut exacto', () => {
    const r = findByShortcut(SAMPLE_REPLIES, 'precio');
    expect(r).not.toBeNull();
    expect(r.shortcut).toBe('precio');
  });
  test('busqueda case-insensitive', () => {
    expect(findByShortcut(SAMPLE_REPLIES, 'PRECIO')).not.toBeNull();
  });
  test('retorna null para inactivo', () => {
    expect(findByShortcut(SAMPLE_REPLIES, 'inactivo')).toBeNull();
  });
  test('retorna null si no existe', () => {
    expect(findByShortcut(SAMPLE_REPLIES, 'nonexistent')).toBeNull();
  });
});
