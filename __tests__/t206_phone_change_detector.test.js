'use strict';

const {
  normalizePhone, isSamePhone, recordPhoneChange,
  getPhoneHistory, getCurrentPhone,
  CHANGE_REASONS, MAX_LINKED_NUMBERS,
  __setFirestoreForTests,
} = require('../core/phone_change_detector');

const UID = 'testUid1234567890';
const OLD_PHONE = '+541155667788';
const NEW_PHONE = '+541199887766';

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var innerDoc = {
    set: async function(data, setOpts) { if (throwSet) throw new Error('set error'); },
  };

  var coll = {
    doc: function() { return innerDoc; },
    where: function() {
      return {
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'c' + i }); }); } };
        },
      };
    },
  };

  var uidDoc = { collection: function() { return coll; } };
  var tenantUidDoc = { collection: function() { return { doc: function() { return innerDoc; } }; } };

  return {
    collection: function(name) {
      if (name === 'tenants') return { doc: function() { return tenantUidDoc; } };
      return { doc: function() { return uidDoc; } };
    },
  };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('normalizePhone', function() {
  test('retorna null para input invalido', function() {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
  test('normaliza numero con +', function() {
    expect(normalizePhone('+541155667788')).toBe('+541155667788');
  });
  test('agrega + si falta', function() {
    var r = normalizePhone('541155667788');
    expect(r).toBe('+541155667788');
  });
  test('retorna null para numero muy corto', function() {
    expect(normalizePhone('+12345')).toBeNull();
  });
});

describe('isSamePhone', function() {
  test('retorna true para mismo numero', function() {
    expect(isSamePhone('+541155667788', '+541155667788')).toBe(true);
  });
  test('retorna false para numeros diferentes', function() {
    expect(isSamePhone('+541155667788', '+541199887766')).toBe(false);
  });
  test('retorna true para mismo sufijo de 10 digitos', function() {
    expect(isSamePhone('+541155667788', '+5411155667788')).toBe(true);
  });
  test('retorna false si alguno es null', function() {
    expect(isSamePhone(null, '+541155667788')).toBe(false);
  });
});

describe('CHANGE_REASONS y constants', function() {
  test('tiene los tipos basicos', function() {
    expect(CHANGE_REASONS).toContain('self_reported');
    expect(CHANGE_REASONS).toContain('owner_manual');
  });
  test('frozen', function() { expect(function() { CHANGE_REASONS[0] = 'x'; }).toThrow(); });
  test('MAX_LINKED_NUMBERS es 5', function() { expect(MAX_LINKED_NUMBERS).toBe(5); });
});

describe('recordPhoneChange', function() {
  test('lanza si uid undefined', async function() {
    await expect(recordPhoneChange(undefined, OLD_PHONE, NEW_PHONE, 'self_reported')).rejects.toThrow('uid requerido');
  });
  test('lanza si oldPhone undefined', async function() {
    await expect(recordPhoneChange(UID, undefined, NEW_PHONE, 'self_reported')).rejects.toThrow('oldPhone requerido');
  });
  test('lanza si reason invalido', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordPhoneChange(UID, OLD_PHONE, NEW_PHONE, 'razon_rara')).rejects.toThrow('invalido');
  });
  test('lanza si oldPhone igual a newPhone', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordPhoneChange(UID, OLD_PHONE, OLD_PHONE, 'self_reported')).rejects.toThrow('mismo numero');
  });
  test('registra cambio correctamente', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await recordPhoneChange(UID, OLD_PHONE, NEW_PHONE, 'self_reported');
    expect(r.oldPhone).toBe(OLD_PHONE);
    expect(r.newPhone).toBe(NEW_PHONE);
    expect(r.docId).toBeDefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordPhoneChange(UID, OLD_PHONE, NEW_PHONE, 'self_reported')).rejects.toThrow('set error');
  });
});

describe('getPhoneHistory', function() {
  test('lanza si uid undefined', async function() {
    await expect(getPhoneHistory(undefined, OLD_PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay historial', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getPhoneHistory(UID, OLD_PHONE);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getPhoneHistory(UID, OLD_PHONE);
    expect(r).toEqual([]);
  });
});

describe('getCurrentPhone', function() {
  test('lanza si uid undefined', async function() {
    await expect(getCurrentPhone(undefined, OLD_PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna mismo numero si no hay cambios', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getCurrentPhone(UID, OLD_PHONE);
    expect(r.currentPhone).toBe(OLD_PHONE);
    expect(r.changed).toBe(false);
  });
  test('retorna numero nuevo si hay cambio registrado', async function() {
    var docs = [{ oldPhone: OLD_PHONE, newPhone: NEW_PHONE, recordedAt: new Date().toISOString() }];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    var r = await getCurrentPhone(UID, OLD_PHONE);
    expect(r.currentPhone).toBe(NEW_PHONE);
    expect(r.changed).toBe(true);
  });
  test('fail-open retorna numero original si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getCurrentPhone(UID, OLD_PHONE);
    expect(r.currentPhone).toBe(OLD_PHONE);
    expect(r.changed).toBe(false);
  });
});
