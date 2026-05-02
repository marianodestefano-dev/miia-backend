"use strict";

function makeDoc(data) { return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : "doc1" }; }
function makeSnap(docs) { const w = docs.map(d => ({ id: d.id || "x", data: () => d })); return { forEach: fn => w.forEach(fn), size: docs.length, empty: !docs.length }; }
function makeCol(docs) { docs = docs || []; const snap = makeSnap(docs); return { doc: id => ({ get: async () => makeDoc(docs.find(d => d.id === id) || null), set: async () => {}, collection: () => makeCol([]) }), where: () => ({ get: async () => snap }), get: async () => snap }; }

const ad = require("../core/agent_dashboard");

describe("agent_dashboard -- T420", () => {
  test("AGENT_PERMISSIONS frozen with 6 permissions", () => {
    expect(Object.isFrozen(ad.AGENT_PERMISSIONS)).toBe(true);
    expect(ad.AGENT_PERMISSIONS.length).toBe(6);
    expect(ad.AGENT_PERMISSIONS).toContain("approve_actions");
  });
  test("createAgentProfile -- default permissions view+reply", async () => {
    ad.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ad.createAgentProfile("uid1", "+57300", { name: "Ana" });
    expect(r.agentPhone).toBe("+57300");
    expect(r.permissions).toContain("view_conversations");
    expect(r.status).toBe("active");
  });
  test("createAgentProfile -- filters invalid permissions", async () => {
    ad.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ad.createAgentProfile("uid1", "+57300", { permissions: ["reply", "fly"] });
    expect(r.permissions).toEqual(["reply"]);
  });
  test("getAgentPermissions -- not found throws", async () => {
    ad.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) });
    await expect(ad.getAgentPermissions("uid1", "+57300")).rejects.toThrow("Agent not found");
  });
  test("approveAction -- valid decision approved", async () => {
    const agentDoc = { id: "uid1_+57300", permissions: ["approve_actions"] };
    const db = { collection: name => name === "agents" ? { doc: () => ({ get: async () => makeDoc(agentDoc) }) } : { doc: () => ({ set: async () => {} }) } };
    ad.__setFirestoreForTests(db);
    const r = await ad.approveAction("uid1", "+57300", "action1", "approved");
    expect(r.decision).toBe("approved");
  });
  test("approveAction -- invalid decision throws", async () => {
    ad.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ad.approveAction("uid1", "+57300", "a1", "maybe")).rejects.toThrow("Invalid decision");
  });
  test("approveAction -- missing permission throws", async () => {
    const agentDoc = { id: "uid1_+57300", permissions: ["reply"] };
    ad.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(agentDoc) }) }) });
    await expect(ad.approveAction("uid1", "+57300", "a1", "approved")).rejects.toThrow("lacks approve_actions");
  });
  test("updateAgentPermissions -- invalid permission throws", async () => {
    ad.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ad.updateAgentPermissions("uid1", "+57300", ["fly"])).rejects.toThrow("Invalid permissions");
  });
  test("getAgentDashboardStats -- counts approved and rejected", async () => {
    const decisions = [{ id: "d1", agentPhone: "+57300", decision: "approved" }, { id: "d2", agentPhone: "+57300", decision: "rejected" }];
    ad.__setFirestoreForTests({ collection: () => makeCol(decisions) });
    const r = await ad.getAgentDashboardStats("uid1", "+57300");
    expect(r.actionsApproved).toBe(1);
    expect(r.actionsRejected).toBe(1);
    expect(r.totalDecisions).toBe(2);
  });
});

const ar = require("../core/agent_registry");

describe("agent_registry -- T421", () => {
  test("INVITE_STATUS frozen with 4 statuses", () => {
    expect(Object.isFrozen(ar.INVITE_STATUS)).toBe(true);
    expect(ar.INVITE_STATUS.length).toBe(4);
    expect(ar.INVITE_STATUS).toContain("revoked");
  });
  test("INVITE_TTL_HOURS is 72", () => {
    expect(ar.INVITE_TTL_HOURS).toBe(72);
  });
  test("generateAgentInviteLink -- creates invite with token and url", async () => {
    ar.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ar.generateAgentInviteLink("uid1", { role: "agent" });
    expect(r.token).toBeDefined();
    expect(r.inviteUrl).toContain("miia-app.com/join/");
    expect(r.status).toBe("pending");
  });
  test("acceptAgentInvite -- invalid token throws", async () => {
    ar.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([]) }) }) });
    await expect(ar.acceptAgentInvite("badtoken", "+57300")).rejects.toThrow("Invalid invite token");
  });
  test("acceptAgentInvite -- valid token accepts", async () => {
    const inv = { id: "inv1", uid: "uid1", token: "tok1", status: "pending", expiresAt: new Date(Date.now() + 3600000).toISOString(), permissions: ["reply"] };
    ar.__setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => makeSnap([inv]) }), doc: () => ({ set: async () => {} }) }) });
    const r = await ar.acceptAgentInvite("tok1", "+57999");
    expect(r.status).toBe("accepted");
    expect(r.agentPhone).toBe("+57999");
  });
  test("revokeAgentInvite -- unauthorized uid throws", async () => {
    const invite = { id: "inv1", uid: "uid1" };
    ar.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(invite), set: async () => {} }) }) });
    await expect(ar.revokeAgentInvite("uid99", "inv1")).rejects.toThrow("Unauthorized");
  });
  test("revokeAgentInvite -- owner revokes successfully", async () => {
    const invite = { id: "inv1", uid: "uid1" };
    ar.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(invite), set: async () => {} }) }) });
    const r = await ar.revokeAgentInvite("uid1", "inv1");
    expect(r.status).toBe("revoked");
  });
  test("removeAgent -- sets status inactive", async () => {
    ar.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ar.removeAgent("uid1", "+57300");
    expect(r.status).toBe("inactive");
  });
});

