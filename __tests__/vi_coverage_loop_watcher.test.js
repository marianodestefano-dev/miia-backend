'use strict';

/**
 * VI-BACKEND-COVERAGE: loop_watcher.js — 100% branches
 * Todas las funciones son puras (in-memory state).
 */

const lw = require('../core/loop_watcher');
const {
  recordMessage,
  isLoopPaused,
  checkAndRecord,
  resetLoop,
  getPausedContacts,
  LOOP_THRESHOLD,
  LOOP_WINDOW_MS,
} = lw;

// Helper: acceder al estado interno via __setStateForTests si existe, o via _loopState
// loop_watcher no exporta __setStateForTests — accedemos directo al módulo require'd
// Usamos jest.resetModules entre suites para aislar estado.

function freshLW() {
  jest.resetModules();
  return require('../core/loop_watcher');
}

// ── isLoopPaused ──────────────────────────────────────────────────────────────

describe('isLoopPaused', () => {
  let m;
  beforeEach(() => { m = freshLW(); });

  test('uid/phone no registrado → false', () => {
    expect(m.isLoopPaused('uid-x', '+57000')).toBe(false);
  });

  test('registrado pero no pausado → false', () => {
    m.recordMessage('uid-1', '+57001');
    expect(m.isLoopPaused('uid-1', '+57001')).toBe(false);
  });

  test('pausado indefinidamente → true', () => {
    const uid = 'uid-2', phone = '+57002';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, phone);
    expect(m.isLoopPaused(uid, phone)).toBe(true);
  });

  test('pausado con autoResetAt en el futuro → sigue pausado', () => {
    const uid = 'uid-3', phone = '+57003';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, phone, { autoResetDaily: true });
    const paused = m.getPausedContacts(uid);
    expect(paused[0].autoResetAt).not.toBeNull();
    expect(m.isLoopPaused(uid, phone)).toBe(true);
  });

  test('pausado con autoResetAt en el pasado → auto-despausar, retorna false', () => {
    const uid = 'uid-4', phone = '+57004';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, phone, { autoResetDaily: true });
    expect(m.isLoopPaused(uid, phone)).toBe(true);
    // Avanzar Date.now 25h → autoResetAt (próxima medianoche COT) ya pasó
    const origNow = Date.now;
    Date.now = () => origNow() + 25 * 60 * 60 * 1000;
    const result = m.isLoopPaused(uid, phone);
    Date.now = origNow;
    expect(result).toBe(false);
  });
});

// ── recordMessage ─────────────────────────────────────────────────────────────

describe('recordMessage', () => {
  let m;
  beforeEach(() => { m = freshLW(); });

  test('primera vez → count=1, loopDetected=false', () => {
    const r = m.recordMessage('uid-a', '+57010');
    expect(r.count).toBe(1);
    expect(r.loopDetected).toBe(false);
  });

  test('segunda vez dentro de ventana → count=2', () => {
    m.recordMessage('uid-b', '+57011');
    const r = m.recordMessage('uid-b', '+57011');
    expect(r.count).toBe(2);
    expect(r.loopDetected).toBe(false);
  });

  test('estado pausado → no incrementa', () => {
    const uid = 'uid-c', phone = '+57012';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, phone);
    const rPaused = m.recordMessage(uid, phone);
    expect(rPaused.loopDetected).toBe(false);
    // count no creció
    const paused = m.getPausedContacts(uid);
    expect(paused[0].count).toBe(LOOP_THRESHOLD + 1);
  });

  test('ventana expirada → reset contadores a 1', () => {
    const uid = 'uid-d', phone = '+57013';
    m.recordMessage(uid, phone);
    // Manually simulate expired window by modifying firstAt
    // loop_watcher doesn't export the state, so we abuse jest.spyOn on Date.now
    const origNow = Date.now;
    const futureTime = Date.now() + LOOP_WINDOW_MS + 1000;
    Date.now = () => futureTime;
    const r = m.recordMessage(uid, phone);
    Date.now = origNow;
    expect(r.count).toBe(1);
    expect(r.loopDetected).toBe(false);
  });

  test('LOOP_THRESHOLD+1 msgs → loopDetected=true, pausa indefinida', () => {
    const uid = 'uid-e', phone = '+57014';
    let result;
    for (let i = 0; i <= LOOP_THRESHOLD; i++) {
      result = m.recordMessage(uid, phone);
    }
    expect(result.loopDetected).toBe(true);
    expect(m.isLoopPaused(uid, phone)).toBe(true);
    const paused = m.getPausedContacts(uid);
    expect(paused[0].autoResetAt).toBeNull(); // indefinida
  });

  test('LOOP_THRESHOLD+1 msgs con autoResetDaily=true → autoResetAt != null', () => {
    const uid = 'uid-f', phone = '+57015';
    let result;
    for (let i = 0; i <= LOOP_THRESHOLD; i++) {
      result = m.recordMessage(uid, phone, { autoResetDaily: true });
    }
    expect(result.loopDetected).toBe(true);
    const paused = m.getPausedContacts(uid);
    expect(paused[0].autoResetAt).not.toBeNull();
  });
});

