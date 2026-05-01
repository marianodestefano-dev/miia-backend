'use strict';
const { assignImportanceScore, rankMemories, getTopMemories, IMPORTANCE_SCORES, MIN_SCORE, MAX_MEMORIES, __setFirestoreForTests } = require('../core/mmc_retrieval');

function makeMockDb({ entries=null, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              if (entries) return { exists: true, data: () => ({ entries }) };
              return { exists: false };
            }
          })
        })
      })
    })
  };
}

afterEach(() => { __setFirestoreForTests(null); });

describe('IMPORTANCE_SCORES y constantes', () => {
  test('owner=0.8, lead=0.5, evento=0.3', () => {
    expect(IMPORTANCE_SCORES.owner).toBe(0.8);
    expect(IMPORTANCE_SCORES.lead).toBe(0.5);
    expect(IMPORTANCE_SCORES.evento).toBe(0.3);
  });
  test('MIN_SCORE=0.2, MAX_MEMORIES=5', () => {
    expect(MIN_SCORE).toBe(0.2);
    expect(MAX_MEMORIES).toBe(5);
  });
  test('IMPORTANCE_SCORES frozen', () => {
    expect(() => { IMPORTANCE_SCORES.owner = 0.1; }).toThrow();
  });
});

describe('assignImportanceScore', () => {
  test('tipo owner → 0.8', () => {
    expect(assignImportanceScore({ type: 'owner' })).toBe(0.8);
  });
  test('tipo lead → 0.5', () => {
    expect(assignImportanceScore({ type: 'lead' })).toBe(0.5);
  });
  test('tipo evento → 0.3', () => {
    expect(assignImportanceScore({ type: 'evento' })).toBe(0.3);
  });
  test('tipo desconocido → default 0.4', () => {
    expect(assignImportanceScore({ type: 'unknown_type' })).toBe(0.4);
  });
  test('importanceScore explicito valido se respeta', () => {
    expect(assignImportanceScore({ type: 'lead', importanceScore: 0.9 })).toBe(0.9);
  });
  test('importanceScore invalido (>1) ignora y usa tipo', () => {
    expect(assignImportanceScore({ type: 'owner', importanceScore: 1.5 })).toBe(0.8);
  });
  test('null/undefined → default', () => {
    expect(assignImportanceScore(null)).toBe(0.4);
    expect(assignImportanceScore(undefined)).toBe(0.4);
  });
});

describe('rankMemories', () => {
  test('filtra memorias con score < minScore', () => {
    const memories = [
      { type: 'owner', content: 'A' },
      { type: 'evento', content: 'B' }, // 0.3 >= 0.2 => ok
      { type: 'unknown', importanceScore: 0.1, content: 'C' } // 0.1 < 0.2 => filtrado
    ];
    const result = rankMemories(memories, { minScore: 0.2 });
    expect(result.length).toBe(2);
    expect(result.find(m => m.content === 'C')).toBeUndefined();
  });

  test('ordena por importanceScore desc', () => {
    const memories = [
      { type: 'evento', content: 'low' },
      { type: 'owner', content: 'high' },
      { type: 'lead', content: 'mid' }
    ];
    const result = rankMemories(memories);
    expect(result[0].content).toBe('high');
    expect(result[1].content).toBe('mid');
    expect(result[2].content).toBe('low');
  });

  test('limite maxResults=5 por default', () => {
    const memories = Array.from({ length: 10 }, (_, i) => ({ type: 'lead', content: `m${i}` }));
    const result = rankMemories(memories);
    expect(result.length).toBe(5);
  });

  test('misma score → ordena por timestamp desc', () => {
    const memories = [
      { type: 'lead', timestamp: 100, content: 'viejo' },
      { type: 'lead', timestamp: 300, content: 'nuevo' },
      { type: 'lead', timestamp: 200, content: 'medio' }
    ];
    const result = rankMemories(memories);
    expect(result[0].content).toBe('nuevo');
    expect(result[1].content).toBe('medio');
    expect(result[2].content).toBe('viejo');
  });

  test('resultado incluye importanceScore', () => {
    const result = rankMemories([{ type: 'owner', content: 'test' }]);
    expect(result[0].importanceScore).toBe(0.8);
  });
});

describe('getTopMemories', () => {
  test('lanza error si uid invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getTopMemories('', '+573001')).rejects.toThrow('uid requerido');
  });

  test('retorna [] si doc no existe en Firestore', async () => {
    __setFirestoreForTests(makeMockDb());
    const result = await getTopMemories('uid1', '+573001');
    expect(result).toEqual([]);
  });

  test('retorna [] si Firestore falla (no lanza)', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const result = await getTopMemories('uid1', '+573001');
    expect(result).toEqual([]);
  });

  test('retorna memorias rankeadas desde Firestore', async () => {
    const entries = [
      { type: 'evento', content: 'low', timestamp: 100 },
      { type: 'owner', content: 'high', timestamp: 200 }
    ];
    __setFirestoreForTests(makeMockDb({ entries }));
    const result = await getTopMemories('uid1', '+573001');
    expect(result.length).toBe(2);
    expect(result[0].importanceScore).toBe(0.8); // owner primero
  });
});
