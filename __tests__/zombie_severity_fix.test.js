'use strict';

/**
 * Tests: T11a — ZOMBIE alert severity fix en health_check.js.
 *
 * Origen: T5 audit 2026-04-29 (ZOMBIE: severity='error' en Railway cuando
 * upserts(10m)=0 — falso positivo cuando todos los servicios estan sanos).
 * Fix T11a C-464: console.warn en vez de console.error para ZOMBIE-only.
 *
 * §A — Tests estaticos sobre source health_check (regex, sin runtime).
 * §B — Tests runtime: simular runFullCheck con mocks.
 */

const fs = require('fs');
const path = require('path');

const HC_PATH = path.resolve(__dirname, '../core/health_check.js');
const HC_SOURCE = fs.readFileSync(HC_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Verificacion estatica del fix T11a en source
// ════════════════════════════════════════════════════════════════════

describe('T11a §A — ZOMBIE severity fix en source health_check (estatico)', () => {
  test('A.1 — hasRealFailure variable presente (distingue falla real de ZOMBIE)', () => {
    expect(HC_SOURCE).toMatch(/hasRealFailure\s*=\s*!results\.firestore\s*\|\|\s*baileysDown\.length\s*>\s*0/);
  });

  test('A.2 — logFn dinamico presente (console.warn para ZOMBIE, console.error para falla real)', () => {
    expect(HC_SOURCE).toMatch(/const logFn\s*=\s*hasRealFailure\s*\?\s*console\.error\s*:\s*console\.warn/);
  });

  test('A.3 — logFn se usa para el log (no console.error hardcodeado)', () => {
    // Verificar que logFn(... se llama, no console.error directamente
    expect(HC_SOURCE).toMatch(/logFn\(`\[HEALTH\]/);
  });

  test('A.4 — comentario T11-FIX presente (trazabilidad)', () => {
    expect(HC_SOURCE).toMatch(/T11-FIX/);
  });

  test('A.5 — console.error NO aparece para el log principal de HEALTH en el bloque if', () => {
    // El bloque if(!results.firestore || ...) ya no debe tener console.error directo
    // (solo logFn que puede ser warn o error segun hasRealFailure)
    const block = HC_SOURCE.slice(
      HC_SOURCE.indexOf('if (!results.firestore || baileysDown.length > 0 || upsertWarn)'),
      HC_SOURCE.indexOf('} else {', HC_SOURCE.indexOf('if (!results.firestore || baileysDown.length > 0 || upsertWarn)'))
    );
    // logFn debe estar, console.error NO debe estar como standalone en el bloque
    expect(block).toContain('logFn(');
    expect(block).not.toMatch(/console\.error\(`\[HEALTH\]/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: mock completo para verificar console level
// ════════════════════════════════════════════════════════════════════

describe('T11a §B — ZOMBIE severity: nivel de log correcto (runtime mock)', () => {
  // Simula la logica de decision del bloque if de runFullCheck
  // sin invocar el modulo completo (que necesita Firestore/Baileys live).
  function simulateHealthLog(results, baileysDown, upsertStats, uptimeSec) {
    const hasConnected = Object.values(results.baileys || {}).some(v => v);
    const upsert = {
      count10min: upsertStats.count10min,
      count20min: upsertStats.count20min,
    };
    let upsertWarn = false;
    if (uptimeSec >= 900 && hasConnected) {
      if (upsert.count10min === 0 && upsert.count20min === 0) upsertWarn = true;
      else if (upsert.count10min === 0) upsertWarn = true;
    }

    if (!results.firestore || baileysDown.length > 0 || upsertWarn) {
      const hasRealFailure = !results.firestore || baileysDown.length > 0;
      const icon = (!results.firestore || (upsert.count10min === 0 && upsert.count20min === 0 && uptimeSec >= 900 && hasConnected)) ? '🚨 CRITICAL' : '⚠️ WARN';
      const logLevel = hasRealFailure ? 'error' : 'warn'; // simula eleccion logFn
      return { logLevel, icon };
    }
    return { logLevel: 'log', icon: '✅' };
  }

  test('B.1 — ZOMBIE solo (servicios sanos, upserts=0,0) → warn, no error', () => {
    const { logLevel, icon } = simulateHealthLog(
      { firestore: true, baileys: { uid1: true } },
      [], // baileysDown empty
      { count10min: 0, count20min: 0 },
      1200 // uptime > 900s
    );
    expect(logLevel).toBe('warn');
    // El icon puede ser CRITICAL (por la logica de icon que indica estado grave)
    // pero el LOG LEVEL es warn — eso es lo que Railway ve como severity
  });

  test('B.2 — Firestore down → error (falla real)', () => {
    const { logLevel } = simulateHealthLog(
      { firestore: false, baileys: { uid1: true } },
      [],
      { count10min: 5, count20min: 10 },
      1200
    );
    expect(logLevel).toBe('error');
  });

  test('B.3 — Baileys down → error (falla real)', () => {
    const { logLevel } = simulateHealthLog(
      { firestore: true, baileys: { uid1: false } },
      ['uid1'],
      { count10min: 5, count20min: 10 },
      1200
    );
    expect(logLevel).toBe('error');
  });

  test('B.4 — upserts normales, todos sanos → log OK (no alert)', () => {
    const { logLevel } = simulateHealthLog(
      { firestore: true, baileys: { uid1: true } },
      [],
      { count10min: 3, count20min: 8 },
      1200
    );
    expect(logLevel).toBe('log');
  });

  test('B.5 — ZOMBIE pero uptime < 900s (startup) → no warn (no activado)', () => {
    // Si el servicio recien arranco, upserts=0 es esperado, no ZOMBIE
    const { logLevel } = simulateHealthLog(
      { firestore: true, baileys: { uid1: true } },
      [],
      { count10min: 0, count20min: 0 },
      300 // uptime < 900s
    );
    expect(logLevel).toBe('log'); // upsertWarn no se activa con uptime < 900s
  });

  test('B.6 — Firestore down + ZOMBIE → error (falla real domina)', () => {
    const { logLevel } = simulateHealthLog(
      { firestore: false, baileys: { uid1: true } },
      [],
      { count10min: 0, count20min: 0 },
      1200
    );
    expect(logLevel).toBe('error');
  });
});
