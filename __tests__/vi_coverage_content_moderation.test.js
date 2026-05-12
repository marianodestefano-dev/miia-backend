'use strict';

/**
 * VI-BACKEND-COVERAGE: core/content_moderation.js — 100% branches
 */

const mod = require('../core/content_moderation');

function makeDb(setFn = jest.fn().mockResolvedValue({})) {
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({ set: setFn }),
    }),
  };
}

beforeEach(() => {
  mod.__setFirestoreForTests(makeDb());
});

// ── moderateContent ───────────────────────────────────────────────

describe('moderateContent', () => {
  test('null → flagged=false (branch !text)', () => {
    expect(mod.moderateContent(null)).toEqual({ flagged: false, patterns: [], severity: null });
    expect(mod.moderateContent('')).toEqual({ flagged: false, patterns: [], severity: null });
  });

  test('texto sin patrones → flagged=false (branch matched.length===0)', () => {
    expect(mod.moderateContent('hola como estas')).toEqual({ flagged: false, patterns: [], severity: null });
  });

  test('1 patron → severity=LOW (branch <2)', () => {
    const r = mod.moderateContent('spam');
    expect(r.flagged).toBe(true);
    expect(r.severity).toBe('low');
  });

  test('2 patrones → severity=MEDIUM (branch >=2 && <3)', () => {
    const r = mod.moderateContent('spam abuse');
    expect(r.flagged).toBe(true);
    expect(r.severity).toBe('medium');
  });

  test('3+ patrones → severity=HIGH (branch >=3)', () => {
    const r = mod.moderateContent('spam abuse hack');
    expect(r.flagged).toBe(true);
    expect(r.severity).toBe('high');
  });
});

// ── flagMessage ───────────────────────────────────────────────────

describe('flagMessage', () => {
  test('sin uid → throw', async () => {
    await expect(mod.flagMessage('', 'phone', 'msg', {})).rejects.toThrow('required');
  });

  test('sin phone → throw', async () => {
    await expect(mod.flagMessage('uid', '', 'msg', {})).rejects.toThrow('required');
  });

  test('sin message → throw', async () => {
    await expect(mod.flagMessage('uid', 'phone', '', {})).rejects.toThrow('required');
  });

  test('params completos → persiste y retorna entry', async () => {
    const r = await mod.flagMessage('uid1', '+54911', 'spam content', { severity: 'low', patterns: ['/spam/i'] });
    expect(r.uid).toBe('uid1');
    expect(r.reviewed).toBe(false);
  });
});

// ── checkAndFlag ──────────────────────────────────────────────────

describe('checkAndFlag', () => {
  test('mensaje limpio → retorna result sin flagear (branch !result.flagged)', async () => {
    const r = await mod.checkAndFlag('uid1', '+54911', 'hola');
    expect(r.flagged).toBe(false);
  });

  test('mensaje flaggeable → llama flagMessage (branch result.flagged)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = await mod.checkAndFlag('uid1', '+54911', 'spam');
    expect(r.flagged).toBe(true);
    logSpy.mockRestore();
  });
});

// ── getDb fallback ─────────────────────────────────────────────────

describe('getDb fallback — _db=null usa firebase directo', () => {
  test('branch _db falsy → require(../config/firebase).db', async () => {
    jest.resetModules();
    const mockSet = jest.fn().mockResolvedValue({});
    const fbDb = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: mockSet }),
      }),
    };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const freshMod = require('../core/content_moderation');
    // _db null en modulo fresco → getDb() usa require('../config/firebase').db
    await freshMod.checkAndFlag('uid1', '+549', 'spam');
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase');
    jest.resetModules();
  });
});
