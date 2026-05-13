"use strict";
/**
 * P7 PISO 7 coverage -- addon_billing, addon_cards, addon_router, addon_sso,
 *   addon_webhooks, games_catalog, games_subscription, ludomiia_host
 * Todos los modulos PISO 7 >= 85% branches
 */

const ab = require("../core/addon_billing");
const ac = require("../core/addon_cards");
const ar = require("../core/addon_router");
const as = require("../core/addon_sso");
const aw = require("../core/addon_webhooks");
const gc = require("../core/games_catalog");
const gs = require("../core/games_subscription");
const lh = require("../core/ludomiia_host");

// ---------------------------------------------------------------------------
// Generic db helpers
// ---------------------------------------------------------------------------

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : "doc1" };
}

function makeSnapWith(docs) {
  return {
    empty: docs.length === 0,
    forEach: cb => docs.forEach(d => cb({ id: d.id || "x", data: () => d })),
  };
}

function makeFirestoreSimple({
  docData = null,
  snapDocs = [],
  throwGet = false,
  throwSet = false,
  throwUpdate = false,
  throwWhere = false,
} = {}) {
  const getResult = throwGet
    ? jest.fn().mockRejectedValue(new Error("Firestore get error"))
    : jest.fn().mockResolvedValue(makeDoc(docData));
  const setResult = throwSet
    ? jest.fn().mockRejectedValue(new Error("Firestore set error"))
    : jest.fn().mockResolvedValue({});
  const updateResult = throwUpdate
    ? jest.fn().mockRejectedValue(new Error("Firestore update error"))
    : jest.fn().mockResolvedValue({});
  const whereGet = throwWhere
    ? jest.fn().mockRejectedValue(new Error("Firestore where error"))
    : jest.fn().mockResolvedValue(makeSnapWith(snapDocs));
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: getResult,
        set: setResult,
        update: updateResult,
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({ get: getResult, set: setResult }),
        }),
      }),
      where: jest.fn().mockReturnValue({ get: whereGet }),
    }),
  };
}

