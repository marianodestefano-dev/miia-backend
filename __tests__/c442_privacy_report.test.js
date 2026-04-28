/**
 * Tests: C-442 Privacy Report (schema + builder + endpoint static).
 *
 * Origen: CARTA_C-442 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Continuidad C-435 doctrina Zod + C-440 patrón static regex tests.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const schemas = require('../core/privacy/report_schema');
const builder = require('../core/privacy/report_builder');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

// ════════════════════════════════════════════════════════════════════
// Mock Firestore mínimo
// ════════════════════════════════════════════════════════════════════

function makeMockFs(initial = {}) {
  const docs = new Map(initial.docs || []);
  const collections = new Map(initial.collections || []);

  function makeDocRef(p) {
    return {
      path: p,
      async get() {
        const data = docs.get(p);
        return { exists: data !== undefined, data: () => data };
      },
      collection(sub) {
        return makeColRef(`${p}/${sub}`);
      },
    };
  }
  function makeColRef(p) {
    return {
      path: p,
      doc(id) { return makeDocRef(`${p}/${id}`); },
      where(field, op, value) {
        return makeQuery(p, [{ field, op, value }]);
      },
      orderBy(field, dir) {
        return makeQuery(p, [], field, dir);
      },
      async get() {
        const all = [];
        const cdocs = collections.get(p) || [];
        for (const [id, data] of cdocs) all.push({ id, data: () => data });
        return { docs: all };
      },
    };
  }
  function makeQuery(colPath, filters, ordF, ordD, lim) {
    return {
      where(f, op, v) { return makeQuery(colPath, [...filters, { field: f, op, value: v }], ordF, ordD, lim); },
      orderBy(f, d) { return makeQuery(colPath, filters, f, d, lim); },
      limit(n) { return makeQuery(colPath, filters, ordF, ordD, n); },
      async get() {
        let cdocs = (collections.get(colPath) || []).map(([id, data]) => ({ id, data: () => data }));
        for (const f of filters) {
          cdocs = cdocs.filter((d) => d.data()[f.field] === f.value);
        }
        if (lim) cdocs = cdocs.slice(0, lim);
        return { docs: cdocs };
      },
    };
  }
  return {
    collection(name) {
      return makeColRef(name);
    },
    _docs: docs,
    _collections: collections,
  };
}

// ════════════════════════════════════════════════════════════════════
// §A — Schema validation
// ════════════════════════════════════════════════════════════════════

describe('C-442 §A — privacyReportSchema validation', () => {
  test('A.1 — payload completo válido PASA', () => {
    const valid = {
      ownerUid: VALID_UID,
      generatedAt: new Date().toISOString(),
      profile: { uid: VALID_UID, email: 'a@b.com', ownerName: 'Mariano' },
      conversationsSummary: { totalContacts: 0, totalMessages: 0, conversationsWithMessages: 0 },
      contactsClassifications: { totalClassified: 0, byType: {} },
      calendarEvents: { totalCreated: 0, upcoming: 0, past: 0 },
      quotes: { totalGenerated: 0, lastQuoteAt: null },
      configFlags: { aiDisclosureEnabled: false, fortalezaSealed: false, weekendModeEnabled: false },
      auditLog: { consentRecords: 0, totalEntries: 0 },
    };
    expect(schemas.privacyReportSchema.safeParse(valid).success).toBe(true);
  });

  test('A.2 — falta ownerUid → FALLA', () => {
    expect(schemas.privacyReportSchema.safeParse({}).success).toBe(false);
  });

  test('A.3 — campo extra (mass-assignment) → FALLA strict', () => {
    const bad = {
      ownerUid: VALID_UID, generatedAt: new Date().toISOString(),
      profile: { uid: VALID_UID }, conversationsSummary: { totalContacts: 0, totalMessages: 0, conversationsWithMessages: 0 },
      contactsClassifications: { totalClassified: 0, byType: {} },
      calendarEvents: { totalCreated: 0, upcoming: 0, past: 0 },
      quotes: { totalGenerated: 0 }, configFlags: {}, auditLog: { consentRecords: 0, totalEntries: 0 },
      extraInjected: 'admin',
    };
    expect(schemas.privacyReportSchema.safeParse(bad).success).toBe(false);
  });

  test('A.4 — request schema valida userId 20-128 chars', () => {
    expect(schemas.privacyReportRequestSchema.safeParse({ userId: VALID_UID }).success).toBe(true);
    expect(schemas.privacyReportRequestSchema.safeParse({ userId: 'short' }).success).toBe(false);
  });

  test('A.5 — request schema strict (rechaza extras)', () => {
    expect(
      schemas.privacyReportRequestSchema.safeParse({ userId: VALID_UID, role: 'admin' }).success
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — buildPrivacyReport
// ════════════════════════════════════════════════════════════════════

describe('C-442 §B — buildPrivacyReport happy path', () => {
  test('B.1 — owner inexistente → reporte con defaults vacíos válido', async () => {
    const mock = makeMockFs();
    builder.__setFirestoreForTests(mock);
    const r = await builder.buildPrivacyReport(VALID_UID);
    expect(r.ownerUid).toBe(VALID_UID);
    expect(r.profile.uid).toBe(VALID_UID);
    expect(r.profile.email).toBeNull();
    expect(r.conversationsSummary.totalContacts).toBe(0);
    expect(r.contactsClassifications.totalClassified).toBe(0);
    expect(r.calendarEvents.totalCreated).toBe(0);
    expect(r.quotes.totalGenerated).toBe(0);
    expect(r.auditLog.consentRecords).toBe(0);
  });

  test('B.2 — owner con profile data → email y nombre populados', async () => {
    const mock = makeMockFs({
      docs: [
        [`users/${VALID_UID}`, { email: 'mariano@miia-app.com', name: 'Mariano' }],
      ],
    });
    builder.__setFirestoreForTests(mock);
    const r = await builder.buildPrivacyReport(VALID_UID);
    expect(r.profile.email).toBe('mariano@miia-app.com');
    expect(r.profile.ownerName).toBe('Mariano');
  });

  test('B.3 — ownerUid inválido → throws', async () => {
    builder.__setFirestoreForTests(makeMockFs());
    await expect(builder.buildPrivacyReport('short')).rejects.toThrow(/ownerUid/);
  });

  test('B.4 — output shape validado contra Zod schema (defensive)', async () => {
    const mock = makeMockFs();
    builder.__setFirestoreForTests(mock);
    const r = await builder.buildPrivacyReport(VALID_UID);
    // Re-validar contra schema explícito
    const parse = schemas.privacyReportSchema.safeParse(r);
    expect(parse.success).toBe(true);
  });

  test('B.5 — campos del reporte NO contienen raw content (privacy)', async () => {
    const mock = makeMockFs();
    builder.__setFirestoreForTests(mock);
    const r = await builder.buildPrivacyReport(VALID_UID);
    const json = JSON.stringify(r);
    // No debe contener literales típicos de mensajes
    expect(json.toLowerCase()).not.toMatch(/messageBody|raw_content/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — endpoint static regex (continuidad C-440 patrón)
// ════════════════════════════════════════════════════════════════════

describe('C-442 §C — endpoint /api/privacy/report wire-in static', () => {
  const SERVER_PATH = path.resolve(__dirname, '../server.js');
  const SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

  test('C.1 — endpoint registrado con app.get', () => {
    expect(SOURCE).toMatch(/app\.get\s*\(\s*['"]\/api\/privacy\/report['"]/);
  });

  test('C.2 — usa rrRequireAuth + rrRequireOwnerOfResource', () => {
    const block = SOURCE.match(/app\.get\(\s*['"]\/api\/privacy\/report['"][\s\S]{0,400}?async/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/rrRequireAuth/);
    expect(block[0]).toMatch(/rrRequireOwnerOfResource/);
  });

  test('C.3 — middleware Zod validate aplicado', () => {
    const block = SOURCE.match(/app\.get\(\s*['"]\/api\/privacy\/report['"][\s\S]{0,400}?async/);
    expect(block[0]).toMatch(/publicSchemas\.validate.*privacyReportRequestSchema/);
  });

  test('C.4 — log [V2-ALERT][PRIVACY-REPORT-FAIL] en error', () => {
    expect(SOURCE).toContain('[V2-ALERT][PRIVACY-REPORT-FAIL]');
  });

  test('C.5 — buildPrivacyReport invocado', () => {
    expect(SOURCE).toMatch(/privacyReportBuilder\.buildPrivacyReport\s*\(/);
  });
});
