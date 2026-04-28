/**
 * Tests: C-448-FORGETME-RACE — lock distribuido Firestore tx en
 * executeForgetMe + guards forgetme_executing en confirm/cancel.
 *
 * Origen: RRC-VI-001 ITEM 3 (race condition forget-me) revisado bajo
 * autoridad delegada Wi (regla 2 post-expulsion TEC).
 *
 * Bug previo:
 *   - executeForgetMe leía forgetme_confirmed sin lock → 2 cron ticks
 *     concurrentes ambos pasan check + ambos borran + audit log doble.
 *   - cancelForgetMe podía ejecutar mientras executeForgetMe ya estaba
 *     borrando subcollections → estado inconsistente (cancela pero
 *     datos ya borrados).
 *
 * Fix:
 *   - executeForgetMe envuelve verificación + set en runTransaction.
 *     Marca forgetme_executing=true atómico. Si otro proceso ya tiene
 *     el lock o el forgetme ya se ejecutó → throws.
 *   - confirmForgetMe + cancelForgetMe verifican !forgetme_executing
 *     y !forgetme_executed_at antes de mutar.
 *   - try/catch en executeForgetMe libera lock si subcol delete falla.
 */

'use strict';

const forgetMe = require('../core/privacy/forget_me');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

// Mock Firestore in-memory con runTransaction (extiende patrón C-444).
function makeMockFs() {
  const store = new Map();
  let txCount = 0;
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
    _txCount: () => txCount,
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
    async runTransaction(cb) {
      txCount += 1;
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
  forgetMe.__setFirestoreForTests(mock);
});

async function setupConfirmed(uid = VALID_UID) {
  const { token } = await forgetMe.requestForgetMe(uid);
  await forgetMe.confirmForgetMe(uid, token);
  return { token };
}

// ════════════════════════════════════════════════════════════════════
// §A — executeForgetMe usa runTransaction (lock distribuido)
// ════════════════════════════════════════════════════════════════════

