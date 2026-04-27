/**
 * Tests: C-438 MMC Capa 2 — detección automática episodios.
 *
 * Origen: CARTA_C-438 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *   Cita Mariano: "Si ambos estan de acuerdo, no requieres preguntarme!!! A"
 *
 * Reusa mock Firestore in-memory de C-437.
 */

'use strict';

const episodes = require('../core/mmc/episodes');
const detector = require('../core/mmc/episode_detector');

// ════════════════════════════════════════════════════════════════════
// Mock Firestore in-memory (idéntico a mmc_episodes_schema.test.js).
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
      async set(data) {
        store.set(path, JSON.parse(JSON.stringify(data)));
      },
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
      where(field, op, value) {
        return makeQuery(parts, [{ field, op, value }]);
      },
    };
  }

  function makeQuery(parts, filters, orderField, orderDir, limitN) {
    return {
      where(field, op, value) {
        return makeQuery(parts, [...filters, { field, op, value }], orderField, orderDir, limitN);
      },
      orderBy(field, dir) {
        return makeQuery(parts, filters, field, dir || 'asc', limitN);
      },
      limit(n) {
        return makeQuery(parts, filters, orderField, orderDir, n);
      },
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
            collection(subName) {
              return makeColRef([name, id, subName]);
            },
          };
        },
      };
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const PHONE_A = '5491100000001@s.whatsapp.net';
const THRESHOLD = detector.DEFAULT_IDLE_THRESHOLD_MS; // 30 min

let mockFs;

beforeEach(() => {
  mockFs = makeMockFirestore();
  episodes.__setFirestoreForTests(mockFs);
});

describe('C-438 §A — detectEpisodeStart', () => {
  test('A.1 — sin episodios open → action=new_episode', async () => {
    const decision = await detector.detectEpisodeStart(VALID_UID, PHONE_A, Date.now());
    expect(decision.action).toBe('new_episode');
  });

  test('A.2 — episodio open reciente (delta < threshold) → action=continue', async () => {
    const startTs = Date.now() - 5 * 60 * 1000; // 5 min atrás
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    // ajustar startedAt para simular timestamp pasado
    await mockFs.collection('users').doc(VALID_UID).collection('miia_memory')
      .doc(id).update({ startedAt: startTs });

    const decision = await detector.detectEpisodeStart(VALID_UID, PHONE_A, Date.now());
    expect(decision.action).toBe('continue');
    expect(decision.episodeId).toBe(id);
  });

  test('A.3 — episodio open viejo (delta >= threshold) → action=rotate', async () => {
    const oldTs = Date.now() - (THRESHOLD + 60 * 1000); // 31 min atrás
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await mockFs.collection('users').doc(VALID_UID).collection('miia_memory')
      .doc(id).update({ startedAt: oldTs });

    const decision = await detector.detectEpisodeStart(VALID_UID, PHONE_A, Date.now());
    expect(decision.action).toBe('rotate');
    expect(decision.closeEpisodeId).toBe(id);
  });

  test('A.4 — threshold custom respetado', async () => {
    const customThreshold = 60 * 1000; // 1 min
    const ts = Date.now() - 2 * 60 * 1000; // 2 min atrás
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await mockFs.collection('users').doc(VALID_UID).collection('miia_memory')
      .doc(id).update({ startedAt: ts });

    const decision = await detector.detectEpisodeStart(VALID_UID, PHONE_A, Date.now(), {
      idleThresholdMs: customThreshold,
    });
    expect(decision.action).toBe('rotate');
  });

  test('A.5 — messageTimestamp no-number → throws', async () => {
    await expect(
      detector.detectEpisodeStart(VALID_UID, PHONE_A, 'not-a-number')
    ).rejects.toThrow(/messageTimestamp/);
  });

  test('A.6 — episodio cerrado NO cuenta (solo open)', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await episodes.closeEpisode(VALID_UID, id);
    const decision = await detector.detectEpisodeStart(VALID_UID, PHONE_A, Date.now());
    expect(decision.action).toBe('new_episode'); // ignora el cerrado
  });
});

