'use strict';
/**
 * R17-C — contact_groups.test.js
 * 100% branch coverage: createGroup + addToGroup + moveToGroup + listGroups + parseGroupCommand
 */

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockGroupDocs = {};
let mockCollGetThrows = false;
let mockOverrideSize = null;

function makeMockDocRef(groupId) {
  return {
    get: function () {
      if (mockGroupDocs[groupId] === undefined) {
        return Promise.resolve({ exists: false, data: function () { return {}; } });
      }
      return Promise.resolve({ exists: true, data: function () { return mockGroupDocs[groupId].data; } });
    },
    set: function (data, opts) {
      if (opts && opts.merge) {
        var prev = (mockGroupDocs[groupId] || { data: {} }).data;
        mockGroupDocs[groupId] = { data: Object.assign({}, prev, data) };
      } else {
        mockGroupDocs[groupId] = { data: data };
      }
      return Promise.resolve();
    },
  };
}

const mockColRef = {
  get: function () {
    if (mockCollGetThrows) return Promise.reject(new Error('FS-FAIL'));
    var docs = Object.entries(mockGroupDocs).map(function (entry) {
      var id = entry[0];
      var d = entry[1];
      return {
        id: id,
        data: function () { return d.data; },
        ref: {
          set: function (data, opts) {
            if (opts && opts.merge) {
              var prev = (mockGroupDocs[id] || { data: {} }).data;
              mockGroupDocs[id] = { data: Object.assign({}, prev, data) };
            } else {
              mockGroupDocs[id] = { data: data };
            }
            return Promise.resolve();
          }
        }
      };
    });
    return Promise.resolve({
      size: mockOverrideSize !== null ? mockOverrideSize : docs.length,
      forEach: function (fn) { docs.forEach(fn); }
    });
  },
  doc: function (groupId) { return makeMockDocRef(groupId); }
};

const mockFs = {
  collection: function () {
    return {
      doc: function () {
        return {
          collection: function () { return mockColRef; }
        };
      }
    };
  }
};

const {
  createGroup,
  addToGroup,
  moveToGroup,
  listGroups,
  parseGroupCommand,
  VALID_GROUP_TYPES,
  MAX_GROUPS_PER_OWNER,
  GROUP_COMMANDS,
  __setFirestoreForTests,
} = require('../core/contact_groups');
__setFirestoreForTests(mockFs);

beforeEach(function () {
  mockGroupDocs = {};
  mockCollGetThrows = false;
  mockOverrideSize = null;
});

// ── createGroup ───────────────────────────────────────────────────────────────
describe('createGroup', function () {
  test('uid faltante => uid_requerido', async function () {
    await expect(createGroup('', 'ventas', 'lead')).rejects.toThrow('uid_requerido');
  });

  test('nombre vacio => nombre_requerido', async function () {
    await expect(createGroup('uid-1', '', 'lead')).rejects.toThrow('nombre_requerido');
  });

  test('nombre null => nombre_requerido', async function () {
    await expect(createGroup('uid-1', null, 'lead')).rejects.toThrow('nombre_requerido');
  });

  test('limite alcanzado => limite_grupos_alcanzado', async function () {
    mockOverrideSize = MAX_GROUPS_PER_OWNER;
    await expect(createGroup('uid-1', 'nuevo', 'lead')).rejects.toThrow('limite_grupos_alcanzado');
  });

  test('tipo valido => se usa el tipo dado', async function () {
    var result = await createGroup('uid-1', 'Clientes VIP', 'cliente');
    expect(result.ok).toBe(true);
    expect(result.groupId).toBe('clientes_vip');
    expect(mockGroupDocs['clientes_vip'].data.tipo).toBe('cliente');
  });

  test('tipo invalido => usa custom', async function () {
    var result = await createGroup('uid-1', 'Otro', 'desconocido');
    expect(result.ok).toBe(true);
    expect(mockGroupDocs['otro'].data.tipo).toBe('custom');
  });

  test('happy path: crea grupo con miembros vacio y timestamps', async function () {
    var result = await createGroup('uid-1', 'Leads', 'lead');
    expect(result.groupId).toBe('leads');
    var data = mockGroupDocs['leads'].data;
    expect(data.nombre).toBe('Leads');
    expect(data.tipo).toBe('lead');
    expect(data.miembros).toEqual([]);
    expect(data.createdAt).toBeTruthy();
    expect(data.updatedAt).toBeTruthy();
  });
});