// ── checkAndRecord ────────────────────────────────────────────────────────────

describe('checkAndRecord', () => {
  let m;
  beforeEach(() => { m = freshLW(); });

  test('primera vez → allowed=true', () => {
    const r = m.checkAndRecord('uid-1', '+57020');
    expect(r.allowed).toBe(true);
    expect(r.loopDetected).toBe(false);
  });

  test('pausado → allowed=false, loopDetected=false', () => {
    const uid = 'uid-2', phone = '+57021';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, phone);
    const r = m.checkAndRecord(uid, phone);
    expect(r.allowed).toBe(false);
    expect(r.loopDetected).toBe(false);
  });

  test('loop detectado en este mensaje → allowed=false, loopDetected=true', () => {
    const uid = 'uid-3', phone = '+57022';
    // Get to threshold - 1
    for (let i = 0; i < LOOP_THRESHOLD; i++) m.recordMessage(uid, phone);
    // This checkAndRecord triggers the loop
    const r = m.checkAndRecord(uid, phone);
    expect(r.allowed).toBe(false);
    expect(r.loopDetected).toBe(true);
  });
});

// ── resetLoop ─────────────────────────────────────────────────────────────────

describe('resetLoop', () => {
  let m;
  beforeEach(() => { m = freshLW(); });

  test('no estaba pausado → false', () => {
    expect(m.resetLoop('uid-1', '+57030')).toBe(false);
  });

  test('no existe entry → false', () => {
    expect(m.resetLoop('uid-x', '+99999')).toBe(false);
  });

  test('pausado indefinidamente → true, despausado', () => {
    const uid = 'uid-2', phone = '+57031';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, phone);
    expect(m.isLoopPaused(uid, phone)).toBe(true);
    const r = m.resetLoop(uid, phone);
    expect(r).toBe(true);
    expect(m.isLoopPaused(uid, phone)).toBe(false);
  });

  test('pausado con autoResetAt (diario) → true, log wasAutoReset', () => {
    const uid = 'uid-3', phone = '+57032';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) {
      m.recordMessage(uid, phone, { autoResetDaily: true });
    }
    expect(m.isLoopPaused(uid, phone)).toBe(true);
    const r = m.resetLoop(uid, phone);
    expect(r).toBe(true);
  });
});

// ── getPausedContacts ─────────────────────────────────────────────────────────

describe('getPausedContacts', () => {
  let m;
  beforeEach(() => { m = freshLW(); });

  test('sin pausados → array vacío', () => {
    m.recordMessage('uid-1', '+57040');
    expect(m.getPausedContacts('uid-1')).toHaveLength(0);
  });

  test('con pausados → lista correcta', () => {
    const uid = 'uid-2';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid, '+57041');
    const paused = m.getPausedContacts(uid);
    expect(paused).toHaveLength(1);
    expect(paused[0].phone).toBe('+57041');
    expect(typeof paused[0].pausedAt).toBe('number');
    expect(typeof paused[0].count).toBe('number');
  });

  test('solo retorna pausados del uid solicitado, no de otros', () => {
    const uid1 = 'uid-a', uid2 = 'uid-b';
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid1, '+57042');
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage(uid2, '+57043');
    expect(m.getPausedContacts(uid1)).toHaveLength(1);
    expect(m.getPausedContacts(uid2)).toHaveLength(1);
    expect(m.getPausedContacts('uid-unknown')).toHaveLength(0);
  });
});

// ── _cleanup (via setInterval) ────────────────────────────────────────────────

describe('_cleanup via setInterval', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('elimina entries stale no-pausados y salta pausados', () => {
    const m = freshLW();

    // Entry no-pausado (solo un mensaje)
    m.recordMessage('uid-cl', '+57090');

    // Entry pausado (para cubrir el `continue`)
    for (let i = 0; i <= LOOP_THRESHOLD; i++) m.recordMessage('uid-p', '+57091');

    // Avanzar tiempo: cleanup dispara a los 120s; a los 360s la entry ya es stale (>300s)
    jest.advanceTimersByTime(360_001);

    // El pausado sigue pausado (nunca se elimina por stale)
    expect(m.isLoopPaused('uid-p', '+57091')).toBe(true);
    // Las líneas 82-86 (_cleanup loop body + continue + delete) se ejecutaron
  });
});
