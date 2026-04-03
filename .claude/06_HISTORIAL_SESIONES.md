# HISTORIAL DE SESIONES — Solo hechos clave

## Sesión 10 (2026-04-03) — Fortress + Registry + Deploy total
- **Commit**: `8120687`
- **Deploy**: ✅ main-test pusheado. Railway tenía 13 commits de atraso (corregido).
- tenant_manager.js: Smart recovery 4 niveles, dedup mensajes, watchdog zombie, pre-emptive refresh 6h, graceful shutdown SIGTERM, config estabilidad (keepAlive/connectTimeout/emitOwnEvents/getMessage), telemetría, getConnectionMetrics()
- baileys_session_store.js v2.0: Identity/session separation, 7 capas protección
- prompt_registry.js: NUEVO — módulos Firestore, checkpoints, rollback, assemble, generatePricingFromSource (read-only), validateFreshness, analyzePromptSize
- cotizacion_generator.js: Fix Receta AR ($3 × usuarios, antes $3 fijo)
- server.js: 8 endpoints REST prompt registry
- .claude/: 6 sub-archivos para continuidad + CLAUDE.md como router
- Análisis: cotización PDF vs prompt (7 discrepancias encontradas)
- Diagnóstico: MIIA producción desactualizada por rama main-test atrasada

## Sesión 9 (2026-04-03) — Affinity + Planes
- Sistema AFFINITY completo (6f4bf62): 6 stages, dual tones, identity, hartazgo
- Persistencia affinity Firestore (98f414c)
- Planes bloques B, C, D, E
- Commits: 6f4bf62, 98f414c, 41d3354, 5c3e74f, 4c6e464, b44e684, a832db7

## Sesión 8 (2026-04-02) — PDF self-chat fix
- Bug: PDF nunca llegaba a self-chat (heurística rota + device ID vs phone)
- Fix: Eliminar heurística, delegar a safeSendMessage
- Commits: ad1562b, d70649a

## Sesión 7 (2026-04-01) — Railway branch fix
- Railway corría commit viejo. Creada rama main-test
- Commits en main-test: b893376

## Sesiones 1-6
Ver RESUMEN_EJECUTIVO_MIIA.md para detalle completo
