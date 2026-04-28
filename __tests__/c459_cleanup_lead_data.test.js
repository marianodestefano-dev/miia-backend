/**
 * Tests: C-459-CLEANUP-LEAD-DATA — helper modular cleanup_lead_data.js
 * + ejecutor scripts/run_cleanup_mariano_esposa.js (static markers).
 *
 * Origen: CARTA C-459 [FIRMADA_VIVO_MARIANO_2026-04-28].
 *
 * Cubre:
 *   §A inspectLeadData detecta keys correctas en mock Firestore.
 *   §B writeBackup genera JSON con shape correcto.
 *   §C deleteLeadData borra keys per-phone y miia_memory match.
 *   §D Idempotencia (deleteLeadData 2 veces no falla).
 *   §E No borra otros phones (solo los firmados).
 *   §F Static markers en script ejecutor.
 */

'use strict';

const path = require('path');
const fsNode = require('fs');
const cleanup = require('../core/admin/cleanup_lead_data');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const PHONE_MARIANO = '573163937365';
const JID_MARIANO = `${PHONE_MARIANO}@s.whatsapp.net`;
const PHONE_OTHER = '573054169969';
const JID_OTHER = `${PHONE_OTHER}@s.whatsapp.net`;

// Mock Firestore con FieldValue.delete soporte
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
        const cur = store.get(p) || {};
        // Resolver dotted paths (ej. "conversations.<jid>") con FieldValue.delete
        for (const [key, value] of Object.entries(patch)) {
          if (key.includes('.')) {
            const [parent, ...rest] = key.split('.');
            const childKey = rest.join('.');
            cur[parent] = { ...(cur[parent] || {}) };
            if (value && value.__isDelete) {
              delete cur[parent][childKey];
            } else {
              cur[parent][childKey] = value;
            }
          } else if (value && value.__isDelete) {
            delete cur[key];
          } else {
            cur[key] = value;
          }
        }
        store.set(p, cur);
      },
      async delete() {
        store.delete(p);
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
                docs.push({
                  id: k.slice(prefix.length),
                  ref: makeDocRef(k),
                  data: () => v,
                });
              }
            }
            return { docs };
          },
        };
      },
    };
  }
  const mock = {
    _store: store,
    collection(name) {
      return { doc(id) { return makeDocRef(`${name}/${id}`); } };
    },
  };
  // Inyectar FieldValue mock para que cleanup_lead_data lo use.
  mock._FieldValue = { delete: () => ({ __isDelete: true }) };
  return mock;
}

let mock;
beforeEach(() => {
  mock = makeMockFs();
  cleanup.__setFirestoreForTests(mock);
});

function setupTenantConversations() {
  mock._store.set(`users/${VALID_UID}/miia_persistent/tenant_conversations`, {
    conversations: {
      [JID_MARIANO]: [{ role: 'user', content: 'hola', timestamp: 1700000000000 }],
      [JID_OTHER]: [{ role: 'user', content: 'lead', timestamp: 1700000001000 }],
    },
    contactTypes: {
      [JID_MARIANO]: 'lead',
      [JID_OTHER]: 'miia_lead',
    },
    leadNames: {
      [JID_MARIANO]: 'Mariano',
      [JID_OTHER]: 'OtherLead',
    },
    conversationMetadata: {
      [JID_MARIANO]: { lastSeen: 1700000000000 },
    },
    ownerActiveChats: {
      [JID_MARIANO]: true,
    },
    updatedAt: 'serverTimestamp',
  });
}

function setupMiiaMemoryEpisodes() {
  mock._store.set(`users/${VALID_UID}/miia_memory/ep_001`, {
    episodeId: 'ep_001', contactPhone: JID_MARIANO, status: 'closed', summary: 's1',
  });
  mock._store.set(`users/${VALID_UID}/miia_memory/ep_002`, {
    episodeId: 'ep_002', contactPhone: JID_OTHER, status: 'closed', summary: 's2',
  });
  mock._store.set(`users/${VALID_UID}/miia_memory/ep_003`, {
    episodeId: 'ep_003', contactPhone: JID_MARIANO, status: 'open',
  });
}

// ════════════════════════════════════════════════════════════════════
// §A — inspectLeadData
// ════════════════════════════════════════════════════════════════════

