'use strict';

// T272: email_engine
const {
  buildEmailRecord, validateEmailData, addRecipients, removeRecipient,
  scheduleEmail, buildEmailStats, buildEmailSummaryText,
  saveEmail, getEmail, updateEmailStatus, listEmails, updateEmailStats,
  isValidEmail, EMAIL_STATUSES, EMAIL_TYPES, EMAIL_PRIORITIES,
  MAX_SUBJECT_LENGTH, MAX_RECIPIENTS_PER_EMAIL,
  __setFirestoreForTests,
} = require('../core/email_engine');

const UID = 'testEmailUid';

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

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
describe('constants', () => {
  test('EMAIL_STATUSES frozen 7 valores', () => {
    expect(EMAIL_STATUSES).toHaveLength(7);
    expect(EMAIL_STATUSES).toContain('draft');
    expect(EMAIL_STATUSES).toContain('sent');
    expect(EMAIL_STATUSES).toContain('bounced');
    expect(Object.isFrozen(EMAIL_STATUSES)).toBe(true);
  });
  test('EMAIL_TYPES frozen 8 valores', () => {
    expect(EMAIL_TYPES).toHaveLength(8);
    expect(Object.isFrozen(EMAIL_TYPES)).toBe(true);
  });
  test('EMAIL_PRIORITIES frozen 4 valores', () => {
    expect(EMAIL_PRIORITIES).toHaveLength(4);
    expect(Object.isFrozen(EMAIL_PRIORITIES)).toBe(true);
  });
  test('MAX_SUBJECT_LENGTH es 150', () => {
    expect(MAX_SUBJECT_LENGTH).toBe(150);
  });
});

// ─── isValidEmail ─────────────────────────────────────────────────────────────
describe('isValidEmail', () => {
  test('emails validos', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('test.email+tag@domain.co')).toBe(true);
    expect(isValidEmail('mariano@miia-app.com')).toBe(true);
  });
  test('emails invalidos', () => {
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

// ─── buildEmailRecord ─────────────────────────────────────────────────────────
describe('buildEmailRecord', () => {
  test('defaults correctos', () => {
    const e = buildEmailRecord(UID, {});
    expect(e.uid).toBe(UID);
    expect(e.type).toBe('custom');
    expect(e.status).toBe('draft');
    expect(e.priority).toBe('normal');
    expect(e.recipients).toHaveLength(0);
    expect(e.openCount).toBe(0);
    expect(e.emailId).toContain('email_');
  });

  test('recipients se filtran por validez', () => {
    const e = buildEmailRecord(UID, {
      recipients: ['valid@test.com', 'invalidemail', 'another@valid.com'],
    });
    expect(e.recipients).toHaveLength(2);
    expect(e.recipientCount).toBe(2);
  });

  test('subject se trunca al MAX', () => {
    const e = buildEmailRecord(UID, { subject: 'x'.repeat(200) });
    expect(e.subject.length).toBe(MAX_SUBJECT_LENGTH);
  });

  test('type invalido cae a custom', () => {
    const e = buildEmailRecord(UID, { type: 'INVALID_TYPE' });
    expect(e.type).toBe('custom');
  });

  test('emailId personalizado se respeta', () => {
    const e = buildEmailRecord(UID, { emailId: 'my_email_001', subject: 'Test' });
    expect(e.emailId).toBe('my_email_001');
  });

  test('from invalido se descarta', () => {
    const e = buildEmailRecord(UID, { from: 'notvalid' });
    expect(e.from).toBeNull();
  });

  test('from valido se acepta', () => {
    const e = buildEmailRecord(UID, { from: 'bot@miia-app.com' });
    expect(e.from).toBe('bot@miia-app.com');
  });

  test('metadata se copia defensivamente', () => {
    const meta = { campaign: 'mayo2026' };
    const e = buildEmailRecord(UID, { metadata: meta });
    meta.extra = 'modified';
    expect(e.metadata.extra).toBeUndefined();
  });
});

// ─── validateEmailData ────────────────────────────────────────────────────────
describe('validateEmailData', () => {
  test('email valido con bodyText', () => {
    const r = validateEmailData({ subject: 'Hola', bodyText: 'Contenido', from: 'bot@miia.com' });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test('email valido con solo bodyHtml', () => {
    const r = validateEmailData({ subject: 'Test', bodyHtml: '<p>Hola</p>' });
    expect(r.valid).toBe(true);
  });

  test('sin subject → error', () => {
    const r = validateEmailData({ bodyText: 'X' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('subject'))).toBe(true);
  });

  test('sin body → error', () => {
    const r = validateEmailData({ subject: 'Test' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('body'))).toBe(true);
  });

  test('from invalido → error', () => {
    const r = validateEmailData({ subject: 'T', bodyText: 'X', from: 'bademail' });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('from'))).toBe(true);
  });

  test('recipients invalidos → error', () => {
    const r = validateEmailData({ subject: 'T', bodyText: 'X', recipients: ['bad1', 'good@test.com', 'bad2'] });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('recipients invalidos'))).toBe(true);
  });

  test('data no objeto → error', () => {
    const r = validateEmailData('string');
    expect(r.valid).toBe(false);
  });
});