describe('C-448-FORGETME-RACE §A — runTransaction lock', () => {
  test('A.1 — executeForgetMe invoca runTransaction al menos 1 vez', async () => {
    await setupConfirmed();
    expect(mock._txCount()).toBe(0);
    await forgetMe.executeForgetMe(VALID_UID);
    expect(mock._txCount()).toBeGreaterThanOrEqual(1);
  });

  test('A.2 — primera execute marca forgetme_executing → segunda execute throws', async () => {
    await setupConfirmed();
    // Simular segundo execute mientras el primero está "executing"
    // (forzar el flag manualmente como si el lock siguiese tomado).
    await mock.collection('users').doc(VALID_UID).set(
      { forgetme_executing: true, forgetme_executing_started_at: Date.now() },
      { merge: true }
    );
    await expect(forgetMe.executeForgetMe(VALID_UID)).rejects.toThrow(/already executing/);
  });

  test('A.3 — execute completo + segundo execute → throws "already executed"', async () => {
    await setupConfirmed();
    await forgetMe.executeForgetMe(VALID_UID);
    await expect(forgetMe.executeForgetMe(VALID_UID)).rejects.toThrow(/already executed/);
  });

  test('A.4 — sin forgetme_confirmed → throws "not confirmed" dentro de tx', async () => {
    await forgetMe.requestForgetMe(VALID_UID);
    await expect(forgetMe.executeForgetMe(VALID_UID)).rejects.toThrow(/not confirmed/);
    // Tx se invocó (descubrió el problema atómicamente)
    expect(mock._txCount()).toBeGreaterThanOrEqual(1);
  });

  test('A.5 — execute libera lock al completar (forgetme_executing=false)', async () => {
    await setupConfirmed();
    await forgetMe.executeForgetMe(VALID_UID);
    const data = mock._store.get(`users/${VALID_UID}`);
    expect(data.forgetme_executing).toBe(false);
    expect(data.forgetme_executed_at).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — cancelForgetMe respeta lock execute
// ════════════════════════════════════════════════════════════════════

describe('C-448-FORGETME-RACE §B — cancelForgetMe guards', () => {
  test('B.1 — cancel mientras executing → throws', async () => {
    await setupConfirmed();
    await mock.collection('users').doc(VALID_UID).set(
      { forgetme_executing: true },
      { merge: true }
    );
    await expect(forgetMe.cancelForgetMe(VALID_UID)).rejects.toThrow(/executing/);
  });

  test('B.2 — cancel post-execute → throws "already executed"', async () => {
    await setupConfirmed();
    await forgetMe.executeForgetMe(VALID_UID);
    // executeForgetMe limpia forgetme_pending → el guard "no forgetme pending"
    // dispara antes que el guard "already executed". Aceptamos cualquiera
    // de los dos como válido (ambos bloquean cancel post-execute).
    await expect(forgetMe.cancelForgetMe(VALID_UID)).rejects.toThrow(/no forgetme pending|already executed/);
  });

  test('B.3 — cancel pending pre-execute → OK', async () => {
    await forgetMe.requestForgetMe(VALID_UID);
    const r = await forgetMe.cancelForgetMe(VALID_UID);
    expect(r.cancelled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — confirmForgetMe respeta lock execute
// ════════════════════════════════════════════════════════════════════

describe('C-448-FORGETME-RACE §C — confirmForgetMe guards', () => {
  test('C.1 — confirm mientras executing → throws', async () => {
    const { token } = await forgetMe.requestForgetMe(VALID_UID);
    await mock.collection('users').doc(VALID_UID).set(
      { forgetme_executing: true },
      { merge: true }
    );
    await expect(forgetMe.confirmForgetMe(VALID_UID, token)).rejects.toThrow(/executing/);
  });

  test('C.2 — confirm post-execute → throws', async () => {
    const { token } = await setupConfirmed();
    await forgetMe.executeForgetMe(VALID_UID);
    // Post-execute, forgetme_pending=false → "no forgetme pending"
    // dispara antes que "already executed". Cualquiera bloquea correctamente.
    await expect(forgetMe.confirmForgetMe(VALID_UID, token)).rejects.toThrow(/no forgetme pending|already executed/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — Comportamiento concurrente simulado
// ════════════════════════════════════════════════════════════════════

describe('C-448-FORGETME-RACE §D — concurrencia simulada', () => {
  test('D.1 — execute secuencial → segundo throws "already executed"', async () => {
    // El mock runTransaction NO simula bloqueo concurrente real (cada
    // callback lee el estado del store en el momento de invocación, no
    // hay aborts por conflicto). El equivalente realista es: tras la
    // primera execute, el flag forgetme_executed_at queda seteado y la
    // siguiente execute falla rápido. El lock real (Firestore tx prod)
    // hace lo mismo + protege durante la ventana de ejecución.
    await setupConfirmed();
    const r1 = await forgetMe.executeForgetMe(VALID_UID);
    expect(r1.deleted).toBeDefined();
    await expect(forgetMe.executeForgetMe(VALID_UID)).rejects.toThrow(/already executed|already executing/);
  });

  test('D.2 — execute exitoso + audit_logs single entry (no duplicado)', async () => {
    await setupConfirmed();
    await forgetMe.executeForgetMe(VALID_UID);
    let auditCount = 0;
    for (const k of mock._store.keys()) {
      if (k.startsWith('audit_logs/')) auditCount += 1;
    }
    expect(auditCount).toBe(1);
  });

  test('D.3 — comentarios C-448-FORGETME-RACE presentes en source', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/privacy/forget_me.js'),
      'utf8'
    );
    expect(SRC).toMatch(/C-448-FORGETME-RACE/);
    expect(SRC).toMatch(/runTransaction/);
    expect(SRC).toMatch(/forgetme_executing/);
  });
});
