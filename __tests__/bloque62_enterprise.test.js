"use strict";

const eo = require("../core/enterprise_onboarding");
const mum = require("../core/multi_user_manager");
const wl = require("../core/white_label");
const akm = require("../core/api_key_manager");
const whm = require("../core/webhook_manager");
const at = require("../core/audit_trail");
const gdpr = require("../core/gdpr_toolkit");

const { ENTERPRISE_STEPS, MIN_ENTERPRISE_SEATS } = eo;
const { ROLES } = mum;
const { DEFAULT_BRAND } = wl;
const { KEY_PREFIX } = akm;
const { WEBHOOK_EVENTS } = whm;
const { ACTION_TYPES } = at;

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
    }),
    where: () => q,
    orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  eo.__setFirestoreForTests(_db);
  mum.__setFirestoreForTests(_db);
  wl.__setFirestoreForTests(_db);
  akm.__setFirestoreForTests(_db);
  whm.__setFirestoreForTests(_db);
  at.__setFirestoreForTests(_db);
  gdpr.__setFirestoreForTests(_db);
});

describe("Enterprise Onboarding", () => {
  test("EO-1: ENTERPRISE_STEPS frozen with 6 steps", () => {
    expect(Object.isFrozen(ENTERPRISE_STEPS)).toBe(true);
    expect(ENTERPRISE_STEPS).toHaveLength(6);
    expect(ENTERPRISE_STEPS[0]).toBe("company_info");
    expect(ENTERPRISE_STEPS[5]).toBe("go_live");
  });

  test("EO-2: createEnterpriseAccount requires min seats", async () => {
    await expect(eo.createEnterpriseAccount({ uid: "u1", companyName: "Acme", contactEmail: "a@b.com", seats: 2 })).rejects.toThrow("at least 5 seats");
  });

  test("EO-3: createEnterpriseAccount creates account with plan=enterprise", async () => {
    const acc = await eo.createEnterpriseAccount({ uid: "u1", companyName: "Acme Corp", contactEmail: "admin@acme.com", seats: 10 });
    expect(acc.plan).toBe("enterprise");
    expect(acc.seats).toBe(10);
    expect(acc.onboardingStep).toBe("company_info");
  });

  test("EO-4: advanceOnboarding moves to next step", async () => {
    const result = await eo.advanceOnboarding("u1", "company_info", {});
    expect(result.next).toBe("legal_contact");
    expect(result.completed).toBe(false);
  });

  test("EO-5: advanceOnboarding last step marks completed", async () => {
    const result = await eo.advanceOnboarding("u1", "go_live", {});
    expect(result.completed).toBe(true);
    expect(result.next).toBeNull();
  });
});

describe("Multi-User Manager", () => {
  test("MU-1: ROLES frozen with 3 roles", () => {
    expect(Object.isFrozen(ROLES)).toBe(true);
    expect(ROLES.ADMIN).toBe("admin");
    expect(ROLES.AGENT).toBe("agent");
    expect(ROLES.READONLY).toBe("readonly");
  });

  test("MU-2: addUser creates user with valid role", async () => {
    const user = await mum.addUser("owner1", "agent@company.com", "agent");
    expect(user.id).toBeDefined();
    expect(user.role).toBe("agent");
    expect(user.active).toBe(true);
  });

  test("MU-3: addUser throws on invalid role", async () => {
    await expect(mum.addUser("owner1", "x@y.com", "superuser")).rejects.toThrow("invalid role");
  });

  test("MU-4: updateUserRole returns new role", async () => {
    const result = await mum.updateUserRole("user-id-1", "readonly");
    expect(result.role).toBe("readonly");
  });
});

describe("White Label", () => {
  test("WL-1: DEFAULT_BRAND frozen with MIIA defaults", () => {
    expect(Object.isFrozen(DEFAULT_BRAND)).toBe(true);
    expect(DEFAULT_BRAND.name).toBe("MIIA");
    expect(DEFAULT_BRAND.primaryColor).toBe("#25D366");
  });

  test("WL-2: getBrandConfig returns defaults when no config set", async () => {
    const brand = await wl.getBrandConfig("uid1");
    expect(brand.name).toBe("MIIA");
  });

  test("WL-3: setBrandConfig saves custom brand", async () => {
    const brand = await wl.setBrandConfig("uid1", { name: "MiTienda", primaryColor: "#FF0000" });
    expect(brand.name).toBe("MiTienda");
    expect(brand.primaryColor).toBe("#FF0000");
  });
});

