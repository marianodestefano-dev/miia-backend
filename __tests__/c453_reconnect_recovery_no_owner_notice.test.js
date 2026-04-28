/**
 * Tests: C-453-BUG024-RECONEXION-LOG — anti-regresion para que el
 * mensaje "MIIA se reconecto y recupero N mensajes" NUNCA regrese a
 * notificar al owner en self-chat (decision Mariano 2026-04-17 C-144).
 *
 * Origen: ITER 2 RRC-VI-001 candidata C-453. APROBADO Wi autoridad
 * delegada 2026-04-28.
 *
 * Bug previo (pre-C-144): tras reconexion + recoverUnrespondedMessages,
 * tenant_manager.js enviaba via sock.sendMessage(selfJid) un texto que
 * exponia mecanica interna ("MIIA se reconecto..."), violando espiritu
 * §2 CLAUDE.md.
 *
 * Fix C-144 (2026-04-17): reemplazado por console.log interno
 * "[TM:{uid}] RECOVERY: N mensaje(s) recuperados post-reconexion".
 *
 * Este test asegura que el codigo productivo NO contenga el patron
 * residual y que NO se reintroduzca en el futuro.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TM_PATH = path.resolve(__dirname, '../whatsapp/tenant_manager.js');
const SOURCE = fs.readFileSync(TM_PATH, 'utf8');

describe('C-453-BUG024-RECONEXION-LOG — owner self-chat no recibe ruido recovery', () => {
  test('A.1 — frase "MIIA se reconectó" NO existe en codigo productivo', () => {
    expect(SOURCE).not.toMatch(/MIIA se reconect[oóá]/);
  });

  test('A.2 — frase "recuper. mensaje(s) que quedaron" NO existe', () => {
    expect(SOURCE).not.toMatch(/recuper[oóeé].{0,40}mensaje\(s\) que quedaron/);
  });

  test('A.3 — recoverUnrespondedMessages NO se sigue por sock.sendMessage al selfJid', () => {
    // Buscar bloque post-recovery (recovered > 0). NO debe haber
    // sock.sendMessage(selfJid o selfChatJid) con texto recovery.
    const block = SOURCE.match(
      /recoverUnrespondedMessages\([\s\S]{0,400}?if\s*\(recovered\s*>\s*0\)\s*\{([\s\S]{0,300}?)\}/
    );
    expect(block).not.toBeNull();
    if (block) {
      // El cuerpo solo debe tener console.log, nunca sock.sendMessage
      expect(block[1]).not.toMatch(/sock\.sendMessage/);
      expect(block[1]).toMatch(/console\.log/);
    }
  });

  test('A.4 — comentario decision Mariano 17-abr C-144 presente como ancla', () => {
    expect(SOURCE).toMatch(/decisi[oó]n\s+Mariano\s+17-abr\s+C-144/);
  });

  test('A.5 — log interno [TM:.*] RECOVERY presente', () => {
    expect(SOURCE).toMatch(/\[TM:\$\{uid\}\]\s*[^']*RECOVERY[^']*recuperados post-reconexi[oó]n/);
  });
});
