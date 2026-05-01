"use strict";

const {
  recordNumberActivity, getNumberStats, getAllNumbersStats,
  getTopPerformingNumber, getDashboardSummary,
  METRIC_FIELDS, DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
} = require("../core/number_dashboard");

const UID = "testUid1234567890";
const PHONE = "+541155667788";
const PHONE2 = "+541199887766";
const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var innerColl = {
    doc: function() {
      return { set: async function(data) { if (throwSet) throw new Error("set error"); } };
    },
    where: function() {
      return {
        where: function() {
          return {
            get: async function() {
              if (throwGet) throw new Error("get error");
              return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: "doc" + i }); }); } };
            },
          };
        },
      };
    },
  };
  var uidDoc = { collection: function() { return innerColl; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe("METRIC_FIELDS y constants", function() {
  test("tiene todos los campos basicos", function() {
    expect(METRIC_FIELDS).toContain("messages_in");
    expect(METRIC_FIELDS).toContain("messages_out");
    expect(METRIC_FIELDS).toContain("leads_contacted");
  });
  test("frozen", function() { expect(function() { METRIC_FIELDS[0] = "x"; }).toThrow(); });
  test("DEFAULT_PERIOD_DAYS es 30", function() { expect(DEFAULT_PERIOD_DAYS).toBe(30); });
});

describe("recordNumberActivity", function() {
  test("lanza si uid undefined", async function() {
    await expect(recordNumberActivity(undefined, PHONE, "messages_in")).rejects.toThrow("uid requerido");
  });
  test("lanza si phone undefined", async function() {
    await expect(recordNumberActivity(UID, undefined, "messages_in")).rejects.toThrow("phone requerido");
  });
  test("lanza si activityType undefined", async function() {
    await expect(recordNumberActivity(UID, PHONE, undefined)).rejects.toThrow("requerido");
  });
  test("lanza si activityType invalido", async function() {
    await expect(recordNumberActivity(UID, PHONE, "tipo_falso")).rejects.toThrow("invalido");
  });
  test("registra sin error", async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordNumberActivity(UID, PHONE, "messages_in")).resolves.toBeUndefined();
  });
  test("propaga error Firestore", async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordNumberActivity(UID, PHONE, "messages_in")).rejects.toThrow("set error");
  });
});

describe("getNumberStats", function() {
  test("lanza si uid undefined", async function() {
    await expect(getNumberStats(undefined, PHONE)).rejects.toThrow("uid requerido");
  });
  test("lanza si phone undefined", async function() {
    await expect(getNumberStats(UID, undefined)).rejects.toThrow("phone requerido");
  });
  test("retorna zeros si no hay actividad", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getNumberStats(UID, PHONE, 30, NOW);
    expect(r.total).toBe(0);
    expect(r.counts.messages_in).toBe(0);
  });
  test("cuenta actividades correctamente", async function() {
    const docs = [
      { phone: PHONE, activityType: "messages_in", recordedAt: new Date(NOW).toISOString() },
      { phone: PHONE, activityType: "messages_in", recordedAt: new Date(NOW).toISOString() },
      { phone: PHONE, activityType: "messages_out", recordedAt: new Date(NOW).toISOString() },
    ];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getNumberStats(UID, PHONE, 30, NOW);
    expect(r.counts.messages_in).toBe(2);
    expect(r.counts.messages_out).toBe(1);
    expect(r.total).toBe(3);
  });
  test("fail-open retorna zeros si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getNumberStats(UID, PHONE, 30, NOW);
    expect(r.total).toBe(0);
  });
});

describe("getAllNumbersStats", function() {
  test("lanza si uid undefined", async function() {
    await expect(getAllNumbersStats(undefined, [PHONE])).rejects.toThrow("uid requerido");
  });
  test("lanza si phones no es array", async function() {
    await expect(getAllNumbersStats(UID, "no-array")).rejects.toThrow("array");
  });
  test("retorna array vacio si phones vacio", async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await getAllNumbersStats(UID, []);
    expect(r).toEqual([]);
  });
  test("retorna stats por cada numero", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAllNumbersStats(UID, [PHONE, PHONE2], 30, NOW);
    expect(r.length).toBe(2);
  });
  test("ordena por total descendente", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getAllNumbersStats(UID, [PHONE, PHONE2], 30, NOW);
    expect(r[0].total).toBeGreaterThanOrEqual(r[1].total);
  });
});

describe("getTopPerformingNumber", function() {
  test("lanza si uid undefined", async function() {
    await expect(getTopPerformingNumber(undefined, [PHONE])).rejects.toThrow("uid requerido");
  });
  test("retorna null si no hay numeros", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getTopPerformingNumber(UID, []);
    expect(r).toBeNull();
  });
  test("retorna stats del primer numero", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getTopPerformingNumber(UID, [PHONE], 30, NOW);
    expect(r.phone).toBe(PHONE);
  });
});

describe("getDashboardSummary", function() {
  test("lanza si uid undefined", async function() {
    await expect(getDashboardSummary(undefined, [])).rejects.toThrow("uid requerido");
  });
  test("tiene numbers, totals, grandTotal, periodDays", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getDashboardSummary(UID, [PHONE], 30, NOW);
    expect(r).toHaveProperty("numbers");
    expect(r).toHaveProperty("totals");
    expect(r).toHaveProperty("grandTotal");
    expect(r).toHaveProperty("periodDays");
  });
  test("grandTotal es 0 cuando no hay actividad", async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getDashboardSummary(UID, [PHONE], 30, NOW);
    expect(r.grandTotal).toBe(0);
  });
});
