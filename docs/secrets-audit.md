# MIIA Secrets Audit

## Secret Inventory

| Secret | Storage | Rotation | Last Rotated |
|--------|---------|----------|-------------|
| GEMINI_API_KEY | Railway env | 90d | 2026-04-01 |
| ELEVENLABS_API_KEY | Railway env | 90d | 2026-04-01 |
| FIREBASE_SERVICE_ACCOUNT | Railway env (JSON) | Annual | 2026-01-01 |
| STRIPE_SECRET_KEY | Railway env | 90d | 2026-04-01 |
| WEBHOOK_SECRET | Railway env | 90d | 2026-04-01 |

## Rules
- R-H3: Secrets NEVER in scripts, commands, or inline env vars. Read from file at runtime.
- No secrets in git history (verified: git log --all -S "sk-" returns empty).
- No secrets in logs (sanitizer.js PII redaction active).

## Audit Result
- All secrets externalized to Railway env vars.
- No hardcoded secrets found in codebase.
- Git history clean.
- Next rotation due: 2026-07-01.
