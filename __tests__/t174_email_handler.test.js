'use strict';

const {
  processIncomingEmail, sendEmail, getUnifiedThread, addWhatsAppMessageToThread,
  EMAIL_CHANNEL, WHATSAPP_CHANNEL, VALID_CHANNELS,
  __setFirestoreForTests, __setTransportForTests,
} = require('../core/email_handler');

const UID = 'testUid1234567890';

function makeMockDb({ docs = [], throwGet = false, throwSet = false } = {}) {
  const docsMap = {};
  docs.forEach(d => { docsMap[d.messageId || 'msg1'] = d; });
  return {
    collection: () => ({ doc: () => ({
      set: async () => { if (throwSet) throw new Error('set error'); },
      collection: () => ({
        doc: () => ({
          set: async () => { if (throwSet) throw new Error('set error'); },
          collection: () => ({
            doc: () => ({ set: async () => { if (throwSet) throw new Error('set error'); } }),
            get: async () => {
              if (throwGet) throw new Error('get error');
              const items = Object.entries(docsMap).map(([id, d]) => ({ id, data: () => d }));
              return { forEach: fn => items.forEach(fn) };
            },
          }),
        }),
      }),
    })})
  };
}

function makeMockTransport({ throwErr = null } = {}) {
  return {
    sendMail: async (opts) => {
      if (throwErr) throw new Error(throwErr);
    },
  };
}

beforeEach(() => { __setFirestoreForTests(null); __setTransportForTests(null); });
afterEach(() => { __setFirestoreForTests(null); __setTransportForTests(null); });

describe('constants', () => {
  test('EMAIL_CHANNEL y WHATSAPP_CHANNEL definidos', () => {
    expect(EMAIL_CHANNEL).toBe('email');
    expect(WHATSAPP_CHANNEL).toBe('whatsapp');
  });
  test('VALID_CHANNELS es frozen', () => {
    expect(() => { VALID_CHANNELS.push('sms'); }).toThrow();
  });
});

describe('processIncomingEmail', () => {
  const email = { from: 'lead@test.com', subject: 'Consulta', body: 'Hola', messageId: 'msg001', receivedAt: '2026-05-04T12:00:00Z' };
  test('lanza si uid undefined', async () => {
    await expect(processIncomingEmail(undefined, email)).rejects.toThrow('uid requerido');
  });
  test('lanza si email.from undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(processIncomingEmail(UID, { messageId: 'x' })).rejects.toThrow('from requerido');
  });
  test('lanza si email.messageId undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(processIncomingEmail(UID, { from: 'x@x.com' })).rejects.toThrow('messageId');
  });
  test('retorna threadId y stored=true', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await processIncomingEmail(UID, email);
    expect(r.threadId).toBeDefined();
    expect(r.stored).toBe(true);
    expect(r.messageId).toBe('msg001');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(processIncomingEmail(UID, email)).rejects.toThrow('set error');
  });
});

describe('sendEmail', () => {
  test('lanza si uid undefined', async () => {
    await expect(sendEmail(undefined, 'x@x.com', 'Subj', 'Body')).rejects.toThrow('uid requerido');
  });
  test('lanza si to no tiene @', async () => {
    await expect(sendEmail(UID, 'noemail', 'Subj', 'Body')).rejects.toThrow('to invalido');
  });
  test('lanza si subject undefined', async () => {
    await expect(sendEmail(UID, 'x@x.com', undefined, 'Body')).rejects.toThrow('subject requerido');
  });
  test('lanza si body undefined', async () => {
    await expect(sendEmail(UID, 'x@x.com', 'Subj', undefined)).rejects.toThrow('body requerido');
  });
  test('envia y retorna messageId', async () => {
    __setFirestoreForTests(makeMockDb());
    __setTransportForTests(makeMockTransport());
    const r = await sendEmail(UID, 'lead@test.com', 'Respuesta', 'Hola lead!');
    expect(r.sent).toBe(true);
    expect(r.messageId).toBeDefined();
  });
  test('propaga error de transport', async () => {
    __setFirestoreForTests(makeMockDb());
    __setTransportForTests(makeMockTransport({ throwErr: 'smtp error' }));
    await expect(sendEmail(UID, 'lead@test.com', 'Subj', 'Body')).rejects.toThrow('smtp error');
  });
});

describe('getUnifiedThread', () => {
  test('lanza si uid undefined', async () => {
    await expect(getUnifiedThread(undefined, 'tid')).rejects.toThrow('uid requerido');
  });
  test('lanza si threadId undefined', async () => {
    await expect(getUnifiedThread(UID, undefined)).rejects.toThrow('threadId requerido');
  });
  test('retorna mensajes ordenados por tiempo', async () => {
    const docs = [
      { messageId: 'm2', sentAt: '2026-05-04T13:00:00Z', channel: 'email' },
      { messageId: 'm1', receivedAt: '2026-05-04T12:00:00Z', channel: 'whatsapp' },
    ];
    __setFirestoreForTests(makeMockDb({ docs }));
    const r = await getUnifiedThread(UID, 'thread1');
    expect(r.length).toBe(2);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getUnifiedThread(UID, 'tid')).toEqual([]);
  });
});

describe('addWhatsAppMessageToThread', () => {
  const msg = { messageId: 'wa_001', body: 'Hola!', sentAt: '2026-05-04T10:00:00Z', direction: 'inbound' };
  test('lanza si uid undefined', async () => {
    await expect(addWhatsAppMessageToThread(undefined, '+541', msg)).rejects.toThrow('uid requerido');
  });
  test('lanza si message.messageId undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(addWhatsAppMessageToThread(UID, '+541', { body: 'x' })).rejects.toThrow('messageId');
  });
  test('guarda con canal whatsapp', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await addWhatsAppMessageToThread(UID, '+541155667788', msg);
    expect(r.threadId).toBeDefined();
    expect(r.messageId).toBe('wa_001');
  });
});
