"use strict";

const { recordRequest, getMetrics, formatPrometheus, reset } = require("../core/prometheus_metrics");
const { detectUpsellOpportunity, buildUpsellPrompt } = require("../core/product_upsell");
const { BOOKING_STATUSES } = require("../core/booking_manager");
const { STEPS } = require("../core/owner_onboarding");
const { buildTTSRequest, cacheKey } = require("../core/audio_response");
const { FLAGS, scoreConversation, detectEscalation } = require("../core/conversation_quality");
const { renderTemplate, validateTemplate } = require("../core/message_templates");
const { generatePaymentLink, __setFirestoreForTests: setPLDb } = require("../core/payment_link_manager");
const { buildDailySummary, __setFirestoreForTests: setSNDb } = require("../core/smart_notification");
const { getMessageStats, __setFirestoreForTests: setTADb } = require("../core/tenant_analytics");

function makeDoc(data) {
  return { exists: true, data: () => data, id: data.id || "doc1" };
}
function makeCol(docs) {
  const arr = docs.map(d => makeDoc(d));
  const q = {
    where: () => q,
    orderBy: () => q,
    startAfter: () => q,
    limit: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0 }),
  };
  return {
    doc: (id) => ({
      get: async () => makeDoc((docs || []).find(d => d.id === id) || { id }),
      set: async () => {},
      update: async () => {},
      collection: () => makeCol([]),
    }),
    where: () => q,
    orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0 }),
    add: async (d) => ({ id: "new-id", ...d }),
  };
}

let _db;
beforeEach(() => {
  reset();
  _db = { collection: () => makeCol([]) };
  setPLDb(_db);
  setSNDb(_db);
  setTADb(_db);
});

describe("Prometheus Metrics", () => {
  test("PM-1: recordRequest increments counter", () => {
    recordRequest(100, 200);
    recordRequest(200, 404);
    expect(getMetrics().requests_total).toBe(2);
  });

  test("PM-2: error rate counts 5xx", () => {
    recordRequest(100, 200);
    recordRequest(100, 500);
    recordRequest(100, 503);
    expect(getMetrics().errors_total).toBe(2);
  });

  test("PM-3: p50 and p95 computed from samples", () => {
    [50,100,150,200,250,300,350,400,450,500].forEach(ms => recordRequest(ms, 200));
    const m = getMetrics();
    expect(m.p50_ms).toBeGreaterThan(0);
    expect(m.p95_ms).toBeGreaterThanOrEqual(m.p50_ms);
  });

  test("PM-4: formatPrometheus returns counter and type lines", () => {
    recordRequest(100, 200);
    const text = formatPrometheus();
    expect(text).toContain("miia_requests_total");
    expect(text).toContain("# TYPE");
  });

  test("PM-5: formatPrometheus includes quantile labels", () => {
    recordRequest(500, 200);
    const text = formatPrometheus();
    expect(text).toContain("quantile=");
    expect(text).toContain("0.95");
  });

  test("PM-6: reset clears counters", () => {
    recordRequest(100, 200);
    reset();
    const m = getMetrics();
    expect(m.requests_total).toBe(0);
    expect(m.errors_total).toBe(0);
  });
});

describe("Product Upsell", () => {
  test("UP-1: detectUpsellOpportunity triggers on signal", () => {
    const catalog = [{ id: "p1", name: "Plan Premium", active: true }];
    const r = detectUpsellOpportunity("quiero mas informacion", catalog);
    expect(r.triggered).toBe(true);
    expect(r.suggestedProducts.length).toBeGreaterThan(0);
  });

  test("UP-2: no trigger on unrelated message", () => {
    const catalog = [{ id: "p1", name: "Plan", active: true }];
    const r = detectUpsellOpportunity("gracias hasta luego", catalog);
    expect(r.triggered).toBe(false);
  });

  test("UP-3: buildUpsellPrompt returns text with products", () => {
    const products = [{ name: "Plan A" }, { name: "Plan B" }];
    const text = buildUpsellPrompt(products);
    expect(text).toContain("Plan A");
    expect(text).toContain("Plan B");
  });
});

