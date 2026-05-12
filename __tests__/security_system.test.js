'use strict';

const {
  requestConfirmation, checkConfirmation, DEFAULT_EXPIRES_MS,
  __setFirestoreForTests: __setFsGuard,
} = require('../core/action_guard');

const {
  generateOTP, validateOTP, sendOTPEmail, RATE_LIMIT_MAX,
  __setFirestoreForTests: __setFsOTP,
} = require('../core/otp_service');

const {
  addTrustedContact, initiateRecovery, completeRecovery, RECOVERY_TTL_MS,
  __setFirestoreForTests: __setFsRecovery,
} = require('../core/recovery_service');

// ── Helpers de mock Firestore ──────────────────────────────────────────────
function makeMockDb(snapExists, snapData) {
  const mockSet = jest.fn().mockResolvedValue(undefined);
  const ref = {
    get: jest.fn().mockResolvedValue({ exists: snapExists, data: () => JSON.parse(JSON.stringify(snapData)) }),
    set: mockSet,
  };
  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({ doc: () => ref }),
        get: jest.fn().mockResolvedValue({ exists: snapExists, data: () => JSON.parse(JSON.stringify(snapData)) }),
      }),
    }),
  };
  return { db, ref, mockSet };
}

function setAllFs(db) {
  __setFsGuard(db);
  __setFsOTP(db);
  __setFsRecovery(db);
}

afterEach(() => { setAllFs(null); });
// ── action_guard ─────────────────────────────────────────────────────────────
describe('requestConfirmation', function () {
  test('parametros faltantes → throw', async function () {
    await expect(requestConfirmation(null, 'a', 'b')).rejects.toThrow('parametros_requeridos');
  });

  test('actionId faltante → throw', async function () {
    await expect(requestConfirmation('uid1', null, 'desc')).rejects.toThrow('parametros_requeridos');
  });

  test('description faltante → throw', async function () {
    await expect(requestConfirmation('uid1', 'act', null)).rejects.toThrow('parametros_requeridos');
  });

  test('con expiresIn custom → guarda y retorna token', async function () {
    const { db } = makeMockDb(false, {});
    __setFsGuard(db);
    const token = await requestConfirmation('uid1', 'delete_kb', 'Borrar base', 30000);
    expect(typeof token).toBe('string');
    expect(token.length).toBe(32);
  });

  test('sin expiresIn → usa DEFAULT_EXPIRES_MS', async function () {
    const { db } = makeMockDb(false, {});
    __setFsGuard(db);
    const token = await requestConfirmation('uid1', 'act', 'desc');
    expect(typeof token).toBe('string');
  });

  test('expiresIn = 0 → usa DEFAULT (no positivo)', async function () {
    const { db } = makeMockDb(false, {});
    __setFsGuard(db);
    const token = await requestConfirmation('uid1', 'act', 'desc', 0);
    expect(typeof token).toBe('string');
  });
});

describe('checkConfirmation', function () {
  test('uid null → throw', async function () {
    await expect(checkConfirmation(null, 'tok', 'SI')).rejects.toThrow('uid_token_requeridos');
  });

  test('token null → throw', async function () {
    await expect(checkConfirmation('uid1', null, 'SI')).rejects.toThrow('uid_token_requeridos');
  });

  test('doc no existe → notFound', async function () {
    const { db } = makeMockDb(false, {});
    __setFsGuard(db);
    const r = await checkConfirmation('uid1', 'tok', 'SI');
    expect(r.notFound).toBe(true);
    expect(r.approved).toBe(false);
  });

  test('doc expirado → expired true', async function () {
    const data = { expiresAt: new Date(Date.now() - 1000).toISOString(), status: 'pending' };
    const { db } = makeMockDb(true, data);
    __setFsGuard(db);
    const r = await checkConfirmation('uid1', 'tok', 'SI');
    expect(r.expired).toBe(true);
    expect(r.approved).toBe(false);
  });

  test('respuesta SI → approved true', async function () {
    const data = { expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'pending' };
    const { db } = makeMockDb(true, data);
    __setFsGuard(db);
    const r = await checkConfirmation('uid1', 'tok', 'SI');
    expect(r.approved).toBe(true);
    expect(r.expired).toBe(false);
  });

  test('respuesta YES → approved true', async function () {
    const data = { expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'pending' };
    const { db } = makeMockDb(true, data);
    __setFsGuard(db);
    const r = await checkConfirmation('uid1', 'tok', 'yes');
    expect(r.approved).toBe(true);
  });

  test('respuesta NO → approved false', async function () {
    const data = { expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'pending' };
    const { db } = makeMockDb(true, data);
    __setFsGuard(db);
    const r = await checkConfirmation('uid1', 'tok', 'NO');
    expect(r.approved).toBe(false);
    expect(r.expired).toBe(false);
  });
});
// ── otp_service ──────────────────────────────────────────────────────────────
describe('generateOTP', function () {
  test('uid null → throw', async function () {
    await expect(generateOTP(null)).rejects.toThrow('uid_requerido');
  });

  test('doc no existe → count=0 → genera OTP', async function () {
    const { db } = makeMockDb(false, {});
    __setFsOTP(db);
    const r = await generateOTP('uid1');
    expect(r.otp).toMatch(/^[0-9]{6}$/);
    expect(r.token.length).toBe(32);
    expect(r.expiresAt).toBeTruthy();
  });

  test('window expirada → count se resetea', async function () {
    const oldWindow = Date.now() - 2 * 60 * 60 * 1000;
    const { db } = makeMockDb(true, { count_1h: 2, window_start: oldWindow, pending: {} });
    __setFsOTP(db);
    const r = await generateOTP('uid1');
    expect(r.otp).toMatch(/^[0-9]{6}$/);
  });

  test('rate limit excedido → throw', async function () {
    const { db } = makeMockDb(true, { count_1h: 3, window_start: Date.now() - 1000, pending: {} });
    __setFsOTP(db);
    await expect(generateOTP('uid1')).rejects.toThrow('otp_rate_limit_excedido');
  });

  test('pending previo → se conserva en el set', async function () {
    const { db } = makeMockDb(true, { count_1h: 1, window_start: Date.now() - 1000, pending: { tok123: { otp: '111111', expiresAt: 'x' } } });
    __setFsOTP(db);
    const r = await generateOTP('uid1');
    expect(r.token).not.toBe('tok123');
  });
});

