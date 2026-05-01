'use strict';
const { exportConversations, serializeExport, __setFirestoreForTests } = require('../core/conversation_export');

function makeMockDb({ data=null, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (data) return { exists: true, data: () => data };
              return { exists: false };
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('exportConversations — validacion', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(exportConversations('')).rejects.toThrow('uid requerido');
  });
  test('lanza error si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    await expect(exportConversations('uid1')).rejects.toThrow('get error');
  });
});

describe('exportConversations — export completo', () => {
  test('retorna todos los campos requeridos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await exportConversations('uid1');
    expect(r).toHaveProperty('uid', 'uid1');
    expect(r).toHaveProperty('exportedAt');
    expect(r).toHaveProperty('totalConversations', 0);
    expect(r).toHaveProperty('totalMessages', 0);
    expect(r).toHaveProperty('data');
  });
  test('cuenta correctamente conversations y messages', async () => {
    const data = {
      conversations: {
        '+573001': [{ text: 'hola' }, { text: 'como estas' }],
        '+573002': [{ text: 'buenos dias' }]
      },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await exportConversations('uid1');
    expect(r.totalConversations).toBe(2);
    expect(r.totalMessages).toBe(3);
  });
  test('incluye contactType si includeContactTypes=true', async () => {
    const data = {
      conversations: { '+573001': [{ text: 'hola' }] },
      contactTypes: { '+573001': 'lead' }
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await exportConversations('uid1', { includeContactTypes: true });
    expect(r.data['+573001'].contactType).toBe('lead');
  });
  test('no incluye contactType si includeContactTypes no se pasa', async () => {
    const data = {
      conversations: { '+573001': [{ text: 'hola' }] },
      contactTypes: { '+573001': 'lead' }
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await exportConversations('uid1');
    expect(r.data['+573001'].contactType).toBeUndefined();
  });
});

describe('exportConversations — filtro por phone', () => {
  test('filtra por phone especifico', async () => {
    const data = {
      conversations: {
        '+573001': [{ text: 'a' }],
        '+573002': [{ text: 'b' }]
      },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await exportConversations('uid1', { phone: '+573001' });
    expect(r.totalConversations).toBe(1);
    expect('+573001' in r.data).toBe(true);
    expect('+573002' in r.data).toBe(false);
  });
  test('retorna vacio si phone no existe', async () => {
    const data = {
      conversations: { '+573001': [] },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await exportConversations('uid1', { phone: '+999' });
    expect(r.totalConversations).toBe(0);
  });
});

describe('serializeExport', () => {
  test('retorna JSON string valido', () => {
    const obj = { uid: 'uid1', data: { '+573001': { messages: [] } } };
    const str = serializeExport(obj);
    expect(typeof str).toBe('string');
    expect(() => JSON.parse(str)).not.toThrow();
  });
  test('lanza error si exportObj es null', () => {
    expect(() => serializeExport(null)).toThrow('exportObj requerido');
  });
});
