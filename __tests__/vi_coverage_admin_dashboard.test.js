"use strict";

const {
  __setFirestoreForTests, ADMIN_ACTIONS, AUDIT_SEVERITY,
  getAllTenants, suspendTenant, activateTenant, logAdminAction,
  getAuditLogs, getTenantStats, getGlobalStats,
} = require("../core/admin_dashboard");

const ADMIN_UID = "adminUid";
const TARGET_UID = "targetUid";

function makeDb({ tenants = [], auditDocs = [], ownerData = null } = {}) {
  return {
    collection: jest.fn().mockImplementation((col) => ({
      get: jest.fn().mockResolvedValue({
        forEach: (fn) => {
          const docs = col === "owners" ? tenants : auditDocs;
          docs.forEach((d) => fn({ id: d.uid || "uid1", data: () => d }));
        },
      }),
      doc: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue(
          ownerData != null ? { exists: true, data: () => ownerData } : { exists: false, data: () => ({}) }
        ),
      })),
    })),
  };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  __setFirestoreForTests(null);
  jest.restoreAllMocks();
});

describe("Constantes", () => {
  test("ADMIN_ACTIONS frozen", () => { expect(() => ADMIN_ACTIONS.push("x")).toThrow(); });
  test("AUDIT_SEVERITY frozen", () => { expect(() => AUDIT_SEVERITY.push("x")).toThrow(); });
});

describe("getAllTenants", () => {
  test("filtros null => todos (filters || {} falsy branch)", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{ status: "active" }] }));
    const r = await getAllTenants(null);
    expect(r.length).toBe(1);
  });
  test("filtro status match => incluye (if false branch)", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{ status: "active" }] }));
    const r = await getAllTenants({ status: "active" });
    expect(r.length).toBe(1);
  });
  test("filtro status no match => excluye (if true branch)", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{ status: "active" }] }));
    const r = await getAllTenants({ status: "suspended" });
    expect(r.length).toBe(0);
  });
  test("sin businessName => Sin nombre (|| branch)", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{}] }));
    const r = await getAllTenants({});
    expect(r[0].businessName).toBe("Sin nombre");
  });
  test("con businessName fallback (|| branch[1])", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{ businessName: "Mi Negocio" }] }));
    const r = await getAllTenants({});
    expect(r[0].businessName).toBe("Mi Negocio");
  });
  test("con business_name (|| branch[0])", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{ business_name: "Empresa SA" }] }));
    const r = await getAllTenants({});
    expect(r[0].businessName).toBe("Empresa SA");
  });
  test("sin phone ni status ni createdAt => defaults", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{}] }));
    const r = await getAllTenants({});
    expect(r[0].phone).toBeNull();
    expect(r[0].status).toBe("active");
    expect(r[0].createdAt).toBeNull();
  });
});

describe("suspendTenant", () => {
  test("sin reason => reason null pasado literalmente", async () => {
    __setFirestoreForTests(makeDb());
    const r = await suspendTenant(ADMIN_UID, TARGET_UID, null);
    expect(r.suspended).toBe(true);
  });
});

describe("logAdminAction severity branches", () => {
  beforeEach(() => { __setFirestoreForTests(makeDb()); });
  test("action invalida => throw", async () => {
    await expect(logAdminAction(ADMIN_UID, "bad_action", TARGET_UID, {})).rejects.toThrow("Invalid admin action");
  });
  test("suspend_tenant => severity critical (|| branch)", async () => {
    const r = await logAdminAction(ADMIN_UID, "suspend_tenant", TARGET_UID, {});
    expect(r.severity).toBe("critical");
  });
  test("force_logout => severity critical", async () => {
    const r = await logAdminAction(ADMIN_UID, "force_logout", TARGET_UID, {});
    expect(r.severity).toBe("critical");
  });
  test("reset_quota => severity warning (nested cond)", async () => {
    const r = await logAdminAction(ADMIN_UID, "reset_quota", TARGET_UID, {});
    expect(r.severity).toBe("warning");
  });
  test("view_audit => severity info (else branch)", async () => {
    const r = await logAdminAction(ADMIN_UID, "view_audit", TARGET_UID, {});
    expect(r.severity).toBe("info");
  });
  test("details null => {} (details || {} falsy)", async () => {
    const r = await logAdminAction(ADMIN_UID, "view_audit", TARGET_UID, null);
    expect(r.details).toEqual({});
  });
});

describe("getAuditLogs", () => {
  const log1 = { action: "suspend_tenant", targetUid: TARGET_UID, severity: "critical", loggedAt: "2026-05-01T10:00:00Z" };
  const log2 = { action: "view_audit", targetUid: "other", severity: "info", loggedAt: "2026-05-02T10:00:00Z" };
  test("sin filtros => todos (filters || {} null branch)", async () => {
    __setFirestoreForTests(makeDb({ auditDocs: [log1, log2] }));
    const r = await getAuditLogs(null);
    expect(r.length).toBe(2);
  });
  test("filtro targetUid excluye no match (if true branch L50)", async () => {
    __setFirestoreForTests(makeDb({ auditDocs: [log1] }));
    const r = await getAuditLogs({ targetUid: "otro" });
    expect(r.length).toBe(0);
  });
  test("filtro action excluye no match (if true branch L51)", async () => {
    __setFirestoreForTests(makeDb({ auditDocs: [log1, log2] }));
    const r = await getAuditLogs({ action: "activate_tenant" });
    expect(r.length).toBe(0);
  });
  test("filtro severity excluye no match", async () => {
    __setFirestoreForTests(makeDb({ auditDocs: [log1, log2] }));
    const r = await getAuditLogs({ severity: "warning" });
    expect(r.length).toBe(0);
  });
});

describe("getTenantStats", () => {
  test("doc no existe => defaults Sin nombre + active (cond-expr false branch)", async () => {
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
          set: jest.fn().mockResolvedValue({}),
        }),
        get: jest.fn().mockResolvedValue({ forEach: () => {} }),
      }),
    };
    __setFirestoreForTests(db);
    const r = await getTenantStats(TARGET_UID);
    expect(r.businessName).toBe("Sin nombre");
    expect(r.status).toBe("active");
  });
  test("doc existe suspended => status suspended (cond-expr true branch)", async () => {
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ business_name: "Biz", suspended: true, messages_today: 5, active_leads: 3 }),
          }),
          set: jest.fn().mockResolvedValue({}),
        }),
        get: jest.fn().mockResolvedValue({ forEach: () => {} }),
      }),
    };
    __setFirestoreForTests(db);
    const r = await getTenantStats(TARGET_UID);
    expect(r.status).toBe("suspended");
    expect(r.messagesTODAY).toBe(5);
  });
});

describe("getGlobalStats", () => {
  test("mix suspended y activos", async () => {
    __setFirestoreForTests(makeDb({ tenants: [{ suspended: true }, { suspended: false }, {}] }));
    const r = await getGlobalStats();
    expect(r.totalTenants).toBe(3);
    expect(r.suspendedTenants).toBe(1);
    expect(r.activeTenants).toBe(2);
  });
});
