'use strict';

// T263 notification_engine — suite completa
const {
  buildNotificationRecord,
  buildNotificationBody,
  scheduleNotification,
  saveNotification,
  getNotification,
  updateNotificationStatus,
  getPendingNotifications,
  getScheduledNotifications,
  buildNotificationSummaryText,
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_PRIORITIES,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  __setFirestoreForTests: setDb,
} = require('../core/notification_engine');

const UID = 'notif263Uid';
const PHONE = '+5491155554444';
const FUTURE = Date.now() + 60 * 60 * 1000;
const NOW = Date.now();

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
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
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('notification_engine — constantes', () => {
  test('NOTIFICATION_TYPES tiene tipos clave', () => {
    ['appointment_reminder', 'payment_received', 'new_lead', 'follow_up_due', 'system_alert', 'custom'].forEach(t =>
      expect(NOTIFICATION_TYPES).toContain(t)
    );
  });
  test('NOTIFICATION_CHANNELS tiene whatsapp y email', () => {
    expect(NOTIFICATION_CHANNELS).toContain('whatsapp');
    expect(NOTIFICATION_CHANNELS).toContain('email');
    expect(NOTIFICATION_CHANNELS).toContain('push');
  });
  test('NOTIFICATION_STATUSES tiene pending, sent, read', () => {
    ['pending', 'scheduled', 'sent', 'failed', 'cancelled', 'read'].forEach(s =>
      expect(NOTIFICATION_STATUSES).toContain(s)
    );
  });
  test('NOTIFICATION_PRIORITIES tiene urgent y low', () => {
    ['low', 'normal', 'high', 'urgent'].forEach(p =>
      expect(NOTIFICATION_PRIORITIES).toContain(p)
    );
  });
  test('MAX_NOTIFICATION_BODY_LENGTH es 2000', () => {
    expect(MAX_NOTIFICATION_BODY_LENGTH).toBe(2000);
  });
  test('MAX_NOTIFICATION_TITLE_LENGTH es 120', () => {
    expect(MAX_NOTIFICATION_TITLE_LENGTH).toBe(120);
  });
});

// ─── buildNotificationRecord ──────────────────────────────────────────────────
describe('buildNotificationRecord', () => {
  test('defaults correctos', () => {
    const n = buildNotificationRecord(UID, { type: 'new_lead', body: 'Nuevo contacto!' });
    expect(n.uid).toBe(UID);
    expect(n.type).toBe('new_lead');
    expect(n.status).toBe('pending');
    expect(n.channel).toBe('whatsapp');
    expect(n.priority).toBe('normal');
    expect(n.sentAt).toBeNull();
    expect(n.readAt).toBeNull();
    expect(n.metadata).toEqual({});
  });
  test('type invalido cae a custom', () => {
    const n = buildNotificationRecord(UID, { type: 'fake_type' });
    expect(n.type).toBe('custom');
  });
  test('channel invalido cae a whatsapp', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', channel: 'telepathy' });
    expect(n.channel).toBe('whatsapp');
  });
  test('status invalido cae a pending', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', status: 'borrado' });
    expect(n.status).toBe('pending');
  });
  test('priority invalida cae a normal', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', priority: 'mega_urgent' });
    expect(n.priority).toBe('normal');
  });
  test('body se trunca a MAX_NOTIFICATION_BODY_LENGTH', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', body: 'X'.repeat(3000) });
    expect(n.body.length).toBe(2000);
  });
  test('title se trunca a MAX_NOTIFICATION_TITLE_LENGTH', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', title: 'T'.repeat(200) });
    expect(n.title.length).toBe(120);
  });
  test('recipientPhone y recipientEmail se guardan', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', recipientPhone: PHONE, recipientEmail: 'a@b.com' });
    expect(n.recipientPhone).toBe(PHONE);
    expect(n.recipientEmail).toBe('a@b.com');
  });
  test('notificationId se puede forzar', () => {
    const n = buildNotificationRecord(UID, { type: 'custom', notificationId: 'notif_custom_001' });
    expect(n.notificationId).toBe('notif_custom_001');
  });
});

