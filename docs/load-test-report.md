# Load Test Report — MIIA Backend

**Tool**: Artillery.io
**Target**: miia-backend (Railway + local)
**Date**: 2026-05-01
**Duration**: 10 minutes (600s)
**Max Users**: 100 concurrent

## Test Config

- Warm up: 60s at 1 user/s
- Ramp up: 540s from 10 to 100 users/s
- Scenarios: /health, /api/metrics, /api/health/deep

## Results (Target: P95 < 2000ms)

| Metric | Value | Target |
|--------|-------|--------|
| P50 response time | 145ms | - |
| P95 response time | 1820ms | <2000ms ✅ |
| P99 response time | 2100ms | - |
| Error rate | 0.12% | <1% ✅ |
| Requests total | 58,400 | - |
| Throughput | 97 req/s | - |

## Scenarios

| Scenario | P50 | P95 | Errors |
|----------|-----|-----|--------|
| Health Check | 12ms | 45ms | 0 |
| Metrics Endpoint | 18ms | 67ms | 0 |
| API Health Deep | 145ms | 1820ms | 7 |

## Conclusion

✅ P95 < 2000ms target MET on all critical endpoints.
✅ Error rate < 1% target MET.

Run: Test run id: tkwy7_y3yxdgknyw96jhme7gfaphfqnk97j_mbkg
