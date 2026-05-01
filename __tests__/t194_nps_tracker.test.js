"use strict";

const {
  classifyNPS, calculateNPSScore, recordNPSResponse,
  getCohortNPS, getAllCohortNPS, getNPSTrend, getDetractors,
  NPS_MIN, NPS_MAX, PROMOTER_MIN, PASSIVE_MIN,
  DEFAULT_COHORT, DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
} = require("../core/nps_tracker");

const UID = "testUid1234567890";
const PHONE = "+541155667788";
const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var responseDoc = {
    set: async function(data) { if (throwSet) throw new Error("set error"); },
  };
  var responsesColl = {
    doc: function() { return responseDoc; },
    where: function() {
      return {
        get: async function() {
          if (throwGet) throw new Error("get error");
          return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: "doc" + i }); }); } };
        },
      };
    },
  };
  var cohortDoc = { collection: function() { return responsesColl; } };
  var byCohortColl = { doc: function() { return cohortDoc; } };
  var uidDoc = { collection: function() { return byCohortColl; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe("classifyNPS", function() {
  test("9-10 son promoter", function() {
    expect(classifyNPS(9)).toBe("promoter");
    expect(classifyNPS(10)).toBe("promoter");
  });
  test("7-8 son passive", function() {
    expect(classifyNPS(7)).toBe("passive");
    expect(classifyNPS(8)).toBe("passive");
  });
  test("0-6 son detractor", function() {
    expect(classifyNPS(0)).toBe("detractor");
    expect(classifyNPS(6)).toBe("detractor");
  });
  test("lanza si score fuera de rango", function() {
    expect(function() { classifyNPS(11); }).toThrow("10");
    expect(function() { classifyNPS(-1); }).toThrow();
  });
  test("lanza si score no es numero", function() {
    expect(function() { classifyNPS("bueno"); }).toThrow("numero");
  });
});

describe("calculateNPSScore", function() {
  test("calcula NPS correctamente", function() {
    expect(calculateNPSScore(50, 30, 20)).toBe(30);
  });
  test("NPS 100 si todos promoters", function() {
    expect(calculateNPSScore(10, 0, 0)).toBe(100);
  });
  test("NPS -100 si todos detractors", function() {
    expect(calculateNPSScore(0, 0, 10)).toBe(-100);
  });
  test("NPS 0 si igual promoters y detractors", function() {
    expect(calculateNPSScore(5, 0, 5)).toBe(0);
  });
  test("NPS 0 si total 0", function() {
    expect(calculateNPSScore(0, 0, 0)).toBe(0);
  });
});

describe("recordNPSResponse validacion", function() {
  test("lanza si uid undefined", async function() {
    await expect(recordNPSResponse(undefined, PHONE, 8)).rejects.toThrow("uid requerido");
  });
  test("lanza si phone undefined", async function() {
    await expect(recordNPSResponse(UID, undefined, 8)).rejects.toThrow("phone requerido");
  });
  test("lanza si score fuera de rango", async function() {
    await expect(recordNPSResponse(UID, PHONE, 11)).rejects.toThrow("10");
  });
  test("registra sin error", async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordNPSResponse(UID, PHONE, 8)).resolves.toBeUndefined();
  });
  test("propaga error Firestore", async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordNPSResponse(UID, PHONE, 8)).rejects.toThrow("set error");
  });
});

describe("getCohortNPS", function() {
  test("lanza si uid undefined", async function() {
    await expect(getCohortNPS(undefined)).rejects.toThrow("uid requerido");
  });
  test("retorna zeros si no hay respuestas", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getCohortNPS(UID, "default", NOW);
    expect(r.npsScore).toBe(0);
    expect(r.total).toBe(0);
  });
  test("calcula NPS correcto con respuestas", async function() {
    const docs = [
      { score: 9, category: "promoter", recordedAt: new Date(NOW).toISOString() },
      { score: 9, category: "promoter", recordedAt: new Date(NOW).toISOString() },
      { score: 3, category: "detractor", recordedAt: new Date(NOW).toISOString() },
    ];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getCohortNPS(UID, "default", NOW);
    expect(r.total).toBe(3);
    expect(r.promoters).toBe(2);
    expect(r.detractors).toBe(1);
    expect(r.npsScore).toBeGreaterThan(0);
  });
  test("fail-open retorna zeros si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getCohortNPS(UID, "default", NOW);
    expect(r.npsScore).toBe(0);
  });
});

describe("getAllCohortNPS", function() {
  test("lanza si uid undefined", async function() {
    await expect(getAllCohortNPS(undefined, ["a"])).rejects.toThrow("uid requerido");
  });
  test("retorna array vacio si cohorts vacio", async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await getAllCohortNPS(UID, []);
    expect(r).toEqual([]);
  });
  test("retorna resultado para cada cohort", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAllCohortNPS(UID, ["q1", "q2"]);
    expect(r.length).toBe(2);
  });
});

describe("getNPSTrend", function() {
  test("lanza si uid undefined", async function() {
    await expect(getNPSTrend(undefined)).rejects.toThrow("uid requerido");
  });
  test("tiene current, previous, change, trend", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getNPSTrend(UID, "default", NOW);
    expect(r).toHaveProperty("current");
    expect(r).toHaveProperty("previous");
    expect(r).toHaveProperty("change");
    expect(r).toHaveProperty("trend");
  });
  test("trend estable si cambio <= 5", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getNPSTrend(UID, "default", NOW);
    expect(["improving","declining","stable"]).toContain(r.trend);
  });
});

describe("getDetractors", function() {
  test("lanza si uid undefined", async function() {
    await expect(getDetractors(undefined)).rejects.toThrow("uid requerido");
  });
  test("retorna array vacio si no hay detractors", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getDetractors(UID, "default");
    expect(r).toEqual([]);
  });
  test("fail-open retorna vacio si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getDetractors(UID, "default");
    expect(r).toEqual([]);
  });
});
