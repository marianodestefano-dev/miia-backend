'use strict';

const rn = require('../core/referido_natural');
const {
  registerNaturalReferral,
  getReferrer,
  claimReferralReward,
  createTicket,
  updateTicketState,
  getActiveTickets,
  setAsistenteMode,
  getAsistenteMode,
  shouldAssistProactively,
  ASISTENTE_MODES,
  __setFirestoreForTests,
} = rn;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const referidos = o.referidos || {};
  const tickets = o.tickets || {};
  const asistente = o.asistente; // {exists, data} or undefined
  const captures = { referidoSets: [], ticketSets: [], asistenteSets: [] };

  const referidosColMethods = {
    doc: jest.fn((phone) => ({
      get: jest.fn().mockResolvedValue({ exists: !!referidos[phone], data: () => referidos[phone] || {} }),
      set: jest.fn((payload, merge) => { captures.referidoSets.push({ phone, payload, merge }); return Promise.resolve({}); }),
    })),
  };

  const ticketsColMethods = {
    doc: jest.fn((id) => ({
      get: jest.fn().mockResolvedValue({ exists: !!tickets[id], data: () => tickets[id] || {} }),
      set: jest.fn((payload, merge) => { captures.ticketSets.push({ id, payload, merge }); return Promise.resolve({}); }),
    })),
    get: jest.fn().mockResolvedValue({
      forEach: function (cb) {
        Object.keys(tickets).forEach(function (id) {
          cb({ data: () => tickets[id] });
        });
      },
    }),
  };

  const asistenteDocMethods = {
    get: jest.fn().mockResolvedValue(asistente !== undefined ? asistente : { exists: false, data: () => ({}) }),
    set: jest.fn((payload, merge) => { captures.asistenteSets.push({ payload, merge }); return Promise.resolve({}); }),
  };

  const subcollFn = jest.fn((subColName) => {
    if (subColName === 'referidos') return referidosColMethods;
    if (subColName === 'tickets') return ticketsColMethods;
    return { doc: jest.fn(() => asistenteDocMethods) };
  });

  const ownerDocFn = jest.fn(() => ({ collection: subcollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── registerNaturalReferral ───────────────────────────────────────────────────

describe('registerNaturalReferral', () => {
  test('uid null -> throw', async () => {
    await expect(registerNaturalReferral(null, 'p1', 'p2')).rejects.toThrow('uid_requerido');
  });
  test('leadPhone null -> throw', async () => {
    await expect(registerNaturalReferral('u1', null, 'p2')).rejects.toThrow('leadPhone_requerido');
  });
  test('referrerPhone null -> throw', async () => {
    await expect(registerNaturalReferral('u1', 'p1', null)).rejects.toThrow('referrerPhone_requerido');
  });
  test('mismo phone -> throw', async () => {
    await expect(registerNaturalReferral('u1', 'p1', 'p1')).rejects.toThrow('mismo_phone_invalido');
  });

  test('OK con referrerName', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    const r = await registerNaturalReferral('uid123456', '5491100', '5491200', { referrerName: 'Ana' });
    expect(r.ok).toBe(true);
    expect(captures.referidoSets[0].payload.referrerName).toBe('Ana');
    expect(captures.referidoSets[0].payload.rewardClaimed).toBe(false);
  });

  test('OK sin opts -> referrerName null', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    await registerNaturalReferral('uid123456', '5491100', '5491200');
    expect(captures.referidoSets[0].payload.referrerName).toBeNull();
  });
});

// ── getReferrer ───────────────────────────────────────────────────────────────

describe('getReferrer', () => {
  test('uid null -> null', async () => {
    expect(await getReferrer(null, 'p1')).toBeNull();
  });
  test('leadPhone null -> null', async () => {
    expect(await getReferrer('u1', null)).toBeNull();
  });

  test('no existe -> null', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getReferrer('uid123456', '5491100')).toBeNull();
  });

  test('OK - retorna referrer con name', async () => {
    const { db } = makeDb({
      referidos: { '5491100': { referrerPhone: '5491200', referrerName: 'Ana', rewardClaimed: true } },
    });
    __setFirestoreForTests(db);
    const r = await getReferrer('uid123456', '5491100');
    expect(r.referrerPhone).toBe('5491200');
    expect(r.referrerName).toBe('Ana');
    expect(r.rewardClaimed).toBe(true);
  });

  test('OK - sin referrerName ni rewardClaimed -> defaults', async () => {
    const { db } = makeDb({
      referidos: { '5491100': { referrerPhone: '5491200' } },
    });
    __setFirestoreForTests(db);
    const r = await getReferrer('uid123456', '5491100');
    expect(r.referrerName).toBeNull();
    expect(r.rewardClaimed).toBe(false);
  });
});

