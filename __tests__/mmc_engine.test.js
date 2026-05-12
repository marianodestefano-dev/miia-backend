'use strict';

/**
 * Tests R14-A/B — core/mmc_engine.js
 * 100% branch coverage: captureEpisode, distillNightly (4 condiciones),
 * getRelevantMemories, requestForgetting, buildMemoryContext,
 * bootstrapMMC, processHardDeletes.
 */

// ── Estado global del mock ─────────────────────────────────────────────────
let mockMemoryDocs = [];
let mockSetThrows = false;
let mockBatchThrows = false;
let mockQueryThrows = false;
let mockTrainingSnap = { exists: false, data: () => ({}) };
let mockConfigSnap = { exists: false, data: () => ({}) };
let mockConvSnap = { exists: false, data: () => ({}) };
let mockEpisodeSetThrows = false; // falla solo en miia_memory set (captureEpisode)
let mockAuditAddThrows = false;
let mockSnapshotSetThrows = false;
let mockUpdateThrows = false;

// ── Firestore mock ─────────────────────────────────────────────────────────
const mockBatch = {
  update: jest.fn(),
  delete: jest.fn(),
  commit: jest.fn(() => {
    if (mockBatchThrows) return Promise.reject(new Error('BATCH-ERROR'));
    return Promise.resolve();
  }),
};

const mockFsMock = {
  batch: () => mockBatch,
  collection: (col) => ({
    doc: (uid) => ({
      collection: (sub) => ({
        doc: (id) => ({
          set: (data, opts) => {
            if (sub === 'mmc_snapshots' && mockSnapshotSetThrows) return Promise.reject(new Error('SNAP-ERROR'));
            if (sub === 'miia_memory' && mockEpisodeSetThrows) return Promise.reject(new Error('EP-SET-ERROR'));
            if (mockSetThrows) return Promise.reject(new Error('SET-ERROR'));
            return Promise.resolve();
          },
          get: () => {
            if (id === 'training_data') return Promise.resolve(mockTrainingSnap);
            if (id === 'config') return Promise.resolve(mockConfigSnap);
            if (id === 'tenant_conversations') return Promise.resolve(mockConvSnap);
            return Promise.resolve({ exists: false });
          },
          update: (fields) => {
            if (mockUpdateThrows) return Promise.reject(new Error('UPDATE-ERROR'));
            // Simulate updating mockMemoryDocs
            const idx = mockMemoryDocs.findIndex((d) => d.episodeId === id);
            if (idx >= 0) Object.assign(mockMemoryDocs[idx], fields);
            return Promise.resolve();
          },
        }),
        add: (data) => {
          if (mockAuditAddThrows) return Promise.reject(new Error('AUDIT-ERROR'));
          return Promise.resolve({ id: 'audit_123' });
        },
        where: (field, op, val) => ({
          where: (f2, o2, v2) => ({
            where: (f3, o3, v3) => ({
              get: () => {
                if (mockQueryThrows) return Promise.reject(new Error('QUERY-ERROR'));
                const filtered = mockMemoryDocs.filter((d) => {
                  let ok = true;
                  if (field === 'phone' && op === '==') ok = ok && d.phone === val;
                  if (field === 'deleted' && op === '==') ok = ok && d.deleted === val;
                  if (f2 === 'graduado' && o2 === '==') ok = ok && d.graduado === v2;
                  if (f2 === 'deleted' && o2 === '==') ok = ok && d.deleted === v2;
                  if (f2 === 'resumen_corto' && o2 === '==') ok = ok && d.resumen_corto === v2;
                  if (f3 === 'graduado' && o3 === '==') ok = ok && d.graduado === v3;
                  if (f3 === 'resumen_corto' && o3 === '==') ok = ok && d.resumen_corto === v3;
                  return ok;
                });
                const docs = filtered.map((d) => ({
                  data: () => d,
                  ref: {
                    update: (fields) => {
                      if (mockUpdateThrows) return Promise.reject(new Error('UPDATE-ERROR'));
                      Object.assign(d, fields);
                      return Promise.resolve();
                    },
                  },
                }));
                return Promise.resolve({ empty: docs.length === 0, docs, size: docs.length });
              },
            }),
            get: () => {
              if (mockQueryThrows) return Promise.reject(new Error('QUERY-ERROR'));
              const filtered = mockMemoryDocs.filter((d) => {
                let ok = true;
                if (field === 'phone' && op === '==') ok = ok && d.phone === val;
                if (field === 'deleted' && op === '==') ok = ok && d.deleted === val;
                if (f2 === 'deleted' && o2 === '==') ok = ok && d.deleted === v2;
                if (f2 === 'resumen_corto' && o2 === '==') ok = ok && d.resumen_corto === v2;
                return ok;
              });
              const docs = filtered.map((d) => ({
                data: () => d,
                ref: {
                  update: (fields) => {
                    if (mockUpdateThrows) return Promise.reject(new Error('UPDATE-ERROR'));
                    Object.assign(d, fields);
                    return Promise.resolve();
                  },
                },
              }));
              return Promise.resolve({ empty: docs.length === 0, docs, size: docs.length });
            },
          }),
          get: () => {
            // 1-where query: processHardDeletes usa .where('deleted','==',true).get()
            if (mockQueryThrows) return Promise.reject(new Error('QUERY-ERROR'));
            const docs = mockMemoryDocs
              .filter((d) => field === 'deleted' ? d.deleted === val : true)
              .map((d) => ({
                data: () => d,
                ref: {
                  update: (fields) => {
                    if (mockUpdateThrows) return Promise.reject(new Error('UPDATE-ERROR'));
                    Object.assign(d, fields);
                    return Promise.resolve();
                  },
                  delete: () => Promise.resolve(),
                },
              }));
            return Promise.resolve({ empty: docs.length === 0, docs, size: docs.length });
          },
          set: (data, opts) => {
            if (sub === 'mmc_snapshots' && mockSnapshotSetThrows) return Promise.reject(new Error('SNAP-ERROR'));
            if (mockSetThrows) return Promise.reject(new Error('SET-ERROR'));
            return Promise.resolve();
          },
          update: () => Promise.resolve(),
        }),
      }),
      set: (data, opts) => {
        if (mockSetThrows) return Promise.reject(new Error('SET-ERROR'));
        mockMemoryDocs.push(data);
        return Promise.resolve();
      },
      get: () => Promise.resolve(mockTrainingSnap),
    }),
  }),
};

