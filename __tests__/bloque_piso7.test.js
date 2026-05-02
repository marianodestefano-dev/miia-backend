"use strict";

function makeDoc(data) { return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : "doc1" }; }
function makeSnap(docs) { const w = docs.map(d => ({ id: d.id || "x", data: () => d })); return { forEach: fn => w.forEach(fn), size: docs.length, empty: !docs.length }; }
function makeCol(docs) { docs = docs || []; const snap = makeSnap(docs); return { doc: id => ({ get: async () => makeDoc(docs.find(d => d.id === id) || null), set: async () => {}, collection: () => makeCol([]) }), where: () => ({ get: async () => snap }), get: async () => snap }; }

const ac = require("../core/addon_cards");

describe("addon_cards -- T426", () => {
  test("ADDON_IDS frozen with ludo_miia and miia_dt", () => {
    expect(Object.isFrozen(ac.ADDON_IDS)).toBe(true);
    expect(ac.ADDON_IDS.length).toBe(2);
    expect(ac.ADDON_IDS).toContain("ludo_miia");
    expect(ac.ADDON_IDS).toContain("miia_dt");
  });
  test("ADDON_CATALOG frozen with price 5 USD each", () => {
    expect(Object.isFrozen(ac.ADDON_CATALOG)).toBe(true);
    expect(ac.ADDON_CATALOG.ludo_miia.priceUSD).toBe(5);
    expect(ac.ADDON_CATALOG.miia_dt.priceUSD).toBe(5);
  });
  test("getAddonCatalog -- returns 2 addons", () => {
    const r = ac.getAddonCatalog();
    expect(r.length).toBe(2);
    expect(r[0].id).toBeDefined();
  });
  test("getOwnerAddons -- no addons returns both inactive", async () => {
    ac.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([]) }) }) });
    const r = await ac.getOwnerAddons("uid1");
    expect(r.ludo_miia.active).toBe(false);
    expect(r.miia_dt.active).toBe(false);
  });
  test("buildDashboardExtrasSection -- returns cards for all addons", async () => {
    ac.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([]) }) }) });
    const r = await ac.buildDashboardExtrasSection("uid1");
    expect(r.section).toBe("extras");
    expect(r.cards.length).toBe(2);
    expect(r.cards[0].active).toBe(false);
  });
});

const ar2 = require("../core/addon_router");

describe("addon_router -- T427", () => {
  test("INTENT_PATTERNS frozen with ludo_miia and miia_dt", () => {
    expect(Object.isFrozen(ar2.INTENT_PATTERNS)).toBe(true);
    expect(ar2.INTENT_PATTERNS.ludo_miia).toBeDefined();
    expect(ar2.INTENT_PATTERNS.miia_dt).toBeDefined();
  });
  test("detectAddonIntent -- juego routes to ludo_miia", () => {
    const r = ar2.detectAddonIntent("quiero hacer un juego de puntos para mis clientes");
    expect(r.detected).toBe(true);
    expect(r.addonId).toBe("ludo_miia");
    expect(r.confidence).toBeGreaterThan(0);
  });
  test("detectAddonIntent -- aviso automatico routes to miia_dt", () => {
    const r = ar2.detectAddonIntent("necesito enviar aviso automatico a mis clientes");
    expect(r.detected).toBe(true);
    expect(r.addonId).toBe("miia_dt");
  });
  test("detectAddonIntent -- unrelated message returns detected false", () => {
    const r = ar2.detectAddonIntent("cual es el precio del cafe?");
    expect(r.detected).toBe(false);
    expect(r.addonId).toBeNull();
  });
  test("routeToAddon -- invalid addon throws", async () => {
    ar2.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ar2.routeToAddon("uid1", "fake_addon", "msg", {})).rejects.toThrow("Invalid addon");
  });
  test("routeToAddon -- inactive addon throws", async () => {
    ar2.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc({ active: false }) }) }) });
    await expect(ar2.routeToAddon("uid1", "ludo_miia", "msg", {})).rejects.toThrow("Addon not active");
  });
  test("routeToAddon -- active addon creates routing record", async () => {
    const db = { collection: name => name === "owner_addons" ? { doc: () => ({ get: async () => makeDoc({ active: true, addonId: "ludo_miia" }) }) } : { doc: () => ({ set: async () => {} }) } };
    ar2.__setFirestoreForTests(db);
    const r = await ar2.routeToAddon("uid1", "ludo_miia", "quiero juego", { from: "chat" });
    expect(r.addonId).toBe("ludo_miia");
    expect(r.id).toBeDefined();
  });
});

