'use strict';

const {
  registerNumber, getOwnerNumbers, updateNumber, getNumberByRole, routeMessage,
  NUMBER_ROLES, DEFAULT_ROLE, MAX_NUMBERS_PER_OWNER,
  __setFirestoreForTests,
} = require('../core/multi_number_manager');

const UID = 'testUid1234567890';
const PHONE1 = '+541155667788';
const PHONE2 = '+541144556677';

function makeMockDb({ numbers = [], throwSet = false } = {}) {
  const numDocs = numbers.map((n, i) => ({ id: 'num' + i, data: () => n }));
  const numColl = {
    doc: () => ({ set: async (d, o) => { if (throwSet) throw new Error('set error'); } }),
    get: async () => ({ forEach: fn => numDocs.forEach(fn) }),
  };
  const uidDoc = { collection: () => numColl };
  return { collection: () => ({ doc: () => uidDoc }) };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('NUMBER_ROLES y constants', () => {
  test('incluye sales, support, delivery, general', () => {
    expect(NUMBER_ROLES).toContain('sales');
    expect(NUMBER_ROLES).toContain('support');
    expect(NUMBER_ROLES).toContain('delivery');
    expect(NUMBER_ROLES).toContain('general');
  });
  test('es frozen', () => {
    expect(() => { NUMBER_ROLES.push('x'); }).toThrow();
  });
  test('DEFAULT_ROLE es general', () => {
    expect(DEFAULT_ROLE).toBe('general');
  });
  test('MAX_NUMBERS_PER_OWNER es 5', () => {
    expect(MAX_NUMBERS_PER_OWNER).toBe(5);
  });
});

describe('registerNumber', () => {
  test('lanza si uid undefined', async () => {
    await expect(registerNumber(undefined, PHONE1)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(registerNumber(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('lanza si phone formato invalido', async () => {
    await expect(registerNumber(UID, '155667788')).rejects.toThrow('formato invalido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerNumber(UID, PHONE1, { role: 'sales' })).resolves.toBeUndefined();
  });
  test('usa DEFAULT_ROLE si rol invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(registerNumber(UID, PHONE1, { role: 'rol_falso' })).resolves.toBeUndefined();
  });
  test('lanza si maximo de numeros alcanzado', async () => {
    const maxNumbers = Array.from({ length: 5 }, (_, i) => ({ phone: '+5411556677' + i, active: true }));
    __setFirestoreForTests(makeMockDb({ numbers: maxNumbers }));
    await expect(registerNumber(UID, PHONE2)).rejects.toThrow('maximo ' + MAX_NUMBERS_PER_OWNER);
  });
  test('lanza si numero ya registrado', async () => {
    __setFirestoreForTests(makeMockDb({ numbers: [{ phone: PHONE1, active: true }] }));
    await expect(registerNumber(UID, PHONE1)).rejects.toThrow('ya registrado');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(registerNumber(UID, PHONE1)).rejects.toThrow('set error');
  });
});

describe('getOwnerNumbers', () => {
  test('lanza si uid undefined', async () => {
    await expect(getOwnerNumbers(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si sin numeros', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getOwnerNumbers(UID)).toEqual([]);
  });
  test('retorna numeros registrados', async () => {
    __setFirestoreForTests(makeMockDb({ numbers: [{ phone: PHONE1, role: 'sales', active: true }] }));
    const nums = await getOwnerNumbers(UID);
    expect(nums.length).toBe(1);
    expect(nums[0].phone).toBe(PHONE1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { throw new Error('err'); } }) }) }) });
    expect(await getOwnerNumbers(UID)).toEqual([]);
  });
});

describe('updateNumber', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateNumber(undefined, PHONE1, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(updateNumber(UID, undefined, {})).rejects.toThrow('phone requerido');
  });
  test('lanza si updates undefined', async () => {
    await expect(updateNumber(UID, PHONE1, null)).rejects.toThrow('updates requerido');
  });
  test('lanza si rol invalido', async () => {
    await expect(updateNumber(UID, PHONE1, { role: 'rol_falso' })).rejects.toThrow('rol invalido');
  });
  test('actualiza sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateNumber(UID, PHONE1, { role: 'support', active: false })).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(updateNumber(UID, PHONE1, { role: 'support' })).rejects.toThrow('set error');
  });
});

describe('getNumberByRole', () => {
  test('lanza si uid undefined', async () => {
    await expect(getNumberByRole(undefined, 'sales')).rejects.toThrow('uid requerido');
  });
  test('lanza si role invalido', async () => {
    await expect(getNumberByRole(UID, 'rol_falso')).rejects.toThrow('rol invalido');
  });
  test('retorna null si sin numeros con ese rol', async () => {
    __setFirestoreForTests(makeMockDb({ numbers: [{ phone: PHONE1, role: 'general', active: true }] }));
    expect(await getNumberByRole(UID, 'sales')).toBeNull();
  });
  test('retorna numero con rol correcto', async () => {
    __setFirestoreForTests(makeMockDb({ numbers: [{ phone: PHONE1, role: 'sales', active: true }] }));
    expect(await getNumberByRole(UID, 'sales')).toBe(PHONE1);
  });
});

describe('routeMessage', () => {
  test('lanza si uid undefined', async () => {
    await expect(routeMessage(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si context undefined', async () => {
    await expect(routeMessage(UID, null)).rejects.toThrow('context requerido');
  });
  test('retorna null si sin numeros', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await routeMessage(UID, {})).toBeNull();
  });
  test('ruta a vip si isVip y hay numero vip', async () => {
    const nums = [{ phone: PHONE1, role: 'vip', active: true }, { phone: PHONE2, role: 'general', active: true }];
    __setFirestoreForTests(makeMockDb({ numbers: nums }));
    expect(await routeMessage(UID, { isVip: true })).toBe(PHONE1);
  });
  test('ruta a support si isExistingClient', async () => {
    const nums = [{ phone: PHONE1, role: 'support', active: true }, { phone: PHONE2, role: 'general', active: true }];
    __setFirestoreForTests(makeMockDb({ numbers: nums }));
    expect(await routeMessage(UID, { isExistingClient: true })).toBe(PHONE1);
  });
  test('ruta a general si no hay match especifico', async () => {
    const nums = [{ phone: PHONE2, role: 'general', active: true }];
    __setFirestoreForTests(makeMockDb({ numbers: nums }));
    expect(await routeMessage(UID, {})).toBe(PHONE2);
  });
});
