"use strict";

const {
  resolveIncomingContext, saveContextSession, getContextSession,
  getContextForLead, buildContextPromptHint,
  CONTEXT_TYPES, DEFAULT_CONTEXT,
  __setFirestoreForTests,
} = require("../core/number_context_router");

const UID = "testUid1234567890";
const PHONE = "+541155667788";
const INCOMING = "+573054169969";
const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var numbersDoc = opts.numbersDoc || null;
  var sessionDoc = opts.sessionDoc || null;
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var sessionsColl = {
    doc: function() {
      return {
        set: async function(data, setOpts) {
          if (throwSet) throw new Error("set error");
        },
        get: async function() {
          if (throwGet) throw new Error("get error");
          return { exists: !!sessionDoc, data: function() { return sessionDoc; } };
        },
      };
    },
  };

  var numbersColl = {
    where: function() {
      return {
        where: function() {
          return {
            get: async function() {
              if (throwGet) throw new Error("get error");
              var items = numbersDoc ? [{ data: function() { return numbersDoc; } }] : [];
              return { forEach: function(fn) { items.forEach(fn); } };
            },
          };
        },
      };
    },
  };

  var collMap = { registered_numbers: numbersColl, context_sessions: sessionsColl };
  var uidDoc = { collection: function(name) { return collMap[name] || sessionsColl; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe("CONTEXT_TYPES y constants", function() {
  test("tiene los tipos principales", function() {
    expect(CONTEXT_TYPES).toContain("sales");
    expect(CONTEXT_TYPES).toContain("support");
    expect(CONTEXT_TYPES).toContain("general");
  });
  test("frozen", function() { expect(function() { CONTEXT_TYPES[0] = "x"; }).toThrow(); });
  test("DEFAULT_CONTEXT es general", function() { expect(DEFAULT_CONTEXT).toBe("general"); });
});

describe("buildContextPromptHint", function() {
  test("retorna hint para sales", function() {
    const h = buildContextPromptHint("sales");
    expect(h.length).toBeGreaterThan(0);
  });
  test("retorna hint para support", function() {
    const h = buildContextPromptHint("support");
    expect(h.length).toBeGreaterThan(0);
  });
  test("fallback a general para rol desconocido", function() {
    const h = buildContextPromptHint("rol_raro");
    const g = buildContextPromptHint("general");
    expect(h).toBe(g);
  });
});

describe("resolveIncomingContext", function() {
  test("lanza si uid undefined", async function() {
    await expect(resolveIncomingContext(undefined, INCOMING, PHONE)).rejects.toThrow("uid requerido");
  });
  test("lanza si incomingPhone undefined", async function() {
    await expect(resolveIncomingContext(UID, undefined, PHONE)).rejects.toThrow("incomingPhone requerido");
  });
  test("lanza si leadPhone undefined", async function() {
    await expect(resolveIncomingContext(UID, INCOMING, undefined)).rejects.toThrow("leadPhone requerido");
  });
  test("retorna default si numero no registrado", async function() {
    __setFirestoreForTests(makeMockDb({ numbersDoc: null }));
    const r = await resolveIncomingContext(UID, INCOMING, PHONE);
    expect(r.context).toBe(DEFAULT_CONTEXT);
    expect(r.numberConfig).toBeNull();
  });
  test("retorna contexto del numero registrado", async function() {
    __setFirestoreForTests(makeMockDb({ numbersDoc: { phone: INCOMING, role: "sales", active: true } }));
    const r = await resolveIncomingContext(UID, INCOMING, PHONE);
    expect(r.context).toBe("sales");
    expect(r.numberConfig).toBeDefined();
  });
  test("fail-open retorna default si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await resolveIncomingContext(UID, INCOMING, PHONE);
    expect(r.context).toBe(DEFAULT_CONTEXT);
  });
});

describe("saveContextSession", function() {
  test("lanza si uid undefined", async function() {
    await expect(saveContextSession(undefined, PHONE, INCOMING, "sales")).rejects.toThrow("uid requerido");
  });
  test("lanza si context undefined", async function() {
    await expect(saveContextSession(UID, PHONE, INCOMING, undefined)).rejects.toThrow("context requerido");
  });
  test("guarda sin error", async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(saveContextSession(UID, PHONE, INCOMING, "sales")).resolves.toBeUndefined();
  });
  test("propaga error Firestore", async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveContextSession(UID, PHONE, INCOMING, "sales")).rejects.toThrow("set error");
  });
});

describe("getContextSession", function() {
  test("lanza si uid undefined", async function() {
    await expect(getContextSession(undefined, PHONE)).rejects.toThrow("uid requerido");
  });
  test("retorna null si no hay sesion", async function() {
    __setFirestoreForTests(makeMockDb({ sessionDoc: null }));
    const r = await getContextSession(UID, PHONE);
    expect(r).toBeNull();
  });
  test("retorna sesion existente", async function() {
    var session = { context: "support", leadPhone: PHONE };
    __setFirestoreForTests(makeMockDb({ sessionDoc: session }));
    const r = await getContextSession(UID, PHONE);
    expect(r.context).toBe("support");
  });
  test("fail-open retorna null si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getContextSession(UID, PHONE);
    expect(r).toBeNull();
  });
});

describe("getContextForLead", function() {
  test("lanza si uid undefined", async function() {
    await expect(getContextForLead(undefined, PHONE)).rejects.toThrow("uid requerido");
  });
  test("lanza si leadPhone undefined", async function() {
    await expect(getContextForLead(UID, undefined)).rejects.toThrow("leadPhone requerido");
  });
  test("usa sesion existente si hay", async function() {
    var session = { context: "vip", leadPhone: PHONE };
    __setFirestoreForTests(makeMockDb({ sessionDoc: session }));
    const r = await getContextForLead(UID, PHONE, INCOMING);
    expect(r.context).toBe("vip");
    expect(r.source).toBe("session");
  });
  test("resuelve por numero si no hay sesion", async function() {
    __setFirestoreForTests(makeMockDb({ sessionDoc: null, numbersDoc: { phone: INCOMING, role: "delivery", active: true } }));
    const r = await getContextForLead(UID, PHONE, INCOMING);
    expect(r.context).toBe("delivery");
    expect(r.source).toBe("number");
  });
  test("fallback a default si no hay sesion ni numero", async function() {
    __setFirestoreForTests(makeMockDb({ sessionDoc: null, numbersDoc: null }));
    const r = await getContextForLead(UID, PHONE);
    expect(r.context).toBe(DEFAULT_CONTEXT);
    expect(r.source).toBe("default");
  });
});
