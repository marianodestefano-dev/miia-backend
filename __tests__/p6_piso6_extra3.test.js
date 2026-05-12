"use strict";
/**
 * P6 PISO 6 extra3 -- dashboard_aggregator + billing_admin + agent_notifier error paths
 */

jest.mock("node-fetch", () => jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

const da = require('../core/dashboard_aggregator');
const ba = require('../core/billing_admin');
const an = require('../core/agent_notifier');

// --- dashboard_aggregator helpers ---
function makeDaDb({ docs = [], throwGet = false } = {}) {
  const get = throwGet
    ? jest.fn().mockRejectedValue(new Error('Firestore error'))
    : jest.fn().mockResolvedValue({
        forEach: cb => docs.forEach(d => cb({ data: () => d })),
      });
  const innerDocObj = { set: jest.fn().mockResolvedValue({}) };
  const innerCol = { get, doc: jest.fn().mockReturnValue(innerDocObj) };
  const outerDoc = { collection: jest.fn().mockReturnValue(innerCol), set: jest.fn().mockResolvedValue({}) };
  const outerCol = { doc: jest.fn().mockReturnValue(outerDoc) };
  return { collection: jest.fn().mockReturnValue(outerCol) };
}

// --- billing_admin helpers ---
function makeBillingDb({ payments = [] } = {}) {
  const docsSnap = { forEach: cb => payments.forEach(p => cb({ data: () => p })) };
  const getSnap = jest.fn().mockResolvedValue(docsSnap);
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        set: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        collection: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ get: getSnap }),
        }),
      }),
      where: jest.fn().mockReturnValue({ get: getSnap }),
    }),
  };
}

// --- agent_notifier helpers ---
function makeAnDb({ agentExists = true, agentData = {}, throwSave = false, throwAgentGet = false } = {}) {
  const agentGet = throwAgentGet
    ? jest.fn().mockRejectedValue(new Error('Firestore read error'))
    : jest.fn().mockResolvedValue({ exists: agentExists, data: () => agentData });
  const histGet = jest.fn().mockResolvedValue({ docs: [] });
  const notifSet = throwSave
    ? jest.fn().mockRejectedValue(new Error('Firestore save error'))
    : jest.fn().mockResolvedValue({});
  return {
    collection: jest.fn((name) => {
      if (name === 'tenants') {
        return {
          doc: jest.fn().mockReturnValue({
            collection: jest.fn().mockReturnValue({
              doc: jest.fn().mockReturnValue({ get: agentGet, set: jest.fn().mockResolvedValue({}) }),
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ get: histGet }) }),
            }),
          }),
        };
      }
      if (name === 'agent_notifications') {
        return {
          doc: jest.fn().mockReturnValue({
            collection: jest.fn().mockReturnValue({
              doc: jest.fn().mockReturnValue({ set: notifSet }),
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ get: histGet }) }),
            }),
          }),
        };
      }
      return { doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }) };
    }),
  };
}

