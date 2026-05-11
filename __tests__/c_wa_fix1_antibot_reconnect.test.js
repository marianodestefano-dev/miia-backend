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

});