// ── addToGroup ────────────────────────────────────────────────────────────────
describe('addToGroup', function () {
  test('sin uid => parametros_requeridos', async function () {
    await expect(addToGroup('', '111', 'ventas')).rejects.toThrow('parametros_requeridos');
  });

  test('sin phone => parametros_requeridos', async function () {
    await expect(addToGroup('uid-1', '', 'ventas')).rejects.toThrow('parametros_requeridos');
  });

  test('sin groupName => parametros_requeridos', async function () {
    await expect(addToGroup('uid-1', '111', '')).rejects.toThrow('parametros_requeridos');
  });

  test('grupo no existe => grupo_no_encontrado', async function () {
    await expect(addToGroup('uid-1', '5571234567', 'inexistente')).rejects.toThrow('grupo_no_encontrado');
  });

  test('contacto ya miembro => alreadyMember:true', async function () {
    var crypto = require('crypto');
    var phone = '5571234567';
    var hash = crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
    mockGroupDocs['ventas'] = { data: { nombre: 'ventas', miembros: [hash] } };
    var result = await addToGroup('uid-1', phone, 'ventas');
    expect(result.alreadyMember).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('contacto nuevo => agrega hash, alreadyMember:false', async function () {
    mockGroupDocs['ventas'] = { data: { nombre: 'ventas', miembros: [] } };
    var result = await addToGroup('uid-1', '5571234567', 'ventas');
    expect(result.alreadyMember).toBe(false);
    expect(result.ok).toBe(true);
    expect(mockGroupDocs['ventas'].data.miembros).toHaveLength(1);
  });

  test('grupo sin campo miembros => usa [] correctamente', async function () {
    mockGroupDocs['ventas'] = { data: { nombre: 'ventas' } };
    var result = await addToGroup('uid-1', '5571234567', 'ventas');
    expect(result.ok).toBe(true);
    expect(mockGroupDocs['ventas'].data.miembros).toHaveLength(1);
  });
});

// ── moveToGroup ───────────────────────────────────────────────────────────────
describe('moveToGroup', function () {
  test('sin parametros => parametros_requeridos', async function () {
    await expect(moveToGroup('', '111', 'destino')).rejects.toThrow('parametros_requeridos');
  });

  test('grupo destino no existe => grupo_destino_no_encontrado', async function () {
    await expect(moveToGroup('uid-1', '5571234567', 'inexistente')).rejects.toThrow('grupo_destino_no_encontrado');
  });

  test('contacto en otro grupo => se mueve, movedFrom set, filter cubre ambos brazos', async function () {
    var crypto = require('crypto');
    var phone = '5571234567';
    var hash = crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
    // origen tiene hash + otro_miembro para que filter cubra m===hash (false) y m!==hash (true)
    mockGroupDocs['origen'] = { data: { nombre: 'origen', miembros: [hash, 'otro_miembro'] } };
    mockGroupDocs['destino'] = { data: { nombre: 'destino', miembros: [] } };
    var result = await moveToGroup('uid-1', phone, 'destino');
    expect(result.ok).toBe(true);
    expect(result.movedFrom).toBe('origen');
    expect(mockGroupDocs['destino'].data.miembros).toContain(hash);
    expect(mockGroupDocs['origen'].data.miembros).toContain('otro_miembro');
  });

  test('contacto ya en grupo destino => no duplica, movedFrom null', async function () {
    var crypto = require('crypto');
    var phone = '5571234567';
    var hash = crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
    mockGroupDocs['destino'] = { data: { nombre: 'destino', miembros: [hash] } };
    var result = await moveToGroup('uid-1', phone, 'destino');
    expect(result.ok).toBe(true);
    expect(result.movedFrom).toBeNull();
    expect(mockGroupDocs['destino'].data.miembros.filter(function (m) { return m === hash; })).toHaveLength(1);
  });

  test('contacto en destino Y origen => remueve de origen, no toca destino (doc.id===targetId branch)', async function () {
    var crypto = require('crypto');
    var phone = '5571234567';
    var hash = crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
    mockGroupDocs['origen'] = { data: { nombre: 'origen', miembros: [hash] } };
    mockGroupDocs['destino'] = { data: { nombre: 'destino', miembros: [hash] } };
    var result = await moveToGroup('uid-1', phone, 'destino');
    expect(result.ok).toBe(true);
    expect(result.movedFrom).toBe('origen');
    expect(mockGroupDocs['destino'].data.miembros).toContain(hash);
  });

  test('contacto no en ningun grupo, destino sin campo miembros => agrega (cubre || [] derecho)', async function () {
    mockGroupDocs['otro'] = { data: { nombre: 'otro' } }; // sin miembros
    mockGroupDocs['destino'] = { data: { nombre: 'destino' } }; // sin miembros
    var result = await moveToGroup('uid-1', '9991234567', 'destino');
    expect(result.ok).toBe(true);
    expect(result.movedFrom).toBeNull();
    expect(mockGroupDocs['destino'].data.miembros).toHaveLength(1);
  });
});

// ── listGroups ────────────────────────────────────────────────────────────────
describe('listGroups', function () {
  test('uid vacio => []', async function () {
    expect(await listGroups('')).toEqual([]);
  });

  test('sin grupos => []', async function () {
    var result = await listGroups('uid-1');
    expect(result).toEqual([]);
  });

  test('grupos con todos los campos => retorna lista completa', async function () {
    mockGroupDocs['ventas'] = { data: { nombre: 'Ventas', tipo: 'lead', miembros: ['h1'], createdAt: '2026-01-01' } };
    var result = await listGroups('uid-1');
    expect(result).toHaveLength(1);
    expect(result[0].groupId).toBe('ventas');
    expect(result[0].nombre).toBe('Ventas');
    expect(result[0].tipo).toBe('lead');
    expect(result[0].miembros).toEqual(['h1']);
    expect(result[0].createdAt).toBe('2026-01-01');
  });

  test('grupo sin campos opcionales => usa defaults (nombre, tipo, miembros, createdAt)', async function () {
    mockGroupDocs['mi_grupo'] = { data: {} };
    var result = await listGroups('uid-1');
    expect(result[0].nombre).toBe('mi_grupo');
    expect(result[0].tipo).toBe('custom');
    expect(result[0].miembros).toEqual([]);
    expect(result[0].createdAt).toBeNull();
  });

  test('Firestore error => []', async function () {
    mockCollGetThrows = true;
    var result = await listGroups('uid-1');
    expect(result).toEqual([]);
  });
});

// ── parseGroupCommand ─────────────────────────────────────────────────────────
describe('parseGroupCommand', function () {
  test('null => null (!text true)', function () {
    expect(parseGroupCommand(null)).toBeNull();
  });

  test('numero (no string) => null (typeof branch)', function () {
    expect(parseGroupCommand(123)).toBeNull();
  });

  test('string vacio => null', function () {
    expect(parseGroupCommand('')).toBeNull();
  });

  test('+grupo Ventas => CREAR', function () {
    var r = parseGroupCommand('+grupo Ventas');
    expect(r.command).toBe('CREAR');
    expect(r.args.nombre).toBe('Ventas');
  });

  test('+agregar con al => AGREGAR', function () {
    var r = parseGroupCommand('+agregar 5571234567 al ventas');
    expect(r.command).toBe('AGREGAR');
    expect(r.args.phone).toBe('5571234567');
    expect(r.args.groupName).toBe('ventas');
  });

  test('+agregar con a (sin l) => AGREGAR', function () {
    var r = parseGroupCommand('+agregar 5571234567 a ventas');
    expect(r.command).toBe('AGREGAR');
    expect(r.args.phone).toBe('5571234567');
  });

  test('+mover => MOVER', function () {
    var r = parseGroupCommand('+mover 5571234567 a clientes');
    expect(r.command).toBe('MOVER');
    expect(r.args.phone).toBe('5571234567');
    expect(r.args.targetGroupName).toBe('clientes');
  });

  test('+grupos => LISTAR', function () {
    var r = parseGroupCommand('+grupos');
    expect(r.command).toBe('LISTAR');
    expect(r.args).toEqual({});
  });

  test('texto sin coincidencia => null', function () {
    expect(parseGroupCommand('hola mundo')).toBeNull();
  });
});

// ── constantes exportadas ─────────────────────────────────────────────────────
describe('constantes', function () {
  test('VALID_GROUP_TYPES tiene los 5 tipos', function () {
    expect(VALID_GROUP_TYPES).toContain('lead');
    expect(VALID_GROUP_TYPES).toContain('cliente');
    expect(VALID_GROUP_TYPES).toContain('familia');
    expect(VALID_GROUP_TYPES).toContain('equipo');
    expect(VALID_GROUP_TYPES).toContain('custom');
  });

  test('MAX_GROUPS_PER_OWNER = 20', function () {
    expect(MAX_GROUPS_PER_OWNER).toBe(20);
  });

  test('GROUP_COMMANDS tiene los 4 comandos', function () {
    expect(GROUP_COMMANDS.CREAR).toBeDefined();
    expect(GROUP_COMMANDS.AGREGAR).toBeDefined();
    expect(GROUP_COMMANDS.MOVER).toBeDefined();
    expect(GROUP_COMMANDS.LISTAR).toBeDefined();
  });
});
