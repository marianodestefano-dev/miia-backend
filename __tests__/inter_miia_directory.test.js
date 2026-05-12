'use strict';

const dir = require('../core/inter_miia_directory');
const {
  setPublicProfile,
  getPublicProfile,
  searchOwners,
  deriveLead,
  updateDerivationStatus,
  recordDerivationSignal,
  isFraudBlocked,
  unblockPhone,
  FRAUD_THRESHOLD_DERIV_DAY,
  FRAUD_THRESHOLD_SAME_PHONE,
  __setFirestoreForTests,
} = dir;

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeProfileSnap(exists, data) {
  return { exists, data: () => data || {} };
}

function makeFraudSnap(exists, data) {
  return { exists, data: () => data || {} };
}

/**
 * makeDb: profileByUid (uid -> profile snap data), fraudByPhone (uid_phone -> fraud snap data),
 * ownersDocs (array de docs con .id), capturedSets para inspeccionar writes.
 */
function makeDb(opts) {
  const o = opts || {};
  const profileMap = o.profileByUid || {};
  const fraudMap = o.fraudByPhone || {};
  const ownersDocs = o.ownersDocs || [];
  const derivations = o.derivations || {};

  const captures = { profileSets: [], fraudSets: [], derivationSets: [] };

  const ownersGetFn = jest.fn().mockResolvedValue({ docs: ownersDocs.map((id) => ({ id })) });

  // owners.doc(uid) returns an object whose collection() routes to the right subcoll for that uid
  const ownerDocFn = jest.fn((uid) => {
    return {
      collection: function (subColName) {
        if (subColName === 'profile_public') {
          return {
            doc: function (_docId) {
              return {
                get: function () {
                  const has = profileMap[uid] !== undefined && profileMap[uid] !== null;
                  return Promise.resolve(makeProfileSnap(has, profileMap[uid] || {}));
                },
                set: function (payload, merge) {
                  captures.profileSets.push({ uid, payload, merge });
                  return Promise.resolve({});
                },
              };
            },
          };
        }
        if (subColName === 'fraud_signals') {
          return {
            doc: function (phone) {
              const key = uid + '_' + phone;
              return {
                get: function () {
                  const data = fraudMap[key];
                  return Promise.resolve(makeFraudSnap(data !== undefined, data || {}));
                },
                set: function (payload, merge) {
                  captures.fraudSets.push({ uid, phone, payload, merge });
                  return Promise.resolve({});
                },
              };
            },
          };
        }
        // derivations
        return {
          doc: function (id) {
            return {
              get: function () {
                return Promise.resolve({ exists: !!derivations[id], data: () => derivations[id] || {} });
              },
              set: function (payload, merge) {
                captures.derivationSets.push({ uid, id, payload, merge });
                return Promise.resolve({});
              },
            };
          },
        };
      },
    };
  });

  const ownersColl = { doc: ownerDocFn, get: ownersGetFn };

  const db = { collection: jest.fn(() => ownersColl) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── setPublicProfile ──────────────────────────────────────────────────────────

describe('setPublicProfile', () => {
  test('uid null -> throw', async () => {
    await expect(setPublicProfile(null, { categoria: 'x' })).rejects.toThrow('uid_requerido');
  });
  test('profile null -> throw', async () => {
    await expect(setPublicProfile('uid1', null)).rejects.toThrow('profile_invalido');
  });
  test('profile no objeto -> throw', async () => {
    await expect(setPublicProfile('uid1', 'string')).rejects.toThrow('profile_invalido');
  });

  test('OK - minimo', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    const r = await setPublicProfile('uid123456', { opt_in_red: true });
    expect(r.ok).toBe(true);
    expect(captures.profileSets[0].payload.opt_in_red).toBe(true);
    expect(captures.profileSets[0].payload.servicios).toEqual([]);
    expect(captures.profileSets[0].payload.zona).toBe('');
    expect(captures.profileSets[0].payload.categoria).toBeNull();
  });

  test('OK - completo con normalizacion lowercase', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    await setPublicProfile('uid123456', {
      categoria: 'salud',
      zona: 'BOGOTA',
      servicios: ['Dermatologia', 'Pediatria'],
      opt_in_red: true,
    });
    expect(captures.profileSets[0].payload.zona).toBe('bogota');
    expect(captures.profileSets[0].payload.servicios).toEqual(['dermatologia', 'pediatria']);
  });

  test('servicios no array -> []', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    await setPublicProfile('uid123456', { servicios: 'no_array' });
    expect(captures.profileSets[0].payload.servicios).toEqual([]);
  });
});

