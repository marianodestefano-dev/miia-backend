/**
 * Tests: C-440 MMC Capa 4 — wire-in TMH (etapa 1 §2-bis MIIA CENTER).
 *
 * Origen: CARTA_C-440 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *
 * Tests estáticos sobre regex del archivo TMH (continuidad C-429 +
 * C-435 patrón) — verifican que el wire-in está presente, usa el
 * guard correcto, y respeta defensividad. Sin emulator Firestore.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TMH_PATH = path.resolve(__dirname, '../whatsapp/tenant_message_handler.js');
const TMH_SOURCE = fs.readFileSync(TMH_PATH, 'utf8');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const MIIA_PERSONAL_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

describe('C-440 §A — wire-in MMC presente y guarded', () => {
  test('A.1 — require core/mmc/episode_detector está importado', () => {
    expect(TMH_SOURCE).toMatch(/require\(['"]\.\.\/core\/mmc\/episode_detector['"]\)/);
  });

  test('A.2 — autoAssignMessageToEpisode invocado en TMH', () => {
    expect(TMH_SOURCE).toMatch(/autoAssignMessageToEpisode\s*\(/);
  });

  test('A.3 — wire-in usa guard isV2EligibleUid (etapa 1 §2-bis)', () => {
    // Buscar el bloque donde se invoca autoAssign y verificar que
    // está dentro de un if con isV2EligibleUid.
    const blockMatch = TMH_SOURCE.match(/isV2EligibleUid\s*\([^)]+\)\s*\)\s*\{[\s\S]{0,800}?autoAssignMessageToEpisode/);
    expect(blockMatch).not.toBeNull();
  });

  test('A.4 — wire-in tiene try/catch defensivo', () => {
    const block = TMH_SOURCE.match(/autoAssignMessageToEpisode[\s\S]{0,500}?catch\s*\(/);
    expect(block).not.toBeNull();
  });

  test('A.5 — error MMC loguea [V2-ALERT][MMC-WIRE-IN]', () => {
    expect(TMH_SOURCE).toMatch(/\[V2-ALERT\]\[MMC-WIRE-IN\]/);
  });

  test('A.6 — wire-in skip si !isSelfChat (no rastrea self-chat)', () => {
    const block = TMH_SOURCE.match(/!isSelfChat[\s&\w]+messageBody[\s\S]{0,500}?autoAssignMessageToEpisode/);
    expect(block).not.toBeNull();
  });
});

describe('C-440 §B — guard isV2EligibleUid coherente con doctrina §2-bis', () => {
  const voiceLoader = require('../core/voice_v2_loader');

  test('B.1 — UID MIIA CENTER → eligible (autoAssign correrá)', () => {
    expect(voiceLoader.isV2EligibleUid(MIIA_CENTER_UID)).toBe(true);
  });

  test('B.2 — UID MIIA Personal → NO eligible (autoAssign skip)', () => {
    expect(voiceLoader.isV2EligibleUid(MIIA_PERSONAL_UID)).toBe(false);
  });

  test('B.3 — UID random → NO eligible', () => {
    expect(voiceLoader.isV2EligibleUid('random_uid_123456789012345')).toBe(false);
  });

  test('B.4 — UID null/undefined/vacío → NO eligible (defensivo)', () => {
    expect(voiceLoader.isV2EligibleUid(null)).toBe(false);
    expect(voiceLoader.isV2EligibleUid(undefined)).toBe(false);
    expect(voiceLoader.isV2EligibleUid('')).toBe(false);
  });
});

describe('C-440 §C — defensividad runtime (autoAssign throws no bloquea Gemini)', () => {
  const detector = require('../core/mmc/episode_detector');
  const episodes = require('../core/mmc/episodes');

  test('C.1 — autoAssignMessageToEpisode existe + retorna shape esperado', async () => {
    // Setup mock fs minimal para verificar shape API
    const mockStore = new Map();
    const mockFs = makeMinimalMockFs(mockStore);
    episodes.__setFirestoreForTests(mockFs);

    const result = await detector.autoAssignMessageToEpisode(
      MIIA_CENTER_UID, '5491100000000@s.whatsapp.net', 'msg_test', Date.now()
    );
    expect(result).toHaveProperty('episodeId');
    expect(result).toHaveProperty('action');
    expect(['created', 'appended', 'rotated']).toContain(result.action);
  });

  test('C.2 — error MMC simulado (mockFs throws) → mensaje claro', async () => {
    const broken = {
      collection: () => { throw new Error('mock fs broken'); },
    };
    episodes.__setFirestoreForTests(broken);
    await expect(
      detector.autoAssignMessageToEpisode(MIIA_CENTER_UID, '5491100000000@s.whatsapp.net', 'msg_test', Date.now())
    ).rejects.toThrow();
    // El error es throw — el wire-in TMH lo atrapa con try/catch (verificado A.4).
  });
});

// ════════════════════════════════════════════════════════════════════
// Helper minimal para C.1 (no replica el mock completo de C-437)
// ════════════════════════════════════════════════════════════════════

function makeMinimalMockFs(store) {
  let counter = 0;
  function makeDocRef(parts) {
    const path = parts.join('/');
    return {
      id: parts[parts.length - 1],
      path,
      async set(d) { store.set(path, JSON.parse(JSON.stringify(d))); },
      async update(p) {
        const cur = store.get(path);
        if (!cur) throw new Error('not found');
        store.set(path, { ...cur, ...JSON.parse(JSON.stringify(p)) });
      },
      async get() {
        const d = store.get(path);
        return { exists: d !== undefined, data: () => d ? JSON.parse(JSON.stringify(d)) : undefined };
      },
    };
  }
  function makeColRef(parts) {
    return {
      doc(id) {
        const did = id || `auto_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
        return makeDocRef([...parts, did]);
      },
      where(f, op, v) { return makeQuery(parts, [{ f, op, v }]); },
    };
  }
  function makeQuery(parts, filters, ordF, ordD, lim) {
    return {
      where(f, op, v) { return makeQuery(parts, [...filters, { f, op, v }], ordF, ordD, lim); },
      orderBy(f, d) { return makeQuery(parts, filters, f, d || 'asc', lim); },
      limit(n) { return makeQuery(parts, filters, ordF, ordD, n); },
      async get() {
        const prefix = parts.join('/') + '/';
        let docs = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
            docs.push({ id: k.slice(prefix.length), data: () => JSON.parse(JSON.stringify(v)) });
          }
        }
        for (const flt of filters) {
          docs = docs.filter((d) => d.data()[flt.f] === flt.v);
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
    collection(name) {
      return { doc(id) { return { collection(s) { return makeColRef([name, id, s]); } }; } };
    },
  };
}
