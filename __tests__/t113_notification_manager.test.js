'use strict';
const { createNotification, getNotifications, markAsRead, NOTIF_TYPES, __setFirestoreForTests } = require('../core/notification_manager');

function makeMockDb(docs = []) {
  const store = {};
  docs.forEach(d => { store[d.notifId] = d; });
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => ({ docs: Object.values(store).map(d => ({ data: () => d })) }),
          doc: (id) => ({
            set: async (data, opts) => {
              store[id] = (opts && opts.merge) ? Object.assign({}, store[id] || {}, data) : data;
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('NOTIF_TYPES', () => {
  test('incluye info/warning/error/success y frozen', () => {
    expect(NOTIF_TYPES).toContain('info');
    expect(NOTIF_TYPES).toContain('warning');
    expect(() => { NOTIF_TYPES.push('x'); }).toThrow();
  });
});

describe('createNotification', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(createNotification('', { type: 'info', title: 't', body: 'b' })).rejects.toThrow('uid requerido');
  });
  test('lanza error si type invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(createNotification('uid1', { type: 'hack', title: 't', body: 'b' })).rejects.toThrow('type invalido');
  });
  test('crea notificacion con todos los campos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await createNotification('uid1', { type: 'success', title: 'Listo', body: 'Todo OK' });
    expect(r.notifId).toBeDefined();
    expect(r.read).toBe(false);
    expect(r.type).toBe('success');
  });
});

describe('getNotifications', () => {
  test('retorna todas las notificaciones', async () => {
    const docs = [
      { notifId: 'n1', type: 'info', read: false, createdAt: '2026-01-01T00:00:00Z' },
      { notifId: 'n2', type: 'warning', read: true, createdAt: '2026-01-02T00:00:00Z' }
    ];
    __setFirestoreForTests(makeMockDb(docs));
    const r = await getNotifications('uid1');
    expect(r.notifications.length).toBe(2);
  });
  test('filtra solo no leidas con unreadOnly=true', async () => {
    const docs = [
      { notifId: 'n1', read: false, createdAt: '2026-01-01T' },
      { notifId: 'n2', read: true, createdAt: '2026-01-02T' }
    ];
    __setFirestoreForTests(makeMockDb(docs));
    const r = await getNotifications('uid1', { unreadOnly: true });
    expect(r.notifications.length).toBe(1);
    expect(r.notifications[0].notifId).toBe('n1');
  });
  test('fail-open si Firestore falla', async () => {
    __setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { throw new Error('err'); } }) }) })
    });
    const r = await getNotifications('uid1');
    expect(r.notifications).toEqual([]);
    expect(r.error).toBeDefined();
  });
});

describe('markAsRead', () => {
  test('marca notificacion como leida', async () => {
    __setFirestoreForTests(makeMockDb([{ notifId: 'n1', read: false }]));
    const r = await markAsRead('uid1', 'n1');
    expect(r.read).toBe(true);
  });
  test('lanza error si uid o notifId vacios', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(markAsRead('', 'n1')).rejects.toThrow('uid y notifId requeridos');
  });
});
