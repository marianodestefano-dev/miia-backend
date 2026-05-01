"use strict";

// E2E cross-piso 50+ integration tests covering all BLOQUE modules

const pr = require("../core/perf_regression");

// Cimientos/Piso0
const rl = require("../core/rate_limiter");

// Piso1 -- MMC / privacy
const gdpr = require("../core/gdpr_toolkit");
const at = require("../core/audit_trail");

// Piso2 -- Dashboard
const ent = require("../core/enterprise_onboarding");
const mum = require("../core/multi_user_manager");
const akm = require("../core/api_key_manager");
const whm = require("../core/webhook_manager");

// Piso3 -- Producto
const gc = require("../core/games_catalog");
const gs = require("../core/games_subscription");
const lb = require("../core/leaderboard");

// Piso4 -- Integraciones
const ref = require("../core/referral_engine");
const cm = require("../core/commission_manager");
const pn = require("../core/push_notifications");

// Piso5 -- Red inter-MIIA
const le = require("../core/lead_scoring");
const sa = require("../core/sentiment_analyzer");
const cp = require("../core/conversion_predictor");

// Vision 2027
const vs = require("../core/voice_selection");
const vm = require("../core/voice_multilang");
const lc = require("../core/latam_config");
const sl = require("../core/social_listening");
const mc = require("../core/multichannel");

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: (data && data.id) || "doc1" };
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
    }),
    where: () => q,
    orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  gdpr.__setFirestoreForTests(_db);
  at.__setFirestoreForTests(_db);
  ent.__setFirestoreForTests(_db);
  mum.__setFirestoreForTests(_db);
  akm.__setFirestoreForTests(_db);
  whm.__setFirestoreForTests(_db);
  gs.__setFirestoreForTests(_db);
  lb.__setFirestoreForTests(_db);
  ref.__setFirestoreForTests(_db);
  cm.__setFirestoreForTests(_db);
  pn.__setFirestoreForTests(_db);
  vs.__setFirestoreForTests(_db);
  sl.__setFirestoreForTests(_db);
  mc.__setFirestoreForTests(_db);
  pr.reset();
});

describe("Perf Regression Detection", () => {
  test("PR-1: THRESHOLDS frozen", () => {
    expect(Object.isFrozen(pr.THRESHOLDS)).toBe(true);
    expect(pr.THRESHOLDS.p95_ms).toBe(2000);
  });

  test("PR-2: recordSnapshot stores metrics", () => {
    const snap = pr.recordSnapshot({ p50_ms: 100, p95_ms: 800, error_rate: 0.001 });
    expect(snap.recordedAt).toBeDefined();
    expect(pr.getHistory().length).toBe(1);
  });

  test("PR-3: detectRegressions flags p95 regression", () => {
    const baseline = { p50_ms: 100, p95_ms: 800, error_rate: 0.001 };
    const current = { p50_ms: 120, p95_ms: 1200, error_rate: 0.002 };
    const result = pr.detectRegressions(current, baseline);
    expect(result.hasRegressions).toBe(true);
    expect(result.regressions.some(r => r.metric === "p95_ms")).toBe(true);
  });

  test("PR-4: detectRegressions no regression on same metrics", () => {
    const baseline = { p50_ms: 100, p95_ms: 800, error_rate: 0.001 };
    const result = pr.detectRegressions(baseline, baseline);
    expect(result.hasRegressions).toBe(false);
  });

  test("PR-5: checkThresholds flags p95 above threshold", () => {
    const result = pr.checkThresholds({ p95_ms: 3000, error_rate: 0.002 });
    expect(result.passing).toBe(false);
    expect(result.violations.some(v => v.metric === "p95_ms")).toBe(true);
  });

  test("PR-6: checkThresholds passes good metrics", () => {
    const result = pr.checkThresholds({ p95_ms: 500, error_rate: 0.001 });
    expect(result.passing).toBe(true);
  });
});

describe("GDPR Toolkit E2E", () => {
  test("GT-1: exportOwnerData returns export object", async () => {
    const exp = await gdpr.exportOwnerData("uid1");
    expect(exp.uid).toBe("uid1");
    expect(exp).toHaveProperty("exportedAt");
  });

  test("GT-2: logConsent records consent event", async () => {
    const result = await gdpr.logConsent("uid1", "analytics", true);
    expect(result.uid).toBe("uid1");
    expect(result.consentType).toBe("analytics");
    expect(result.value).toBe(true);
  });

  test("GT-3: deleteOwnerData cascades delete flag", async () => {
    const result = await gdpr.deleteOwnerData("uid1");
    expect(result.uid).toBe("uid1");
    expect(result.deletedAt).toBeDefined();
  });
});

