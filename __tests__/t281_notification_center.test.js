'use strict';

const {
  buildNotificationRecord,
  buildBatchNotifications,
  applyDispatchResult,
  markDelivered,
  cancelNotification,
  shouldRetry,
  computeNextRetryMs,
  buildNotificationSummaryText,
  saveNotification,
  getNotification,
  updateNotification,
  listPendingNotifications,
  listScheduledNotifications,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
  MAX_RETRY_ATTEMPTS,
  MAX_BATCH_SIZE,
  __setFirestoreForTests,
} = require('../core/notification_center');

function makeMockDb() {
  const stored = {};
  return {
    stored,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!stored[uid]) stored[uid] = {};
                stored[uid][id] = { ...data };
              },
              get: async () => {
                const rec = stored[uid] && stored[uid][id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => {
                chain.filters.push([f2, op2, v2]);
                return chain;
              };
              chain.get = async () => {
                const all = Object.values(stored[uid] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  if (o === '<=') return r[f] <= v;
                  return true;
                }));
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              };
              return chain;
            },
            get: async () => {
              const all = Object.values(stored[uid] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'usr_notif_test_001';

describe('T281 — notification_center', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // ─── Constantes ───────────────────────────────────────────────────────────

  describe('Constantes exportadas', () => {
    test('NOTIFICATION_CHANNELS es frozen', () => {
      expect(Object.isFrozen(NOTIFICATION_CHANNELS)).toBe(true);
      expect(NOTIFICATION_CHANNELS).toContain('whatsapp');
      expect(NOTIFICATION_CHANNELS).toContain('email');
      expect(NOTIFICATION_CHANNELS).toContain('sms');
    });

    test('NOTIFICATION_STATUSES es frozen con todos los estados', () => {
      expect(Object.isFrozen(NOTIFICATION_STATUSES)).toBe(true);
      expect(NOTIFICATION_STATUSES).toContain('pending');
      expect(NOTIFICATION_STATUSES).toContain('sent');
      expect(NOTIFICATION_STATUSES).toContain('delivered');
      expect(NOTIFICATION_STATUSES).toContain('failed');
      expect(NOTIFICATION_STATUSES).toContain('scheduled');
    });

    test('NOTIFICATION_PRIORITIES es frozen', () => {
      expect(Object.isFrozen(NOTIFICATION_PRIORITIES)).toBe(true);
      expect(NOTIFICATION_PRIORITIES).toContain('urgent');
      expect(NOTIFICATION_PRIORITIES).toContain('normal');
    });

    test('MAX_RETRY_ATTEMPTS es 3', () => {
      expect(MAX_RETRY_ATTEMPTS).toBe(3);
    });

    test('MAX_BATCH_SIZE es 100', () => {
      expect(MAX_BATCH_SIZE).toBe(100);
    });
  });

  // ─── buildNotificationRecord ──────────────────────────────────────────────

  describe('buildNotificationRecord', () => {
    test('construye notificacion whatsapp con campos requeridos', () => {
      const n = buildNotificationRecord(UID, {
        channel: 'whatsapp',
        type: 'appointment_reminder',
        priority: 'high',
        recipientPhone: '+541155551234',
        body: 'Recordatorio de turno manana a las 10hs',
      });

      expect(n.uid).toBe(UID);
      expect(n.channel).toBe('whatsapp');
      expect(n.type).toBe('appointment_reminder');
      expect(n.priority).toBe('high');
      expect(n.status).toBe('pending');
      expect(n.recipientPhone).toBe('+541155551234');
      expect(n.attempts).toBe(0);
      expect(n.maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
    });

    test('channel invalido cae a whatsapp', () => {
      const n = buildNotificationRecord(UID, { channel: 'telepathy' });
      expect(n.channel).toBe('whatsapp');
    });

    test('type invalido cae a custom', () => {
      const n = buildNotificationRecord(UID, { type: 'invento' });
      expect(n.type).toBe('custom');
    });

    test('priority invalida cae a normal', () => {
      const n = buildNotificationRecord(UID, { priority: 'extreme' });
      expect(n.priority).toBe('normal');
    });

    test('scheduledAt futuro genera status scheduled', () => {
      const futureTs = Date.now() + 3600000;
      const n = buildNotificationRecord(UID, { scheduledAt: futureTs });
      expect(n.status).toBe('scheduled');
      expect(n.scheduledAt).toBe(futureTs);
    });

    test('scheduledAt pasado no genera scheduled', () => {
      const pastTs = Date.now() - 1000;
      const n = buildNotificationRecord(UID, { scheduledAt: pastTs });
      expect(n.status).toBe('pending');
      expect(n.scheduledAt).toBeNull();
    });

    test('body truncado a MAX_BODY_LENGTH', () => {
      const n = buildNotificationRecord(UID, { body: 'x'.repeat(5000) });
      expect(n.body.length).toBe(4096);
    });

    test('templateVars copiados correctamente', () => {
      const n = buildNotificationRecord(UID, {
        templateVars: { nombre: 'Maria', servicio: 'Pilates' },
      });
      expect(n.templateVars.nombre).toBe('Maria');
      expect(n.templateVars.servicio).toBe('Pilates');
    });

    test('notificationId unico por llamada', () => {
      const n1 = buildNotificationRecord(UID, {});
      const n2 = buildNotificationRecord(UID, {});
      expect(n1.notificationId).not.toBe(n2.notificationId);
    });
  });

  // ─── buildBatchNotifications ──────────────────────────────────────────────

  describe('buildBatchNotifications', () => {
    test('genera notificaciones para cada destinatario', () => {
      const recipients = [
        { phone: '+541155550001', name: 'Ana' },
        { phone: '+541155550002', name: 'Luis' },
        { phone: '+541155550003', name: 'Marta' },
      ];
      const batch = buildBatchNotifications(UID, recipients, {
        channel: 'whatsapp',
        type: 'broadcast',
        body: 'Oferta especial hoy!',
      });

      expect(batch.length).toBe(3);
      expect(batch[0].recipientPhone).toBe('+541155550001');
      expect(batch[1].recipientName).toBe('Luis');
      expect(batch[2].recipientPhone).toBe('+541155550003');
    });

    test('respeta MAX_BATCH_SIZE', () => {
      const recipients = Array.from({ length: 150 }, (_, i) => ({ phone: '+5411' + i }));
      const batch = buildBatchNotifications(UID, recipients, { channel: 'email' });
      expect(batch.length).toBe(MAX_BATCH_SIZE);
    });

    test('retorna array vacio si recipients esta vacio', () => {
      const batch = buildBatchNotifications(UID, [], { channel: 'sms' });
      expect(batch).toEqual([]);
    });

    test('templateVars por destinatario sobrescriben los compartidos', () => {
      const recipients = [{ phone: '+1', templateVars: { nombre: 'Personal' } }];
      const batch = buildBatchNotifications(UID, recipients, {
        channel: 'whatsapp',
        templateVars: { nombre: 'Compartido', negocio: 'Demo' },
      });
      expect(batch[0].templateVars.nombre).toBe('Personal');
      expect(batch[0].templateVars.negocio).toBe('Demo');
    });
  });

  // ─── applyDispatchResult ──────────────────────────────────────────────────

  describe('applyDispatchResult', () => {
    test('resultado exitoso → status sent, sentAt seteado', () => {
      const n = buildNotificationRecord(UID, { channel: 'email' });
      const updated = applyDispatchResult(n, { success: true });
      expect(updated.status).toBe('sent');
      expect(updated.sentAt).toBeGreaterThan(0);
      expect(updated.attempts).toBe(1);
      expect(updated.lastError).toBeNull();
    });

    test('fallo primer intento → status sigue pending, attempts++', () => {
      const n = buildNotificationRecord(UID, {});
      const updated = applyDispatchResult(n, { success: false, error: 'timeout' });
      expect(updated.status).toBe('pending');
      expect(updated.attempts).toBe(1);
      expect(updated.lastError).toBe('timeout');
    });

    test('fallo en maxAttempts → status failed', () => {
      const n = { ...buildNotificationRecord(UID, {}), attempts: 2 };
      const updated = applyDispatchResult(n, { success: false, error: 'server error' });
      expect(updated.status).toBe('failed');
      expect(updated.failedAt).toBeGreaterThan(0);
      expect(updated.attempts).toBe(3);
    });
  });

  // ─── markDelivered ────────────────────────────────────────────────────────

  describe('markDelivered', () => {
    test('sent → delivered correctamente', () => {
      const n = { ...buildNotificationRecord(UID, {}), status: 'sent', sentAt: Date.now() };
      const delivered = markDelivered(n);
      expect(delivered.status).toBe('delivered');
      expect(delivered.deliveredAt).toBeGreaterThan(0);
    });

    test('lanza error si no esta en sent', () => {
      const n = buildNotificationRecord(UID, {});
      expect(() => markDelivered(n)).toThrow();
    });
  });

  // ─── cancelNotification ───────────────────────────────────────────────────

  describe('cancelNotification', () => {
    test('cancela notificacion pending', () => {
      const n = buildNotificationRecord(UID, {});
      const cancelled = cancelNotification(n);
      expect(cancelled.status).toBe('cancelled');
    });

    test('cancela notificacion scheduled', () => {
      const n = buildNotificationRecord(UID, { scheduledAt: Date.now() + 9999 });
      const cancelled = cancelNotification(n);
      expect(cancelled.status).toBe('cancelled');
    });

    test('lanza error si ya fue enviada', () => {
      const n = { ...buildNotificationRecord(UID, {}), status: 'sent' };
      expect(() => cancelNotification(n)).toThrow();
    });

    test('lanza error si ya esta entregada', () => {
      const n = { ...buildNotificationRecord(UID, {}), status: 'delivered' };
      expect(() => cancelNotification(n)).toThrow();
    });

    test('lanza error si ya esta cancelada', () => {
      const n = { ...buildNotificationRecord(UID, {}), status: 'cancelled' };
      expect(() => cancelNotification(n)).toThrow();
    });
  });

  // ─── shouldRetry ──────────────────────────────────────────────────────────

  describe('shouldRetry', () => {
    test('retorna true si pending con intentos disponibles', () => {
      const n = buildNotificationRecord(UID, {});
      expect(shouldRetry(n)).toBe(true);
    });

    test('retorna false si status no es pending', () => {
      const n = { ...buildNotificationRecord(UID, {}), status: 'failed' };
      expect(shouldRetry(n)).toBe(false);
    });

    test('retorna false si maxAttempts alcanzado', () => {
      const n = { ...buildNotificationRecord(UID, {}), attempts: 3 };
      expect(shouldRetry(n)).toBe(false);
    });

    test('retorna false si notification es null', () => {
      expect(shouldRetry(null)).toBe(false);
    });
  });

  // ─── computeNextRetryMs ───────────────────────────────────────────────────

  describe('computeNextRetryMs', () => {
    test('backoff exponencial: 2000 → 4000 → 8000 → cap 30000', () => {
      expect(computeNextRetryMs(0)).toBe(2000);
      expect(computeNextRetryMs(1)).toBe(4000);
      expect(computeNextRetryMs(2)).toBe(8000);
      expect(computeNextRetryMs(10)).toBe(30000);
    });
  });

  // ─── buildNotificationSummaryText ─────────────────────────────────────────

  describe('buildNotificationSummaryText', () => {
    test('genera texto con canal, tipo y estado', () => {
      const n = buildNotificationRecord(UID, {
        channel: 'email',
        type: 'payment_confirmed',
        priority: 'high',
        recipientName: 'Carlos Garcia',
        recipientEmail: 'carlos@example.com',
        subject: 'Pago confirmado',
      });
      const text = buildNotificationSummaryText(n);
      expect(text).toContain('EMAIL');
      expect(text).toContain('payment_confirmed');
      expect(text).toContain('Carlos Garcia');
      expect(text).toContain('carlos@example.com');
      expect(text).toContain('Pago confirmado');
    });

    test('retorna mensaje si notification es null', () => {
      expect(buildNotificationSummaryText(null)).toBe('Notificacion no encontrada.');
    });

    test('muestra intentos si > 0', () => {
      const n = { ...buildNotificationRecord(UID, {}), attempts: 2 };
      const text = buildNotificationSummaryText(n);
      expect(text).toContain('Intentos: 2');
    });
  });

  // ─── Firestore CRUD ───────────────────────────────────────────────────────

  describe('Operaciones Firestore', () => {
    test('saveNotification + getNotification funciona', async () => {
      const n = buildNotificationRecord(UID, { channel: 'whatsapp', recipientPhone: '+541155551234' });
      await saveNotification(UID, n);
      const retrieved = await getNotification(UID, n.notificationId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.recipientPhone).toBe('+541155551234');
    });

    test('getNotification retorna null si no existe', async () => {
      const result = await getNotification(UID, 'notif_inexistente_999');
      expect(result).toBeNull();
    });

    test('updateNotification hace merge', async () => {
      const n = buildNotificationRecord(UID, {});
      await saveNotification(UID, n);
      await updateNotification(UID, n.notificationId, { status: 'sent', sentAt: Date.now() });
      const retrieved = await getNotification(UID, n.notificationId);
      expect(retrieved.status).toBe('sent');
    });

    test('listPendingNotifications retorna las pendientes', async () => {
      const n1 = buildNotificationRecord(UID, { channel: 'whatsapp', priority: 'urgent' });
      const n2 = buildNotificationRecord(UID, { channel: 'email', priority: 'normal' });
      await saveNotification(UID, n1);
      await saveNotification(UID, n2);
      const pending = await listPendingNotifications(UID);
      expect(pending.length).toBe(2);
      // urgent primero
      expect(pending[0].priority).toBe('urgent');
    });

    test('listPendingNotifications filtra por channel', async () => {
      const n1 = buildNotificationRecord(UID, { channel: 'whatsapp' });
      const n2 = buildNotificationRecord(UID, { channel: 'email' });
      await saveNotification(UID, n1);
      await saveNotification(UID, n2);
      const whatsappPending = await listPendingNotifications(UID, { channel: 'whatsapp' });
      expect(whatsappPending.every(n => n.channel === 'whatsapp')).toBe(true);
    });

    test('listScheduledNotifications retorna programadas antes del ts', async () => {
      const futureTs = Date.now() + 3600000;
      const n = buildNotificationRecord(UID, { scheduledAt: futureTs });
      await saveNotification(UID, n);
      const scheduled = await listScheduledNotifications(UID, futureTs + 1000);
      expect(scheduled.length).toBe(1);
      expect(scheduled[0].status).toBe('scheduled');
    });

    test('listPendingNotifications retorna array vacio si no hay', async () => {
      const result = await listPendingNotifications('uid_vacio_notif');
      expect(result).toEqual([]);
    });
  });
});