// ─── buildNotificationBody ────────────────────────────────────────────────────
describe('buildNotificationBody', () => {
  test('appointment_reminder incluye nombre y negocio', () => {
    const b = buildNotificationBody('appointment_reminder', { contactName: 'Ana', businessName: 'Salon', datetime: '2026-06-01 10:00' });
    expect(b).toContain('Ana');
    expect(b).toContain('Salon');
    expect(b).toContain('2026-06-01');
  });
  test('appointment_confirmation menciona confirmado', () => {
    const b = buildNotificationBody('appointment_confirmation', { contactName: 'Juan', datetime: '2026-06-01 11:00' });
    expect(b).toContain('Juan');
    expect(b.toLowerCase()).toContain('confirm');
  });
  test('appointment_cancellation menciona cancelado', () => {
    const b = buildNotificationBody('appointment_cancellation', { contactName: 'Laura' });
    expect(b).toContain('Laura');
    expect(b.toLowerCase()).toContain('cancel');
  });
  test('payment_received incluye monto', () => {
    const b = buildNotificationBody('payment_received', { amount: '5000', currency: 'ARS', name: 'Carlos' });
    expect(b).toContain('5000');
    expect(b).toContain('ARS');
    expect(b).toContain('Carlos');
  });
  test('payment_failed menciona problema', () => {
    const b = buildNotificationBody('payment_failed', { amount: '1000', currency: 'USD' });
    expect(b).toContain('problema');
  });
  test('new_lead incluye nombre si existe', () => {
    const b = buildNotificationBody('new_lead', { contactName: 'Pedro', businessName: 'TiendaX' });
    expect(b).toContain('Pedro');
    expect(b).toContain('TiendaX');
  });
  test('follow_up_due menciona seguimiento', () => {
    const b = buildNotificationBody('follow_up_due', { contactName: 'Maria' });
    expect(b).toContain('Maria');
    expect(b.toLowerCase()).toContain('seguimiento');
  });
  test('broadcast_complete menciona el nombre', () => {
    const b = buildNotificationBody('broadcast_complete', { broadcastName: 'Promo Verano' });
    expect(b).toContain('Promo Verano');
  });
  test('system_alert incluye mensaje', () => {
    const b = buildNotificationBody('system_alert', { message: 'Conexion perdida' });
    expect(b).toContain('Conexion perdida');
  });
  test('custom usa body o message si existe', () => {
    const b = buildNotificationBody('custom', { body: 'Mensaje personalizado' });
    expect(b).toContain('Mensaje personalizado');
  });
  test('tipo sin params no lanza error', () => {
    expect(() => buildNotificationBody('new_lead')).not.toThrow();
  });
});

// ─── scheduleNotification ─────────────────────────────────────────────────────
describe('scheduleNotification', () => {
  test('cambia status a scheduled', () => {
    const n = buildNotificationRecord(UID, { type: 'appointment_reminder' });
    const scheduled = scheduleNotification(n, FUTURE);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt).toBe(FUTURE);
  });
  test('timestamp pasado lanza error', () => {
    const n = buildNotificationRecord(UID, { type: 'custom' });
    expect(() => scheduleNotification(n, Date.now() - 1000)).toThrow('futuro');
  });
  test('notificacion no pending lanza error', () => {
    const n = { ...buildNotificationRecord(UID, { type: 'custom' }), status: 'sent' };
    expect(() => scheduleNotification(n, FUTURE)).toThrow('pending');
  });
});

// ─── saveNotification + getNotification ───────────────────────────────────────
describe('saveNotification + getNotification', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const n = buildNotificationRecord(UID, { type: 'new_lead', body: 'Hola!', channel: 'whatsapp', priority: 'high', recipientPhone: PHONE });
    const savedId = await saveNotification(UID, n);
    expect(savedId).toBe(n.notificationId);
    const loaded = await getNotification(UID, n.notificationId);
    expect(loaded.type).toBe('new_lead');
    expect(loaded.priority).toBe('high');
    expect(loaded.recipientPhone).toBe(PHONE);
  });
  test('getNotification retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getNotification(UID, 'notif_no_existe');
    expect(loaded).toBeNull();
  });
  test('saveNotification con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const n = buildNotificationRecord(UID, { type: 'custom' });
    await expect(saveNotification(UID, n)).rejects.toThrow('set error');
  });
  test('getNotification con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getNotification(UID, 'notif_001');
    expect(loaded).toBeNull();
  });
});

// ─── updateNotificationStatus ─────────────────────────────────────────────────
describe('updateNotificationStatus', () => {
  test('actualiza a sent', async () => {
    setDb(makeMockDb());
    const id = await updateNotificationStatus(UID, 'notif_001', 'sent');
    expect(id).toBe('notif_001');
  });
  test('actualiza a read', async () => {
    const db = makeMockDb();
    setDb(db);
    const n = buildNotificationRecord(UID, { type: 'custom', notificationId: 'notif_001' });
    await saveNotification(UID, n);
    await updateNotificationStatus(UID, 'notif_001', 'read');
    const loaded = await getNotification(UID, 'notif_001');
    expect(loaded.readAt).toBeDefined();
  });
  test('status invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(updateNotificationStatus(UID, 'notif_001', 'fake_status')).rejects.toThrow('status invalido');
  });
  test('throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(updateNotificationStatus(UID, 'notif_001', 'cancelled')).rejects.toThrow('set error');
  });
});

