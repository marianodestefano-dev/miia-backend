'use strict';

/**
 * T52 — Anti-regresion sanitize hot paths TMH adicionales (continuacion T49)
 *
 * Lineas migradas a slog.msgContent en este batch:
 *  - L2030: Mensaje cita (quotedText del contacto)
 *  - L3496: LEARNING:SAFETY-NET (instruccion del owner)
 *  - L3662: COTIZ-TMH texto promesa eliminado (texto IA pre-PDF)
 *  - L3864: RESPONDELE-TAG body (msg de MIIA al contacto)
 */

const fs = require('fs');
const path = require('path');

describe('T52 — sanitize hot paths TMH adicionales (anti-regresion)', () => {
  const tmhPath = path.join(__dirname, '..', 'whatsapp', 'tenant_message_handler.js');
  const src = fs.readFileSync(tmhPath, 'utf8');

  test('Mensaje cita usa slog.msgContent (no console.log con quotedText)', () => {
    expect(src).toMatch(/slog\.msgContent\([^)]*Mensaje cita[^)]*messageContext\.quotedText\.substring/);
  });

  test('LEARNING:SAFETY-NET usa slog.msgContent (no console.log con instruction)', () => {
    expect(src).toMatch(/slog\.msgContent\([^)]*LEARNING:SAFETY-NET[^)]*instruction\.substring/);
  });

  test('COTIZ-TMH texto promesa usa slog.msgContent', () => {
    expect(src).toMatch(/slog\.msgContent\([^)]*COTIZ-TMH[^)]*Texto promesa[^)]*textoAntes\.substring/);
  });

  test('RESPONDELE-TAG body usa slog.msgContent (separado del structural)', () => {
    expect(src).toMatch(/slog\.msgContent\(`\$\{logPrefix\} \[RESPONDELE-TAG\] body`,\s*msgText\.substring/);
  });

  test('regresion: NO debe quedar `console.log...Mensaje cita.*quotedText.substring`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*Mensaje cita[^)]*quotedText\.substring/);
  });

  test('regresion: NO debe quedar `console.log...Instrucción del owner.*instruction.substring`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*Instrucción del owner[^)]*instruction\.substring/);
  });

  test('regresion: NO debe quedar `console.log...COTIZ-TMH.*Texto promesa.*textoAntes.substring`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*COTIZ-TMH[^)]*Texto promesa[^)]*textoAntes\.substring/);
  });

  test('regresion: NO debe quedar `console.log...RESPONDELE-TAG.*Mensaje enviado.*msgText.substring`', () => {
    expect(src).not.toMatch(/console\.log\([^)]*RESPONDELE-TAG[^)]*Mensaje enviado[^)]*msgText\.substring/);
  });

  test('slog import sigue presente', () => {
    expect(src).toMatch(/const \{ slog \} = require\('\.\.\/core\/log_sanitizer'\)/);
  });
});