jest.mock('firebase-admin', () => ({ firestore: () => mockFsMock }));

const {
  captureEpisode,
  distillNightly,
  getRelevantMemories,
  requestForgetting,
  buildMemoryContext,
  bootstrapMMC,
  processHardDeletes,
  MEMORY_ELIGIBLE_CHAT_TYPES,
  __setFirestoreForTests,
  _phoneHash,
  _hasFutureDate,
  _hasRememberThis,
  _isFamilyOrTeam,
  _extractTopics,
  _detectTono,
  _detectIdioma,
} = require('../core/mmc_engine');

beforeAll(() => { __setFirestoreForTests(mockFsMock); });

beforeEach(() => {
  mockMemoryDocs = [];
  mockSetThrows = false;
  mockBatchThrows = false;
  mockQueryThrows = false;
  mockUpdateThrows = false;
  mockAuditAddThrows = false;
  mockSnapshotSetThrows = false;
  mockTrainingSnap = { exists: false, data: () => ({}) };
  mockConfigSnap = { exists: false, data: () => ({}) };
  mockConvSnap = { exists: false, data: () => ({}) };
  mockEpisodeSetThrows = false;
  mockBatch.update.mockClear();
  mockBatch.delete.mockClear();
  mockBatch.commit.mockClear();
});

const UID = 'abcdefghijklmnopqrstuvwx12'; // 26 chars OK
const PHONE = '573001234567';

// ── Helpers internos ───────────────────────────────────────────────────────
describe('_phoneHash', () => {
  it('devuelve 8 chars hex', () => {
    expect(_phoneHash('573001234567')).toMatch(/^[0-9a-f]{8}$/);
  });
  it('acepta non-string (covierte a string)', () => {
    expect(() => _phoneHash(12345)).not.toThrow();
  });
});

describe('_extractTopics', () => {
  it('array vacio -> []', () => { expect(_extractTopics([])).toEqual([]); });
  it('null -> []', () => { expect(_extractTopics(null)).toEqual([]); });
  it('mensajes con texto -> array de topics', () => {
    const msgs = [{ text: 'quiero consultar sobre precios disponibles cliente nuevo' }];
    const t = _extractTopics(msgs);
    expect(Array.isArray(t)).toBe(true);
  });
  it('mensaje sin text ni body -> usa string vacio (|| "")', () => {
    const t = _extractTopics([{}]);
    expect(Array.isArray(t)).toBe(true);
  });
});

