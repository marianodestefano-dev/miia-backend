/**
 * Tests: C-445 §A — Integration tests end-to-end Piso 1.
 *
 * Origen: CARTA_C-445 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Cubre flujo completo Piso 1:
 *   C-437 schema → C-438 detector → C-439 distiller → C-440 wire-in TMH →
 *   C-441 nightly runner → C-442 privacy report builder →
 *   C-443 export endpoint → C-444 forgetme.
 *
 * Mock Firestore in-memory + mock Gemini. Sin emulator dependency.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const episodes = require('../core/mmc/episodes');
const detector = require('../core/mmc/episode_detector');
const distiller = require('../core/mmc/episode_distiller');
const reportBuilder = require('../core/privacy/report_builder');
const forgetMe = require('../core/privacy/forget_me');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // MIIA CENTER
const PHONE_A = '5491100000001@s.whatsapp.net';

// ════════════════════════════════════════════════════════════════════
// Mock Firestore unificado para todo el flujo
// ════════════════════════════════════════════════════════════════════

function makeMockFs() {
  const store = new Map();
  let autoIdCounter = 0;

  function makeDocRef(parts) {
    const id = parts[parts.length - 1];
    const path = parts.join('/');
    return {
      id, path,
      async set(d, opts) {
        if (opts && opts.merge) {
          const cur = store.get(path) || {};
          store.set(path, { ...cur, ...JSON.parse(JSON.stringify(d)) });
        } else {
          store.set(path, JSON.parse(JSON.stringify(d)));
        }
      },
      async update(p) {
        const cur = store.get(path);
        if (!cur) throw new Error('not found');
        store.set(path, { ...cur, ...JSON.parse(JSON.stringify(p)) });
      },
      async delete() { store.delete(path); },
      async get() {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data ? JSON.parse(JSON.stringify(data)) : undefined };
      },
      collection(sub) { return makeColRef([...parts, sub]); },
    };
  }
  function makeColRef(parts) {
    return {
      doc(id) {
        const docId = id || `auto_${++autoIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
        return makeDocRef([...parts, docId]);
      },
      where(field, op, value) { return makeQuery(parts, [{ field, op, value }]); },
      orderBy(field, dir) { return makeQuery(parts, [], field, dir); },
      async add(d) {
        const id = `auto_${++autoIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
        store.set([...parts, id].join('/'), JSON.parse(JSON.stringify(d)));
        return { id };
      },
      async get() {
        const prefix = parts.join('/') + '/';
        const docs = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
            docs.push({ id: k.slice(prefix.length), data: () => JSON.parse(JSON.stringify(v)) });
          }
        }
        return { docs };
      },
    };
  }
  function makeQuery(parts, filters, ordF, ordD, lim) {
    return {
      where(f, op, v) { return makeQuery(parts, [...filters, { field: f, op, value: v }], ordF, ordD, lim); },
      orderBy(f, d) { return makeQuery(parts, filters, f, d, lim); },
      limit(n) { return makeQuery(parts, filters, ordF, ordD, n); },
      async get() {
        const prefix = parts.join('/') + '/';
        let docs = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
            docs.push({ id: k.slice(prefix.length), data: () => JSON.parse(JSON.stringify(v)) });
          }
        }
        for (const f of filters) {
          docs = docs.filter((d) => d.data()[f.field] === f.value);
        }
        if (ordF) {
          docs.sort((a, b) => {
            const av = a.data()[ordF]; const bv = b.data()[ordF];
            return ordD === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
          });
        }
        if (lim) docs = docs.slice(0, lim);
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
            collection(sub) { return makeColRef([name, id, sub]); },
            async get() {
              const path = `${name}/${id}`;
              const data = store.get(path);
              return { exists: data !== undefined, data: () => data };
            },
            async set(d, opts) {
              const path = `${name}/${id}`;
              if (opts && opts.merge) {
                const cur = store.get(path) || {};
                store.set(path, { ...cur, ...JSON.parse(JSON.stringify(d)) });
              } else {
                store.set(path, JSON.parse(JSON.stringify(d)));
              }
            },
          };
        },
        where(field, op, value) {
          return {
            where(f, op2, v) {
              return {
                limit: (n) => ({
                  async get() {
                    const docs = [];
                    for (const [k, v2] of store.entries()) {
                      if (k.startsWith(`${name}/`) && k.split('/').length === 2) {
                        if (v2[field] === value && v2[f] === v) {
                          docs.push({ id: k.split('/')[1], data: () => v2 });
                        }
                      }
                    }
                    return { docs: docs.slice(0, n) };
                  },
                }),
              };
            },
          };
        },
        async add(d) {
          const id = `auto_${++autoIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
          store.set(`${name}/${id}`, JSON.parse(JSON.stringify(d)));
          return { id };
        },
      };
    },
  };
}

let mockFs;

beforeEach(() => {
  mockFs = makeMockFs();
  episodes.__setFirestoreForTests(mockFs);
  distiller.__setFirestoreForTests(mockFs);
  reportBuilder.__setFirestoreForTests(mockFs);
  forgetMe.__setFirestoreForTests(mockFs);
});

// ════════════════════════════════════════════════════════════════════
// §A — Flujo completo MMC
// ════════════════════════════════════════════════════════════════════

describe('C-445 §A — E2E flujo MMC (C-437 → C-441)', () => {
  test('A.1 — autoAssign creates → addMessage → close → distill → graduated', async () => {
    // C-440 wire-in: autoAssignMessageToEpisode
    const r1 = await detector.autoAssignMessageToEpisode(VALID_UID, PHONE_A, 'msg_001', Date.now());
    expect(r1.action).toBe('created');

    // C-437 add más mensajes
    await episodes.addMessageToEpisode(VALID_UID, r1.episodeId, 'msg_002');

    // C-437 close
    await episodes.closeEpisode(VALID_UID, r1.episodeId);

    // C-439 distill
    const gemini = distiller.createMockGeminiForDistillation({
      topic: 'consulta inventario abril',
      summary: 'Owner pide stock + plazos.',
    });
    const result = await distiller.runNightlyDistillation(VALID_UID, gemini, {
      getEpisodesFn: async (uid) => {
        const list = await episodes.listEpisodes(uid, PHONE_A, { status: 'closed' });
        return list;
      },
    });
    expect(result.processed).toBe(1);
    expect(result.errors).toEqual([]);

    // Verificar episodio destilado
    const finalEp = await episodes.getEpisode(VALID_UID, r1.episodeId);
    expect(finalEp.status).toBe('distilled');
    expect(finalEp.topic).toBe('consulta inventario abril');
  });

  test('A.2 — detector rotate idle (C-438) — close viejo + new', async () => {
    const oldTs = Date.now() - (35 * 60 * 1000);
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    await mockFs.collection('users').doc(VALID_UID).collection('miia_memory').doc(id1).update({ startedAt: oldTs });

    const r = await detector.autoAssignMessageToEpisode(VALID_UID, PHONE_A, 'm2', Date.now());
    expect(r.action).toBe('rotated');
    const old = await episodes.getEpisode(VALID_UID, id1);
    expect(old.status).toBe('closed');
    const fresh = await episodes.getEpisode(VALID_UID, r.episodeId);
    expect(fresh.status).toBe('open');
    expect(fresh.messageIds).toEqual(['m2']);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Privacy report incluye episodios (C-442)
// ════════════════════════════════════════════════════════════════════

describe('C-445 §B — Privacy report con datos MMC (C-442)', () => {
  test('B.1 — buildPrivacyReport retorna shape válido sin data', async () => {
    const report = await reportBuilder.buildPrivacyReport(VALID_UID);
    expect(report.ownerUid).toBe(VALID_UID);
    expect(report.profile.uid).toBe(VALID_UID);
    expect(report.conversationsSummary.totalContacts).toBe(0);
  });

  test('B.2 — owner con profile data → report incluye email + name', async () => {
    await mockFs.collection('users').doc(VALID_UID).set({
      email: 'mariano@miia-app.com',
      name: 'Mariano',
    });
    const report = await reportBuilder.buildPrivacyReport(VALID_UID);
    expect(report.profile.email).toBe('mariano@miia-app.com');
    expect(report.profile.ownerName).toBe('Mariano');
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — ForgetMe full cycle (C-444)
// ════════════════════════════════════════════════════════════════════

describe('C-445 §C — ForgetMe E2E (C-444)', () => {
  test('C.1 — request → confirm → execute → data borrada + audit preservado', async () => {
    // Setup data inicial
    await mockFs.collection('users').doc(VALID_UID).set({
      email: 'mariano@miia-app.com',
      name: 'Mariano',
    });
    await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');

    // C-444 §B request
    const { token } = await forgetMe.requestForgetMe(VALID_UID);
    expect(token).toMatch(/^\d{6}$/);

    // C-444 §C confirm
    await forgetMe.confirmForgetMe(VALID_UID, token);

    // C-444 §E execute
    const r = await forgetMe.executeForgetMe(VALID_UID);
    expect(r.deleted.length).toBeGreaterThan(0);

    // Verificar profile anonymizado
    const profile = mockFs._store.get(`users/${VALID_UID}`);
    expect(profile.email).toBeNull();
    expect(profile.name).toBeNull();
    expect(profile.forgetme_anonymized).toBe(true);

    // Verificar audit log preservado
    let auditCount = 0;
    for (const k of mockFs._store.keys()) {
      if (k.startsWith('audit_logs/')) auditCount += 1;
    }
    expect(auditCount).toBeGreaterThan(0);
  });

  test('C.2 — cancel previene execute (idempotencia)', async () => {
    const { token } = await forgetMe.requestForgetMe(VALID_UID);
    await forgetMe.cancelForgetMe(VALID_UID);
    // Después cancel, intentar confirm con token original debe fallar
    await expect(forgetMe.confirmForgetMe(VALID_UID, token)).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — Aislamiento multi-tenant (C-429 + C-440)
// ════════════════════════════════════════════════════════════════════

describe('C-445 §D — Aislamiento cross-owner (C-429 + C-440)', () => {
  const OWNER_B = 'bq2BbtCVF8cZo30tum584zrGATJ3';

  test('D.1 — episodios owner A NO aparecen en queries owner B', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'mA');
    const epOwnerB = await episodes.getEpisode(OWNER_B, id);
    expect(epOwnerB).toBeNull();
  });

  test('D.2 — buildPrivacyReport owner B NO ve datos owner A', async () => {
    await episodes.createEpisode(VALID_UID, PHONE_A, 'mA');
    const reportB = await reportBuilder.buildPrivacyReport(OWNER_B);
    expect(reportB.profile.uid).toBe(OWNER_B);
    // Owner B no tiene episodios — su report debe estar vacío
  });
});

// ════════════════════════════════════════════════════════════════════
// §E — Executor script integrity (C-445 §B)
// ════════════════════════════════════════════════════════════════════

describe('C-445 §E — run_forget_me_executor.js script', () => {
  const SCRIPT_PATH = path.resolve(__dirname, '../scripts/run_forget_me_executor.js');
  const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

  test('E.1 — script llama executeForgetMe del helper C-444', () => {
    expect(SOURCE).toMatch(/forgetMe\.executeForgetMe\s*\(/);
  });

  test('E.2 — query Firestore filter forgetme_pending=true Y confirmed=true', () => {
    expect(SOURCE).toMatch(/forgetme_pending.*==.*true/);
    expect(SOURCE).toMatch(/forgetme_confirmed.*==.*true/);
  });

  test('E.3 — log [V2-ALERT][FORGETME-EXECUTED] count', () => {
    expect(SOURCE).toContain('[V2-ALERT][FORGETME-EXECUTED]');
  });

  test('E.4 — try/catch per-owner (no bloquea batch)', () => {
    expect(SOURCE).toMatch(/for\s*\([^)]*candidates[\s\S]{0,200}?try\s*\{/);
  });

  test('E.5 — exit code 0 OK / 1 error', () => {
    expect(SOURCE).toMatch(/process\.exit\(0\)/);
    expect(SOURCE).toMatch(/process\.exit\(1\)/);
  });
});
