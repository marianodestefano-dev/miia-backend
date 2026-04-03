# HISTORIAL DE SESIONES — Solo hechos clave

## Sesión 10 (2026-04-03) — Fortress + Registry + Cotización fix
- tenant_manager.js: Smart recovery 4 niveles, dedup mensajes, monitor unificado
- prompt_registry.js: NUEVO módulo — versionado Firestore + checkpoints + rollback
- server.js: 8 endpoints REST para prompt registry
- cotizacion_generator.js: Fix receta AR ($3 × usuarios)
- index.html: Rediseño Apple/Mac (sesión anterior, no committeado)
- .claude/: Reestructuración sub-archivos para continuidad
- NO DEPLOYADO

## Sesión 9 (2026-04-03) — Affinity + Planes
- Sistema AFFINITY completo (6f4bf62): 6 stages, dual tones, identity, hartazgo
- Persistencia affinity Firestore (98f414c)
- Planes bloques B, C, D, E
- baileys_session_store.js v2.0 escrito (no committeado)
- Commits: 6f4bf62, 98f414c, 41d3354, 5c3e74f, 4c6e464, b44e684, a832db7

## Sesión 8 (2026-04-02) — PDF self-chat fix
- Bug: PDF nunca llegaba a self-chat (heurística rota + device ID vs phone)
- Fix: Eliminar heurística, delegar a safeSendMessage
- Commits: ad1562b, d70649a

## Sesión 7 (2026-04-01) — Railway branch fix
- Railway corría commit viejo. Creada rama main-test
- Commits en main-test: b893376

## Sesiones 1-6 — Pre-historial
Ver RESUMEN_EJECUTIVO_MIIA.md para detalle completo
