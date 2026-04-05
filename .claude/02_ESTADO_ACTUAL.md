# ESTADO ACTUAL — Actualizar SIEMPRE al inicio y fin de cada sesión

**Última actualización**: Sesión 11, 2026-04-05
**Deploy**: ✅ DEPLOYADO — commit d2c120f en main Y main-test (Railway)

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
- [x] Gemini dual API key rotation (429 fallback)
- [x] Inter-MIIA coordination (detectInterMiiaCommand, sendInterMiia, processIncomingInterMiia)
- [x] Email desde WhatsApp ("mandále un mail a X diciendo Y")
- [x] Backend reorganizado en 2 capas (core/, ai/, services/, whatsapp/, data/, voice/)

## Bugs resueltos sesión 11
- [x] `body is not defined` → `userMessage` (2 commits)
- [x] `message is not defined` → disabled with `if (false)` (audio child detection)
- [x] `mediaContext is not defined` → `incomingWasAudio = false`
- [x] `tenantState is not defined` → `userProfile` (3 ocurrencias: email cmd, inter-MIIA)

## Auditoría processMiiaResponse (líneas 1534-3034)
- Escaneadas TODAS las variables usadas en la función
- Todas confirmadas: globals, requires, o function-scoped
- No quedan ReferenceError potenciales

## Bugs pendientes (NO resueltos aún)
- [ ] **P4**: setTenantTrainingData — ya exportado en module.exports pero verificar que server.js lo usa
- [ ] **P3**: Endpoint `/api/tenant/:uid/documents/upload` no existe en backend
- [ ] **Prompt demasiado largo**: ~15k tokens, instrucciones del final se diluyen
- [ ] **España**: Generator no fuerza modalidad anual server-side
- [ ] **RD factura**: Prompt la agrupa mal con "sin factura"
- [ ] **Tokens IA por plan** (80/250/400): NO están en el prompt
- [ ] **Ficha estética por plan**: NO está en el prompt
- [ ] **Eventos deportivos**: Solo reactivo, no proactivo (Bloque G)

## Sesión 11 — Lo que se hizo
- Commits: `b97ff14`, `3ae3ea7`, `9feb8d5`, `d2c120f`
- Fix: 4 ReferenceError bugs en processMiiaResponse (body, message, mediaContext, tenantState)
- Auditoría completa de processMiiaResponse (1500 líneas) — 0 variables sin declarar
- Backend reorganizado: ~50 require() actualizados a nueva estructura de carpetas
- Inter-MIIA: nuevo módulo `core/inter_miia.js`
- Email desde WA: `services/mail_service.js` + `sendGenericEmail()`
- Gemini 429 fix: rotación de API keys con fallback automático
- Frontend: Hero carousel con 5 slides (cotización, agenda, deporte, inter-MIIA, voz)

## Ramas
- `main` = `main-test` = commit `d2c120f` (idénticas)
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
