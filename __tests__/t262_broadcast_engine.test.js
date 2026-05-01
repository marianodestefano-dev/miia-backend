'use strict';

// T262 broadcast_engine — suite completa
const {
  buildBroadcastRecord,
  validateBroadcastContent,
  addRecipients,
  removeRecipient,
  scheduleBroadcast,
  computeBroadcastStats,
  buildBroadcastSummaryText,
  saveBroadcast,
  getBroadcast,
  updateBroadcastStatus,
  recordRecipientResult,
  listBroadcasts,
  isValidPhone,
  BROADCAST_STATUSES,
  BROADCAST_TYPES,
  RECIPIENT_STATUSES,
  MAX_RECIPIENTS_PER_BROADCAST,
  MAX_MESSAGE_LENGTH,
  MIN_INTERVAL_BETWEEN_SENDS_MS,
  __setFirestoreForTests: setDb,
} = require('../core/broadcast_engine');

const UID = 'broadcast262Uid';
const PHONES = ['+5491155554444', '+5491155554445', '+5491155554446'];
const FUTURE = Date.now() + 60 * 60 * 1000;

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
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { empty: Object.keys(db_stored).length === 0, forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => setDb(null));
afterEach(() => setDb(null));

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
describe('broadcast_engine — constantes', () => {
  test('BROADCAST_STATUSES tiene draft, scheduled, sent, failed', () => {
    ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'].forEach(s =>
      expect(BROADCAST_STATUSES).toContain(s)
    );
  });
  test('BROADCAST_TYPES tiene promotional y reminder', () => {
    expect(BROADCAST_TYPES).toContain('promotional');
    expect(BROADCAST_TYPES).toContain('reminder');
    expect(BROADCAST_TYPES).toContain('follow_up');
  });
  test('RECIPIENT_STATUSES tiene pending y sent', () => {
    expect(RECIPIENT_STATUSES).toContain('pending');
    expect(RECIPIENT_STATUSES).toContain('sent');
    expect(RECIPIENT_STATUSES).toContain('opted_out');
  });
  test('MAX_RECIPIENTS_PER_BROADCAST es 1000', () => {
    expect(MAX_RECIPIENTS_PER_BROADCAST).toBe(1000);
  });
  test('MAX_MESSAGE_LENGTH es 4096', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(4096);
  });
  test('MIN_INTERVAL_BETWEEN_SENDS_MS definido', () => {
    expect(MIN_INTERVAL_BETWEEN_SENDS_MS).toBeGreaterThan(0);
  });
});

// ─── isValidPhone ─────────────────────────────────────────────────────────────
describe('isValidPhone', () => {
  test('numero argentino valido', () => {
    expect(isValidPhone('+5491155554444')).toBe(true);
  });
  test('numero sin + invalido', () => {
    expect(isValidPhone('5491155554444')).toBe(false);
  });
  test('numero muy corto invalido', () => {
    expect(isValidPhone('+5491')).toBe(false);
  });
  test('string vacio invalido', () => {
    expect(isValidPhone('')).toBe(false);
  });
  test('null invalido', () => {
    expect(isValidPhone(null)).toBe(false);
  });
  test('numero colombiano valido', () => {
    expect(isValidPhone('+573001234567')).toBe(true);
  });
});

