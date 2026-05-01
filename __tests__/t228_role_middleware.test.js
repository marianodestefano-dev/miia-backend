'use strict';

const {
  requireRole, requirePermission, requireMinRole, validateRoleContext,
  hasPermission, isValidRole, isRoleAtLeast, getRoleLevel, buildRoleContext,
  ROLES, ROLE_HIERARCHY, PERMISSIONS,
} = require('../core/role_middleware');

const UID = 'testUid1234567890';

describe('Constantes', () => {
  test('ROLES tiene 5 roles', () => { expect(ROLES.length).toBe(5); });
  test('frozen ROLES', () => { expect(() => { ROLES.push('x'); }).toThrow(); });
  test('frozen PERMISSIONS', () => { expect(() => { PERMISSIONS.nuevo = []; }).toThrow(); });
  test('founder tiene nivel maximo', () => { expect(ROLE_HIERARCHY.founder).toBeGreaterThan(ROLE_HIERARCHY.owner); });
  test('readonly tiene nivel minimo', () => { expect(ROLE_HIERARCHY.readonly).toBe(0); });
});

describe('isValidRole', () => {
  test('owner es valido', () => { expect(isValidRole('owner')).toBe(true); });
  test('founder es valido', () => { expect(isValidRole('founder')).toBe(true); });
  test('agent es valido', () => { expect(isValidRole('agent')).toBe(true); });
  test('admin no es valido', () => { expect(isValidRole('admin')).toBe(false); });
  test('undefined no es valido', () => { expect(isValidRole(undefined)).toBe(false); });
});

describe('hasPermission', () => {
  test('owner puede manage_config', () => { expect(hasPermission('owner', 'manage_config')).toBe(true); });
  test('agent no puede manage_config', () => { expect(hasPermission('agent', 'manage_config')).toBe(false); });
  test('founder puede admin_global', () => { expect(hasPermission('founder', 'admin_global')).toBe(true); });
  test('owner no puede admin_global', () => { expect(hasPermission('owner', 'admin_global')).toBe(false); });
  test('agent puede read_conversations', () => { expect(hasPermission('agent', 'read_conversations')).toBe(true); });
  test('permiso desconocido retorna false', () => { expect(hasPermission('owner', 'nope')).toBe(false); });
  test('rol invalido retorna false', () => { expect(hasPermission('admin', 'read_conversations')).toBe(false); });
});

describe('getRoleLevel e isRoleAtLeast', () => {
  test('founder > owner > agent > api_client > readonly', () => {
    expect(getRoleLevel('founder')).toBeGreaterThan(getRoleLevel('owner'));
    expect(getRoleLevel('owner')).toBeGreaterThan(getRoleLevel('agent'));
    expect(getRoleLevel('agent')).toBeGreaterThan(getRoleLevel('api_client'));
    expect(getRoleLevel('api_client')).toBeGreaterThan(getRoleLevel('readonly'));
  });
  test('rol invalido retorna -1', () => { expect(getRoleLevel('desconocido')).toBe(-1); });
  test('founder es al menos owner', () => { expect(isRoleAtLeast('founder', 'owner')).toBe(true); });
  test('agent no es al menos owner', () => { expect(isRoleAtLeast('agent', 'owner')).toBe(false); });
  test('owner es al menos owner', () => { expect(isRoleAtLeast('owner', 'owner')).toBe(true); });
});

describe('validateRoleContext', () => {
  test('retorna invalido si ctx null', () => {
    expect(validateRoleContext(null).valid).toBe(false);
  });
  test('retorna invalido si falta uid', () => {
    expect(validateRoleContext({ role: 'owner' }).valid).toBe(false);
  });
  test('retorna invalido si falta role', () => {
    expect(validateRoleContext({ uid: UID }).valid).toBe(false);
  });
  test('retorna invalido si role invalido', () => {
    expect(validateRoleContext({ uid: UID, role: 'superadmin' }).valid).toBe(false);
  });
  test('retorna valido con uid y role validos', () => {
    expect(validateRoleContext({ uid: UID, role: 'owner' }).valid).toBe(true);
  });
});

describe('requireRole', () => {
  test('lanza si allowedRoles no es array', () => {
    expect(() => requireRole('owner')).toThrow('debe ser array');
  });
  test('lanza si alguno de los roles es invalido', () => {
    expect(() => requireRole(['owner', 'superadmin'])).toThrow('roles invalidos');
  });
  test('retorna funcion', () => {
    expect(typeof requireRole(['owner'])).toBe('function');
  });
  test('permite rol correcto', () => {
    const check = requireRole(['owner', 'founder']);
    const r = check({ uid: UID, role: 'owner' });
    expect(r.allowed).toBe(true);
  });
  test('bloquea rol incorrecto', () => {
    const check = requireRole(['founder']);
    const r = check({ uid: UID, role: 'agent' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('founder');
  });
  test('bloquea ctx invalido', () => {
    const check = requireRole(['owner']);
    const r = check({ role: 'owner' });
    expect(r.allowed).toBe(false);
  });
});

describe('requirePermission', () => {
  test('lanza si permiso desconocido', () => {
    expect(() => requirePermission('nope')).toThrow('permiso desconocido');
  });
  test('retorna funcion', () => {
    expect(typeof requirePermission('read_conversations')).toBe('function');
  });
  test('permite si tiene permiso', () => {
    const check = requirePermission('send_broadcast');
    const r = check({ uid: UID, role: 'owner' });
    expect(r.allowed).toBe(true);
  });
  test('bloquea si no tiene permiso', () => {
    const check = requirePermission('admin_global');
    const r = check({ uid: UID, role: 'owner' });
    expect(r.allowed).toBe(false);
  });
});

describe('requireMinRole', () => {
  test('lanza si minRole invalido', () => {
    expect(() => requireMinRole('superadmin')).toThrow('minRole invalido');
  });
  test('retorna funcion', () => {
    expect(typeof requireMinRole('owner')).toBe('function');
  });
  test('founder pasa nivel owner', () => {
    const check = requireMinRole('owner');
    expect(check({ uid: UID, role: 'founder' }).allowed).toBe(true);
  });
  test('agent no pasa nivel owner', () => {
    const check = requireMinRole('owner');
    expect(check({ uid: UID, role: 'agent' }).allowed).toBe(false);
  });
  test('readonly no pasa nivel agent', () => {
    const check = requireMinRole('agent');
    expect(check({ uid: UID, role: 'readonly' }).allowed).toBe(false);
  });
});

describe('buildRoleContext', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildRoleContext(undefined, 'owner')).toThrow('uid requerido');
  });
  test('lanza si role invalido', () => {
    expect(() => buildRoleContext(UID, 'superadmin')).toThrow('role invalido');
  });
  test('retorna contexto valido', () => {
    const ctx = buildRoleContext(UID, 'agent', { agentId: 'ag1' });
    expect(ctx.uid).toBe(UID);
    expect(ctx.role).toBe('agent');
    expect(ctx.agentId).toBe('ag1');
    expect(ctx.createdAt).toBeDefined();
  });
  test('tenantUid default es uid', () => {
    const ctx = buildRoleContext(UID, 'owner');
    expect(ctx.tenantUid).toBe(UID);
  });
});
