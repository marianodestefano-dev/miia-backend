'use strict';
const { reloadConfig, getConfig, contactAllows, resetCounters, clearCache, DEFAULTS, __setFirestoreForTests } = require('../core/owner_rate_limiter');

function makeMockDb({ rateLimits=null, throwGet=false }={}) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('firestore error');
          if (rateLimits) return { exists: true, data: () => ({ rateLimits }) };
          return { exists: false };
        }
      })
    })
  };
}

beforeEach(() => { clearCache(); __setFirestoreForTests(null); });
afterEach(() => { clearCache(); __setFirestoreForTests(null); });

describe('DEFAULTS', () => {
  test('tiene perContact=5, perTenant=50, windowSecs=30', () => {
    expect(DEFAULTS.perContact).toBe(5);
    expect(DEFAULTS.perTenant).toBe(50);
    expect(DEFAULTS.windowSecs).toBe(30);
  });
  test('DEFAULTS está frozen', () => {
    expect(() => { DEFAULTS.perContact = 99; }).toThrow();
  });
});

describe('reloadConfig', () => {
  test('lanza error si uid es vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(reloadConfig('')).rejects.toThrow('uid requerido');
  });

  test('retorna DEFAULTS si Firestore no tiene config', async () => {
    __setFirestoreForTests(makeMockDb());
    const cfg = await reloadConfig('uid001');
    expect(cfg.perContact).toBe(DEFAULTS.perContact);
    expect(cfg.perTenant).toBe(DEFAULTS.perTenant);
    expect(cfg.windowSecs).toBe(DEFAULTS.windowSecs);
  });

  test('retorna config del owner si existe en Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ rateLimits: { perContact: 10, perTenant: 100, windowSecs: 60 } }));
    const cfg = await reloadConfig('uid002');
    expect(cfg.perContact).toBe(10);
    expect(cfg.perTenant).toBe(100);
    expect(cfg.windowSecs).toBe(60);
  });

  test('usa DEFAULTS si Firestore lanza error', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const cfg = await reloadConfig('uid003');
    expect(cfg.perContact).toBe(DEFAULTS.perContact);
  });

  test('merge parcial: solo perContact sobreescribe', async () => {
    __setFirestoreForTests(makeMockDb({ rateLimits: { perContact: 8 } }));
    const cfg = await reloadConfig('uid004');
    expect(cfg.perContact).toBe(8);
    expect(cfg.perTenant).toBe(DEFAULTS.perTenant);
    expect(cfg.windowSecs).toBe(DEFAULTS.windowSecs);
  });
});

describe('contactAllows', () => {
  test('permite los primeros N envios hasta perContact', () => {
    __setFirestoreForTests(makeMockDb());
    const uid = 'uidCL';
    const phone = '+573001';
    const now = Date.now();
    for (let i = 0; i < DEFAULTS.perContact; i++) {
      const r = contactAllows(uid, phone, now + i * 100);
      expect(r.allowed).toBe(true);
    }
    // El siguiente debe ser bloqueado
    const blocked = contactAllows(uid, phone, now + 500);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('contact_rate_exceeded');
  });

  test('permite envios despues de vencer la ventana', () => {
    __setFirestoreForTests(makeMockDb());
    const uid = 'uidW';
    const phone = '+573002';
    const now = 1000;
    for (let i = 0; i < DEFAULTS.perContact; i++) contactAllows(uid, phone, now);
    // Bloqueado en ventana
    expect(contactAllows(uid, phone, now + 1000).allowed).toBe(false);
    // Fuera de ventana (30s * 1000ms + 1ms)
    const futureNow = now + DEFAULTS.windowSecs * 1000 + 1;
    expect(contactAllows(uid, phone, futureNow).allowed).toBe(true);
  });

  test('retorna allowed=false si uid o phone son falsy', () => {
    expect(contactAllows('', '+573001').allowed).toBe(false);
    expect(contactAllows('uid1', '').allowed).toBe(false);
  });
});

describe('resetCounters', () => {
  test('resetea contadores sin afectar config', () => {
    const uid = 'uidR';
    const phone = '+573003';
    const now = Date.now();
    for (let i = 0; i < DEFAULTS.perContact; i++) contactAllows(uid, phone, now);
    expect(contactAllows(uid, phone, now).allowed).toBe(false);
    resetCounters(uid);
    expect(contactAllows(uid, phone, now).allowed).toBe(true);
  });
});
