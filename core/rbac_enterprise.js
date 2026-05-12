'use strict';

/**
 * R29 — core/rbac_enterprise.js (Piso 6 P6.1)
 * Role-Based Access Control + Agent Dashboard + Enterprise Account.
 * Schema:
 *   - enterprises/{enterpriseId} -> { name, ownerUid, createdAt, plan }
 *   - enterprises/{enterpriseId}/members/{uid} -> { role, joinedAt, invitedBy }
 *   - enterprises/{enterpriseId}/permissions_overrides/{uid} -> custom grants
 */

const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  AGENT: 'agent',
  VIEWER: 'viewer',
});

// Permisos por rol (cascada: owner > admin > manager > agent > viewer)
const ROLE_PERMISSIONS = Object.freeze({
  owner: ['*'],
  admin: ['users.manage', 'campaigns.manage', 'tickets.manage', 'dashboard.view', 'reports.view', 'settings.manage'],
  manager: ['users.view', 'campaigns.manage', 'tickets.manage', 'dashboard.view', 'reports.view'],
  agent: ['tickets.manage', 'tickets.assigned', 'dashboard.view'],
  viewer: ['dashboard.view', 'reports.view'],
});

const ENTERPRISE_PLANS = Object.freeze(['starter', 'pro', 'enterprise']);
const PLAN_LIMITS = Object.freeze({
  starter: { maxUsers: 5, maxCampaigns: 3 },
  pro: { maxUsers: 25, maxCampaigns: 20 },
  enterprise: { maxUsers: 200, maxCampaigns: 200 },
});

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _enterpriseDoc(enterpriseId) {
  return db().collection('enterprises').doc(enterpriseId);
}
function _membersCol(enterpriseId) {
  return db().collection('enterprises').doc(enterpriseId).collection('members');
}
function _overridesCol(enterpriseId) {
  return db().collection('enterprises').doc(enterpriseId).collection('permissions_overrides');
}

// ── Enterprise CRUD ───────────────────────────────────────────────────────────
/**
 * Crea una nueva enterprise. El creador (ownerUid) queda como role=owner.
 */
async function createEnterprise(ownerUid, payload) {
  if (!ownerUid) throw new Error('ownerUid_requerido');
  if (!payload || !payload.name) throw new Error('name_requerido');
  const plan = payload.plan && ENTERPRISE_PLANS.includes(payload.plan) ? payload.plan : 'starter';
  const enterpriseId = 'ent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    enterpriseId,
    name: String(payload.name).slice(0, 100),
    ownerUid,
    plan,
    createdAt: new Date().toISOString(),
    active: true,
  };
  await _enterpriseDoc(enterpriseId).set(record);
  await _membersCol(enterpriseId).doc(ownerUid).set({
    uid: ownerUid,
    role: ROLES.OWNER,
    joinedAt: new Date().toISOString(),
    invitedBy: null,
  });
  console.log('[RBAC] enterprise creada id=' + enterpriseId + ' owner=' + ownerUid.slice(0, 8));
  return { ok: true, enterpriseId, ...record };
}

async function getEnterprise(enterpriseId) {
  if (!enterpriseId) throw new Error('enterpriseId_requerido');
  const snap = await _enterpriseDoc(enterpriseId).get();
  if (!snap.exists) return null;
  return snap.data();
}

// ── Members ───────────────────────────────────────────────────────────────────
/**
 * Agrega un miembro a la enterprise con un rol.
 */
