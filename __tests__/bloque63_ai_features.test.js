"use strict";

const we = require("../core/workflow_engine");
const dc = require("../core/drip_campaign");
const ls = require("../core/lead_scoring");
const sa = require("../core/sentiment_analyzer");
const cp = require("../core/churn_prediction");
const ra = require("../core/revenue_analytics");
const ca = require("../core/cohort_analysis");
const cvp = require("../core/conversion_predictor");

const { TRIGGER_TYPES, ACTION_TYPES } = we;
const { SCORE_FACTORS, INTENT_KEYWORDS, computeLeadScore } = ls;
const { SENTIMENTS, analyzeSentiment } = sa;
const { CHURN_RISK_LEVELS, computeChurnRisk } = cp;
const { CONVERSION_SIGNALS, predictConversion } = cvp;

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: (data && data.id) || "doc1", ref: { update: async () => {} } };
}
function makeCol(docs) {
  const arr = (docs || []).map(d => makeDoc(d));
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
  return {
    doc: (id) => ({
      get: async () => makeDoc((docs || []).find(d => d && d.id === id) || null),
      set: async () => {},
      update: async () => {},
      collection: (name) => makeCol([]),
    }),
    where: () => q,
    orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  we.__setFirestoreForTests(_db);
  dc.__setFirestoreForTests(_db);
  ls.__setFirestoreForTests(_db);
  sa.__setFirestoreForTests(_db);
  cp.__setFirestoreForTests(_db);
  ra.__setFirestoreForTests(_db);
  ca.__setFirestoreForTests(_db);
  cvp.__setFirestoreForTests(_db);
});

describe("Workflow Engine", () => {
  test("WE-1: TRIGGER_TYPES and ACTION_TYPES frozen", () => {
    expect(Object.isFrozen(TRIGGER_TYPES)).toBe(true);
    expect(Object.isFrozen(ACTION_TYPES)).toBe(true);
    expect(TRIGGER_TYPES).toContain("lead_no_response_48h");
    expect(ACTION_TYPES).toContain("send_message");
  });

  test("WE-2: createWorkflow creates active workflow", async () => {
    const wf = await we.createWorkflow("uid1", {
      name: "48h follow-up",
      trigger: "lead_no_response_48h",
      action: { type: "send_message", message: "Hola, te cuento algo" },
    });
    expect(wf.id).toBeDefined();
    expect(wf.active).toBe(true);
    expect(wf.delayHours).toBe(48);
  });

  test("WE-3: createWorkflow throws on invalid trigger", async () => {
    await expect(we.createWorkflow("uid1", { name: "T", trigger: "fake_trigger", action: { type: "send_message" } })).rejects.toThrow("invalid trigger");
  });
});

describe("Drip Campaign", () => {
  test("DC-1: createCampaign validates steps", async () => {
    await expect(dc.createCampaign("uid1", { name: "C", steps: [] })).rejects.toThrow("steps required");
  });

  test("DC-2: createCampaign creates campaign with steps", async () => {
    const c = await dc.createCampaign("uid1", {
      name: "Bienvenida",
      steps: [{ message: "Hola", delayDays: 0 }, { message: "Seguimiento", delayDays: 3 }],
    });
    expect(c.id).toBeDefined();
    expect(c.steps).toHaveLength(2);
  });

  test("DC-3: optOut marks enrollment as opted out", async () => {
    const result = await dc.optOut("campaign-1", "5491100000000");
    expect(result.optedOut).toBe(true);
  });
});

describe("Lead Scoring", () => {
  test("LS-1: SCORE_FACTORS frozen and sum to 1.0", () => {
    expect(Object.isFrozen(SCORE_FACTORS)).toBe(true);
    const total = Object.values(SCORE_FACTORS).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.01);
  });

  test("LS-2: computeLeadScore returns 0 for empty messages", () => {
    const r = computeLeadScore([]);
    expect(r.score).toBe(0);
  });

  test("LS-3: computeLeadScore higher score with intent keywords", () => {
    const msgs = [
      { role: "lead", content: "cuanto cuesta el plan?" },
      { role: "lead", content: "quiero comprar ya" },
      { role: "miia", content: "hola! el plan es..." },
    ];
    const r = computeLeadScore(msgs);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.breakdown.intentKeywords).toBeGreaterThan(0);
  });
});