const ab = require("../core/addon_billing");

describe("addon_billing -- T428", () => {
  test("ADDON_PRICE_USD is 5", () => {
    expect(ab.ADDON_PRICE_USD).toBe(5);
  });
  test("PAYMENT_PROVIDERS frozen with paddle and mercadopago", () => {
    expect(Object.isFrozen(ab.PAYMENT_PROVIDERS)).toBe(true);
    expect(ab.PAYMENT_PROVIDERS).toContain("paddle");
    expect(ab.PAYMENT_PROVIDERS).toContain("mercadopago");
  });
  test("createAddonCheckout -- invalid addon throws", async () => {
    ab.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ab.createAddonCheckout("uid1", "fake", "paddle")).rejects.toThrow("Invalid addon");
  });
  test("createAddonCheckout -- invalid provider throws", async () => {
    ab.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ab.createAddonCheckout("uid1", "ludo_miia", "paypal")).rejects.toThrow("Invalid provider");
  });
  test("createAddonCheckout -- creates checkout with price 5", async () => {
    ab.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ab.createAddonCheckout("uid1", "ludo_miia", "paddle");
    expect(r.amountUSD).toBe(5);
    expect(r.status).toBe("pending");
    expect(r.checkoutUrl).toContain("ludo_miia");
  });
  test("confirmAddonPayment -- activates addon and returns payment", async () => {
    ab.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ab.confirmAddonPayment("uid1", "miia_dt", "txn_abc123");
    expect(r.status).toBe("completed");
    expect(r.addonActivated).toBe(true);
    expect(r.transactionId).toBe("txn_abc123");
  });
});

const asso = require("../core/addon_sso");

describe("addon_sso -- T429", () => {
  test("SSO_TTL_SECONDS is 60", () => {
    expect(asso.SSO_TTL_SECONDS).toBe(60);
  });
  test("generateSSOToken -- invalid addon throws", async () => {
    asso.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(asso.generateSSOToken("uid1", "fake")).rejects.toThrow("Invalid addon");
  });
  test("generateSSOToken -- inactive addon throws", async () => {
    asso.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc({ active: false }) }) }) });
    await expect(asso.generateSSOToken("uid1", "ludo_miia")).rejects.toThrow("Addon not active");
  });
  test("generateSSOToken -- active addon returns token with 60s TTL", async () => {
    const db = { collection: name => name === "owner_addons" ? { doc: () => ({ get: async () => makeDoc({ active: true }) }) } : { doc: () => ({ set: async () => {} }) } };
    asso.__setFirestoreForTests(db);
    const r = await asso.generateSSOToken("uid1", "ludo_miia");
    expect(r.token).toBeDefined();
    expect(r.ttlSeconds).toBe(60);
    expect(r.addonId).toBe("ludo_miia");
  });
  test("validateSSOToken -- invalid token throws", async () => {
    asso.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([]) }) }) });
    await expect(asso.validateSSOToken("badtoken", "ludo_miia")).rejects.toThrow("Invalid SSO token");
  });
  test("validateSSOToken -- used token throws", async () => {
    const rec = { id: "r1", uid: "uid1", addonId: "ludo_miia", token: "tok", used: true, expiresAt: new Date(Date.now() + 60000).toISOString() };
    asso.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([rec]) }), doc: () => ({ set: async () => {} }) }) });
    await expect(asso.validateSSOToken("tok", "ludo_miia")).rejects.toThrow("already used");
  });
  test("validateSSOToken -- expired token throws", async () => {
    const rec = { id: "r1", uid: "uid1", addonId: "ludo_miia", token: "tok", used: false, expiresAt: new Date(Date.now() - 10000).toISOString() };
    asso.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([rec]) }), doc: () => ({ set: async () => {} }) }) });
    await expect(asso.validateSSOToken("tok", "ludo_miia")).rejects.toThrow("expired");
  });
  test("validateSSOToken -- valid token returns uid", async () => {
    const rec = { id: "r1", uid: "uid1", addonId: "ludo_miia", token: "tok", used: false, expiresAt: new Date(Date.now() + 30000).toISOString() };
    asso.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([rec]) }), doc: () => ({ set: async () => {} }) }) });
    const r = await asso.validateSSOToken("tok", "ludo_miia");
    expect(r.uid).toBe("uid1");
    expect(r.valid).toBe(true);
  });
});