describe("Booking Manager", () => {
  test("BK-1: BOOKING_STATUSES frozen with correct values", () => {
    expect(Object.isFrozen(BOOKING_STATUSES)).toBe(true);
    expect(BOOKING_STATUSES.PENDING).toBe("pending");
    expect(BOOKING_STATUSES.CONFIRMED).toBe("confirmed");
    expect(BOOKING_STATUSES.CANCELLED).toBe("cancelled");
  });
});

describe("Owner Onboarding", () => {
  test("OO-1: STEPS frozen with 5 items in correct order", () => {
    expect(Object.isFrozen(STEPS)).toBe(true);
    expect(STEPS).toHaveLength(5);
    expect(STEPS[0]).toBe("phone_verify");
    expect(STEPS[4]).toBe("test_message");
  });
});

describe("Audio Response", () => {
  test("AR-1: buildTTSRequest returns url, body, headers", () => {
    const req = buildTTSRequest("hola mundo", "voice123");
    expect(req.url).toContain("voice123");
    const body = JSON.parse(req.body);
    expect(body.text).toBe("hola mundo");
    expect(body.model_id).toBeDefined();
    expect(body.voice_settings).toBeDefined();
  });

  test("AR-2: cacheKey is deterministic SHA256", () => {
    const k1 = cacheKey("hello", "v1");
    const k2 = cacheKey("hello", "v1");
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(64);
  });

  test("AR-3: cacheKey differs for different inputs", () => {
    expect(cacheKey("a", "v1")).not.toBe(cacheKey("b", "v1"));
    expect(cacheKey("a", "v1")).not.toBe(cacheKey("a", "v2"));
  });
});

describe("Conversation Quality", () => {
  test("CQ-1: FLAGS frozen with required keys", () => {
    expect(Object.isFrozen(FLAGS)).toBe(true);
    expect(FLAGS.ESCALATION_DETECTED).toBe("ESCALATION_DETECTED");
    expect(FLAGS.RESPONSE_TOO_SHORT).toBe("RESPONSE_TOO_SHORT");
  });

  test("CQ-2: scoreConversation returns score 0-100", () => {
    const msgs = [
      { role: "lead", content: "hola" },
      { role: "miia", content: "hola! como puedo ayudarte hoy con tu consulta?" },
    ];
    const r = scoreConversation(msgs);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(r.flags)).toBe(true);
  });

  test("CQ-3: detectEscalation finds lead asking for human", () => {
    const msgs = [{ role: "lead", content: "necesito hablar con una persona" }];
    expect(detectEscalation(msgs)).toBe(true);
  });
});

describe("Message Templates", () => {
  test("MT-1: renderTemplate replaces variables", () => {
    const tpl = { content: "Hola {nombre}, tu cita es el {fecha}" };
    const out = renderTemplate(tpl, { nombre: "Ana", fecha: "lunes" });
    expect(out).toBe("Hola Ana, tu cita es el lunes");
  });

  test("MT-2: validateTemplate detects unbalanced braces", () => {
    expect(validateTemplate("Hola {nombre}").valid).toBe(true);
    expect(validateTemplate("Hola {nombre").valid).toBe(false);
  });
});

describe("Payment Link Manager", () => {
  test("PL-1: generatePaymentLink returns link with id and status pending", async () => {
    const link = await generatePaymentLink("uid1", {
      amount: 100, currency: "ARS", description: "Test", phone: "5491100000000"
    });
    expect(link.id).toBeDefined();
    expect(link.amount).toBe(100);
    expect(link.status).toBe("pending");
  });
});

describe("Smart Notification", () => {
  test("SN-1: buildDailySummary returns structured object", async () => {
    const summary = await buildDailySummary("uid1");
    expect(summary).toHaveProperty("date");
    expect(summary).toHaveProperty("sent");
    expect(summary).toHaveProperty("received");
  });
});

describe("Tenant Analytics", () => {
  test("TA-1: getMessageStats returns required fields", async () => {
    const stats = await getMessageStats("uid1", { days: 7 });
    expect(stats).toHaveProperty("total");
    expect(stats).toHaveProperty("sent");
    expect(stats).toHaveProperty("received");
  });
});
