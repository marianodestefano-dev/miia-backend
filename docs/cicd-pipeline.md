# MIIA CI/CD Pipeline

## Current Pipeline (Railway Auto-Deploy)

```
git push origin main
    ↓
Railway detects push → builds Docker image
    ↓
npm install → node server.js health check
    ↓
Deploy (zero-downtime swap)
    ↓
smoke-prod.js validates 10 endpoints
    ↓
Alert on failure → rollback available
```

## Pre-Push Checklist (automated via git hook)
1. `npx jest --no-coverage` — all tests must pass
2. `node scripts/smoke-prod.js` — smoke against staging
3. `npm audit --audit-level=high` — zero high/critical

## Branch Strategy
- `main` — production. Auto-deploy on push.
- `feature/fortaleza` — Fortaleza branch (isolated, §2-ter CLAUDE.md). NO auto-deploy.
- Feature branches — NO auto-deploy. Merge to main via PR.

## Rollback
- Railway: one-click rollback to any prior deploy
- Target RTO: < 2 minutes

## Future: GitHub Actions
- Add `.github/workflows/test.yml` to run jest on PR
- Block merge if tests fail
- Add dependency-review action