describe('_detectTono', () => {
  it('array vacio -> neutro', () => { expect(_detectTono([])).toBe('neutro'); });
  it('null -> neutro', () => { expect(_detectTono(null)).toBe('neutro'); });
  it('urgente detectado', () => {
    expect(_detectTono([{ text: 'problema urgente ahora!' }])).toBe('urgente');
  });
  it('positivo detectado', () => {
    expect(_detectTono([{ text: 'gracias perfecto excelente' }])).toBe('positivo');
  });
  it('negativo detectado', () => {
    expect(_detectTono([{ text: 'estoy triste no puedo' }])).toBe('negativo');
  });
  it('texto sin patron -> neutro', () => {
    expect(_detectTono([{ text: 'hola como andas' }])).toBe('neutro');
  });
  it('mensaje sin text ni body -> usa string vacio (|| "")', () => {
    expect(_detectTono([{}])).toBe('neutro');
  });
});

describe('_detectIdioma', () => {
  it('array vacio -> es', () => { expect(_detectIdioma([])).toBe('es'); });
  it('null -> es', () => { expect(_detectIdioma(null)).toBe('es'); });
  it('texto en ingles -> en', () => {
    expect(_detectIdioma([{ text: 'this is the best solution for that' }])).toBe('en');
  });
  it('texto en frances -> fr', () => {
    expect(_detectIdioma([{ text: 'bonjour avec les des une' }])).toBe('fr');
  });
  it('texto en espanol -> es', () => {
    expect(_detectIdioma([{ text: 'hola como estas amigo' }])).toBe('es');
  });
  it('mensaje sin text ni body -> usa string vacio (|| "")', () => {
    expect(_detectIdioma([{}])).toBe('es');
  });
});

describe('_hasFutureDate', () => {
  it('null -> false', () => { expect(_hasFutureDate(null)).toBe(false); });
  it('array vacio -> false', () => { expect(_hasFutureDate([])).toBe(false); });
  it('detects "el lunes"', () => {
    expect(_hasFutureDate([{ text: 'te llamo el lunes a las 10' }])).toBe(true);
  });
  it('detects "proxima semana"', () => {
    expect(_hasFutureDate([{ text: 'lo hacemos proxima semana' }])).toBe(true);
  });
  it('sin fecha -> false', () => {
    expect(_hasFutureDate([{ text: 'hola como estas' }])).toBe(false);
  });
});

describe('_hasRememberThis', () => {
  it('null -> false', () => { expect(_hasRememberThis(null)).toBe(false); });
  it('"recorda esto" -> true', () => {
    expect(_hasRememberThis([{ text: 'recorda esto que es importante' }])).toBe(true);
  });
  it('"recorda eso" -> true', () => {
    expect(_hasRememberThis([{ text: 'si si recorda eso' }])).toBe(true);
  });
  it('texto sin patron -> false', () => {
    expect(_hasRememberThis([{ text: 'hola amigo' }])).toBe(false);
  });
  it('mensaje con body en vez de text -> cubre arm m.body truthy', () => {
    expect(_hasRememberThis([{ body: 'recorda esto' }])).toBe(true);
  });
  it('mensaje sin text ni body -> cubre arm || "" (arm 4)', () => {
    expect(_hasRememberThis([{}])).toBe(false);
  });
});

describe('_isFamilyOrTeam', () => {
  it('phone en familyContacts -> true', () => {
    expect(_isFamilyOrTeam('573001234567', { familyContacts: { '573001234567': true } })).toBe(true);
  });
  it('phone en medilink_team -> true', () => {
    expect(_isFamilyOrTeam('573009999999', { familyContacts: {}, medilink_team: ['573009999999'] })).toBe(true);
  });
  it('phone desconocido -> false', () => {
    expect(_isFamilyOrTeam('573000000000', { familyContacts: {}, medilink_team: [] })).toBe(false);
  });
  it('contexto nulo -> false', () => {
    expect(_isFamilyOrTeam('5730', null)).toBe(false);
  });
  it('medilink_team no array -> false', () => {
    expect(_isFamilyOrTeam('5730', { familyContacts: {}, medilink_team: null })).toBe(false);
  });
});

