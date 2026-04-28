/**
 * Tests: C-462-PRIVACY-REPORT-LOUD-FAIL — buildPrivacyReport propaga
 * errores con partial diagnostic.
 *
 * Origen: ITER 3 RRC §B hallazgo BAJA. APROBADO Wi autoridad delegada
 * 2026-04-28 11:33 COT. Pattern LOUD-FAIL anchor C-459 BUG 2.
 *
 * Bug previo: 4+ helpers en report_builder.js tragan errores silently
 *   con `catch (_) { return defaults }`. Si UNAUTHENTICATED, owner ve
 *   reporte vacio "0 contactos / 0 mensajes" sin saber del error.
 *
 * Fix: helpers devuelven {ok, data, error?, section}. buildPrivacyReport
 *   agrega partial_errors a _diagnostic. Si TODOS fallan, throws con
 *   err.code='PRIVACY_REPORT_ALL_FAILED'.
 */

'use strict';

const reportBuilder = require('../core/privacy/report_builder');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

function makeMockFs(opts = {}) {
  const failures = opts || {};
  const store = new Map();
  function makeDocRef(p) {
    return {
      path: p,
      async get() {
        if (failures[p]) {
          throw new Error(failures[p]);
        }
        const data = store.get(p);
        return { exists: data !== undefined, data: () => data };
      },
      collection(sub) {
        const subPath = `${p}/${sub}`;
        return {
          path: subPath,
          doc(id) { return makeDocRef(`${subPath}/${id}`); },
          async get() {
            if (failures[subPath]) {
              throw new Error(failures[subPath]);
            }
            const docs = [];
            const prefix = subPath + '/';
            for (const [k, v] of store.entries()) {
              if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
                docs.push({ id: k.slice(prefix.length), data: () => v });
              }
            }
            return { docs };
          },
          where(field, op, value) {
            return {
              async get() {
                if (failures[subPath]) {
                  throw new Error(failures[subPath]);
                }
                const docs = [];
                const prefix = subPath + '/';
                for (const [k, v] of store.entries()) {
                  if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
                    if (v[field] === value) docs.push({ id: k.slice(prefix.length), data: () => v });
                  }
                }
                return { docs };
              },
            };
          },
          orderBy() {
            const wrapper = {
              limit() {
                return {
                  async get() {
                    if (failures[subPath]) {
                      throw new Error(failures[subPath]);
                    }
                    const docs = [];
                    const prefix = subPath + '/';
                    for (const [k, v] of store.entries()) {
                      if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
                        docs.push({ id: k.slice(prefix.length), data: () => v });
                      }
                    }
                    return { docs: docs.slice(0, 1) };
                  },
                };
              },
            };
            return wrapper;
          },
        };
      },
    };
  }
  return {
    _store: store,
    collection(name) {
      return {
        path: name,
        doc(id) { return makeDocRef(`${name}/${id}`); },
        where(field, op, value) {
          return {
            async get() {
              if (failures[name]) {
                throw new Error(failures[name]);
              }
              const docs = [];
              const prefix = name + '/';
              for (const [k, v] of store.entries()) {
                if (k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1) {
                  if (v[field] === value) docs.push({ id: k.slice(prefix.length), data: () => v });
                }
              }
              return { docs };
            },
          };
        },
      };
    },
  };
}

describe('C-462-PRIVACY-REPORT-LOUD-FAIL §A — happy path', () => {
  test('A.1 — todos helpers OK → report SIN _diagnostic', async () => {
    const mock = makeMockFs();
    mock._store.set(`users/${VALID_UID}`, { email: 'mariano@test.com', name: 'Mariano' });
    reportBuilder.__setFirestoreForTests(mock);

    const r = await reportBuilder.buildPrivacyReport(VALID_UID);
    expect(r.ownerUid).toBe(VALID_UID);
    expect(r.profile.email).toBe('mariano@test.com');
    expect(r._diagnostic).toBeUndefined();
  });
});

