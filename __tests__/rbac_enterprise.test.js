'use strict';

const r = require('../core/rbac_enterprise');
const {
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
  __setFirestoreForTests,
} = r;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const enterprises = o.enterprises || {};
  const membersByEnt = o.membersByEnt || {};
  const overridesByEnt = o.overridesByEnt || {};
  const captures = { entSets: [], memberSets: [], overrideSets: [] };

  const entDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!enterprises[id], data: () => enterprises[id] || {} }),
    set: jest.fn((payload, merge) => { captures.entSets.push({ id, payload, merge }); return Promise.resolve({}); }),
    collection: function (subName) {
      if (subName === 'members') {
        const members = membersByEnt[id] || {};
        return {
          doc: jest.fn((uid) => ({
            get: jest.fn().mockResolvedValue({ exists: !!members[uid], data: () => members[uid] || {} }),
            set: jest.fn((payload, merge) => { captures.memberSets.push({ id, uid, payload, merge }); return Promise.resolve({}); }),
          })),
          get: jest.fn().mockResolvedValue({
            forEach: function (cb) {
              Object.keys(members).forEach(function (uid) {
                cb({ data: () => members[uid] });
              });
            },
          }),
        };
      }
      // permissions_overrides
      const overrides = overridesByEnt[id] || {};
      return {
        doc: jest.fn((uid) => ({
          get: jest.fn().mockResolvedValue({ exists: !!overrides[uid], data: () => overrides[uid] || {} }),
          set: jest.fn((payload, merge) => { captures.overrideSets.push({ id, uid, payload, merge }); return Promise.resolve({}); }),
        })),
      };
    },
  }));

  const db = {
    collection: jest.fn((name) => {
      if (name === 'enterprises') return { doc: entDocFn };
      return { doc: entDocFn };
    }),
  };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── createEnterprise ──────────────────────────────────────────────────────────

describe('createEnterprise', () => {
  test('ownerUid null -> throw', async () => {
    await expect(createEnterprise(null, { name: 'X' })).rejects.toThrow('ownerUid_requerido');
  });
  test('payload null -> throw', async () => {
    await expect(createEnterprise('u1', null)).rejects.toThrow('name_requerido');
  });
  test('sin name -> throw', async () => {
    await expect(createEnterprise('u1', {})).rejects.toThrow('name_requerido');
  });

  test('OK con plan default (starter)', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await createEnterprise('owner12345', { name: 'Acme' });
    expect(r.plan).toBe('starter');
    expect(captures.memberSets[0].payload.role).toBe('owner');
  });

  test('OK con plan valido (pro)', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await createEnterprise('owner12345', { name: 'Acme', plan: 'pro' });
    expect(r.plan).toBe('pro');
  });

  test('plan invalido -> starter', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await createEnterprise('owner12345', { name: 'Acme', plan: 'mega' });
    expect(r.plan).toBe('starter');
  });

  test('name largo -> truncado a 100', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await createEnterprise('owner12345', { name: 'x'.repeat(500) });
    expect(captures.entSets[0].payload.name.length).toBe(100);
  });
});

// ── getEnterprise ─────────────────────────────────────────────────────────────

describe('getEnterprise', () => {
  test('enterpriseId null -> throw', async () => {
    await expect(getEnterprise(null)).rejects.toThrow('enterpriseId_requerido');
  });

  test('no existe -> null', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getEnterprise('ent_1')).toBeNull();
  });

  test('OK', async () => {
    const { db } = makeDb({ enterprises: { ent_1: { name: 'Acme', plan: 'pro' } } });
    __setFirestoreForTests(db);
    const r = await getEnterprise('ent_1');
    expect(r.name).toBe('Acme');
  });
});

// ── addMember ─────────────────────────────────────────────────────────────────