describe("API Key Manager", () => {
  test("AK-1: KEY_PREFIX is mk_", () => {
    expect(KEY_PREFIX).toBe("mk_");
  });

  test("AK-2: createApiKey returns key with prefix and hash", async () => {
    const result = await akm.createApiKey("uid1", { name: "My Key" });
    expect(result.key).toMatch(/^mk_/);
    expect(result.id).toBeDefined();
  });

  test("AK-3: validateApiKey returns null for invalid key", async () => {
    const result = await akm.validateApiKey("invalid_key");
    expect(result).toBeNull();
  });

  test("AK-4: revokeApiKey marks key inactive", async () => {
    const result = await akm.revokeApiKey("key-id-1");
    expect(result.active).toBe(false);
  });
});

describe("Webhook Manager", () => {
  test("WH-1: WEBHOOK_EVENTS frozen with 4 events", () => {
    expect(Object.isFrozen(WEBHOOK_EVENTS)).toBe(true);
    expect(WEBHOOK_EVENTS).toContain("lead_nuevo");
    expect(WEBHOOK_EVENTS).toContain("cita_agendada");
  });

  test("WH-2: generateHmacSignature is deterministic", () => {
    const sig1 = whm.generateHmacSignature("secret", "body");
    const sig2 = whm.generateHmacSignature("secret", "body");
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64);
  });

  test("WH-3: registerWebhook throws on invalid event", async () => {
    await expect(whm.registerWebhook("uid1", { url: "https://x.com", events: ["evento_inexistente"] })).rejects.toThrow("invalid events");
  });

  test("WH-4: registerWebhook creates webhook record", async () => {
    const wh = await whm.registerWebhook("uid1", { url: "https://hooks.x.com/endpoint", events: ["lead_nuevo"] });
    expect(wh.id).toBeDefined();
    expect(wh.active).toBe(true);
    expect(wh.secret).toBeDefined();
  });
});

describe("Audit Trail", () => {
  test("AT-1: ACTION_TYPES frozen and non-empty", () => {
    expect(Object.isFrozen(ACTION_TYPES)).toBe(true);
    expect(ACTION_TYPES).toContain("login");
    expect(ACTION_TYPES).toContain("message_sent");
  });

  test("AT-2: logAction creates immutable entry", async () => {
    const entry = await at.logAction("uid1", "login", { ip: "1.2.3.4" });
    expect(entry.id).toBeDefined();
    expect(entry.action).toBe("login");
    expect(entry.ip).toBe("1.2.3.4");
    expect(entry.timestamp).toBeDefined();
  });

  test("AT-3: logAction throws on invalid action", async () => {
    await expect(at.logAction("uid1", "hack_system")).rejects.toThrow("invalid action");
  });
});

describe("GDPR Toolkit", () => {
  test("GD-1: exportOwnerData returns export structure", async () => {
    const data = await gdpr.exportOwnerData("uid1");
    expect(data).toHaveProperty("exportedAt");
    expect(data).toHaveProperty("uid");
    expect(data).toHaveProperty("leads");
    expect(Array.isArray(data.leads)).toBe(true);
  });

  test("GD-2: logConsent records consent entry", async () => {
    const entry = await gdpr.logConsent("uid1", "marketing_emails", true);
    expect(entry.consentType).toBe("marketing_emails");
    expect(entry.value).toBe(true);
  });

  test("GD-3: deleteOwnerData returns deletion log", async () => {
    const log = await gdpr.deleteOwnerData("uid1", "user_request");
    expect(log.uid).toBe("uid1");
    expect(log.reason).toBe("user_request");
    expect(Array.isArray(log.collections)).toBe(true);
  });
});
