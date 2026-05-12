'use strict';

let prb;

function makeDb({ memDocs = [], convDocs = [], contactDocs = [] } = {}) {
  const makeSnap = (docs) => ({ forEach: (fn) => docs.forEach(fn) });
  return {
    collection: jest.fn().mockImplementation((col) => ({
      doc: jest.fn().mockReturnValue({
        collection: jest.fn().mockImplementation((sub) => ({
          get: jest.fn().mockResolvedValue(
            sub === 'miia_memory' ? makeSnap(memDocs) :
            sub === 'conversations' ? makeSnap(convDocs) :
            sub === 'contacts' ? makeSnap(contactDocs) :
            makeSnap([])
          ),
          doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
        })),
      }),
    })),
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  prb = require('../core/privacy_report_builder');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  prb.__setFirestoreForTests(null);
  jest.restoreAllMocks();
});

describe('P1.2 -- getMemoryStats con documentos (lineas 78-81)', () => {
  test('miia_memory con docs de tipo conocido -> cuenta por tipo', async () => {
    const memDocs = [
      { data: () => ({ type: 'personal' }) },
      { data: () => ({ type: 'personal' }) },
      { data: () => ({ type: 'business' }) },
    ];
    prb.__setFirestoreForTests(makeDb({ memDocs }));
    const r = await prb.getConversationStats('uid1');
    expect(r.count).toBe(0);
    const stats = await prb.buildPrivacyReport('uid1');
    expect(stats.memory.episodeCount).toBe(3);
    expect(stats.memory.byType.personal).toBe(2);
    expect(stats.memory.byType.business).toBe(1);
  });

  test('miia_memory con doc sin type -> cae a unknown (branch type || unknown)', async () => {
    const memDocs = [
      { data: () => ({ type: null }) },
      { data: () => ({}) },
    ];
    prb.__setFirestoreForTests(makeDb({ memDocs }));
    const stats = await prb.buildPrivacyReport('uid1');
    expect(stats.memory.episodeCount).toBe(2);
    expect(stats.memory.byType.unknown).toBe(2);
  });

  test('miia_memory con docs y tipo repetido -> acumula byType (branch byType[t] || 0)', async () => {
    const memDocs = [
      { data: () => ({ type: 'episodic' }) },
      { data: () => ({ type: 'episodic' }) },
      { data: () => ({ type: 'episodic' }) },
    ];
    prb.__setFirestoreForTests(makeDb({ memDocs }));
    const stats = await prb.buildPrivacyReport('uid1');
    expect(stats.memory.byType.episodic).toBe(3);
  });
});

describe('P1.2 -- getConversationStats con documentos', () => {
  test('convDocs con lastMessageAt -> oldest y newest calculados', async () => {
    const convDocs = [
      { data: () => ({ lastMessageAt: '2026-01-01' }) },
      { data: () => ({ lastMessageAt: '2026-03-15' }) },
      { data: () => ({ lastMessageAt: '2026-02-20' }) },
    ];
    prb.__setFirestoreForTests(makeDb({ convDocs }));
    const r = await prb.getConversationStats('uid1');
    expect(r.count).toBe(3);
    expect(r.oldest).toBe('2026-01-01');
    expect(r.newest).toBe('2026-03-15');
  });

  test('convDocs sin lastMessageAt -> oldest=null, newest=null', async () => {
    const convDocs = [{ data: () => ({}) }, { data: () => ({}) }];
    prb.__setFirestoreForTests(makeDb({ convDocs }));
    const r = await prb.getConversationStats('uid1');
    expect(r.count).toBe(2);
    expect(r.oldest).toBeNull();
    expect(r.newest).toBeNull();
  });
});
