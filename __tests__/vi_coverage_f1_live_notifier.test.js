"use strict";

let buildLiveMessage, checkDriverPositionChange, processLivePositionUpdates, _lastNotifiedLap;
let adminMock;

beforeAll(() => {
  jest.resetModules();
  adminMock = { firestore: jest.fn() };
  jest.doMock("firebase-admin", () => adminMock);
  jest.doMock("../sports/f1_dashboard/f1_schema", () => ({
    paths: { driver: jest.fn().mockReturnValue("f1_data/2025/drivers/HAM") },
  }));
  const mod = require("../sports/f1_dashboard/f1_live_notifier");
  buildLiveMessage = mod.buildLiveMessage;
  checkDriverPositionChange = mod.checkDriverPositionChange;
  processLivePositionUpdates = mod.processLivePositionUpdates;
  _lastNotifiedLap = mod._lastNotifiedLap;
});

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  _lastNotifiedLap.clear();
});
afterEach(() => jest.restoreAllMocks());

function makeDb({ driverExists = true, driverData = { name: "Hamilton", team: "Mercedes", number: "44" }, ownerPhone = "+1234" } = {}) {
  return {
    doc: jest.fn().mockImplementation((path) => ({
      get: jest.fn().mockResolvedValue(
        path.startsWith("f1_data")
          ? { exists: driverExists, data: () => driverData }
          : { data: () => ownerPhone ? { phone: ownerPhone } : null }
      ),
    })),
    collectionGroup: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [] }),
    }),
  };
}

describe("buildLiveMessage branches", () => {
  test("P1 + gained + totalLaps truthy (V lap/total)", () => {
    const m = buildLiveMessage("Hamilton", "Mercedes", 1, 3, "Monaco", 5, 78);
    expect(m).toContain("LIDERA");
    expect(m).toContain("V5/78");
  });
  test("gained no P1 => subio (else-if gained taken)", () => {
    expect(buildLiveMessage("Hamilton", "Mercedes", 2, 5, "Monaco", 10, 78)).toContain("subio a P2");
  });
  test("lost => cayo (else-if lost branch[1] taken)", () => {
    expect(buildLiveMessage("Hamilton", "Mercedes", 5, 2, "Monaco", 20, 78)).toContain("cayo a P5");
  });
  test("ni gained ni lost => mantiene (cond-expr[1] mantiene branch)", () => {
    expect(buildLiveMessage("Hamilton", "Mercedes", 3, 3, "Monaco", 30, 78)).toContain("mantiene P3");
  });
  test("totalLaps=0 => sin total (cond-expr[1] lapStr)", () => {
    const m = buildLiveMessage("Hamilton", "Mercedes", 1, 2, "Monaco", 5, 0);
    expect(m).toContain("(V5)");
    expect(m).not.toContain("V5/");
  });
});

describe("checkDriverPositionChange branches", () => {
  test("!adoptedDriverId => null", async () => {
    expect(await checkDriverPositionChange("uid1", null, [{ position: 1, driver_number: "44" }], {}, 10, 78, "Monaco")).toBeNull();
  });
  test("!currentPositions => null", async () => {
    expect(await checkDriverPositionChange("uid1", "HAM", null, {}, 10, 78, "Monaco")).toBeNull();
  });
  test("currentPositions vacia => null (.length=0)", async () => {
    expect(await checkDriverPositionChange("uid1", "HAM", [], {}, 10, 78, "Monaco")).toBeNull();
  });
  test("!driverDoc.exists => null", async () => {
    adminMock.firestore.mockReturnValue(makeDb({ driverExists: false }));
    expect(await checkDriverPositionChange("uid1", "HAM", [{ position: 2, driver_number: "44" }], {}, 10, 78, "Monaco")).toBeNull();
  });
  test("driver no en positions => null (!current branch)", async () => {
    adminMock.firestore.mockReturnValue(makeDb());
    expect(await checkDriverPositionChange("uid1", "HAM", [{ position: 1, driver_number: "33" }], {}, 10, 78, "Monaco")).toBeNull();
  });
  test("match por p.number => binary-expr[1] branch", async () => {
    adminMock.firestore.mockReturnValue(makeDb());
    _lastNotifiedLap.set("uid1", 1);
    const msg = await checkDriverPositionChange("uid1", "HAM", [{ position: 2, number: "44" }], { "44": 4 }, 10, 78, "Monaco");
    expect(msg).toContain("Hamilton");
  });
  test("newPos === oldPos => null", async () => {
    adminMock.firestore.mockReturnValue(makeDb());
    expect(await checkDriverPositionChange("uid1", "HAM", [{ position: 3, driver_number: "44" }], { "44": 3 }, 10, 78, "Monaco")).toBeNull();
  });
  test("prevPositions vacio => oldPos=newPos => null (|| newPos branch)", async () => {
    adminMock.firestore.mockReturnValue(makeDb());
    expect(await checkDriverPositionChange("uid1", "HAM", [{ position: 3, driver_number: "44" }], {}, 10, 78, "Monaco")).toBeNull();
  });
  test("rate limit activo => null", async () => {
    adminMock.firestore.mockReturnValue(makeDb());
    _lastNotifiedLap.set("uid1", 8);
    expect(await checkDriverPositionChange("uid1", "HAM", [{ position: 2, driver_number: "44" }], { "44": 4 }, 10, 78, "Monaco")).toBeNull();
  });
  test("todo ok => retorna mensaje", async () => {
    adminMock.firestore.mockReturnValue(makeDb());
    _lastNotifiedLap.set("uid1", 1);
    const msg = await checkDriverPositionChange("uid1", "HAM", [{ position: 2, driver_number: "44" }], { "44": 5 }, 10, 78, "Monaco");
    expect(msg).toContain("Hamilton");
  });
});