// ── captureEpisode ─────────────────────────────────────────────────────────
describe('captureEpisode', () => {
  it('lanza si uid nulo', async () => {
    await expect(captureEpisode(null, PHONE, [], {})).rejects.toThrow('uid requerido');
  });
  it('lanza si uid no string', async () => {
    await expect(captureEpisode(123, PHONE, [], {})).rejects.toThrow('uid requerido');
  });
  it('lanza si phone nulo', async () => {
    await expect(captureEpisode(UID, null, [], {})).rejects.toThrow('phone requerido');
  });
  it('lanza si mensajes no es array', async () => {
    await expect(captureEpisode(UID, PHONE, 'not-array', {})).rejects.toThrow('mensajes debe ser array');
  });
  it('lanza si Firestore SET falla', async () => {
    mockSetThrows = true;
    await expect(captureEpisode(UID, PHONE, [], {})).rejects.toThrow('SET-ERROR');
  });
  it('OK con array vacio -> episodeId string', async () => {
    const id = await captureEpisode(UID, PHONE, [], {});
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
  it('OK con mensajes y contexto completo', async () => {
    const msgs = [{ text: 'hola quiero consultar precio disponible' }, { body: 'si tengo' }];
    const id = await captureEpisode(UID, PHONE, msgs, { chatType: 'owner_selfchat' });
    expect(typeof id).toBe('string');
  });
  it('contexto null -> usa defaults', async () => {
    const id = await captureEpisode(UID, PHONE, [], null);
    expect(typeof id).toBe('string');
  });
  it('mensaje sin text ni body -> cubre || "" en _extractMenciones/_extractTopics', async () => {
    const id = await captureEpisode(UID, PHONE, [{}], {});
    expect(typeof id).toBe('string');
  });
});

// ── getRelevantMemories ────────────────────────────────────────────────────
describe('getRelevantMemories', () => {
  it('lanza si uid nulo', async () => {
    await expect(getRelevantMemories(null, PHONE, [])).rejects.toThrow('uid requerido');
  });
  it('lanza si phone nulo', async () => {
    await expect(getRelevantMemories(UID, null, [])).rejects.toThrow('phone requerido');
  });
  it('retorna [] cuando query lanza error', async () => {
    mockQueryThrows = true;
    const r = await getRelevantMemories(UID, PHONE, []);
    expect(r).toEqual([]);
  });
  it('retorna [] cuando no hay episodios graduados', async () => {
    const r = await getRelevantMemories(UID, PHONE, []);
    expect(r).toEqual([]);
  });
  it('retorna episodios graduados ordenados por score', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep1', graduado: true, deleted: false,
        topicos: ['precio', 'consulta'], keywords: [], fecha: '2026-05-10', resumen_corto: 'consulta precio' },
      { uid: UID, phone: PHONE, episodeId: 'ep2', graduado: true, deleted: false,
        topicos: ['urgente'], keywords: [], fecha: '2026-05-11', resumen_corto: 'problema urgente' },
    ];
    const r = await getRelevantMemories(UID, PHONE, ['precio']);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].episodeId).toBe('ep1'); // precio match primero
  });
  it('episodio sin topicos ni keywords -> || [] en scoring (linea 285)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_no_words', graduado: true, deleted: false,
      fecha: '2026-05-10', resumen_corto: 'sin topicos',
      // topicos y keywords ausentes (undefined)
    }];
    const r = await getRelevantMemories(UID, PHONE, ['precio']);
    expect(Array.isArray(r)).toBe(true);
  });

  it('keywords vacio -> score 1 para todos, devuelve primeros 3', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep1', graduado: true, deleted: false, topicos: [], keywords: [], fecha: '2026-05-01', resumen_corto: 'a' },
      { uid: UID, phone: PHONE, episodeId: 'ep2', graduado: true, deleted: false, topicos: [], keywords: [], fecha: '2026-05-02', resumen_corto: 'b' },
      { uid: UID, phone: PHONE, episodeId: 'ep3', graduado: true, deleted: false, topicos: [], keywords: [], fecha: '2026-05-03', resumen_corto: 'c' },
      { uid: UID, phone: PHONE, episodeId: 'ep4', graduado: true, deleted: false, topicos: [], keywords: [], fecha: '2026-05-04', resumen_corto: 'd' },
    ];
    const r = await getRelevantMemories(UID, PHONE, null);
    expect(r.length).toBeLessThanOrEqual(3);
  });
});