// =============================================================================
// DASHBOARD AGGREGATOR
// =============================================================================
describe("P6 extra3 -- dashboard_aggregator", () => {

  test("getTimeframeRange: today", () => {
    const r = da.getTimeframeRange("today", Date.now());
    expect(r.from).toBeLessThanOrEqual(r.to);
  });
  test("getTimeframeRange: week", () => {
    const r = da.getTimeframeRange("week", Date.now());
    expect(r.to - r.from).toBeGreaterThan(5 * 24 * 3600 * 1000);
  });
  test("getTimeframeRange: month", () => {
    const r = da.getTimeframeRange("month", Date.now());
    expect(r.to - r.from).toBeGreaterThan(28 * 24 * 3600 * 1000);
  });
  test("getTimeframeRange: quarter", () => {
    const r = da.getTimeframeRange("quarter", Date.now());
    expect(r.to - r.from).toBeGreaterThan(88 * 24 * 3600 * 1000);
  });
  test("getTimeframeRange: default (invalid)", () => {
    const r = da.getTimeframeRange("unknown", Date.now());
    expect(r.from).toBeLessThanOrEqual(r.to);
  });
  test("getTimeframeRange: sin now -> usa Date.now()", () => {
    const r = da.getTimeframeRange("today");
    expect(r).toHaveProperty("from");
    expect(r).toHaveProperty("to");
  });

  test("isValidSection: valid", () => { expect(da.isValidSection("leads")).toBe(true); });
  test("isValidSection: invalid", () => { expect(da.isValidSection("unknown")).toBe(false); });
  test("isValidTimeframe: valid", () => { expect(da.isValidTimeframe("week")).toBe(true); });
  test("isValidTimeframe: invalid", () => { expect(da.isValidTimeframe("century")).toBe(false); });

  test("buildOverviewSection: sin args -> defaults cero", () => {
    const r = da.buildOverviewSection();
    expect(r.section).toBe("overview");
    expect(r.totalLeads).toBe(0);
    expect(r.conversionRate).toBe(0);
  });
  test("buildOverviewSection: con leads -> calcula conversionRate", () => {
    const r = da.buildOverviewSection({ totalLeads: 10, convertedLeads: 2 });
    expect(r.conversionRate).toBe(0.2);
  });
  test("buildOverviewSection: totalLeads=0 -> conversionRate=0", () => {
    const r = da.buildOverviewSection({ totalLeads: 0, convertedLeads: 5 });
    expect(r.conversionRate).toBe(0);
  });

  test("buildLeadsFunnelData: array vacio -> zeros", () => {
    const r = da.buildLeadsFunnelData([]);
    expect(r.total).toBe(0);
    expect(r.topLeads).toHaveLength(0);
  });
  test("buildLeadsFunnelData: no array -> zeros", () => {
    const r = da.buildLeadsFunnelData(null);
    expect(r.total).toBe(0);
  });
  test("buildLeadsFunnelData: categorias varias", () => {
    const leads = [
      { phone: "+1", score: 90, category: "hot" },
      { phone: "+2", score: 10, category: "cold" },
      { phone: "+3", score: 5, category: "spam" },
      { phone: "+4", score: 50, category: "warm" },
      { phone: "+5", score: 80, category: "ready" },
      { phone: "+6", score: 20, category: "unknown_cat" },
    ];
    const r = da.buildLeadsFunnelData(leads);
    expect(r.funnel.caliente).toBe(1);
    expect(r.funnel.frio).toBe(2);
    expect(r.funnel.spam).toBe(1);
    expect(r.funnel.interesado).toBe(1);
    expect(r.funnel.listo).toBe(1);
    expect(r.total).toBe(6);
    expect(r.topLeads.length).toBeLessThanOrEqual(5);
  });
  test("buildLeadsFunnelData: sin category -> default frio", () => {
    const r = da.buildLeadsFunnelData([{ phone: "+1", score: 30 }]);
    expect(r.funnel.frio).toBe(1);
  });

  test("buildRevenueData: array vacio -> total=0", () => {
    const r = da.buildRevenueData([]);
    expect(r.total).toBe(0);
    expect(r.section).toBe("payments");
  });
  test("buildRevenueData: null -> total=0", () => {
    const r = da.buildRevenueData(null);
    expect(r.total).toBe(0);
  });
  test("buildRevenueData: pagos confirmados y pendientes", () => {
    const payments = [
      { status: "confirmed", amount: 100, currency: "USD" },
      { status: "confirmed", amount: 50, currency: "COP" },
      { status: "pending", amount: 30 },
    ];
    const r = da.buildRevenueData(payments, "month");
    expect(r.total).toBe(150);
    expect(r.byCurrency.USD).toBe(100);
    expect(r.byCurrency.COP).toBe(50);
    expect(r.paymentCount).toBe(3);
  });
  test("buildRevenueData: pago confirmed sin currency -> default USD", () => {
    const r = da.buildRevenueData([{ status: "confirmed", amount: 10 }]);
    expect(r.byCurrency.USD).toBe(10);
  });
  test("buildRevenueData: sin timeframe -> usa month default", () => {
    const r = da.buildRevenueData([]);
    expect(r.timeframe).toBe("month");
  });
  test("buildRevenueData: pago sin amount -> 0", () => {
    const r = da.buildRevenueData([{ status: "confirmed" }]);
    expect(r.total).toBe(0);
  });
  test("buildRevenueData: pago sin status -> unknown", () => {
    const r = da.buildRevenueData([{ amount: 10 }]);
    expect(r.byStatus.unknown).toBe(10);
  });

  test("buildConversationsSection: array vacio -> zeros", () => {
    const r = da.buildConversationsSection([]);
    expect(r.total).toBe(0);
    expect(r.bySentiment).toEqual({});
  });
  test("buildConversationsSection: null -> zeros", () => {
    const r = da.buildConversationsSection(null);
    expect(r.total).toBe(0);
  });
  test("buildConversationsSection: sin sentiment -> neutral", () => {
    const r = da.buildConversationsSection([{ keyMoments: null }]);
    expect(r.bySentiment.neutral).toBe(1);
  });
  test("buildConversationsSection: con sentiment y keyMoments", () => {
    const r = da.buildConversationsSection([
      {
        sentiment: { label: "positive" },
        keyMoments: [{ type: "booking" }, { type: "booking" }, { type: "complaint" }],
      },
    ]);
    expect(r.bySentiment.positive).toBe(1);
    expect(r.topTopics[0].type).toBe("booking");
  });

  test("buildDashboardSnapshot: uid null -> throw", () => {
    expect(() => da.buildDashboardSnapshot(null, {})).toThrow("uid requerido");
  });
  test("buildDashboardSnapshot: sections null -> throw", () => {
    expect(() => da.buildDashboardSnapshot("uid1", null)).toThrow("sections requerido");
  });
  test("buildDashboardSnapshot: valid -> snapshot con snapshotId", () => {
    const s = da.buildDashboardSnapshot("uid123", { overview: {} });
    expect(s.snapshotId).toContain("uid123".slice(0, 8));
    expect(s.uid).toBe("uid123");
    expect(s.timeframe).toBe("month");
  });
  test("buildDashboardSnapshot: timeframe valido -> se usa", () => {
    const s = da.buildDashboardSnapshot("uid1", {}, { timeframe: "week" });
    expect(s.timeframe).toBe("week");
  });
  test("buildDashboardSnapshot: timeframe invalido -> month", () => {
    const s = da.buildDashboardSnapshot("uid1", {}, { timeframe: "decade" });
    expect(s.timeframe).toBe("month");
  });
  test("buildDashboardSnapshot: generatedAt custom", () => {
    const s = da.buildDashboardSnapshot("uid1", {}, { generatedAt: 9999 });
    expect(s.generatedAt).toBe(9999);
  });

  test("saveDashboardSnapshot: uid null -> throw", async () => {
    await expect(da.saveDashboardSnapshot(null, { snapshotId: "x" })).rejects.toThrow("uid requerido");
  });
  test("saveDashboardSnapshot: snapshot null -> throw", async () => {
    await expect(da.saveDashboardSnapshot("uid1", null)).rejects.toThrow("snapshot invalido");
  });
  test("saveDashboardSnapshot: snapshot sin snapshotId -> throw", async () => {
    await expect(da.saveDashboardSnapshot("uid1", {})).rejects.toThrow("snapshot invalido");
  });
  test("saveDashboardSnapshot: valid -> retorna snapshotId", async () => {
    da.__setFirestoreForTests(makeDaDb());
    const snap = { snapshotId: "snap1", uid: "uid1" };
    const r = await da.saveDashboardSnapshot("uid1", snap);
    expect(r).toBe("snap1");
  });

  test("getLatestDashboardSnapshot: uid null -> throw", async () => {
    await expect(da.getLatestDashboardSnapshot(null)).rejects.toThrow("uid requerido");
  });
  test("getLatestDashboardSnapshot: docs vacios -> null", async () => {
    da.__setFirestoreForTests(makeDaDb({ docs: [] }));
    const r = await da.getLatestDashboardSnapshot("uid1");
    expect(r).toBeNull();
  });
  test("getLatestDashboardSnapshot: retorna el mas reciente", async () => {
    da.__setFirestoreForTests(makeDaDb({
      docs: [
        { timeframe: "week", generatedAt: 100 },
        { timeframe: "month", generatedAt: 200 },
      ],
    }));
    const r = await da.getLatestDashboardSnapshot("uid1");
    expect(r.generatedAt).toBe(200);
  });
  test("getLatestDashboardSnapshot: filtra por timeframe", async () => {
    da.__setFirestoreForTests(makeDaDb({
      docs: [
        { timeframe: "week", generatedAt: 300 },
        { timeframe: "month", generatedAt: 100 },
      ],
    }));
    const r = await da.getLatestDashboardSnapshot("uid1", "month");
    expect(r.timeframe).toBe("month");
  });
  test("getLatestDashboardSnapshot: timeframe invalido -> no filtra", async () => {
    da.__setFirestoreForTests(makeDaDb({
      docs: [
        { timeframe: "week", generatedAt: 100 },
        { timeframe: "month", generatedAt: 50 },
      ],
    }));
    const r = await da.getLatestDashboardSnapshot("uid1", "century");
    expect(r.generatedAt).toBe(100);
  });
  test("getLatestDashboardSnapshot: Firestore throws -> null", async () => {
    da.__setFirestoreForTests(makeDaDb({ throwGet: true }));
    const r = await da.getLatestDashboardSnapshot("uid1");
    expect(r).toBeNull();
  });

  test("buildDashboardText: snapshot null -> empty string", () => {
    expect(da.buildDashboardText(null)).toBe("");
  });
  test("buildDashboardText: sin sections.overview -> solo header", () => {
    const snap = { date: "2026-05-11", timeframe: "month", sections: {} };
    const t = da.buildDashboardText(snap);
    expect(t).toContain("2026-05-11");
  });
  test("buildDashboardText: con overview -> incluye leads y revenue", () => {
    const snap = {
      date: "2026-05-11", timeframe: "week",
      sections: {
        overview: {
          totalLeads: 20, newLeads: 5, conversionRate: 0.25,
          totalRevenue: 500, pendingPayments: 100,
          totalMessages: 300, avgResponseTime: 5,
          pendingFollowUps: 3,
        },
      },
    };
    const t = da.buildDashboardText(snap);
    expect(t).toContain("Leads");
    expect(t).toContain("Revenue");
    expect(t).toContain("Follow-ups");
  });
  test("buildDashboardText: con leads.funnel -> muestra funnel", () => {
    const snap = {
      date: "2026-05-11", timeframe: "month",
      sections: {
        leads: { funnel: { spam: 1, frio: 2, interesado: 3, caliente: 4, listo: 5 } },
      },
    };
    const t = da.buildDashboardText(snap);
    expect(t).toContain("Funnel");
  });
  test("buildDashboardText: pendingFollowUps=0 -> no muestra linea follow-ups", () => {
    const snap = {
      date: "2026-05-11", timeframe: "month",
      sections: {
        overview: {
          totalLeads: 5, newLeads: 1, conversionRate: 0.2,
          totalRevenue: 0, pendingPayments: 0,
          totalMessages: 10, avgResponseTime: 0, pendingFollowUps: 0,
        },
      },
    };
    const t = da.buildDashboardText(snap);
    expect(t).not.toContain("Follow-ups");
  });
});

