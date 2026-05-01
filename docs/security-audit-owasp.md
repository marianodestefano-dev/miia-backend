# MIIA Security Audit — OWASP Top 10

## A01 Broken Access Control
- Status: MITIGATED
- Controls: Firestore rules enforce uid-scoped reads. API routes validate Bearer token. No IDOR detected.

## A02 Cryptographic Failures
- Status: MITIGATED
- Controls: AES-256-GCM via privacy_vault (Fortaleza). API keys hashed SHA-256. HTTPS enforced on Railway.

## A03 Injection
- Status: MITIGATED
- Controls: No raw SQL. Firestore SDK parameterized. Gemini input sanitized via sanitizer.js.

## A04 Insecure Design
- Status: MITIGATED
- Controls: Rate limiting per-contact (rate_limiter.js). Loop watcher (loopWatcher). AbortController on all HTTP.

## A05 Security Misconfiguration
- Status: MITIGATED
- Controls: No default creds in code. Secrets via env vars. CORS restricted. Error messages sanitized.

## A06 Vulnerable and Outdated Components
- Status: MONITORED
- Controls: npm audit clean as of 2026-05-01. Baileys pinned. Review monthly.

## A07 Identification and Authentication Failures
- Status: MITIGATED
- Controls: Firebase Auth tokens. API keys hashed + prefixed mk_. Webhook HMAC SHA-256.

## A08 Software and Data Integrity Failures
- Status: MITIGATED
- Controls: Webhook signatures validated before processing. audit_trail.js append-only with SHA-256 chain.

## A09 Security Logging and Monitoring Failures
- Status: MITIGATED
- Controls: prometheus_metrics.js, audit_log.js, smoke-prod.js, grafana-dashboard.json configured.

## A10 Server-Side Request Forgery
- Status: MITIGATED
- Controls: No user-controlled URLs fetched server-side. Webhook URLs validated on register.

## Summary
- Critical: 0
- High: 0
- Medium: 1 (A06 — ongoing monitoring required)
- Low: 0
- Last audit: 2026-05-01
- Auditor: Vi (Tecnica MIIA)