const em = require("../core/enterprise_manager");

describe("enterprise_manager -- T422", () => {
  test("ENTERPRISE_STATUS frozen with 4 statuses", () => {
    expect(Object.isFrozen(em.ENTERPRISE_STATUS)).toBe(true);
    expect(em.ENTERPRISE_STATUS.length).toBe(4);
    expect(em.ENTERPRISE_STATUS).toContain("trial");
  });
  test("BILLING_CYCLES frozen monthly and annual", () => {
    expect(Object.isFrozen(em.BILLING_CYCLES)).toBe(true);
    expect(em.BILLING_CYCLES).toContain("monthly");
    expect(em.BILLING_CYCLES).toContain("annual");
  });
  test("createEnterprise -- no name throws", async () => {
    em.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(em.createEnterprise("uid1", {})).rejects.toThrow("name required");
  });
  test("createEnterprise -- invalid billing cycle throws", async () => {
    em.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(em.createEnterprise("uid1", { name: "Corp", billingCycle: "weekly" })).rejects.toThrow("Invalid billing cycle");
  });
  test("createEnterprise -- creates with trial status", async () => {
    em.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await em.createEnterprise("uid1", { name: "Corp LATAM", seats: 10 });
    expect(r.status).toBe("trial");
    expect(r.ownerUids).toContain("uid1");
    expect(r.seats).toBe(10);
  });
  test("addEnterpriseOwner -- seats full throws", async () => {
    const ent = { id: "e1", seats: 2, ownerUids: ["uid1", "uid2"] };
    em.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(ent), set: async () => {} }) }) });
    await expect(em.addEnterpriseOwner("e1", "uid3")).rejects.toThrow("seats full");
  });
  test("addEnterpriseOwner -- adds new owner", async () => {
    const ent = { id: "e1", seats: 5, ownerUids: ["uid1"] };
    em.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(ent), set: async () => {} }) }) });
    const r = await em.addEnterpriseOwner("e1", "uid2");
    expect(r.totalOwners).toBe(2);
  });
  test("suspendEnterprise -- sets status suspended", async () => {
    em.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await em.suspendEnterprise("e1", "payment_failure");
    expect(r.status).toBe("suspended");
  });
  test("getEnterpriseSummary -- not found throws", async () => {
    em.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) });
    await expect(em.getEnterpriseSummary("e_none")).rejects.toThrow("not found");
  });
});

const elf = require("../core/enterprise_lead_flow");

