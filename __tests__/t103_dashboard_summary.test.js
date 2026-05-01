'use strict';
const { buildDashboardSummary, RECENT_DAYS, TOP_CONTACTS_LIMIT, __setFirestoreForTests } = require('../core/dashboard_summary');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1000000000000;

function makeMockDb({ data=null, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (data) return { exists: true, data: () => data };
              return { exists: false };
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('buildDashboardSummary — validacion', () => {
  test('lanza error si uid vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(buildDashboardSummary('')).rejects.toThrow('uid requerido');
  });
  test('lanza error si uid no es string', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(buildDashboardSummary(12345)).rejects.toThrow('uid requerido');
  });
});

describe('buildDashboardSummary — campos requeridos', () => {
  test('retorna todos los campos con Firestore vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await buildDashboardSummary('uid1', NOW);
    expect(r).toHaveProperty('uid', 'uid1');
    expect(r).toHaveProperty('totalConversations', 0);
    expect(r).toHaveProperty('totalLeads', 0);
    expect(r).toHaveProperty('totalClients', 0);
    expect(r).toHaveProperty('totalContacts', 0);
    expect(r).toHaveProperty('recentMessageCount', 0);
    expect(r).toHaveProperty('topContacts');
    expect(r).toHaveProperty('generatedAt');
    expect(Array.isArray(r.topContacts)).toBe(true);
  });
});

describe('buildDashboardSummary — conteos', () => {
  test('cuenta totalConversations correctamente', async () => {
    const data = {
      conversations: { '+573001': [], '+573002': [], '+573003': [] },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await buildDashboardSummary('uid1', NOW);
    expect(r.totalConversations).toBe(3);
  });

  test('cuenta leads y clients por contactTypes', async () => {
    const data = {
      conversations: { '+573001': [], '+573002': [], '+573003': [], '+573004': [] },
      contactTypes: {
        '+573001': 'lead',
        '+573002': 'client',
        '+573003': 'miia_lead',
        '+573004': 'unknown'
      }
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await buildDashboardSummary('uid1', NOW);
    expect(r.totalLeads).toBe(2); // lead + miia_lead
    expect(r.totalClients).toBe(1);
    expect(r.totalContacts).toBe(4);
  });

  test('recentMessageCount cuenta solo mensajes en los ultimos 7 dias', async () => {
    const recentTs = NOW - 3 * DAY_MS; // 3 dias atras = reciente
    const oldTs = NOW - 10 * DAY_MS;  // 10 dias atras = viejo
    const data = {
      conversations: {
        '+573001': [
          { text: 'hola', timestamp: recentTs },
          { text: 'viejo', timestamp: oldTs }
        ]
      },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await buildDashboardSummary('uid1', NOW);
    expect(r.recentMessageCount).toBe(1); // solo el reciente
  });

  test('topContacts son los 5 mas activos por totalMessages', async () => {
    const data = {
      conversations: {
        '+a': Array(10).fill({ text: 'x' }),
        '+b': Array(5).fill({ text: 'x' }),
        '+c': Array(8).fill({ text: 'x' }),
        '+d': Array(2).fill({ text: 'x' }),
        '+e': Array(9).fill({ text: 'x' }),
        '+f': Array(1).fill({ text: 'x' })
      },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ data }));
    const r = await buildDashboardSummary('uid1', NOW);
    expect(r.topContacts.length).toBe(5);
    expect(r.topContacts[0].phone).toBe('+a'); // 10 msgs
    expect(r.topContacts[1].phone).toBe('+e'); // 9 msgs
  });
});

describe('buildDashboardSummary — resiliencia', () => {
  test('retorna resultado parcial si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await buildDashboardSummary('uid1', NOW);
    expect(r.uid).toBe('uid1');
    expect(r.totalConversations).toBe(0);
  });
});
