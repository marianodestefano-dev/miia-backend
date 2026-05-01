'use strict';

/**
 * MIIA - Response Optimizer (T216)
 * Metricas y utilidades para mantener P95 < 2s en respuestas MIIA.
 */

const P95_TARGET_MS = 2000;
const P99_TARGET_MS = 5000;
const WINDOW_SIZE = 1000;
const ALERT_THRESHOLD_P95 = 0.9;

const RESPONSE_BUCKETS = Object.freeze(['<500ms', '500-1s', '1-2s', '2-5s', '>5s']);

function classifyLatency(ms) {
  if (typeof ms !== 'number' || ms < 0) throw new Error('ms debe ser numero positivo');
  if (ms < 500) return '<500ms';
  if (ms < 1000) return '500-1s';
  if (ms < 2000) return '1-2s';
  if (ms < 5000) return '2-5s';
  return '>5s';
}

function calculatePercentile(sortedTimes, percentile) {
  if (!Array.isArray(sortedTimes) || sortedTimes.length === 0) return 0;
  if (percentile < 0 || percentile > 100) throw new Error('percentile debe ser 0-100');
  var idx = Math.min(Math.floor(sortedTimes.length * (percentile / 100)), sortedTimes.length - 1);
  return sortedTimes[idx];
}

function analyzeResponseTimes(times) {
  if (!Array.isArray(times)) throw new Error('times debe ser array');
  if (times.length === 0) return { p50: 0, p95: 0, p99: 0, mean: 0, max: 0, min: 0, count: 0, meetsTarget: true };
  var sorted = times.slice().sort(function(a, b) { return a - b; });
  var sum = sorted.reduce(function(acc, v) { return acc + v; }, 0);
  var p95 = calculatePercentile(sorted, 95);
  var p99 = calculatePercentile(sorted, 99);
  return {
    p50: calculatePercentile(sorted, 50),
    p95,
    p99,
    mean: Math.round(sum / sorted.length),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    count: sorted.length,
    meetsTarget: p95 <= P95_TARGET_MS,
  };
}

function generateLatencyReport(times) {
  if (!Array.isArray(times)) throw new Error('times debe ser array');
  var stats = analyzeResponseTimes(times);
  var buckets = {};
  RESPONSE_BUCKETS.forEach(function(b) { buckets[b] = 0; });
  times.forEach(function(ms) {
    var bucket = classifyLatency(ms);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });
  return {
    stats,
    buckets,
    percentages: Object.fromEntries(
      Object.entries(buckets).map(function([k, v]) {
        return [k, times.length > 0 ? Math.round(v / times.length * 100) : 0];
      })
    ),
    recommendation: stats.meetsTarget
      ? 'OK: P95 dentro del target (' + P95_TARGET_MS + 'ms)'
      : 'ALERTA: P95 ' + stats.p95 + 'ms supera target ' + P95_TARGET_MS + 'ms',
  };
}

function shouldThrottle(recentTimes, windowMs) {
  if (!Array.isArray(recentTimes)) throw new Error('recentTimes debe ser array');
  if (recentTimes.length === 0) return false;
  var stats = analyzeResponseTimes(recentTimes);
  return !stats.meetsTarget;
}

function estimateQueueDelay(pendingCount, avgProcessingMs) {
  if (typeof pendingCount !== 'number' || pendingCount < 0) throw new Error('pendingCount invalido');
  if (typeof avgProcessingMs !== 'number' || avgProcessingMs <= 0) throw new Error('avgProcessingMs invalido');
  var estimated = pendingCount * avgProcessingMs;
  return {
    estimatedMs: estimated,
    exceedsTarget: estimated > P95_TARGET_MS,
    recommendBatch: pendingCount > 10,
  };
}

module.exports = {
  classifyLatency,
  calculatePercentile,
  analyzeResponseTimes,
  generateLatencyReport,
  shouldThrottle,
  estimateQueueDelay,
  P95_TARGET_MS,
  P99_TARGET_MS,
  RESPONSE_BUCKETS,
  WINDOW_SIZE,
};
