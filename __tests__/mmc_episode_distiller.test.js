/**
 * Tests: C-439 MMC Capa 3 — destilación nocturna semántica.
 *
 * Origen: CARTA_C-439 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *
 * §6.18 AbortController obligatorio en fetch externo (Gemini).
 *
 * Mock Firestore in-memory reusado de C-437/C-438.
 */

'use strict';

const episodes = require('../core/mmc/episodes');
const distiller = require('../core/mmc/episode_distiller');

// ════════════════════════════════════════════════════════════════════
// Mock Firestore (mismo patrón C-437/C-438)
// ════════════════════════════════════════════════════════════════════

function makeMockFirestore() {
  const store = new Map();
  let autoIdCounter = 0;
  function pathFor(parts) { return parts.join('/'); }
  function makeDocRef(parts) {
    const id = parts[parts.length - 1];
    const path = pathFor(parts);
    return {
      id,
      path,
      async set(data) { store.set(path, JSON.parse(JSON.stringify(data))); },
      async update(patch) {
        const cur = store.get(path);
        if (!cur) throw new Error('not found');
        store.set(path, { ...cur, ...JSON.parse(JSON.stringify(patch)) });
      },
      async get() {
        const data = store.get(path);
        return {
          exists: data !== undefined,
          data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
        };
      },
    };
  }
  function makeColRef(parts) {
    return {
      doc(id) {
        const docId = id || `auto_${++autoIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
        return makeDocRef([...parts, docId]);
      },
      where(field, op, value) { return makeQuery(parts, [{ field, op, value }]); },
    };
  }
  function makeQuery(parts, filters, orderField, orderDir, limitN) {
    return {
      where(f, o, v) { return makeQuery(parts, [...filters, { field: f, op: o, value: v }], orderField, orderDir, limitN); },
      orderBy(f, d) { return makeQuery(parts, filters, f, d || 'asc', limitN); },
      limit(n) { return makeQuery(parts, filters, orderField, orderDir, n); },
      async get() {
        const colPrefix = pathFor(parts) + '/';
        let docs = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(colPrefix) && k.slice(colPrefix.length).split('/').length === 1) {
            docs.push({ id: k.slice(colPrefix.length), data: () => JSON.parse(JSON.stringify(v)) });
          }
        }
        for (const f of filters) {
          docs = docs.filter((d) => {
            const dv = d.data()[f.field];
            if (f.op === '==') return dv === f.value;
            return false;
          });
        }
        if (orderField) {
          docs.sort((a, b) => {
            const av = a.data()[orderField];
            const bv = b.data()[orderField];
            return orderDir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
          });
        }
        if (limitN) docs = docs.slice(0, limitN);
        return { docs };
      },
    };
  }
  return {
    _store: store,
    collection(name) {
      return {
        doc(id) {
          return {
            collection(subName) { return makeColRef([name, id, subName]); },
          };
        },
      };
    },
    // C-450-FIRESTORE-TX-AUDIT: runTransaction agregado para soportar
    // lock distribuido per-episodio en runNightlyDistillation.
    async runTransaction(cb) {
      const tx = {
        async get(ref) { return ref.get(); },
        update(ref, data) {
          const cur = store.get(ref.path) || {};
          store.set(ref.path, { ...cur, ...JSON.parse(JSON.stringify(data)) });
        },
      };
      return cb(tx);
    },
  };
}

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const PHONE_A = '5491100000001@s.whatsapp.net';

let mockFs;
beforeEach(() => {
  mockFs = makeMockFirestore();
  distiller.__setFirestoreForTests(mockFs);
});

// ════════════════════════════════════════════════════════════════════
// §A — distillEpisode
// ════════════════════════════════════════════════════════════════════

describe('C-439 §A — distillEpisode', () => {
  const epData = {
    episodeId: 'ep_abc',
    ownerUid: VALID_UID,
    contactPhone: PHONE_A,
    messageIds: ['m1', 'm2', 'm3'],
    status: 'closed',
    summary: null,
  };

  test('A.1 — happy path mock object → topic+summary trim', async () => {
    const gemini = distiller.createMockGeminiForDistillation({
      topic: '  consulta stock abril  ',
      summary: '  Owner pide planilla viernes  ',
    });
    const r = await distiller.distillEpisode(epData, gemini);
    expect(r.topic).toBe('consulta stock abril');
    expect(r.summary).toBe('Owner pide planilla viernes');
  });

  test('A.2 — response shape text JSON-string → parsea', async () => {
    const gemini = distiller.createMockGeminiForDistillation({ responseShape: 'text' });
    const r = await distiller.distillEpisode(epData, gemini);
    expect(typeof r.topic).toBe('string');
    expect(typeof r.summary).toBe('string');
  });

  test('A.3 — response invalid_json → throws controlled', async () => {
    const gemini = distiller.createMockGeminiForDistillation({ responseShape: 'invalid_json' });
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow(/JSON detectable|JSON parse|missing topic/);
  });

  test('A.4 — gemini error 500 → throws controlled', async () => {
    const gemini = distiller.createMockGeminiForDistillation({ fail: true });
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow(/gemini error/);
  });

  test('A.5 — gemini timeout (AbortController §6.18) → throws controlled', async () => {
    const gemini = distiller.createMockGeminiForDistillation({ timeoutForever: true });
    await expect(
      distiller.distillEpisode(epData, gemini, { timeoutMs: 50 })
    ).rejects.toThrow(/timeout/);
  });

  test('A.6 — episodeData null → throws', async () => {
    const gemini = distiller.createMockGeminiForDistillation();
    await expect(distiller.distillEpisode(null, gemini)).rejects.toThrow(/episodeData/);
  });

  test('A.7 — geminiClient sin generateContent → throws', async () => {
    await expect(distiller.distillEpisode(epData, {})).rejects.toThrow(/generateContent/);
  });

  test('A.8 — topic vacío en respuesta → throws', async () => {
    const gemini = distiller.createMockGeminiForDistillation({ topic: '   ', summary: 'ok' });
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow(/topic vacío/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — runNightlyDistillation
// ════════════════════════════════════════════════════════════════════

describe('C-439 §B — runNightlyDistillation', () => {
  test('B.1 — 3 episodios closed → 3 procesados, status=distilled', async () => {
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    const id2 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm2');
    const id3 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm3');
    await episodes.closeEpisode(VALID_UID, id1);
    await episodes.closeEpisode(VALID_UID, id2);
    await episodes.closeEpisode(VALID_UID, id3);

    const candidates = await Promise.all([id1, id2, id3].map((id) => episodes.getEpisode(VALID_UID, id)));
    const gemini = distiller.createMockGeminiForDistillation();

    const r = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async () => candidates,
    });

    expect(r.processed).toBe(3);
    expect(r.errors).toEqual([]);
    const after = await episodes.getEpisode(VALID_UID, id1);
    expect(after.status).toBe('distilled');
    expect(typeof after.topic).toBe('string');
    expect(typeof after.summary).toBe('string');
  });

  test('B.2 — 0 episodios pending → 0 procesados (no error)', async () => {
    const gemini = distiller.createMockGeminiForDistillation();
    const r = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async () => [],
    });
    expect(r.processed).toBe(0);
    expect(r.errors).toEqual([]);
  });

  test('B.3 — 1 falla, 2 ok → reporta 2 OK + 1 error en lista', async () => {
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    const id2 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm2');
    const id3 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm3');
    await episodes.closeEpisode(VALID_UID, id1);
    await episodes.closeEpisode(VALID_UID, id2);
    await episodes.closeEpisode(VALID_UID, id3);
    const candidates = await Promise.all([id1, id2, id3].map((id) => episodes.getEpisode(VALID_UID, id)));

    let callCount = 0;
    const gemini = {
      async generateContent({ signal }) {
        callCount++;
        if (callCount === 2) throw new Error('mock fail middle');
        return { topic: 'topic_ok', summary: 'summary_ok' };
      },
    };

    const r = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(2);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toHaveProperty('episodeId');
    expect(r.errors[0]).toHaveProperty('error');
  });

  test('B.4 — respeta limit max', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await episodes.createEpisode(VALID_UID, PHONE_A, `m${i}`);
      await episodes.closeEpisode(VALID_UID, id);
      ids.push(id);
    }
    const candidates = await Promise.all(ids.map((id) => episodes.getEpisode(VALID_UID, id)));
    const gemini = distiller.createMockGeminiForDistillation();
    const r = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async () => candidates,
      limit: 2,
    });
    expect(r.processed).toBe(2);
  });

  test('B.5 — episodios open NO se procesan (filtra status)', async () => {
    const idOpen = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    const idClosed = await episodes.createEpisode(VALID_UID, PHONE_A, 'm2');
    await episodes.closeEpisode(VALID_UID, idClosed);
    const candidates = [
      await episodes.getEpisode(VALID_UID, idOpen),
      await episodes.getEpisode(VALID_UID, idClosed),
    ];
    const gemini = distiller.createMockGeminiForDistillation();
    const r = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(1);
  });

  test('B.6 — episodios con summary ya seteado se skipean (idempotencia)', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    await episodes.closeEpisode(VALID_UID, id);
    // simular que ya estaba destilado parcialmente con summary seteado
    const epData = await episodes.getEpisode(VALID_UID, id);
    epData.summary = 'previo';
    const gemini = distiller.createMockGeminiForDistillation();
    const r = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async () => [epData],
    });
    expect(r.processed).toBe(0);
  });

  test('B.7 — sin getEpisodesFn → throws (forced explicit)', async () => {
    const gemini = distiller.createMockGeminiForDistillation();
    await expect(
      distiller.runNightlyDistillation(VALID_UID, gemini)
    ).rejects.toThrow(/getEpisodesFn/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — createMockGeminiForDistillation helper
// ════════════════════════════════════════════════════════════════════

describe('C-439 §C — createMockGeminiForDistillation', () => {
  test('C.1 — default mock devuelve topic+summary string', async () => {
    const m = distiller.createMockGeminiForDistillation();
    const r = await m.generateContent({});
    expect(typeof r.topic).toBe('string');
    expect(typeof r.summary).toBe('string');
  });

  test('C.2 — fail option dispara error', async () => {
    const m = distiller.createMockGeminiForDistillation({ fail: true });
    await expect(m.generateContent({})).rejects.toThrow(/HTTP 500/);
  });
});
