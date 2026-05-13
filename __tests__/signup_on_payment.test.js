'use strict';

const signup = require('../core/signup_on_payment');

beforeEach(() => {
  signup.__setAdminAuthForTests(null);
});

describe('signup_on_payment', () => {
  describe('isLikelyEmail', () => {
    test('rechaza null/undefined/no string', () => {
      expect(signup.isLikelyEmail(null)).toBe(false);
      expect(signup.isLikelyEmail(undefined)).toBe(false);
      expect(signup.isLikelyEmail(123)).toBe(false);
      expect(signup.isLikelyEmail('')).toBe(false);
    });
    test('rechaza strings sin @', () => {
      expect(signup.isLikelyEmail('hola')).toBe(false);
      expect(signup.isLikelyEmail('hola.com')).toBe(false);
    });
    test('rechaza @ sin dominio', () => {
      expect(signup.isLikelyEmail('hola@')).toBe(false);
      expect(signup.isLikelyEmail('@hola.com')).toBe(false);
    });
    test('acepta emails validos', () => {
      expect(signup.isLikelyEmail('hola@miia-app.com')).toBe(true);
      expect(signup.isLikelyEmail('mariano.destefano@gmail.com')).toBe(true);
    });
  });

  describe('ensureUserFromEmail', () => {
    test('email invalido -> throw invalid_email', async () => {
      await expect(signup.ensureUserFromEmail('not-email')).rejects.toThrow('invalid_email');
      await expect(signup.ensureUserFromEmail(null)).rejects.toThrow('invalid_email');
    });

    test('email existe -> retorna uid + created=false', async () => {
      signup.__setAdminAuthForTests({
        getUserByEmail: jest.fn().mockResolvedValue({ uid: 'uid-existente', email: 'a@b.com' }),
        createUser: jest.fn(),
      });
      const r = await signup.ensureUserFromEmail('a@b.com');
      expect(r.uid).toBe('uid-existente');
      expect(r.created).toBe(false);
      expect(r.email).toBe('a@b.com');
    });

    test('email no existe -> crea + retorna created=true', async () => {
      const createUser = jest.fn().mockResolvedValue({ uid: 'uid-nuevo' });
      signup.__setAdminAuthForTests({
        getUserByEmail: jest.fn().mockRejectedValue({ code: 'auth/user-not-found' }),
        createUser,
      });
      const r = await signup.ensureUserFromEmail('nuevo@miia.com');
      expect(r.uid).toBe('uid-nuevo');
      expect(r.created).toBe(true);
      expect(createUser).toHaveBeenCalledWith({
        email: 'nuevo@miia.com',
        emailVerified: false,
        disabled: false,
      });
    });

    test('getUserByEmail throws no-found pero retorna sin uid -> sigue creando', async () => {
      // edge: lookup retorna objeto sin uid (no debería pasar, pero defensiva)
      const createUser = jest.fn().mockResolvedValue({ uid: 'uid-fallback' });
      signup.__setAdminAuthForTests({
        getUserByEmail: jest.fn().mockResolvedValue({ uid: null }),
        createUser,
      });
      const r = await signup.ensureUserFromEmail('weird@miia.com');
      expect(r.created).toBe(true);
      expect(r.uid).toBe('uid-fallback');
    });

    test('getUserByEmail throws otro error -> rethrow', async () => {
      signup.__setAdminAuthForTests({
        getUserByEmail: jest.fn().mockRejectedValue({ code: 'auth/internal-error', message: 'boom' }),
        createUser: jest.fn(),
      });
      await expect(signup.ensureUserFromEmail('a@b.com')).rejects.toMatchObject({ code: 'auth/internal-error' });
    });

    test('getUserByEmail rejects con error sin code -> rethrow', async () => {
      signup.__setAdminAuthForTests({
        getUserByEmail: jest.fn().mockRejectedValue(new Error('something else')),
        createUser: jest.fn(),
      });
      await expect(signup.ensureUserFromEmail('a@b.com')).rejects.toThrow('something else');
    });

    test('getUserByEmail rejects null (defensiva) -> rethrow', async () => {
      signup.__setAdminAuthForTests({
        getUserByEmail: jest.fn().mockRejectedValue(null),
        createUser: jest.fn(),
      });
      await expect(signup.ensureUserFromEmail('a@b.com')).rejects.toBeNull();
    });
  });
});