// ─── addRecipients ────────────────────────────────────────────────────────────
describe('addRecipients', () => {
  test('agrega recipients validos sin duplicar', () => {
    let e = buildEmailRecord(UID, { recipients: ['a@test.com'] });
    e = addRecipients(e, ['b@test.com', 'a@test.com', 'c@test.com']);
    expect(e.recipients).toHaveLength(3);
    expect(e.recipients).toContain('b@test.com');
    expect(e.recipients).toContain('c@test.com');
  });

  test('filtra emails invalidos', () => {
    let e = buildEmailRecord(UID, {});
    e = addRecipients(e, ['valid@test.com', 'INVALID', 'another@test.com']);
    expect(e.recipients).toHaveLength(2);
  });

  test('array requerido', () => {
    const e = buildEmailRecord(UID, {});
    expect(() => addRecipients(e, 'not-array')).toThrow('array');
  });
});

// ─── removeRecipient ──────────────────────────────────────────────────────────
describe('removeRecipient', () => {
  test('elimina recipient existente', () => {
    let e = buildEmailRecord(UID, { recipients: ['a@t.com', 'b@t.com', 'c@t.com'] });
    e = removeRecipient(e, 'b@t.com');
    expect(e.recipients).not.toContain('b@t.com');
    expect(e.recipientCount).toBe(2);
  });

  test('recipient no existente no rompe', () => {
    const e = buildEmailRecord(UID, { recipients: ['a@t.com'] });
    const result = removeRecipient(e, 'nonexistent@t.com');
    expect(result.recipients).toHaveLength(1);
  });
});

// ─── scheduleEmail ────────────────────────────────────────────────────────────
describe('scheduleEmail', () => {
  test('programa email draft para futuro', () => {
    const e = buildEmailRecord(UID, { subject: 'Promo', bodyText: 'X' });
    const future = Date.now() + 3600000;
    const scheduled = scheduleEmail(e, future);
    expect(scheduled.status).toBe('queued');
    expect(scheduled.scheduledAt).toBe(future);
  });

  test('timestamp pasado → error', () => {
    const e = buildEmailRecord(UID, {});
    expect(() => scheduleEmail(e, Date.now() - 1000)).toThrow('futuro');
  });

  test('email no-draft → error', () => {
    const e = { ...buildEmailRecord(UID, {}), status: 'sent' };
    expect(() => scheduleEmail(e, Date.now() + 1000)).toThrow('draft');
  });
});

// ─── buildEmailStats ──────────────────────────────────────────────────────────
describe('buildEmailStats', () => {
  test('calcula tasas correctamente', () => {
    const e = { recipientCount: 100, openCount: 40, clickCount: 10, bounceCount: 5, unsubscribeCount: 2 };
    const s = buildEmailStats(e);
    expect(s.openRate).toBe(40);
    expect(s.clickRate).toBe(10);
    expect(s.bounceRate).toBe(5);
  });

  test('0 recipients → tasas 0', () => {
    const e = { recipientCount: 0, openCount: 0, clickCount: 0, bounceCount: 0, unsubscribeCount: 0 };
    const s = buildEmailStats(e);
    expect(s.openRate).toBe(0);
    expect(s.clickRate).toBe(0);
  });
});

// ─── buildEmailSummaryText ────────────────────────────────────────────────────
describe('buildEmailSummaryText', () => {
  test('null retorna mensaje defecto', () => {
    expect(buildEmailSummaryText(null)).toContain('no encontrado');
  });

  test('draft incluye subject y estado', () => {
    const e = buildEmailRecord(UID, { subject: 'Campaña Mayo', type: 'promotional', recipients: ['a@t.com', 'b@t.com'] });
    const text = buildEmailSummaryText(e);
    expect(text).toContain('Campaña Mayo');
    expect(text).toContain('draft');
    expect(text).toContain('2');
  });

  test('sent incluye estadisticas', () => {
    const e = {
      ...buildEmailRecord(UID, { subject: 'Enviado', type: 'transactional', recipients: ['a@t.com', 'b@t.com', 'c@t.com'] }),
      status: 'sent', openCount: 2, clickCount: 1, bounceCount: 0, unsubscribeCount: 0,
    };
    const text = buildEmailSummaryText(e);
    expect(text).toContain('sent');
    expect(text).toContain('Aperturas');
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveEmail + getEmail round-trip', () => {
  test('guarda y recupera email', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const e = buildEmailRecord(UID, {
      subject: 'Bienvenido a MIIA',
      bodyText: 'Gracias por unirte.',
      type: 'welcome',
      recipients: ['cliente@test.com'],
    });
    await saveEmail(UID, e);
    __setFirestoreForTests(db);
    const loaded = await getEmail(UID, e.emailId);
    expect(loaded).not.toBeNull();
    expect(loaded.subject).toBe('Bienvenido a MIIA');
    expect(loaded.type).toBe('welcome');
  });

  test('getEmail retorna null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await getEmail(UID, 'nonexistent');
    expect(result).toBeNull();
  });

  test('saveEmail lanza error con throwSet', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const e = buildEmailRecord(UID, { subject: 'T', bodyText: 'X' });
    await expect(saveEmail(UID, e)).rejects.toThrow('set error');
  });
});

