'use strict';

const tm = require('./tenant_metrics');

let _requestsTotal = 0;
let _errorsTotal = 0;
const _responseTimes = [];
const _MAX_SAMPLES = 10000;

function recordRequest(durationMs, statusCode) {
  _requestsTotal += 1;
  if (statusCode >= 400) _errorsTotal += 1;
  _responseTimes.push(durationMs);
  if (_responseTimes.length > _MAX_SAMPLES) _responseTimes.shift();
}

function _percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function getMetrics() {
  const sorted = [..._responseTimes].sort((a, b) => a - b);
  const p50 = _percentile(sorted, 50);
  const p95 = _percentile(sorted, 95);
  const p99 = _percentile(sorted, 99);
  const errorRate = _requestsTotal > 0 ? (_errorsTotal / _requestsTotal) : 0;
  return { requests_total: _requestsTotal, errors_total: _errorsTotal, error_rate: errorRate, p50_ms: p50, p95_ms: p95, p99_ms: p99, sample_count: sorted.length };
}

function formatPrometheus() {
  const m = getMetrics();
  const lines = [
    "# HELP miia_requests_total Total HTTP requests",
    "# TYPE miia_requests_total counter",
    "miia_requests_total " + m.requests_total,
    "# HELP miia_errors_total Total HTTP errors",
    "# TYPE miia_errors_total counter",
    "miia_errors_total " + m.errors_total,
    "# HELP miia_error_rate Error rate (0-1)",
    "# TYPE miia_error_rate gauge",
    "miia_error_rate " + m.error_rate.toFixed(4),
    "# HELP miia_response_time_ms Response time percentiles in ms",
    "# TYPE miia_response_time_ms summary",
    'miia_response_time_ms{quantile="0.5"} ' + m.p50_ms,
    'miia_response_time_ms{quantile="0.95"} ' + m.p95_ms,
    'miia_response_time_ms{quantile="0.99"} ' + m.p99_ms,
    "miia_response_time_ms_count " + m.sample_count,
  ];
  return lines.join(String.fromCharCode(10));
}

function reset() {
  _requestsTotal = 0; _errorsTotal = 0; _responseTimes.length = 0;
}

module.exports = { recordRequest, getMetrics, formatPrometheus, reset };
