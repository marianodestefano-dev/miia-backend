/**
 * Tests: C-437 MMC Capa 2 — schema episodios + helpers básicos.
 *
 * Origen: CARTA_C-437 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27]
 *   Cita Mariano: "Si ambos estan de acuerdo, no requieres preguntarme!!! A"
 *
 * Mock Firestore in-memory para evitar dependencia de emulator.
 */

'use strict';

const episodes = require('../core/mmc/episodes');

// ════════════════════════════════════════════════════════════════════
// Mock Firestore in-memory
// ════════════════════════════════════════════════════════════════════

function makeMockFirestore() {
  const store = new Map(); // path → data
  let autoIdCounter = 0;

  function pathFor(parts) {
    return parts.join('/');
  }

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

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // 28 chars
const PHONE_A = '5491100000001@s.whatsapp.net';
const PHONE_B = '5491100000002@s.whatsapp.net';

let mockFs;

beforeEach(() => {
  mockFs = makeMockFirestore();
  episodes.__setFirestoreForTests(mockFs);
});

describe('C-437 §A — createEpisode', () => {
  test('A.1 — genera episodeId válido + status=open + campos correctos', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const e = await episodes.getEpisode(VALID_UID, id);
    expect(e.episodeId).toBe(id);
    expect(e.ownerUid).toBe(VALID_UID);
    expect(e.contactPhone).toBe(PHONE_A);
    expect(e.status).toBe('open');
    expect(e.endedAt).toBeNull();
    expect(e.messageIds).toEqual(['msg_001']);
    expect(e.topic).toBeNull();
    expect(e.summary).toBeNull();
    expect(Array.isArray(e.tags)).toBe(true);
    expect(typeof e.startedAt).toBe('number');
  });

  test('A.2 — ownerUid inválido (vacío) → throws', async () => {
    await expect(episodes.createEpisode('', PHONE_A, 'm')).rejects.toThrow(/ownerUid/);
  });

  test('A.3 — ownerUid inválido (corto <20 chars) → throws', async () => {
    await expect(episodes.createEpisode('short', PHONE_A, 'm')).rejects.toThrow(/ownerUid/);
  });

  test('A.4 — contactPhone vacío → throws', async () => {
    await expect(episodes.createEpisode(VALID_UID, '', 'm')).rejects.toThrow(/contactPhone/);
  });

  test('A.5 — firstMessageId vacío → throws', async () => {
    await expect(episodes.createEpisode(VALID_UID, PHONE_A, '')).rejects.toThrow(/firstMessageId/);
  });
});

describe('C-437 §B — addMessageToEpisode', () => {
  test('B.1 — append messageId al array', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await episodes.addMessageToEpisode(VALID_UID, id, 'msg_002');
    await episodes.addMessageToEpisode(VALID_UID, id, 'msg_003');
    const e = await episodes.getEpisode(VALID_UID, id);
    expect(e.messageIds).toEqual(['msg_001', 'msg_002', 'msg_003']);
  });

  test('B.2 — episodio inexistente → throws', async () => {
    await expect(episodes.addMessageToEpisode(VALID_UID, 'nope', 'm')).rejects.toThrow(/not found/);
  });

  test('B.3 — episodio cerrado → throws', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await episodes.closeEpisode(VALID_UID, id);
    await expect(episodes.addMessageToEpisode(VALID_UID, id, 'msg_002')).rejects.toThrow(/cannot add/);
  });

  test('B.4 — messageId vacío → throws', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await expect(episodes.addMessageToEpisode(VALID_UID, id, '')).rejects.toThrow(/messageId/);
  });
});

describe('C-437 §C — closeEpisode', () => {
  test('C.1 — setea status=closed + endedAt', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    const ts = Date.now();
    await episodes.closeEpisode(VALID_UID, id, ts);
    const e = await episodes.getEpisode(VALID_UID, id);
    expect(e.status).toBe('closed');
    expect(e.endedAt).toBe(ts);
  });

  test('C.2 — endedAt default Date.now() si omitido', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    const before = Date.now();
    await episodes.closeEpisode(VALID_UID, id);
    const e = await episodes.getEpisode(VALID_UID, id);
    expect(e.endedAt).toBeGreaterThanOrEqual(before);
  });

  test('C.3 — episodio inexistente → throws', async () => {
    await expect(episodes.closeEpisode(VALID_UID, 'nope')).rejects.toThrow(/not found/);
  });

  test('C.4 — episodio ya cerrado → throws (idempotencia explícita)', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    await episodes.closeEpisode(VALID_UID, id);
    await expect(episodes.closeEpisode(VALID_UID, id)).rejects.toThrow(/already/);
  });
});

describe('C-437 §D — getEpisode', () => {
  test('D.1 — episodio existente devuelve data', async () => {
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'msg_001');
    const e = await episodes.getEpisode(VALID_UID, id);
    expect(e).toBeTruthy();
    expect(e.episodeId).toBe(id);
  });

  test('D.2 — episodio inexistente devuelve null', async () => {
    const e = await episodes.getEpisode(VALID_UID, 'nope');
    expect(e).toBeNull();
  });
});

describe('C-437 §E — listEpisodes (filtros)', () => {
  test('E.1 — filtra por contactPhone', async () => {
    await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    await episodes.createEpisode(VALID_UID, PHONE_A, 'm2');
    await episodes.createEpisode(VALID_UID, PHONE_B, 'm3');
    const listA = await episodes.listEpisodes(VALID_UID, PHONE_A);
    expect(listA.length).toBe(2);
    expect(listA.every((e) => e.contactPhone === PHONE_A)).toBe(true);
  });

  test('E.2 — filtra por status=open', async () => {
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    await episodes.createEpisode(VALID_UID, PHONE_A, 'm2');
    await episodes.closeEpisode(VALID_UID, id1);
    const open = await episodes.listEpisodes(VALID_UID, PHONE_A, { status: 'open' });
    expect(open.length).toBe(1);
    expect(open[0].status).toBe('open');
    const closed = await episodes.listEpisodes(VALID_UID, PHONE_A, { status: 'closed' });
    expect(closed.length).toBe(1);
    expect(closed[0].status).toBe('closed');
  });

  test('E.3 — limit aplicado', async () => {
    for (let i = 0; i < 5; i++) {
      await episodes.createEpisode(VALID_UID, PHONE_A, `m${i}`);
    }
    const limited = await episodes.listEpisodes(VALID_UID, PHONE_A, { limit: 2 });
    expect(limited.length).toBe(2);
  });

  test('E.4 — status inválido → throws', async () => {
    await expect(
      episodes.listEpisodes(VALID_UID, PHONE_A, { status: 'invalid_status' })
    ).rejects.toThrow(/status invalid/);
  });

  test('E.5 — orden desc por startedAt (más reciente primero)', async () => {
    const id1 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await episodes.createEpisode(VALID_UID, PHONE_A, 'm2');
    const list = await episodes.listEpisodes(VALID_UID, PHONE_A);
    expect(list[0].episodeId).toBe(id2);
    expect(list[1].episodeId).toBe(id1);
  });
});

describe('C-437 §F — aislamiento multi-tenant (continuidad C-429)', () => {
  test('F.1 — episodios de owner A NO se leen con uid de owner B', async () => {
    const UID_B = 'bq2BbtCVF8cZo30tum584zrGATJ3';
    const id = await episodes.createEpisode(VALID_UID, PHONE_A, 'm1');
    // owner B intenta leer con su uid → null (path subcollection diferente)
    const e = await episodes.getEpisode(UID_B, id);
    expect(e).toBeNull();
  });
});