describe('C-462-PRIVACY-REPORT-LOUD-FAIL §B — partial failures', () => {
  test('B.1 — 1 helper UNAUTHENTICATED → report con _diagnostic.partial_errors', async () => {
    const mock = makeMockFs({
      [`users/${VALID_UID}/contactTypes`]: '16 UNAUTHENTICATED auth fail',
    });
    mock._store.set(`users/${VALID_UID}`, { email: 'm@t.com' });
    reportBuilder.__setFirestoreForTests(mock);

    const r = await reportBuilder.buildPrivacyReport(VALID_UID);
    expect(r._diagnostic).toBeDefined();
    expect(r._diagnostic.partial_errors.length).toBe(1);
    expect(r._diagnostic.partial_errors[0].section).toBe('contactsClassifications');
    expect(r._diagnostic.partial_errors[0].error).toMatch(/UNAUTHENTICATED/);
    // Otros helpers siguen funcionando: profile OK
    expect(r.profile.email).toBe('m@t.com');
    // Default seguro para helper fallido
    expect(r.contactsClassifications.totalClassified).toBe(0);
  });

  test('B.2 — partial_errors entry tiene shape correcto (section + error)', async () => {
    const mock = makeMockFs({
      [`users/${VALID_UID}/contactTypes`]: 'UNAUTHENTICATED test',
    });
    mock._store.set(`users/${VALID_UID}`, {});
    reportBuilder.__setFirestoreForTests(mock);

    const r = await reportBuilder.buildPrivacyReport(VALID_UID);
    expect(r._diagnostic.partial_errors[0]).toMatchObject({
      section: 'contactsClassifications',
      error: expect.stringContaining('UNAUTHENTICATED'),
    });
  });
});

describe('C-462-PRIVACY-REPORT-LOUD-FAIL §C — all helpers fail', () => {
  test('C.1 — todos fallan → throws PRIVACY_REPORT_ALL_FAILED', async () => {
    // Forzar fail global: todas las queries Firestore tiran error.
    const mock = {
      collection() {
        return {
          doc() { return { async get() { throw new Error('UNAUTHENTICATED global'); } }; },
          where() { return { async get() { throw new Error('UNAUTHENTICATED global'); } }; },
        };
      },
    };
    reportBuilder.__setFirestoreForTests(mock);

    // Wrap doc methods to also fail
    const origCollection = mock.collection;
    mock.collection = function(name) {
      const c = origCollection.call(mock, name);
      const origDoc = c.doc;
      c.doc = function(id) {
        const d = origDoc.call(c, id);
        d.collection = function() {
          return {
            async get() { throw new Error('UNAUTHENTICATED global'); },
            doc() { return { async get() { throw new Error('UNAUTHENTICATED global'); } }; },
            where() { return { async get() { throw new Error('UNAUTHENTICATED global'); } }; },
            orderBy() { return { limit() { return { async get() { throw new Error('UNAUTHENTICATED global'); } }; } }; },
          };
        };
        return d;
      };
      return c;
    };

    await expect(reportBuilder.buildPrivacyReport(VALID_UID))
      .rejects.toMatchObject({ code: 'PRIVACY_REPORT_ALL_FAILED' });
  });
});

describe('C-462-PRIVACY-REPORT-LOUD-FAIL §D — defensive', () => {
  test('D.1 — ownerUid invalido → throws (sin tocar Firestore)', async () => {
    await expect(reportBuilder.buildPrivacyReport('short')).rejects.toThrow(/ownerUid invalid/);
  });

  test('D.2 — ownerUid undefined → throws', async () => {
    await expect(reportBuilder.buildPrivacyReport(undefined)).rejects.toThrow(/ownerUid invalid/);
  });
});

describe('C-462-PRIVACY-REPORT-LOUD-FAIL §E — source markers', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../core/privacy/report_builder.js'),
    'utf8'
  );

  test('E.1 — comentario C-462-PRIVACY-REPORT-LOUD-FAIL presente', () => {
    expect(SRC).toContain('C-462-PRIVACY-REPORT-LOUD-FAIL');
  });

  test('E.2 — log [V2-ALERT][PRIVACY-REPORT-PARTIAL] presente', () => {
    expect(SRC).toContain('[V2-ALERT][PRIVACY-REPORT-PARTIAL]');
  });

  test('E.3 — code PRIVACY_REPORT_ALL_FAILED presente', () => {
    expect(SRC).toContain('PRIVACY_REPORT_ALL_FAILED');
  });

  test('E.4 — schema reportDiagnosticSchema presente', () => {
    const SCHEMA_SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/privacy/report_schema.js'),
      'utf8'
    );
    expect(SCHEMA_SRC).toContain('reportDiagnosticSchema');
  });
});