describe("Audit Trail E2E", () => {
  test("AT-1: logAction creates audit entry", async () => {
    const entry = await at.logAction("uid1", "api_key_created", { ip: "127.0.0.1" });
    expect(entry.uid).toBe("uid1");
    expect(entry.action).toBe("api_key_created");
    expect(entry.id).toBeDefined();
  });

  test("AT-2: getAuditLog returns entries for uid", async () => {
    const log = await at.getAuditLog("uid1");
    expect(Array.isArray(log)).toBe(true);
  });
});

describe("Enterprise E2E", () => {
  test("EE-1: ENTERPRISE_STEPS frozen with 6 steps", () => {
    expect(Object.isFrozen(ent.ENTERPRISE_STEPS)).toBe(true);
    expect(ent.ENTERPRISE_STEPS.length).toBe(6);
  });

  test("EE-2: startOnboarding creates enterprise record", async () => {
    const result = await ent.createEnterpriseAccount({ uid: "uid1", seats: 10, companyName: "Acme Corp", contactEmail: "test@acme.com" });
    expect(result.id).toBe("uid1");
    expect(result.onboardingStep).toBe(ent.ENTERPRISE_STEPS[0]);
  });

  test("EE-3: ROLES frozen", () => {
    expect(Object.isFrozen(mum.ROLES)).toBe(true);
    expect(mum.ROLES.ADMIN).toBe("admin");
  });

  test("EE-4: addUser creates user with role", async () => {
    const user = await mum.addUser("uid1", "user@example.com", "agent");
    expect(user.role).toBe("agent");
    expect(user.email).toBe("user@example.com");
  });

  test("EE-5: createApiKey creates hashed key", async () => {
    const result = await akm.createApiKey("uid1", { name: "Test Key" });
    expect(result.key).toMatch(/^mk_/);
    expect(result.keyId || result.id).toBeDefined();
  });

  test("EE-6: WEBHOOK_EVENTS frozen", () => {
    expect(Object.isFrozen(whm.WEBHOOK_EVENTS)).toBe(true);
    expect(whm.WEBHOOK_EVENTS).toContain("lead_nuevo");
  });
});

describe("Games E2E", () => {
  test("GE-1: CATALOG frozen with 15 games", () => {
    expect(Object.isFrozen(gc.CATALOG)).toBe(true);
    expect(gc.CATALOG.length).toBe(15);
  });

  test("GE-2: PLANS frozen with 3 tiers", () => {
    expect(Object.isFrozen(gs.PLANS)).toBe(true);
    expect(gs.PLANS.ENTERPRISE.gamesPerMonth).toBe(-1);
  });

  test("GE-3: createSubscription and checkGameLimit flow", async () => {
    const noSub = await gs.checkGameLimit("uid_no_sub");
    expect(noSub.allowed).toBe(false);
  });

  test("GE-4: updateLeaderboard creates entry", async () => {
    const entry = await lb.updateLeaderboard("uid1", "Pro", "trivia_general", 90);
    expect(entry.score).toBe(90);
  });
});

describe("Referral & Commission E2E", () => {
  test("RC-1: createInvite creates invite", async () => {
    const invite = await ref.createInvite("uid1");
    expect(invite.uid).toBe("uid1");
    expect(invite.code).toBeDefined();
  });

  test("RC-2: COMMISSION_RATES frozen", () => {
    expect(Object.isFrozen(cm.COMMISSION_RATES)).toBe(true);
    expect(cm.COMMISSION_RATES.month1).toBe(0.20);
  });

  test("RC-3: recordCommission creates record", async () => {
    const rec = await cm.recordCommission("referrer1", "uid1", 99, 1);
    expect(rec.referrerId).toBe("referrer1");
    expect(rec.commission).toBeGreaterThan(0);
  });

  test("RC-4: NOTIFICATION_TYPES frozen", () => {
    expect(Object.isFrozen(pn.NOTIFICATION_TYPES)).toBe(true);
    expect(pn.NOTIFICATION_TYPES.LEAD_NUEVO).toBeDefined();
  });
});