describe("Sentiment Analyzer", () => {
  test("SA-1: SENTIMENTS frozen with 4 values", () => {
    expect(Object.isFrozen(SENTIMENTS)).toBe(true);
    expect(SENTIMENTS).toContain("positive");
    expect(SENTIMENTS).toContain("negative");
    expect(SENTIMENTS).toContain("urgent");
  });

  test("SA-2: analyzeSentiment detects positive", () => {
    const r = analyzeSentiment("muchas gracias, excelente servicio");
    expect(r.sentiment).toBe("positive");
    expect(r.signals.length).toBeGreaterThan(0);
  });

  test("SA-3: analyzeSentiment detects negative", () => {
    const r = analyzeSentiment("tengo una queja, muy mal servicio");
    expect(r.sentiment).toBe("negative");
  });

  test("SA-4: analyzeSentiment detects urgent", () => {
    const r = analyzeSentiment("es urgente, necesito respuesta ahora");
    expect(r.sentiment).toBe("urgent");
  });
});

describe("Churn Prediction", () => {
  test("CP-1: CHURN_RISK_LEVELS frozen", () => {
    expect(Object.isFrozen(CHURN_RISK_LEVELS)).toBe(true);
    expect(CHURN_RISK_LEVELS.HIGH).toBe("high");
    expect(CHURN_RISK_LEVELS.LOW).toBe("low");
  });

  test("CP-2: computeChurnRisk high for 30+ days inactive", () => {
    const lastContact = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const r = computeChurnRisk(lastContact, 1, 0);
    expect(r.level).toBe("high");
    expect(r.daysSinceContact).toBeGreaterThan(30);
  });

  test("CP-3: computeChurnRisk low for recent active lead", () => {
    const r = computeChurnRisk(Date.now() - 2 * 24 * 60 * 60 * 1000, 10, 1000);
    expect(r.level).toBe("low");
  });
});

describe("Revenue Analytics", () => {
  test("RA-1: getRevenueSummary returns required fields", async () => {
    const summary = await ra.getRevenueSummary("uid1");
    expect(summary).toHaveProperty("mrr");
    expect(summary).toHaveProperty("arr");
    expect(summary).toHaveProperty("churnRate");
    expect(summary).toHaveProperty("ltv");
  });

  test("RA-2: ARR equals MRR * 12", async () => {
    const summary = await ra.getRevenueSummary("uid1");
    expect(summary.arr).toBeCloseTo(summary.mrr * 12, 1);
  });
});

describe("Cohort Analysis", () => {
  test("CA-1: buildCohorts returns cohorts array", async () => {
    const result = await ca.buildCohorts("uid1");
    expect(result).toHaveProperty("cohorts");
    expect(Array.isArray(result.cohorts)).toBe(true);
  });

  test("CA-2: getMonthKey formats correctly", () => {
    const ts = new Date(2026, 4, 15).getTime();
    const key = ca.getMonthKey(ts);
    expect(key).toBe("2026-05");
  });
});

describe("Conversion Predictor", () => {
  test("CV-1: CONVERSION_SIGNALS frozen", () => {
    expect(Object.isFrozen(CONVERSION_SIGNALS)).toBe(true);
    expect(CONVERSION_SIGNALS).toContain("precio");
    expect(CONVERSION_SIGNALS).toContain("comprar");
  });

  test("CV-2: predictConversion 0 for empty messages", () => {
    const r = predictConversion([]);
    expect(r.probability).toBe(0);
    expect(r.level).toBe("low");
  });

  test("CV-3: predictConversion high for strong signals", () => {
    const msgs = [
      { role: "lead", content: "quiero comprar ya, cuando empezamos" },
      { role: "lead", content: "me interesa el precio" },
    ];
    const r = predictConversion(msgs);
    expect(r.probability).toBeGreaterThan(40);
    expect(r.factors.length).toBeGreaterThan(0);
  });
});
