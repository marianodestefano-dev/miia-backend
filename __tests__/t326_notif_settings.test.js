'use strict';

const {
  createNotification, getNotifications, markAsRead,
  NOTIF_TYPES, __setFirestoreForTests: setNotifDb,
} = require('../core/notification_manager');

const {
  getSettings, updateSettings, ALLOWED_SETTINGS, DEFAULTS,
  __setFirestoreForTests: setSettingsDb,
} = require('../core/owner_settings');

const UID = 'uid_t326_test';

// Mock Firestore para notifications (usa snap.docs)
function makeNotifDb(notifDocs = []) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (!store[uid]) store[uid] = {};
              if (!store[uid][subCol]) store[uid][subCol] = {};
              if (opts && opts.merge) {
                store[uid][subCol][id] = { ...(store[uid][subCol][id] || {}), ...data };
              } else {
                store[uid][subCol][id] = { ...data };
              }
            },
            get: async () => {
              const d = store[uid] && store[uid][subCol] && store[uid][subCol][id];
              return { exists: !!d, data: () => d };
            },
          }),
          get: async () => ({
            docs: notifDocs.map(n => ({ data: () => n })),
          }),
        }),
      }),
    }),
  };
}

// Mock Firestore para settings (owners/{uid})
function makeSettingsDb(settingsData = null) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        get: async () => {
          if (settingsData !== null) return { exists: true, data: () => ({ settings: settingsData }) };
          return { exists: false };
        },
        set: async (data, opts) => {
          if (!store[uid]) store[uid] = {};
          if (opts && opts.merge) {
            store[uid] = { ...store[uid], ...data };
          } else {
            store[uid] = { ...data };
          }
        },
        collection: () => ({ doc: () => ({ set: async () => {}, get: async () => ({ exists: false }) }) }),
      }),
    }),
  };
}