// ── getPublicProfile ──────────────────────────────────────────────────────────

describe('getPublicProfile', () => {
  test('uid null -> throw', async () => {
    await expect(getPublicProfile(null)).rejects.toThrow('uid_requerido');
  });

  test('no existe -> null', async () => {
    const { db } = makeDb({ profileByUid: {} });
    __setFirestoreForTests(db);
    expect(await getPublicProfile('uid123456')).toBeNull();
  });

  test('OK', async () => {
    const profile = { categoria: 'salud', opt_in_red: true };
    const { db } = makeDb({ profileByUid: { uid123456: profile } });
    __setFirestoreForTests(db);
    const r = await getPublicProfile('uid123456');
    expect(r.categoria).toBe('salud');
  });
});

// ── searchOwners ──────────────────────────────────────────────────────────────

describe('searchOwners', () => {
  test('no owners -> []', async () => {
    const { db } = makeDb({ ownersDocs: [], profileByUid: {} });
    __setFirestoreForTests(db);
    expect(await searchOwners({})).toEqual([]);
  });

  test('owner sin perfil publico -> excluido', async () => {
    const { db } = makeDb({ ownersDocs: ['u1'], profileByUid: {} });
    __setFirestoreForTests(db);
    expect(await searchOwners({})).toEqual([]);
  });

  test('owner sin opt_in_red -> excluido', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: false } },
    });
    __setFirestoreForTests(db);
    expect(await searchOwners({})).toEqual([]);
  });

  test('zona no match -> excluido', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'medellin', categoria: 'salud', servicios: [] } },
    });
    __setFirestoreForTests(db);
    expect(await searchOwners({ zona: 'BOGOTA' })).toEqual([]);
  });

  test('categoria no match -> excluido', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'bogota', categoria: 'turismo', servicios: [] } },
    });
    __setFirestoreForTests(db);
    expect(await searchOwners({ categoria: 'salud' })).toEqual([]);
  });

  test('servicio no match -> excluido', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'bogota', categoria: 'salud', servicios: ['cardiologia'] } },
    });
    __setFirestoreForTests(db);
    expect(await searchOwners({ servicio: 'dermatologia' })).toEqual([]);
  });

  test('servicio match exact', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'bogota', categoria: 'salud', servicios: ['dermatologia'] } },
    });
    __setFirestoreForTests(db);
    const r = await searchOwners({ servicio: 'dermatologia' });
    expect(r).toHaveLength(1);
  });

  test('servicio match parcial (includes)', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'bogota', categoria: 'salud', servicios: ['dermatologia_estetica'] } },
    });
    __setFirestoreForTests(db);
    const r = await searchOwners({ servicio: 'derma' });
    expect(r).toHaveLength(1);
  });

  test('servicio sin servicios array -> excluido', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'bogota', categoria: 'salud' } },
    });
    __setFirestoreForTests(db);
    expect(await searchOwners({ servicio: 'derma' })).toEqual([]);
  });

  test('limit > MAX_RESULTS -> capped a MAX_RESULTS', async () => {
    const owners = Array.from({ length: 25 }, function (_, i) { return 'u' + i; });
    const profileByUid = {};
    owners.forEach(function (uid) {
      profileByUid[uid] = { opt_in_red: true, zona: 'bogota', categoria: 'salud', servicios: ['derm'] };
    });
    const { db } = makeDb({ ownersDocs: owners, profileByUid });
    __setFirestoreForTests(db);
    const r = await searchOwners({ limit: 100 });
    expect(r).toHaveLength(20);
  });

  test('limit por defecto 10', async () => {
    const owners = Array.from({ length: 15 }, function (_, i) { return 'u' + i; });
    const profileByUid = {};
    owners.forEach(function (uid) {
      profileByUid[uid] = { opt_in_red: true, zona: 'bogota', categoria: 'salud', servicios: [] };
    });
    const { db } = makeDb({ ownersDocs: owners, profileByUid });
    __setFirestoreForTests(db);
    const r = await searchOwners({});
    expect(r).toHaveLength(10);
  });

  test('snap.docs undefined -> []', async () => {
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
        })),
        get: jest.fn().mockResolvedValue({}),
      })),
    };
    __setFirestoreForTests(db);
    expect(await searchOwners({})).toEqual([]);
  });

  test('criteria=undefined -> usa {} (limit default 10)', async () => {
    const { db } = makeDb({ ownersDocs: [], profileByUid: {} });
    __setFirestoreForTests(db);
    expect(await searchOwners()).toEqual([]);
  });

  test('owner con perfil pero servicios no presente y sin criterio servicio -> incluido (servicios=[])', async () => {
    const { db } = makeDb({
      ownersDocs: ['u1'],
      profileByUid: { u1: { opt_in_red: true, zona: 'bogota', categoria: 'salud' } },
    });
    __setFirestoreForTests(db);
    const r = await searchOwners({ zona: 'bogota' });
    expect(r).toHaveLength(1);
    expect(r[0].servicios).toEqual([]);
  });
});