describe('validateOTP', function () {
  test('uid/token/otp faltantes → false', async function () {
    expect(await validateOTP(null, 'tok', '123456')).toBe(false);
  });

  test('doc no existe → false', async function () {
    const { db } = makeMockDb(false, {});
    __setFsOTP(db);
    expect(await validateOTP('uid1', 'tok', '123456')).toBe(false);
  });

  test('token no en pending → false', async function () {
    const { db } = makeMockDb(true, { pending: {} });
    __setFsOTP(db);
    expect(await validateOTP('uid1', 'tokX', '123456')).toBe(false);
  });

  test('token expirado → false (borra de pending)', async function () {
    const expired = new Date(Date.now() - 1000).toISOString();
    const { db } = makeMockDb(true, { pending: { tok1: { otp: '111111', expiresAt: expired } } });
    __setFsOTP(db);
    expect(await validateOTP('uid1', 'tok1', '111111')).toBe(false);
  });

  test('OTP incorrecto → false', async function () {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeMockDb(true, { pending: { tok1: { otp: '111111', expiresAt: future } } });
    __setFsOTP(db);
    expect(await validateOTP('uid1', 'tok1', '999999')).toBe(false);
  });

  test('OTP correcto y no expirado → true (borra pending)', async function () {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeMockDb(true, { pending: { tok1: { otp: '111111', expiresAt: future } } });
    __setFsOTP(db);
    expect(await validateOTP('uid1', 'tok1', '111111')).toBe(true);
  });
});

describe('sendOTPEmail', function () {
  test('uid null → throw', async function () {
    await expect(sendOTPEmail(null, '123456')).rejects.toThrow('uid_requerido');
  });

  test('doc no existe → throw owner_no_encontrado', async function () {
    const { db } = makeMockDb(false, {});
    __setFsOTP(db);
    await expect(sendOTPEmail('uid1', '123456')).rejects.toThrow('owner_no_encontrado');
  });

  test('owner con email → ok', async function () {
    const { db } = makeMockDb(true, { email: 'test@test.com' });
    __setFsOTP(db);
    const r = await sendOTPEmail('uid1', '123456');
    expect(r.ok).toBe(true);
    expect(r.email).toBe('test@test.com');
  });

  test('owner sin email → email=null', async function () {
    const { db } = makeMockDb(true, {});
    __setFsOTP(db);
    const r = await sendOTPEmail('uid1', '123456');
    expect(r.email).toBeNull();
  });
});
// ── recovery_service ─────────────────────────────────────────────────────────
describe('addTrustedContact', function () {
  test('uid null → throw', async function () {
    await expect(addTrustedContact(null, '+573001234', 'Juan', 'basic')).rejects.toThrow('parametros_requeridos');
  });

  test('phone null → throw', async function () {
    await expect(addTrustedContact('uid1', null, 'Juan', 'basic')).rejects.toThrow('parametros_requeridos');
  });

  test('nombre null → throw', async function () {
    await expect(addTrustedContact('uid1', '+573001234', null, 'basic')).rejects.toThrow('parametros_requeridos');
  });

  test('nivel valido → se usa', async function () {
    const { db } = makeMockDb(false, {});
    __setFsRecovery(db);
    const r = await addTrustedContact('uid1', '+573001234', 'Juan', 'advanced');
    expect(r.ok).toBe(true);
  });

  test('nivel invalido → usa basic', async function () {
    const { db } = makeMockDb(false, {});
    __setFsRecovery(db);
    const r = await addTrustedContact('uid1', '+573001234', 'Juan', 'superadmin');
    expect(r.ok).toBe(true);
  });
});

