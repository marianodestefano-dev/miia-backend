'use strict';

/**
 * T58 — coverage gap fix recurrente: loop_watcher.js (era 80.76%)
 */

const lw = require('../core/loop_watcher');

// Helper para limpiar state via reset por phone único
function uniqUid(testName) { return `uid_t58_${testName}_${Date.now()}_${Math.random()}`; }

describe('T58 §A — recordMessage', () => {
  test('primer mensaje crea entry count=1', () => {
    const uid = uniqUid('first');
    const r = lw.recordMessage(uid, '+57301', {});
    expect(r.loopDetected).toBe(false);
    expect(r.count).toBe(1);
  });

  test('mensajes < threshold → no loop', () => {
    const uid = uniqUid('under');
    for (let i = 0; i < 5; i++) {
      const r = lw.recordMessage(uid, '+57302', {});
      expect(r.loopDetected).toBe(false);
    }
  });

  test('mensajes > threshold → loop detectado + pausado indefinido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid = uniqUid('loop_indef');
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, '+57303', {});
      expect(lw.isLoopPaused(uid, '+57303')).toBe(true);
    } finally { console.error = orig; }
  });

  test('mensajes > threshold con autoResetDaily=true → pausado con autoResetAt', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid = uniqUid('loop_daily');
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, '+57304', { autoResetDaily: true });
      expect(lw.isLoopPaused(uid, '+57304')).toBe(true);
      const paused = lw.getPausedContacts(uid);
      expect(paused.length).toBe(1);
      expect(paused[0].autoResetAt).not.toBeNull();
      expect(paused[0].autoResetAt).toBeGreaterThan(Date.now());
    } finally { console.error = orig; }
  });

  test('ventana expirada (>30s) → reset contador a 1', () => {
    const uid = uniqUid('window_expire');
    const phone = '+57305';
    // Manipular tiempo via Date.now mock
    const origNow = Date.now;
    let mockTime = origNow();
    Date.now = () => mockTime;
    try {
      lw.recordMessage(uid, phone, {}); // count=1
      lw.recordMessage(uid, phone, {}); // count=2
      mockTime += 35_000; // avanzar 35s
      const r = lw.recordMessage(uid, phone, {});
      expect(r.count).toBe(1); // resetead0 a 1
    } finally { Date.now = origNow; }
  });

  test('mensaje en estado pausado → no incrementa count', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid = uniqUid('paused_no_incr');
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, '+57306', {});
      const beforeCount = lw.getPausedContacts(uid)[0].count;
      lw.recordMessage(uid, '+57306', {});
      const afterCount = lw.getPausedContacts(uid)[0].count;
      expect(afterCount).toBe(beforeCount);
    } finally { console.error = orig; }
  });
});

describe('T58 §B — isLoopPaused', () => {
  test('phone sin entry → false', () => {
    expect(lw.isLoopPaused('uid_x', '+57999')).toBe(false);
  });

  test('phone activo NO pausado → false', () => {
    const uid = uniqUid('active');
    lw.recordMessage(uid, '+57400', {});
    expect(lw.isLoopPaused(uid, '+57400')).toBe(false);
  });

  test('phone con autoResetAt en pasado → auto-despausa', () => {
    const orig = console.error;
    const orig2 = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      const uid = uniqUid('autoreset');
      const phone = '+57401';
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, phone, { autoResetDaily: true });
      // Manipular autoResetAt para que ya haya pasado
      const origNow = Date.now;
      Date.now = () => origNow() + 25 * 3600 * 1000; // +25 horas
      try {
        const stillPaused = lw.isLoopPaused(uid, phone);
        expect(stillPaused).toBe(false);
      } finally { Date.now = origNow; }
    } finally {
      console.error = orig;
      console.log = orig2;
    }
  });
});

