'use strict';
let ts;
beforeEach(() => {
  jest.resetModules();
  ts = require('../core/task_scheduler');
  ts._resetRunningTasksForTests();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('initTaskScheduler', () => {
  test('sin notifyOwner => _notifyOwner=null (branch deps.notifyOwner falsy)', () => {
    ts.initTaskScheduler();
  });
  test('con notifyOwner => _notifyOwner set (branch deps.notifyOwner truthy)', () => {
    ts.initTaskScheduler({ notifyOwner: jest.fn() });
  });
});

describe('executeWithConcentration level/log branches', () => {
  test('level invalido => usa LEVELS[1] (branch LEVELS[level] || LEVELS[1])', async () => {
    const r = await ts.executeWithConcentration(99, 'task', () => 'ok');
    expect(r.success).toBe(true);
  });
  test('level=1 => PASIVO sin init log (branch level < 3)', async () => {
    const r = await ts.executeWithConcentration(1, 'task', () => 'ok');
    expect(r.success).toBe(true);
  });
  test('level=2 => BAJO sin init log (branch level < 3)', async () => {
    const r = await ts.executeWithConcentration(2, 'task', () => 'ok');
    expect(r.success).toBe(true);
  });
  test('level=3 => MEDIO con init log y success log (branch level >= 3)', async () => {
    const r = await ts.executeWithConcentration(3, 'task3', () => 'res');
    expect(r.success).toBe(true); expect(r.result).toBe('res');
  });
  test('level=3 con opts.context => log con context (branch opts.context truthy)', async () => {
    const r = await ts.executeWithConcentration(3, 'task3c', () => 'ok', { context: 'myctx' });
    expect(r.success).toBe(true);
  });
  test('level=4 => ALTO minMs=30000 => fast task log L4 (branch level >= 4)', async () => {
    const r = await ts.executeWithConcentration(4, 'task4', () => 'res4');
    expect(r.success).toBe(true);
  });
  test('_metrics.byLevel entry previo => || 0 false branch', async () => {
    await ts.executeWithConcentration(3, 't1', () => 'ok');
    await ts.executeWithConcentration(3, 't2', () => 'ok');
    const m = ts.getTaskMetrics();
    expect(m.byLevel[3]).toBe(2);
  });
});
describe('executeWithConcentration mutex', () => {
  test('ya corriendo + level>=3 => skip log (branch level>=3 truthy)', async () => {
    ts._resetRunningTasksForTests();
    let resolve;
    const p1 = ts.executeWithConcentration(3, 'mutex-task', () => new Promise(r => { resolve = r; }));
    const r2 = await ts.executeWithConcentration(3, 'mutex-task', () => 'ok2');
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('already_running');
    resolve('done');
    await p1;
  });
  test('ya corriendo + level<3 => skip sin log (branch level<3 falsy)', async () => {
    ts._resetRunningTasksForTests();
    let resolve;
    const p1 = ts.executeWithConcentration(2, 'mutex2', () => new Promise(r => { resolve = r; }));
    const r2 = await ts.executeWithConcentration(2, 'mutex2', () => 'ok2');
    expect(r2.skipped).toBe(true);
    resolve('done');
    await p1;
  });
  test('mutex: task distinta puede correr en paralelo', async () => {
    let resolve1;
    const p1 = ts.executeWithConcentration(2, 'task-a', () => new Promise(r => { resolve1 = r; }));
    const r2 = await ts.executeWithConcentration(2, 'task-b', () => 'ok');
    expect(r2.skipped).toBeUndefined();
    resolve1('done');
    await p1;
  });
});

describe('executeWithConcentration verifyFn', () => {
  test('verifyFn => true => success verified (branch verified=true)', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const r = await ts.executeWithConcentration(5, 'v-task', () => 'res', { verifyFn: verify });
    expect(r.success).toBe(true);
    expect(verify).toHaveBeenCalled();
  });
  test('verifyFn throws => verified=false, sigue (branch catch verifyErr)', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('verify fail'));
    const r = await ts.executeWithConcentration(1, 'v-err', () => 'res', { verifyFn: verify });
    expect(r.success).toBe(true);
  });
  test('verifyFn => false on v=1, true on v=2 (branch v<verifications re-execute)', async () => {
    let vcall = 0;
    const verify = jest.fn().mockImplementation(() => { vcall++; return vcall >= 2; });
    const r = await ts.executeWithConcentration(4, 'v-retry', () => 'res', { verifyFn: verify });
    expect(r.success).toBe(true);
    expect(vcall).toBeGreaterThanOrEqual(2);
  });
  test('verifyFn always false + attempt < maxAttempts => retry (branch !verified && attempt<max)', async () => {
    jest.useFakeTimers();
    const verify = jest.fn().mockResolvedValue(false);
    let taskCalls = 0;
    const p = ts.executeWithConcentration(3, 'v-always-fail', () => { taskCalls++; return 'res'; }, { verifyFn: verify });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(taskCalls).toBeGreaterThan(1);
    jest.useRealTimers();
  });
  test('sin verifyFn => verifications skip (branch lvl.verifications>0 && opts.verifyFn false)', async () => {
    const r = await ts.executeWithConcentration(3, 'no-verify', () => 'ok');
    expect(r.success).toBe(true);
  });
});

describe('executeWithConcentration retry', () => {
  test('L3 retry: falla 1 vez y luego ok (branch attempt < maxAttempts catch)', async () => {
    jest.useFakeTimers();
    let call = 0;
    const taskFn = () => { call++; if (call < 2) throw new Error('fail'); return 'ok'; };
    const p = ts.executeWithConcentration(3, 'retry-task', taskFn);
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.retries).toBe(1);
    jest.useRealTimers();
  });
  test('success con retriesUsed>0 => log con reintentos (branch retriesUsed > 0)', async () => {
    jest.useFakeTimers();
    let call = 0;
    const taskFn = () => { call++; if (call < 2) throw new Error('fail'); return 'res'; };
    const p = ts.executeWithConcentration(3, 'r2-task', taskFn);
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.retries).toBeGreaterThan(0);
    jest.useRealTimers();
  });
});

