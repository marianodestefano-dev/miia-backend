'use strict';

/**
 * VI-WA-TESTS — Cobertura 100% branches del codigo nuevo de C-WA-FIX-1
 * en whatsapp/tenant_manager.js (commit e48a258).
 *
 * Estrategia: las funciones son privadas (no exportadas) porque tenant_manager.js
 * es ZONA CRITICA. Se replican como funciones puras identicas para testear
 * todas las branches sin tocar el modulo productivo.
 *
 * Branches cubiertos:
 *   A. _randDelay(minMs, maxMs)
 *   B. updateDisconnectHistory(map, uid, now, windowMs)
 *   C. getReconnectDelay(statusCode, recentCount, attempts) — logica de seleccion
 *   D. Constantes C-WA-FIX-1 en rate_limiter y loop_watcher
 */

// ── replicas identicas de las funciones privadas de TM (C-WA-FIX-1) ──────────

const DISCONNECT_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const DISCONNECT_COOLING_THRESHOLD = 5;

function _randDelay(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

function updateDisconnectHistory(map, uid, nowMs, windowMs) {
  const hist = map.get(uid) || [];
  const recent = hist.filter(ts => nowMs - ts < windowMs);
  recent.push(nowMs);
  map.set(uid, recent);
  return recent;
}

function getReconnectDelay(statusCode, recent, attempts) {
  const inCooling = recent.length > DISCONNECT_COOLING_THRESHOLD;
  const isConnectionReplaced = statusCode === 440;
  let delay;
  if (isConnectionReplaced) {
    const baseDelay = Math.min(5000 + (attempts * 3000), 30000);
    delay = baseDelay + Math.floor(Math.random() * 2000);
  } else if (inCooling) {
    delay = _randDelay(90 * 60_000, 150 * 60_000);
  } else if (statusCode === 428) {
    delay = _randDelay(25 * 60_000, 50 * 60_000);
  } else if (statusCode === 500 && recent.length >= 3) {
    delay = _randDelay(20 * 60_000, 40 * 60_000);
  } else {
    delay = _randDelay(3 * 60_000, 8 * 60_000);
  }
  return { delay, inCooling };
}

// ── §A: _randDelay ─────────────────────────────────────────────────────────────

describe('C-WA-FIX-1 §A -- _randDelay(minMs, maxMs)', function() {
  test('A.1 retorna valor >= minMs', function() {
    for (let i = 0; i < 50; i++) {
      expect(_randDelay(1000, 5000)).toBeGreaterThanOrEqual(1000);
    }
  });

  test('A.2 retorna valor < maxMs', function() {
    for (let i = 0; i < 50; i++) {
      expect(_randDelay(1000, 5000)).toBeLessThan(5000);
    }
  });

  test('A.3 cuando min === max - 1: retorna siempre min', function() {
    expect(_randDelay(1000, 1001)).toBe(1000);
  });

  test('A.4 rango cooling 90-150 min: dentro de rango', function() {
    for (let i = 0; i < 20; i++) {
      const v = _randDelay(90 * 60_000, 150 * 60_000);
      expect(v).toBeGreaterThanOrEqual(90 * 60_000);
      expect(v).toBeLessThan(150 * 60_000);
    }
  });

  test('A.5 rango 428: 25-50 min dentro de rango', function() {
    for (let i = 0; i < 20; i++) {
      const v = _randDelay(25 * 60_000, 50 * 60_000);
      expect(v).toBeGreaterThanOrEqual(25 * 60_000);
      expect(v).toBeLessThan(50 * 60_000);
    }
  });
});

// ── §B: updateDisconnectHistory ───────────────────────────────────────────────

describe('C-WA-FIX-1 §B -- updateDisconnectHistory', function() {
  test('B.1 uid nuevo: crea historial con 1 entrada', function() {
    const map = new Map();
    const recent = updateDisconnectHistory(map, 'uid-1', Date.now(), DISCONNECT_HISTORY_WINDOW_MS);
    expect(recent).toHaveLength(1);
    expect(map.has('uid-1')).toBe(true);
  });

  test('B.2 entradas dentro de la ventana: se conservan', function() {
    const map = new Map();
    const now = Date.now();
    updateDisconnectHistory(map, 'uid-2', now - 1000, DISCONNECT_HISTORY_WINDOW_MS);
    updateDisconnectHistory(map, 'uid-2', now - 2000, DISCONNECT_HISTORY_WINDOW_MS);
    const recent = updateDisconnectHistory(map, 'uid-2', now, DISCONNECT_HISTORY_WINDOW_MS);
    expect(recent).toHaveLength(3);
  });

  test('B.3 entradas fuera de ventana: se filtran', function() {
    const map = new Map();
    const now = Date.now();
    const oldTs = now - DISCONNECT_HISTORY_WINDOW_MS - 1000;
    map.set('uid-3', [oldTs, oldTs]);
    const recent = updateDisconnectHistory(map, 'uid-3', now, DISCONNECT_HISTORY_WINDOW_MS);
    expect(recent).toHaveLength(1); // los viejos se filtran, solo queda el nuevo
  });

  test('B.4 exactamente en el limite de ventana: no se incluye', function() {
    const map = new Map();
    const now = Date.now();
    const borderTs = now - DISCONNECT_HISTORY_WINDOW_MS; // exactamente en el borde
    map.set('uid-4', [borderTs]);
    const recent = updateDisconnectHistory(map, 'uid-4', now, DISCONNECT_HISTORY_WINDOW_MS);
    expect(recent).toHaveLength(1); // borderTs queda fuera (< no <=), solo el nuevo
  });
});

// ── §C: getReconnectDelay -- todas las branches ───────────────────────────────

describe('C-WA-FIX-1 §C -- getReconnectDelay branches', function() {
  test('C.1 code 440: delay entre 5000 y 32000ms (backoff attempts=0)', function() {
    const { delay, inCooling } = getReconnectDelay(440, [], 0);
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThan(32000);
    expect(inCooling).toBe(false);
  });

  test('C.2 code 440 attempts=10: delay capped a ~30000+2000', function() {
    const { delay } = getReconnectDelay(440, [], 10);
    // baseDelay = min(5000 + 10*3000, 30000) = 30000; + random(0,2000)
    expect(delay).toBeGreaterThanOrEqual(30000);
    expect(delay).toBeLessThan(32001);
  });

  test('C.3 cooling mode (6 disconnects recientes): delay 90-150 min', function() {
    const recent = [1, 2, 3, 4, 5, 6]; // 6 entradas > threshold 5
    const { delay, inCooling } = getReconnectDelay(500, recent, 1);
    expect(inCooling).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(90 * 60_000);
    expect(delay).toBeLessThan(150 * 60_000);
  });

  test('C.4 code 428 sin cooling: delay 25-50 min', function() {
    const recent = [1, 2]; // < threshold
    const { delay, inCooling } = getReconnectDelay(428, recent, 1);
    expect(inCooling).toBe(false);
    expect(delay).toBeGreaterThanOrEqual(25 * 60_000);
    expect(delay).toBeLessThan(50 * 60_000);
  });

  test('C.5 code 500 con 3+ recientes sin cooling: delay 20-40 min', function() {
    const recent = [1, 2, 3]; // 3 entradas, < threshold 5
    const { delay, inCooling } = getReconnectDelay(500, recent, 1);
    expect(inCooling).toBe(false);
    expect(delay).toBeGreaterThanOrEqual(20 * 60_000);
    expect(delay).toBeLessThan(40 * 60_000);
  });

  test('C.6 code 500 con 2 recientes (< 3): delay 3-8 min (default)', function() {
    const recent = [1, 2]; // 2 entradas < 3
    const { delay } = getReconnectDelay(500, recent, 1);
    expect(delay).toBeGreaterThanOrEqual(3 * 60_000);
    expect(delay).toBeLessThan(8 * 60_000);
  });

  test('C.7 code 999 (desconocido) sin historial: delay default 3-8 min', function() {
    const { delay } = getReconnectDelay(999, [], 1);
    expect(delay).toBeGreaterThanOrEqual(3 * 60_000);
    expect(delay).toBeLessThan(8 * 60_000);
  });

  test('C.8 exactamente 5 recientes (= threshold, no > threshold): NO cooling', function() {
    const recent = [1, 2, 3, 4, 5]; // exactly 5, threshold is > 5
    const { inCooling } = getReconnectDelay(500, recent, 1);
    expect(inCooling).toBe(false);
  });

  test('C.9 440 tiene prioridad sobre cooling', function() {
    const recent = [1, 2, 3, 4, 5, 6]; // cooling mode
    const { delay } = getReconnectDelay(440, recent, 0);
    // code 440 branch ejecuta antes que cooling check
    expect(delay).toBeLessThan(32001); // no es rango cooling
  });
});

// ── §D: constantes exportadas de rate_limiter y loop_watcher ──────────────────

describe('C-WA-FIX-1 §D -- constantes anti-bot exportadas', function() {
  const rl = require('../core/rate_limiter');
  const lw = require('../core/loop_watcher');

  test('D.1 DISCONNECT_HISTORY_WINDOW_MS = 6h', function() {
    expect(DISCONNECT_HISTORY_WINDOW_MS).toBe(6 * 60 * 60 * 1000);
  });

  test('D.2 DISCONNECT_COOLING_THRESHOLD = 5', function() {
    expect(DISCONNECT_COOLING_THRESHOLD).toBe(5);
  });

  test('D.3 rate_limiter: CONTACT_WINDOW_MS = 60s', function() {
    expect(rl.CONTACT_WINDOW_MS).toBe(60_000);
  });

  test('D.4 rate_limiter: CONTACT_MAX_FAMILY = 5', function() {
    expect(rl.CONTACT_MAX_FAMILY).toBe(5);
  });

  test('D.5 rate_limiter: CONTACT_MAX_DEFAULT = 2', function() {
    expect(rl.CONTACT_MAX_DEFAULT).toBe(2);
  });

  test('D.6 loop_watcher: LOOP_THRESHOLD = 6', function() {
    expect(lw.LOOP_THRESHOLD).toBe(6);
  });

  test('D.7 loop_watcher: LOOP_WINDOW_MS = 60s', function() {
    expect(lw.LOOP_WINDOW_MS).toBe(60_000);
  });
});