describe('addMember', () => {
  test('enterpriseId null -> throw', async () => {
    await expect(addMember(null, 'u1', 'admin')).rejects.toThrow('parametros_requeridos');
  });
  test('uid null -> throw', async () => {
    await expect(addMember('ent_1', null, 'admin')).rejects.toThrow('parametros_requeridos');
  });
  test('role invalido -> throw', async () => {
    await expect(addMember('ent_1', 'u1', 'super')).rejects.toThrow('role_invalido');
  });

  test('enterprise no encontrada -> throw', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    await expect(addMember('ent_X', 'u1', 'admin')).rejects.toThrow('enterprise_no_encontrada');
  });

  test('limite de plan -> throw', async () => {
    const members = {};
    for (let i = 0; i < 5; i++) members['u' + i] = { uid: 'u' + i, role: 'agent' };
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'starter' } },
      membersByEnt: { ent_1: members },
    });
    __setFirestoreForTests(db);
    await expect(addMember('ent_1', 'u5', 'agent')).rejects.toThrow('limite_usuarios_plan');
  });

  test('OK - dentro del limite', async () => {
    const { db, captures } = makeDb({
      enterprises: { ent_1: { plan: 'pro' } },
      membersByEnt: { ent_1: { u1: { uid: 'u1', role: 'owner' } } },
    });
    __setFirestoreForTests(db);
    const r = await addMember('ent_1', 'u2', 'admin', 'u1');
    expect(r.ok).toBe(true);
    expect(captures.memberSets[0].payload.role).toBe('admin');
    expect(captures.memberSets[0].payload.invitedBy).toBe('u1');
  });

  test('plan invalido -> usa starter limits', async () => {
    const members = {};
    for (let i = 0; i < 5; i++) members['u' + i] = { uid: 'u' + i };
    const { db } = makeDb({
      enterprises: { ent_1: { plan: 'mega' } },
      membersByEnt: { ent_1: members },
    });
    __setFirestoreForTests(db);
    await expect(addMember('ent_1', 'u5', 'agent')).rejects.toThrow('limite_usuarios_plan');
  });

  test('OK sin invitedBy -> null', async () => {
    const { db, captures } = makeDb({
      enterprises: { ent_1: { plan: 'pro' } },
      membersByEnt: { ent_1: {} },
    });
    __setFirestoreForTests(db);
    await addMember('ent_1', 'u2', 'agent');
    expect(captures.memberSets[0].payload.invitedBy).toBeNull();
  });
});

// ── removeMember ──────────────────────────────────────────────────────────────

describe('removeMember', () => {
  test('parametros null -> throw', async () => {
    await expect(removeMember(null, 'u1')).rejects.toThrow('parametros_requeridos');
    await expect(removeMember('ent_1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('miembro no encontrado -> throw', async () => {
    const { db } = makeDb({ enterprises: { ent_1: { plan: 'pro' } } });
    __setFirestoreForTests(db);
    await expect(removeMember('ent_1', 'u1')).rejects.toThrow('miembro_no_encontrado');
  });

  test('owner no removible -> throw', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u1: { uid: 'u1', role: 'owner' } } },
    });
    __setFirestoreForTests(db);
    await expect(removeMember('ent_1', 'u1')).rejects.toThrow('owner_no_removible');
  });

  test('OK - agent removible', async () => {
    const { db, captures } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'agent' } } },
    });
    __setFirestoreForTests(db);
    const r = await removeMember('ent_1', 'u2');
    expect(r.ok).toBe(true);
    expect(captures.memberSets[0].payload.active).toBe(false);
  });
});

// ── getMember ─────────────────────────────────────────────────────────────────

describe('getMember', () => {
  test('parametros null -> null', async () => {
    expect(await getMember(null, 'u1')).toBeNull();
    expect(await getMember('ent_1', null)).toBeNull();
  });

  test('no existe -> null', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getMember('ent_1', 'u1')).toBeNull();
  });

  test('OK', async () => {
    const { db } = makeDb({ membersByEnt: { ent_1: { u1: { uid: 'u1', role: 'admin' } } } });
    __setFirestoreForTests(db);
    const r = await getMember('ent_1', 'u1');
    expect(r.role).toBe('admin');
  });
});

// ── listMembers ───────────────────────────────────────────────────────────────

describe('listMembers', () => {
  test('enterpriseId null -> throw', async () => {
    await expect(listMembers(null)).rejects.toThrow('enterpriseId_requerido');
  });

  test('OK - filtra removidos (active=false)', async () => {
    const { db } = makeDb({
      membersByEnt: {
        ent_1: {
          u1: { uid: 'u1', role: 'owner' },
          u2: { uid: 'u2', role: 'admin', active: true },
          u3: { uid: 'u3', role: 'agent', active: false },
        },
      },
    });
    __setFirestoreForTests(db);
    const r = await listMembers('ent_1');
    expect(r).toHaveLength(2);
    expect(r.map(function (m) { return m.uid; })).toEqual(['u1', 'u2']);
  });

  test('OK - vacio', async () => {
    const { db } = makeDb({ membersByEnt: { ent_1: {} } });
    __setFirestoreForTests(db);
    expect(await listMembers('ent_1')).toEqual([]);
  });
});