async function addMember(enterpriseId, uid, role, invitedBy) {
  if (!enterpriseId || !uid) throw new Error('parametros_requeridos');
  if (!Object.values(ROLES).includes(role)) throw new Error('role_invalido: ' + role);
  // verificar limite del plan
  const entSnap = await _enterpriseDoc(enterpriseId).get();
  if (!entSnap.exists) throw new Error('enterprise_no_encontrada');
  const entData = entSnap.data();
  const membersSnap = await _membersCol(enterpriseId).get();
  let count = 0;
  membersSnap.forEach(function () { count++; });
  const limits = PLAN_LIMITS[entData.plan] || PLAN_LIMITS.starter;
  if (count >= limits.maxUsers) throw new Error('limite_usuarios_plan');

  await _membersCol(enterpriseId).doc(uid).set({
    uid, role,
    joinedAt: new Date().toISOString(),
    invitedBy: invitedBy || null,
  });
  console.log('[RBAC] member uid=' + uid.slice(0, 8) + ' role=' + role + ' ent=' + enterpriseId);
  return { ok: true };
}

async function removeMember(enterpriseId, uid) {
  if (!enterpriseId || !uid) throw new Error('parametros_requeridos');
  const memberRef = _membersCol(enterpriseId).doc(uid);
  const snap = await memberRef.get();
  if (!snap.exists) throw new Error('miembro_no_encontrado');
  const data = snap.data();
  if (data.role === ROLES.OWNER) throw new Error('owner_no_removible');
  await memberRef.set({ removedAt: new Date().toISOString(), active: false }, { merge: true });
  return { ok: true };
}

async function getMember(enterpriseId, uid) {
  if (!enterpriseId || !uid) return null;
  const snap = await _membersCol(enterpriseId).doc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function listMembers(enterpriseId) {
  if (!enterpriseId) throw new Error('enterpriseId_requerido');
  const snap = await _membersCol(enterpriseId).get();
  const members = [];
  snap.forEach(function (doc) {
    const data = doc.data();
    if (data.active !== false) members.push(data);
  });
  return members;
}

// ── Permission checks ─────────────────────────────────────────────────────────
/**
 * Devuelve la lista de permisos efectivos para un uid en una enterprise.
 * Incluye los de su rol + overrides.
 */
async function getEffectivePermissions(enterpriseId, uid) {
  if (!enterpriseId || !uid) return [];
  const member = await getMember(enterpriseId, uid);
  if (!member) return [];
  const rolePerms = ROLE_PERMISSIONS[member.role] || [];
  let perms = rolePerms.slice();
  const overrideSnap = await _overridesCol(enterpriseId).doc(uid).get();
  if (overrideSnap.exists) {
    const data = overrideSnap.data();
    const grants = Array.isArray(data.grants) ? data.grants : [];
    perms = perms.concat(grants);
    if (Array.isArray(data.revokes)) {
      const revokeSet = new Set(data.revokes);
      perms = perms.filter(function (p) { return !revokeSet.has(p); });
    }
  }
  return Array.from(new Set(perms));
}

/**
 * Devuelve true si el uid tiene el permiso pedido (o '*').
 */
async function hasPermission(enterpriseId, uid, permission) {
  if (!enterpriseId || !uid || !permission) return false;
  const perms = await getEffectivePermissions(enterpriseId, uid);
  return perms.includes('*') || perms.includes(permission);
}

// ── Overrides ─────────────────────────────────────────────────────────────────
async function setPermissionOverrides(enterpriseId, uid, opts) {
  if (!enterpriseId || !uid) throw new Error('parametros_requeridos');
  const o = opts || {};
  const payload = {
    uid,
    grants: Array.isArray(o.grants) ? o.grants : [],
    revokes: Array.isArray(o.revokes) ? o.revokes : [],
    updatedAt: new Date().toISOString(),
  };
  await _overridesCol(enterpriseId).doc(uid).set(payload, { merge: true });
  return { ok: true };
}

module.exports = {
  createEnterprise,
  getEnterprise,
  addMember,
  removeMember,
  getMember,
  listMembers,
  getEffectivePermissions,
  hasPermission,
  setPermissionOverrides,
  ROLES,
  ROLE_PERMISSIONS,
  ENTERPRISE_PLANS,
  PLAN_LIMITS,
  __setFirestoreForTests,
};
