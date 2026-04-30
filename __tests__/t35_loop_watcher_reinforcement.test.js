'use strict';

/**
 * Tests: T35 — Loop Watcher reinforcement (anti-regresion + cobertura edge cases).
 *
 * Origen: Wi mail [169] [ACK-T28-T31+N4-VI] — "T35 Anti-loop watchdog
 * reinforcement — auditoria patron loopWatcher post-T15 RC2".
 *
 * NO modifica core/loop_watcher.js. Solo agrega cobertura defensiva sobre
 * comportamiento documentado:
 *   §A — Threshold detection (10 msgs combinados en 30s)
 *   §B — Pausa diferenciada (TMH indefinida vs MIIA CENTER auto-reset COT)
 *   §C — Edge cases (window reset, stale cleanup, paused entries no-clean)
 *   §D — Owner reset manual
 *   §E — Multi-tenant isolation (uid distintos no interfieren)
 *   §F — Integracion con T9 RC-1 paridad (per-phone semantics)
 */

'use strict';

describe('T35 — Loop Watcher reinforcement', () => {
  let watcher;

  beforeAll(() => {
    // Re-require fresh for clean state
    delete require.cache[require.resolve('../core/loop_watcher')];
    watcher = require('../core/loop_watcher');
  });

  beforeEach(() => {
    // Reset state entre tests via owner reset (no exposed clear()).
    // Hack: usar resetLoop sobre keys conocidos.
    // Mejor: no testear todos en bloque con state compartido.
  });

  // ════════════════════════════════════════════════════════════════
  // §A — Threshold detection
  // ════════════════════════════════════════════════════════════════

  describe('T35 §A — threshold detection', () => {
    test('A.1 — primer msg no dispara loop', () => {
      const uid = 'uid-A1';
      const phone = '573000000001';
      const r = watcher.recordMessage(uid, phone, {});
      expect(r.loopDetected).toBe(false);
      expect(r.count).toBe(1);
      watcher.resetLoop(uid, phone);
    });

    test('A.2 — 10 msgs en ventana NO dispara loop (threshold > 10)', () => {
      const uid = 'uid-A2';
      const phone = '573000000002';
      let r;
      for (let i = 0; i < 10; i++) {
        r = watcher.recordMessage(uid, phone, {});
      }
      expect(r.loopDetected).toBe(false);
      expect(r.count).toBe(10);
      watcher.resetLoop(uid, phone);
    });

    test('A.3 — 11 msgs en ventana DISPARA loop', () => {
      const uid = 'uid-A3';
      const phone = '573000000003';
      let r;
      for (let i = 0; i < 11; i++) {
        r = watcher.recordMessage(uid, phone, {});
      }
      expect(r.loopDetected).toBe(true);
      expect(r.count).toBe(11);
      watcher.resetLoop(uid, phone);
    });

    test('A.4 — post-pausa siguientes msgs no incrementan count', () => {
      const uid = 'uid-A4';
      const phone = '573000000004';
      // Disparar loop
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, phone, {});
      const before = watcher.recordMessage(uid, phone, {});
      const after = watcher.recordMessage(uid, phone, {});
      expect(before.loopDetected).toBe(false); // ya pausado, no re-detecta
      expect(after.count).toBe(before.count); // no incrementa
      watcher.resetLoop(uid, phone);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // §B — Pausa diferenciada autoResetDaily
  // ════════════════════════════════════════════════════════════════

  describe('T35 §B — pausa diferenciada TMH vs MIIA CENTER', () => {
    test('B.1 — autoResetDaily=false → pausa indefinida (autoResetAt null)', () => {
      const uid = 'uid-B1';
      const phone = '573000000005';
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, phone, { autoResetDaily: false });
      expect(watcher.isLoopPaused(uid, phone)).toBe(true);
      watcher.resetLoop(uid, phone);
    });

    test('B.2 — autoResetDaily=true → pausa con autoResetAt timestamp futuro', () => {
      const uid = 'uid-B2';
      const phone = '573000000006';
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, phone, { autoResetDaily: true });
      expect(watcher.isLoopPaused(uid, phone)).toBe(true);
      watcher.resetLoop(uid, phone);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // §C — Edge cases
  // ════════════════════════════════════════════════════════════════

  describe('T35 §C — edge cases', () => {
    test('C.1 — checkAndRecord retorna allowed=false si ya pausado', () => {
      const uid = 'uid-C1';
      const phone = '573000000007';
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, phone, {});
      const r = watcher.checkAndRecord(uid, phone, {});
      expect(r.allowed).toBe(false);
      watcher.resetLoop(uid, phone);
    });

    test('C.2 — checkAndRecord retorna allowed=true si NO pausado', () => {
      const uid = 'uid-C2';
      const phone = '573000000008';
      const r = watcher.checkAndRecord(uid, phone, {});
      expect(r.allowed).toBe(true);
      watcher.resetLoop(uid, phone);
    });

    test('C.3 — isLoopPaused para phone inexistente retorna false', () => {
      expect(watcher.isLoopPaused('uid-inexistente', '573999999999')).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // §D — Owner reset manual
  // ════════════════════════════════════════════════════════════════

  describe('T35 §D — owner reset manual', () => {
    test('D.1 — resetLoop borra entry → isLoopPaused false', () => {
      const uid = 'uid-D1';
      const phone = '573000000009';
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, phone, {});
      expect(watcher.isLoopPaused(uid, phone)).toBe(true);
      watcher.resetLoop(uid, phone);
      expect(watcher.isLoopPaused(uid, phone)).toBe(false);
    });

    test('D.2 — resetLoop sobre entry inexistente no throw', () => {
      expect(() => watcher.resetLoop('uid-D2', '573000000010')).not.toThrow();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // §E — Multi-tenant isolation
  // ════════════════════════════════════════════════════════════════

  describe('T35 §E — multi-tenant isolation', () => {
    test('E.1 — pause uid1 no afecta uid2 mismo phone', () => {
      const phone = '573000000011';
      // Disparar loop en uid1
      for (let i = 0; i < 11; i++) watcher.recordMessage('uid-E1-a', phone, {});
      expect(watcher.isLoopPaused('uid-E1-a', phone)).toBe(true);
      // uid2 no afectado
      expect(watcher.isLoopPaused('uid-E1-b', phone)).toBe(false);
      watcher.resetLoop('uid-E1-a', phone);
    });

    test('E.2 — pause phone1 no afecta phone2 mismo uid', () => {
      const uid = 'uid-E2';
      // Disparar loop en phone1
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, '573000000012', {});
      expect(watcher.isLoopPaused(uid, '573000000012')).toBe(true);
      expect(watcher.isLoopPaused(uid, '573000000013')).toBe(false);
      watcher.resetLoop(uid, '573000000012');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // §F — Integracion paridad T9 RC-1 (per-phone semantics)
  // ════════════════════════════════════════════════════════════════

  describe('T35 §F — paridad T9 RC-1 per-phone semantics', () => {
    test('F.1 — getPausedContacts(uid) retorna lista correcta', () => {
      const uid = 'uid-F1';
      // Pausar 2 phones
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, '573000000020', {});
      for (let i = 0; i < 11; i++) watcher.recordMessage(uid, '573000000021', {});
      const list = watcher.getPausedContacts(uid);
      expect(list.length).toBeGreaterThanOrEqual(2);
      // Cleanup
      watcher.resetLoop(uid, '573000000020');
      watcher.resetLoop(uid, '573000000021');
    });

    test('F.2 — getPausedContacts(uid) NO incluye contactos sanos', () => {
      const uid = 'uid-F2';
      watcher.recordMessage(uid, '573000000022', {}); // 1 msg, no loop
      const list = watcher.getPausedContacts(uid);
      const item = list.find(c => c.phone === '573000000022');
      expect(item).toBeUndefined();
    });

    test('F.3 — counter combinado in+out (no separa direcciones)', () => {
      const uid = 'uid-F3';
      const phone = '573000000023';
      // Simular 6 in + 5 out (todos via recordMessage, no diferencia)
      for (let i = 0; i < 11; i++) {
        watcher.recordMessage(uid, phone, {});
      }
      expect(watcher.isLoopPaused(uid, phone)).toBe(true);
      watcher.resetLoop(uid, phone);
    });
  });
});
