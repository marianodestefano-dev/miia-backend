'use strict';

/**
 * MIIA - Role Middleware (T228)
 * C.7 ROADMAP: middleware requireRole() centralizado.
 * Consolida validaciones duplicadas de rol en un punto unico.
 */

const ROLES = Object.freeze(['owner', 'agent', 'founder', 'readonly', 'api_client']);
const ROLE_HIERARCHY = Object.freeze({
  founder: 4,
  owner: 3,
  agent: 2,
  api_client: 1,
  readonly: 0,
});

const PERMISSIONS = Object.freeze({
  read_conversations: ['owner', 'agent', 'founder', 'readonly'],
  write_conversations: ['owner', 'agent', 'founder'],
  manage_contacts: ['owner', 'founder'],
  send_broadcast: ['owner', 'founder'],
  manage_config: ['owner', 'founder'],
  view_analytics: ['owner', 'agent', 'founder'],
  export_data: ['owner', 'founder'],
  manage_api_keys: ['owner', 'founder'],
  admin_global: ['founder'],
  handoff_assign: ['owner', 'agent', 'founder'],
  billing_manage: ['owner', 'founder'],
});

function isValidRole(role) {
  return ROLES.includes(role);
}

function hasPermission(role, permission) {
  if (!isValidRole(role)) return false;
  if (!PERMISSIONS[permission]) return false;
  return PERMISSIONS[permission].includes(role);
}

function getRoleLevel(role) {
  return ROLE_HIERARCHY[role] !== undefined ? ROLE_HIERARCHY[role] : -1;
}

function isRoleAtLeast(role, minRole) {
  return getRoleLevel(role) >= getRoleLevel(minRole);
}

function validateRoleContext(ctx) {
  if (!ctx) return { valid: false, reason: 'ctx requerido' };
  if (!ctx.uid) return { valid: false, reason: 'uid requerido' };
  if (!ctx.role) return { valid: false, reason: 'role requerido' };
  if (!isValidRole(ctx.role)) return { valid: false, reason: 'role invalido: ' + ctx.role };
  return { valid: true };
}

function requireRole(allowedRoles) {
  if (!Array.isArray(allowedRoles)) throw new Error('allowedRoles debe ser array');
  var invalid = allowedRoles.filter(function(r) { return !isValidRole(r); });
  if (invalid.length > 0) throw new Error('roles invalidos: ' + invalid.join(', '));
  return function(ctx) {
    var validation = validateRoleContext(ctx);
    if (!validation.valid) return { allowed: false, reason: validation.reason };
    if (!allowedRoles.includes(ctx.role)) {
      return { allowed: false, reason: 'rol ' + ctx.role + ' no tiene permiso. Requiere: ' + allowedRoles.join(', ') };
    }
    return { allowed: true };
  };
}

function requirePermission(permission) {
  if (!PERMISSIONS[permission]) throw new Error('permiso desconocido: ' + permission);
  return function(ctx) {
    var validation = validateRoleContext(ctx);
    if (!validation.valid) return { allowed: false, reason: validation.reason };
    if (!hasPermission(ctx.role, permission)) {
      return { allowed: false, reason: 'rol ' + ctx.role + ' no tiene permiso ' + permission };
    }
    return { allowed: true };
  };
}

function requireMinRole(minRole) {
  if (!isValidRole(minRole)) throw new Error('minRole invalido: ' + minRole);
  return function(ctx) {
    var validation = validateRoleContext(ctx);
    if (!validation.valid) return { allowed: false, reason: validation.reason };
    if (!isRoleAtLeast(ctx.role, minRole)) {
      return { allowed: false, reason: 'rol ' + ctx.role + ' no cumple nivel minimo ' + minRole };
    }
    return { allowed: true };
  };
}

function buildRoleContext(uid, role, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!isValidRole(role)) throw new Error('role invalido: ' + role);
  return {
    uid,
    role,
    tenantUid: (opts && opts.tenantUid) ? opts.tenantUid : uid,
    agentId: (opts && opts.agentId) ? opts.agentId : null,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  requireRole,
  requirePermission,
  requireMinRole,
  validateRoleContext,
  hasPermission,
  isValidRole,
  isRoleAtLeast,
  getRoleLevel,
  buildRoleContext,
  ROLES,
  ROLE_HIERARCHY,
  PERMISSIONS,
};