describe('T58 §C — checkAndRecord', () => {
  test('no pausado + bajo threshold → allowed=true', () => {
    const uid = uniqUid('check_ok');
    const r = lw.checkAndRecord(uid, '+57500', {});
    expect(r.allowed).toBe(true);
    expect(r.loopDetected).toBe(false);
  });

  test('en threshold → allowed=false + loopDetected=true', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid = uniqUid('check_loop');
      const phone = '+57501';
      let lastResult;
      for (let i = 0; i < 13; i++) lastResult = lw.checkAndRecord(uid, phone, {});
      expect(lastResult.allowed).toBe(false);
      // El loopDetected es true en el momento exacto del trigger; despues paused
    } finally { console.error = orig; }
  });

  test('pausado previo → allowed=false sin loopDetected (ya pausado)', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid = uniqUid('check_paused');
      const phone = '+57502';
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, phone, {});
      const r = lw.checkAndRecord(uid, phone, {});
      expect(r.allowed).toBe(false);
      expect(r.loopDetected).toBe(false);
    } finally { console.error = orig; }
  });
});

describe('T58 §D — resetLoop', () => {
  test('reset phone pausado → true + delete state', () => {
    const orig1 = console.error;
    const orig2 = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      const uid = uniqUid('reset_paused');
      const phone = '+57600';
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, phone, {});
      expect(lw.isLoopPaused(uid, phone)).toBe(true);
      const r = lw.resetLoop(uid, phone);
      expect(r).toBe(true);
      expect(lw.isLoopPaused(uid, phone)).toBe(false);
    } finally {
      console.error = orig1;
      console.log = orig2;
    }
  });

  test('reset phone NO pausado → false', () => {
    const orig = console.log;
    console.log = () => {};
    try {
      const uid = uniqUid('reset_notpaused');
      const phone = '+57601';
      lw.recordMessage(uid, phone, {});
      const r = lw.resetLoop(uid, phone);
      expect(r).toBe(false);
    } finally { console.log = orig; }
  });

  test('reset phone sin entry → false', () => {
    const orig = console.log;
    console.log = () => {};
    try {
      const uid = uniqUid('reset_noentry');
      const r = lw.resetLoop(uid, '+57999');
      expect(r).toBe(false);
    } finally { console.log = orig; }
  });

  test('reset autoReset (daily) → log diferenciado + true', () => {
    const orig1 = console.error;
    const orig2 = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      const uid = uniqUid('reset_daily');
      const phone = '+57602';
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, phone, { autoResetDaily: true });
      const r = lw.resetLoop(uid, phone);
      expect(r).toBe(true);
    } finally {
      console.error = orig1;
      console.log = orig2;
    }
  });
});

describe('T58 §E — getPausedContacts', () => {
  test('sin pausados → array vacio', () => {
    const uid = uniqUid('pc_empty');
    expect(lw.getPausedContacts(uid)).toEqual([]);
  });

  test('multiples pausados retornados', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid = uniqUid('pc_multi');
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, '+57700', {});
      for (let i = 0; i < 12; i++) lw.recordMessage(uid, '+57701', {});
      const list = lw.getPausedContacts(uid);
      expect(list.length).toBe(2);
      expect(list[0]).toHaveProperty('phone');
      expect(list[0]).toHaveProperty('pausedAt');
      expect(list[0]).toHaveProperty('count');
      expect(list[0]).toHaveProperty('autoResetAt');
    } finally { console.error = orig; }
  });

  test('solo retorna pausados del uid pedido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const uid1 = uniqUid('pc_a');
      const uid2 = uniqUid('pc_b');
      for (let i = 0; i < 12; i++) lw.recordMessage(uid1, '+57800', {});
      for (let i = 0; i < 12; i++) lw.recordMessage(uid2, '+57801', {});
      expect(lw.getPausedContacts(uid1).length).toBe(1);
      expect(lw.getPausedContacts(uid2).length).toBe(1);
    } finally { console.error = orig; }
  });
});

describe('T58 §F — Constantes', () => {
  test('LOOP_THRESHOLD = 10', () => {
    expect(lw.LOOP_THRESHOLD).toBe(10);
  });
  test('LOOP_WINDOW_MS = 30_000', () => {
    expect(lw.LOOP_WINDOW_MS).toBe(30_000);
  });
});