// ─── getPendingNotifications ──────────────────────────────────────────────────
describe('getPendingNotifications', () => {
  test('retorna pendientes', async () => {
    const n1 = buildNotificationRecord(UID, { type: 'new_lead', status: 'pending' });
    const n2 = buildNotificationRecord(UID, { type: 'follow_up_due', status: 'pending' });
    n2.notificationId = n2.notificationId + '_2';
    const n3 = { ...buildNotificationRecord(UID, { type: 'custom' }), status: 'sent' };
    n3.notificationId = n3.notificationId + '_3';
    setDb(makeMockDb({ stored: { [n1.notificationId]: n1, [n2.notificationId]: n2, [n3.notificationId]: n3 } }));
    const pending = await getPendingNotifications(UID);
    expect(pending.every(n => n.status === 'pending')).toBe(true);
    expect(pending.length).toBe(2);
  });
  test('filtra por opts.before usando scheduledAt', async () => {
    const n1 = { ...buildNotificationRecord(UID, { type: 'custom' }), status: 'pending', scheduledAt: NOW - 5000 };
    const n2 = { ...buildNotificationRecord(UID, { type: 'custom' }), status: 'pending', scheduledAt: NOW + 999999 };
    n2.notificationId = n2.notificationId + '_2';
    setDb(makeMockDb({ stored: { [n1.notificationId]: n1, [n2.notificationId]: n2 } }));
    const pending = await getPendingNotifications(UID, { before: NOW });
    expect(pending.length).toBe(1);
    expect(pending[0].scheduledAt).toBe(NOW - 5000);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const pending = await getPendingNotifications(UID);
    expect(pending).toEqual([]);
  });
});

// ─── getScheduledNotifications ────────────────────────────────────────────────
describe('getScheduledNotifications', () => {
  test('retorna solo las agendadas', async () => {
    const n1 = { ...buildNotificationRecord(UID, { type: 'appointment_reminder' }), status: 'scheduled', scheduledAt: FUTURE };
    const n2 = { ...buildNotificationRecord(UID, { type: 'follow_up_due' }), status: 'pending' };
    n2.notificationId = n2.notificationId + '_2';
    setDb(makeMockDb({ stored: { [n1.notificationId]: n1, [n2.notificationId]: n2 } }));
    const scheduled = await getScheduledNotifications(UID);
    expect(scheduled.every(n => n.status === 'scheduled')).toBe(true);
    expect(scheduled.length).toBe(1);
  });
  test('filtra por opts.before', async () => {
    const n1 = { ...buildNotificationRecord(UID, { type: 'custom' }), status: 'scheduled', scheduledAt: NOW + 1000 };
    const n2 = { ...buildNotificationRecord(UID, { type: 'custom' }), status: 'scheduled', scheduledAt: NOW + 999999999 };
    n2.notificationId = n2.notificationId + '_2';
    setDb(makeMockDb({ stored: { [n1.notificationId]: n1, [n2.notificationId]: n2 } }));
    const scheduled = await getScheduledNotifications(UID, { before: NOW + 5000 });
    expect(scheduled.length).toBe(1);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const scheduled = await getScheduledNotifications(UID);
    expect(scheduled).toEqual([]);
  });
});

// ─── buildNotificationSummaryText ─────────────────────────────────────────────
describe('buildNotificationSummaryText', () => {
  test('retorna mensaje si null', () => {
    expect(buildNotificationSummaryText(null)).toContain('no encontrada');
  });
  test('incluye tipo y estado', () => {
    const n = buildNotificationRecord(UID, { type: 'new_lead', title: 'Lead nuevo', body: 'Carlos pregunto!' });
    const text = buildNotificationSummaryText(n);
    expect(text).toContain('new_lead');
    expect(text).toContain('pending');
    expect(text).toContain('Carlos pregunto!');
  });
  test('incluye canal y prioridad', () => {
    const n = buildNotificationRecord(UID, { type: 'system_alert', channel: 'email', priority: 'urgent' });
    const text = buildNotificationSummaryText(n);
    expect(text).toContain('email');
    expect(text).toContain('urgent');
  });
  test('incluye fecha agendada si scheduledAt', () => {
    const n = buildNotificationRecord(UID, { type: 'appointment_reminder' });
    const scheduled = scheduleNotification(n, FUTURE);
    const text = buildNotificationSummaryText(scheduled);
    expect(text).toContain('Agendada');
  });
});
