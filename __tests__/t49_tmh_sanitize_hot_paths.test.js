'use strict';

/**
 * T49 — Anti-regresion sanitize hot paths TMH (3 lineas migradas a slog.msgContent)
 *
 * Lineas migradas:
 *  - L1766: CLASSIFY-CMD owner sin pendientes -> slog.msgContent
 *  - L2069: C-037 classification command directo -> slog.msgContent
 *  - L3134: SEARCH-HINT msg body -> slog.msgContent
 *
 * Verifica que esas 3 ocurrencias YA NO usen patron `console.log("...messageBody.trim()...")`
 * o `console.log("...messageBody.substring(0,60)...")` directamente.
 */

const fs = require('fs');
const path = require('path');

describe('T49 — sanitize hot paths TMH (anti-regresion)', () => {
  const tmhPath = path.join(__dirname, '..', 'whatsapp', 'tenant_message_handler.js');
  const src = fs.readFileSync(tmhPath, 'utf8');

  test('L1766 CLASSIFY-CMD usa slog.msgContent (no console.log directo con messageBody.trim())', () => {
    expect(src).toMatch(/slog\.msgContent\(`\$\{logPrefix\} \[CLASSIFY-CMD\][^`]*Owner escribio \(sin pendientes\)/);
  });

  test('L2069 C-037 usa slog.msgContent (no console.log directo)', () => {
    expect(src).toMatch(/slog\.msgContent\(`\$\{logPrefix\}[^`]*C-037[^`]*Owner escribio directo al lead/);
  });

  test('L3134 SEARCH-HINT msg usa slog.msgContent (no embedido en console.log structural)', () => {
    expect(src).toMatch(/slog\.msgContent\(`\$\{logPrefix\} 🔍 SEARCH-HINT msg`,\s*messageBody\.substring\(0,\s*60\)/);
  });

  test('regresion: NO debe haber `console.log...messageBody.trim()...pendientes de clasificación`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*messageBody\.trim\(\)[^)]*pendientes de clasificación/);
  });

  test('regresion: NO debe haber `console.log...C-037: Owner escribió...messageBody.trim()`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*C-037[^)]*messageBody\.trim\(\)[^)]*directo al lead/);
  });

  test('regresion: NO debe haber `console.log...SEARCH-HINT...msg=...messageBody.substring`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*SEARCH-HINT[^)]*msg="\$\{messageBody\.substring/);
  });

  test('slog import sigue presente (no se rompio post T43)', () => {
    expect(src).toMatch(/const \{ slog \} = require\('\.\.\/core\/log_sanitizer'\)/);
  });
});