describe('C-459-CLEANUP §A — inspectLeadData', () => {
  test('A.1 — detecta tenant_conversations keys per-phone correctamente', async () => {
    setupTenantConversations();
    const r = await cleanup.inspectLeadData(VALID_UID, [PHONE_MARIANO]);
    expect(r.tenantConversations[JID_MARIANO]).toBeDefined();
    expect(r.tenantConversations[JID_MARIANO].contactTypes).toBe('lead');
    expect(r.tenantConversations[JID_MARIANO].leadNames).toBe('Mariano');
    expect(r.tenantConversations[JID_MARIANO].conversations.length).toBe(1);
  });

  test('A.2 — detecta miia_memory episodios match contactPhone', async () => {
    setupMiiaMemoryEpisodes();
    const r = await cleanup.inspectLeadData(VALID_UID, [PHONE_MARIANO]);
    expect(r.miiaMemory.length).toBe(2);
    const ids = r.miiaMemory.map((e) => e.episodeId).sort();
    expect(ids).toEqual(['ep_001', 'ep_003']);
  });

  test('A.3 — phones array vacio → throws', async () => {
    await expect(cleanup.inspectLeadData(VALID_UID, []))
      .rejects.toThrow(/phones array required/);
  });

  test('A.4 — ownerUid invalido → throws', async () => {
    await expect(cleanup.inspectLeadData('short', [PHONE_MARIANO]))
      .rejects.toThrow(/ownerUid invalid/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — writeBackup
// ════════════════════════════════════════════════════════════════════

describe('C-459-CLEANUP §B — writeBackup', () => {
  test('B.1 — genera JSON con schema correcto', () => {
    const tmpFile = path.join(require('os').tmpdir(), `c459_test_backup_${Date.now()}.json`);
    const snapshot = {
      tenantConversations: { [JID_MARIANO]: { conversations: [] } },
      miiaMemory: [],
    };
    cleanup.writeBackup(snapshot, tmpFile);
    expect(fsNode.existsSync(tmpFile)).toBe(true);
    const parsed = JSON.parse(fsNode.readFileSync(tmpFile, 'utf8'));
    expect(parsed.schema).toBe('C-459-CLEANUP-LEAD-DATA-v1');
    expect(typeof parsed.backupAt).toBe('string');
    expect(parsed.tenantConversations).toBeDefined();
    fsNode.unlinkSync(tmpFile);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — deleteLeadData
// ════════════════════════════════════════════════════════════════════

describe('C-459-CLEANUP §C — deleteLeadData', () => {
  test('C.1 — borra keys tenant_conversations del phone target solamente', async () => {
    setupTenantConversations();
    const r = await cleanup.deleteLeadData(VALID_UID, [PHONE_MARIANO]);
    expect(r.deletedKeys.conversations).toContain(JID_MARIANO);
    expect(r.deletedKeys.contactTypes).toContain(JID_MARIANO);

    const tcDoc = mock._store.get(`users/${VALID_UID}/miia_persistent/tenant_conversations`);
    // Mariano borrado
    expect(tcDoc.conversations[JID_MARIANO]).toBeUndefined();
    expect(tcDoc.contactTypes[JID_MARIANO]).toBeUndefined();
    // Other intacto
    expect(tcDoc.conversations[JID_OTHER]).toBeDefined();
    expect(tcDoc.contactTypes[JID_OTHER]).toBe('miia_lead');
  });

  test('C.2 — borra miia_memory episodios match contactPhone', async () => {
    setupMiiaMemoryEpisodes();
    const r = await cleanup.deleteLeadData(VALID_UID, [PHONE_MARIANO]);
    expect(r.deletedEpisodes).toBe(2);
    // ep_001 + ep_003 (Mariano) borrados
    expect(mock._store.get(`users/${VALID_UID}/miia_memory/ep_001`)).toBeUndefined();
    expect(mock._store.get(`users/${VALID_UID}/miia_memory/ep_003`)).toBeUndefined();
    // ep_002 (other) intacto
    expect(mock._store.get(`users/${VALID_UID}/miia_memory/ep_002`)).toBeDefined();
  });

  test('C.3 — idempotente: 2 deletes consecutivos no fallan', async () => {
    setupTenantConversations();
    setupMiiaMemoryEpisodes();
    await cleanup.deleteLeadData(VALID_UID, [PHONE_MARIANO]);
    const r2 = await cleanup.deleteLeadData(VALID_UID, [PHONE_MARIANO]);
    expect(r2.deletedEpisodes).toBe(0); // ya no hay episodes
  });

  test('C.4 — phones array vacio → throws', async () => {
    await expect(cleanup.deleteLeadData(VALID_UID, []))
      .rejects.toThrow(/phones array required/);
  });

  test('C.5 — multi-phone borra todos los matches', async () => {
    setupTenantConversations();
    setupMiiaMemoryEpisodes();
    const r = await cleanup.deleteLeadData(VALID_UID, [PHONE_MARIANO, PHONE_OTHER]);
    expect(r.deletedEpisodes).toBe(3);
    const tcDoc = mock._store.get(`users/${VALID_UID}/miia_persistent/tenant_conversations`);
    expect(tcDoc.conversations[JID_MARIANO]).toBeUndefined();
    expect(tcDoc.conversations[JID_OTHER]).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — Static markers script ejecutor
// ════════════════════════════════════════════════════════════════════

describe('C-459-CLEANUP §D — script run_cleanup_mariano_esposa.js', () => {
  const SCRIPT_PATH = path.resolve(__dirname, '../scripts/run_cleanup_mariano_esposa.js');
  const SOURCE = fsNode.readFileSync(SCRIPT_PATH, 'utf8');

  test('D.1 — MIIA_CENTER_UID hardcoded correcto', () => {
    expect(SOURCE).toContain(`'A5pMESWlfmPWCoCPRbwy85EzUzy2'`);
  });

  test('D.2 — Mariano Personal phone hardcoded', () => {
    expect(SOURCE).toContain(`'573163937365'`);
  });

  test('D.3 — DEFAULT mode es DRY_RUN (--execute requerido)', () => {
    expect(SOURCE).toMatch(/process\.argv\.includes\(\s*['"]--execute['"]/);
  });

  test('D.4 — backup path en c:/tmp con timestamp', () => {
    expect(SOURCE).toMatch(/c:\/tmp\/cleanup_mariano_esposa_/);
  });

  test('D.5 — invoca cleanup.inspectLeadData + cleanup.deleteLeadData', () => {
    expect(SOURCE).toMatch(/cleanup\.inspectLeadData/);
    expect(SOURCE).toMatch(/cleanup\.deleteLeadData/);
  });

  test('D.6 — log [V2-ALERT][CLEANUP-EXECUTED] en exito', () => {
    expect(SOURCE).toContain('[V2-ALERT][CLEANUP-EXECUTED]');
  });
});