// ─── buildBroadcastRecord ─────────────────────────────────────────────────────
describe('buildBroadcastRecord', () => {
  test('defaults correctos', () => {
    const b = buildBroadcastRecord(UID, { name: 'Promo Mayo', message: 'Hola!', recipients: PHONES });
    expect(b.uid).toBe(UID);
    expect(b.name).toBe('Promo Mayo');
    expect(b.message).toBe('Hola!');
    expect(b.status).toBe('draft');
    expect(b.type).toBe('custom');
    expect(b.sentCount).toBe(0);
    expect(b.failedCount).toBe(0);
    expect(b.results).toEqual({});
    expect(b.recipientCount).toBe(3);
  });
  test('status invalido cae a draft', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', status: 'fake' });
    expect(b.status).toBe('draft');
  });
  test('type invalido cae a custom', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', type: 'fake_type' });
    expect(b.type).toBe('custom');
  });
  test('recipients se deduplicaan', () => {
    const dupes = [...PHONES, PHONES[0], PHONES[1]];
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: dupes });
    expect(b.recipientCount).toBe(3);
  });
  test('recipients invalidos se filtran', () => {
    const mixed = [...PHONES, 'no_es_un_telefono', '123'];
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: mixed });
    expect(b.recipientCount).toBe(3);
  });
  test('message se trunca a MAX_MESSAGE_LENGTH', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'A'.repeat(5000) });
    expect(b.message.length).toBe(4096);
  });
  test('broadcastId se puede forzar', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', broadcastId: 'bc_custom_01' });
    expect(b.broadcastId).toBe('bc_custom_01');
  });
  test('metadata invalida cae a objeto vacio', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', metadata: 'invalid' });
    expect(b.metadata).toEqual({});
  });
});

// ─── validateBroadcastContent ─────────────────────────────────────────────────
describe('validateBroadcastContent', () => {
  test('valido retorna valid=true', () => {
    const r = validateBroadcastContent({ name: 'Promo', message: 'Hola!', recipients: PHONES });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  test('sin name es invalido', () => {
    const r = validateBroadcastContent({ message: 'Hola!', recipients: PHONES });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('name'))).toBe(true);
  });
  test('sin message es invalido', () => {
    const r = validateBroadcastContent({ name: 'X', recipients: PHONES });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('message'))).toBe(true);
  });
  test('sin recipients es invalido', () => {
    const r = validateBroadcastContent({ name: 'X', message: 'Y', recipients: [] });
    expect(r.valid).toBe(false);
  });
  test('recipients > MAX es invalido', () => {
    const many = Array.from({ length: 1001 }, (_, i) => '+549111' + String(i).padStart(7, '0'));
    const r = validateBroadcastContent({ name: 'X', message: 'Y', recipients: many });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('MAX'))).toBe(true);
  });
});

// ─── addRecipients ────────────────────────────────────────────────────────────
describe('addRecipients', () => {
  test('agrega phones nuevos', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: [PHONES[0]] });
    const updated = addRecipients(b, [PHONES[1], PHONES[2]]);
    expect(updated.recipientCount).toBe(3);
  });
  test('no duplica existentes', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const updated = addRecipients(b, PHONES);
    expect(updated.recipientCount).toBe(3);
  });
  test('filtra invalidos', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: [PHONES[0]] });
    const updated = addRecipients(b, ['invalido', PHONES[1]]);
    expect(updated.recipientCount).toBe(2);
  });
  test('exceder MAX lanza error', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y' });
    const many = Array.from({ length: 1001 }, (_, i) => '+549111' + String(i).padStart(7, '0'));
    expect(() => addRecipients(b, many)).toThrow('MAX');
  });
  test('null retorna broadcast sin cambios', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const updated = addRecipients(b, null);
    expect(updated.recipientCount).toBe(3);
  });
});

// ─── removeRecipient ──────────────────────────────────────────────────────────
describe('removeRecipient', () => {
  test('elimina phone existente', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const updated = removeRecipient(b, PHONES[0]);
    expect(updated.recipientCount).toBe(2);
    expect(updated.recipients).not.toContain(PHONES[0]);
  });
  test('phone inexistente no cambia nada', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const updated = removeRecipient(b, '+5491999999999');
    expect(updated.recipientCount).toBe(3);
  });
});

