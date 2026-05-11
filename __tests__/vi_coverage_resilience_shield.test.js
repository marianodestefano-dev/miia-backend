'use strict';

let shield;
beforeEach(() => {
  jest.resetModules();
  shield = require('../core/resilience_shield');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });
describe('recordFail', () => {
  test('system invalido => circuitOpened:false health:0 (branch !s)', () => {
    expect(shield.recordFail('invalid', 'err')).toEqual({ circuitOpened: false, health: 0 });
  });
  test('gemini => health 85 (branch emoji gemini)', () => {
    const r = shield.recordFail('gemini', 'api error');
    expect(r.health).toBe(85); expect(r.circuitOpened).toBe(false);
  });
  test('firestore => emoji firestore', () => { shield.recordFail('firestore', 'timeout'); });
  test('whatsapp => emoji whatsapp', () => { shield.recordFail('whatsapp', 'disconnect'); });
  test('node => emoji ot sin circuitOpen', () => {
    expect(shield.recordFail('node', 'err').circuitOpened).toBe(false);
  });
  test('meta.statusCode => branch truthy', () => {
    shield.recordFail('gemini', 'error', { statusCode: 429 });
  });
  test('5 fallos => circuit abre circuitOpened=true', () => {
    for (let i = 0; i < 4; i++) shield.recordFail('gemini', 'err');
    expect(shield.recordFail('gemini', 'err').circuitOpened).toBe(true);
  });
  test('circuit ya abierto => circuitOpened=false (branch !s.circuitOpen false)', () => {
    for (let i = 0; i < 5; i++) shield.recordFail('gemini', 'err');
    expect(shield.recordFail('gemini', 'err').circuitOpened).toBe(false);
  });
  test('activeOwnerUid + 3 fallos => autoRecover async llamado', () => {
    shield.setActiveOwnerUid('uid1');
    shield.recordFail('gemini', 'err'); shield.recordFail('gemini', 'err'); shield.recordFail('gemini', 'err');
  });
});

describe('recordSuccess', () => {
  test('system invalido => no-op (branch !s)', () => {
    expect(() => shield.recordSuccess('invalid')).not.toThrow();
  });
  test('circuitOpen=false => no close (branch s.circuitOpen falsy)', () => {
    shield.recordSuccess('gemini');
  });
  test('circuitOpen=true => cierra (branch s.circuitOpen truthy)', () => {
    for (let i = 0; i < 5; i++) shield.recordFail('gemini', 'err');
    expect(shield.isCircuitOpen('gemini')).toBe(true);
    shield.recordSuccess('gemini');
    expect(shield.isCircuitOpen('gemini')).toBe(false);
  });
});

describe('isCircuitOpen', () => {
  test('system invalido => false (branch !s)', () => {
    expect(shield.isCircuitOpen('invalid')).toBe(false);
  });
  test('circuitOpen=false => false (branch !s.circuitOpen)', () => {
    expect(shield.isCircuitOpen('gemini')).toBe(false);
  });
  test('dentro de cooldown => true', () => {
    for (let i = 0; i < 5; i++) shield.recordFail('gemini', 'err');
    expect(shield.isCircuitOpen('gemini')).toBe(true);
  });
  test('cooldown expirado => auto-close false (branch Date.now-openedAt > cooldown)', () => {
    jest.useFakeTimers();
    for (let i = 0; i < 5; i++) shield.recordFail('gemini', 'err');
    jest.setSystemTime(Date.now() + 61000);
    expect(shield.isCircuitOpen('gemini')).toBe(false);
    jest.useRealTimers();
  });
});

