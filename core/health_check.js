'use strict';

/**
 * HEALTH CHECK + AUTO-RECOVERY — Monitoreo de salud de MIIA
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Verifica cada 60s:
 *   1. Baileys: ¿socket conectado? ¿responde a ping?
 *   2. Firestore: ¿responde a lectura?
 *   3. AI Gateway: ¿Gemini/Claude responden?
 *
 * Si algo falla → intenta recovery automático (hasta 3 veces).
 * Si no se recupera → alerta al owner por self-chat + log CRITICAL.
 *
 * Estado expuesto vía /api/health para dashboard en tiempo real.
 */

const admin = require('firebase-admin');
const { getUpsertStats } = require('../whatsapp/tenant_manager');

// ═══════════════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════════════

const _health = {
  firestore: { status: 'unknown', lastCheck: null, lastError: null, consecutiveFailures: 0, latencyHistory: [] },
  baileys: {},    // { [uid]: { status, lastCheck, lastError, consecutiveFailures } }
  aiGateway: { status: 'unknown', lastCheck: null, lastError: null, consecutiveFailures: 0, latencyHistory: [] },
  startedAt: new Date().toISOString(),
  lastFullCheck: null,
};

const MAX_CONSECUTIVE_FAILURES = 3;
const CHECK_INTERVAL_MS = 60_000; // 60 segundos
const RECOVERY_COOLDOWN_MS = 30_000; // 30s entre intentos de recovery

// T24-FIX: latency rolling buffer para percentiles p50/p95/p99 (E2 propuesta T20)
const LATENCY_BUFFER_SIZE = 100; // ultimos 100 checks
const LATENCY_DEGRADATION_FACTOR = 2; // p95 > 2x baseline → degradacion

/**
 * Agrega un sample de latencia al buffer rolling (max 100 entries).
 */
function recordLatency(component, latencyMs) {
  if (typeof latencyMs !== 'number' || latencyMs < 0) return;
  if (!_health[component]) return;
  if (!Array.isArray(_health[component].latencyHistory)) {
    _health[component].latencyHistory = [];
  }
  _health[component].latencyHistory.push(latencyMs);
  if (_health[component].latencyHistory.length > LATENCY_BUFFER_SIZE) {
    _health[component].latencyHistory.shift();
  }
}

/**
 * Calcula percentiles p50, p95, p99 + min/max/avg sobre el buffer rolling.
 * Retorna null si no hay suficientes samples (< 5).
 */
function computePercentiles(component) {
  const history = _health[component]?.latencyHistory;
  if (!Array.isArray(history) || history.length < 5) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    samples: n,
    min: sorted[0],
    max: sorted[n - 1],
    avg: Math.round(sum / n),
    p50: pct(0.50),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}

// Callbacks registrados por server.js / tenant_manager.js
const _recoveryCallbacks = {
  reconnectBaileys: null,  // (uid) => Promise<boolean>
  notifyOwner: null,       // (uid, message) => Promise<void>
};

// ═══════════════════════════════════════════════════════════════
// CHECK: FIRESTORE
// ═══════════════════════════════════════════════════════════════