// ─── scheduleBroadcast ────────────────────────────────────────────────────────
describe('scheduleBroadcast', () => {
  test('cambia status a scheduled con timestamp futuro', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const scheduled = scheduleBroadcast(b, FUTURE);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt).toBe(FUTURE);
  });
  test('timestamp pasado lanza error', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y' });
    expect(() => scheduleBroadcast(b, Date.now() - 1000)).toThrow('futuro');
  });
  test('broadcast no draft lanza error', () => {
    const b = { ...buildBroadcastRecord(UID, { name: 'X', message: 'Y' }), status: 'sent' };
    expect(() => scheduleBroadcast(b, FUTURE)).toThrow('draft');
  });
});

// ─── computeBroadcastStats ────────────────────────────────────────────────────
describe('computeBroadcastStats', () => {
  test('calcula sentCount, failedCount, deliveryRate', () => {
    const results = {
      phone1: 'sent', phone2: 'sent', phone3: 'failed', phone4: 'sent', phone5: 'opted_out',
    };
    const stats = computeBroadcastStats(results);
    expect(stats.sentCount).toBe(3);
    expect(stats.failedCount).toBe(1);
    expect(stats.optedOutCount).toBe(1);
    expect(stats.deliveryRate).toBe(60);
  });
  test('sin resultados retorna ceros', () => {
    const stats = computeBroadcastStats({});
    expect(stats.sentCount).toBe(0);
    expect(stats.deliveryRate).toBe(0);
  });
  test('null retorna ceros', () => {
    const stats = computeBroadcastStats(null);
    expect(stats.sentCount).toBe(0);
    expect(stats.failedCount).toBe(0);
  });
  test('pendingCount correcto', () => {
    const results = { p1: 'pending', p2: 'sent', p3: 'pending' };
    const stats = computeBroadcastStats(results);
    expect(stats.pendingCount).toBe(2);
  });
  test('bounced cuenta como failed', () => {
    const results = { p1: 'bounced', p2: 'sent' };
    const stats = computeBroadcastStats(results);
    expect(stats.failedCount).toBe(1);
  });
});

// ─── saveBroadcast + getBroadcast ─────────────────────────────────────────────
describe('saveBroadcast + getBroadcast', () => {
  test('round-trip exitoso', async () => {
    const db = makeMockDb();
    setDb(db);
    const b = buildBroadcastRecord(UID, { name: 'Promo Junio', message: 'Hola mundo!', recipients: PHONES, type: 'promotional' });
    const savedId = await saveBroadcast(UID, b);
    expect(savedId).toBe(b.broadcastId);
    const loaded = await getBroadcast(UID, b.broadcastId);
    expect(loaded.name).toBe('Promo Junio');
    expect(loaded.type).toBe('promotional');
    expect(loaded.recipientCount).toBe(3);
  });
  test('getBroadcast retorna null si no existe', async () => {
    setDb(makeMockDb());
    const loaded = await getBroadcast(UID, 'bc_no_existe');
    expect(loaded).toBeNull();
  });
  test('saveBroadcast con throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y' });
    await expect(saveBroadcast(UID, b)).rejects.toThrow('set error');
  });
  test('getBroadcast con throwGet retorna null', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const loaded = await getBroadcast(UID, 'bc_001');
    expect(loaded).toBeNull();
  });
});

// ─── updateBroadcastStatus ────────────────────────────────────────────────────
describe('updateBroadcastStatus', () => {
  test('actualiza a sending', async () => {
    setDb(makeMockDb());
    const id = await updateBroadcastStatus(UID, 'bc_001', 'sending');
    expect(id).toBe('bc_001');
  });
  test('actualiza a sent con sentAt', async () => {
    const db = makeMockDb();
    setDb(db);
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', broadcastId: 'bc_001' });
    await saveBroadcast(UID, b);
    await updateBroadcastStatus(UID, 'bc_001', 'sent');
    const loaded = await getBroadcast(UID, 'bc_001');
    expect(loaded.sentAt).toBeDefined();
  });
  test('status invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(updateBroadcastStatus(UID, 'bc_001', 'fake_status')).rejects.toThrow('status invalido');
  });
  test('throwSet lanza error', async () => {
    setDb(makeMockDb({ throwSet: true }));
    await expect(updateBroadcastStatus(UID, 'bc_001', 'cancelled')).rejects.toThrow('set error');
  });
});