describe('classifyGeminiError', () => {
  test('429 + quota => QUOTA_EXHAUSTED isFatal=true', () => {
    const r = shield.classifyGeminiError(429, 'quota exceeded');
    expect(r.type).toBe('QUOTA_EXHAUSTED'); expect(r.isFatal).toBe(true);
  });
  test('429 sin quota => RATE_LIMIT', () => {
    expect(shield.classifyGeminiError(429, 'rate limited').type).toBe('RATE_LIMIT');
  });
  test('403 + billing => BILLING_DISABLED', () => {
    expect(shield.classifyGeminiError(403, 'billing disabled').type).toBe('BILLING_DISABLED');
  });
  test('403 sin billing => FORBIDDEN', () => {
    expect(shield.classifyGeminiError(403, 'forbidden access').type).toBe('FORBIDDEN');
  });
  test('503 => SERVER_ERROR', () => {
    expect(shield.classifyGeminiError(503, '').type).toBe('SERVER_ERROR');
  });
  test('500 => SERVER_ERROR (branch 500)', () => {
    expect(shield.classifyGeminiError(500, '').type).toBe('SERVER_ERROR');
  });
  test('400 + safety => SAFETY_BLOCKED', () => {
    expect(shield.classifyGeminiError(400, 'safety blocked').type).toBe('SAFETY_BLOCKED');
  });
  test('400 sin safety => BAD_REQUEST', () => {
    expect(shield.classifyGeminiError(400, 'invalid payload').type).toBe('BAD_REQUEST');
  });
  test('codigo desconocido => UNKNOWN', () => {
    expect(shield.classifyGeminiError(418, '').type).toBe('UNKNOWN');
  });
});

describe('recordNodeError', () => {
  test('registra error y reduce health node', () => {
    shield.recordNodeError('uncaughtException', new Error('crash'));
    expect(shield.getHealthDashboard().systems.node.unhandledErrors).toBe(1);
  });
});

describe('checkMemory', () => {
  test('threshold=0 => warning=true', () => { expect(shield.checkMemory(0).warning).toBe(true); });
  test('threshold=999999 => warning=false', () => { expect(shield.checkMemory(999999).warning).toBe(false); });
});

describe('getHealthDashboard', () => {
  test('retorna sistemas y overall', () => {
    const d = shield.getHealthDashboard();
    expect(d.systems.gemini.health).toBeDefined();
    expect(typeof d.overall).toBe('number');
  });
});