describe('initiateRecovery', function () {
  test('uid null → throw', async function () {
    await expect(initiateRecovery(null, '+573001234')).rejects.toThrow('parametros_requeridos');
  });

  test('phone null → throw', async function () {
    await expect(initiateRecovery('uid1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('phone no en trusted_contacts → throw', async function () {
    const { db } = makeMockDb(false, {});
    __setFsRecovery(db);
    await expect(initiateRecovery('uid1', '+573001234')).rejects.toThrow('contacto_no_autorizado');
  });

  test('phone autorizado → retorna token e instrucciones', async function () {
    const { db } = makeMockDb(true, { phone: '+573001234', nombre: 'Juan', nivel: 'basic' });
    __setFsRecovery(db);
    const r = await initiateRecovery('uid1', '+573001234');
    expect(r.token.length).toBe(32);
    expect(r.instrucciones).toContain('Juan');
  });
});

describe('completeRecovery', function () {
  test('parametros faltantes → throw', async function () {
    await expect(completeRecovery(null, 'tok', '123456')).rejects.toThrow('parametros_requeridos');
  });

  test('token null → throw', async function () {
    await expect(completeRecovery('uid1', null, '123456')).rejects.toThrow('parametros_requeridos');
  });

  test('otp null → throw', async function () {
    await expect(completeRecovery('uid1', 'tok', null)).rejects.toThrow('parametros_requeridos');
  });

  test('doc no existe → throw', async function () {
    const { db } = makeMockDb(false, {});
    __setFsRecovery(db);
    await expect(completeRecovery('uid1', 'tok', '123456')).rejects.toThrow('recovery_no_encontrado');
  });

  test('ya completado → throw', async function () {
    const { db } = makeMockDb(true, { completed: true, expiresAt: new Date(Date.now() + 60000).toISOString(), otp: '111111' });
    __setFsRecovery(db);
    await expect(completeRecovery('uid1', 'tok', '111111')).rejects.toThrow('recovery_ya_completado');
  });

  test('expirado → throw', async function () {
    const { db } = makeMockDb(true, { completed: false, expiresAt: new Date(Date.now() - 1000).toISOString(), otp: '111111' });
    __setFsRecovery(db);
    await expect(completeRecovery('uid1', 'tok', '111111')).rejects.toThrow('recovery_expirado');
  });

  test('OTP invalido → throw', async function () {
    const { db } = makeMockDb(true, { completed: false, expiresAt: new Date(Date.now() + 60000).toISOString(), otp: '111111' });
    __setFsRecovery(db);
    await expect(completeRecovery('uid1', 'tok', '999999')).rejects.toThrow('otp_invalido');
  });

  test('OTP valido y no expirado → temp_access', async function () {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeMockDb(true, { completed: false, expiresAt: future, otp: '111111' });
    __setFsRecovery(db);
    const r = await completeRecovery('uid1', 'tok', '111111');
    expect(r.temp_access).toBeTruthy();
    expect(r.expiresAt).toBeTruthy();
  });
});
// ── cobertura ramas adicionales ─────────────────────────────────────────────
describe('cobertura ramas action_guard', function () {
  test('response null en checkConfirmation → resp empty → rejected', async function () {
    const data = { expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'pending' };
    const { db } = makeMockDb(true, data);
    __setFsGuard(db);
    const r = await checkConfirmation('uid1', 'tok', null);
    expect(r.approved).toBe(false);
    expect(r.expired).toBe(false);
  });
});

describe('cobertura ramas otp_service', function () {
  test('window activa pero count_1h undefined → || 0', async function () {
    const { db } = makeMockDb(true, { window_start: Date.now() - 1000, pending: {} });
    __setFsOTP(db);
    const r = await generateOTP('uid1');
    expect(r.otp).toMatch(/^[0-9]{6}$/);
  });

  test('validateOTP: pending undefined → || {} → entry undefined → false', async function () {
    const future = new Date(Date.now() + 60000).toISOString();
    const { db } = makeMockDb(true, {});
    __setFsOTP(db);
    expect(await validateOTP('uid1', 'tok1', '111111')).toBe(false);
  });
});
