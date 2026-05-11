'use strict';
const stm = require('../core/support_ticket_manager');

function makeDb({ exists = true, messages = [] } = {}) {
  const docRef = {
    set: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({ exists, data: () => ({ messages, status: 'open' }) }),
    update: jest.fn().mockResolvedValue({}),
  };
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue(docRef),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => [{ data: () => ({ id: 't1' }) }].forEach(fn)) }),
    }),
  };
}

beforeEach(() => { stm.__setFirestoreForTests(makeDb()); jest.clearAllMocks(); });

describe('createTicket', () => {
  test('!uid → throw', async () => { await expect(stm.createTicket('', { subject: 's', description: 'd' })).rejects.toThrow('required'); });
  test('!subject → throw', async () => { await expect(stm.createTicket('uid1', { description: 'd' })).rejects.toThrow('required'); });
  test('!description → throw', async () => { await expect(stm.createTicket('uid1', { subject: 's' })).rejects.toThrow('required'); });
  test('sin priority → MEDIUM (branch priority falsy)', async () => { const t = await stm.createTicket('uid1', { subject: 'T', description: 'D' }); expect(t.priority).toBe('medium'); });
  test('con priority → usa la dada (branch priority truthy)', async () => { const t = await stm.createTicket('uid1', { subject: 'T', description: 'D', priority: 'urgent' }); expect(t.priority).toBe('urgent'); });
  test('sin opts → opts={} (branch opts||{})', async () => { await expect(stm.createTicket('uid1')).rejects.toThrow('required'); });
});

describe('replyToTicket', () => {
  test('!ticketId → throw', async () => { await expect(stm.replyToTicket('', 'uid1', 'msg')).rejects.toThrow('required'); });
  test('!fromUid → throw', async () => { await expect(stm.replyToTicket('t1', '', 'msg')).rejects.toThrow('required'); });
  test('!message → throw', async () => { await expect(stm.replyToTicket('t1', 'uid1', '')).rejects.toThrow('required'); });
  test('snap.exists=false → ticket not found (branch !snap.exists)', async () => {
    stm.__setFirestoreForTests(makeDb({ exists: false }));
    await expect(stm.replyToTicket('t1', 'uid1', 'msg')).rejects.toThrow('ticket not found');
  });
  test('ticket sin messages → [] (branch ticket.messages falsy)', async () => {
    stm.__setFirestoreForTests(makeDb({ exists: true, messages: null }));
    const r = await stm.replyToTicket('t1', 'uid1', 'Hola');
    expect(r.ticketId).toBe('t1');
  });
  test('ticket con messages → spread (branch ticket.messages truthy)', async () => {
    stm.__setFirestoreForTests(makeDb({ exists: true, messages: [{ from: 'prev', message: 'ant' }] }));
    const r = await stm.replyToTicket('t1', 'uid1', 'Hola');
    expect(r.reply.message).toBe('Hola');
  });
});

describe('closeTicket', () => {
  test('!ticketId → throw', async () => { await expect(stm.closeTicket('')).rejects.toThrow('ticketId required'); });
  test('sin resolution → default (branch resolution falsy)', async () => { const r = await stm.closeTicket('t1'); expect(r.status).toBe('resolved'); });
  test('con resolution → la dada (branch resolution truthy)', async () => { const r = await stm.closeTicket('t1', 'fixed'); expect(r.status).toBe('resolved'); });
});

describe('listTickets', () => {
  test('sin opts → sin filtros (both false branches)', async () => { const t = await stm.listTickets(); expect(Array.isArray(t)).toBe(true); });
  test('con opts.status → filtra (branch opts&&status true)', async () => { const t = await stm.listTickets({ status: 'open' }); expect(Array.isArray(t)).toBe(true); });
  test('con opts.uid → filtra (branch opts&&uid true)', async () => { const t = await stm.listTickets({ uid: 'uid1' }); expect(Array.isArray(t)).toBe(true); });
  test('con opts.status y opts.uid → ambos filtros', async () => { const t = await stm.listTickets({ status: 'open', uid: 'uid1' }); expect(Array.isArray(t)).toBe(true); });
});

describe('getDb fallback', () => {
  test('_db=null usa require firebase (branch _db falsy)', async () => {
    jest.resetModules();
    const fbDb = { collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }), where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn() }) }) };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const fm = require('../core/support_ticket_manager');
    await fm.createTicket('uid1', { subject: 'T', description: 'D' });
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase'); jest.resetModules();
  });
});
