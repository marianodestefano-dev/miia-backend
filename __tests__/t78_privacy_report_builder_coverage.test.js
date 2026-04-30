'use strict';

/**
 * T78 — privacy/report_builder.js coverage gap fix (era 72.32%)
 *
 * Cubre helpers internos por categoría + LOUD-FAIL paths + partial errors.
 */

const rb = require('../core/privacy/report_builder');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // 28 chars

// Mock helpers
function mockDoc(data, exists = true) {
  return {
    get: async () => ({ exists, data: () => data || {} }),
  };
}
function mockCollection(docsArr) {
  return {
    get: async () => ({ docs: docsArr.map(d => ({ data: () => d })) }),
    where: () => mockCollection(docsArr),
    orderBy: () => ({
      limit: () => ({
        get: async () => ({ docs: docsArr.slice(0, 1).map(d => ({ data: () => d })) }),
      }),
    }),
    doc: (subId) => mockDoc({}),
  };
}

function makeMockFirestoreOK(uid) {
  return {
    collection: (name) => {
      if (name === 'consent_records') {
        return { where: () => ({ get: async () => ({ docs: [{ data: () => ({}) }, { data: () => ({}) }] }) }) };
      }
      if (name !== 'users') {
        return { get: async () => ({ docs: [] }) };
      }
      return {
        doc: (docUid) => ({
          get: async () => ({
            exists: true,
            data: () => ({
              email: 'm@x.com',
              name: 'Mariano',
              aiDisclosureEnabled: true,
              fortalezaSealed: false,
              weekendModeEnabled: true,
            }),
          }),
          collection: (subname) => {
            if (subname === 'miia_state') {
              return {
                doc: () => ({
                  get: async () => ({
                    exists: true,
                    data: () => ({ conversations: { '+57301': ['m1', 'm2'], '+57302': [] } }),
                  }),
                }),
              };
            }
            if (subname === 'contactTypes') {
              return {
                get: async () => ({ docs: [
                  { data: () => ({ type: 'lead' }) },
                  { data: () => ({ type: 'lead' }) },
                  { data: () => ({ type: 'family' }) },
                ] }),
              };
            }
            if (subname === 'calendar_events') {
              const now = Date.now();
              return {
                get: async () => ({ docs: [
                  { data: () => ({ startTimestamp: now + 3600000 }) }, // upcoming
                  { data: () => ({ startTimestamp: now - 3600000 }) }, // past
                  { data: () => ({ startTimestamp: 0 }) }, // past (sin ts -> 0)
                ] }),
              };
            }
            if (subname === 'quotes') {
              return {
                get: async () => ({ docs: [{ data: () => ({ createdAt: '2026-04-30T10:00:00Z' }) }] }),
                orderBy: () => ({
                  limit: () => ({
                    get: async () => ({ docs: [{ data: () => ({ createdAt: '2026-04-30T10:00:00Z' }) }] }),
                  }),
                }),
              };
            }
            if (subname === 'audit_logs') {
              return { get: async () => ({ docs: [{}, {}, {}] }) };
            }
            return { get: async () => ({ docs: [] }) };
          },
        }),
      };
    },
  };
}

function makeMockFirestoreAllFail() {
  const fail = () => { throw new Error('firestore down'); };
  return {
    collection: () => ({
      doc: () => ({
        get: fail,
        collection: () => ({
          get: fail,
          doc: () => ({ get: fail }),
          where: () => ({ get: fail }),
          orderBy: () => ({ limit: () => ({ get: fail }) }),
        }),
      }),
      where: () => ({ get: fail }),
    }),
  };
}

afterEach(() => {
  rb.__setFirestoreForTests(null);
});

describe('T78 §A — buildPrivacyReport happy path', () => {
  test('todas las secciones OK → report completo sin _diagnostic', async () => {
    rb.__setFirestoreForTests(makeMockFirestoreOK(VALID_UID));
    const r = await rb.buildPrivacyReport(VALID_UID);
    expect(r.ownerUid).toBe(VALID_UID);
    expect(r.profile.email).toBe('m@x.com');
    expect(r.profile.ownerName).toBe('Mariano');
    expect(r.conversationsSummary.totalContacts).toBe(2);
    expect(r.conversationsSummary.totalMessages).toBe(2);
    expect(r.conversationsSummary.conversationsWithMessages).toBe(1);
    expect(r.contactsClassifications.totalClassified).toBe(3);
    expect(r.contactsClassifications.byType.lead).toBe(2);
    expect(r.contactsClassifications.byType.family).toBe(1);
    expect(r.calendarEvents.upcoming).toBe(1);
    expect(r.calendarEvents.past).toBe(2);
    expect(r.quotes.totalGenerated).toBe(1);
    expect(r.configFlags.aiDisclosureEnabled).toBe(true);
    expect(r.auditLog.consentRecords).toBe(2);
    expect(r.auditLog.totalEntries).toBe(3);
    expect(r._diagnostic).toBeUndefined();
    expect(typeof r.generatedAt).toBe('string');
  });
});

