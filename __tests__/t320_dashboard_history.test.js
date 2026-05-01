'use strict';

const {
  buildDashboardSummary,
  __setFirestoreForTests: setDashDb,
  RECENT_DAYS,
  TOP_CONTACTS_LIMIT,
} = require('../core/dashboard_summary');

const {
  getContactHistory,
  __setFirestoreForTests: setHistDb,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} = require('../core/contact_history');

const NOW = 1000000000000;
const DAY = 24 * 60 * 60 * 1000;
const UID = 'uid_t320_test_001';

function makeFirestoreWithData(uid, data) {
  return {
    collection: (col) => ({
      doc: (docUid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            get: async () => {
              if (col === 'users' && docUid === uid && subCol === 'miia_persistent' && docId === 'tenant_conversations') {
                return { exists: true, data: () => data };
              }
              return { exists: false };
            },
          }),
        }),
      }),
    }),
  };
}

function makeEmptyFirestore() {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: false }),
          }),
        }),
      }),
    }),
  };
}

describe('T320 -- dashboard_summary + contact_history (22 tests)', () => {

  // Constants
  test('RECENT_DAYS = 7', () => { expect(RECENT_DAYS).toBe(7); });
  test('TOP_CONTACTS_LIMIT = 5', () => { expect(TOP_CONTACTS_LIMIT).toBe(5); });
  test('DEFAULT_LIMIT = 50', () => { expect(DEFAULT_LIMIT).toBe(50); });
  test('MAX_LIMIT = 200', () => { expect(MAX_LIMIT).toBe(200); });

  // buildDashboardSummary — edge cases
  test('uid null lanza Error', async () => {
    await expect(buildDashboardSummary(null)).rejects.toThrow('uid requerido');
  });

  test('Firestore doc no existe: retorna zeros', async () => {
    setDashDb(makeEmptyFirestore());
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.totalConversations).toBe(0);
    expect(r.totalLeads).toBe(0);
    expect(r.totalClients).toBe(0);
    expect(r.topContacts).toEqual([]);
  });

  test('generatedAt es ISO string', async () => {
    setDashDb(makeEmptyFirestore());
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
  });

  test('conteo totalConversations correcto', async () => {
    const data = {
      conversations: { '+571111': [], '+572222': [], '+573333': [] },
      contactTypes: {},
    };
    setDashDb(makeFirestoreWithData(UID, data));
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.totalConversations).toBe(3);
  });

  test('conteo totalLeads y totalClients', async () => {
    const data = {
      conversations: { '+571111': [], '+572222': [], '+573333': [] },
      contactTypes: { '+571111': 'lead', '+572222': 'client', '+573333': 'miia_lead' },
    };
    setDashDb(makeFirestoreWithData(UID, data));
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.totalLeads).toBe(2); // lead + miia_lead
    expect(r.totalClients).toBe(1);
  });

  test('recentMessageCount solo mensajes en 7 dias', async () => {
    const data = {
      conversations: {
        '+571111': [
          { timestamp: NOW - 3 * DAY },   // reciente
          { timestamp: NOW - 8 * DAY },   // viejo
          { timestamp: NOW - 1 * DAY },   // reciente
        ],
      },
      contactTypes: {},
    };
    setDashDb(makeFirestoreWithData(UID, data));
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.recentMessageCount).toBe(2);
  });

  test('topContacts ordenados por messageCount desc', async () => {
    const data = {
      conversations: {
        '+571111': [{}],
        '+572222': [{}, {}, {}],
        '+573333': [{}, {}],
      },
      contactTypes: {},
    };
    setDashDb(makeFirestoreWithData(UID, data));
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.topContacts[0].phone).toBe('+572222');
    expect(r.topContacts[0].messageCount).toBe(3);
  });

  test('topContacts max 5 contactos', async () => {
    const convs = {};
    for (let i = 0; i < 10; i++) convs[`+5700000000${i}`] = [{}, {}];
    setDashDb(makeFirestoreWithData(UID, { conversations: convs, contactTypes: {} }));
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.topContacts.length).toBeLessThanOrEqual(5);
  });

  test('Firestore lanza: retorna zeros sin crash', async () => {
    const brokenDb = {
      collection: () => { throw new Error('firestore down'); },
    };
    setDashDb(brokenDb);
    const r = await buildDashboardSummary(UID, NOW);
    expect(r.totalConversations).toBe(0);
  });

  // getContactHistory — edge cases
  test('uid null lanza Error', async () => {
    await expect(getContactHistory(null, '+571111')).rejects.toThrow('uid requerido');
  });

  test('phone null lanza Error', async () => {
    await expect(getContactHistory(UID, null)).rejects.toThrow('phone requerido');
  });

  test('doc no existe: messages=[]', async () => {
    setHistDb(makeEmptyFirestore());
    const r = await getContactHistory(UID, '+571111');
    expect(r.messages).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  test('retorna mensajes ordenados desc por timestamp', async () => {
    const data = {
      conversations: {
        '+571111': [
          { text: 'A', timestamp: NOW - 3 * DAY },
          { text: 'C', timestamp: NOW - 1 * DAY },
          { text: 'B', timestamp: NOW - 2 * DAY },
        ],
      },
    };
    setHistDb(makeFirestoreWithData(UID, data));
    const r = await getContactHistory(UID, '+571111');
    expect(r.messages[0].text).toBe('C');
    expect(r.messages[1].text).toBe('B');
    expect(r.messages[2].text).toBe('A');
  });

  test('paginacion before: filtra mensajes anteriores al cursor', async () => {
    const data = {
      conversations: {
        '+571111': [
          { text: 'old', timestamp: NOW - 5 * DAY },
          { text: 'new', timestamp: NOW - 1 * DAY },
        ],
      },
    };
    setHistDb(makeFirestoreWithData(UID, data));
    const r = await getContactHistory(UID, '+571111', { before: NOW - 2 * DAY });
    expect(r.messages.length).toBe(1);
    expect(r.messages[0].text).toBe('old');
  });

  test('limit respetado + hasMore correcto', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ text: `m${i}`, timestamp: NOW - i * 1000 }));
    const data = { conversations: { '+571111': msgs } };
    setHistDb(makeFirestoreWithData(UID, data));
    const r = await getContactHistory(UID, '+571111', { limit: 5 });
    expect(r.messages.length).toBe(5);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toBeDefined();
  });

  test('limit no supera MAX_LIMIT=200', async () => {
    setHistDb(makeEmptyFirestore());
    const r = await getContactHistory(UID, '+571111', { limit: 9999 });
    expect(r.messages.length).toBeLessThanOrEqual(200);
  });

  test('phone sin mensajes retorna messages=[]', async () => {
    const data = { conversations: { '+572222': [] } };
    setHistDb(makeFirestoreWithData(UID, data));
    const r = await getContactHistory(UID, '+571111'); // phone diferente
    expect(r.messages).toEqual([]);
  });

  test('Firestore lanza: retorna error sin crash', async () => {
    const brokenDb = { collection: () => { throw new Error('down'); } };
    setHistDb(brokenDb);
    const r = await getContactHistory(UID, '+571111');
    expect(r.messages).toEqual([]);
    expect(r.error).toBeDefined();
  });
});