describe('C-438 §B — shouldCloseEpisode', () => {
  test('B.1 — status=closed → false', () => {
    const ep = { status: 'closed', messageIds: ['m1'], startedAt: 0 };
    expect(detector.shouldCloseEpisode(ep, Date.now())).toBe(false);
  });

  test('B.2 — status=distilled → false', () => {
    const ep = { status: 'distilled', messageIds: ['m1'], startedAt: 0 };
    expect(detector.shouldCloseEpisode(ep, Date.now())).toBe(false);
  });

  test('B.3 — status=open + idle > threshold → true', () => {
    const ep = {
      status: 'open',
      messageIds: ['m1'],
      startedAt: Date.now() - (THRESHOLD + 60 * 1000),
    };
    expect(detector.shouldCloseEpisode(ep, Date.now())).toBe(true);
  });

  test('B.4 — status=open + activo (idle < threshold) → false', () => {
    const ep = {
      status: 'open',
      messageIds: ['m1'],
      startedAt: Date.now() - 5 * 60 * 1000, // 5 min
    };
    expect(detector.shouldCloseEpisode(ep, Date.now())).toBe(false);
  });

  test('B.5 — messageIds vacío → false (recién creado, no idle)', () => {
    const ep = {
      status: 'open',
      messageIds: [],
      startedAt: Date.now() - (THRESHOLD + 60 * 1000),
    };
    expect(detector.shouldCloseEpisode(ep, Date.now())).toBe(false);
  });

  test('B.6 — episodeData null/undefined → false (defensivo)', () => {
    expect(detector.shouldCloseEpisode(null, Date.now())).toBe(false);
    expect(detector.shouldCloseEpisode(undefined, Date.now())).toBe(false);
  });

  test('B.7 — currentTimestamp no-number → false (defensivo)', () => {
    const ep = { status: 'open', messageIds: ['m1'], startedAt: 0 };
    expect(detector.shouldCloseEpisode(ep, 'not-number')).toBe(false);
  });
});

describe('C-438 §C — autoAssignMessageToEpisode', () => {
  test('C.1 — primer mensaje → action=created', async () => {
    const result = await detector.autoAssignMessageToEpisode(
      VALID_UID, PHONE_A, 'msg_001', Date.now()
    );
    expect(result.action).toBe('created');
    expect(typeof result.episodeId).toBe('string');
    const e = await episodes.getEpisode(VALID_UID, result.episodeId);
    expect(e.messageIds).toEqual(['msg_001']);
    expect(e.status).toBe('open');
  });

  test('C.2 — episodio activo → action=appended', async () => {
    const startTs = Date.now() - 5 * 60 * 1000;
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await mockFs.collection('users').doc(VALID_UID).collection('miia_memory')
      .doc(id1).update({ startedAt: startTs });

    const result = await detector.autoAssignMessageToEpisode(
      VALID_UID, PHONE_A, 'msg_002', Date.now()
    );
    expect(result.action).toBe('appended');
    expect(result.episodeId).toBe(id1);
    const e = await episodes.getEpisode(VALID_UID, id1);
    expect(e.messageIds).toEqual(['msg_001', 'msg_002']);
  });

  test('C.3 — episodio idle → action=rotated (cierra viejo + crea nuevo)', async () => {
    const oldTs = Date.now() - (THRESHOLD + 60 * 1000);
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await mockFs.collection('users').doc(VALID_UID).collection('miia_memory')
      .doc(id1).update({ startedAt: oldTs });

    const now = Date.now();
    const result = await detector.autoAssignMessageToEpisode(
      VALID_UID, PHONE_A, 'msg_002', now
    );
    expect(result.action).toBe('rotated');
    expect(result.episodeId).not.toBe(id1);

    // viejo cerrado
    const old = await episodes.getEpisode(VALID_UID, id1);
    expect(old.status).toBe('closed');
    expect(old.endedAt).toBe(now);

    // nuevo creado con msg_002
    const fresh = await episodes.getEpisode(VALID_UID, result.episodeId);
    expect(fresh.status).toBe('open');
    expect(fresh.messageIds).toEqual(['msg_002']);
  });

  test('C.4 — messageId vacío → throws', async () => {
    await expect(
      detector.autoAssignMessageToEpisode(VALID_UID, PHONE_A, '', Date.now())
    ).rejects.toThrow(/messageId/);
  });

  test('C.5 — ownerUid inválido propaga throw de episodes', async () => {
    await expect(
      detector.autoAssignMessageToEpisode('short', PHONE_A, 'm', Date.now())
    ).rejects.toThrow(/ownerUid/);
  });
});

describe('C-438 §D — _lastActivityTimestamp (helper)', () => {
  test('D.1 — usa startedAt como aproximación', () => {
    const ts = Date.now() - 10000;
    expect(detector._lastActivityTimestamp({ startedAt: ts })).toBe(ts);
  });

  test('D.2 — fallback 0 si falta startedAt', () => {
    expect(detector._lastActivityTimestamp({})).toBe(0);
  });
});