describe('T78 §B — validación ownerUid', () => {
  test('uid corto tira', async () => {
    rb.__setFirestoreForTests(makeMockFirestoreOK(VALID_UID));
    await expect(rb.buildPrivacyReport('short')).rejects.toThrow(/ownerUid invalid/);
  });
  test('uid null tira', async () => {
    rb.__setFirestoreForTests(makeMockFirestoreOK(VALID_UID));
    await expect(rb.buildPrivacyReport(null)).rejects.toThrow(/ownerUid invalid/);
  });
  test('uid muy largo tira', async () => {
    rb.__setFirestoreForTests(makeMockFirestoreOK(VALID_UID));
    await expect(rb.buildPrivacyReport('x'.repeat(200))).rejects.toThrow(/ownerUid invalid/);
  });
  test('uid no-string tira', async () => {
    rb.__setFirestoreForTests(makeMockFirestoreOK(VALID_UID));
    await expect(rb.buildPrivacyReport(123)).rejects.toThrow(/ownerUid invalid/);
  });
});

describe('T78 §C — partial errors LOUD-FAIL', () => {
  test('1 seccion falla → report con _diagnostic.partial_errors', async () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      // Mock que falla solo profile (users doc)
      rb.__setFirestoreForTests({
        collection: (name) => {
          if (name === 'consent_records') {
            return { where: () => ({ get: async () => ({ docs: [] }) }) };
          }
          return {
            doc: (uid) => ({
              get: async () => { throw new Error('profile fail'); },
              collection: (sub) => {
                if (sub === 'miia_state') return { doc: () => ({ get: async () => ({ exists: false }) }) };
                if (sub === 'contactTypes') return { get: async () => ({ docs: [] }) };
                if (sub === 'calendar_events') return { get: async () => ({ docs: [] }) };
                if (sub === 'quotes') return {
                  get: async () => ({ docs: [] }),
                  orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
                };
                if (sub === 'audit_logs') return { get: async () => ({ docs: [] }) };
                return { get: async () => ({ docs: [] }) };
              },
            }),
          };
        },
      });
      const r = await rb.buildPrivacyReport(VALID_UID);
      expect(r._diagnostic).toBeDefined();
      // profile + configFlags fallaron (ambos consultan users.doc().get)
      expect(r._diagnostic.partial_errors.length).toBeGreaterThanOrEqual(1);
      expect(r.profile.email).toBeNull(); // default fallback
    } finally { console.warn = orig; }
  });

  test('todas las secciones fallan → throw PRIVACY_REPORT_ALL_FAILED', async () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      rb.__setFirestoreForTests(makeMockFirestoreAllFail());
      await expect(rb.buildPrivacyReport(VALID_UID)).rejects.toThrow(/all .* sections failed/);
    } finally { console.warn = orig; }
  });
});

describe('T78 §D — defensive defaults (docs inexistentes)', () => {
  test('user doc inexistente → profile con defaults', async () => {
    rb.__setFirestoreForTests({
      collection: (name) => {
        if (name === 'consent_records') return { where: () => ({ get: async () => ({ docs: [] }) }) };
        return {
          doc: (uid) => ({
            get: async () => ({ exists: false, data: () => ({}) }),
            collection: (sub) => {
              if (sub === 'miia_state') return { doc: () => ({ get: async () => ({ exists: false }) }) };
              return {
                get: async () => ({ docs: [] }),
                orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
              };
            },
          }),
        };
      },
    });
    const r = await rb.buildPrivacyReport(VALID_UID);
    expect(r.profile.email).toBeNull();
    expect(r.profile.ownerName).toBeNull();
    expect(r.conversationsSummary.totalContacts).toBe(0);
    expect(r.contactsClassifications.totalClassified).toBe(0);
    expect(r.calendarEvents.upcoming).toBe(0);
    expect(r.quotes.totalGenerated).toBe(0);
  });

  test('miia_state.conversations inexistente → totalContacts=0', async () => {
    rb.__setFirestoreForTests({
      collection: (name) => {
        if (name === 'consent_records') return { where: () => ({ get: async () => ({ docs: [] }) }) };
        return {
          doc: (uid) => ({
            get: async () => ({ exists: true, data: () => ({}) }),
            collection: (sub) => {
              if (sub === 'miia_state') {
                return { doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }) };
              }
              return {
                get: async () => ({ docs: [] }),
                orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
              };
            },
          }),
        };
      },
    });
    const r = await rb.buildPrivacyReport(VALID_UID);
    expect(r.conversationsSummary.totalContacts).toBe(0);
  });

  test('contactTypes con type vacío → cuenta como "unknown"', async () => {
    rb.__setFirestoreForTests({
      collection: (name) => {
        if (name === 'consent_records') return { where: () => ({ get: async () => ({ docs: [] }) }) };
        return {
          doc: () => ({
            get: async () => ({ exists: false }),
            collection: (sub) => {
              if (sub === 'miia_state') return { doc: () => ({ get: async () => ({ exists: false }) }) };
              if (sub === 'contactTypes') {
                return {
                  get: async () => ({ docs: [
                    { data: () => ({}) }, // sin type
                    { data: () => ({ type: 'lead' }) },
                  ] }),
                };
              }
              return {
                get: async () => ({ docs: [] }),
                orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
              };
            },
          }),
        };
      },
    });
    const r = await rb.buildPrivacyReport(VALID_UID);
    expect(r.contactsClassifications.byType.unknown).toBe(1);
    expect(r.contactsClassifications.byType.lead).toBe(1);
  });
});
