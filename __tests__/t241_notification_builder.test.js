'use strict';

const {
  buildNotificationRecord, saveNotification, updateNotificationStatus,
  getRecentNotifications, hasSentRecentNotification, buildNotificationText,
  buildNewLeadText, buildSpamAlertText, buildHandoffText,
  buildDailySummaryText, buildSystemAlertText,
  isValidType, isValidPriority, getPriorityForType,
  NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES, NOTIFICATION_STATUSES,
  MAX_NOTIFICATIONS_STORED, DIGEST_COOLDOWN_MS, SUPPRESSION_WINDOW_MS,
  __setFirestoreForTests,
} = require('../core/notification_builder');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

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
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
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
  test('NOTIFICATION_TYPES tiene 12 tipos', () => { expect(NOTIFICATION_TYPES.length).toBe(12); });
  test('frozen NOTIFICATION_TYPES', () => { expect(() => { NOTIFICATION_TYPES.push('x'); }).toThrow(); });
  test('NOTIFICATION_PRIORITIES tiene 4 niveles', () => { expect(NOTIFICATION_PRIORITIES.length).toBe(4); });
  test('frozen NOTIFICATION_PRIORITIES', () => { expect(() => { NOTIFICATION_PRIORITIES.push('x'); }).toThrow(); });
  test('NOTIFICATION_STATUSES tiene 4 estados', () => { expect(NOTIFICATION_STATUSES.length).toBe(4); });
  test('frozen NOTIFICATION_STATUSES', () => { expect(() => { NOTIFICATION_STATUSES.push('x'); }).toThrow(); });
  test('MAX_NOTIFICATIONS_STORED es 200', () => { expect(MAX_NOTIFICATIONS_STORED).toBe(200); });
  test('DIGEST_COOLDOWN_MS es 23h', () => { expect(DIGEST_COOLDOWN_MS).toBe(23 * 60 * 60 * 1000); });
  test('SUPPRESSION_WINDOW_MS es 5min', () => { expect(SUPPRESSION_WINDOW_MS).toBe(5 * 60 * 1000); });
});

describe('isValidType / isValidPriority / getPriorityForType', () => {
  test('new_lead es tipo valido', () => { expect(isValidType('new_lead')).toBe(true); });
  test('unknown no es valido', () => { expect(isValidType('unknown')).toBe(false); });
  test('critical es prioridad valida', () => { expect(isValidPriority('critical')).toBe(true); });
  test('urgent no es valida', () => { expect(isValidPriority('urgent')).toBe(false); });
  test('otp_requested es critical', () => { expect(getPriorityForType('otp_requested')).toBe('critical'); });
  test('spam_detected es critical', () => { expect(getPriorityForType('spam_detected')).toBe('critical'); });
  test('new_lead es high', () => { expect(getPriorityForType('new_lead')).toBe('high'); });
  test('daily_summary es low', () => { expect(getPriorityForType('daily_summary')).toBe('low'); });
  test('catalog_updated es normal', () => { expect(getPriorityForType('catalog_updated')).toBe('normal'); });
});

describe('buildNotificationRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildNotificationRecord(undefined, 'new_lead', {})).toThrow('uid requerido');
  });
  test('lanza si type invalido', () => {
    expect(() => buildNotificationRecord(UID, 'invalid_type', {})).toThrow('type invalido');
  });
  test('construye record correctamente', () => {
    const r = buildNotificationRecord(UID, 'new_lead', { phone: PHONE });
    expect(r.notifId).toMatch(/^notif_/);
    expect(r.uid).toBe(UID);
    expect(r.type).toBe('new_lead');
    expect(r.priority).toBe('high');
    expect(r.status).toBe('pending');
    expect(r.data.phone).toBe(PHONE);
    expect(r.createdAt).toBeDefined();
  });
  test('prioridad custom en opts', () => {
    const r = buildNotificationRecord(UID, 'catalog_updated', {}, { priority: 'critical' });
    expect(r.priority).toBe('critical');
  });
  test('prioridad invalida cae al default', () => {
    const r = buildNotificationRecord(UID, 'catalog_updated', {}, { priority: 'mega_urgent' });
    expect(r.priority).toBe('normal');
  });
});

describe('saveNotification', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveNotification(undefined, { notifId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveNotification(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const record = buildNotificationRecord(UID, 'new_lead', { phone: PHONE });
    const id = await saveNotification(UID, record);
    expect(id).toBe(record.notifId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const record = buildNotificationRecord(UID, 'system_alert', {});
    await expect(saveNotification(UID, record)).rejects.toThrow('set error');
  });
});

describe('updateNotificationStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateNotificationStatus(undefined, 'notif1', 'sent')).rejects.toThrow('uid requerido');
  });
  test('lanza si notifId undefined', async () => {
    await expect(updateNotificationStatus(UID, undefined, 'sent')).rejects.toThrow('notifId requerido');
  });
  test('lanza si status invalido', async () => {
    await expect(updateNotificationStatus(UID, 'notif1', 'deleted')).rejects.toThrow('status invalido');
  });
  test('actualiza sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateNotificationStatus(UID, 'notif1', 'sent')).resolves.toBeUndefined();
  });
  test('acepta suppressedReason', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateNotificationStatus(UID, 'n1', 'suppressed', { suppressedReason: 'duplicate' })).resolves.toBeUndefined();
  });
});