describe('executeWithConcentration onFail branches', () => {
  test('L5 notify sin notifyOwner => log solo (branch !_notifyOwner false)', async () => {
    jest.useFakeTimers();
    const p = ts.executeWithConcentration(5, 'l5-fail', () => { throw new Error('crit'); });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.success).toBe(false);
    jest.useRealTimers();
  });
  test('L5 notify con notifyOwner => notifica (branch _notifyOwner truthy)', async () => {
    jest.useFakeTimers();
    const notify = jest.fn().mockResolvedValue(undefined);
    ts.initTaskScheduler({ notifyOwner: notify });
    const p = ts.executeWithConcentration(5, 'l5-notify', () => { throw new Error('crit'); });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.success).toBe(false);
    expect(notify).toHaveBeenCalled();
    jest.useRealTimers();
  });
  test('L5 notifyOwner throws => catch notifyErr', async () => {
    jest.useFakeTimers();
    ts.initTaskScheduler({ notifyOwner: jest.fn().mockRejectedValue(new Error('notify fail')) });
    const p = ts.executeWithConcentration(5, 'l5-nthrow', () => { throw new Error('crit'); });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.success).toBe(false);
    jest.useRealTimers();
  });
  test('L4 log+retry => error log (branch case log+retry)', async () => {
    jest.useFakeTimers();
    const p = ts.executeWithConcentration(4, 'l4-fail', () => { throw new Error('alto'); });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.success).toBe(false);
    jest.useRealTimers();
  });
  test('L3 log => error log (branch case log)', async () => {
    jest.useFakeTimers();
    const p = ts.executeWithConcentration(3, 'l3-fail', () => { throw new Error('medio'); });
    await jest.runAllTimersAsync();
    const r = await p;
    expect(r.success).toBe(false);
    jest.useRealTimers();
  });
  test('L2 silent => _trackSilentFailure (branch case silent)', async () => {
    const r = await ts.executeWithConcentration(2, 'l2-silent', () => { throw new Error('low'); });
    expect(r.success).toBe(false);
  });
  test('L1 ignore => _trackSilentFailure (branch case ignore/default)', async () => {
    const r = await ts.executeWithConcentration(1, 'l1-ignore', () => { throw new Error('pasivo'); });
    expect(r.success).toBe(false);
  });
});

describe('_trackSilentFailure escalation', () => {
  test('count=5 => warn escalado (branch sf.count===5)', async () => {
    for (let i = 0; i < 5; i++) {
      await ts.executeWithConcentration(2, 'sf-task', () => { throw new Error('e'); });
    }
    const sf = ts.getSilentFailures();
    expect(sf['sf-task'].count).toBe(5);
  });
  test('count>=10 => escalated=true (branch sf.count>=10)', async () => {
    for (let i = 0; i < 10; i++) {
      await ts.executeWithConcentration(1, 'sf-task10', () => { throw new Error('e'); });
    }
    expect(ts.getSilentFailures()['sf-task10'].escalated).toBe(true);
  });
});

describe('withConcentration', () => {
  test('success => return result', async () => {
    const fn = jest.fn().mockResolvedValue('wrapped-ok');
    const wrapped = ts.withConcentration(3, 'wc-ok', fn);
    const result = await wrapped('arg1');
    expect(result).toBe('wrapped-ok');
    expect(fn).toHaveBeenCalledWith('arg1');
  });
  test('fail + level>=3 => throw (branch !success && level>=3)', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    const fn = jest.fn().mockRejectedValue(new Error('wrap fail'));
    const wrapped = ts.withConcentration(3, 'wc-fail', fn);
    await expect(wrapped()).rejects.toThrow('TASK-SCHEDULER');
  });
  test('fail + level<3 => return undefined sin throw (branch !success && level<3)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('low fail'));
    const wrapped = ts.withConcentration(2, 'wc-low', fn);
    const result = await wrapped();
    expect(result).toBeUndefined();
  });
});

describe('getTaskMetrics', () => {
  test('sin avgDuration => count=0 => 0 (branch data.count>0 false)', () => {
    const m = ts.getTaskMetrics();
    expect(typeof m.totalTasks).toBe('number');
  });
  test('con avgDuration => calcula promedio (branch data.count>0 true)', async () => {
    await ts.executeWithConcentration(3, 'mt-task', () => 'ok');
    const m = ts.getTaskMetrics();
    expect(m.avgDurationMs[3]).toBeGreaterThanOrEqual(0);
  });
});

describe('LEVELS export', () => {
  test('LEVELS exporta los 5 niveles', () => {
    expect(Object.keys(ts.LEVELS).length).toBe(5);
    expect(ts.LEVELS[5].name).toBe('CRÍTICO');
  });
});
describe('executeWithConcentration remaining coverage branches', () => {
  test('verifyFn=true + level=3 => no L4 log (branch if(level>=4) false en verified=true)', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const r = await ts.executeWithConcentration(3, 'v3-true', () => 'res', { verifyFn: verify });
    expect(r.success).toBe(true);
  });
  test('notify con lastError.message=null => Error desconocido (branch lastError?.message || falsy)', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    const notify = jest.fn().mockResolvedValue(undefined);
    ts.initTaskScheduler({ notifyOwner: notify });
    const r = await ts.executeWithConcentration(5, 'l5-null-err', () => { throw new Error(''); });
    expect(r.success).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Error desconocido'));
  });
});