// ── buildMemoryContext ─────────────────────────────────────────────────────
describe('buildMemoryContext', () => {
  it('retorna "" para chatType lead', async () => {
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'lead' });
    expect(r).toBe('');
  });
  it('retorna "" para chatType miia_lead', async () => {
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'miia_lead' });
    expect(r).toBe('');
  });
  it('retorna "" para chatType client', async () => {
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'client' });
    expect(r).toBe('');
  });
  it('retorna "" cuando no hay memorias', async () => {
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'owner_selfchat' });
    expect(r).toBe('');
  });
  it('retorna string con MEMORIA cuando hay episodios', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep1', graduado: true, deleted: false,
      topicos: ['precio'], keywords: [], fecha: '2026-05-10T12:00:00Z', resumen_corto: 'consulto precio'
    }];
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'family' });
    expect(r).toContain('[MEMORIA EPISODICA');
    expect(r).toContain('consulto precio');
  });
  it('resumen_corto null -> usa topicos', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep2', graduado: true, deleted: false,
      topicos: ['tema1', 'tema2'], keywords: [], fecha: '2026-05-10T12:00:00Z', resumen_corto: null
    }];
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'owner_selfchat' });
    expect(r).toContain('tema1');
  });
  it('episodio sin fecha -> "sin fecha" (linea 314)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_no_fecha', graduado: true, deleted: false,
      topicos: ['x'], keywords: [], resumen_corto: 'sin fecha',
      // fecha ausente (undefined)
    }];
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'owner_selfchat' });
    expect(r).toContain('sin fecha');
  });

  it('episodio sin resumen_corto y topicos vacio -> "(sin resumen)" (linea 315)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_no_resumen', graduado: true, deleted: false,
      topicos: [], keywords: [], fecha: '2026-05-10T12:00:00Z', resumen_corto: null,
    }];
    const r = await buildMemoryContext(UID, PHONE, { chatType: 'owner_selfchat' });
    expect(r).toContain('(sin resumen)');
  });

  it('opts null -> chatType undefined, chatTypes check skipped', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep3', graduado: true, deleted: false,
      topicos: ['x'], keywords: [], fecha: '2026-05-10T12:00:00Z', resumen_corto: 'x'
    }];
    const r = await buildMemoryContext(UID, PHONE, null);
    expect(typeof r).toBe('string');
  });
});

// ── requestForgetting ──────────────────────────────────────────────────────
describe('requestForgetting', () => {
  it('lanza si uid nulo', async () => {
    await expect(requestForgetting(null, PHONE)).rejects.toThrow('uid requerido');
  });
  it('lanza si phone nulo', async () => {
    await expect(requestForgetting(UID, null)).rejects.toThrow('phone requerido');
  });
  it('lanza si soft-delete falla', async () => {
    mockBatchThrows = true;
    mockMemoryDocs = [{ uid: UID, phone: PHONE, episodeId: 'ep1', deleted: false }];
    await expect(requestForgetting(UID, PHONE)).rejects.toThrow();
  });
  it('OK con 0 episodios -> { eliminados: 0 }', async () => {
    const r = await requestForgetting(UID, PHONE);
    expect(r.eliminados).toBe(0);
  });
  it('OK con episodios -> soft-delete + audit log', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep1', deleted: false },
      { uid: UID, phone: PHONE, episodeId: 'ep2', deleted: false },
    ];
    const r = await requestForgetting(UID, PHONE);
    expect(r.eliminados).toBe(2);
  });
  it('audit log error no bloquea resultado', async () => {
    mockAuditAddThrows = true;
    const r = await requestForgetting(UID, PHONE);
    expect(typeof r.eliminados).toBe('number');
  });
});