const aw = require("../core/addon_webhooks");

describe("addon_webhooks -- T430", () => {
  test("WEBHOOK_EVENTS frozen with 3 events", () => {
    expect(Object.isFrozen(aw.WEBHOOK_EVENTS)).toBe(true);
    expect(aw.WEBHOOK_EVENTS.length).toBe(3);
    expect(aw.WEBHOOK_EVENTS).toContain("addon_activated");
    expect(aw.WEBHOOK_EVENTS).toContain("addon_deactivated");
  });
  test("registerWebhook -- invalid addon throws", async () => {
    aw.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(aw.registerWebhook("uid1", "fake", "https://x.com", [])).rejects.toThrow("Invalid addon");
  });
  test("registerWebhook -- invalid event throws", async () => {
    aw.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(aw.registerWebhook("uid1", "ludo_miia", "https://x.com", ["bad_event"])).rejects.toThrow("Invalid events");
  });
  test("registerWebhook -- valid config saves webhook", async () => {
    aw.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await aw.registerWebhook("uid1", "ludo_miia", "https://my.app/webhook", ["addon_activated"]);
    expect(r.webhookUrl).toBe("https://my.app/webhook");
    expect(r.events).toContain("addon_activated");
    expect(r.active).toBe(true);
  });
  test("fireWebhook -- invalid event throws", async () => {
    aw.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(aw.fireWebhook("uid1", "ludo_miia", "bad_event", {})).rejects.toThrow("Invalid event");
  });
  test("fireWebhook -- no webhook registered returns fired false", async () => {
    aw.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) });
    const r = await aw.fireWebhook("uid1", "ludo_miia", "addon_activated", {});
    expect(r.fired).toBe(false);
  });
  test("activateAddon -- sets active and fires webhook", async () => {
    const db = {
      collection: name => {
        if (name === "owner_addons") return { doc: () => ({ set: async () => {} }) };
        if (name === "addon_webhooks") return { doc: () => ({ get: async () => makeDoc({ active: true, events: ["addon_activated"], webhookUrl: "https://x.com" }) }) };
        return { doc: () => ({ set: async () => {} }) };
      }
    };
    aw.__setFirestoreForTests(db);
    const r = await aw.activateAddon("uid1", "ludo_miia");
    expect(r.active).toBe(true);
    expect(r.addonId).toBe("ludo_miia");
  });
  test("deactivateAddon -- invalid addon throws", async () => {
    aw.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(aw.deactivateAddon("uid1", "bad_addon")).rejects.toThrow("Invalid addon");
  });
  test("deactivateAddon -- sets inactive", async () => {
    const db = {
      collection: name => {
        if (name === "owner_addons") return { doc: () => ({ set: async () => {} }) };
        if (name === "addon_webhooks") return { doc: () => ({ get: async () => makeDoc(null) }) };
        return { doc: () => ({ set: async () => {} }) };
      }
    };
    aw.__setFirestoreForTests(db);
    const r = await aw.deactivateAddon("uid1", "miia_dt");
    expect(r.active).toBe(false);
  });
});