// ── recordDerivationSignal ────────────────────────────────────────────────────

describe('recordDerivationSignal', () => {
  test('uid null -> throw', async () => {
    await expect(recordDerivationSignal(null, '5491100')).rejects.toThrow('parametros_requeridos');
  });
  test('phone null -> throw', async () => {
    await expect(recordDerivationSignal('uid1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('primer registro -> count=1, no bloqueado', async () => {
    const { db, captures } = makeDb({ fraudByPhone: {} });
    __setFirestoreForTests(db);
    const r = await recordDerivationSignal('uid123456', '5491100');
    expect(r.count_day).toBe(1);
    expect(r.count_total).toBe(1);
    expect(r.blocked).toBe(false);
    expect(captures.fraudSets[0].payload.blocked).toBe(false);
  });

  test('supera FRAUD_THRESHOLD_SAME_PHONE -> blocked', async () => {
    const { db } = makeDb({
      fraudByPhone: {
        'uid123456_5491100': {
          count_day: 2, count_total: FRAUD_THRESHOLD_SAME_PHONE - 1,
          last_day_start: new Date().toISOString(),
        },
      },
    });
    __setFirestoreForTests(db);
    const r = await recordDerivationSignal('uid123456', '5491100');
    expect(r.blocked).toBe(true);
    expect(r.count_total).toBe(FRAUD_THRESHOLD_SAME_PHONE);
  });

  test('supera FRAUD_THRESHOLD_DERIV_DAY -> blocked', async () => {
    const { db } = makeDb({
      fraudByPhone: {
        'uid123456_5491100': {
          count_day: FRAUD_THRESHOLD_DERIV_DAY - 1, count_total: 1,
          last_day_start: new Date().toISOString(),
        },
      },
    });
    __setFirestoreForTests(db);
    const r = await recordDerivationSignal('uid123456', '5491100');
    expect(r.blocked).toBe(true);
    expect(r.count_day).toBe(FRAUD_THRESHOLD_DERIV_DAY);
  });

  test('dia distinto -> count_day reset a 1', async () => {
    const oldDay = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      fraudByPhone: {
        'uid123456_5491100': { count_day: 5, count_total: 5, last_day_start: oldDay },
      },
    });
    __setFirestoreForTests(db);
    const r = await recordDerivationSignal('uid123456', '5491100');
    expect(r.count_day).toBe(1);
    expect(r.count_total).toBe(6);
  });

  test('snap sin last_day_start (data{}) -> lastDay=0 cae a no-same-day', async () => {
    const { db } = makeDb({
      fraudByPhone: { 'uid123456_5491100': { count_day: 5, count_total: 5 } },
    });
    __setFirestoreForTests(db);
    const r = await recordDerivationSignal('uid123456', '5491100');
    expect(r.count_day).toBe(1);
  });

  test('inSameDay=true pero count_day undefined -> count_day=1 (rama || 0)', async () => {
    const { db } = makeDb({
      fraudByPhone: {
        'uid123456_5491100': {
          last_day_start: new Date().toISOString(),
          count_total: 1,
        },
      },
    });
    __setFirestoreForTests(db);
    const r = await recordDerivationSignal('uid123456', '5491100');
    expect(r.count_day).toBe(1);
  });
});

