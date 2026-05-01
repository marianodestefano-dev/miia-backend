'use strict';

const {
  assignImportanceScore, rankMemories, getTopMemories,
  IMPORTANCE_SCORES, MIN_SCORE, MAX_MEMORIES,
  __setFirestoreForTests: setMmcDb,
} = require('../core/mmc_retrieval');

const {
  applyDecay, runDecayForOwner, startDecayCron,
  DECAY_THRESHOLD_DAYS, DECAY_RATE, MIN_FLOOR,
  __setFirestoreForTests: setDecayDb,
} = require('../core/mmc_decay');

const UID = 'uid_t332';
const PHONE = '+571111222';
const NOW = 1000000000000;
const DAY = 24 * 60 * 60 * 1000;

describe('T332 -- mmc_retrieval + mmc_decay (28 tests)', () => {

  // Constants
  test('IMPORTANCE_SCORES frozen', () => {
    expect(() => { IMPORTANCE_SCORES.owner = 0.1; }).toThrow();
  });

  test('IMPORTANCE_SCORES: owner=0.8, lead=0.5, evento=0.3', () => {
    expect(IMPORTANCE_SCORES.owner).toBe(0.8);
    expect(IMPORTANCE_SCORES.lead).toBe(0.5);
    expect(IMPORTANCE_SCORES.evento).toBe(0.3);
  });

  test('MIN_SCORE=0.2, MAX_MEMORIES=5', () => {
    expect(MIN_SCORE).toBe(0.2);
    expect(MAX_MEMORIES).toBe(5);
  });

  test('DECAY_THRESHOLD_DAYS=90, DECAY_RATE=0.95, MIN_FLOOR=0.05', () => {
    expect(DECAY_THRESHOLD_DAYS).toBe(90);
    expect(DECAY_RATE).toBe(0.95);
    expect(MIN_FLOOR).toBe(0.05);
  });

  // assignImportanceScore
  test('assignImportanceScore: null -> default 0.4', () => {
    expect(assignImportanceScore(null)).toBe(0.4);
  });

  test('assignImportanceScore: type owner -> 0.8', () => {
    expect(assignImportanceScore({ type: 'owner' })).toBe(0.8);
  });

  test('assignImportanceScore: type lead -> 0.5', () => {
    expect(assignImportanceScore({ type: 'lead' })).toBe(0.5);
  });

  test('assignImportanceScore: tipo desconocido -> default 0.4', () => {
    expect(assignImportanceScore({ type: 'custom' })).toBe(0.4);
  });

  test('assignImportanceScore: importanceScore explícito respetado', () => {
    expect(assignImportanceScore({ importanceScore: 0.7 })).toBe(0.7);
  });

  // rankMemories
  test('rankMemories: no array -> []', () => {
    expect(rankMemories(null)).toEqual([]);
  });

  test('rankMemories: filtra score < MIN_SCORE', () => {
    const mems = [
      { type: 'evento', importanceScore: 0.1 },  // score 0.1 < 0.2
      { type: 'lead' },                           // score 0.5 >= 0.2
    ];
    const r = rankMemories(mems);
    expect(r.length).toBe(1);
    expect(r[0].type).toBe('lead');
  });

  test('rankMemories: ordena por score desc', () => {
    const mems = [
      { type: 'lead', timestamp: NOW - 1000 },   // score 0.5
      { type: 'owner', timestamp: NOW - 2000 },  // score 0.8
    ];
    const r = rankMemories(mems);
    expect(r[0].type).toBe('owner');
    expect(r[1].type).toBe('lead');
  });

  test('rankMemories: mismo score -> ordena por timestamp desc (mas reciente primero)', () => {
    const mems = [
      { type: 'lead', timestamp: NOW - 5000 },
      { type: 'lead', timestamp: NOW - 1000 },
    ];
    const r = rankMemories(mems);
    expect(r[0].timestamp).toBe(NOW - 1000);
  });

  test('rankMemories: max MAX_MEMORIES=5', () => {
    const mems = Array.from({ length: 10 }, (_, i) => ({ type: 'owner', timestamp: NOW - i * 1000 }));
    const r = rankMemories(mems);
    expect(r.length).toBe(5);
  });

  test('rankMemories: maxResults custom respetado', () => {
    const mems = Array.from({ length: 10 }, () => ({ type: 'lead' }));
    const r = rankMemories(mems, { maxResults: 3 });
    expect(r.length).toBe(3);
  });

  test('rankMemories: importanceScore en resultado', () => {
    const mems = [{ type: 'owner' }];
    const r = rankMemories(mems);
    expect(r[0].importanceScore).toBe(0.8);
  });

  // getTopMemories
  test('getTopMemories: uid null lanza', async () => {
    await expect(getTopMemories(null, PHONE)).rejects.toThrow('uid requerido');
  });

  test('getTopMemories: phone null lanza', async () => {
    await expect(getTopMemories(UID, null)).rejects.toThrow('phone requerido');
  });

  test('getTopMemories: doc no existe -> []', async () => {
    setMmcDb({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }) }),
    });
    const r = await getTopMemories(UID, PHONE);
    expect(r).toEqual([]);
  });

  test('getTopMemories: retorna memorias rankeadas', async () => {
    const entries = [
      { type: 'owner', timestamp: NOW - 1000 },
      { type: 'evento', importanceScore: 0.1, timestamp: NOW - 2000 },
      { type: 'lead', timestamp: NOW - 3000 },
    ];
    setMmcDb({
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: true, data: () => ({ entries }) }),
            }),
          }),
        }),
      }),
    });
    const r = await getTopMemories(UID, PHONE);
    expect(r.length).toBe(2); // evento filtrado (score 0.1 < 0.2)
    expect(r[0].type).toBe('owner');
  });

  test('getTopMemories: Firestore error -> []', async () => {
    setMmcDb({ collection: () => { throw new Error('down'); } });
    const r = await getTopMemories(UID, PHONE);
    expect(r).toEqual([]);
  });

  // applyDecay
  test('applyDecay: no array -> []', () => {
    expect(applyDecay(null)).toEqual([]);
  });

  test('applyDecay: sin timestamp -> no decae', () => {
    const mems = [{ type: 'owner' }]; // sin timestamp
    const r = applyDecay(mems, NOW);
    expect(r[0]).toEqual(mems[0]);
  });

  test('applyDecay: memoria reciente (< 90d) no decae', () => {
    const mems = [{ type: 'owner', timestamp: NOW - 30 * DAY }];
    const r = applyDecay(mems, NOW);
    expect(r[0].importanceScore).toBeUndefined(); // no tocado
  });

  test('applyDecay: memoria antigua (>90d) decae', () => {
    const mems = [{ type: 'owner', timestamp: NOW - 95 * DAY }];
    const r = applyDecay(mems, NOW);
    // 5 dias extra de decay sobre score 0.8: 0.8 * 0.95^5
    const expected = 0.8 * Math.pow(0.95, 5);
    expect(r[0].importanceScore).toBeCloseTo(expected, 5);
  });

  test('applyDecay: score decaido no cae por debajo de MIN_FLOOR=0.05', () => {
    // Memoria muy antigua: 90+200 dias = 290 dias extra
    const mems = [{ type: 'evento', timestamp: NOW - (90 + 200) * DAY }];
    const r = applyDecay(mems, NOW);
    expect(r[0].importanceScore).toBeGreaterThanOrEqual(MIN_FLOOR);
  });

  // startDecayCron
  test('startDecayCron: retorna { stop }', () => {
    jest.useFakeTimers();
    const cron = startDecayCron(async () => []);
    expect(typeof cron.stop).toBe('function');
    expect(() => cron.stop()).not.toThrow();
    jest.useRealTimers();
  });
});
