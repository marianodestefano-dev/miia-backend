# MIIA Blue-Green Deploy on Railway

## Strategy
Railway supports instant deploy + rollback. MIIA uses a simplified blue-green via Railway service duplication.

## Process
1. **Green** = current production service (active, receiving traffic)
2. **Blue** = new version deployed to staging service URL
3. Smoke test blue: `node scripts/smoke-prod.js BLUE_URL`
4. If smoke passes: Railway "promote" blue → production URL swap
5. Green stays running for 15 min as hot standby
6. If production error rate > 1% in 15 min: rollback (Railway one-click)

## Rollback
- Railway: Deployments tab → previous deploy → "Rollback"
- Target: < 2 min to rollback

## Smoke Test Endpoints
- GET /health → 200
- GET /metrics → 200 + Prometheus format
- POST /api/test-ping → 200

## SLA During Deploy
- Max downtime: 0 seconds (Railway hot swap)
- Max error spike window: 30 seconds during connection drain