describe('T326 -- notification_manager + owner_settings (24 tests)', () => {

  // NOTIF_TYPES
  test('NOTIF_TYPES frozen y contiene info/warning/error/success', () => {
    expect(() => { NOTIF_TYPES.push('extra'); }).toThrow();
    ['info', 'warning', 'error', 'success'].forEach(t => expect(NOTIF_TYPES).toContain(t));
  });

  // createNotification
  test('createNotification: uid null lanza', async () => {
    await expect(createNotification(null, { type: 'info', title: 'T', body: 'B' })).rejects.toThrow('uid requerido');
  });

  test('createNotification: type invalido lanza', async () => {
    setNotifDb(makeNotifDb());
    await expect(createNotification(UID, { type: 'critico', title: 'T', body: 'B' })).rejects.toThrow('type invalido');
  });

  test('createNotification: title null lanza', async () => {
    setNotifDb(makeNotifDb());
    await expect(createNotification(UID, { type: 'info', title: null, body: 'B' })).rejects.toThrow('title requerido');
  });

  test('createNotification: crea notif correctamente', async () => {
    setNotifDb(makeNotifDb());
    const r = await createNotification(UID, { type: 'success', title: 'Listo', body: 'Todo OK' });
    expect(r.type).toBe('success');
    expect(r.title).toBe('Listo');
    expect(r.read).toBe(false);
    expect(r.notifId).toMatch(/^n_/);
  });

  // getNotifications
  test('getNotifications: uid null lanza', async () => {
    await expect(getNotifications(null)).rejects.toThrow('uid requerido');
  });

  test('getNotifications: retorna lista de notifs', async () => {
    const docs = [
      { type: 'info', title: 'A', body: 'x', read: false, createdAt: '2026-05-01T10:00:00Z' },
      { type: 'warning', title: 'B', body: 'y', read: true, createdAt: '2026-05-01T09:00:00Z' },
    ];
    setNotifDb(makeNotifDb(docs));
    const r = await getNotifications(UID);
    expect(r.total).toBe(2);
    expect(r.notifications.length).toBe(2);
    // Ordenadas desc por createdAt
    expect(r.notifications[0].title).toBe('A');
  });

  test('getNotifications: unreadOnly filtra leidas', async () => {
    const docs = [
      { type: 'info', title: 'A', body: 'x', read: false, createdAt: '2026-05-01T10:00:00Z' },
      { type: 'warning', title: 'B', body: 'y', read: true, createdAt: '2026-05-01T09:00:00Z' },
    ];
    setNotifDb(makeNotifDb(docs));
    const r = await getNotifications(UID, { unreadOnly: true });
    expect(r.notifications.length).toBe(1);
    expect(r.notifications[0].title).toBe('A');
  });

  test('getNotifications: limit respetado', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      type: 'info', title: `N${i}`, body: 'x', read: false, createdAt: `2026-05-01T${String(i).padStart(2,'0')}:00:00Z`
    }));
    setNotifDb(makeNotifDb(docs));
    const r = await getNotifications(UID, { limit: 3 });
    expect(r.notifications.length).toBe(3);
    expect(r.total).toBe(10);
  });

  test('getNotifications: Firestore error retorna [] con error', async () => {
    const brokenDb = { collection: () => { throw new Error('down'); } };
    setNotifDb(brokenDb);
    const r = await getNotifications(UID);
    expect(r.notifications).toEqual([]);
    expect(r.error).toBeDefined();
  });

  // markAsRead
  test('markAsRead: uid/notifId null lanza', async () => {
    await expect(markAsRead(null, 'n_123')).rejects.toThrow();
  });

  test('markAsRead: retorna { uid, notifId, read: true }', async () => {
    setNotifDb(makeNotifDb());
    const r = await markAsRead(UID, 'n_12345');
    expect(r.read).toBe(true);
    expect(r.notifId).toBe('n_12345');
  });

  // ALLOWED_SETTINGS / DEFAULTS
  test('ALLOWED_SETTINGS frozen', () => {
    expect(() => { ALLOWED_SETTINGS.hackKey = 'string'; }).toThrow();
  });

  test('DEFAULTS frozen', () => {
    expect(() => { DEFAULTS.language = 'en'; }).toThrow();
  });

  test('DEFAULTS.language=es, timezone=America/Bogota, aiEnabled=true', () => {
    expect(DEFAULTS.language).toBe('es');
    expect(DEFAULTS.timezone).toBe('America/Bogota');
    expect(DEFAULTS.aiEnabled).toBe(true);
  });

  // getSettings
  test('getSettings: uid null lanza', async () => {
    await expect(getSettings(null)).rejects.toThrow('uid requerido');
  });

  test('getSettings: doc no existe -> defaults', async () => {
    setSettingsDb(makeSettingsDb(null));
    const r = await getSettings(UID);
    expect(r.settings.language).toBe('es');
    expect(r.settings.aiEnabled).toBe(true);
  });

  test('getSettings: merge saved con defaults', async () => {
    setSettingsDb(makeSettingsDb({ language: 'en', maxResponseLength: 300 }));
    const r = await getSettings(UID);
    expect(r.settings.language).toBe('en');
    expect(r.settings.maxResponseLength).toBe(300);
    expect(r.settings.aiEnabled).toBe(true); // default aplicado
  });

  test('getSettings: Firestore error -> defaults sin crash', async () => {
    const brokenDb = { collection: () => { throw new Error('down'); } };
    setSettingsDb(brokenDb);
    const r = await getSettings(UID);
    expect(r.settings.language).toBe('es');
    expect(r.error).toBeDefined();
  });

  // updateSettings
  test('updateSettings: uid null lanza', async () => {
    await expect(updateSettings(null, { language: 'en' })).rejects.toThrow('uid requerido');
  });

  test('updateSettings: updates no objeto lanza', async () => {
    setSettingsDb(makeSettingsDb(null));
    await expect(updateSettings(UID, null)).rejects.toThrow('updates debe ser un objeto');
  });

  test('updateSettings: key no permitida lanza', async () => {
    setSettingsDb(makeSettingsDb(null));
    await expect(updateSettings(UID, { hackKey: 'x' })).rejects.toThrow('Settings inválidos');
  });

  test('updateSettings: tipo incorrecto lanza', async () => {
    setSettingsDb(makeSettingsDb(null));
    await expect(updateSettings(UID, { aiEnabled: 'si' })).rejects.toThrow('Settings inválidos');
  });

  test('updateSettings: actualiza correctamente', async () => {
    setSettingsDb(makeSettingsDb(null));
    const r = await updateSettings(UID, { language: 'en', maxResponseLength: 300 });
    expect(r.updatedKeys).toContain('language');
    expect(r.updatedKeys).toContain('maxResponseLength');
    expect(r.updatedAt).toBeDefined();
  });
});
