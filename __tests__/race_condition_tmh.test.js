/**
 * Tests: T9 — RC-1 per-phone processing guard en handleTenantMessage.
 *
 * Origen: T5 audit 2026-04-29 (RC-1 ALTO: TMH sin per-phone guard).
 * Implementado como parte de T9 bajo instrucción directa Mariano 2026-04-29.
 *
 * §A — Tests estáticos sobre source TMH (regex, sin emulator).
 * §B — Tests runtime con ctx mock (verifica comportamiento concurrent drop).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TMH_PATH = path.resolve(__dirname, '../whatsapp/tenant_message_handler.js');
const TMH_SOURCE = fs.readFileSync(TMH_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Verificación estática de fuente (RC-1 guard presente y correcto)
// ════════════════════════════════════════════════════════════════════

describe('T9 §A — RC-1 guard en source TMH (estático)', () => {
  test('A.1 — guard check ctx._processingPhones?.has(phone) presente', () => {
    expect(TMH_SOURCE).toMatch(/ctx\._processingPhones\?\.has\(phone\)/);
  });

  test('A.2 — inicialización con new Set() presente', () => {
    expect(TMH_SOURCE).toMatch(/ctx\._processingPhones\s*=\s*ctx\._processingPhones\s*\?\?\s*new Set\(\)/);
  });

  test('A.3 — ctx._processingPhones.add(phone) presente', () => {
    expect(TMH_SOURCE).toMatch(/ctx\._processingPhones\.add\(phone\)/);
  });

  test('A.4 — limpieza en finally con ctx._processingPhones?.delete(phone)', () => {
    expect(TMH_SOURCE).toMatch(/finally\s*\{[\s\S]{0,200}?ctx\._processingPhones\?\.delete\(phone\)/);
  });

  test('A.5 — log tag [RC-1] presente en el warn de concurrent drop', () => {
    expect(TMH_SOURCE).toMatch(/\[RC-1\]/);
  });

  test('A.6 — guard está ANTES del outer try (orden correcto)', () => {
    const guardPos = TMH_SOURCE.indexOf('ctx._processingPhones?.has(phone)');
    // _responseSentOk se declara justo antes del try { del outer try/catch global
    const outerTryPrelude = TMH_SOURCE.indexOf('let _responseSentOk = false');
    expect(guardPos).toBeGreaterThan(0);
    expect(outerTryPrelude).toBeGreaterThan(0);
    expect(guardPos).toBeLessThan(outerTryPrelude);
  });

  test('A.7 — guard está DESPUÉS de getOrCreateContext (ctx disponible)', () => {
    const getCtxPos = TMH_SOURCE.indexOf('getOrCreateContext(uid, ownerUid, role)');
    const guardPos = TMH_SOURCE.indexOf('ctx._processingPhones?.has(phone)');
    expect(getCtxPos).toBeGreaterThan(0);
    expect(guardPos).toBeGreaterThan(getCtxPos);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: mock ctx para verificar comportamiento
// ════════════════════════════════════════════════════════════════════

describe('T9 §B — RC-1 comportamiento runtime (ctx mock)', () => {
  // Simular el bloque de guard directamente — extrae la lógica aislada
  // sin necesidad de mockear toda la cadena TMH.
  function applyRc1Guard(ctx, phone) {
    if (ctx._processingPhones?.has(phone)) return false; // dropped
    ctx._processingPhones = ctx._processingPhones ?? new Set();
    ctx._processingPhones.add(phone);
    return true; // processing
  }

  function releaseRc1Guard(ctx, phone) {
    ctx._processingPhones?.delete(phone);
  }

  test('B.1 — primer mensaje pasa (phone no en procesamiento)', () => {
    const ctx = {};
    const result = applyRc1Guard(ctx, '573001234567@s.whatsapp.net');
    expect(result).toBe(true);
    expect(ctx._processingPhones.has('573001234567@s.whatsapp.net')).toBe(true);
    releaseRc1Guard(ctx, '573001234567@s.whatsapp.net');
  });

  test('B.2 — segundo mensaje mismo phone es dropped (concurrent drop)', () => {
    const ctx = {};
    const phone = '573001234567@s.whatsapp.net';
    applyRc1Guard(ctx, phone); // primer mensaje toma el lock
    const result = applyRc1Guard(ctx, phone); // segundo mensaje → drop
    expect(result).toBe(false);
    releaseRc1Guard(ctx, phone);
  });

  test('B.3 — phone diferente NO es bloqueado (solo per-phone)', () => {
    const ctx = {};
    const phone1 = '573001234567@s.whatsapp.net';
    const phone2 = '573009876543@s.whatsapp.net';
    applyRc1Guard(ctx, phone1); // phone1 en procesamiento
    const result = applyRc1Guard(ctx, phone2); // phone2 debe pasar
    expect(result).toBe(true);
    releaseRc1Guard(ctx, phone1);
    releaseRc1Guard(ctx, phone2);
  });

  test('B.4 — después de liberar el lock, el phone puede procesarse de nuevo', () => {
    const ctx = {};
    const phone = '573001234567@s.whatsapp.net';
    applyRc1Guard(ctx, phone);
    releaseRc1Guard(ctx, phone);
    const result = applyRc1Guard(ctx, phone); // nueva llamada debe pasar
    expect(result).toBe(true);
    releaseRc1Guard(ctx, phone);
  });

  test('B.5 — ctx sin _processingPhones inicializado (primer uso) → Set creado', () => {
    const ctx = {}; // sin _processingPhones
    expect(ctx._processingPhones).toBeUndefined();
    applyRc1Guard(ctx, '573001234567@s.whatsapp.net');
    expect(ctx._processingPhones).toBeInstanceOf(Set);
    releaseRc1Guard(ctx, '573001234567@s.whatsapp.net');
  });

  test('B.6 — releaseRc1Guard en ctx sin Set (finally seguro con ?.delete)', () => {
    const ctx = {}; // sin _processingPhones
    expect(() => releaseRc1Guard(ctx, '573001234567@s.whatsapp.net')).not.toThrow();
  });

  test('B.7 — múltiples phones simultáneos, cada uno independiente', () => {
    const ctx = {};
    const phones = ['573001@s.whatsapp.net', '573002@s.whatsapp.net', '573003@s.whatsapp.net'];
    phones.forEach(p => expect(applyRc1Guard(ctx, p)).toBe(true));
    expect(ctx._processingPhones.size).toBe(3);
    phones.forEach(p => releaseRc1Guard(ctx, p));
    expect(ctx._processingPhones.size).toBe(0);
  });
});