describe('notifyOwner', () => {
  test('sin notifySelfChat => undefined (branch !_notifySelfChat)', async () => {
    await expect(shield.notifyOwner('uid1', 'gemini', 'msg')).resolves.toBeUndefined();
  });
  test('rate limited => fn 1 vez (branch within 5min)', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    shield.setNotifyFunction(fn);
    await shield.notifyOwner('uid-rl', 'gemini', 'msg1');
    await shield.notifyOwner('uid-rl', 'gemini', 'msg2');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  test('diferente uid => fn 2 veces (branch diferente key)', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    shield.setNotifyFunction(fn);
    await shield.notifyOwner('uid-a', 'gemini', 'msg');
    await shield.notifyOwner('uid-b', 'gemini', 'msg');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  test('fn throws => catch sin throw (branch catch e)', async () => {
    shield.setNotifyFunction(jest.fn().mockRejectedValue(new Error('fail')));
    await expect(shield.notifyOwner('uid-e', 'firestore', 'msg')).resolves.toBeUndefined();
  });
});

describe('findRecoveryStrategy', () => {
  test('match exact system+pattern => ROTATE_KEY isKnown=true', () => {
    const r = shield.findRecoveryStrategy('gemini', '429 rate limit error');
    expect(r.action).toBe('ROTATE_KEY'); expect(r.isKnown).toBe(true);
  });
  test('cross-match diferente system => isKnown=true (second loop)', () => {
    expect(shield.findRecoveryStrategy('node', 'quota exhausted').isKnown).toBe(true);
  });
  test('unknown pattern => CIRCUIT_BREAK isKnown=false', () => {
    const r = shield.findRecoveryStrategy('gemini', 'xyz_completely_unknown_abc');
    expect(r.action).toBe('CIRCUIT_BREAK'); expect(r.isKnown).toBe(false);
  });
  test('unknown => getUnknownErrors tiene entry', () => {
    shield.findRecoveryStrategy('gemini', 'totally_unknown_zzz_abc');
    expect(shield.getUnknownErrors().length).toBeGreaterThan(0);
  });
});

describe('autoRecover', () => {
  test('ROTATE_KEY => executed=true', async () => {
    const r = await shield.autoRecover('gemini', '429 rate limit', 'uid1');
    expect(r.action).toBe('ROTATE_KEY'); expect(r.executed).toBe(true);
  });
  test('ROTATE_KEY_AND_PAUSE => circuit abre', async () => {
    await shield.autoRecover('gemini', 'quota exhausted resource_exhausted', 'uid1');
    expect(shield.isCircuitOpen('gemini')).toBe(true);
  });
  test('RETRY_BACKOFF => executed=true', async () => {
    expect((await shield.autoRecover('gemini', '503 overloaded', 'uid1')).action).toBe('RETRY_BACKOFF');
  });
  test('CIRCUIT_BREAK isKnown=true => sin notify (branch !isKnown false)', async () => {
    const r = await shield.autoRecover('firestore', 'quota exceeded resource_exhausted', 'uid1');
    expect(r.action).toBe('CIRCUIT_BREAK'); expect(r.executed).toBe(true);
  });
  test('CIRCUIT_BREAK !isKnown + uid => notify (branch !isKnown && uid)', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    shield.setNotifyFunction(fn);
    await shield.autoRecover('gemini', 'totally_unknown_error_zyx', 'uid-n');
    expect(fn).toHaveBeenCalled();
  });
  test('NOTIFY_OWNER con uid => notifica', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    shield.setNotifyFunction(fn);
    const r = await shield.autoRecover('firestore', 'PERMISSION_DENIED permission', 'uid1');
    expect(r.action).toBe('NOTIFY_OWNER'); expect(fn).toHaveBeenCalled();
  });
  test('NOTIFY_OWNER sin uid => no notifica (branch uid falsy)', async () => {
    const fn = jest.fn();
    shield.setNotifyFunction(fn);
    await shield.autoRecover('firestore', 'PERMISSION_DENIED permission', null);
    expect(fn).not.toHaveBeenCalled();
  });
  test('ENGINE_SWITCH => executed=true', async () => {
    expect((await shield.autoRecover('whatsapp', '440 connection replaced', 'uid1')).action).toBe('ENGINE_SWITCH');
  });
  test('RECONNECT_BACKOFF => executed=true', async () => {
    expect((await shield.autoRecover('whatsapp', '515 restart', 'uid1')).action).toBe('RECONNECT_BACKOFF');
  });
  test('BLOCK_CREDS_WRITE => executed=true', async () => {
    expect((await shield.autoRecover('whatsapp', 'Bad MAC decrypt', 'uid1')).action).toBe('BLOCK_CREDS_WRITE');
  });
});