// ── claimReferralReward ───────────────────────────────────────────────────────

describe('claimReferralReward', () => {
  test('uid null -> throw', async () => {
    await expect(claimReferralReward(null, 'p1')).rejects.toThrow('parametros_requeridos');
  });
  test('leadPhone null -> throw', async () => {
    await expect(claimReferralReward('u1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('referido no encontrado -> throw', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    await expect(claimReferralReward('uid123456', '5491100')).rejects.toThrow('referido_no_encontrado');
  });

  test('reward ya reclamado -> throw', async () => {
    const { db } = makeDb({
      referidos: { '5491100': { referrerPhone: '5491200', rewardClaimed: true } },
    });
    __setFirestoreForTests(db);
    await expect(claimReferralReward('uid123456', '5491100')).rejects.toThrow('reward_ya_reclamado');
  });

  test('OK', async () => {
    const { db, captures } = makeDb({
      referidos: { '5491100': { referrerPhone: '5491200', rewardClaimed: false } },
    });
    __setFirestoreForTests(db);
    const r = await claimReferralReward('uid123456', '5491100');
    expect(r.ok).toBe(true);
    expect(r.referrerPhone).toBe('5491200');
    expect(captures.referidoSets[0].payload.rewardClaimed).toBe(true);
  });
});

// ── createTicket ──────────────────────────────────────────────────────────────

describe('createTicket', () => {
  test('uid null -> throw', async () => {
    await expect(createTicket(null, { title: 'X' })).rejects.toThrow('uid_requerido');
  });
  test('payload null -> throw', async () => {
    await expect(createTicket('u1', null)).rejects.toThrow('titulo_requerido');
  });
  test('payload sin title -> throw', async () => {
    await expect(createTicket('u1', {})).rejects.toThrow('titulo_requerido');
  });

  test('OK - priority default normal', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await createTicket('uid123456', { title: 'Problema' });
    expect(r.ok).toBe(true);
    expect(r.priority).toBe('normal');
    expect(r.state).toBe('open');
    expect(captures.ticketSets[0].payload.priority).toBe('normal');
  });

  test('OK - priority alta valida', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await createTicket('uid123456', { title: 'X', priority: 'urgent' });
    expect(r.priority).toBe('urgent');
  });

  test('priority invalida -> normal', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await createTicket('uid123456', { title: 'X', priority: 'foo' });
    expect(r.priority).toBe('normal');
  });

  test('OK con description y fromPhone', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await createTicket('uid123456', { title: 'X', description: 'Detalle', fromPhone: '5491' });
    expect(captures.ticketSets[0].payload.description).toBe('Detalle');
    expect(captures.ticketSets[0].payload.fromPhone).toBe('5491');
  });

  test('OK sin description -> empty string, sin fromPhone -> null', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await createTicket('uid123456', { title: 'X' });
    expect(captures.ticketSets[0].payload.description).toBe('');
    expect(captures.ticketSets[0].payload.fromPhone).toBeNull();
  });

  test('title largo -> truncado a 200', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await createTicket('uid123456', { title: 'x'.repeat(500) });
    expect(captures.ticketSets[0].payload.title.length).toBe(200);
  });

  test('description larga -> truncada a 5000', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await createTicket('uid123456', { title: 'X', description: 'y'.repeat(10000) });
    expect(captures.ticketSets[0].payload.description.length).toBe(5000);
  });
});

// ── updateTicketState ─────────────────────────────────────────────────────────

describe('updateTicketState', () => {
  test('uid null -> throw', async () => {
    await expect(updateTicketState(null, 't1', 'open')).rejects.toThrow('parametros_requeridos');
  });
  test('ticketId null -> throw', async () => {
    await expect(updateTicketState('u1', null, 'open')).rejects.toThrow('parametros_requeridos');
  });
  test('state invalido -> throw', async () => {
    await expect(updateTicketState('u1', 't1', 'foo')).rejects.toThrow('state_invalido');
  });

  test('OK - resolved', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await updateTicketState('uid123456', 'tkt_1', 'resolved');
    expect(r.ok).toBe(true);
    expect(captures.ticketSets[0].payload.state).toBe('resolved');
  });
});

