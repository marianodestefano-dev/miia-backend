'use strict';
const { getContactHistory, DEFAULT_LIMIT, MAX_LIMIT, __setFirestoreForTests } = require('../core/contact_history');

function makeMockDb({ conversations=null, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (conversations) return { exists: true, data: () => ({ conversations }) };
              return { exists: false };
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('constantes', () => {
  test('DEFAULT_LIMIT=50, MAX_LIMIT=200', () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_LIMIT).toBe(200);
  });
});

describe('getContactHistory — validacion', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getContactHistory('', '+573001')).rejects.toThrow('uid requerido');
  });
  test('lanza error si phone vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getContactHistory('uid1', '')).rejects.toThrow('phone requerido');
  });
});

describe('getContactHistory — resultados basicos', () => {
  test('retorna mensajes del contacto ordenados por timestamp desc', async () => {
    const conversations = {
      '+573001': [
        { text: 'primero', timestamp: 1000 },
        { text: 'ultimo', timestamp: 3000 },
        { text: 'medio', timestamp: 2000 }
      ]
    };
    __setFirestoreForTests(makeMockDb({ conversations }));
    const r = await getContactHistory('uid1', '+573001');
    expect(r.messages[0].text).toBe('ultimo'); // mas reciente primero
    expect(r.messages[1].text).toBe('medio');
    expect(r.messages[2].text).toBe('primero');
  });

  test('retorna [] si el phone no tiene historial', async () => {
    const conversations = { '+573002': [] };
    __setFirestoreForTests(makeMockDb({ conversations }));
    const r = await getContactHistory('uid1', '+573001');
    expect(r.messages).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  test('retorna [] con Firestore vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getContactHistory('uid1', '+573001');
    expect(r.messages).toEqual([]);
  });
});

describe('getContactHistory — paginacion', () => {
  test('hasMore=true si hay mas mensajes que el limite', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ text: `m${i}`, timestamp: i * 100 }));
    const conversations = { '+573001': msgs };
    __setFirestoreForTests(makeMockDb({ conversations }));
    const r = await getContactHistory('uid1', '+573001', { limit: 5 });
    expect(r.hasMore).toBe(true);
    expect(r.messages.length).toBe(5);
    expect(r.nextCursor).not.toBeNull();
  });

  test('hasMore=false si todos los mensajes caben en el limite', async () => {
    const msgs = [{ text: 'a', timestamp: 100 }, { text: 'b', timestamp: 200 }];
    const conversations = { '+573001': msgs };
    __setFirestoreForTests(makeMockDb({ conversations }));
    const r = await getContactHistory('uid1', '+573001', { limit: 10 });
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  test('before cursor filtra mensajes anteriores al timestamp', async () => {
    const msgs = [
      { text: 'viejo', timestamp: 100 },
      { text: 'medio', timestamp: 500 },
      { text: 'nuevo', timestamp: 900 }
    ];
    const conversations = { '+573001': msgs };
    __setFirestoreForTests(makeMockDb({ conversations }));
    const r = await getContactHistory('uid1', '+573001', { before: 600 });
    expect(r.messages.length).toBe(2); // solo los < 600
    expect(r.messages.some(m => m.text === 'nuevo')).toBe(false);
  });

  test('limite se clampea a MAX_LIMIT=200', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ text: `m${i}`, timestamp: i }));
    const conversations = { '+573001': msgs };
    __setFirestoreForTests(makeMockDb({ conversations }));
    const r = await getContactHistory('uid1', '+573001', { limit: 999 });
    expect(r.messages.length).toBe(10); // solo hay 10
  });
});

describe('getContactHistory — resiliencia', () => {
  test('retorna [] si Firestore falla, no lanza', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getContactHistory('uid1', '+573001');
    expect(r.messages).toEqual([]);
    expect(r.error).toBeDefined();
  });
});