// ---------------------------------------------------------------------------
// GAMES CATALOG (no Firestore needed - pure functions)
// ---------------------------------------------------------------------------
describe("P7 -- games_catalog", () => {
  test("listGames: sin filtros -> todos (15)", () => {
    const r = gc.listGames();
    expect(r.length).toBe(15);
  });
  test("listGames: filtro category trivia -> 5", () => {
    const r = gc.listGames({ category: "trivia" });
    expect(r.every(g => g.category === "trivia")).toBe(true);
    expect(r.length).toBe(5);
  });
  test("listGames: filtro query wordgame -> incluye word games", () => {
    const r = gc.listGames({ query: "ahorcado" });
    expect(r.length).toBeGreaterThan(0);
  });
  test("listGames: filtro category + query", () => {
    const r = gc.listGames({ category: "quiz", query: "pop" });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].category).toBe("quiz");
  });
  test("listGames: filtros null -> todos", () => {
    const r = gc.listGames(null);
    expect(r.length).toBe(15);
  });
  test("listGames: category inexistente -> empty", () => {
    const r = gc.listGames({ category: "chess" });
    expect(r.length).toBe(0);
  });

  test("getGame: id valido -> retorna juego", () => {
    const g = gc.getGame("trivia_general");
    expect(g.id).toBe("trivia_general");
    expect(g.category).toBe("trivia");
  });
  test("getGame: id invalido -> null", () => {
    const g = gc.getGame("inexistente_game");
    expect(g).toBeNull();
  });

  test("GAME_CATEGORIES tiene 6 categorias", () => {
    expect(gc.GAME_CATEGORIES.length).toBe(6);
    expect(gc.GAME_CATEGORIES).toContain("trivia");
  });
  test("CATALOG frozen", () => {
    expect(() => { gc.CATALOG.push({}); }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GAMES SUBSCRIPTION
// ---------------------------------------------------------------------------
describe("P7 -- games_subscription", () => {
  test("createSubscription: uid null -> throw", async () => {
    await expect(gs.createSubscription(null, "basic")).rejects.toThrow("uid and planKey required");
  });
  test("createSubscription: planKey null -> throw", async () => {
    await expect(gs.createSubscription("uid1", null)).rejects.toThrow("uid and planKey required");
  });
  test("createSubscription: plan invalido -> throw", async () => {
    await expect(gs.createSubscription("uid1", "diamond")).rejects.toThrow("invalid plan");
  });
  test("createSubscription: basic -> success", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple());
    const r = await gs.createSubscription("uid1", "basic");
    expect(r.plan).toBe("basic");
    expect(r.uid).toBe("uid1");
    expect(r.priceUsd).toBe(3);
    expect(r.status).toBe("active");
  });
  test("createSubscription: enterprise -> unlimited (-1)", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple());
    const r = await gs.createSubscription("uid1", "enterprise");
    expect(r.gamesPerMonth).toBe(-1);
  });
  test("createSubscription: PRO uppercase -> funciona", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple());
    const r = await gs.createSubscription("uid1", "PRO");
    expect(r.plan).toBe("pro");
    expect(r.gamesPerMonth).toBe(100);
  });

  test("checkGameLimit: uid null -> throw", async () => {
    await expect(gs.checkGameLimit(null)).rejects.toThrow("uid required");
  });
  test("checkGameLimit: sin suscripcion -> allowed=false", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    const r = await gs.checkGameLimit("uid1");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("no_subscription");
  });
  test("checkGameLimit: suscripcion inactiva -> allowed=false", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple({ docData: { status: "cancelled", gamesPerMonth: 20, gamesUsed: 0 } }));
    const r = await gs.checkGameLimit("uid1");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("inactive_subscription");
  });
  test("checkGameLimit: enterprise ilimitado -> allowed=true, remaining=-1", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple({ docData: { status: "active", gamesPerMonth: -1, gamesUsed: 0 } }));
    const r = await gs.checkGameLimit("uid1");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(-1);
  });
  test("checkGameLimit: basic con juegos restantes -> allowed=true", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple({ docData: { status: "active", gamesPerMonth: 20, gamesUsed: 5 } }));
    const r = await gs.checkGameLimit("uid1");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(15);
  });
  test("checkGameLimit: agotado -> allowed=false", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple({ docData: { status: "active", gamesPerMonth: 20, gamesUsed: 20 } }));
    const r = await gs.checkGameLimit("uid1");
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });
  test("checkGameLimit: gamesUsed undefined -> usa 0", async () => {
    gs.__setFirestoreForTests(makeFirestoreSimple({ docData: { status: "active", gamesPerMonth: 20 } }));
    const r = await gs.checkGameLimit("uid1");
    expect(r.remaining).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// LUDOMIIA HOST
// ---------------------------------------------------------------------------
describe("P7 -- ludomiia_host", () => {
  test("activateLudoMIIA: uid null -> throw", async () => {
    await expect(lh.activateLudoMIIA(null)).rejects.toThrow("uid required");
  });
  test("activateLudoMIIA: sin opts -> defaults", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.activateLudoMIIA("uid1");
    expect(r.ludomiia.enabled).toBe(true);
    expect(r.ludomiia.gamesAllowed).toEqual(["trivia", "wordgame", "quiz"]);
    expect(r.ludomiia.maxSessionsPerDay).toBe(10);
  });
  test("activateLudoMIIA: con opts -> usa opts", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.activateLudoMIIA("uid1", { gamesAllowed: ["trivia"], maxSessionsPerDay: 5 });
    expect(r.ludomiia.gamesAllowed).toEqual(["trivia"]);
    expect(r.ludomiia.maxSessionsPerDay).toBe(5);
  });
  test("activateLudoMIIA: opts sin gamesAllowed -> default games", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.activateLudoMIIA("uid1", { maxSessionsPerDay: 3 });
    expect(r.ludomiia.gamesAllowed).toEqual(["trivia", "wordgame", "quiz"]);
    expect(r.ludomiia.maxSessionsPerDay).toBe(3);
  });

  test("getLudoStatus: uid null -> throw", async () => {
    await expect(lh.getLudoStatus(null)).rejects.toThrow("uid required");
  });
  test("getLudoStatus: snap no existe -> enabled=false", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    const r = await lh.getLudoStatus("uid1");
    expect(r.enabled).toBe(false);
  });
  test("getLudoStatus: snap existe sin ludomiia -> enabled=false", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple({ docData: { name: "test" } }));
    const r = await lh.getLudoStatus("uid1");
    expect(r.enabled).toBe(false);
    expect(r.config).toBeNull();
  });
  test("getLudoStatus: snap con ludomiia enabled=true -> enabled=true", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple({ docData: { ludomiia: { enabled: true, maxSessionsPerDay: 10 } } }));
    const r = await lh.getLudoStatus("uid1");
    expect(r.enabled).toBe(true);
    expect(r.config.maxSessionsPerDay).toBe(10);
  });
  test("getLudoStatus: ludomiia.enabled=false -> enabled=false", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple({ docData: { ludomiia: { enabled: false } } }));
    const r = await lh.getLudoStatus("uid1");
    expect(r.enabled).toBe(false);
  });

  test("createGameSession: uid null -> throw", async () => {
    await expect(lh.createGameSession(null, "+57300", "trivia")).rejects.toThrow("uid, phone, gameType required");
  });
  test("createGameSession: phone null -> throw", async () => {
    await expect(lh.createGameSession("uid1", null, "trivia")).rejects.toThrow("uid, phone, gameType required");
  });
  test("createGameSession: gameType null -> throw", async () => {
    await expect(lh.createGameSession("uid1", "+57300", null)).rejects.toThrow("uid, phone, gameType required");
  });
  test("createGameSession: valid -> retorna session", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.createGameSession("uid1", "+57300", "trivia");
    expect(r.uid).toBe("uid1");
    expect(r.phone).toBe("+57300");
    expect(r.gameType).toBe("trivia");
    expect(r.status).toBe("active");
    expect(r.score).toBe(0);
  });

  test("endGameSession: sessionId null -> throw", async () => {
    await expect(lh.endGameSession(null, 50)).rejects.toThrow("sessionId required");
  });
  test("endGameSession: con score -> score=finalScore", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.endGameSession("sess1", 75);
    expect(r.score).toBe(75);
    expect(r.status).toBe("completed");
  });
  test("endGameSession: sin score -> score=0 (|| 0 branch)", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.endGameSession("sess1", 0);
    expect(r.score).toBe(0);
  });
  test("endGameSession: undefined score -> score=0", async () => {
    lh.__setFirestoreForTests(makeFirestoreSimple());
    const r = await lh.endGameSession("sess1", undefined);
    expect(r.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ADDON BILLING
// ---------------------------------------------------------------------------
describe("P7 -- addon_billing", () => {
  test("createAddonCheckout: addon invalido -> throw", async () => {
    await expect(ab.createAddonCheckout("uid1", "chess_addon", "paypal")).rejects.toThrow("Invalid addon");
  });
  test("createAddonCheckout: provider invalido -> throw", async () => {
    await expect(ab.createAddonCheckout("uid1", "ludo_miia", "stripe")).rejects.toThrow("Invalid provider");
  });
  test("createAddonCheckout: valid paypal -> success", async () => {
    ab.__setFirestoreForTests(makeFirestoreSimple());
    const r = await ab.createAddonCheckout("uid1", "ludo_miia", "paypal");
    expect(r.addonId).toBe("ludo_miia");
    expect(r.provider).toBe("paypal");
    expect(r.amountUSD).toBe(5);
    expect(r.status).toBe("pending");
  });
  test("createAddonCheckout: mercadopago -> funciona", async () => {
    ab.__setFirestoreForTests(makeFirestoreSimple());
    const r = await ab.createAddonCheckout("uid1", "miia_dt", "mercadopago");
    expect(r.provider).toBe("mercadopago");
  });

  test("confirmAddonPayment: addon invalido -> throw", async () => {
    await expect(ab.confirmAddonPayment("uid1", "chess_addon", "txn1")).rejects.toThrow("Invalid addon");
  });
  test("confirmAddonPayment: valid -> success", async () => {
    ab.__setFirestoreForTests(makeFirestoreSimple());
    const r = await ab.confirmAddonPayment("uid1", "ludo_miia", "txn123");
    expect(r.addonActivated).toBe(true);
    expect(r.status).toBe("completed");
    expect(r.transactionId).toBe("txn123");
  });

  test("getAddonPaymentHistory: con pagos -> lista", async () => {
    ab.__setFirestoreForTests(makeFirestoreSimple({ snapDocs: [{ id: "p1", amount: 5, addonId: "ludo_miia" }] }));
    const r = await ab.getAddonPaymentHistory("uid1");
    expect(r).toHaveLength(1);
    expect(r[0].addonId).toBe("ludo_miia");
  });
  test("getAddonPaymentHistory: sin pagos -> empty", async () => {
    ab.__setFirestoreForTests(makeFirestoreSimple({ snapDocs: [] }));
    const r = await ab.getAddonPaymentHistory("uid1");
    expect(r).toHaveLength(0);
  });

  test("PAYMENT_PROVIDERS y PAYMENT_STATUS frozen", () => {
    expect(Object.isFrozen(ab.PAYMENT_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(ab.PAYMENT_STATUS)).toBe(true);
    expect(ab.ADDON_PRICE_USD).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ADDON CARDS
// ---------------------------------------------------------------------------
describe("P7 -- addon_cards", () => {
  test("ADDON_IDS frozen", () => {
    expect(Object.isFrozen(ac.ADDON_IDS)).toBe(true);
    expect(ac.ADDON_IDS).toContain("ludo_miia");
    expect(ac.ADDON_IDS).toContain("miia_dt");
  });

  test("getAddonCatalog -> 2 addons", () => {
    const r = ac.getAddonCatalog();
    expect(r).toHaveLength(2);
    expect(r[0].id).toBeDefined();
  });

  test("getOwnerAddons: sin addons -> ambos inactive", async () => {
    ac.__setFirestoreForTests(makeFirestoreSimple({ snapDocs: [] }));
    const r = await ac.getOwnerAddons("uid1");
    expect(r.ludo_miia.active).toBe(false);
    expect(r.miia_dt.active).toBe(false);
  });
  test("getOwnerAddons: con addon activo -> refleja activo", async () => {
    ac.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ addonId: "ludo_miia", active: true, activatedAt: "2026-05-01" }],
    }));
    const r = await ac.getOwnerAddons("uid1");
    expect(r.ludo_miia.active).toBe(true);
    expect(r.ludo_miia.activatedAt).toBe("2026-05-01");
  });
  test("getOwnerAddons: addonId desconocido en snap -> se ignora", async () => {
    ac.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ addonId: "unknown_addon", active: true }],
    }));
    const r = await ac.getOwnerAddons("uid1");
    expect(r.ludo_miia.active).toBe(false);
  });

  test("buildDashboardExtrasSection: addon inactivo -> url=null", async () => {
    ac.__setFirestoreForTests(makeFirestoreSimple({ snapDocs: [] }));
    const r = await ac.buildDashboardExtrasSection("uid1");
    expect(r.section).toBe("extras");
    expect(r.cards[0].url).toBeNull();
    expect(r.cards[0].active).toBe(false);
    expect(r.cards[0].activatedAt).toBeNull();
  });
  test("buildDashboardExtrasSection: addon activo -> url presente", async () => {
    ac.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ addonId: "ludo_miia", active: true, activatedAt: "2026-05-01" }],
    }));
    const r = await ac.buildDashboardExtrasSection("uid1");
    const ludo = r.cards.find(c => c.id === "ludo_miia");
    expect(ludo.active).toBe(true);
    expect(ludo.url).toContain("ludo");
    expect(ludo.activatedAt).toBe("2026-05-01");
  });
});

