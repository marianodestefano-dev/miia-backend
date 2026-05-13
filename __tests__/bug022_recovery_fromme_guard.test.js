'use strict';

/**
 * BUG-022 — Reproceso mensajes viejos post-reconnect (firma Mariano 2026-05-12).
 *
 * Fix: persistir isFromMe en pending_responses + skip durante recovery si
 * isFromMe=true. Previene reprocesos del owner como lead aun si BUG-021 vive.
 *
 * Estrategia test (zona critica tenant_manager.js): leer source verbatim
 * y verificar que las 3 ediciones esten presentes:
 *   1. Persistencia isFromMe en owner-path pending_responses
 *   2. Persistencia isFromMe en lead-path pending_responses
 *   3. Skip durante recovery si msg.isFromMe === true
 */

const fs = require('fs');
const path = require('path');

const TM_PATH = path.resolve(__dirname, '../whatsapp/tenant_manager.js');
const SOURCE = fs.readFileSync(TM_PATH, 'utf8');

describe('BUG-022 — Recovery fromMe guard (firma Mariano 2026-05-12)', () => {
  test('persiste isFromMe en owner-path pending_responses', () => {
    // Buscar el ownerPendingData con isFromMe
    expect(SOURCE).toMatch(/ownerPendingData[\s\S]{0,500}isFromMe:\s*!!isFromMe/);
  });

  test('persiste isFromMe en lead-path pending_responses', () => {
    // Buscar el pendingData (no owner) con isFromMe
    expect(SOURCE).toMatch(/pendingData[\s\S]{0,500}isFromMe:\s*!!isFromMe/);
  });

  test('skip durante recovery si msg.isFromMe === true', () => {
    expect(SOURCE).toMatch(/msg\.isFromMe === true/);
    expect(SOURCE).toContain('RECOVERY skip msg fromMe=true (BUG-022 guard)');
  });

  test('skip borra el msg del store para no acumular ruido', () => {
    // El skip elimina de pending_responses
    const skipBlock = SOURCE.match(/msg\.isFromMe === true[\s\S]{0,500}/);
    expect(skipBlock).toBeTruthy();
    expect(skipBlock[0]).toContain('pending_responses');
    expect(skipBlock[0]).toContain('delete');
  });

  test('referencia explicita al firmante + firma viva fecha', () => {
    expect(SOURCE).toContain('BUG-022 fix (firma Mariano 2026-05-12)');
  });
});

describe('BUG-024 — already closed in C-144', () => {
  test('NO existe sendMessage de "MIIA se reconecto" al self-chat', () => {
    // BUG-024 ya cerrado en C-144: solo console.log interno, no sendMessage
    expect(SOURCE).not.toMatch(/sock\.sendMessage[\s\S]{0,200}MIIA se reconect/);
  });

  test('comentario C-144 documenta la decision', () => {
    expect(SOURCE).toContain('decisión Mariano 17-abr C-144');
  });
});