// ── distillNightly ─────────────────────────────────────────────────────────
describe('distillNightly', () => {
  it('lanza si uid nulo', async () => {
    await expect(distillNightly(null)).rejects.toThrow('uid requerido');
  });
  it('lanza si query falla', async () => {
    mockQueryThrows = true;
    await expect(distillNightly(UID)).rejects.toThrow('QUERY-ERROR');
  });
  it('retorna 0s cuando no hay episodios sin resumen', async () => {
    const r = await distillNightly(UID);
    expect(r).toEqual({ procesados: 0, graduados: 0, eliminados: 0 });
  });

  it('Cond1: importancia>=3 -> graduado', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_c1', deleted: false, resumen_corto: null,
      topicos: ['precio'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockResolvedValue('Consulta precio importante\n4');
    mockTrainingSnap = { exists: true, data: () => ({ memory_chunks: [] }) };
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1);
  });

  it('Cond2: phone en familyContacts -> graduado sin importar importancia', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_c2', deleted: false, resumen_corto: null,
      topicos: ['saludo'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    mockTrainingSnap = { exists: false, data: () => ({}) };
    const mockGemini = jest.fn().mockResolvedValue('Saludo familiar\n1');
    const r = await distillNightly(UID, {
      _gemini: mockGemini,
      familyContacts: { [PHONE]: true },
    });
    expect(r.graduados).toBe(1);
  });

  it('Cond3: menciones con fecha futura -> graduado', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_c3', deleted: false, resumen_corto: null,
      topicos: ['reunion'], tono_detectado: 'neutro', menciones_importantes: ['el lunes a las 10'],
    }];
    mockTrainingSnap = { exists: false, data: () => ({}) };
    const mockGemini = jest.fn().mockResolvedValue('Reunion programada\n2');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1);
  });

  it('no graduado si ninguna condicion cumplida', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_ng', deleted: false, resumen_corto: null,
      topicos: ['hola'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockResolvedValue('Solo un saludo\n1');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(0);
    expect(r.procesados).toBe(1);
  });

  it('Gemini falla -> resumen fallback desde topicos, no bloquea', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_gfail', deleted: false, resumen_corto: null,
      topicos: ['urgente', 'pago'], tono_detectado: 'urgente', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockRejectedValue(new Error('GEMINI-DOWN'));
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('importancia NaN en respuesta Gemini -> default 2', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_nan', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockResolvedValue('Resumen aqui\nnada');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('importancia fuera de rango (0) -> default 2', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_rng', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n0');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('update error no bloquea el loop (continue)', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep_upd1', deleted: false, resumen_corto: null, topicos: [], tono_detectado: 'neutro', menciones_importantes: [] },
      { uid: UID, phone: PHONE, episodeId: 'ep_upd2', deleted: false, resumen_corto: null, topicos: [], tono_detectado: 'neutro', menciones_importantes: [] },
    ];
    mockUpdateThrows = true;
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n1');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(2);
  });

  it('snapshot set error no bloquea resultado', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_snap', deleted: false, resumen_corto: null,
      topicos: [], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    mockSnapshotSetThrows = true;
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n1');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('_gemini no provisto -> usa _callGemini real (fetch mock)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_real', deleted: false, resumen_corto: null,
      topicos: ['test'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Resumen real\n1' }] } }] }),
    });
    const r = await distillNightly(UID);
    expect(r.procesados).toBe(1);
    global.fetch = undefined;
  });

  it('_callGemini con parts[0] sin text -> || "" (linea 204)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_notext', deleted: false, resumen_corto: null,
      topicos: ['test'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{}] } }] }),
    });
    const r = await distillNightly(UID);
    expect(r.procesados).toBe(1);
    global.fetch = undefined;
  });

  it('_callGemini con AbortError -> gemini_timeout', async () => {
    // Cubre la rama AbortError dentro de _callGemini
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_abort', deleted: false, resumen_corto: null,
      topicos: ['test'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    global.fetch = jest.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const r = await distillNightly(UID);
    // AbortError -> catch en Gemini -> fallback resumen
    expect(r.procesados).toBe(1);
    global.fetch = undefined;
  });

  it('Gemini devuelve "" -> resumen vacio -> || "" en chunk (linea 163), cond3 asegura graduacion', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_empty_res', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro',
      menciones_importantes: ['el lunes a las 10'], // cond3 = true
    }];
    mockTrainingSnap = { exists: false };
    const mockGemini = jest.fn().mockResolvedValue(''); // trim='', lines[0]='' -> resumen=''
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1);
  });

  it('episode con phone null -> || "" en _appendMemoryGraduatedChunk (linea 166)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: null, episodeId: 'ep_no_phone', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    mockTrainingSnap = { exists: false };
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n4');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1);
  });

  it('episode con topicos null -> || [] en prompt y en chunk (lineas 396,434)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_null_top', deleted: false, resumen_corto: null,
      topicos: null, tono_detectado: 'neutro', menciones_importantes: [],
    }];
    mockTrainingSnap = { exists: false };
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n4');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1);
  });

  it('Gemini devuelve respuesta sin newline -> lines[1] undefined -> NaN (linea 401)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_nobreak', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockResolvedValue('Resumen sin salto de linea');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
    expect(r.graduados).toBe(0); // importancia default 2
  });

  it('Gemini falla con topicos null -> resumen fallback (lineas 405 arms)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_fail_null_top', deleted: false, resumen_corto: null,
      topicos: null, tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockRejectedValue(new Error('GEMINI-DOWN'));
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('Gemini falla con topicos vacio -> "(sin resumen)" fallback (linea 405 arm2)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_fail_empty_top', deleted: false, resumen_corto: null,
      topicos: [], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    const mockGemini = jest.fn().mockRejectedValue(new Error('GEMINI-DOWN'));
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('menciones_importantes null -> usa [] (linea 412)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_null_men', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: null,
    }];
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n1');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.procesados).toBe(1);
  });

  it('chunk graduado -> training snap exists con memory_chunks no-array -> usa []', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_tc_false', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    mockTrainingSnap = { exists: true, data: () => ({ memory_chunks: 'not_array' }) };
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n4');
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1);
  });

  it('chunk set error no bloquea resultado (linea 436)', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_chunk_throw', deleted: false, resumen_corto: null,
      topicos: ['x'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    mockTrainingSnap = { exists: false };
    const mockGemini = jest.fn().mockResolvedValue('Resumen\n4');
    mockSetThrows = true; // hace que _appendMemoryGraduatedChunk.set() falle
    const r = await distillNightly(UID, { _gemini: mockGemini });
    expect(r.graduados).toBe(1); // chunk fallo pero resultado ok
    expect(r.procesados).toBe(1);
  });

  it('_callGemini con fetch !ok -> lanza error -> fallback en catch', async () => {
    mockMemoryDocs = [{
      uid: UID, phone: PHONE, episodeId: 'ep_notok', deleted: false, resumen_corto: null,
      topicos: ['test'], tono_detectado: 'neutro', menciones_importantes: [],
    }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });
    const r = await distillNightly(UID);
    expect(r.procesados).toBe(1);
    global.fetch = undefined;
  });
});