describe("enterprise_lead_flow -- T423", () => {
  test("FLOW_STAGES frozen with 6 stages", () => {
    expect(Object.isFrozen(elf.FLOW_STAGES)).toBe(true);
    expect(elf.FLOW_STAGES.length).toBe(6);
    expect(elf.FLOW_STAGES[0]).toBe("captured");
    expect(elf.FLOW_STAGES[4]).toBe("converted");
  });
  test("QUALIFY_THRESHOLD is 60", () => {
    expect(elf.QUALIFY_THRESHOLD).toBe(60);
  });
  test("captureEnterpriseLead -- creates lead in captured stage", async () => {
    elf.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await elf.captureEnterpriseLead("ent1", { phone: "+57300", name: "Maria" });
    expect(r.stage).toBe("captured");
    expect(r.score).toBe(0);
  });
  test("qualifyLead -- score 70 = qualified", async () => {
    elf.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await elf.qualifyLead("ent1", "lead1", 70);
    expect(r.stage).toBe("qualified");
    expect(r.qualified).toBe(true);
  });
  test("qualifyLead -- score 40 = not qualified", async () => {
    elf.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await elf.qualifyLead("ent1", "lead1", 40);
    expect(r.stage).toBe("captured");
    expect(r.qualified).toBe(false);
  });
  test("qualifyLead -- score out of range throws", async () => {
    elf.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(elf.qualifyLead("ent1", "lead1", 150)).rejects.toThrow("Score must be 0-100");
  });
  test("assignLeadToOwner -- lead not found throws", async () => {
    elf.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) });
    await expect(elf.assignLeadToOwner("ent1", "lead_x", "uid1")).rejects.toThrow("Lead not found");
  });
  test("assignLeadToOwner -- sets assigned stage", async () => {
    const lead = { id: "lead1", stage: "qualified" };
    elf.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(lead), set: async () => {} }) }) });
    const r = await elf.assignLeadToOwner("ent1", "lead1", "uid1");
    expect(r.stage).toBe("assigned");
    expect(r.assignedTo).toBe("uid1");
  });
  test("updateLeadStage -- invalid stage throws", async () => {
    elf.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(elf.updateLeadStage("ent1", "lead1", "dreaming")).rejects.toThrow("Invalid stage");
  });
  test("getEnterpriseLeadFunnel -- counts by stage", async () => {
    const leads = [{ id: "l1", stage: "captured" }, { id: "l2", stage: "qualified" }, { id: "l3", stage: "captured" }];
    elf.__setFirestoreForTests({ collection: () => makeCol(leads) });
    const r = await elf.getEnterpriseLeadFunnel("ent1");
    expect(r.funnel.captured).toBe(2);
    expect(r.funnel.qualified).toBe(1);
    expect(r.total).toBe(3);
  });
});

const adm = require("../core/admin_dashboard");

describe("admin_dashboard -- T424", () => {
  test("ADMIN_ACTIONS frozen with 5 actions", () => {
    expect(Object.isFrozen(adm.ADMIN_ACTIONS)).toBe(true);
    expect(adm.ADMIN_ACTIONS.length).toBe(5);
    expect(adm.ADMIN_ACTIONS).toContain("suspend_tenant");
  });
  test("AUDIT_SEVERITY frozen info/warning/critical", () => {
    expect(Object.isFrozen(adm.AUDIT_SEVERITY)).toBe(true);
    expect(adm.AUDIT_SEVERITY).toContain("critical");
  });
  test("logAdminAction -- invalid action throws", async () => {
    adm.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(adm.logAdminAction("admin1", "delete_everything", "uid1", {})).rejects.toThrow("Invalid admin action");
  });
  test("logAdminAction -- suspend_tenant gets critical severity", async () => {
    adm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await adm.logAdminAction("admin1", "suspend_tenant", "uid1", { reason: "abuse" });
    expect(r.severity).toBe("critical");
    expect(r.action).toBe("suspend_tenant");
  });
  test("logAdminAction -- view_audit gets info severity", async () => {
    adm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await adm.logAdminAction("admin1", "view_audit", "uid1", {});
    expect(r.severity).toBe("info");
  });
  test("suspendTenant -- sets suspended true", async () => {
    adm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await adm.suspendTenant("admin1", "uid1", "spam");
    expect(r.suspended).toBe(true);
    expect(r.reason).toBe("spam");
  });
  test("activateTenant -- sets suspended false", async () => {
    adm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await adm.activateTenant("admin1", "uid1");
    expect(r.suspended).toBe(false);
  });
  test("getAuditLogs -- filters by targetUid", async () => {
    const logs = [{ id: "l1", targetUid: "uid1", action: "suspend_tenant", severity: "critical", loggedAt: "2026-05-01T10:00:00Z" }, { id: "l2", targetUid: "uid2", action: "view_audit", severity: "info", loggedAt: "2026-05-01T09:00:00Z" }];
    adm.__setFirestoreForTests({ collection: () => makeCol(logs) });
    const r = await adm.getAuditLogs({ targetUid: "uid1" });
    expect(r.length).toBe(1);
    expect(r[0].targetUid).toBe("uid1");
  });
  test("getGlobalStats -- counts tenants correctly", async () => {
    const owners = [{ id: "u1", suspended: false }, { id: "u2", suspended: true }, { id: "u3", suspended: false }];
    adm.__setFirestoreForTests({ collection: () => makeCol(owners) });
    const r = await adm.getGlobalStats();
    expect(r.totalTenants).toBe(3);
    expect(r.activeTenants).toBe(2);
    expect(r.suspendedTenants).toBe(1);
  });
  test("getTenantStats -- returns stats without conversation content", async () => {
    const owner = { id: "uid1", business_name: "Mi Tienda", messages_today: 42, active_leads: 7 };
    adm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(owner) }) }) });
    const r = await adm.getTenantStats("uid1");
    expect(r.messagesTODAY).toBe(42);
    expect(r.activeLeads).toBe(7);
    expect(r.businessName).toBe("Mi Tienda");
  });
});