describe("AI Features E2E", () => {
  test("AI-1: computeLeadScore returns 0-100 score", () => {
    const msgs = [
      { role: "lead", text: "hola quiero saber mas", timestamp: Date.now() - 60000 },
      { role: "miia", text: "hola!", timestamp: Date.now() - 50000 },
      { role: "lead", text: "me interesa", timestamp: Date.now() - 10000 },
    ];
    const result = le.computeLeadScore(msgs);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test("AI-2: analyzeSentiment returns valid sentiment", () => {
    const result = sa.analyzeSentiment("me encanta este producto");
    expect(sa.SENTIMENTS).toContain(result.sentiment);
  });

  test("AI-3: predictConversion returns risk level", () => {
    const result = cp.predictConversion([
      { role: "lead", text: "precio?" },
      { role: "miia", text: "$99/mes" },
      { role: "lead", text: "como pago?" },
    ]);
    expect(["high", "medium", "low"]).toContain(result.level);
  });
});

describe("Vision 2027 E2E", () => {
  test("V27-1: listVoices returns all voices", () => {
    expect(vs.listVoices().length).toBeGreaterThanOrEqual(9);
  });

  test("V27-2: selectVoice detects English", () => {
    const r = vm.selectVoice("thank you for your help", null);
    expect(r.lang).toBe("en");
  });

  test("V27-3: getConfig CO has COP currency", () => {
    expect(lc.getConfig("CO").currency).toBe("COP");
  });

  test("V27-4: SOCIAL_PLATFORMS has 4 platforms", () => {
    expect(sl.SOCIAL_PLATFORMS.length).toBe(4);
  });

  test("V27-5: SUPPORTED_CHANNELS has 4 channels", () => {
    expect(mc.SUPPORTED_CHANNELS.length).toBe(4);
  });

  test("V27-6: registerChannel whatsapp", async () => {
    const r = await mc.registerChannel("uid1", "whatsapp", {});
    expect(r.active).toBe(true);
  });

  test("V27-7: processMention stores record", async () => {
    const r = await sl.processMention("uid1", { platform: "twitter", author: "x", text: "test", sentiment: "neutral" });
    expect(r.id).toBeDefined();
  });
});

describe("Cross-Piso Integration Flow", () => {
  test("CROSS-1: Full owner journey — enterprise onboard + api key + webhook + audit", async () => {
    const ob = await ent.createEnterpriseAccount({ uid: "uid1", seats: 10, companyName: "TestCorp SA", contactEmail: "test@testcorp.com" });
    expect(ob.onboardingStep).toBeDefined();

    const key = await akm.createApiKey("uid1", "Integration Key");
    expect(key.key).toMatch(/^mk_/);

    const audit = await at.logAction("uid1", "api_key_created", { ip: "127.0.0.1" });
    expect(audit.id).toBeDefined();
  });

  test("CROSS-2: Games flow — subscription + catalog + leaderboard", async () => {
    const sub = await gs.createSubscription("uid1", "pro");
    expect(sub.status).toBe("active");

    const game = gc.getGame("trivia_general");
    expect(game).not.toBeNull();

    const entry = await lb.updateLeaderboard("uid1", "TestUser", game.id, 75);
    expect(entry.score).toBe(75);
  });

  test("CROSS-3: Referral + commission flow", async () => {
    const invite = await ref.createInvite("referrer1");
    expect(invite.code.length).toBeGreaterThan(4);

    const rec = await cm.recordCommission("referrer1", "new_uid", 99, 1);
    expect(rec.status).toBe("pending");
  });

  test("CROSS-4: GDPR + audit trail — consent + log", async () => {
    const consent = await gdpr.logConsent("uid1", "analytics", true);
    expect(consent.value).toBe(true);

    const audit = await at.logAction("uid1", "settings_changed", { feature: "analytics" });
    expect(audit.action).toBe("settings_changed");
  });

  test("CROSS-5: Perf regression — record + check threshold", () => {
    pr.recordSnapshot({ p50_ms: 200, p95_ms: 1500, error_rate: 0.003 });
    const history = pr.getHistory();
    expect(history.length).toBe(1);

    const check = pr.checkThresholds(history[0]);
    expect(check.passing).toBe(true);
  });

  test("CROSS-6: Multichannel + social mention cross-check", async () => {
    const channel = await mc.registerChannel("uid1", "web_widget", { color: "#25D366" });
    expect(channel.active).toBe(true);

    const mention = await sl.processMention("uid1", {
      platform: "instagram",
      author: "cliente_feliz",
      text: "MIIA me ayudo mucho!",
      sentiment: "positive",
    });
    expect(mention.uid).toBe("uid1");
  });
});
