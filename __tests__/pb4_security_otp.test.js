'use strict';

jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

let otp;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  otp = require('../core/security_otp');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.useFakeTimers();
});

afterEach(() => {
  if (otp) otp.clearAllForTests();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function makeDb({ exists = true, contacts = [], throwOn = null } = {}) {
  return {
    doc: jest.fn().mockImplementation((path) => ({
      get: jest.fn().mockImplementation(() => {
        if (throwOn) return Promise.reject(new Error('db error'));
        return Promise.resolve({ exists, data: () => ({ contacts }) });
      }),
      set: jest.fn().mockImplementation(() => {
        if (throwOn) return Promise.reject(new Error('db error'));
        return Promise.resolve({});
      }),
    })),
  };
}

describe('PB4 -- generateOTP', () => {
  test('uid null -> lanza error', () => {
    expect(() => otp.generateOTP(null)).toThrow('uid requerido');
  });

  test('uid valido, action default -> genera OTP con action=unknown', () => {
    const r = otp.generateOTP('uid1');
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.action).toBe('unknown');
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });

  test('uid valido, action especifica -> action se preserva', () => {
    const r = otp.generateOTP('uid1', 'delete_kb');
    expect(r.action).toBe('delete_kb');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('uid1'));
  });

  test('segundo generateOTP para mismo uid -> reemplaza el anterior', () => {
    const r1 = otp.generateOTP('uid1', 'a1');
    const r2 = otp.generateOTP('uid1', 'a2');
    expect(r2.action).toBe('a2');
    const v = otp.verifyOTP('uid1', r1.code);
    if (r1.code === r2.code) {
      expect(v.valid).toBe(true);
    } else {
      expect(v.valid).toBe(false);
    }
  });
});

describe('PB4 -- verifyOTP', () => {
  test('uid null -> {valid: false, reason: uid_o_codigo_faltante}', () => {
    expect(otp.verifyOTP(null, '123456')).toEqual({ valid: false, reason: 'uid_o_codigo_faltante' });
  });

  test('inputCode null -> {valid: false, reason: uid_o_codigo_faltante}', () => {
    expect(otp.verifyOTP('uid1', null)).toEqual({ valid: false, reason: 'uid_o_codigo_faltante' });
  });

  test('uid sin OTP -> {valid: false, reason: no_otp_found}', () => {
    expect(otp.verifyOTP('uid-none', '123456')).toEqual({ valid: false, reason: 'no_otp_found' });
  });

  test('OTP expirado -> {valid: false, reason: expired}', () => {
    otp.generateOTP('uid1', 'test');
    jest.advanceTimersByTime(otp.OTP_TTL_MS + 1000);
    expect(otp.verifyOTP('uid1', '000000')).toEqual({ valid: false, reason: 'expired' });
    expect(otp.isOTPPending('uid1')).toBe(false);
  });

  test('codigo incorrecto -> {valid: false, reason: wrong_code}', () => {
    otp.generateOTP('uid1', 'test');
    expect(otp.verifyOTP('uid1', '000000')).toEqual({ valid: false, reason: 'wrong_code' });
  });

  test('codigo correcto -> {valid: true, action} + OTP consumido (one-use)', () => {
    const g = otp.generateOTP('uid1', 'delete_kb');
    const r = otp.verifyOTP('uid1', g.code);
    expect(r.valid).toBe(true);
    expect(r.action).toBe('delete_kb');
    expect(otp.isOTPPending('uid1')).toBe(false);
  });

  test('codigo correcto con espacios (trim) -> valid=true', () => {
    const g = otp.generateOTP('uid1', 'x');
    expect(otp.verifyOTP('uid1', '  ' + g.code + '  ').valid).toBe(true);
  });
});

describe('PB4 -- invalidateOTP', () => {
  test('uid null -> false', () => {
    expect(otp.invalidateOTP(null)).toBe(false);
  });

  test('uid sin OTP -> false (Map.delete returns false)', () => {
    expect(otp.invalidateOTP('uid-none')).toBe(false);
  });

  test('uid con OTP -> true + OTP eliminado', () => {
    otp.generateOTP('uid1', 'x');
    expect(otp.invalidateOTP('uid1')).toBe(true);
    expect(otp.isOTPPending('uid1')).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('invalidado'));
  });
});

