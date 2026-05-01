# MIIA Dependency Audit

## Production Dependencies

| Package | Version | Vulnerabilities | Notes |
|---------|---------|----------------|-------|
| @baileys/baileys | pinned | 0 | WhatsApp session — monitor |
| @google-cloud/firestore | ^7.x | 0 | Stable |
| express | ^4.18 | 0 | |
| stripe | ^14.x | 0 | |
| nodemailer | ^6.x | 0 | |
| axios | ^1.x | 0 | AbortController used on all calls |

## Audit Command
```bash
npm audit --audit-level=high
```

## Result: 2026-05-01
- High: 0
- Critical: 0
- Moderate: 0 (after overrides for test deps)

## Policy
- Run npm audit on every PR merge.
- High/Critical: block deploy.
- Moderate: fix within 30 days.
- Baileys: pin and monitor manually (no npm audit support for git deps).
