# MIIA Monitoring Alerts Configuration

## Alert Rules (Grafana / UptimeRobot)

| Alert | Condition | Severity | Channel |
|-------|-----------|----------|---------|
| P95 Latency High | p95_ms > 2000 for 5min | WARNING | wi.gg@miia-app.com |
| P95 Latency Critical | p95_ms > 5000 for 2min | CRITICAL | hola@miia-app.com + SMS |
| Error Rate High | error_rate > 1% for 3min | WARNING | wi.gg@miia-app.com |
| Error Rate Critical | error_rate > 5% for 1min | CRITICAL | hola@miia-app.com + SMS |
| Service Down | /health 3 consecutive fails | CRITICAL | hola@miia-app.com + SMS |
| Baileys Disconnect | WA session lost | HIGH | wi.gg@miia-app.com |
| Memory Usage | RSS > 1.5GB | WARNING | wi.gg@miia-app.com |

## Runbook

### P95 Latency High
1. Check Gemini API status page
2. Check Railway metrics for CPU/Memory spike
3. If Gemini: wait + auto-retry in AbortController
4. If Railway: scale up service

### Baileys Disconnect
1. Check Railway logs for QR code regeneration
2. Scan QR from Railway logs via Mariano phone
3. Session auto-restores from creds in Firestore

## UptimeRobot Check
- URL: https://miia-backend.railway.app/health
- Interval: 60 seconds
- Alert contacts: wi.gg@miia-app.com, hola@miia-app.com
