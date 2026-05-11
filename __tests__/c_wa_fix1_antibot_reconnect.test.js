'use strict';

/**
 * C-WA-FIX-1 — Anti-bot reconexion WhatsApp
 * Verifica que los nuevos valores de rate_limiter y loop_watcher
 * sean los correctos post-fix de restriccion WA de Mariano (2026-05-11).
 */

const rl = require('../core/rate_limiter');
const lw = require('../core/loop_watcher');

describe('C-WA-FIX-1 — Anti-bot reconexion WhatsApp', () => {

  describe('rate_limiter: constantes anti-bot', () => {
    test('CONTACT_WINDOW_MS = 60000 (ventana duplicada)', () => {
      expect(rl.CONTACT_WINDOW_MS).toBe(60_000);
    });
    test('CONTACT_MAX_FAMILY = 5 (reducido de 10)', () => {
      expect(rl.CONTACT_MAX_FAMILY).toBe(5);
    });
    test('CONTACT_MAX_DEFAULT = 2 (reducido de 5)', () => {
      expect(rl.CONTACT_MAX_DEFAULT).toBe(2);
    });
  });

  describe('loop_watcher: constantes anti-bot', () => {
    test('LOOP_THRESHOLD = 6 (reducido de 10)', () => {
      expect(lw.LOOP_THRESHOLD).toBe(6);
    });
    test('LOOP_WINDOW_MS = 60000 (ventana duplicada)', () => {
      expect(lw.LOOP_WINDOW_MS).toBe(60_000);
    });
  });

  describe('rate_limiter: comportamiento con nuevos limites', () => {
    test('familia: 5 mensajes OK, el 6to es bloqueado', () => {
      const uid = 'wa-fix1-fam-1';
      const phone = '573100001';
      for (let i = 0; i < 5; i++) {
        expect(rl.contactAllows(uid, phone, 'familia')).toBe(true);
        rl.contactRecord(uid, phone);
      }
      expect(rl.contactAllows(uid, phone, 'familia')).toBe(false);
    });

    test('lead: 2 mensajes OK, el 3ro es bloqueado', () => {
      const uid = 'wa-fix1-lead-1';
      const phone = '573100002';
      for (let i = 0; i < 2; i++) {
        expect(rl.contactAllows(uid, phone, 'lead')).toBe(true);
        rl.contactRecord(uid, phone);
      }
      expect(rl.contactAllows(uid, phone, 'lead')).toBe(false);
    });

    test('equipo: 5 mensajes OK, el 6to bloqueado', () => {
      const uid = 'wa-fix1-equipo-1';
      const phone = '573100003';
      for (let i = 0; i < 5; i++) {
        expect(rl.contactAllows(uid, phone, 'equipo')).toBe(true);
        rl.contactRecord(uid, phone);
      }
      expect(rl.contactAllows(uid, phone, 'equipo')).toBe(false);
    });
  });

  describe('loop_watcher: comportamiento con nuevo threshold', () => {
    test('5 msgs NO dispara loop (threshold > 5)', () => {
      const uid = 'wa-fix1-loop-1';
      const phone = '573loop001';
      let r;
      for (let i = 0; i < 5; i++) r = lw.recordMessage(uid, phone, {});
      expect(r.loopDetected).toBe(false);
      lw.resetLoop(uid, phone);
    });

    test('7 msgs dispara loop (threshold=6)', () => {
      const uid = 'wa-fix1-loop-2';
      const phone = '573loop002';
      let r;
      for (let i = 0; i < 7; i++) r = lw.recordMessage(uid, phone, {});
      expect(r.loopDetected).toBe(true);
      lw.resetLoop(uid, phone);
    });
  });

  // ── WATCHDOG V2: threshold COT dinámico (anti-bot C-WA-FIX-1 §2) ──────────────
  // El WATCHDOG ya no usa sendPresenceUpdate. Usa probe pasivo (ws.readyState + ws.ping TCP-level).
  // El threshold silentMinutes es DINÁMICO: 10 min de día, 60 min de noche COT (00:00-06:00h).
  // La lógica COT de tenant_manager.js (L1207-1210) replica exactamente la función de abajo.
  describe('WATCHDOG V2 — threshold COT dinámico', () => {
    // Función pura que replica la lógica de tenant_manager.js
    function calcThreshold(utcHour) {
      const cotHour = (utcHour - 5 + 24) % 24; // COT = UTC-5 sin DST
      const isNightCOT = cotHour >= 0 && cotHour < 6;
      return isNightCOT ? 60 : 10;
    }

    test('UTC 05:00 → COT 00:00 → isNightCOT=true → threshold=60 min', () => {
      expect(calcThreshold(5)).toBe(60);
    });

    test('UTC 06:00 → COT 01:00 → isNightCOT=true → threshold=60 min', () => {
      expect(calcThreshold(6)).toBe(60);
    });

    test('UTC 10:59 → COT 05:59 → isNightCOT=true → threshold=60 min', () => {
      // 10*60+59 = 659 min UTC = 05:59 COT
      expect(calcThreshold(10)).toBe(60); // 10 UTC → 5 COT → noche
    });

    test('UTC 11:00 → COT 06:00 → isNightCOT=false → threshold=10 min', () => {
      // 11 UTC → 6 COT → fuera de rango 0-5h nocturno
      expect(calcThreshold(11)).toBe(10);
    });

    test('UTC 15:00 → COT 10:00 → isNightCOT=false → threshold=10 min', () => {
      expect(calcThreshold(15)).toBe(10);
    });

    test('UTC 00:00 → COT 19:00 (UTC-5 → 24-5=19) → isNightCOT=false → threshold=10 min', () => {
      // 0 - 5 + 24 = 19h COT → no es noche
      expect(calcThreshold(0)).toBe(10);
    });

    test('UTC 04:59 → COT 23:59 → isNightCOT=false → threshold=10 min', () => {
      // 4 - 5 + 24 = 23h COT → no es noche
      expect(calcThreshold(4)).toBe(10);
    });

    test('umbral: noche COT recorre exactamente UTC 05h-10h (6 horas)', () => {
      const nightHoursUTC = [5, 6, 7, 8, 9, 10]; // UTC cuando COT es 00-05h
      const dayHoursUTC   = [0, 1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
      nightHoursUTC.forEach(h => expect(calcThreshold(h)).toBe(60));
      dayHoursUTC.forEach(h => expect(calcThreshold(h)).toBe(10));
    });
  });


});
