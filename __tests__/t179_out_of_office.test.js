'use strict';

const {
  activateOOO, deactivateOOO, getOOOState, isOOOActive,
  buildOOOResponse, recordLeadInfoDuringOOO,
  getPendingOOOLeads, markOOOLeadProcessed,
  OOO_MODES, DEFAULT_MODE, DEFAULT_MESSAGE_ES,
  MAX_OOO_DAYS, __setFirestoreForTests,
} = require('../core/out_of_office');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const FUTURE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

function makeMockDb({ storedDoc = null, throwGet = false, throwSet = false, pendingLeads = [] } = {}) {
  const oooDoc = {
    set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
    get: async () => {
      if (throwGet) throw new Error('get error');
      if (storedDoc) return { exists: true, data: () => storedDoc };
      return { exists: false, data: () => null };
    },
  };
  const pendingColl = {
    doc: () => ({
      set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
    }),
    where: () => ({
      get: async () => {
        if (throwGet) throw new Error('get error');
        const items = pendingLeads.map((l, i) => ({ id: 'lead' + i, data: () => l }));
        return { forEach: fn => items.forEach(fn) };
      },
    }),
  };
  const oooLeadDoc = {
    collection: () => pendingColl,
  };
  return {
    collection: (name) => {
      if (name === 'out_of_office') return { doc: () => oooDoc };
      if (name === 'ooo_leads') return { doc: () => oooLeadDoc };
      return { doc: () => oooDoc };
    },
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('OOO_MODES y constants', () => {
  test('incluye auto_reply y full_handle', () => {
    expect(OOO_MODES).toContain('auto_reply');
    expect(OOO_MODES).toContain('full_handle');
  });
  test('es frozen', () => {
    expect(() => { OOO_MODES.push('nuevo'); }).toThrow();
  });
  test('DEFAULT_MODE es auto_reply', () => {
    expect(DEFAULT_MODE).toBe('auto_reply');
  });
  test('MAX_OOO_DAYS es 30', () => {
    expect(MAX_OOO_DAYS).toBe(30);
  });
});

describe('activateOOO', () => {
  test('lanza si uid undefined', async () => {
    await expect(activateOOO(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si modo invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(activateOOO(UID, { mode: 'modo_falso' })).rejects.toThrow('modo invalido');
  });
  test('lanza si returnAt formato invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(activateOOO(UID, { returnAt: 'no-una-fecha' })).rejects.toThrow('formato invalido');
  });
  test('lanza si returnAt mas de MAX_OOO_DAYS', async () => {
    __setFirestoreForTests(makeMockDb());
    const farFuture = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    await expect(activateOOO(UID, { returnAt: farFuture })).rejects.toThrow('mas de ' + MAX_OOO_DAYS);
  });
  test('activa sin error con opciones default', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(activateOOO(UID)).resolves.toBeUndefined();
  });
  test('activa con modo collect_info', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(activateOOO(UID, { mode: 'collect_info', returnAt: FUTURE })).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(activateOOO(UID)).rejects.toThrow('set error');
  });
});


describe('deactivateOOO', () => {
  test('lanza si uid undefined', async () => {
    await expect(deactivateOOO(undefined)).rejects.toThrow('uid requerido');
  });
  test('desactiva sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(deactivateOOO(UID)).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(deactivateOOO(UID)).rejects.toThrow('set error');
  });
});

describe('getOOOState', () => {
  test('lanza si uid undefined', async () => {
    await expect(getOOOState(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna null si no hay estado', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = await getOOOState(UID);
    expect(s).toBeNull();
  });
  test('retorna estado guardado', async () => {
    __setFirestoreForTests(makeMockDb({ storedDoc: { uid: UID, active: true, mode: 'auto_reply', returnAt: FUTURE } }));
    const s = await getOOOState(UID);
    expect(s.active).toBe(true);
    expect(s.mode).toBe('auto_reply');
  });
  test('auto-expira si returnAt ya paso', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ storedDoc: { uid: UID, active: true, returnAt: pastDate } }));
    const s = await getOOOState(UID);
    expect(s._autoExpired).toBe(true);
    expect(s.active).toBe(false);
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const s = await getOOOState(UID);
    expect(s).toBeNull();
  });
});

describe('isOOOActive', () => {
  test('lanza si uid undefined', async () => {
    await expect(isOOOActive(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna false si sin estado', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await isOOOActive(UID)).toBe(false);
  });
  test('retorna true si activo', async () => {
    __setFirestoreForTests(makeMockDb({ storedDoc: { uid: UID, active: true, returnAt: FUTURE } }));
    expect(await isOOOActive(UID)).toBe(true);
  });
  test('retorna false si auto-expirado', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ storedDoc: { uid: UID, active: true, returnAt: past } }));
    expect(await isOOOActive(UID)).toBe(false);
  });
});

describe('buildOOOResponse', () => {
  test('lanza si oooState undefined', () => {
    expect(() => buildOOOResponse(null, {})).toThrow('oooState requerido');
  });
  test('lanza si OOO no activo', () => {
    expect(() => buildOOOResponse({ active: false }, {})).toThrow('no esta activo');
  });
  test('retorna mensaje custom', () => {
    const msg = buildOOOResponse({ active: true, message: 'Mensaje custom' }, {});
    expect(msg).toContain('Mensaje custom');
  });
  test('retorna DEFAULT_MESSAGE si sin message', () => {
    const msg = buildOOOResponse({ active: true }, {});
    expect(msg).toContain(DEFAULT_MESSAGE_ES);
  });
  test('incluye fecha returnAt en mensaje', () => {
    const msg = buildOOOResponse({ active: true, message: 'Hola', returnAt: FUTURE }, {});
    expect(msg).toContain('disponible');
  });
});

describe('recordLeadInfoDuringOOO y getPendingOOOLeads', () => {
  test('lanza si uid undefined en record', async () => {
    await expect(recordLeadInfoDuringOOO(undefined, PHONE, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(recordLeadInfoDuringOOO(UID, undefined, {})).rejects.toThrow('phone requerido');
  });
  test('lanza si collectedInfo no es objeto', async () => {
    await expect(recordLeadInfoDuringOOO(UID, PHONE, null)).rejects.toThrow('collectedInfo requerido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordLeadInfoDuringOOO(UID, PHONE, { name: 'Juan' })).resolves.toBeUndefined();
  });
  test('propaga error Firestore en record', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordLeadInfoDuringOOO(UID, PHONE, { name: 'Juan' })).rejects.toThrow('set error');
  });
  test('lanza si uid undefined en get', async () => {
    await expect(getPendingOOOLeads(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si sin leads', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getPendingOOOLeads(UID);
    expect(r).toEqual([]);
  });
  test('retorna leads pendientes', async () => {
    const leads = [{ uid: UID, phone: PHONE, processed: false }];
    __setFirestoreForTests(makeMockDb({ pendingLeads: leads }));
    const r = await getPendingOOOLeads(UID);
    expect(r.length).toBe(1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getPendingOOOLeads(UID);
    expect(r).toEqual([]);
  });
});

describe('markOOOLeadProcessed', () => {
  test('lanza si uid undefined', async () => {
    await expect(markOOOLeadProcessed(undefined, 'lead1')).rejects.toThrow('uid requerido');
  });
  test('lanza si leadId undefined', async () => {
    await expect(markOOOLeadProcessed(UID, undefined)).rejects.toThrow('leadId requerido');
  });
  test('marca sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(markOOOLeadProcessed(UID, 'lead1')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(markOOOLeadProcessed(UID, 'lead1')).rejects.toThrow('set error');
  });
});
