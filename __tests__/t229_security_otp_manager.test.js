'use strict';

const {
  createOTP, verifyOTP, revokeOTP, buildOTPMessage, generateOTPCode,
  isOTPExpired, isValidCriticalAction,
  CRITICAL_ACTIONS, OTP_STATUSES, OTP_LENGTH, OTP_TTL_MS, MAX_OTP_ATTEMPTS,
  __setFirestoreForTests,
} = require('../core/security_otp_manager');

const UID = 'testUid1234567890';

function makeMockDbWithDoc(docData = null, { throwSet = false, throwGet = false } = {}) {
  const stored = {};
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              stored[id || 'doc'] = { ...(stored[id || 'doc'] || docData || {}), ...data };
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const d = stored[id] || docData;
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('Constantes', () => {
  test('OTP_LENGTH es 6', () => { expect(OTP_LENGTH).toBe(6); });
  test('OTP_TTL_MS es 10 minutos', () => { expect(OTP_TTL_MS).toBe(10 * 60 * 1000); });
  test('MAX_OTP_ATTEMPTS es 3', () => { expect(MAX_OTP_ATTEMPTS).toBe(3); });
  test('CRITICAL_ACTIONS tiene 7 acciones', () => { expect(CRITICAL_ACTIONS.length).toBe(7); });
  test('frozen CRITICAL_ACTIONS', () => { expect(() => { CRITICAL_ACTIONS.push('x'); }).toThrow(); });
  test('OTP_STATUSES tiene 4 estados', () => { expect(OTP_STATUSES.length).toBe(4); });
});

describe('generateOTPCode', () => {
  test('genera codigo de 6 digitos', () => {
    const code = generateOTPCode();
    expect(code).toHaveLength(6);
    expect(/^[0-9]{6}$/.test(code)).toBe(true);
  });
  test('genera codigos distintos en llamadas sucesivas', () => {
    const codes = new Set(Array.from({ length: 10 }, () => generateOTPCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('isValidCriticalAction', () => {
  test('delete_account es valida', () => { expect(isValidCriticalAction('delete_account')).toBe(true); });
  test('api_key_rotate es valida', () => { expect(isValidCriticalAction('api_key_rotate')).toBe(true); });
  test('accion_rara no es valida', () => { expect(isValidCriticalAction('accion_rara')).toBe(false); });
});

describe('isOTPExpired', () => {
  test('retorna true si record null', () => { expect(isOTPExpired(null)).toBe(true); });
  test('retorna true si expiresAt pasado', () => {
    const r = { expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(isOTPExpired(r)).toBe(true);
  });
  test('retorna false si expiresAt futuro', () => {
    const r = { expiresAt: new Date(Date.now() + 60000).toISOString() };
    expect(isOTPExpired(r)).toBe(false);
  });
});

describe('createOTP', () => {
  test('lanza si uid undefined', async () => {
    await expect(createOTP(undefined, 'delete_account')).rejects.toThrow('uid requerido');
  });
  test('lanza si action undefined', async () => {
    await expect(createOTP(UID, undefined)).rejects.toThrow('action requerido');
  });
  test('lanza si action invalida', async () => {
    __setFirestoreForTests(makeMockDbWithDoc());
    await expect(createOTP(UID, 'login')).rejects.toThrow('action invalida');
  });
  test('retorna otpId, code y expiresAt', async () => {
    __setFirestoreForTests(makeMockDbWithDoc());
    const r = await createOTP(UID, 'api_key_rotate');
    expect(r.otpId).toMatch(/^otp_/);
    expect(r.code).toHaveLength(OTP_LENGTH);
    expect(r.expiresAt).toBeDefined();
  });
  test('acepta codigo forzado para tests', async () => {
    __setFirestoreForTests(makeMockDbWithDoc());
    const r = await createOTP(UID, 'reset_config', { _forceCode: '123456' });
    expect(r.code).toBe('123456');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDbWithDoc(null, { throwSet: true }));
    await expect(createOTP(UID, 'delete_account')).rejects.toThrow('set error');
  });
});

describe('verifyOTP', () => {
  test('lanza si uid undefined', async () => {
    await expect(verifyOTP(undefined, 'otp1', '123456')).rejects.toThrow('uid requerido');
  });
  test('lanza si otpId undefined', async () => {
    await expect(verifyOTP(UID, undefined, '123456')).rejects.toThrow('otpId requerido');
  });
  test('lanza si inputCode undefined', async () => {
    const db = makeMockDbWithDoc({ status: 'pending', code: '111111', attempts: 0, expiresAt: new Date(Date.now() + 60000).toISOString() });
    __setFirestoreForTests(db);
    await expect(verifyOTP(UID, 'otp1', undefined)).rejects.toThrow('inputCode requerido');
  });
  test('lanza si OTP no encontrado', async () => {
    __setFirestoreForTests(makeMockDbWithDoc(null));
    await expect(verifyOTP(UID, 'otp1', '123456')).rejects.toThrow('OTP no encontrado');
  });
  test('retorna invalido si OTP no esta pendiente', async () => {
    __setFirestoreForTests(makeMockDbWithDoc({
      status: 'used', code: '123456', attempts: 1, expiresAt: new Date(Date.now() + 60000).toISOString()
    }));
    const r = await verifyOTP(UID, 'otp1', '123456');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('used');
  });
  test('retorna invalido si OTP expirado', async () => {
    __setFirestoreForTests(makeMockDbWithDoc({
      status: 'pending', code: '123456', attempts: 0, expiresAt: new Date(Date.now() - 1000).toISOString()
    }));
    const r = await verifyOTP(UID, 'otp1', '123456');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('expirado');
  });
  test('retorna invalido si codigo incorrecto', async () => {
    __setFirestoreForTests(makeMockDbWithDoc({
      status: 'pending', code: '123456', attempts: 0, expiresAt: new Date(Date.now() + 60000).toISOString()
    }));
    const r = await verifyOTP(UID, 'otp1', '999999');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('incorrecto');
  });
  test('retorna valido si codigo correcto', async () => {
    __setFirestoreForTests(makeMockDbWithDoc({
      status: 'pending', code: '123456', attempts: 0, expiresAt: new Date(Date.now() + 60000).toISOString(),
      action: 'api_key_rotate',
    }));
    const r = await verifyOTP(UID, 'otp1', '123456');
    expect(r.valid).toBe(true);
    expect(r.action).toBe('api_key_rotate');
  });
});

describe('revokeOTP', () => {
  test('lanza si uid undefined', async () => {
    await expect(revokeOTP(undefined, 'otp1')).rejects.toThrow('uid requerido');
  });
  test('lanza si otpId undefined', async () => {
    await expect(revokeOTP(UID, undefined)).rejects.toThrow('otpId requerido');
  });
  test('revoca sin error', async () => {
    __setFirestoreForTests(makeMockDbWithDoc());
    await expect(revokeOTP(UID, 'otp1')).resolves.toBeUndefined();
  });
});

describe('buildOTPMessage', () => {
  test('incluye codigo y accion', () => {
    const msg = buildOTPMessage('123456', 'delete_account', new Date(Date.now() + 60000).toISOString());
    expect(msg).toContain('123456');
    expect(msg).toContain('delete_account');
    expect(msg).toContain('10');
  });
  test('menciona no compartir', () => {
    const msg = buildOTPMessage('654321', 'api_key_rotate', new Date().toISOString());
    expect(msg.toLowerCase()).toContain('no compartir');
  });
});