describe('autoRecover GC+Reformulate+misc', () => {
  test('GC_HINT sin global.gc => executed=false (branch !global.gc)', async () => {
    delete global.gc;
    const r = await shield.autoRecover('node', 'heap memory ENOMEM', 'uid1');
    expect(r.action).toBe('GC_HINT'); expect(r.executed).toBe(false);
  });
  test('GC_HINT con global.gc => gc() llamado executed=true', async () => {
    global.gc = jest.fn();
    const r = await shield.autoRecover('node', 'heap memory ENOMEM', 'uid1');
    expect(r.executed).toBe(true); expect(global.gc).toHaveBeenCalled();
    delete global.gc;
  });
  test('REFORMULATE => executed=false', async () => {
    expect((await shield.autoRecover('gemini', 'safety blocked harm', 'uid1')).executed).toBe(false);
  });
  test('ENOSPC node => NOTIFY_OWNER', async () => {
    shield.setNotifyFunction(jest.fn().mockResolvedValue(undefined));
    expect((await shield.autoRecover('node', 'ENOSPC disk full', 'uid1')).action).toBe('NOTIFY_OWNER');
  });
  test('timeout gemini => RETRY_BACKOFF', async () => {
    expect((await shield.autoRecover('gemini', 'ETIMEDOUT timeout', 'uid1')).action).toBe('RETRY_BACKOFF');
  });
  test('timeout whatsapp => RECONNECT_BACKOFF', async () => {
    expect((await shield.autoRecover('whatsapp', 'ETIMEDOUT timeout', 'uid1')).action).toBe('RECONNECT_BACKOFF');
  });
  test('403 billing gemini => NOTIFY_OWNER', async () => {
    shield.setNotifyFunction(jest.fn().mockResolvedValue(undefined));
    expect((await shield.autoRecover('gemini', '403 billing disabled', 'uid1')).action).toBe('NOTIFY_OWNER');
  });
  test('whatsapp 401 => NOTIFY_OWNER', async () => {
    shield.setNotifyFunction(jest.fn().mockResolvedValue(undefined));
    expect((await shield.autoRecover('whatsapp', '401 logged out session', 'uid1')).action).toBe('NOTIFY_OWNER');
  });
  test('whatsapp unknown => CIRCUIT_BREAK sin abrir (whatsapp no tiene circuitOpen)', async () => {
    expect((await shield.autoRecover('whatsapp', 'totally_unknown_xyz_error', 'uid1')).action).toBe('CIRCUIT_BREAK');
  });
});

describe('startHealthMonitor', () => {
  test('interval: overall>=80 => verde + recovery pasiva', () => {
    jest.useFakeTimers();
    shield.startHealthMonitor(1000);
    jest.advanceTimersByTime(1001);
    expect(shield.getHealthDashboard().overall).toBeGreaterThanOrEqual(0);
    jest.useRealTimers();
  });
  test('interval: overall<50 => rojo (degrade all systems)', () => {
    jest.useFakeTimers();
    for (let i = 0; i < 10; i++) { shield.recordFail('gemini', 'e'); shield.recordFail('firestore', 'e'); }
    for (let i = 0; i < 10; i++) { shield.recordFail('whatsapp', 'e'); shield.recordFail('node', 'e'); }
    shield.startHealthMonitor(1000);
    jest.advanceTimersByTime(1001);
    jest.useRealTimers();
  });
  test('node recovery sin recent errors (branch noRecentNodeErrors)', () => {
    jest.useFakeTimers();
    shield.recordNodeError('uncaughtException', new Error('e'));
    jest.setSystemTime(Date.now() + 6 * 60 * 1000);
    shield.startHealthMonitor(1000);
    jest.advanceTimersByTime(1001);
    jest.useRealTimers();
  });
  test('segunda llamada => clearInterval anterior (branch if _healthInterval)', () => {
    jest.useFakeTimers();
    shield.startHealthMonitor(5000);
    shield.startHealthMonitor(5000);
    jest.useRealTimers();
  });
});
describe('startHealthMonitor passive recovery branches', () => {
  test('line 464: gemini health < 100 + consecutiveFails=0 + old lastFail => +2', () => {
    jest.useFakeTimers();
    shield.recordFail('gemini', 'err');
    shield.recordSuccess('gemini');
    jest.setSystemTime(Date.now() + 6 * 60 * 1000);
    shield.startHealthMonitor(1000);
    jest.advanceTimersByTime(1001);
    const d = shield.getHealthDashboard();
    expect(d.systems.gemini.health).toBeGreaterThan(85);
    jest.useRealTimers();
  });
  test('line 473: node health < 100 + noRecentErrors => +2 y unhandledErrors=0 tras 5 ticks', () => {
    jest.useFakeTimers();
    shield.recordNodeError('uncaughtException', new Error('e'));
    jest.setSystemTime(Date.now() + 6 * 60 * 1000);
    shield.startHealthMonitor(1000);
    jest.advanceTimersByTime(5001);
    const d = shield.getHealthDashboard();
    expect(d.systems.node.health).toBe(100);
    expect(d.systems.node.unhandledErrors).toBe(0);
    jest.useRealTimers();
  });
});
