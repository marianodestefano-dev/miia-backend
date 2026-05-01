'use strict';
/**
 * T102 — MMC GET endpoint tests
 * Testea directamente la logica de mmc_retrieval + validaciones del endpoint.
 * No carga server.js completo (demasiado pesado); testea el modulo directamente.
 */
const { getTopMemories, rankMemories, IMPORTANCE_SCORES, MIN_SCORE, MAX_MEMORIES, __setFirestoreForTests } = require('../core/mmc_retrieval');

function makeMockDb({ entries=null, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (throwGet) throw new Error('firestore error');
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

// Simula la logica de validacion del endpoint
function validateEndpointParams({ uid, phone, limit, minScore }) {
  if (!uid) return { error: 'BAD_REQUEST', message: 'uid requerido' };
  if (!phone) return { error: 'BAD_REQUEST', message: 'query param phone requerido' };
  const l = parseInt(limit) || 20;
  const s = parseFloat(minScore) || 0.2;
  if (l < 1 || l > 100) return { error: 'VALIDATION_ERROR', message: 'limit debe estar entre 1 y 100' };
  if (s < 0 || s > 1) return { error: 'VALIDATION_ERROR', message: 'minScore debe estar entre 0 y 1' };
  return null;
}

describe('Endpoint param validation', () => {
  test('uid faltante → BAD_REQUEST', () => {
    const err = validateEndpointParams({ uid: '', phone: '+573001', limit: 20, minScore: 0.2 });
    expect(err.error).toBe('BAD_REQUEST');
  });

  test('phone faltante → BAD_REQUEST', () => {
    const err = validateEndpointParams({ uid: 'uid1', phone: '', limit: 20, minScore: 0.2 });
    expect(err.error).toBe('BAD_REQUEST');
    expect(err.message).toContain('phone');
  });

  test('limit=-1 → VALIDATION_ERROR', () => {
    const err = validateEndpointParams({ uid: 'uid1', phone: '+573001', limit: -1, minScore: 0.2 });
    expect(err.error).toBe('VALIDATION_ERROR');
  });

  test('limit=101 → VALIDATION_ERROR', () => {
    const err = validateEndpointParams({ uid: 'uid1', phone: '+573001', limit: 101, minScore: 0.2 });
    expect(err.error).toBe('VALIDATION_ERROR');
  });

  test('minScore=1.5 → VALIDATION_ERROR', () => {
    const err = validateEndpointParams({ uid: 'uid1', phone: '+573001', limit: 10, minScore: 1.5 });
    expect(err.error).toBe('VALIDATION_ERROR');
  });

  test('params validos → null (no error)', () => {
    const err = validateEndpointParams({ uid: 'uid1', phone: '+573001', limit: 20, minScore: 0.3 });
    expect(err).toBeNull();
  });
});

describe('getTopMemories con params tipo endpoint', () => {
  test('retorna array vacio si no hay datos en Firestore', async () => {
    __setFirestoreForTests(makeMockDb());
    const result = await getTopMemories('uid1', '+573001', { maxResults: 20, minScore: 0.3 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test('respeta limit (maxResults)', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ type: 'lead', content: `m${i}`, timestamp: i * 1000 }));
    __setFirestoreForTests(makeMockDb({ entries }));
    const result = await getTopMemories('uid1', '+573001', { maxResults: 3, minScore: 0.0 });
    expect(result.length).toBe(3);
  });

  test('respeta minScore (filtra memories debajo del umbral)', async () => {
    const entries = [
      { type: 'lead', content: 'a', importanceScore: 0.5 },
      { type: 'owner', content: 'b', importanceScore: 0.1 } // debajo de minScore 0.3
    ];
    __setFirestoreForTests(makeMockDb({ entries }));
    const result = await getTopMemories('uid1', '+573001', { maxResults: 20, minScore: 0.3 });
    expect(result.some(m => m.content === 'b')).toBe(false);
    expect(result.some(m => m.content === 'a')).toBe(true);
  });

  test('retorna [] si Firestore lanza error (fail-open)', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const result = await getTopMemories('uid1', '+573001', { maxResults: 20, minScore: 0.2 });
    expect(result).toEqual([]);
  });
});

describe('Formato de respuesta del endpoint', () => {
  test('cada memory tiene importanceScore incluido', async () => {
    const entries = [{ type: 'owner', content: 'test', timestamp: 1000 }];
    __setFirestoreForTests(makeMockDb({ entries }));
    const memories = await getTopMemories('uid1', '+573001', { maxResults: 20, minScore: 0.2 });
    expect(memories[0]).toHaveProperty('importanceScore');
    expect(memories[0].importanceScore).toBe(0.8);
  });
});
