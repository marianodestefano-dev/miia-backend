"use strict";

const THRESHOLDS = Object.freeze({
  p50_ms: 500,
  p95_ms: 2000,
  p99_ms: 5000,
  error_rate: 0.01,
  req_per_min_min: 10,
});

const _history = [];

function recordSnapshot(metrics) {
  if (!metrics) throw new Error("metrics required");
  const snap = { ...metrics, recordedAt: Date.now() };
  _history.push(snap);
  if (_history.length > 1000) _history.shift();
  return snap;
}

function detectRegressions(current, baseline) {
  if (!current || !baseline) throw new Error("current and baseline required");
  const regressions = [];
  if (current.p50_ms > baseline.p50_ms * 1.2) {
    regressions.push({ metric: "p50_ms", current: current.p50_ms, baseline: baseline.p50_ms, delta_pct: ((current.p50_ms - baseline.p50_ms) / baseline.p50_ms * 100).toFixed(1) });
  }
  if (current.p95_ms > baseline.p95_ms * 1.2) {
    regressions.push({ metric: "p95_ms", current: current.p95_ms, baseline: baseline.p95_ms, delta_pct: ((current.p95_ms - baseline.p95_ms) / baseline.p95_ms * 100).toFixed(1) });
  }
  if (current.error_rate > baseline.error_rate * 2 && current.error_rate > 0.005) {
    regressions.push({ metric: "error_rate", current: current.error_rate, baseline: baseline.error_rate });
  }
  return { hasRegressions: regressions.length > 0, regressions };
}

function checkThresholds(metrics) {
  if (!metrics) throw new Error("metrics required");
  const violations = [];
  if (metrics.p95_ms > THRESHOLDS.p95_ms) violations.push({ metric: "p95_ms", value: metrics.p95_ms, threshold: THRESHOLDS.p95_ms });
  if (metrics.error_rate > THRESHOLDS.error_rate) violations.push({ metric: "error_rate", value: metrics.error_rate, threshold: THRESHOLDS.error_rate });
  return { passing: violations.length === 0, violations };
}

function getHistory() { return _history.slice(); }

function reset() { _history.length = 0; }

module.exports = { recordSnapshot, detectRegressions, checkThresholds, getHistory, reset, THRESHOLDS };
