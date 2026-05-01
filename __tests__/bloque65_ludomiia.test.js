"use strict";

const lh = require("../core/ludomiia_host");
const ld = require("../core/ludomiia_dashboard");
const gc = require("../core/games_catalog");
const gs = require("../core/games_subscription");
const lb = require("../core/leaderboard");

const { CATALOG, GAME_CATEGORIES, listGames, getGame } = gc;
const { PLANS } = gs;

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: (data && data.id) || "doc1", ref: { update: async () => {} } };
}
function makeCol(docs) {
  const arr = (docs || []).map(d => makeDoc(d));
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: (n) => q,
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
    limit: (n) => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  lh.__setFirestoreForTests(_db);
  ld.__setFirestoreForTests(_db);
  gs.__setFirestoreForTests(_db);
  lb.__setFirestoreForTests(_db);
});

describe("LudoMIIA Host", () => {
  test("LH-1: activateLudoMIIA creates config with defaults", async () => {
    const result = await lh.activateLudoMIIA("uid1");
    expect(result.ludomiia.enabled).toBe(true);
    expect(Array.isArray(result.ludomiia.gamesAllowed)).toBe(true);
    expect(result.ludomiia.maxSessionsPerDay).toBe(10);
  });

  test("LH-2: getLudoStatus returns not enabled for unknown owner", async () => {
    const status = await lh.getLudoStatus("uid1");
    expect(status.enabled).toBe(false);
  });

  test("LH-3: createGameSession returns active session", async () => {
    const session = await lh.createGameSession("uid1", "5491100000000", "trivia");
    expect(session.id).toBeDefined();
    expect(session.status).toBe("active");
    expect(session.gameType).toBe("trivia");
  });

  test("LH-4: endGameSession marks session completed", async () => {
    const result = await lh.endGameSession("session-1", 85);
    expect(result.status).toBe("completed");
    expect(result.score).toBe(85);
  });

  test("LH-5: createGameSession requires all params", async () => {
    await expect(lh.createGameSession("uid1", null, "trivia")).rejects.toThrow("phone");
  });
});

describe("LudoMIIA Dashboard", () => {
  test("LD-1: getLudoDashboard returns required fields", async () => {
    const dashboard = await ld.getLudoDashboard("uid1");
    expect(dashboard).toHaveProperty("activeSessions");
    expect(dashboard).toHaveProperty("completedSessions");
    expect(dashboard).toHaveProperty("totalSessions");
    expect(dashboard).toHaveProperty("avgScore");
    expect(dashboard).toHaveProperty("byGame");
  });

  test("LD-2: getLudoDashboard returns zero counts for empty", async () => {
    const dashboard = await ld.getLudoDashboard("uid1");
    expect(dashboard.totalSessions).toBe(0);
    expect(dashboard.avgScore).toBe(0);
  });
});

describe("MIIA GAMES Catalog", () => {
  test("GC-1: CATALOG frozen with 15+ games", () => {
    expect(Object.isFrozen(CATALOG)).toBe(true);
    expect(CATALOG.length).toBeGreaterThanOrEqual(15);
  });

  test("GC-2: GAME_CATEGORIES frozen with all categories", () => {
    expect(Object.isFrozen(GAME_CATEGORIES)).toBe(true);
    expect(GAME_CATEGORIES).toContain("trivia");
    expect(GAME_CATEGORIES).toContain("wordgame");
    expect(GAME_CATEGORIES).toContain("quiz");
  });

  test("GC-3: listGames returns all games without filter", () => {
    const games = listGames();
    expect(games.length).toBe(CATALOG.length);
  });

  test("GC-4: listGames filters by category", () => {
    const triviaGames = listGames({ category: "trivia" });
    expect(triviaGames.length).toBeGreaterThan(0);
    triviaGames.forEach(g => expect(g.category).toBe("trivia"));
  });

  test("GC-5: getGame returns game by id", () => {
    const game = getGame("trivia_general");
    expect(game).not.toBeNull();
    expect(game.name).toBe("Trivia General");
  });

  test("GC-6: getGame returns null for unknown id", () => {
    expect(getGame("fake_game_xyz")).toBeNull();
  });
});

describe("MIIA GAMES Subscription", () => {
  test("GS-1: PLANS frozen with 3 tiers", () => {
    expect(Object.isFrozen(PLANS)).toBe(true);
    expect(PLANS.BASIC).toBeDefined();
    expect(PLANS.PRO).toBeDefined();
    expect(PLANS.ENTERPRISE).toBeDefined();
  });

  test("GS-2: createSubscription creates active sub", async () => {
    const sub = await gs.createSubscription("uid1", "basic");
    expect(sub.status).toBe("active");
    expect(sub.plan).toBe("basic");
    expect(sub.priceUsd).toBe(3);
  });

  test("GS-3: createSubscription throws on invalid plan", async () => {
    await expect(gs.createSubscription("uid1", "superplan")).rejects.toThrow("invalid plan");
  });

  test("GS-4: checkGameLimit returns not allowed without subscription", async () => {
    const result = await gs.checkGameLimit("uid_no_sub");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_subscription");
  });

  test("GS-5: ENTERPRISE plan has unlimited games", () => {
    expect(PLANS.ENTERPRISE.gamesPerMonth).toBe(-1);
  });
});

describe("Leaderboard", () => {
  test("LB-1: updateLeaderboard creates entry", async () => {
    const entry = await lb.updateLeaderboard("uid1", "GamerPro", "trivia_general", 95);
    expect(entry.uid).toBe("uid1");
    expect(entry.alias).toBe("GamerPro");
    expect(entry.score).toBe(95);
  });

  test("LB-2: getGlobalStats returns totalPlayers and mostActive", async () => {
    const stats = await lb.getGlobalStats();
    expect(stats).toHaveProperty("totalPlayers");
    expect(stats).toHaveProperty("mostActive");
    expect(Array.isArray(stats.mostActive)).toBe(true);
  });

  test("LB-3: updateLeaderboard uses Anonimo when no alias", async () => {
    const entry = await lb.updateLeaderboard("uid2", null, "quiz_culture", 70);
    expect(entry.alias).toBe("Anonimo");
  });
});