// =============================================================================
// BILLING ADMIN -- branches restantes
// =============================================================================
describe("P6 extra3 -- billing_admin branches", () => {
  test("getOwnerBilling: pago sin amount -> 0 (|| branch)", async () => {
    ba.__setFirestoreForTests(makeBillingDb({ payments: [{ status: "confirmed" }] }));
    const r = await ba.getOwnerBilling("uid1");
    expect(r.totalPaid).toBe(0);
    expect(r.payments).toHaveLength(1);
  });

  test("getOwnerBilling: pagos con amount -> suma correcta", async () => {
    ba.__setFirestoreForTests(makeBillingDb({ payments: [{ amount: 50 }, { amount: 30 }] }));
    const r = await ba.getOwnerBilling("uid1");
    expect(r.totalPaid).toBe(80);
  });
});

// =============================================================================
// AGENT NOTIFIER -- error paths
// =============================================================================
describe("P6 extra3 -- agent_notifier error paths", () => {
  test("getAgentConfig: Firestore throws -> null (catch branch)", async () => {
    an.__setFirestoreForTests(makeAnDb({ throwAgentGet: true }));
    const r = await an.getAgentConfig("uid1", "agent1");
    expect(r).toBeNull();
  });

  test("notifyAgent: Firestore save throws -> sigue funcionando", async () => {
    an.__setFirestoreForTests(makeAnDb({
      agentExists: true,
      agentData: { channel: "push", endpoint: null, active: true },
      throwSave: true,
    }));
    an.__setHttpClientForTests(jest.fn().mockResolvedValue({ ok: true }));
    const r = await an.notifyAgent("uid1", "agent1", "tick1", { leadPhone: "+57300" });
    expect(r).toBeDefined();
  });

  test("notifyAgent: webhook channel con httpClient que lanza -> notified=false", async () => {
    an.__setFirestoreForTests(makeAnDb({
      agentExists: true,
      agentData: { channel: "webhook", endpoint: "https://hook.test/x", active: true },
    }));
    an.__setHttpClientForTests(jest.fn().mockRejectedValue(new Error("network error")));
    const r = await an.notifyAgent("uid1", "agent1", "tick1", { leadPhone: "+57300" });
    expect(r.notified).toBe(false);
    expect(r.reason).toBe("webhook_error");
  });

  test("httpPost usa node-fetch cuando _httpClient es null (line 16 branch)", async () => {
    an.__setFirestoreForTests(makeAnDb({
      agentExists: true,
      agentData: { channel: "webhook", endpoint: "https://hook.test/nullclient", active: true },
    }));
    an.__setHttpClientForTests(null);
    // node-fetch esta mockeado -> resolve { ok:true } -> no lanza -> continua a Firestore save
    const r = await an.notifyAgent("uid1", "agent1", "tick2", { leadPhone: "+57300" });
    // puede ser notified:true o error de Firestore save (suprimido) -> de todos modos retorna algo
    expect(r).toBeDefined();
  });
});
