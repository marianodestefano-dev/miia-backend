"use strict";

const sa = require("../core/super_admin");
const ffa = require("../core/feature_flags_admin");
const ba = require("../core/billing_admin");
const stm = require("../core/support_ticket_manager");
const cm = require("../core/content_moderation");
const bo = require("../core/bulk_operations");

const { SUPER_ADMIN_ROLES } = sa;
const { TICKET_STATUSES, TICKET_PRIORITIES } = stm;
const { SEVERITY_LEVELS, moderateContent } = cm;

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
  sa.__setFirestoreForTests(_db);
  ffa.__setFirestoreForTests(_db);
  ba.__setFirestoreForTests(_db);
  stm.__setFirestoreForTests(_db);
  cm.__setFirestoreForTests(_db);
  bo.__setFirestoreForTests(_db);
});

describe("Super Admin", () => {
  test("SA-1: SUPER_ADMIN_ROLES frozen", () => {
    expect(Object.isFrozen(SUPER_ADMIN_ROLES)).toBe(true);
    expect(SUPER_ADMIN_ROLES).toContain("super_admin");
    expect(SUPER_ADMIN_ROLES).toContain("support");
  });

  test("SA-2: getSystemStats returns required fields", async () => {
    const stats = await sa.getSystemStats();
    expect(stats).toHaveProperty("totalOwners");
    expect(stats).toHaveProperty("totalLeads");
    expect(stats).toHaveProperty("totalMrr");
    expect(stats).toHaveProperty("timestamp");
  });

  test("SA-3: isSuperAdmin returns false for unknown uid", async () => {
    const result = await sa.isSuperAdmin("unknown-uid");
    expect(result).toBe(false);
  });

  test("SA-4: getAllOwners returns array", async () => {
    const owners = await sa.getAllOwners({ limit: 10 });
    expect(Array.isArray(owners)).toBe(true);
  });
});

describe("Feature Flags Admin", () => {
  test("FF-1: setFlag creates global flag", async () => {
    const flag = await ffa.setFlag("new_dashboard", true);
    expect(flag.name).toBe("new_dashboard");
    expect(flag.value).toBe(true);
    expect(flag.scope).toBe("global");
  });

  test("FF-2: setFlag creates owner-scoped flag", async () => {
    const flag = await ffa.setFlag("beta_feature", true, { ownerUid: "uid1" });
    expect(flag.ownerUid).toBe("uid1");
  });

  test("FF-3: getFlag returns false for unset flag", async () => {
    const value = await ffa.getFlag("nonexistent_flag");
    expect(value).toBe(false);
  });

  test("FF-4: listFlags returns object", async () => {
    const flags = await ffa.listFlags("uid1");
    expect(typeof flags).toBe("object");
  });
});

describe("Billing Admin", () => {
  test("BA-1: issueRefund requires positive amount", async () => {
    await expect(ba.issueRefund("pay-1", -10, "test")).rejects.toThrow("positive amount");
  });

  test("BA-2: issueRefund creates refund record", async () => {
    const refund = await ba.issueRefund("pay-1", 50.00, "customer request");
    expect(refund.id).toBeDefined();
    expect(refund.amount).toBe(50.00);
    expect(refund.status).toBe("processed");
  });

  test("BA-3: changePlan validates plan name", async () => {
    await expect(ba.changePlan("uid1", "superplan")).rejects.toThrow("invalid plan");
  });

  test("BA-4: changePlan updates owner plan", async () => {
    const result = await ba.changePlan("uid1", "pro");
    expect(result.plan).toBe("pro");
  });
});

describe("Support Ticket Manager", () => {
  test("TK-1: TICKET_STATUSES and TICKET_PRIORITIES frozen", () => {
    expect(Object.isFrozen(TICKET_STATUSES)).toBe(true);
    expect(Object.isFrozen(TICKET_PRIORITIES)).toBe(true);
    expect(TICKET_STATUSES.OPEN).toBe("open");
    expect(TICKET_PRIORITIES.URGENT).toBe("urgent");
  });

  test("TK-2: createTicket requires uid, subject, description", async () => {
    await expect(stm.createTicket("uid1", { subject: "Help" })).rejects.toThrow("description required");
  });

  test("TK-3: createTicket creates open ticket", async () => {
    const ticket = await stm.createTicket("uid1", { subject: "Need help", description: "Cannot login" });
    expect(ticket.id).toBeDefined();
    expect(ticket.status).toBe("open");
    expect(ticket.priority).toBe("medium");
  });

  test("TK-4: closeTicket marks as resolved", async () => {
    const result = await stm.closeTicket("ticket-1", "Fixed");
    expect(result.status).toBe("resolved");
  });
});

describe("Content Moderation", () => {
  test("CM-1: SEVERITY_LEVELS frozen", () => {
    expect(Object.isFrozen(SEVERITY_LEVELS)).toBe(true);
    expect(SEVERITY_LEVELS.HIGH).toBe("high");
    expect(SEVERITY_LEVELS.LOW).toBe("low");
  });

  test("CM-2: moderateContent returns not flagged for clean text", () => {
    const r = moderateContent("hola como estas, que precio tiene?");
    expect(r.flagged).toBe(false);
  });

  test("CM-3: moderateContent flags abusive content", () => {
    const r = moderateContent("esto es un fraude y una estafa");
    expect(r.flagged).toBe(true);
    expect(r.severity).toBeDefined();
  });

  test("CM-4: checkAndFlag returns result", async () => {
    const r = await cm.checkAndFlag("uid1", "5491100000000", "mensaje normal sin problemas");
    expect(r.flagged).toBe(false);
  });
});

describe("Bulk Operations", () => {
  test("BO-1: broadcastToAllOwners requires message", async () => {
    await expect(bo.broadcastToAllOwners("")).rejects.toThrow("message required");
  });

  test("BO-2: broadcastToAllOwners returns batchId and count", async () => {
    const result = await bo.broadcastToAllOwners("Actualizacion importante");
    expect(result.batchId).toBeDefined();
    expect(result.status).toBe("queued");
  });

  test("BO-3: changePlanBulk validates plan", async () => {
    await expect(bo.changePlanBulk(["uid1"], "megaplan")).rejects.toThrow("invalid plan");
  });

  test("BO-4: changePlanBulk updates all owners", async () => {
    const result = await bo.changePlanBulk(["uid1", "uid2"], "pro");
    expect(result.updated).toBe(2);
    expect(result.plan).toBe("pro");
  });
});