// ── getActiveTickets ──────────────────────────────────────────────────────────

describe('getActiveTickets', () => {
  test('uid null -> throw', async () => {
    await expect(getActiveTickets(null)).rejects.toThrow('uid_requerido');
  });

  test('sin tickets -> []', async () => {
    const { db } = makeDb({ tickets: {} });
    __setFirestoreForTests(db);
    expect(await getActiveTickets('uid123456')).toEqual([]);
  });

  test('mezcla activos y cerrados -> solo activos', async () => {
    const { db } = makeDb({
      tickets: {
        t1: { ticketId: 't1', state: 'open', createdAt: '2026-05-01' },
        t2: { ticketId: 't2', state: 'resolved', createdAt: '2026-05-02' },
        t3: { ticketId: 't3', state: 'closed', createdAt: '2026-05-03' },
        t4: { ticketId: 't4', state: 'in_progress', createdAt: '2026-05-04' },
      },
    });
    __setFirestoreForTests(db);
    const r = await getActiveTickets('uid123456');
    expect(r).toHaveLength(2);
    // ordered by createdAt desc
    expect(r[0].ticketId).toBe('t4');
    expect(r[1].ticketId).toBe('t1');
  });
});

// ── setAsistenteMode ──────────────────────────────────────────────────────────

describe('setAsistenteMode', () => {
  test('uid null -> throw', async () => {
    await expect(setAsistenteMode(null, 'off')).rejects.toThrow('uid_requerido');
  });
  test('mode invalido -> throw', async () => {
    await expect(setAsistenteMode('u1', 'foo')).rejects.toThrow('mode_invalido');
  });

  test('OK - off', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setAsistenteMode('uid123456', ASISTENTE_MODES.OFF);
    expect(r.mode).toBe('off');
    expect(captures.asistenteSets[0].payload.mode).toBe('off');
  });

  test('OK - proactive', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setAsistenteMode('uid123456', ASISTENTE_MODES.PROACTIVE);
    expect(r.mode).toBe('proactive');
  });

  test('OK - silent', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setAsistenteMode('uid123456', ASISTENTE_MODES.SILENT);
    expect(r.mode).toBe('silent');
  });
});

// ── getAsistenteMode ──────────────────────────────────────────────────────────

describe('getAsistenteMode', () => {
  test('uid null -> throw', async () => {
    await expect(getAsistenteMode(null)).rejects.toThrow('uid_requerido');
  });

  test('doc no existe -> off (default)', async () => {
    const { db } = makeDb({ asistente: { exists: false, data: () => ({}) } });
    __setFirestoreForTests(db);
    expect(await getAsistenteMode('uid123456')).toBe('off');
  });

  test('doc existe con mode -> retorna mode', async () => {
    const { db } = makeDb({ asistente: { exists: true, data: () => ({ mode: 'proactive' }) } });
    __setFirestoreForTests(db);
    expect(await getAsistenteMode('uid123456')).toBe('proactive');
  });

  test('doc existe sin mode -> off (fallback)', async () => {
    const { db } = makeDb({ asistente: { exists: true, data: () => ({}) } });
    __setFirestoreForTests(db);
    expect(await getAsistenteMode('uid123456')).toBe('off');
  });
});

// ── shouldAssistProactively ───────────────────────────────────────────────────

describe('shouldAssistProactively', () => {
  test('mode=proactive -> true', async () => {
    const { db } = makeDb({ asistente: { exists: true, data: () => ({ mode: 'proactive' }) } });
    __setFirestoreForTests(db);
    expect(await shouldAssistProactively('uid123456')).toBe(true);
  });

  test('mode=off -> false', async () => {
    const { db } = makeDb({ asistente: { exists: true, data: () => ({ mode: 'off' }) } });
    __setFirestoreForTests(db);
    expect(await shouldAssistProactively('uid123456')).toBe(false);
  });

  test('mode=silent -> false', async () => {
    const { db } = makeDb({ asistente: { exists: true, data: () => ({ mode: 'silent' }) } });
    __setFirestoreForTests(db);
    expect(await shouldAssistProactively('uid123456')).toBe(false);
  });
});