describe("processLivePositionUpdates branches", () => {
  test("!currentPositions => early return (branch[0])", async () => {
    await processLivePositionUpdates(null, {}, 10, 78, "Monaco", jest.fn());
  });
  test("empty positions => early return (branch[1])", async () => {
    await processLivePositionUpdates([], {}, 10, 78, "Monaco", jest.fn());
  });
  test("!currentLap => early return (branch[2])", async () => {
    await processLivePositionUpdates([{ position: 1 }], {}, 0, 78, "Monaco", jest.fn());
  });
  test("prefs sin adopted_driver => skip (!adopted_driver)", async () => {
    const db = {
      doc: makeDb().doc,
      collectionGroup: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => ({ notifications: true, uid: "u1" }) }] }),
      }),
    };
    adminMock.firestore.mockReturnValue(db);
    const send = jest.fn();
    await processLivePositionUpdates([{ position: 1, driver_number: "44" }], {}, 10, 78, "Monaco", send);
    expect(send).not.toHaveBeenCalled();
  });
  test("prefs sin uid => skip (!uid)", async () => {
    const db = {
      doc: makeDb().doc,
      collectionGroup: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => ({ notifications: true, adopted_driver: "HAM" }) }] }),
      }),
    };
    adminMock.firestore.mockReturnValue(db);
    await processLivePositionUpdates([{ position: 1 }], {}, 10, 78, "Monaco", jest.fn());
  });
  test("msg null => skip (!msg)", async () => {
    const db = {
      doc: jest.fn().mockImplementation(() => ({ get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }) })),
      collectionGroup: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => ({ notifications: true, adopted_driver: "HAM", uid: "u1" }) }] }),
      }),
    };
    adminMock.firestore.mockReturnValue(db);
    const send = jest.fn();
    await processLivePositionUpdates([{ position: 2, driver_number: "44" }], { "44": 2 }, 10, 78, "Monaco", send);
    expect(send).not.toHaveBeenCalled();
  });
  test("phone null => skip (!phone)", async () => {
    const db = {
      doc: jest.fn().mockImplementation((path) => ({
        get: jest.fn().mockResolvedValue(
          path.startsWith("f1_data")
            ? { exists: true, data: () => ({ name: "Hamilton", team: "Mercedes", number: "44" }) }
            : { data: () => null }
        ),
      })),
      collectionGroup: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => ({ notifications: true, adopted_driver: "HAM", uid: "u1" }) }] }),
      }),
    };
    adminMock.firestore.mockReturnValue(db);
    _lastNotifiedLap.set("u1", 1);
    const send = jest.fn();
    await processLivePositionUpdates([{ position: 2, driver_number: "44" }], { "44": 5 }, 10, 78, "Monaco", send);
    expect(send).not.toHaveBeenCalled();
  });
  test("happy path => send llamado", async () => {
    const db = {
      doc: jest.fn().mockImplementation((path) => ({
        get: jest.fn().mockResolvedValue(
          path.startsWith("f1_data")
            ? { exists: true, data: () => ({ name: "Hamilton", team: "Mercedes", number: "44" }) }
            : { data: () => ({ phone: "+1234" }) }
        ),
      })),
      collectionGroup: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [{ data: () => ({ notifications: true, adopted_driver: "HAM", uid: "u1" }) }] }),
      }),
    };
    adminMock.firestore.mockReturnValue(db);
    _lastNotifiedLap.set("u1", 1);
    const send = jest.fn().mockResolvedValue({});
    await processLivePositionUpdates([{ position: 2, driver_number: "44" }], { "44": 5 }, 10, 78, "Monaco", send);
    expect(send).toHaveBeenCalled();
  });
  test("db throw => catch error", async () => {
    adminMock.firestore.mockReturnValue({ collectionGroup: jest.fn().mockImplementation(() => { throw new Error("crash"); }) });
    await processLivePositionUpdates([{ position: 1 }], {}, 10, 78, "Monaco", jest.fn());
    expect(console.error).toHaveBeenCalled();
  });
  test("driver_number y number => actualiza prevPositions (if true branches)", async () => {
    const db = { collectionGroup: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) }) };
    adminMock.firestore.mockReturnValue(db);
    const prev = {};
    await processLivePositionUpdates([{ position: 3, driver_number: "44", number: "44" }, { position: 5 }], prev, 10, 78, "Monaco", jest.fn());
    expect(prev["44"]).toBe(3);
  });
  test("position sin driver_number ni number => no actualiza (if false branches)", async () => {
    const db = { collectionGroup: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) }) };
    adminMock.firestore.mockReturnValue(db);
    const prev = {};
    await processLivePositionUpdates([{ position: 3 }], prev, 10, 78, "Monaco", jest.fn());
    expect(Object.keys(prev).length).toBe(0);
  });
});