// ── getEffectivePermissions ───────────────────────────────────────────────────

describe('getEffectivePermissions', () => {
  test('uid null -> []', async () => {
    expect(await getEffectivePermissions('ent_1', null)).toEqual([]);
  });
  test('enterpriseId null -> []', async () => {
    expect(await getEffectivePermissions(null, 'u1')).toEqual([]);
  });

  test('miembro no existe -> []', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getEffectivePermissions('ent_1', 'u1')).toEqual([]);
  });

  test('owner -> [*]', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u1: { uid: 'u1', role: 'owner' } } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u1');
    expect(perms).toContain('*');
  });

  test('agent -> permisos basicos', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'agent' } } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u2');
    expect(perms).toContain('tickets.manage');
    expect(perms).toContain('dashboard.view');
  });

  test('role no estandar -> rolePerms=[]', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'custom_role' } } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u2');
    expect(perms).toEqual([]);
  });

  test('con overrides grants suma permisos', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'viewer' } } },
      overridesByEnt: { ent_1: { u2: { grants: ['extra.permission'], revokes: [] } } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u2');
    expect(perms).toContain('extra.permission');
    expect(perms).toContain('dashboard.view');
  });

  test('con overrides revokes elimina permisos', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'admin' } } },
      overridesByEnt: { ent_1: { u2: { grants: [], revokes: ['users.manage'] } } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u2');
    expect(perms).not.toContain('users.manage');
    expect(perms).toContain('dashboard.view');
  });

  test('overrides con grants/revokes no array -> default []', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'viewer' } } },
      overridesByEnt: { ent_1: { u2: { grants: 'string', revokes: 'string' } } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u2');
    // No agrega grants ni filtra revokes -> mantiene viewer perms
    expect(perms).toContain('dashboard.view');
  });

  test('overrides existe sin grants/revokes -> no aplica filtro', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'viewer' } } },
      overridesByEnt: { ent_1: { u2: {} } },
    });
    __setFirestoreForTests(db);
    const perms = await getEffectivePermissions('ent_1', 'u2');
    expect(perms).toContain('dashboard.view');
  });
});

// ── hasPermission ─────────────────────────────────────────────────────────────

describe('hasPermission', () => {
  test('parametros null -> false', async () => {
    expect(await hasPermission(null, 'u1', 'x')).toBe(false);
    expect(await hasPermission('ent_1', null, 'x')).toBe(false);
    expect(await hasPermission('ent_1', 'u1', null)).toBe(false);
  });

  test('owner tiene cualquier permiso (*)', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u1: { uid: 'u1', role: 'owner' } } },
    });
    __setFirestoreForTests(db);
    expect(await hasPermission('ent_1', 'u1', 'cualquier.cosa')).toBe(true);
  });

  test('viewer no tiene users.manage', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'viewer' } } },
    });
    __setFirestoreForTests(db);
    expect(await hasPermission('ent_1', 'u2', 'users.manage')).toBe(false);
  });

  test('viewer tiene dashboard.view', async () => {
    const { db } = makeDb({
      membersByEnt: { ent_1: { u2: { uid: 'u2', role: 'viewer' } } },
    });
    __setFirestoreForTests(db);
    expect(await hasPermission('ent_1', 'u2', 'dashboard.view')).toBe(true);
  });
});

// ── setPermissionOverrides ────────────────────────────────────────────────────

describe('setPermissionOverrides', () => {
  test('parametros null -> throw', async () => {
    await expect(setPermissionOverrides(null, 'u1', {})).rejects.toThrow('parametros_requeridos');
    await expect(setPermissionOverrides('ent_1', null, {})).rejects.toThrow('parametros_requeridos');
  });

  test('OK con grants/revokes', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setPermissionOverrides('ent_1', 'u1', { grants: ['a'], revokes: ['b'] });
    expect(r.ok).toBe(true);
    expect(captures.overrideSets[0].payload.grants).toEqual(['a']);
    expect(captures.overrideSets[0].payload.revokes).toEqual(['b']);
  });

  test('OK sin opts -> defaults []', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await setPermissionOverrides('ent_1', 'u1');
    expect(captures.overrideSets[0].payload.grants).toEqual([]);
    expect(captures.overrideSets[0].payload.revokes).toEqual([]);
  });

  test('opts.grants no array -> []', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await setPermissionOverrides('ent_1', 'u1', { grants: 'foo' });
    expect(captures.overrideSets[0].payload.grants).toEqual([]);
  });
});