// ── bootstrapMMC ───────────────────────────────────────────────────────────
describe('bootstrapMMC', () => {
  it('lanza si uid nulo', async () => {
    await expect(bootstrapMMC(null)).rejects.toThrow('uid requerido');
  });

  it('lanza si uid no string', async () => {
    await expect(bootstrapMMC(123)).rejects.toThrow('uid requerido');
  });

  it('retorna skipped si ya bootstrapped', async () => {
    mockConfigSnap = { exists: true, data: () => ({ bootstrapped: true }) };
    const r = await bootstrapMMC(UID);
    expect(r).toEqual({ episodios_creados: 0, skipped: true });
  });

  it('retorna episodios_creados:0 si convSnap no existe', async () => {
    mockConvSnap = { exists: false };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0);
    expect(r.skipped).toBeUndefined();
  });

  it('retorna episodios_creados:0 si conversations vacio', async () => {
    mockConvSnap = { exists: true, data: () => ({ conversations: {} }) };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0);
  });

  it('data sin campo conversations -> || {} (linea 495 arm 1)', async () => {
    mockConvSnap = { exists: true, data: () => ({}) }; // sin campo conversations -> undefined -> || {}
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0);
  });

  it('mensaje sin text ni body -> usa "" (linea 504 arm 2)', async () => {
    const recentTs = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockConvSnap = {
      exists: true,
      data: () => ({
        conversations: {
          [PHONE]: { history: [{ timestamp: recentTs }] }, // sin text ni body
        },
      }),
    };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(1);
  });

  it('retorna episodios_creados:0 si history muy antigua', async () => {
    const oldTs = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 dias atras
    mockConvSnap = {
      exists: true,
      data: () => ({
        conversations: {
          [PHONE]: { history: [{ text: 'hola', timestamp: oldTs }] },
        },
      }),
    };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0);
  });

  it('crea episodios para mensajes recientes', async () => {
    const recentTs = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 dias atras
    mockConvSnap = {
      exists: true,
      data: () => ({
        conversations: {
          [PHONE]: { history: [{ text: 'hola', timestamp: recentTs }] },
        },
      }),
    };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(1);
  });

  it('captureEpisode error no bloquea bootstrap (linea 509)', async () => {
    const recentTs = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockEpisodeSetThrows = true; // solo falla el set de miia_memory (captureEpisode)
    mockConvSnap = {
      exists: true,
      data: () => ({
        conversations: {
          [PHONE]: { history: [{ text: 'ok', timestamp: recentTs }] },
        },
      }),
    };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0); // fallo -> no incremento
    expect(r.skipped).toBeUndefined();   // pero no fallo toda la funcion
  });

  it('opts null -> usa defaults (o = {})', async () => {
    mockConvSnap = { exists: false };
    const r = await bootstrapMMC(UID, null);
    expect(r.episodios_creados).toBe(0);
  });

  it('historia no-array -> usa []', async () => {
    const recentTs = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockConvSnap = {
      exists: true,
      data: () => ({
        conversations: {
          [PHONE]: { history: 'not-array' }, // no es array
        },
      }),
    };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0); // history vacia -> sin recientes -> skip
  });

  it('mensaje con body en vez de text -> usa body', async () => {
    const recentTs = Date.now() - 1 * 24 * 60 * 60 * 1000;
    mockConvSnap = {
      exists: true,
      data: () => ({
        conversations: {
          [PHONE]: { history: [{ body: 'hola desde body', timestamp: recentTs }] },
        },
      }),
    };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(1);
  });

  it('configSnap.exists pero NO bootstrapped -> procede normalmente', async () => {
    mockConfigSnap = { exists: true, data: () => ({ bootstrapped: false }) };
    mockConvSnap = { exists: false };
    const r = await bootstrapMMC(UID);
    expect(r.episodios_creados).toBe(0);
    expect(r.skipped).toBeUndefined();
  });
});

