/**
 * Tests: C-444 Privacy ForgetMe (request + confirm + cancel + execute).
 *
 * Origen: CARTA_C-444 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Mock Firestore reusado de C-437/C-442 patrón.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const forgetMe = require('../core/privacy/forget_me');
const schemas = require('../core/privacy/report_schema');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const OTHER_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

// Mock Firestore in-memory (patrón C-437)
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
        async add(d) {
          const id = `auto_${store.size}_${Math.random().toString(36).slice(2, 6)}`;
          store.set(`${name}/${id}`, JSON.parse(JSON.stringify(d)));
          return { id };
        },
      };
    },
  };
}

let mock;
beforeEach(() => {
  mock = makeMockFs();
  forgetMe.__setFirestoreForTests(mock);
});

// ════════════════════════════════════════════════════════════════════
// §A — Schemas
// ════════════════════════════════════════════════════════════════════

describe('C-444 §A — Zod schemas', () => {
  test('A.1 — forgetMeRequestSchema valida userId 20-128', () => {
    expect(schemas.forgetMeRequestSchema.safeParse({ userId: VALID_UID }).success).toBe(true);
    expect(schemas.forgetMeRequestSchema.safeParse({ userId: 'short' }).success).toBe(false);
  });

  test('A.2 — forgetMeRequestSchema strict (rechaza extras)', () => {
    expect(
      schemas.forgetMeRequestSchema.safeParse({ userId: VALID_UID, role: 'admin' }).success
    ).toBe(false);
  });

  test('A.3 — forgetMeConfirmSchema valida token 6 dígitos', () => {
    expect(
      schemas.forgetMeConfirmSchema.safeParse({ userId: VALID_UID, token: '123456' }).success
    ).toBe(true);
    expect(
      schemas.forgetMeConfirmSchema.safeParse({ userId: VALID_UID, token: '12345' }).success
    ).toBe(false);
    expect(
      schemas.forgetMeConfirmSchema.safeParse({ userId: VALID_UID, token: 'abcdef' }).success
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — requestForgetMe
// ════════════════════════════════════════════════════════════════════

describe('C-444 §B — requestForgetMe', () => {
  test('B.1 — primera request → genera token + flag pending', async () => {
    const r = await forgetMe.requestForgetMe(VALID_UID);
    expect(r.token).toMatch(/^\d{6}$/);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
    const data = mock._store.get(`users/${VALID_UID}`);
    expect(data.forgetme_pending).toBe(true);
    expect(data.forgetme_confirmed).toBe(false);
    expect(typeof data.forgetme_token_hash).toBe('string');
  });

  test('B.2 — request con pending activo dentro de TTL → throws', async () => {
    await forgetMe.requestForgetMe(VALID_UID);
    await expect(forgetMe.requestForgetMe(VALID_UID)).rejects.toThrow(/already pending/);
  });

  test('B.3 — ownerUid inválido → throws', async () => {
    await expect(forgetMe.requestForgetMe('short')).rejects.toThrow(/ownerUid/);
  });

  test('B.4 — token NO se almacena plain — solo hash', async () => {
    const r = await forgetMe.requestForgetMe(VALID_UID);
    const data = mock._store.get(`users/${VALID_UID}`);
    expect(data.forgetme_token_hash).not.toBe(r.token);
    expect(data.forgetme_token_hash.length).toBe(64); // SHA-256 hex
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — confirmForgetMe
// ════════════════════════════════════════════════════════════════════

describe('C-444 §C — confirmForgetMe', () => {
  test('C.1 — token válido → confirmed=true', async () => {
    const { token } = await forgetMe.requestForgetMe(VALID_UID);
    const r = await forgetMe.confirmForgetMe(VALID_UID, token);
    expect(r.confirmed).toBe(true);
    const data = mock._store.get(`users/${VALID_UID}`);
    expect(data.forgetme_confirmed).toBe(true);
  });

  test('C.2 — token inválido → throws', async () => {
    await forgetMe.requestForgetMe(VALID_UID);
    await expect(forgetMe.confirmForgetMe(VALID_UID, '000000')).rejects.toThrow(/token mismatch/);
  });

  test('C.3 — token formato inválido → throws', async () => {
    await expect(forgetMe.confirmForgetMe(VALID_UID, 'abc')).rejects.toThrow(/token invalid/);
  });

  test('C.4 — sin pending → throws', async () => {
    await expect(forgetMe.confirmForgetMe(VALID_UID, '123456')).rejects.toThrow(/owner not found|no forgetme pending/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — cancelForgetMe
// ════════════════════════════════════════════════════════════════════

describe('C-444 §D — cancelForgetMe', () => {
  test('D.1 — cancela pending → flag pending=false', async () => {
    await forgetMe.requestForgetMe(VALID_UID);
    const r = await forgetMe.cancelForgetMe(VALID_UID);
    expect(r.cancelled).toBe(true);
    const data = mock._store.get(`users/${VALID_UID}`);
    expect(data.forgetme_pending).toBe(false);
    expect(data.forgetme_token_hash).toBeNull();
  });

  test('D.2 — sin pending → throws', async () => {
    await expect(forgetMe.cancelForgetMe(VALID_UID)).rejects.toThrow(/owner not found|no forgetme pending/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §E — executeForgetMe (cron daily simulation)
// ════════════════════════════════════════════════════════════════════

describe('C-444 §E — executeForgetMe', () => {
  test('E.1 — sin confirmed → throws', async () => {
    await forgetMe.requestForgetMe(VALID_UID);
    await expect(forgetMe.executeForgetMe(VALID_UID)).rejects.toThrow(/not confirmed/);
  });

  test('E.2 — confirmed → borra subcollections + anonymiza profile', async () => {
    const { token } = await forgetMe.requestForgetMe(VALID_UID);
    await forgetMe.confirmForgetMe(VALID_UID, token);
    // Simular subcollection con data
    mock._store.set(`users/${VALID_UID}/miia_memory/ep_1`, { topic: 't' });
    mock._store.set(`users/${VALID_UID}/contactTypes/contact_1`, { type: 'lead' });
    // También set email + name en profile para verificar anonymization
    mock._store.set(`users/${VALID_UID}`, {
      ...mock._store.get(`users/${VALID_UID}`),
      email: 'mariano@miia-app.com',
      name: 'Mariano',
    });

    const r = await forgetMe.executeForgetMe(VALID_UID);
    expect(r.deleted.length).toBeGreaterThan(0);

    const profile = mock._store.get(`users/${VALID_UID}`);
    expect(profile.email).toBeNull();
    expect(profile.name).toBeNull();
    expect(profile.forgetme_anonymized).toBe(true);
    expect(profile.forgetme_pending).toBe(false);
  });

  test('E.3 — preserva audit_logs entry anonymizado', async () => {
    const { token } = await forgetMe.requestForgetMe(VALID_UID);
    await forgetMe.confirmForgetMe(VALID_UID, token);
    await forgetMe.executeForgetMe(VALID_UID);

    let auditCount = 0;
    for (const k of mock._store.keys()) {
      if (k.startsWith('audit_logs/')) auditCount += 1;
    }
    expect(auditCount).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// §F — Endpoints static (continuidad C-440/C-442 patrón)
// ════════════════════════════════════════════════════════════════════

describe('C-444 §F — endpoints wire-in static', () => {
  const SERVER_PATH = path.resolve(__dirname, '../server.js');
  const SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

  test('F.1 — endpoint POST /api/privacy/forget-me registrado', () => {
    expect(SOURCE).toMatch(/app\.post\(\s*['"]\/api\/privacy\/forget-me['"]/);
  });

  test('F.2 — endpoint POST /api/privacy/forget-me/confirm registrado', () => {
    expect(SOURCE).toMatch(/app\.post\(\s*['"]\/api\/privacy\/forget-me\/confirm['"]/);
  });

  test('F.3 — endpoint POST /api/privacy/forget-me/cancel registrado', () => {
    expect(SOURCE).toMatch(/app\.post\(\s*['"]\/api\/privacy\/forget-me\/cancel['"]/);
  });

  test('F.4 — todos los endpoints usan rrRequireAuth + rrRequireOwnerOfResource', () => {
    const blocks = SOURCE.match(/\/api\/privacy\/forget-me[\s\S]{0,500}?async/g);
    expect(blocks).not.toBeNull();
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      expect(block).toMatch(/rrRequireAuth/);
      expect(block).toMatch(/rrRequireOwnerOfResource/);
    }
  });

  test('F.5 — token NUNCA se incluye en response request endpoint', () => {
    const block = SOURCE.match(/app\.post\(\s*['"]\/api\/privacy\/forget-me['"][\s\S]{0,2000}?\n\)/);
    expect(block).not.toBeNull();
    // En el response NO debe haber token plain
    expect(block[0]).toMatch(/expiresAt/);
    // En res.json no debe ir 'token:' inline
    expect(block[0]).not.toMatch(/res\.json\([^)]*\btoken:/);
  });

  test('F.6 — log [V2-ALERT][PRIVACY-FORGETME-FAIL] en error', () => {
    expect(SOURCE).toContain('[V2-ALERT][PRIVACY-FORGETME-FAIL]');
  });
});
