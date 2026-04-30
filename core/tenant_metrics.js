'use strict';

/**
 * TENANT METRICS — T53 (Vi 2026-04-30)
 *
 * Skeleton standalone para metricas per-tenant in-memory rolling window.
 *
 * Diseño:
 * - WINDOW_MS = 5 min (configurable). Cada metrica es un array de eventos
 *   con timestamp; _pruneOld elimina eventos fuera del window al leer/escribir.
 * - Per-tenant counters: incoming msg, outgoing msg, errors, AI calls.
 * - aggregateAll() retorna snapshot agregado por uid + global.
 * - Wire-in opcional a /api/health/tenant-metrics queda para T-future con
 *   firma Mariano (zona critica server.js seccion 5).
 *
 * Standard: Google + Amazon + NASA — fail loudly, observable, zero PII.
 * NO loggea contenido de mensajes — solo conteos + latencias.
 */

const WINDOW_MS = 5 * 60 * 1000;

// State per-tenant: { uid: { messagesIn:[], messagesOut:[], errors:[], aiCalls:[] } }
const _state = {};

function _ensure(uid) {
  if (!_state[uid]) {
    _state[uid] = {
      messagesIn: [],
      messagesOut: [],
      errors: [],
      aiCalls: [],
    };
  }
  return _state[uid];
}

function _pruneOld(arr, windowMs = WINDOW_MS) {
  const cutoff = Date.now() - windowMs;
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
}

// ═══════════════════════════════════════════════════════════════
// RECORD APIs (zero-PII — solo conteos + latencias + flags)
// ═══════════════════════════════════════════════════════════════

/**
 * Registrar mensaje entrante de un contacto al tenant.
 * @param {string} uid - Tenant UID
 * @param {object} [opts] - { contactType?: 'lead'|'family'|...|'owner' }
 */
function recordIncoming(uid, opts = {}) {
  if (!uid) return;
  const t = _ensure(uid);
  t.messagesIn.push({ ts: Date.now(), contactType: opts.contactType || 'unknown' });
  _pruneOld(t.messagesIn);
}

/**
 * Registrar mensaje saliente (MIIA respondio).
 * @param {string} uid
 * @param {object} [opts] - { latencyMs?: number, contactType?: string }
 */
function recordOutgoing(uid, opts = {}) {
  if (!uid) return;
  const t = _ensure(uid);
  t.messagesOut.push({
    ts: Date.now(),
    latencyMs: typeof opts.latencyMs === 'number' ? opts.latencyMs : 0,
    contactType: opts.contactType || 'unknown',
  });
  _pruneOld(t.messagesOut);
}

/**
 * Registrar error en el procesamiento de un mensaje del tenant.
 * @param {string} uid
 * @param {object} opts - { code?: string, module?: string }
 */
function recordError(uid, opts = {}) {
  if (!uid) return;
  const t = _ensure(uid);
  t.errors.push({ ts: Date.now(), code: opts.code || 'unknown', module: opts.module || 'unknown' });
  _pruneOld(t.errors);
}

/**
 * Registrar llamada AI del tenant.
 * @param {string} uid
 * @param {object} opts - { provider, latencyMs, success: bool }
 */
function recordAICall(uid, opts = {}) {
  if (!uid) return;
  const t = _ensure(uid);
  t.aiCalls.push({
    ts: Date.now(),
    provider: opts.provider || 'unknown',
    latencyMs: typeof opts.latencyMs === 'number' ? opts.latencyMs : 0,
    success: opts.success !== false,
  });
  _pruneOld(t.aiCalls);
}

// ═══════════════════════════════════════════════════════════════
// AGGREGATE APIs
// ═══════════════════════════════════════════════════════════════

function _percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Snapshot agregado de un tenant especifico.
 * @param {string} uid
 * @returns {object} stats
 */
function getTenantStats(uid) {
  if (!uid || !_state[uid]) {
    return {
      uid: uid || null,
      window_ms: WINDOW_MS,
      messages_in: 0,
      messages_out: 0,
      errors: 0,
      error_rate: '0%',
      ai_calls: 0,
      ai_success_rate: '100%',
      ai_avg_latency_ms: 0,
      out_p50_latency_ms: 0,
      out_p95_latency_ms: 0,
      contact_type_breakdown: {},
    };
  }
  const t = _state[uid];
  _pruneOld(t.messagesIn);
  _pruneOld(t.messagesOut);
  _pruneOld(t.errors);
  _pruneOld(t.aiCalls);

  const inCount = t.messagesIn.length;
  const outCount = t.messagesOut.length;
  const errCount = t.errors.length;
  const totalMsg = inCount + outCount;
  const errorRate = totalMsg > 0 ? Math.round((errCount / totalMsg) * 100) : 0;

  const aiCount = t.aiCalls.length;
  const aiSuccess = t.aiCalls.filter(c => c.success).length;
  const aiSuccessRate = aiCount > 0 ? Math.round((aiSuccess / aiCount) * 100) : 100;
  const aiAvgLatency = aiCount > 0
    ? Math.round(t.aiCalls.reduce((s, c) => s + c.latencyMs, 0) / aiCount)
    : 0;

  const outLatencies = t.messagesOut.map(m => m.latencyMs);
  const p50 = _percentile(outLatencies, 50);
  const p95 = _percentile(outLatencies, 95);

  const breakdown = {};
  for (const m of t.messagesIn) breakdown[m.contactType] = (breakdown[m.contactType] || 0) + 1;

  return {
    uid,
    window_ms: WINDOW_MS,
    messages_in: inCount,
    messages_out: outCount,
    errors: errCount,
    error_rate: `${errorRate}%`,
    ai_calls: aiCount,
    ai_success_rate: `${aiSuccessRate}%`,
    ai_avg_latency_ms: aiAvgLatency,
    out_p50_latency_ms: p50,
    out_p95_latency_ms: p95,
    contact_type_breakdown: breakdown,
  };
}

/**
 * Snapshot global de todos los tenants tracked.
 * @returns {{ tenants: object[], global: object }}
 */
function aggregateAll() {
  const uids = Object.keys(_state);
  const tenants = uids.map(uid => getTenantStats(uid));

  // Global rollup
  const totalIn = tenants.reduce((s, t) => s + t.messages_in, 0);
  const totalOut = tenants.reduce((s, t) => s + t.messages_out, 0);
  const totalErr = tenants.reduce((s, t) => s + t.errors, 0);
  const totalAI = tenants.reduce((s, t) => s + t.ai_calls, 0);
  const totalMsg = totalIn + totalOut;
  const globalErrorRate = totalMsg > 0 ? Math.round((totalErr / totalMsg) * 100) : 0;

  return {
    tenants,
    global: {
      tenant_count: uids.length,
      messages_in: totalIn,
      messages_out: totalOut,
      errors: totalErr,
      error_rate: `${globalErrorRate}%`,
      ai_calls: totalAI,
      window_ms: WINDOW_MS,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Resetear state (solo para tests).
 */
function _resetState() {
  for (const k of Object.keys(_state)) delete _state[k];
}

module.exports = {
  recordIncoming,
  recordOutgoing,
  recordError,
  recordAICall,
  getTenantStats,
  aggregateAll,
  WINDOW_MS,
  // Test-only
  _resetState,
};
