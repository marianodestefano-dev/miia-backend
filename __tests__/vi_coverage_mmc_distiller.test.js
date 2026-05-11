'use strict';

/**
 * VI-BACKEND-COVERAGE: core/mmc_distiller.js — 100% branches
 * Tests adicionales sobre el skeleton T34 para cubrir ramas no alcanzadas por t34_mmc_distiller_skeleton.test.js
 */

function makeLogger() {
  const childLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { debug: jest.fn(), warn: jest.fn(), child: jest.fn().mockReturnValue(childLog) };
}
function makeLogSanitizer() {
  return { maskUid: jest.fn().mockReturnValue('uid***'), slog: { msgContent: jest.fn() } };
}

// ── §D — distillEpisode ENABLED branches ─────────────────────────────────────

describe('mmc_distiller — MMC_FASE_1_ENABLED=true branches', () => {
  let mmc;
  let logMock;
  let sanitizerMock;
  let recordLatencyMock;

  beforeAll(() => {
    jest.resetModules();
    logMock = makeLogger();
    sanitizerMock = makeLogSanitizer();
    recordLatencyMock = jest.fn();

    jest.doMock('firebase-admin', () => ({ firestore: jest.fn() }));
    jest.doMock('../core/logger', () => logMock);
    jest.doMock('../core/health_check', () => ({ recordLatency: recordLatencyMock }));
    jest.doMock('../core/log_sanitizer', () => sanitizerMock);

    process.env.MMC_FASE_1_ENABLED = 'true';
    mmc = require('../core/mmc_distiller');
  });

  afterAll(() => {
    delete process.env.MMC_FASE_1_ENABLED;
    jest.resetModules();
  });

  beforeEach(() => {
    mmc.clearProcessing();
    jest.clearAllMocks();
    // Restore default child mock after each test
    const childLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    logMock.child.mockReturnValue(childLog);
  });

  test('MMC_FASE_1_ENABLED=true confirmado', () => {
    expect(mmc.MMC_FASE_1_ENABLED).toBe(true);
  });

  test('phone ya en processing → return null (branch _processingPhones.has)', async () => {
    const phone = '+54911concurrent';
    // First call: make logger.child throw BEFORE the try block → phone stays stuck in Set
    // (finally block inside try won't run, so phone is NOT deleted)
    logMock.child.mockImplementationOnce(() => { throw new Error('child intentionally fails'); });
    // First call rejects (phone gets added to set but NOT deleted due to throw before try)
    await expect(mmc.distillEpisode('uid1', phone, [])).rejects.toThrow();
    // Phone is now stuck in the processing Set
    expect(mmc.isProcessingPhone(phone)).toBe(true);

    // Second call: hits _processingPhones.has(phone) guard → returns null
    const r = await mmc.distillEpisode('uid1', phone, []);
    expect(r).toBeNull();
  });

  test('conversation=null → no slog.msgContent (branch conversation falsy)', async () => {
    const r = await mmc.distillEpisode('uid2', '+54912test', null);
    expect(r).toEqual({ status: 'stub', episodeId: null });
    expect(sanitizerMock.slog.msgContent).not.toHaveBeenCalled();
  });

  test('conversation vacía → no slog.msgContent (branch length===0)', async () => {
    const r = await mmc.distillEpisode('uid3', '+54913test', []);
    expect(r).toEqual({ status: 'stub', episodeId: null });
    expect(sanitizerMock.slog.msgContent).not.toHaveBeenCalled();
  });

  test('lastTurn con content → slog.msgContent llamado (branch content truthy)', async () => {
    const r = await mmc.distillEpisode('uid4', '+54914test', [
      { role: 'user', content: 'Hola MIIA, tengo una consulta' },
    ]);
    expect(r).toEqual({ status: 'stub', episodeId: null });
    expect(sanitizerMock.slog.msgContent).toHaveBeenCalled();
  });

  test('lastTurn sin content → no slog.msgContent (branch content falsy)', async () => {
    const r = await mmc.distillEpisode('uid5', '+54915test', [
      { role: 'user' }, // no content field
    ]);
    expect(r).toEqual({ status: 'stub', episodeId: null });
    expect(sanitizerMock.slog.msgContent).not.toHaveBeenCalled();
  });

  test('recordLatency es función → llamado en finally (branch typeof === function true)', async () => {
    await mmc.distillEpisode('uid6', '+54916test', []);
    expect(recordLatencyMock).toHaveBeenCalledWith('aiGateway', expect.any(Number));
  });

  test('error dentro del try block → catch (status=error, branch catch)', async () => {
    // Make log.info throw inside the try block to trigger the catch
    const failLog = {
      info: jest.fn().mockImplementation(() => { throw new Error('info fail inside try'); }),
      warn: jest.fn(),
      error: jest.fn(),
    };
    logMock.child.mockReturnValueOnce(failLog);
    const r = await mmc.distillEpisode('uid7', '+54917test', []);
    expect(r).toEqual({ status: 'error', error: 'info fail inside try' });
    expect(failLog.error).toHaveBeenCalled();
  });

  test('getProcessingCount retorna cantidad correcta (línea 137)', async () => {
    mmc.clearProcessing();
    expect(mmc.getProcessingCount()).toBe(0);
  });

  test('isProcessingPhone: phone liberado después de distillEpisode (finally branch)', async () => {
    const phone = '+54918test';
    expect(mmc.isProcessingPhone(phone)).toBe(false);
    await mmc.distillEpisode('uid8', phone, []);
    expect(mmc.isProcessingPhone(phone)).toBe(false); // deleted in finally
  });
});

// ── §E — recordLatency NOT a function branch ──────────────────────────────────

describe('mmc_distiller — recordLatency no es función (branch typeof false)', () => {
  let mmc2;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('firebase-admin', () => ({ firestore: jest.fn() }));
    jest.doMock('../core/logger', () => makeLogger());
    jest.doMock('../core/health_check', () => ({ recordLatency: undefined })); // NOT a function
    jest.doMock('../core/log_sanitizer', () => makeLogSanitizer());

    process.env.MMC_FASE_1_ENABLED = 'true';
    mmc2 = require('../core/mmc_distiller');
  });

  afterAll(() => {
    delete process.env.MMC_FASE_1_ENABLED;
    jest.resetModules();
  });

  test('recordLatency undefined → branch typeof === function false, no error', async () => {
    const r = await mmc2.distillEpisode('uid9', '+54919test', []);
    expect(r).toEqual({ status: 'stub', episodeId: null });
  });
});