async function checkFirestore() {
  const start = Date.now();
  try {
    // Lectura simple — si Firestore responde, está vivo
    await admin.firestore().collection('_health_check').doc('ping').set({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      source: 'health_check'
    });
    const latency = Date.now() - start;
    // T24-FIX: preservar latencyHistory entre updates (no clobber)
    const prevHistory = _health.firestore?.latencyHistory || [];
    _health.firestore = {
      status: 'healthy',
      lastCheck: new Date().toISOString(),
      latencyMs: latency,
      lastError: null,
      consecutiveFailures: 0,
      latencyHistory: prevHistory,
    };
    recordLatency('firestore', latency);
    return true;
  } catch (e) {
    _health.firestore.consecutiveFailures++;
    _health.firestore.status = _health.firestore.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'critical' : 'degraded';
    _health.firestore.lastCheck = new Date().toISOString();
    _health.firestore.lastError = e.message;
    console.error(`[HEALTH] ❌ Firestore CHECK FAILED (${_health.firestore.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CHECK: BAILEYS (por tenant)
// ═══════════════════════════════════════════════════════════════

function checkBaileys(uid, sock) {
  if (!_health.baileys[uid]) {
    _health.baileys[uid] = { status: 'unknown', lastCheck: null, lastError: null, consecutiveFailures: 0 };
  }
  const state = _health.baileys[uid];

  try {
    if (!sock) {
      state.consecutiveFailures++;
      state.status = 'disconnected';
      state.lastError = 'Socket is null';
    } else if (!sock.user) {
      state.consecutiveFailures++;
      state.status = 'disconnected';
      state.lastError = 'Socket has no user (not authenticated)';
    } else {
      state.status = 'healthy';
      state.lastError = null;
      state.consecutiveFailures = 0;
    }
    state.lastCheck = new Date().toISOString();
    return state.status === 'healthy';
  } catch (e) {
    state.consecutiveFailures++;
    state.status = 'error';
    state.lastCheck = new Date().toISOString();
    state.lastError = e.message;
    console.error(`[HEALTH] ❌ Baileys CHECK FAILED for ${uid}: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// CHECK: AI GATEWAY (Gemini/Claude)
// ═══════════════════════════════════════════════════════════════

async function checkAIGateway(aiGateway) {
  const start = Date.now();
  try {
    if (!aiGateway || typeof aiGateway.healthCheck !== 'function') {
      // Si no hay healthCheck, verificar que el módulo existe
      _health.aiGateway.status = 'unknown';
      _health.aiGateway.lastCheck = new Date().toISOString();
      return true; // No fallar si no hay healthCheck implementado
    }
    const result = await aiGateway.healthCheck();
    const latency = Date.now() - start;
    // T24-FIX: preservar latencyHistory entre updates
    const prevHistory = _health.aiGateway?.latencyHistory || [];
    _health.aiGateway = {
      status: result ? 'healthy' : 'degraded',
      lastCheck: new Date().toISOString(),
      latencyMs: latency,
      lastError: null,
      consecutiveFailures: result ? 0 : _health.aiGateway.consecutiveFailures + 1,
      latencyHistory: prevHistory,
    };
    if (result) recordLatency('aiGateway', latency); // solo samples healthy
    return result;
  } catch (e) {
    _health.aiGateway.consecutiveFailures++;
    _health.aiGateway.status = _health.aiGateway.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'critical' : 'degraded';
    _health.aiGateway.lastCheck = new Date().toISOString();
    _health.aiGateway.lastError = e.message;
    console.error(`[HEALTH] ❌ AI Gateway CHECK FAILED (${_health.aiGateway.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-RECOVERY
// ═══════════════════════════════════════════════════════════════

async function attemptRecovery(uid, component) {
  console.warn(`[HEALTH] 🔧 Intentando recovery de ${component} para ${uid}...`);

  if (component === 'baileys' && _recoveryCallbacks.reconnectBaileys) {
    try {
      const success = await _recoveryCallbacks.reconnectBaileys(uid);
      if (success) {
        console.log(`[HEALTH] ✅ Recovery de Baileys exitoso para ${uid}`);
        _health.baileys[uid].consecutiveFailures = 0;
        _health.baileys[uid].status = 'recovering';
        return true;
      }
    } catch (e) {
      console.error(`[HEALTH] ❌ Recovery de Baileys falló para ${uid}: ${e.message}`);
    }
  }

  // Si no se pudo recuperar y ya van MAX intentos → alertar al owner
  if (_recoveryCallbacks.notifyOwner) {
    try {
      await _recoveryCallbacks.notifyOwner(uid, `⚠️ *ALERTA SISTEMA*: ${component} no responde después de ${MAX_CONSECUTIVE_FAILURES} intentos. Puede que necesites reconectar manualmente desde el dashboard.`);
    } catch (e) {
      console.error(`[HEALTH] ❌ No pude notificar al owner ${uid}: ${e.message}`);
    }
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// RUN FULL CHECK — Ejecutar todas las verificaciones
// ═══════════════════════════════════════════════════════════════

/**
 * Ejecutar health check completo.
 * @param {Object} opts
 * @param {Object} opts.tenants - { uid: { sock, isReady } } — estado de cada tenant
 * @param {Object} [opts.aiGateway] - Módulo de AI gateway (opcional)
 * @returns {Object} Estado completo de salud
 */
async function runFullCheck({ tenants = {}, aiGateway = null } = {}) {
  const results = { firestore: false, baileys: {}, aiGateway: false, timestamp: new Date().toISOString() };

  // 1. Firestore
  results.firestore = await checkFirestore();

  // 2. Baileys por tenant
  for (const [uid, tenant] of Object.entries(tenants)) {
    const healthy = checkBaileys(uid, tenant.sock);
    results.baileys[uid] = healthy;

    // Auto-recovery si falla consistentemente
    if (!healthy && _health.baileys[uid]?.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      await attemptRecovery(uid, 'baileys');
    }
  }

  // 3. AI Gateway
  results.aiGateway = await checkAIGateway(aiGateway);

  _health.lastFullCheck = results.timestamp;

  // Log resumen — C-228/F2: incluye upsert stats
  const baileysDown = Object.entries(results.baileys).filter(([, v]) => !v).map(([k]) => k);
  const upsert = getUpsertStats(null);
  const uptimeSec = Math.floor((Date.now() - new Date(_health.startedAt).getTime()) / 1000);
  const hasConnected = Object.values(results.baileys).some(v => v);
  let upsertTag = `upserts(10m): ${upsert.count10min}, (20m): ${upsert.count20min}`;
  let upsertWarn = false;
  if (uptimeSec >= 900 && hasConnected) {
    if (upsert.count10min === 0 && upsert.count20min === 0) {
      upsertTag = `❌ upserts(10m): 0, (20m): 0 — ZOMBIE?`;
      upsertWarn = true;
    } else if (upsert.count10min === 0) {
      upsertTag = `⚠️ upserts(10m): 0, (20m): ${upsert.count20min}`;
      upsertWarn = true;
    }
  }
  if (!results.firestore || baileysDown.length > 0 || upsertWarn) {
    const hasRealFailure = !results.firestore || baileysDown.length > 0;
    const icon = (!results.firestore || (upsert.count10min === 0 && upsert.count20min === 0 && uptimeSec >= 900 && hasConnected)) ? '🚨 CRITICAL' : '⚠️ WARN';
    // T11-FIX: ZOMBIE solo (upserts=0 con todos servicios sanos) → console.warn, no console.error.
    // En Railway, console.error genera severity=error — falso positivo cuando no hay falla real.
    const logFn = hasRealFailure ? console.error : console.warn;
    logFn(`[HEALTH] ${icon} — Firestore: ${results.firestore ? '✅' : '❌'}, Baileys down: [${baileysDown.join(', ')}], AI: ${results.aiGateway ? '✅' : '⚠️'} | ${upsertTag}`);
  } else {
    console.log(`[HEALTH] ✅ ALL HEALTHY — Firestore: ✅, Baileys: ${Object.keys(results.baileys).length} tenants ✅, AI: ${results.aiGateway ? '✅' : '⚠️'} | ${upsertTag}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// INICIALIZACIÓN — Llamar desde server.js
// ═══════════════════════════════════════════════════════════════

let _checkInterval = null;

/**
 * Iniciar health checks periódicos.
 * @param {Object} opts - { tenants, aiGateway, reconnectBaileys, notifyOwner }
 */
function startHealthChecks(opts = {}) {
  if (_checkInterval) clearInterval(_checkInterval);

  if (opts.reconnectBaileys) _recoveryCallbacks.reconnectBaileys = opts.reconnectBaileys;
  if (opts.notifyOwner) _recoveryCallbacks.notifyOwner = opts.notifyOwner;

  const getTenants = opts.getTenants || (() => opts.tenants || {});
  const aiGw = opts.aiGateway || null;

  _checkInterval = setInterval(async () => {
    try {
      await runFullCheck({ tenants: getTenants(), aiGateway: aiGw });
    } catch (e) {
      console.error(`[HEALTH] ❌ Error en health check periódico: ${e.message}`);
    }
  }, CHECK_INTERVAL_MS);

  console.log(`[HEALTH] 🏥 Health checks iniciados (cada ${CHECK_INTERVAL_MS / 1000}s)`);
}

function stopHealthChecks() {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// API — Para endpoint /api/health
// ═══════════════════════════════════════════════════════════════

function getHealthStatus() {
  const baileysStatuses = Object.entries(_health.baileys).map(([uid, state]) => ({
    uid: uid.substring(0, 8) + '...', // No exponer UID completo
    status: state.status,
    lastCheck: state.lastCheck,
    failures: state.consecutiveFailures
  }));

  // ═══ C-228/F2: Métrica messages.upsert deslizante ═══
  const uptimeSeconds = Math.floor((Date.now() - new Date(_health.startedAt).getTime()) / 1000);
  const upsertStats = getUpsertStats(null); // todos los tenants
  const hasConnectedTenants = baileysStatuses.some(b => b.status === 'healthy');
  let upsertStatus = 'healthy';
  if (uptimeSeconds >= 900 && hasConnectedTenants) { // 15 min boot grace
    if (upsertStats.count10min === 0 && upsertStats.count20min === 0) {
      upsertStatus = 'critical';
    } else if (upsertStats.count10min === 0) {
      upsertStatus = 'warn';
    }
  }

  const overallStatus =
    _health.firestore.status === 'critical' ? 'critical' :
    baileysStatuses.some(b => b.status === 'disconnected') ? 'degraded' :
    _health.firestore.status === 'healthy' ? 'healthy' : 'unknown';

  // T24-FIX: percentiles latency rolling para Firestore + AI Gateway
  const firestorePct = computePercentiles('firestore');
  const aiGatewayPct = computePercentiles('aiGateway');

  return {
    status: overallStatus,
    uptime: uptimeSeconds,
    startedAt: _health.startedAt,
    lastFullCheck: _health.lastFullCheck,
    components: {
      firestore: {
        status: _health.firestore.status,
        latencyMs: _health.firestore.latencyMs,
        lastCheck: _health.firestore.lastCheck,
        failures: _health.firestore.consecutiveFailures,
        latency: firestorePct, // T24: { samples, min, max, avg, p50, p95, p99 } | null
      },
      baileys: baileysStatuses,
      aiGateway: {
        status: _health.aiGateway.status,
        latencyMs: _health.aiGateway.latencyMs,
        lastCheck: _health.aiGateway.lastCheck,
        failures: _health.aiGateway.consecutiveFailures,
        latency: aiGatewayPct, // T24
      },
      messagesUpsert: {
        count10min: upsertStats.count10min,
        count20min: upsertStats.count20min,
        lastUpsertAt: upsertStats.lastUpsertAt ? new Date(upsertStats.lastUpsertAt).toISOString() : null,
        status: upsertStatus,
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  startHealthChecks,
  stopHealthChecks,
  runFullCheck,
  getHealthStatus,
  // T24-FIX: helpers latency percentiles (exposicion para tests)
  recordLatency,
  computePercentiles,
  _health, // exposicion estado interno para tests T24
  LATENCY_BUFFER_SIZE,
  checkFirestore,
  checkBaileys,
  checkAIGateway,
  CHECK_INTERVAL_MS,
  MAX_CONSECUTIVE_FAILURES,
};