// ---------------------------------------------------------------------------
// ADDON ROUTER
// ---------------------------------------------------------------------------
describe("P7 -- addon_router", () => {
  test("detectAddonIntent: message null -> not detected", () => {
    const r = ar.detectAddonIntent(null);
    expect(r.detected).toBe(false);
    expect(r.addonId).toBeNull();
  });
  test("detectAddonIntent: sin patron -> not detected", () => {
    const r = ar.detectAddonIntent("hola como estas");
    expect(r.detected).toBe(false);
  });
  test("detectAddonIntent: ludo_miia match (juego) -> detected", () => {
    const r = ar.detectAddonIntent("quiero jugar un juego");
    expect(r.detected).toBe(true);
    expect(r.addonId).toBe("ludo_miia");
    expect(r.confidence).toBeGreaterThan(0);
  });
  test("detectAddonIntent: miia_dt match (broadcast) -> detected", () => {
    const r = ar.detectAddonIntent("necesito hacer un broadcast masivo");
    expect(r.detected).toBe(true);
    expect(r.addonId).toBe("miia_dt");
  });
  test("detectAddonIntent: multiple patterns -> confidence aumenta", () => {
    const r = ar.detectAddonIntent("ruleta y sorteo y concurso de puntos");
    expect(r.detected).toBe(true);
    expect(r.addonId).toBe("ludo_miia");
    expect(r.confidence).toBeGreaterThanOrEqual(1);
  });

  test("routeToAddon: addon invalido -> throw", async () => {
    await expect(ar.routeToAddon("uid1", "chess", "hola")).rejects.toThrow("Invalid addon");
  });
  test("routeToAddon: addon no activo (snap no existe) -> throw", async () => {
    ar.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    await expect(ar.routeToAddon("uid1", "ludo_miia", "hola")).rejects.toThrow("Addon not active");
  });
  test("routeToAddon: addon exists but not active -> throw", async () => {
    ar.__setFirestoreForTests(makeFirestoreSimple({ docData: { active: false } }));
    await expect(ar.routeToAddon("uid1", "ludo_miia", "hola")).rejects.toThrow("Addon not active");
  });
  test("routeToAddon: addon activo -> success", async () => {
    ar.__setFirestoreForTests(makeFirestoreSimple({ docData: { active: true } }));
    const r = await ar.routeToAddon("uid1", "ludo_miia", "hola", { chatType: "lead" });
    expect(r.addonId).toBe("ludo_miia");
    expect(r.uid).toBe("uid1");
    expect(r.context.chatType).toBe("lead");
  });
  test("routeToAddon: sin context -> usa {}", async () => {
    ar.__setFirestoreForTests(makeFirestoreSimple({ docData: { active: true } }));
    const r = await ar.routeToAddon("uid1", "miia_dt", "hola");
    expect(r.context).toEqual({});
  });

  test("getRoutingHistory: sin filtro addonId -> todos", async () => {
    ar.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [
        { uid: "uid1", addonId: "ludo_miia" },
        { uid: "uid1", addonId: "miia_dt" },
      ],
    }));
    const r = await ar.getRoutingHistory("uid1");
    expect(r).toHaveLength(2);
  });
  test("getRoutingHistory: con filtro addonId -> filtra", async () => {
    ar.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [
        { uid: "uid1", addonId: "ludo_miia" },
        { uid: "uid1", addonId: "miia_dt" },
      ],
    }));
    const r = await ar.getRoutingHistory("uid1", "ludo_miia");
    expect(r).toHaveLength(1);
    expect(r[0].addonId).toBe("ludo_miia");
  });
});