// ── isFraudBlocked ────────────────────────────────────────────────────────────

describe('isFraudBlocked', () => {
  test('uid null -> false', async () => {
    expect(await isFraudBlocked(null, '5491100')).toBe(false);
  });
  test('phone null -> false', async () => {
    expect(await isFraudBlocked('uid1', null)).toBe(false);
  });

  test('no existe -> false', async () => {
    const { db } = makeDb({ fraudByPhone: {} });
    __setFirestoreForTests(db);
    expect(await isFraudBlocked('uid123456', '5491100')).toBe(false);
  });

  test('blocked=false -> false', async () => {
    const { db } = makeDb({
      fraudByPhone: { 'uid123456_5491100': { blocked: false } },
    });
    __setFirestoreForTests(db);
    expect(await isFraudBlocked('uid123456', '5491100')).toBe(false);
  });

  test('blocked=true sin TTL -> true', async () => {
    const { db } = makeDb({
      fraudByPhone: { 'uid123456_5491100': { blocked: true } },
    });
    __setFirestoreForTests(db);
    expect(await isFraudBlocked('uid123456', '5491100')).toBe(true);
  });

  test('blocked=true con TTL expirado -> false', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const { db } = makeDb({
      fraudByPhone: { 'uid123456_5491100': { blocked: true, blocked_until: past } },
    });
    __setFirestoreForTests(db);
    expect(await isFraudBlocked('uid123456', '5491100')).toBe(false);
  });

  test('blocked=true con TTL vigente -> true', async () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeDb({
      fraudByPhone: { 'uid123456_5491100': { blocked: true, blocked_until: future } },
    });
    __setFirestoreForTests(db);
    expect(await isFraudBlocked('uid123456', '5491100')).toBe(true);
  });
});

// ── unblockPhone ──────────────────────────────────────────────────────────────

