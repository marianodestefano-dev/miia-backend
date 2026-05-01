"use strict";

const {
  buildHandoffContext, initiateEscalation, assignTicket,
  resolveTicket, getTicket, getOpenTickets, isLeadInEscalation,
  ESCALATION_REASONS, AGENT_STATES, TICKET_STATES, DEFAULT_TIMEOUT_MINS,
  __setFirestoreForTests, __setNotifyFnForTests,
} = require("../core/human_agent_router");

const UID = "testUid1234567890";
const PHONE = "+541155667788";
const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var ticketDoc = opts.ticketDoc || null;
  var ticketDocs = opts.ticketDocs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var innerTicketDoc = {
    set: async function(data, setOpts) { if (throwSet) throw new Error("set error"); },
    get: async function() {
      if (throwGet) throw new Error("get error");
      return { exists: !!ticketDoc, data: function() { return ticketDoc; } };
    },
  };

  var innerColl = {
    doc: function() { return innerTicketDoc; },
    where: function() {
      return {
        where: function() {
          return {
            get: async function() {
              if (throwGet) throw new Error("get error");
              return { forEach: function(fn) { ticketDocs.forEach(function(d, i) { fn({ data: function() { return d; }, id: "t" + i }); }); } };
            },
          };
        },
        get: async function() {
          if (throwGet) throw new Error("get error");
          return { forEach: function(fn) { ticketDocs.forEach(function(d, i) { fn({ data: function() { return d; }, id: "t" + i }); }); } };
        },
      };
    },
  };

  var uidDoc = { collection: function() { return innerColl; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() {
  __setFirestoreForTests(null);
  __setNotifyFnForTests(null);
});
afterEach(function() {
  __setFirestoreForTests(null);
  __setNotifyFnForTests(null);
});

describe("ESCALATION_REASONS y constants", function() {
  test("tiene tipos principales", function() {
    expect(ESCALATION_REASONS).toContain("complaint");
    expect(ESCALATION_REASONS).toContain("owner_request");
    expect(ESCALATION_REASONS).toContain("emergency");
  });
  test("frozen", function() { expect(function() { ESCALATION_REASONS[0] = "x"; }).toThrow(); });
  test("DEFAULT_TIMEOUT_MINS es 30", function() { expect(DEFAULT_TIMEOUT_MINS).toBe(30); });
  test("TICKET_STATES tiene open y resolved", function() {
    expect(TICKET_STATES).toContain("open");
    expect(TICKET_STATES).toContain("resolved");
  });
});

describe("buildHandoffContext", function() {
  test("lanza si lead sin phone", function() {
    expect(function() { buildHandoffContext({}, []); }).toThrow("phone requerido");
  });
  test("retorna contexto con leadPhone", function() {
    const r = buildHandoffContext({ phone: PHONE, name: "Juan" }, [{ text: "hola" }], "complaint");
    expect(r.leadPhone).toBe(PHONE);
    expect(r.reason).toBe("complaint");
    expect(r.recentMessages.length).toBe(1);
  });
  test("limita a 10 mensajes recientes", function() {
    var msgs = Array.from({ length: 20 }, function(_, i) { return { text: "msg" + i }; });
    const r = buildHandoffContext({ phone: PHONE }, msgs);
    expect(r.recentMessages.length).toBe(10);
  });
  test("messageCount cuenta total", function() {
    var msgs = Array.from({ length: 15 }, function(_, i) { return { text: "m" + i }; });
    const r = buildHandoffContext({ phone: PHONE }, msgs);
    expect(r.messageCount).toBe(15);
  });
});

describe("initiateEscalation", function() {
  test("lanza si uid undefined", async function() {
    await expect(initiateEscalation(undefined, PHONE)).rejects.toThrow("uid requerido");
  });
  test("lanza si leadPhone undefined", async function() {
    await expect(initiateEscalation(UID, undefined)).rejects.toThrow("leadPhone requerido");
  });
  test("lanza si reason invalido", async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(initiateEscalation(UID, PHONE, { reason: "motivo_falso" })).rejects.toThrow("invalido");
  });
  test("crea ticket con campos correctos", async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await initiateEscalation(UID, PHONE, { reason: "complaint" });
    expect(r.ticketId).toBeDefined();
    expect(r.state).toBe("open");
    expect(r.reason).toBe("complaint");
  });
  test("llama notifyFn si existe", async function() {
    var called = false;
    __setFirestoreForTests(makeMockDb());
    __setNotifyFnForTests(async function() { called = true; });
    await initiateEscalation(UID, PHONE);
    expect(called).toBe(true);
  });
  test("propaga error Firestore", async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(initiateEscalation(UID, PHONE)).rejects.toThrow("set error");
  });
});

describe("assignTicket", function() {
  test("lanza si uid undefined", async function() {
    await expect(assignTicket(undefined, "t1", "agent1")).rejects.toThrow("uid requerido");
  });
  test("lanza si ticketId undefined", async function() {
    await expect(assignTicket(UID, undefined, "agent1")).rejects.toThrow("ticketId requerido");
  });
  test("lanza si agentId undefined", async function() {
    await expect(assignTicket(UID, "t1", undefined)).rejects.toThrow("agentId requerido");
  });
  test("asigna sin error", async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(assignTicket(UID, "t1", "agent1")).resolves.toBeUndefined();
  });
});

describe("resolveTicket", function() {
  test("lanza si uid undefined", async function() {
    await expect(resolveTicket(undefined, "t1")).rejects.toThrow("uid requerido");
  });
  test("retorna ticketId y resolvedAt", async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await resolveTicket(UID, "t1");
    expect(r.ticketId).toBe("t1");
    expect(r.resolvedAt).toBeDefined();
  });
});

describe("getTicket", function() {
  test("lanza si uid undefined", async function() {
    await expect(getTicket(undefined, "t1")).rejects.toThrow("uid requerido");
  });
  test("retorna null si ticket no existe", async function() {
    __setFirestoreForTests(makeMockDb({ ticketDoc: null }));
    const r = await getTicket(UID, "t1");
    expect(r).toBeNull();
  });
  test("retorna datos del ticket", async function() {
    var ticket = { ticketId: "t1", state: "open", leadPhone: PHONE };
    __setFirestoreForTests(makeMockDb({ ticketDoc: ticket }));
    const r = await getTicket(UID, "t1");
    expect(r.state).toBe("open");
  });
});

describe("getOpenTickets", function() {
  test("lanza si uid undefined", async function() {
    await expect(getOpenTickets(undefined)).rejects.toThrow("uid requerido");
  });
  test("retorna array vacio si no hay tickets", async function() {
    __setFirestoreForTests(makeMockDb({ ticketDocs: [] }));
    const r = await getOpenTickets(UID);
    expect(r).toEqual([]);
  });
  test("fail-open retorna vacio si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getOpenTickets(UID);
    expect(r).toEqual([]);
  });
});

describe("isLeadInEscalation", function() {
  test("lanza si uid undefined", async function() {
    await expect(isLeadInEscalation(undefined, PHONE)).rejects.toThrow("uid requerido");
  });
  test("retorna false si no hay escalaciones activas", async function() {
    __setFirestoreForTests(makeMockDb({ ticketDocs: [] }));
    const r = await isLeadInEscalation(UID, PHONE);
    expect(r).toBe(false);
  });
  test("fail-open retorna false si Firestore falla", async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await isLeadInEscalation(UID, PHONE);
    expect(r).toBe(false);
  });
});
