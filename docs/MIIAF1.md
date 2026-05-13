# MIIAF1 — Documentación

**Documento canónico**: ver [`sports/f1_dashboard/README.md`](../sports/f1_dashboard/README.md).

Este archivo es un pointer breve. Toda la arquitectura, env vars,
endpoints, comandos WhatsApp, troubleshooting y deploy checklist viven
en el README del módulo F1.

## Quick links

- **Arquitectura**: README sección "Arquitectura"
- **Env vars requeridas** (Railway): README sección "Env vars requeridas (Railway prod)"
- **Deploy checklist B.4**: README sección "Deploy checklist Railway B.4"
- **Endpoints API**: README sección "Endpoints API"
- **Comandos WhatsApp**: README sección "Comandos WhatsApp (F1.23 + F1.26)"
- **Troubleshooting**: README sección "Troubleshooting"
- **Tests + cobertura**: README sección "Tests + cobertura"

## Origen + firmas

- **Spec**: `.claude/IDEAS_PENDIENTES.md` IDEA #052 (firmada Mariano 2026-04-24).
- **Arranque**: firma viva Mariano 2026-05-01 "EMPIEZA A HACERLO!!!".
- **Audit Q2 MVP TEC**: `JUEGA-MIIA/.juega_miia/operativo/MEMO_AUDIT_MIIAF1.md` (2026-05-12).
- **B.3 F1.30 pago real**: firma Mariano "haz BLOQUE B - MIIAF1 completo"
  2026-05-12 + [RESPUESTA-VI-MIIAF1] 20:15 COT — commit `f1f754c`.
- **B.4 deploy Railway**: pendiente Mariano ejecutar con secrets
  (Vi confirmó Q6 que TEC no tiene CLI).
- **B.6 cov sweep**: branch 100% global F1 verificado pre-B.3, post-B.3
  sigue 100%. Único gap menor: `f1_service.js` server lifecycle handlers
  (SIGTERM/SIGINT) — cubrir con `/* istanbul ignore */` en B.6 cierre.