// ─── recordRecipientResult ────────────────────────────────────────────────────
describe('recordRecipientResult', () => {
  test('guarda resultado enviado', async () => {
    const stored = { bc_001: { broadcastId: 'bc_001', results: {} } };
    setDb(makeMockDb({ stored }));
    const ok = await recordRecipientResult(UID, 'bc_001', PHONES[0], 'sent');
    expect(ok).toBe(true);
  });
  test('result invalido lanza error', async () => {
    setDb(makeMockDb());
    await expect(recordRecipientResult(UID, 'bc_001', PHONES[0], 'fake_result')).rejects.toThrow('result invalido');
  });
  test('throwSet retorna false', async () => {
    setDb(makeMockDb({ throwSet: true }));
    const ok = await recordRecipientResult(UID, 'bc_001', PHONES[0], 'sent');
    expect(ok).toBe(false);
  });
});

// ─── listBroadcasts ───────────────────────────────────────────────────────────
describe('listBroadcasts', () => {
  test('retorna todos los broadcasts', async () => {
    const b1 = buildBroadcastRecord(UID, { name: 'B1', message: 'M1', status: 'draft' });
    const b2 = buildBroadcastRecord(UID, { name: 'B2', message: 'M2', status: 'sent' });
    b2.broadcastId = b2.broadcastId + '_2';
    setDb(makeMockDb({ stored: { [b1.broadcastId]: b1, [b2.broadcastId]: b2 } }));
    const results = await listBroadcasts(UID);
    expect(results.length).toBe(2);
  });
  test('filtra por status', async () => {
    const b1 = buildBroadcastRecord(UID, { name: 'B1', message: 'M1', status: 'draft' });
    const b2 = { ...buildBroadcastRecord(UID, { name: 'B2', message: 'M2' }), status: 'sent' };
    b2.broadcastId = b2.broadcastId + '_2';
    setDb(makeMockDb({ stored: { [b1.broadcastId]: b1, [b2.broadcastId]: b2 } }));
    const drafts = await listBroadcasts(UID, { status: 'draft' });
    expect(drafts.every(b => b.status === 'draft')).toBe(true);
  });
  test('throwGet retorna array vacio', async () => {
    setDb(makeMockDb({ throwGet: true }));
    const results = await listBroadcasts(UID);
    expect(results).toEqual([]);
  });
});

// ─── buildBroadcastSummaryText ────────────────────────────────────────────────
describe('buildBroadcastSummaryText', () => {
  test('retorna mensaje si null', () => {
    expect(buildBroadcastSummaryText(null)).toContain('no encontrado');
  });
  test('incluye nombre y estado', () => {
    const b = buildBroadcastRecord(UID, { name: 'Promo Verano', message: 'Hola!', status: 'draft' });
    const text = buildBroadcastSummaryText(b);
    expect(text).toContain('Promo Verano');
    expect(text).toContain('draft');
  });
  test('incluye destinatarios', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y', recipients: PHONES });
    const text = buildBroadcastSummaryText(b);
    expect(text).toContain('3');
  });
  test('incluye tasa entrega si sent', () => {
    const b = {
      ...buildBroadcastRecord(UID, { name: 'X', message: 'Y' }),
      status: 'sent',
      results: { p1: 'sent', p2: 'sent', p3: 'failed' },
    };
    const text = buildBroadcastSummaryText(b);
    expect(text).toContain('Tasa de entrega');
    expect(text).toContain('%');
  });
  test('incluye fecha agendada si scheduledAt', () => {
    const b = buildBroadcastRecord(UID, { name: 'X', message: 'Y' });
    const scheduled = scheduleBroadcast(b, FUTURE);
    const text = buildBroadcastSummaryText(scheduled);
    expect(text).toContain('Agendado');
  });
});