describe('PB4 -- isOTPPending', () => {
  test('uid null -> false', () => {
    expect(otp.isOTPPending(null)).toBe(false);
  });

  test('uid sin OTP -> false', () => {
    expect(otp.isOTPPending('uid-none')).toBe(false);
  });

  test('uid con OTP vigente -> true', () => {
    otp.generateOTP('uid1', 'x');
    expect(otp.isOTPPending('uid1')).toBe(true);
  });

  test('uid con OTP expirado -> false + limpia store', () => {
    otp.generateOTP('uid1', 'x');
    jest.advanceTimersByTime(otp.OTP_TTL_MS + 1000);
    expect(otp.isOTPPending('uid1')).toBe(false);
  });
});

describe('PB4 -- isCriticalAction', () => {
  test('action null -> false (branch !action)', () => {
    expect(otp.isCriticalAction(null)).toBe(false);
  });

  test('action en CRITICAL_ACTIONS -> true', () => {
    expect(otp.isCriticalAction('delete_kb')).toBe(true);
    expect(otp.isCriticalAction('add_agent')).toBe(true);
    expect(otp.isCriticalAction('anomaly_detected')).toBe(true);
  });

  test('action no critica -> false', () => {
    expect(otp.isCriticalAction('send_message')).toBe(false);
  });
});

describe('PB4 -- getTrustedContacts', () => {
  test('uid null -> lanza error', async () => {
    await expect(otp.getTrustedContacts(null)).rejects.toThrow('uid requerido');
  });

  test('doc no existe -> retorna []', async () => {
    otp.__setFirestoreForTests(makeDb({ exists: false }));
    expect(await otp.getTrustedContacts('uid1')).toEqual([]);
  });

  test('doc existe con contacts -> retorna contacts', async () => {
    const contacts = [{ name: 'Ale', phone: '+5491112345678' }];
    otp.__setFirestoreForTests(makeDb({ exists: true, contacts }));
    expect(await otp.getTrustedContacts('uid1')).toEqual(contacts);
  });

  test('doc existe con contacts null -> retorna [] (|| [])', async () => {
    otp.__setFirestoreForTests({
      doc: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ exists: true, data: () => ({}) }),
      }),
    });
    expect(await otp.getTrustedContacts('uid1')).toEqual([]);
  });

  test('db lanza error -> retorna [] + console.error', async () => {
    otp.__setFirestoreForTests(makeDb({ throwOn: true }));
    const r = await otp.getTrustedContacts('uid1');
    expect(r).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('PB4 -- setTrustedContacts', () => {
  test('uid null -> lanza error', async () => {
    await expect(otp.setTrustedContacts(null, [])).rejects.toThrow('uid requerido');
  });

  test('contacts no array -> lanza error', async () => {
    await expect(otp.setTrustedContacts('uid1', 'string')).rejects.toThrow('contacts debe ser array');
  });

  test('contacts.length > 3 -> lanza error', async () => {
    await expect(otp.setTrustedContacts('uid1', [1, 2, 3, 4])).rejects.toThrow('maximo 3 trusted contacts');
  });

  test('contacts validos -> guarda + retorna {success, count}', async () => {
    const db = makeDb();
    otp.__setFirestoreForTests(db);
    const contacts = [{ name: 'Ale' }, { name: 'Pablo' }];
    const r = await otp.setTrustedContacts('uid1', contacts);
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('uid1'));
  });

  test('array vacio -> valido (0 contacts)', async () => {
    const db = makeDb();
    otp.__setFirestoreForTests(db);
    const r = await otp.setTrustedContacts('uid1', []);
    expect(r.success).toBe(true);
    expect(r.count).toBe(0);
  });

  test('db lanza error -> re-throw + console.error', async () => {
    otp.__setFirestoreForTests(makeDb({ throwOn: true }));
    await expect(otp.setTrustedContacts('uid1', [{ name: 'x' }])).rejects.toThrow('db error');
    expect(console.error).toHaveBeenCalled();
  });
});

describe('PB4 -- constantes exportadas', () => {
  test('OTP_TTL_MS = 5 minutos', () => {
    expect(otp.OTP_TTL_MS).toBe(5 * 60 * 1000);
  });
  test('OTP_LENGTH = 6', () => {
    expect(otp.OTP_LENGTH).toBe(6);
  });
  test('CRITICAL_ACTIONS es un Set con acciones criticas', () => {
    expect(otp.CRITICAL_ACTIONS).toBeInstanceOf(Set);
    expect(otp.CRITICAL_ACTIONS.has('delete_kb')).toBe(true);
    expect(otp.CRITICAL_ACTIONS.has('add_agent')).toBe(true);
  });
});