describe('updateEmailStatus', () => {
  test('draft → queued', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const e = buildEmailRecord(UID, { subject: 'T', bodyText: 'X', emailId: 'email_001' });
    await saveEmail(UID, e);
    __setFirestoreForTests(db);
    await updateEmailStatus(UID, 'email_001', 'queued');
    __setFirestoreForTests(db);
    const loaded = await getEmail(UID, 'email_001');
    expect(loaded.status).toBe('queued');
  });

  test('sent setea sentAt', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const e = buildEmailRecord(UID, { subject: 'T', bodyText: 'X', emailId: 'email_002' });
    await saveEmail(UID, e);
    __setFirestoreForTests(db);
    await updateEmailStatus(UID, 'email_002', 'sent');
    __setFirestoreForTests(db);
    const loaded = await getEmail(UID, 'email_002');
    expect(loaded.status).toBe('sent');
    expect(loaded.sentAt).toBeDefined();
  });

  test('status invalido → error', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    await expect(updateEmailStatus(UID, 'any', 'INVALID')).rejects.toThrow('status invalido');
  });
});

describe('listEmails', () => {
  test('filtra por status', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const e1 = buildEmailRecord(UID, { subject: 'A', bodyText: 'X', status: 'draft', emailId: 'e1' });
    const e2 = buildEmailRecord(UID, { subject: 'B', bodyText: 'X', status: 'sent', emailId: 'e2' });
    await saveEmail(UID, e1);
    await saveEmail(UID, e2);
    __setFirestoreForTests(db);
    const drafts = await listEmails(UID, { status: 'draft' });
    expect(drafts.every(e => e.status === 'draft')).toBe(true);
  });
});

describe('updateEmailStats', () => {
  test('actualiza openCount y clickCount', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const e = buildEmailRecord(UID, { subject: 'T', bodyText: 'X', emailId: 'email_stats' });
    await saveEmail(UID, e);
    __setFirestoreForTests(db);
    await updateEmailStats(UID, 'email_stats', { openCount: 45, clickCount: 12 });
    __setFirestoreForTests(db);
    const loaded = await getEmail(UID, 'email_stats');
    expect(loaded.openCount).toBe(45);
    expect(loaded.clickCount).toBe(12);
  });
});

// ─── PIPELINE: campaña promocional completa ──────────────────────────────────
describe('Pipeline: campana promocional completa', () => {
  test('draft → recipients → schedule → send → stats', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    // 1. Crear email draft
    let email = buildEmailRecord(UID, {
      subject: 'Promo Mayo 2026 — 20% descuento',
      bodyText: 'Hola! Tenes un 20% de descuento este mes.',
      bodyHtml: '<h1>20% OFF</h1><p>Solo por Mayo 2026</p>',
      type: 'promotional',
      from: 'promos@miia-app.com',
      fromName: 'MIIA Promos',
    });
    expect(email.status).toBe('draft');
    expect(email.recipientCount).toBe(0);

    // 2. Validar
    const validation = validateEmailData({ subject: email.subject, bodyText: email.bodyText, from: email.from });
    expect(validation.valid).toBe(true);

    // 3. Agregar destinatarios
    email = addRecipients(email, ['ana@test.com', 'carlos@test.com', 'lucia@test.com', 'INVALID_EMAIL']);
    expect(email.recipientCount).toBe(3);

    // 4. Programar para el futuro
    const futureTs = Date.now() + 3600000; // 1h
    email = scheduleEmail(email, futureTs);
    expect(email.status).toBe('queued');
    expect(email.scheduledAt).toBe(futureTs);

    // 5. Guardar en Firestore
    await saveEmail(UID, email);
    __setFirestoreForTests(db);
    const loaded = await getEmail(UID, email.emailId);
    expect(loaded.recipientCount).toBe(3);
    expect(loaded.status).toBe('queued');

    // 6. Marcar como enviado
    __setFirestoreForTests(db);
    await updateEmailStatus(UID, email.emailId, 'sent');

    // 7. Actualizar estadisticas post-envio
    __setFirestoreForTests(db);
    await updateEmailStats(UID, email.emailId, { openCount: 2, clickCount: 1, bounceCount: 0 });

    // 8. Verificar stats finales
    __setFirestoreForTests(db);
    const final = await getEmail(UID, email.emailId);
    expect(final.status).toBe('sent');
    expect(final.sentAt).toBeDefined();
    expect(final.openCount).toBe(2);

    const stats = buildEmailStats(final);
    expect(stats.openRate).toBe(67); // 2/3 * 100 rounded
    expect(stats.clickRate).toBe(33); // 1/3 * 100 rounded

    // 9. Resumen
    const summary = buildEmailSummaryText(final);
    expect(summary).toContain('Promo Mayo 2026');
    expect(summary).toContain('sent');
    expect(summary).toContain('Aperturas');
  });
});
