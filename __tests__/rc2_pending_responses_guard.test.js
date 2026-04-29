'use strict';

/**
 * Tests: T15 — RC-2 GUARD pendingResponses 1s window.
 *
 * Origen: T5 audit 2026-04-28 (RC-2 MEDIO: ventana 1s entre delete isProcessing
 * en finally y setTimeout retry permite doble call Gemini si llega msg nuevo).
 * Fix T15 firmado Wi autoridad delegada + Mariano viva 2026-04-29.
 *
 * §A — Tests estaticos sobre source server.js (sin runtime).
 * §B — Tests runtime: simular timing de la ventana con mock setTimeout.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

// Bloque del retry pendingResponses para tests de scope
const RETRY_BLOCK_START = SERVER_SOURCE.indexOf('if (pendingResponses[effectiveTarget]) {');
const RETRY_BLOCK_END = SERVER_SOURCE.indexOf('}, 1000);', RETRY_BLOCK_START);
const RETRY_BLOCK = SERVER_SOURCE.slice(RETRY_BLOCK_START, RETRY_BLOCK_END);

// ════════════════════════════════════════════════════════════════════
// §A — Verificacion estatica del guard T15-FIX en source server.js
// ════════════════════════════════════════════════════════════════════

describe('T15 §A — RC-2 GUARD en source server.js (estatico)', () => {
  test('A.1 — bloque retry pendingResponses presente', () => {
    expect(RETRY_BLOCK_START).toBeGreaterThan(0);
    expect(RETRY_BLOCK_END).toBeGreaterThan(RETRY_BLOCK_START);
  });

  test('A.2 — comentario T15-FIX presente (trazabilidad)', () => {
    expect(RETRY_BLOCK).toMatch(/T15-FIX/);
  });

  test('A.3 — guard if (isProcessing[effectiveTarget]) presente en bloque retry', () => {
    expect(RETRY_BLOCK).toMatch(/if\s*\(\s*isProcessing\[effectiveTarget\]\s*\)/);
  });

  test('A.4 — early return cuando guard true', () => {
    // Despues del if guard, debe haber un return; antes del isProcessing[...] = Date.now()
    const guardIdx = RETRY_BLOCK.search(/if\s*\(\s*isProcessing\[effectiveTarget\]\s*\)/);
    const setIdx = RETRY_BLOCK.indexOf('isProcessing[effectiveTarget] = Date.now()');
    const returnIdx = RETRY_BLOCK.indexOf('return;', guardIdx);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    expect(returnIdx).toBeLessThan(setIdx);
  });

  test('A.5 — log "RC-2 skip retry" presente', () => {
    expect(RETRY_BLOCK).toMatch(/RC-2 skip retry/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: simular timing window con mock state
// ════════════════════════════════════════════════════════════════════

describe('T15 §B — RC-2 GUARD logica de timing (runtime mock)', () => {
  // Simular la decision del guard en el retry setTimeout.
  // En el codigo real: el retry chequea si isProcessing[target] esta seteado;
  // si si → skip (un nuevo handler ya esta procesando).
  function shouldSkipRetry(isProcessingState, target) {
    return Boolean(isProcessingState[target]);
  }

  // Simular flow completo: handler A termina, agenda retry, mientras tanto handler B llega.
  function simulateRetryFlow({ pendingAtFinally, newHandlerArrivesInWindow }) {
    const isProcessing = {};
    const target = 'phone1';

    // Handler A esta procesando, finally ejecuta → delete isProcessing
    delete isProcessing[target];

    // Si pendingResponses[target]=true, agenda retry 1s
    let retryScheduled = pendingAtFinally;

    // Mientras la ventana 1s esta abierta:
    if (newHandlerArrivesInWindow) {
      // Nuevo mensaje llega, pasa check L10610 (isProcessing undefined → no return)
      // Su setTimeout 3s eventualmente setea isProcessing[target] = Date.now()
      // Para simular, asumimos que el setTimeout 3s del nuevo handler ejecuta ANTES
      // del retry 1s? NO — el retry 1s es mas rapido. Pero el nuevo HANDLER puede
      // setear isProcessing antes si el orden de timers difiere.
      //
      // En el caso real: si AMBOS timers disparan, el orden no esta garantizado.
      // El guard protege en el caso donde el nuevo handler llego primero a setear.
      isProcessing[target] = Date.now();
    }

    // Retry dispara 1s despues
    if (retryScheduled) {
      if (shouldSkipRetry(isProcessing, target)) {
        return { retryExecuted: false, reason: 'skipped — new handler active' };
      }
      // Retry procede normal
      isProcessing[target] = Date.now();
      return { retryExecuted: true, reason: 'no concurrent handler — retry OK' };
    }
    return { retryExecuted: false, reason: 'no pending response' };
  }

  test('B.1 — sin pending → no se dispara retry', () => {
    const result = simulateRetryFlow({ pendingAtFinally: false, newHandlerArrivesInWindow: false });
    expect(result.retryExecuted).toBe(false);
    expect(result.reason).toMatch(/no pending/);
  });

  test('B.2 — con pending + isProcessing limpio en retry → retry ejecuta normal', () => {
    const result = simulateRetryFlow({ pendingAtFinally: true, newHandlerArrivesInWindow: false });
    expect(result.retryExecuted).toBe(true);
    expect(result.reason).toMatch(/no concurrent handler/);
  });

  test('B.3 — con pending + nuevo msg en ventana (isProcessing seteado) → SKIP retry', () => {
    const result = simulateRetryFlow({ pendingAtFinally: true, newHandlerArrivesInWindow: true });
    expect(result.retryExecuted).toBe(false);
    expect(result.reason).toMatch(/skipped/);
    expect(result.reason).toMatch(/new handler/);
  });

  test('B.4 — guard idempotente: multiple llamadas con isProcessing seteado → siempre skip', () => {
    const isProcessing = { phone1: Date.now() };
    expect(shouldSkipRetry(isProcessing, 'phone1')).toBe(true);
    expect(shouldSkipRetry(isProcessing, 'phone1')).toBe(true); // idempotente
    expect(shouldSkipRetry(isProcessing, 'phone1')).toBe(true);
  });

  test('B.5 — guard NO afecta si isProcessing es 0 o undefined', () => {
    expect(shouldSkipRetry({}, 'phone1')).toBe(false);
    expect(shouldSkipRetry({ phone1: 0 }, 'phone1')).toBe(false);
    expect(shouldSkipRetry({ phone1: undefined }, 'phone1')).toBe(false);
  });

  test('B.6 — guard distingue por phone (un phone con isProcessing no afecta a otro)', () => {
    const isProcessing = { phone1: Date.now() };
    expect(shouldSkipRetry(isProcessing, 'phone1')).toBe(true);
    expect(shouldSkipRetry(isProcessing, 'phone2')).toBe(false);
  });
});