// ── processHardDeletes ─────────────────────────────────────────────────────
describe('processHardDeletes', () => {
  it('lanza si uid nulo', async () => {
    await expect(processHardDeletes(null)).rejects.toThrow('uid requerido');
  });

  it('lanza si uid no string', async () => {
    await expect(processHardDeletes(123)).rejects.toThrow('uid requerido');
  });

  it('lanza si query falla', async () => {
    mockQueryThrows = true;
    await expect(processHardDeletes(UID)).rejects.toThrow('QUERY-ERROR');
  });

  it('retorna eliminados:0 cuando no hay episodios con deleted=true', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep1', deleted: false },
    ];
    const r = await processHardDeletes(UID);
    expect(r.eliminados).toBe(0);
  });

  it('retorna eliminados:0 cuando episodios deleted pero hardDeleteAt futuro', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep1', deleted: true, hardDeleteAt: Date.now() + 99999 },
    ];
    const r = await processHardDeletes(UID);
    expect(r.eliminados).toBe(0);
  });

  it('retorna eliminados:0 cuando episodio deleted pero sin hardDeleteAt', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep1', deleted: true },
    ];
    const r = await processHardDeletes(UID);
    expect(r.eliminados).toBe(0);
  });

  it('hard-delete episodios con hardDeleteAt vencido', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep_old', deleted: true, hardDeleteAt: Date.now() - 1000 },
    ];
    const r = await processHardDeletes(UID);
    expect(r.eliminados).toBe(1);
    expect(mockBatch.delete).toHaveBeenCalled();
    expect(mockBatch.commit).toHaveBeenCalled();
  });

  it('mezcla de vencidos y futuros -> elimina solo los vencidos', async () => {
    mockMemoryDocs = [
      { uid: UID, phone: PHONE, episodeId: 'ep_ok', deleted: true, hardDeleteAt: Date.now() - 5000 },
      { uid: UID, phone: PHONE, episodeId: 'ep_future', deleted: true, hardDeleteAt: Date.now() + 99999 },
    ];
    const r = await processHardDeletes(UID);
    expect(r.eliminados).toBe(1);
  });
});

// ── MEMORY_ELIGIBLE_CHAT_TYPES ─────────────────────────────────────────────
describe('MEMORY_ELIGIBLE_CHAT_TYPES', () => {
  it('owner_selfchat es elegible', () => {
    expect(MEMORY_ELIGIBLE_CHAT_TYPES.has('owner_selfchat')).toBe(true);
  });
  it('lead NO es elegible', () => {
    expect(MEMORY_ELIGIBLE_CHAT_TYPES.has('lead')).toBe(false);
  });
});
