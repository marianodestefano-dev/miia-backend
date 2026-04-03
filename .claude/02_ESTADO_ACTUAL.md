# ESTADO ACTUAL — Actualizar SIEMPRE al inicio y fin de cada sesión

**Última actualización**: Sesión 10, 2026-04-03
**Deploy**: ✅ DEPLOYADO — commit 8120687 en main Y main-test (Railway)

## Funciona HOY (en producción tras este deploy)
- [x] Self-chat, Familia, Equipo, Leads
- [x] Cotizaciones PDF (tag → PDF → WhatsApp)
- [x] Affinity 6 stages + Firestore persist
- [x] Google Search para owner + círculo cercano
- [x] Agenda via tag [AGENDAR_EVENTO]
- [x] Aprendizaje via tags [APRENDIZAJE_NEGOCIO/PERSONAL/DUDOSO]
- [x] Dark/Light mode (~85%)
- [x] Baileys session fortress v2.0 (7 capas + 6 técnicas preventivas)
- [x] Deduplicación de mensajes (TTL 10 min)
- [x] Smart recovery 4 niveles (30+ intentos antes de QR)
- [x] Watchdog conexión zombie + pre-emptive refresh cada 6h
- [x] Graceful shutdown SIGTERM
- [x] Prompt registry (módulos versionados + checkpoints + rollback)
- [x] Fix Receta AR ($3 × usuarios)

## Bugs pendientes (NO resueltos aún)
- [ ] **P4**: setTenantTrainingData — ya exportado en module.exports pero verificar que server.js lo usa
- [ ] **P3**: Endpoint `/api/tenant/:uid/documents/upload` no existe en backend
- [ ] **Prompt demasiado largo**: ~15k tokens, instrucciones del final se diluyen
- [ ] **España**: Generator no fuerza modalidad anual server-side
- [ ] **RD factura**: Prompt la agrupa mal con "sin factura"
- [ ] **Tokens IA por plan** (80/250/400): NO están en el prompt
- [ ] **Ficha estética por plan**: NO está en el prompt
- [ ] **Eventos deportivos**: Solo reactivo, no proactivo (Bloque G)

## Sesión 10 — Lo que se hizo
- Commit: `8120687`
- Deploy: main-test pusheado (Railway autodeploy). Antes tenía 13 commits de atraso.
- tenant_manager.js: Smart recovery, dedup, watchdog, pre-emptive refresh, graceful shutdown, telemetría, config estabilidad Baileys
- baileys_session_store.js v2.0: Identity/session separation, 7 capas protección
- prompt_registry.js: NUEVO — módulos Firestore + checkpoints + rollback + pricing auto-sync
- cotizacion_generator.js: Fix Receta AR ($3 × usuarios)
- server.js: 8 endpoints prompt registry
- .claude/: 6 sub-archivos para continuidad post-compactación
- CLAUDE.md: Reescrito como router (40 líneas)
- Análisis completo: cotización PDF vs prompt vs generator por país
- Diagnóstico MIIA desactualizada: Railway corría código de sesión 7, resuelto con merge

## Ramas
- `main` = `main-test` = commit `8120687` (idénticas)
- Railway autodeploya desde `main-test`

## Bloques pendientes
```
A (restante): A3 documents endpoint, A4 verificar setTenantTrainingData en server.js
D: Limpieza técnica P3-P7
E: Rediseño visual QA (dark/light inline colors)
F: Multi-negocio + grupos CRUD
G: Sistema Inteligencia Fase 1 (proactivo, cascada, aprendizaje)
H-K: Fases futuras
```
