'use strict';

/**
 * Tests: T33 — PayPal observability instrumentation.
 *
 * Origen: T29 audit identifico GAP — PayPal sin V2-ALERT structured log
 * + sin AbortController. Wi firmo T33 mail [169] [ACK-T28-T31+N4-VI] —
 * "T33 IMPLEMENTAR T29 payments observability — instrumentar Stripe/MP
 * con telemetry".
 *
 * NOTA: Stripe deprecado (410 Gone). MP ya tiene V2-ALERT (existente).
 * T33 enfoca en cerrar GAP PayPal (5 endpoints) — paridad con Paddle/MP.
 *
 * §A — Tests estaticos sobre source server.js: AbortSignal.timeout en
 *      5 fetch PayPal + V2-ALERT en 4 catch handlers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

// Bloque PayPal (entre comentarios PAYPAL CHECKOUT y PAYPAL WEBHOOK / next section)
const PAYPAL_BLOCK_START = SERVER_SOURCE.indexOf('// PAYPAL CHECKOUT');
const PAYPAL_BLOCK_END = SERVER_SOURCE.indexOf('// MERCADOPAGO', PAYPAL_BLOCK_START);
const PAYPAL_BLOCK = PAYPAL_BLOCK_END > 0
  ? SERVER_SOURCE.slice(PAYPAL_BLOCK_START, PAYPAL_BLOCK_END)
  : SERVER_SOURCE.slice(PAYPAL_BLOCK_START, PAYPAL_BLOCK_START + 8000);

describe('T33 §A — PayPal AbortController + V2-ALERT', () => {
  test('A.1 — comentario T33-FIX presente (trazabilidad)', () => {
    expect(PAYPAL_BLOCK).toMatch(/T33-FIX/);
  });

  test('A.2 — getPayPalToken usa AbortSignal.timeout', () => {
    // Buscar el bloque de getPayPalToken
    const idx = PAYPAL_BLOCK.indexOf('async function getPayPalToken');
    expect(idx).toBeGreaterThan(0);
    const block = PAYPAL_BLOCK.slice(idx, idx + 600);
    expect(block).toMatch(/AbortSignal\.timeout/);
  });

  test('A.3 — 5+ ocurrencias AbortSignal.timeout en bloque PayPal', () => {
    // 1 token + 1 subscribe + 1 agent-checkout + 1 capture + 1 capture-agent = 5
    const matches = PAYPAL_BLOCK.match(/AbortSignal\.timeout\(15000\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  test('A.4 — V2-ALERT][PAYMENT-FAIL] presente con provider paypal', () => {
    expect(PAYPAL_BLOCK).toMatch(/V2-ALERT.*PAYMENT-FAIL/);
    expect(PAYPAL_BLOCK).toMatch(/provider:\s*['"]paypal['"]/);
  });

  test('A.5 — V2-ALERT incluye stages: subscribe, agent-checkout, capture, capture-agent', () => {
    expect(PAYPAL_BLOCK).toMatch(/stage:\s*['"]subscribe['"]/);
    expect(PAYPAL_BLOCK).toMatch(/stage:\s*['"]agent-checkout['"]/);
    expect(PAYPAL_BLOCK).toMatch(/stage:\s*['"]capture['"]/);
    expect(PAYPAL_BLOCK).toMatch(/stage:\s*['"]capture-agent['"]/);
  });

  test('A.6 — V2-ALERT incluye uid contextual para correlation', () => {
    // Cada V2-ALERT tiene un uid: req.body?.uid || 'unknown' o similar
    const matches = PAYPAL_BLOCK.match(/uid:\s*req\.body\?\.uid/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  test('A.7 — capture handler V2-ALERT diferencia capture_not_completed vs network error', () => {
    // 2 V2-ALERT en handler capture: uno por capture.status != COMPLETED
    // y otro por catch (network/exception)
    expect(PAYPAL_BLOCK).toMatch(/error:\s*['"]capture_not_completed['"]/);
  });

  test('A.8 — Paridad con Paddle: mismo formato V2-ALERT][PAYMENT-FAIL]', () => {
    // Paddle ya usa el patron — verificar que PayPal lo replica
    const paddleBlock = SERVER_SOURCE.slice(
      SERVER_SOURCE.indexOf('// PADDLE WEBHOOK'),
      SERVER_SOURCE.indexOf('// Endpoints Stripe deprecados')
    );
    const paddleAlert = paddleBlock.match(/\[V2-ALERT\]\[PAYMENT-FAIL\]/);
    const paypalAlert = PAYPAL_BLOCK.match(/\[V2-ALERT\]\[PAYMENT-FAIL\]/);
    expect(paddleAlert).not.toBeNull();
    expect(paypalAlert).not.toBeNull();
  });
});
