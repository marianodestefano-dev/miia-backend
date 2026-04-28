/**
 * Tests: C-450-FIRESTORE-TX-AUDIT — lock distribuido per-episodio en
 * runNightlyDistillation evita doble-call Gemini + double-write race.
 *
 * Origen: ITER 2 RRC-VI-001 §B.2 finding (audit operadores Firestore
 * con flags estado). Aprobado Wi autoridad delegada.
 *
 * Bug previo:
 *   - 2 cron runners paralelos invocan runNightlyDistillation con
 *     mismos candidates -> ambos llaman Gemini -> costo duplicado.
 *   - Filtro `if (ep.summary || ep.status !== 'closed') continue` se
 *     aplica al snapshot pre-distill; entre el read y el update hay
 *     ventana de race.
 *
 * Fix:
 *   - _acquireDistillLock(): runTransaction marca distilling=true
 *     atómico. Si otro runner ya tiene el lock, throws + skip.
 *   - _markDistilled(): set status=distilled + summary + topic +
 *     distilling=false (libera lock al completar).
 *   - try/catch wrap en runNightlyDistillation libera distilling=false
 *     si distillEpisode falla, para retry sano del próximo cron.
 */

'use strict';

const distiller = require('../core/mmc/episode_distiller');
const episodes = require('../core/mmc/episodes');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