describe('unblockPhone', () => {
  test('uid null -> throw', async () => {
    await expect(unblockPhone(null, '5491100')).rejects.toThrow('parametros_requeridos');
  });
  test('phone null -> throw', async () => {
    await expect(unblockPhone('uid1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('OK', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await unblockPhone('uid123456', '5491100');
    expect(r.ok).toBe(true);
    expect(captures.fraudSets[0].payload.blocked).toBe(false);
  });
});

// ── deriveLead ────────────────────────────────────────────────────────────────

describe('deriveLead', () => {
  test('fromUid null -> throw', async () => {
    await expect(deriveLead(null, 'u2', { phone: 'p', motivo: 'm' })).rejects.toThrow('uids_requeridos');
  });
  test('toUid null -> throw', async () => {
    await expect(deriveLead('u1', null, { phone: 'p', motivo: 'm' })).rejects.toThrow('uids_requeridos');
  });
  test('mismo uid -> throw', async () => {
    await expect(deriveLead('u1', 'u1', { phone: 'p', motivo: 'm' })).rejects.toThrow('mismo_uid_invalido');
  });
  test('leadInfo null -> throw', async () => {
    await expect(deriveLead('u1', 'u2', null)).rejects.toThrow('lead_info_incompleto');
  });
  test('leadInfo sin phone -> throw', async () => {
    await expect(deriveLead('u1', 'u2', { motivo: 'm' })).rejects.toThrow('lead_info_incompleto');
  });
  test('leadInfo sin motivo -> throw', async () => {
    await expect(deriveLead('u1', 'u2', { phone: 'p' })).rejects.toThrow('lead_info_incompleto');
  });

  test('destino sin perfil -> throw', async () => {
    const { db } = makeDb({ profileByUid: {} });
    __setFirestoreForTests(db);
    await expect(deriveLead('u1from123', 'u2to12345', { phone: '5491100', motivo: 'urgente' }))
      .rejects.toThrow('destino_sin_perfil');
  });

  test('destino sin opt_in -> throw', async () => {
    const { db } = makeDb({ profileByUid: { 'u2to12345': { opt_in_red: false } } });
    __setFirestoreForTests(db);
    await expect(deriveLead('u1from123', 'u2to12345', { phone: '5491100', motivo: 'urgente' }))
      .rejects.toThrow('destino_no_acepta_red');
  });

  test('phone bloqueado por fraude -> throw', async () => {
    const { db } = makeDb({
      profileByUid: { 'u2to12345': { opt_in_red: true } },
      fraudByPhone: { 'u1from123_5491100': { blocked: true } },
    });
    __setFirestoreForTests(db);
    await expect(deriveLead('u1from123', 'u2to12345', { phone: '5491100', motivo: 'urgente' }))
      .rejects.toThrow('bloqueado_por_fraude');
  });

  test('OK - deriva exitosamente', async () => {
    const { db, captures } = makeDb({
      profileByUid: { 'u2to12345': { opt_in_red: true } },
      fraudByPhone: {},
    });
    __setFirestoreForTests(db);
    const r = await deriveLead('u1from123', 'u2to12345', {
      phone: '5491100',
      motivo: 'urgente',
      contacto_nombre: 'Juan',
    });
    expect(r.ok).toBe(true);
    expect(r.derivationId).toMatch(/^der_/);
    expect(captures.derivationSets).toHaveLength(2); // 1 en fromUid, 1 en toUid
  });

  test('OK sin contacto_nombre -> null', async () => {
    const { db, captures } = makeDb({
      profileByUid: { 'u2to12345': { opt_in_red: true } },
    });
    __setFirestoreForTests(db);
    await deriveLead('u1from123', 'u2to12345', { phone: '5491100', motivo: 'urgente' });
    expect(captures.derivationSets[0].payload.contacto_nombre).toBeNull();
  });
});

// ── updateDerivationStatus ────────────────────────────────────────────────────

describe('updateDerivationStatus', () => {
  test('uid null -> throw', async () => {
    await expect(updateDerivationStatus(null, 'd1', 'aceptado')).rejects.toThrow('parametros_requeridos');
  });
  test('derivationId null -> throw', async () => {
    await expect(updateDerivationStatus('u1', null, 'aceptado')).rejects.toThrow('parametros_requeridos');
  });
  test('status invalido -> throw', async () => {
    await expect(updateDerivationStatus('u1', 'd1', 'foo')).rejects.toThrow('status_invalido');
  });

  test('OK - aceptado', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await updateDerivationStatus('uid123456', 'der_1', 'aceptado');
    expect(r.ok).toBe(true);
    expect(captures.derivationSets[0].payload.status).toBe('aceptado');
  });

  test('OK - rechazado', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await updateDerivationStatus('uid123456', 'der_1', 'rechazado');
    expect(r.status).toBe('rechazado');
  });

  test('OK - cerrado', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await updateDerivationStatus('uid123456', 'der_1', 'cerrado');
    expect(r.status).toBe('cerrado');
  });
});