describe('getRecentNotifications', () => {
  test('lanza si uid undefined', async () => {
    await expect(getRecentNotifications(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay notifs', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getRecentNotifications(UID)).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getRecentNotifications(UID)).toEqual([]);
  });
  test('respeta limite', async () => {
    const stored = {};
    for (let i = 0; i < 10; i++) {
      stored['notif_' + i] = { type: 'new_lead', status: 'sent', createdAt: new Date(Date.now() + i).toISOString() };
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getRecentNotifications(UID, 3);
    expect(r.length).toBe(3);
  });
});

describe('hasSentRecentNotification', () => {
  test('lanza si uid undefined', async () => {
    await expect(hasSentRecentNotification(undefined, 'new_lead')).rejects.toThrow('uid requerido');
  });
  test('retorna false si no hay notif reciente', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await hasSentRecentNotification(UID, 'new_lead')).toBe(false);
  });
  test('retorna true si hay notif reciente enviada', async () => {
    const stored = {
      'notif_1': { type: 'spam_detected', status: 'sent', sentAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    expect(await hasSentRecentNotification(UID, 'spam_detected', 60000)).toBe(true);
  });
  test('retorna false si notif antigua', async () => {
    const stored = {
      'notif_1': { type: 'spam_detected', status: 'sent', sentAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), createdAt: new Date().toISOString() },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    expect(await hasSentRecentNotification(UID, 'spam_detected', 5 * 60 * 1000)).toBe(false);
  });
});

describe('buildNotificationText', () => {
  test('retorna vacio si record null', () => {
    expect(buildNotificationText(null)).toBe('');
  });
  test('new_lead menciona el nombre o phone', () => {
    const r = buildNotificationRecord(UID, 'new_lead', { name: 'Juan', text: 'Hola quiero info' });
    const text = buildNotificationText(r);
    expect(text).toContain('Juan');
    expect(text).toContain('Hola');
  });
  test('spam_detected menciona SPAM y severity', () => {
    const r = buildNotificationRecord(UID, 'spam_detected', { phone: PHONE, severity: 'high' });
    const text = buildNotificationText(r);
    expect(text.toUpperCase()).toContain('SPAM');
    expect(text).toContain('high');
  });
  test('handoff_requested menciona motivo', () => {
    const r = buildNotificationRecord(UID, 'handoff_requested', { phone: PHONE, reason: 'complaint' });
    const text = buildNotificationText(r);
    expect(text.toLowerCase()).toContain('handoff');
    expect(text).toContain('complaint');
  });
  test('daily_summary incluye estadisticas', () => {
    const r = buildNotificationRecord(UID, 'daily_summary', { messages: 150, leads: 10, handoffs: 2 });
    const text = buildNotificationText(r);
    expect(text).toContain('150');
    expect(text).toContain('10');
    expect(text).toContain('2');
  });
  test('system_alert incluye componente', () => {
    const r = buildNotificationRecord(UID, 'system_alert', { component: 'gemini', message: 'timeout', severity: 'critical' });
    const text = buildNotificationText(r);
    expect(text).toContain('gemini');
    expect(text).toContain('timeout');
  });
  test('otp_requested menciona accion', () => {
    const r = buildNotificationRecord(UID, 'otp_requested', { action: 'delete_account' });
    const text = buildNotificationText(r);
    expect(text).toContain('delete_account');
  });
  test('broadcast_done menciona cantidad', () => {
    const r = buildNotificationRecord(UID, 'broadcast_done', { sent: 42 });
    const text = buildNotificationText(r);
    expect(text).toContain('42');
  });
  test('low_stock menciona producto', () => {
    const r = buildNotificationRecord(UID, 'low_stock', { itemName: 'Empanadas', stock: 3 });
    const text = buildNotificationText(r);
    expect(text).toContain('Empanadas');
    expect(text).toContain('3');
  });
  test('recovery_initiated menciona contacto', () => {
    const r = buildNotificationRecord(UID, 'recovery_initiated', { phone: PHONE });
    const text = buildNotificationText(r);
    expect(text).toContain(PHONE);
  });
});

describe('buildDailySummaryText / buildSystemAlertText directo', () => {
  test('daily summary con keywords', () => {
    const text = buildDailySummaryText({ messages: 50, leads: 5, handoffs: 1, topKeywords: ['precio', 'envio'] });
    expect(text).toContain('precio');
    expect(text).toContain('envio');
  });
  test('system alert critical tiene emoji rojo', () => {
    const text = buildSystemAlertText({ component: 'db', message: 'down', severity: 'critical' });
    expect(text).toContain('🔴');
  });
  test('system alert warning tiene emoji amarillo', () => {
    const text = buildSystemAlertText({ component: 'api', message: 'slow', severity: 'warning' });
    expect(text).toContain('🟡');
  });
});
