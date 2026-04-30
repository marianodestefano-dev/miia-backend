'use strict';

/**
 * HEALTH AGGREGATOR — T47 (Vi 2026-04-30)
 *
 * Modulo standalone que agrega checks de salud por subsistema:
 * - Baileys: cuántos tenants online/offline/errored (via tenant_manager)
 * - AI (Gemini): estado del circuit breaker (via resilience_shield)
 * - Firestore: ping a una coleccion read-only (via firebase-admin)
 * - Process: uptime, memory, version
 *
 * Wire-in a `/health` o `/api/health/full` requiere edicion en server.js
 * (zona critica §5) -> ese paso queda como T48 con firma Mariano.
 *
 * Diseño: cada check es opcional (best-effort) y nunca tira excepción
 * sin atrapar. Si un subsistema falla, su sub-objeto reporta `status: 'error'`
 * + `error: <message>`. El agregador siempre retorna un objeto valido.
 *
 * Standard: Google + Amazon + NASA — fail loudly por subsistema, never break.
 */

const TIMEOUT_MS = 3000;

/**
 * Wrap promise con timeout para evitar que un check cuelgue todo el report.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Check 1 — Baileys tenant connections.
 * Espera modulo `whatsapp/tenant_manager` con getter de tenants.
 */
async function checkBaileys(tenantManager) {
  if (!tenantManager) {
    return { status: 'unknown', reason: 'tenant_manager not provided' };
  }
  try {
    const getAll = tenantManager.getAllTenants || tenantManager.tenants;
    let tenantList;
    if (typeof getAll === 'function') {
      tenantList = getAll();
    } else if (getAll && typeof getAll.values === 'function') {
      tenantList = Array.from(getAll.values());
    } else if (Array.isArray(getAll)) {
      tenantList = getAll;
    } else {
      return { status: 'unknown', reason: 'tenant_manager API not recognized' };
    }
    const total = tenantList.length;
    let online = 0, offline = 0, errored = 0;
    for (const t of tenantList) {
      if (!t) { offline++; continue; }
      const isReady = t.isReady === true || t.ready === true;
      const hasErr = t.lastError != null || t.cryptoErrorCount > 5;
      if (hasErr) errored++;
      else if (isReady) online++;
      else offline++;
    }
    const ratio = total > 0 ? online / total : 1;
    const status = total === 0 ? 'idle'
      : ratio >= 0.9 ? 'ok'
      : ratio >= 0.5 ? 'degraded'
      : 'critical';
    return { status, total, online, offline, errored };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/**
 * Check 2 — AI circuit breaker (resilience_shield).
 */
async function checkAI(shield) {
  if (!shield) return { status: 'unknown', reason: 'shield not provided' };
  try {
    const SYS = shield.SYSTEMS || {};
    const sysKey = SYS.GEMINI || 'GEMINI';
    const isOpen = typeof shield.isCircuitOpen === 'function'
      ? shield.isCircuitOpen(sysKey) : false;
    const dashboard = typeof shield.getHealthDashboard === 'function'
      ? shield.getHealthDashboard() : null;
    return {
      status: isOpen ? 'critical' : 'ok',
      circuit_open: isOpen,
      dashboard_available: dashboard != null,
    };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/**
 * Check 3 — Firestore connectivity probe.
 * Intenta read de una coleccion conocida (no escribe, no transaccion).
 */
async function checkFirestore(firestoreClient, probeCollection = '_health_probe') {
  if (!firestoreClient) return { status: 'unknown', reason: 'firestore not provided' };
  try {
    const t0 = Date.now();
    await withTimeout(
      firestoreClient.collection(probeCollection).limit(1).get(),
      TIMEOUT_MS,
      'firestore_probe'
    );
    return { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/**
 * Check 4 — Process metadata (uptime, memory).
 */
function checkProcess() {
  const mem = process.memoryUsage();
  return {
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
    memory_mb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    node_version: process.version,
  };
}

/**
 * Aggregate full health report.
 * @param {object} deps - inyecta dependencias { tenantManager, shield, firestoreClient }
 * @returns {Promise<object>} reporte agregado
 */
async function aggregateHealth(deps = {}) {
  const t0 = Date.now();
  const [baileys, ai, firestore] = await Promise.all([
    checkBaileys(deps.tenantManager),
    checkAI(deps.shield),
    checkFirestore(deps.firestoreClient, deps.probeCollection),
  ]);
  const proc = checkProcess();
  const subsystems = { baileys, ai, firestore, process: proc };
  // Overall status: max severity de cada subsistema (ok < degraded < critical < error)
  const severity = { ok: 0, idle: 0, unknown: 1, degraded: 2, critical: 3, error: 4 };
  let maxSev = 0;
  for (const sub of Object.values(subsystems)) {
    const s = severity[sub.status] != null ? severity[sub.status] : 0;
    if (s > maxSev) maxSev = s;
  }
  const overallByLevel = ['ok', 'unknown', 'degraded', 'critical', 'error'];
  return {
    status: overallByLevel[maxSev] || 'ok',
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    subsystems,
  };
}

module.exports = {
  aggregateHealth,
  checkBaileys,
  checkAI,
  checkFirestore,
  checkProcess,
  // Exposed for tests
  withTimeout,
};
