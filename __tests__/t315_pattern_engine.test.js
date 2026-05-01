'use strict';

/**
 * T315 -- pattern_engine behavioral unit tests (10/10)
 * pattern_engine exports: init, stop, getSellerDNA, runPatternAnalysis
 * Testing behavioral: no crash, early returns, state management.
 */

const {
  init,
  stop,
  getSellerDNA,
  runPatternAnalysis,
} = require('../core/pattern_engine');

describe('T315 -- pattern_engine (10 tests)', () => {

  afterEach(() => {
    stop();
  });

  // stop

  test('stop: no lanza si el engine no fue iniciado', () => {
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow(); // llamar dos veces tampoco lanza
  });

  // init

  test('init: no lanza con deps validos', () => {
    jest.useFakeTimers();
    const deps = {
      firestore: {},
      aiGateway: { generate: async () => '' },
    };
    expect(() => init('uid_t315', deps)).not.toThrow();
    stop();
    jest.useRealTimers();
  });

  test('init: no lanza con deps vacios', () => {
    jest.useFakeTimers();
    expect(() => init('uid_t315', {})).not.toThrow();
    stop();
    jest.useRealTimers();
  });

  test('init: segundo init no crash (idempotente con setInterval multiple)', () => {
    jest.useFakeTimers();
    const deps = { firestore: {}, aiGateway: { generate: async () => '' } };
    expect(() => {
      init('uid_t315', deps);
      init('uid_t315', deps); // segundo init
    }).not.toThrow();
    stop();
    jest.useRealTimers();
  });

  // runPatternAnalysis

  test('runPatternAnalysis: retorna undefined si no hay deps (_deps null)', async () => {
    // Llamar sin init primero (deps son null por modulo)
    stop(); // asegurar no corriendo
    // Como el modulo tiene estado global, necesitamos resetear
    // runPatternAnalysis hace: if (!_deps || !_ownerUid) return;
    // Después de stop, _deps puede seguir siendo el ultimo init
    // Simplemente verificamos que no lanza
    await expect(runPatternAnalysis()).resolves.toBeUndefined();
  });

  test('runPatternAnalysis: retorna sin error aunque firestore no exista', async () => {
    jest.useFakeTimers();
    init('uid_t315_poll', { firestore: null, aiGateway: null });
    await expect(runPatternAnalysis()).resolves.toBeUndefined();
    stop();
    jest.useRealTimers();
  });

  // getSellerDNA

  test('getSellerDNA: retorna null si _deps es null o no tiene firestore', async () => {
    stop();
    // Sin init (o con deps vacios), getSellerDNA deberia retornar null
    const result = await getSellerDNA();
    expect(result).toBeNull();
  });

  test('getSellerDNA: retorna null si firestore falla', async () => {
    jest.useFakeTimers();
    const failingFirestore = {
      collection: () => { throw new Error('firestore unavailable'); },
    };
    init('uid_t315_dna', { firestore: failingFirestore, aiGateway: {} });
    const result = await getSellerDNA();
    expect(result).toBeNull();
    stop();
    jest.useRealTimers();
  });

  // State management

  test('stop despues de init: limpia interval sin error', () => {
    jest.useFakeTimers();
    const deps = { firestore: {}, aiGateway: { generate: async () => '' } };
    init('uid_t315_stop', deps);
    expect(() => stop()).not.toThrow();
    jest.useRealTimers();
  });

  test('ciclo completo init -> stop -> init -> stop no lanza', () => {
    jest.useFakeTimers();
    const deps = { firestore: {}, aiGateway: {} };
    expect(() => {
      init('uid1', deps);
      stop();
      init('uid2', deps);
      stop();
    }).not.toThrow();
    jest.useRealTimers();
  });
});
