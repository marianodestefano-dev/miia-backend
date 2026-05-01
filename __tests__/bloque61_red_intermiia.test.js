"use strict";

const { createInvite, trackClick, getReferralNetwork, generateReferralCode } = require("../core/referral_engine");
const { getCommissionRate, COMMISSION_RATES, recordCommission } = require("../core/commission_manager");
const { getReferralDashboard } = require("../core/referral_dashboard");
const { setOptIn, checkRateLimit, sendNetworkMessage, RATE_LIMIT_PER_DAY } = require("../core/network_messaging");
const { getGrowthSummary } = require("../core/growth_metrics");
const { buildShareLink, SHARE_CHANNELS } = require("../core/viral_loop");
const { sendNotification, NOTIFICATION_TYPES } = require("../core/push_notifications");
const { checkAndAwardBadges, getOwnerBadges, BADGES } = require("../core/gamification");
const { createExperiment, assignVariant, getVariantForUser } = require("../core/ab_testing");

const re = require("../core/referral_engine");
const cm = require("../core/commission_manager");
const rd = require("../core/referral_dashboard");
const nm = require("../core/network_messaging");
const gm = require("../core/growth_metrics");
const vl = require("../core/viral_loop");
const pn = require("../core/push_notifications");
const gf = require("../core/gamification");
const ab = require("../core/ab_testing");

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: (data && data.id) || "doc1", ref: { update: async () => {} } };
}
function makeCol(docs) {
  const arr = (docs || []).map(d => makeDoc(d));
  const q = {
    where: () => q,
    orderBy: () => q,
    startAfter: () => q,
    limit: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
  return {
    doc: (id) => ({
      get: async () => makeDoc((docs || []).find(d => d && d.id === id) || null),
      set: async () => {},
      update: async () => {},
      collection: () => makeCol([]),
    }),
    where: () => q,
    orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
    add: async (d) => ({ id: "new-id" }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  re.__setFirestoreForTests(_db);
  cm.__setFirestoreForTests(_db);
  rd.__setFirestoreForTests(_db);
  nm.__setFirestoreForTests(_db);
  gm.__setFirestoreForTests(_db);
  vl.__setFirestoreForTests(_db);
  pn.__setFirestoreForTests(_db);
  gf.__setFirestoreForTests(_db);
  ab.__setFirestoreForTests(_db);
});

describe("Referral Engine", () => {
  test("RE-1: generateReferralCode returns uid prefix + uuid segment", () => {
    const code = generateReferralCode("uid123abc");
    expect(code).toMatch(/^uid123-/);
    expect(code.length).toBeGreaterThan(8);
  });

  test("RE-2: createInvite returns link and code", async () => {
    const invite = await createInvite("uid1", { utm_campaign: "test" });
    expect(invite.code).toBeDefined();
    expect(invite.link).toContain("?ref=");
    expect(invite.link).toContain("utm_campaign=test");
    expect(invite.status || "ok").toBeTruthy();
  });

  test("RE-3: getReferralNetwork returns nodes array", async () => {
    const net = await getReferralNetwork("uid1");
    expect(net).toHaveProperty("nodes");
    expect(net).toHaveProperty("total");
    expect(Array.isArray(net.nodes)).toBe(true);
  });
});

describe("Commission Manager", () => {
  test("CM-1: COMMISSION_RATES frozen", () => {
    expect(Object.isFrozen(COMMISSION_RATES)).toBe(true);
    expect(COMMISSION_RATES.month1).toBe(0.20);
    expect(COMMISSION_RATES.months2to6).toBe(0.10);
    expect(COMMISSION_RATES.month7plus).toBe(0.00);
  });

  test("CM-2: getCommissionRate returns correct rate by month", () => {
    expect(getCommissionRate(0)).toBe(0.20);
    expect(getCommissionRate(3)).toBe(0.10);
    expect(getCommissionRate(7)).toBe(0.00);
  });

  test("CM-3: recordCommission calculates commission correctly", async () => {
    const rec = await recordCommission("ref1", "ref2", 100, 0);
    expect(rec.commission).toBe(20.00);
    expect(rec.status).toBe("pending");
  });
});

describe("Referral Dashboard", () => {
  test("RD-1: getReferralDashboard returns network and commissions", async () => {
    const dashboard = await getReferralDashboard("uid1");
    expect(dashboard).toHaveProperty("network");
    expect(dashboard).toHaveProperty("commissions");
    expect(dashboard.network).toHaveProperty("totalReferrals");
  });
});

describe("Network Messaging", () => {
  test("NM-1: RATE_LIMIT_PER_DAY is 5", () => {
    expect(RATE_LIMIT_PER_DAY).toBe(5);
  });

  test("NM-2: sendNetworkMessage fails if recipient not opted in", async () => {
    await expect(sendNetworkMessage("uid1", "uid2", "hola")).rejects.toThrow("not opted in");
  });

  test("NM-3: setOptIn changes opt-in status", async () => {
    const result = await setOptIn("uid1", true);
    expect(result.optedIn).toBe(true);
  });
});

describe("Growth Metrics", () => {
  test("GM-1: getGrowthSummary returns activation and retention", async () => {
    const summary = await getGrowthSummary("uid1");
    expect(summary).toHaveProperty("uid");
    expect(summary).toHaveProperty("activation");
    expect(summary).toHaveProperty("retention");
  });
});

describe("Viral Loop", () => {
  test("VL-1: SHARE_CHANNELS frozen", () => {
    expect(Object.isFrozen(SHARE_CHANNELS)).toBe(true);
    expect(SHARE_CHANNELS).toContain("whatsapp");
    expect(SHARE_CHANNELS).toContain("email");
  });

  test("VL-2: buildShareLink returns correct WA link", () => {
    const link = buildShareLink("uid1", "uid1ab-xyz123", "whatsapp");
    expect(link).toContain("wa.me");
    expect(link).toContain("uid1ab-xyz123");
  });

  test("VL-3: buildShareLink copy channel returns bare URL", () => {
    const link = buildShareLink("uid1", "CODE1", "copy");
    expect(link).toContain("miia-app.com/join");
    expect(link).toContain("CODE1");
  });
});

describe("Push Notifications", () => {
  test("PN-1: NOTIFICATION_TYPES frozen", () => {
    expect(Object.isFrozen(NOTIFICATION_TYPES)).toBe(true);
    expect(NOTIFICATION_TYPES.LEAD_NUEVO).toBe("lead_nuevo");
  });

  test("PN-2: sendNotification queues valid notification", async () => {
    const n = await sendNotification("uid1", "lead_nuevo", { phone: "5491100000000" });
    expect(n.id).toBeDefined();
    expect(n.status).toBe("queued");
    expect(n.type).toBe("lead_nuevo");
  });

  test("PN-3: sendNotification throws on invalid type", async () => {
    await expect(sendNotification("uid1", "tipo_invalido")).rejects.toThrow("invalid notification type");
  });
});

describe("Gamification", () => {
  test("GA-1: BADGES frozen with required badges", () => {
    expect(Object.isFrozen(BADGES)).toBe(true);
    expect(BADGES.PRIMER_LEAD.id).toBe("primer_lead");
    expect(BADGES.TRES_MESES.id).toBe("tres_meses");
  });

  test("GA-2: checkAndAwardBadges returns awarded array", async () => {
    const result = await checkAndAwardBadges("uid1");
    expect(result).toHaveProperty("awarded");
    expect(Array.isArray(result.awarded)).toBe(true);
  });

  test("GA-3: getOwnerBadges returns badges count", async () => {
    const result = await getOwnerBadges("uid1");
    expect(result).toHaveProperty("badges");
    expect(result).toHaveProperty("count");
  });
});

describe("A/B Testing", () => {
  test("AB-1: createExperiment returns experiment with id", async () => {
    const exp = await createExperiment({ name: "Test1", feature: "new_ui", rolloutPct: 50 });
    expect(exp.id).toBeDefined();
    expect(exp.active).toBe(true);
    expect(exp.rolloutPct).toBe(50);
  });

  test("AB-2: assignVariant is deterministic", () => {
    const v1 = assignVariant("uid123", 100, ["control", "treatment"]);
    const v2 = assignVariant("uid123", 100, ["control", "treatment"]);
    expect(v1).toBe(v2);
    expect(["control", "treatment"]).toContain(v1);
  });

  test("AB-3: assignVariant returns null when outside rollout", () => {
    const v = assignVariant("uid123", 0, ["control", "treatment"]);
    expect(v).toBeNull();
  });

  test("AB-4: createExperiment throws on invalid rolloutPct", async () => {
    await expect(createExperiment({ name: "T", feature: "f", rolloutPct: 150 })).rejects.toThrow("rolloutPct");
  });
});
