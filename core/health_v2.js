'use strict';

/**
 * MIIA — Health V2 con latencias (T109)
 * Mide latencias de servicios criticos: Firestore, Gemini (mocked), Redis (si aplica).
 * Retorna { status: 'ok'|'degraded'|'down', services: { name, latencyMs, status } }
 */

const admin = require('firebase-admin');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || admin.firestore(); }

let _externalPingFn = null;
function __setExternalPingForTests(fn) { _externalPingFn = fn; }

const LATENCY_THRESHOLDS = Object.freeze({
  ok: 500,       // < 500ms = ok
  degraded: 2000, // 500-2000ms = degraded
  // > 2000ms = down
});

/**
 * Mide la latencia de un ping a Firestore.
 */
async function pingFirestore(uid) {
  if (!uid) return { latencyMs: -1, status: 'skipped' };
  const start = Date.now();
  try {
    await db().collection('health_ping').doc('v2').get();
    const latencyMs = Date.now() - start;
    const status = latencyMs < LATENCY_THRESHOLDS.ok ? 'ok'
      : latencyMs < LATENCY_THRESHOLDS.degraded ? 'degraded' : 'down';
    return { latencyMs, status };
  } catch (e) {
    return { latencyMs: Date.now() - start, status: 'down', error: e.message };
  }
}

/**
 * Ping a servicio externo (Gemini, etc). Usa _externalPingFn en tests.
 */
async function pingExternal(name, pingFn) {
  const start = Date.now();
  try {
    const fn = _externalPingFn || pingFn;
    await fn(name);
    const latencyMs = Date.now() - start;
    const status = latencyMs < LATENCY_THRESHOLDS.ok ? 'ok'
      : latencyMs < LATENCY_THRESHOLDS.degraded ? 'degraded' : 'down';
    return { name, latencyMs, status };
  } catch (e) {
    return { name, latencyMs: Date.now() - start, status: 'down', error: e.message };
  }
}

/**
 * Retorna un health check V2 completo con latencias.
 * @param {string} [uid] - opcional para ping Firestore tenant
 * @param {Array<{name, pingFn}>} [externalServices]
 * @returns {Promise<{ status, uptimeMs, services, checkedAt }>}
 */
async function getHealthV2(uid, externalServices = [], startTime = process.hrtime.bigint()) {
  const uptimeMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  const services = [];

  // Firestore ping
  const fs = await pingFirestore(uid);
  services.push({ name: 'firestore', ...fs });

  // External services
  for (const svc of externalServices) {
    const result = await pingExternal(svc.name, svc.pingFn);
    services.push(result);
  }

  // Overall status = worst of all services
  const hasDown = services.some(s => s.status === 'down');
  const hasDegraded = services.some(s => s.status === 'degraded');
  const overallStatus = hasDown ? 'down' : hasDegraded ? 'degraded' : 'ok';

  return {
    status: overallStatus,
    uptimeMs: Math.round(uptimeMs),
    services,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Clasifica un latencyMs segun umbrales.
 */
function classifyLatency(latencyMs) {
  if (latencyMs < 0) return 'skipped';
  if (latencyMs < LATENCY_THRESHOLDS.ok) return 'ok';
  if (latencyMs < LATENCY_THRESHOLDS.degraded) return 'degraded';
  return 'down';
}

module.exports = {
  getHealthV2, pingFirestore, pingExternal, classifyLatency,
  LATENCY_THRESHOLDS, __setFirestoreForTests, __setExternalPingForTests,
};
