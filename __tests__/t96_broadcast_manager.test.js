'use strict';
const { scheduleBroadcast, processBroadcast, getBroadcastStatus, CONTACT_FILTERS, __setFirestoreForTests } = require('../core/broadcast_manager');

const UID = 'testOwner999';

function makeMockDb({ scheduleData=null, throwSchedule=false, throwGet=false, throwUpdate=false }={}) {
  const docs = {};
  return {
    collection: () => ({
      doc: (uid) => ({
        collection: (col) => ({
          doc: (docId) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const key = `${uid}/${col}/${docId}`;
              if (docs[key]) return { exists: true, data: () => docs[key] };
              if (scheduleData && col === 'items') return { exists: true, data: () => scheduleData };
              return { exists: false };
            },
            set: async (data) => {
              if (throwSchedule) throw new Error('set error');
              const key = `${uid}/${col}/${docId}`;
              docs[key] = data;
            },
            update: async (data) => {
              if (throwUpdate) throw new Error('update error');
              const key = `${uid}/${col}/${docId}`;
              docs[key] = Object.assign({}, docs[key] || {}, data);
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('CONTACT_FILTERS', () => {
  test('tiene los 3 filtros esperados y está frozen', () => {
    expect(CONTACT_FILTERS).toContain('all_leads');
    expect(CONTACT_FILTERS).toContain('all_clients');
    expect(CONTACT_FILTERS).toContain('all_contacts');
    expect(() => { CONTACT_FILTERS.push('extra'); }).toThrow();
  });
});

describe('scheduleBroadcast — validacion inputs', () => {
  test('lanza error si uid es undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(scheduleBroadcast(undefined, { message: 'hola', contactFilter: 'all_leads' }))
      .rejects.toThrow('uid requerido');
  });
  test('lanza error si message es vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(scheduleBroadcast(UID, { message: '', contactFilter: 'all_leads' }))
      .rejects.toThrow('message requerido');
  });
  test('lanza error si contactFilter invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(scheduleBroadcast(UID, { message: 'test', contactFilter: 'invalid_filter' }))
      .rejects.toThrow('contactFilter inválido');
  });
});

describe('scheduleBroadcast — exito', () => {
  test('retorna objeto con broadcastId y status pending', async () => {
    __setFirestoreForTests(makeMockDb());
    const result = await scheduleBroadcast(UID, { message: 'Hola a todos', contactFilter: 'all_leads' });
    expect(result).toHaveProperty('broadcastId');
    expect(result.uid).toBe(UID);
    expect(result.message).toBe('Hola a todos');
    expect(result.contactFilter).toBe('all_leads');
    expect(result.status).toBe('pending');
    expect(result).toHaveProperty('createdAt');
  });
  test('scheduledAt se incluye cuando se pasa', async () => {
    __setFirestoreForTests(makeMockDb());
    const scheduled = new Date('2026-06-01T10:00:00Z').toISOString();
    const result = await scheduleBroadcast(UID, { message: 'Promo', contactFilter: 'all_clients', scheduledAt: scheduled });
    expect(result.scheduledAt).toBe(scheduled);
  });
  test('lanza error si Firestore falla al guardar', async () => {
    __setFirestoreForTests(makeMockDb({ throwSchedule: true }));
    await expect(scheduleBroadcast(UID, { message: 'test', contactFilter: 'all_leads' }))
      .rejects.toThrow();
  });
});

describe('processBroadcast — filtros de contactos', () => {
  test('all_leads solo envia a leads', async () => {
    __setFirestoreForTests(makeMockDb({
      scheduleData: { message: 'test', contactFilter: 'all_leads', status: 'pending' }
    }));
    const sent = [];
    const sendFn = async (phone, msg) => { sent.push(phone); };
    const contacts = {
      '+573001': { status: 'lead' },
      '+573002': { status: 'client' },
      '+573003': { status: 'lead' },
      '+573004': { status: 'ignored' }
    };
    await processBroadcast(UID, 'broadcast123', sendFn, contacts);
    expect(sent).toContain('+573001');
    expect(sent).toContain('+573003');
    expect(sent).not.toContain('+573002');
    expect(sent).not.toContain('+573004');
  });

  test('all_clients solo envia a clients', async () => {
    __setFirestoreForTests(makeMockDb({
      scheduleData: { message: 'test', contactFilter: 'all_clients', status: 'pending' }
    }));
    const sent = [];
    const sendFn = async (phone, msg) => { sent.push(phone); };
    const contacts = {
      '+573001': { status: 'lead' },
      '+573002': { status: 'client' }
    };
    await processBroadcast(UID, 'bc_cli', sendFn, contacts);
    expect(sent).not.toContain('+573001');
    expect(sent).toContain('+573002');
  });

  test('all_contacts envia a leads y clients pero no a ignored/blocked', async () => {
    __setFirestoreForTests(makeMockDb({
      scheduleData: { message: 'test', contactFilter: 'all_contacts', status: 'pending' }
    }));
    const sent = [];
    const sendFn = async (phone, msg) => { sent.push(phone); };
    const contacts = {
      '+573001': { status: 'lead' },
      '+573002': { status: 'client' },
      '+573003': { status: 'ignored' },
      '+573004': { status: 'blocked' }
    };
    await processBroadcast(UID, 'bc_all', sendFn, contacts);
    expect(sent).toContain('+573001');
    expect(sent).toContain('+573002');
    expect(sent).not.toContain('+573003');
    expect(sent).not.toContain('+573004');
  });

  test('retorna objeto con sentCount y failedCount', async () => {
    __setFirestoreForTests(makeMockDb({
      scheduleData: { message: 'hola', contactFilter: 'all_leads', status: 'pending' }
    }));
    let callCount = 0;
    const sendFn = async (phone, msg) => {
      callCount++;
      if (phone === '+573002') throw new Error('send fail');
    };
    const contacts = {
      '+573001': { status: 'lead' },
      '+573002': { status: 'lead' },
      '+573003': { status: 'lead' }
    };
    const result = await processBroadcast(UID, 'bc_counts', sendFn, contacts);
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(1);
  });
});

describe('getBroadcastStatus', () => {
  test('retorna status y conteos desde Firestore', async () => {
    const scheduleData = {
      status: 'completed', sentCount: 10, failedCount: 2, message: 'hola', contactFilter: 'all_leads'
    };
    __setFirestoreForTests(makeMockDb({ scheduleData }));
    const status = await getBroadcastStatus(UID, 'bc_status_test');
    expect(status.broadcastId).toBe('bc_status_test');
    expect(status.status).toBe('completed');
    expect(status.sentCount).toBe(10);
    expect(status.failedCount).toBe(2);
  });

  test('retorna not_found si broadcastId no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    const status = await getBroadcastStatus(UID, 'bc_no_existe');
    expect(status.status).toBe('not_found');
  });

  test('lanza error si uid es invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getBroadcastStatus('', 'bc_test')).rejects.toThrow('uid requerido');
  });

  test('retorna error si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const status = await getBroadcastStatus(UID, 'bc_err');
    expect(status.status).toBe('error');
  });
});

describe('processBroadcast — resiliencia', () => {
  test('si Firestore update falla, igual retorna resultado parcial', async () => {
    __setFirestoreForTests(makeMockDb({
      scheduleData: { message: 'test', contactFilter: 'all_leads', status: 'pending' },
      throwUpdate: true
    }));
    const sent = [];
    const sendFn = async (phone, msg) => { sent.push(phone); };
    const contacts = { '+573001': { status: 'lead' } };
    const result = await processBroadcast(UID, 'bc_resilient', sendFn, contacts);
    expect(sent).toContain('+573001');
    expect(result).toHaveProperty('sentCount');
  });

  test('si broadcast no existe en Firestore, lanza error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(processBroadcast(UID, 'no_existe', async () => {}, {}))
      .rejects.toThrow();
  });
});