// ---------------------------------------------------------------------------
// ADDON SSO
// ---------------------------------------------------------------------------
describe("P7 -- addon_sso", () => {
  test("generateSSOToken: addon invalido -> throw", async () => {
    await expect(as.generateSSOToken("uid1", "chess_sso")).rejects.toThrow("Invalid addon");
  });
  test("generateSSOToken: addon no activo (snap no existe) -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    await expect(as.generateSSOToken("uid1", "ludo_miia")).rejects.toThrow("Addon not active");
  });
  test("generateSSOToken: addon exists not active -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({ docData: { active: false } }));
    await expect(as.generateSSOToken("uid1", "ludo_miia")).rejects.toThrow("Addon not active");
  });
  test("generateSSOToken: addon activo -> token retornado", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({ docData: { active: true } }));
    const r = await as.generateSSOToken("uid1", "ludo_miia");
    expect(r.token).toBeDefined();
    expect(r.addonId).toBe("ludo_miia");
    expect(r.ttlSeconds).toBe(60);
  });

  test("validateSSOToken: token no encontrado -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({ snapDocs: [] }));
    await expect(as.validateSSOToken("bad-token", "ludo_miia")).rejects.toThrow("Invalid SSO token");
  });
  test("validateSSOToken: addonId mismatch -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ id: "tok1", uid: "uid1", addonId: "miia_dt", used: false, expiresAt: new Date(Date.now() + 60000).toISOString() }],
    }));
    await expect(as.validateSSOToken("some-token", "ludo_miia")).rejects.toThrow("addon mismatch");
  });
  test("validateSSOToken: token ya usado -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ id: "tok1", uid: "uid1", addonId: "ludo_miia", used: true, expiresAt: new Date(Date.now() + 60000).toISOString() }],
    }));
    await expect(as.validateSSOToken("some-token", "ludo_miia")).rejects.toThrow("already used");
  });
  test("validateSSOToken: token expirado -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ id: "tok1", uid: "uid1", addonId: "ludo_miia", used: false, expiresAt: new Date(Date.now() - 60000).toISOString() }],
    }));
    await expect(as.validateSSOToken("some-token", "ludo_miia")).rejects.toThrow("expired");
  });
  test("validateSSOToken: token valido -> uid retornado", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ id: "tok1", uid: "uid1", addonId: "ludo_miia", used: false, expiresAt: new Date(Date.now() + 60000).toISOString() }],
    }));
    const r = await as.validateSSOToken("some-token", "ludo_miia");
    expect(r.uid).toBe("uid1");
    expect(r.valid).toBe(true);
  });

  test("revokeSSOToken: token no encontrado -> throw", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({ snapDocs: [] }));
    await expect(as.revokeSSOToken("bad-token")).rejects.toThrow("Token not found");
  });
  test("revokeSSOToken: token valido -> revoked=true", async () => {
    as.__setFirestoreForTests(makeFirestoreSimple({
      snapDocs: [{ id: "tok1", uid: "uid1", addonId: "ludo_miia", used: false }],
    }));
    const r = await as.revokeSSOToken("good-token");
    expect(r.revoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADDON WEBHOOKS
// ---------------------------------------------------------------------------
describe("P7 -- addon_webhooks", () => {
  test("registerWebhook: addon invalido -> throw", async () => {
    await expect(aw.registerWebhook("uid1", "chess", "https://hook.test", ["addon_activated"])).rejects.toThrow("Invalid addon");
  });
  test("registerWebhook: evento invalido -> throw", async () => {
    await expect(aw.registerWebhook("uid1", "ludo_miia", "https://hook.test", ["invalid_event"])).rejects.toThrow("Invalid events");
  });
  test("registerWebhook: valid con events -> success", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple());
    const r = await aw.registerWebhook("uid1", "ludo_miia", "https://hook.test", ["addon_activated"]);
    expect(r.addonId).toBe("ludo_miia");
    expect(r.active).toBe(true);
    expect(r.events).toEqual(["addon_activated"]);
  });
  test("registerWebhook: sin events -> usa WEBHOOK_EVENTS default", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple());
    const r = await aw.registerWebhook("uid1", "miia_dt", "https://hook.test");
    expect(r.events).toEqual(aw.WEBHOOK_EVENTS);
  });
  test("registerWebhook: events vacio [] -> usa [] ([] es truthy)", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple());
    const r = await aw.registerWebhook("uid1", "ludo_miia", "https://hook.test", []);
    expect(r.events).toEqual([]);
  });

  test("fireWebhook: evento invalido -> throw", async () => {
    await expect(aw.fireWebhook("uid1", "ludo_miia", "invalid_event", {})).rejects.toThrow("Invalid event");
  });
  test("fireWebhook: snap no existe -> fired=false", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    const r = await aw.fireWebhook("uid1", "ludo_miia", "addon_activated", {});
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("no webhook registered");
  });
  test("fireWebhook: snap existe pero no activo -> fired=false", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({ docData: { active: false, events: ["addon_activated"] } }));
    const r = await aw.fireWebhook("uid1", "ludo_miia", "addon_activated", {});
    expect(r.fired).toBe(false);
  });
  test("fireWebhook: event no suscrito -> fired=false", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({
      docData: { active: true, events: ["addon_deactivated"], webhookUrl: "https://hook.test" },
    }));
    const r = await aw.fireWebhook("uid1", "ludo_miia", "addon_activated", {});
    expect(r.fired).toBe(false);
    expect(r.reason).toBe("event not subscribed");
  });
  test("fireWebhook: valid -> fired=true", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({
      docData: { active: true, events: ["addon_activated"], webhookUrl: "https://hook.test" },
    }));
    const r = await aw.fireWebhook("uid1", "ludo_miia", "addon_activated", { uid: "uid1" });
    expect(r.fired).toBe(true);
    expect(r.event).toBe("addon_activated");
  });
  test("fireWebhook: payload null -> usa {}", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({
      docData: { active: true, events: ["addon_activated"], webhookUrl: "https://hook.test" },
    }));
    const r = await aw.fireWebhook("uid1", "ludo_miia", "addon_activated", null);
    expect(r.fired).toBe(true);
  });

  test("activateAddon: addon invalido -> throw", async () => {
    await expect(aw.activateAddon("uid1", "chess")).rejects.toThrow("Invalid addon");
  });
  test("activateAddon: valid (webhook no registrado) -> active=true", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    const r = await aw.activateAddon("uid1", "ludo_miia");
    expect(r.active).toBe(true);
  });

  test("deactivateAddon: addon invalido -> throw", async () => {
    await expect(aw.deactivateAddon("uid1", "chess")).rejects.toThrow("Invalid addon");
  });
  test("deactivateAddon: valid -> active=false", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    const r = await aw.deactivateAddon("uid1", "miia_dt");
    expect(r.active).toBe(false);
  });

  test("getWebhookConfigs: snap no existe -> null", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({ docData: null }));
    const r = await aw.getWebhookConfigs("uid1", "ludo_miia");
    expect(r).toBeNull();
  });
  test("getWebhookConfigs: snap existe -> data", async () => {
    aw.__setFirestoreForTests(makeFirestoreSimple({ docData: { webhookUrl: "https://hook.test", active: true } }));
    const r = await aw.getWebhookConfigs("uid1", "ludo_miia");
    expect(r.webhookUrl).toBe("https://hook.test");
  });
});