// Mock Firestore con runTransaction (patrón C-448).
function makeMockFs() {
  const store = new Map();
  function makeDocRef(p) {
    return {
      path: p,
      async get() {
        const data = store.get(p);
        return { exists: data !== undefined, data: () => data };
      },
      async set(d, opts) {
        if (opts && opts.merge) {
          const cur = store.get(p) || {};
          store.set(p, { ...cur, ...JSON.parse(JSON.stringify(d)) });
        } else {
          store.set(p, JSON.parse(JSON.stringify(d)));
        }
      },
      async update(patch) {
        const cur = store.get(p);
        if (!cur) throw new Error('not found');
        store.set(p, { ...cur, ...JSON.parse(JSON.stringify(patch)) });
      },
      collection(sub) {
        const subPath = `${p}/${sub}`;
        return {
          path: subPath,
          doc(id) { return makeDocRef(`${subPath}/${id}`); },
          async get() {
            const docs = [];
            const prefix = subPath + '/';
            for (const [k, v] of store.entries()) {
              if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
                docs.push({ id: k.slice(prefix.length), data: () => v });
              }
            }
            return { docs };
          },
        };
      },
    };
  }
  return {
    _store: store,
    collection(name) {
      return {
        doc(id) { return makeDocRef(`${name}/${id}`); },
      };
    },
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

let mock;
beforeEach(() => {
  mock = makeMockFs();
  distiller.__setFirestoreForTests(mock);
});

function makeMockGemini(opts = {}) {
  return {
    async generateContent({ signal }) {
      if (opts.fail) throw new Error('mock gemini fail');
      return { topic: opts.topic || 'mock topic', summary: opts.summary || 'mock summary' };
    },
  };
}

function setupClosedEpisode(episodeId) {
  const path = `users/${VALID_UID}/miia_memory/${episodeId}`;
  mock._store.set(path, {
    episodeId,
    status: 'closed',
    summary: null,
    contactPhone: '5491100000001@s.whatsapp.net',
  });
}

// ════════════════════════════════════════════════════════════════════
// §A — Lock atómico per-episodio
// ════════════════════════════════════════════════════════════════════

describe('C-450-FIRESTORE-TX-AUDIT §A — distill lock', () => {
  test('A.1 — runNightlyDistillation marca distilling=false al completar (lock liberado)', async () => {
    setupClosedEpisode('ep_001');
    const candidates = [{ episodeId: 'ep_001', status: 'closed', summary: null }];
    const r = await distiller.runNightlyDistillation(VALID_UID, makeMockGemini(), {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(1);
    const data = mock._store.get(`users/${VALID_UID}/miia_memory/ep_001`);
    expect(data.distilling).toBe(false);
    expect(data.status).toBe('distilled');
    expect(data.summary).toBe('mock summary');
  });

  test('A.2 — episodio con distilling=true preset → skipeado (lock por otro runner)', async () => {
    setupClosedEpisode('ep_002');
    // Simular otro runner ya tiene el lock
    const path = `users/${VALID_UID}/miia_memory/ep_002`;
    mock._store.set(path, { ...mock._store.get(path), distilling: true });

    const candidates = [{ episodeId: 'ep_002', status: 'closed', summary: null }];
    const r = await distiller.runNightlyDistillation(VALID_UID, makeMockGemini(), {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(0);
    expect(r.skippedLocked.length).toBe(1);
    expect(r.skippedLocked[0].episodeId).toBe('ep_002');
  });

  test('A.3 — Gemini falla → libera lock para retry siguiente cron', async () => {
    setupClosedEpisode('ep_003');
    const candidates = [{ episodeId: 'ep_003', status: 'closed', summary: null }];
    const r = await distiller.runNightlyDistillation(VALID_UID, makeMockGemini({ fail: true }), {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(0);
    expect(r.errors.length).toBe(1);
    const data = mock._store.get(`users/${VALID_UID}/miia_memory/ep_003`);
    expect(data.distilling).toBe(false); // lock liberado
    expect(data.status).toBe('closed'); // sin tocar status
  });

  test('A.4 — episodio con summary ya seteado → skipeado por filter pre-lock', async () => {
    const path = `users/${VALID_UID}/miia_memory/ep_004`;
    mock._store.set(path, { episodeId: 'ep_004', status: 'distilled', summary: 'old' });
    const candidates = [{ episodeId: 'ep_004', status: 'distilled', summary: 'old' }];
    const r = await distiller.runNightlyDistillation(VALID_UID, makeMockGemini(), {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(0);
    // No skippedLocked porque el filter pre-lock catcha primero
  });

  test('A.5 — multiples episodios mixtos: 1 disponible + 1 locked + 1 distilled', async () => {
    setupClosedEpisode('ep_avail');
    setupClosedEpisode('ep_locked');
    mock._store.set(`users/${VALID_UID}/miia_memory/ep_locked`, {
      ...mock._store.get(`users/${VALID_UID}/miia_memory/ep_locked`),
      distilling: true,
    });
    mock._store.set(`users/${VALID_UID}/miia_memory/ep_done`, {
      episodeId: 'ep_done', status: 'distilled', summary: 'd',
    });

    const candidates = [
      { episodeId: 'ep_avail', status: 'closed', summary: null },
      { episodeId: 'ep_locked', status: 'closed', summary: null },
      { episodeId: 'ep_done', status: 'distilled', summary: 'd' },
    ];
    const r = await distiller.runNightlyDistillation(VALID_UID, makeMockGemini(), {
      getEpisodesFn: async () => candidates,
    });
    expect(r.processed).toBe(1);
    expect(r.skippedLocked.length).toBe(1);
    expect(r.skippedLocked[0].episodeId).toBe('ep_locked');
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Source code presence
// ════════════════════════════════════════════════════════════════════

describe('C-450-FIRESTORE-TX-AUDIT §B — source markers', () => {
  test('B.1 — episode_distiller.js usa runTransaction', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/mmc/episode_distiller.js'),
      'utf8'
    );
    expect(SRC).toMatch(/runTransaction/);
  });

  test('B.2 — comentario C-450-FIRESTORE-TX-AUDIT presente', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/mmc/episode_distiller.js'),
      'utf8'
    );
    expect(SRC).toContain('C-450-FIRESTORE-TX-AUDIT');
  });

  test('B.3 — _acquireDistillLock + _releaseDistillLock helpers presentes', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/mmc/episode_distiller.js'),
      'utf8'
    );
    expect(SRC).toMatch(/_acquireDistillLock/);
    expect(SRC).toMatch(/_releaseDistillLock/);
  });

  test('B.4 — flag distilling presente en _markDistilled', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/mmc/episode_distiller.js'),
      'utf8'
    );
    expect(SRC).toMatch(/distilling:\s*false/);
  });

  test('B.5 — runNightlyDistillation devuelve skippedLocked', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/mmc/episode_distiller.js'),
      'utf8'
    );
    expect(SRC).toMatch(/skippedLocked/);
  });
});
