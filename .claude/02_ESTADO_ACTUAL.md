# ESTADO ACTUAL — Actualizar SIEMPRE al inicio y fin de cada sesión

**Última actualización**: Sesión 10, 2026-04-03

## Funciona HOY
- [x] Self-chat, Familia, Equipo, Leads
- [x] Cotizaciones PDF (tag → PDF → WhatsApp)
- [x] Affinity 6 stages + Firestore persist
- [x] Google Search para owner + círculo cercano
- [x] Agenda via tag [AGENDAR_EVENTO]
- [x] Aprendizaje via tags [APRENDIZAJE_NEGOCIO/PERSONAL/DUDOSO]
- [x] Dark/Light mode (~85%)
- [x] Baileys session fortress v2.0

## Bugs conocidos
- [ ] **Receta AR**: Corregido localmente — era $3 fijo, ahora $3 × usuarios
- [ ] **P4**: setTenantTrainingData no exportado → training no persiste en reconexión
- [ ] **P3**: Endpoint `/api/tenant/:uid/documents/upload` no existe en backend
- [ ] **Prompt demasiado largo**: ~15k tokens, instrucciones del final se diluyen
- [ ] **Precios prompt vs generator**: Resuelto con generatePricingFromSource() (read-only)
- [ ] **España**: Generator no fuerza modalidad anual server-side
- [ ] **RD factura**: Prompt la agrupa mal con "sin factura"
- [ ] **Tokens IA por plan** (80/250/400): NO están en el prompt
- [ ] **Ficha estética por plan**: NO está en el prompt
- [ ] **Eventos deportivos**: Solo reactivo, no proactivo (Bloque G)

## Sesión 10 — Cambios locales (NO deployados)
### Baileys (tenant_manager.js)
- Smart recovery 4 niveles (30+ intentos antes de QR)
- Deduplicación de mensajes (isDuplicate, TTL 10 min)
- Monitor unificado de errores crypto (handleCryptoError)
- Bloqueo de creds durante errores (blockCredsWrites)
- Watchdog de conexión zombie (cada 5 min)
- Pre-emptive session key refresh (cada 6h)
- Configuración agresiva estabilidad (keepAlive 25s, connectTimeout 60s, emitOwnEvents false, getMessage)
- Graceful shutdown SIGTERM/SIGINT (sock.end, no logout)
- Telemetría de conexión
- getConnectionMetrics() exportado

### Prompts (prompt_registry.js — NUEVO)
- Módulos versionados en Firestore + historial
- Checkpoints (snapshots nombrados)
- Rollback (restaura todos los módulos a un checkpoint)
- Assemble (combina módulos + interpolación variables + log)
- generatePricingFromSource() — READ-ONLY desde cotizacion_generator
- validateFreshness() — verifica que prompt no esté stale
- analyzePromptSize() — warning si >8000 tokens
- Diff entre estado actual y checkpoint

### Cotización (cotizacion_generator.js)
- Fix Receta AR: $3 × usuarios (antes era $3 fijo)
- Fix HTML PDF: muestra precio calculado en vez de hardcoded $3

### Server.js
- 8 endpoints REST para prompt registry

### Estructura de continuidad (.claude/)
- 01_IDENTIDAD.md — stack, credenciales, archivos críticos
- 02_ESTADO_ACTUAL.md — este archivo
- 03_REGLAS_MARIANO.md — comportamiento obligatorio
- 04_COTIZACIONES.md — sistema precios, reglas por país
- 05_BAILEYS_FORTRESS.md — protección de sesión
- 06_HISTORIAL_SESIONES.md — resumen por sesión
- CLAUDE.md reescrito como router a sub-archivos

## Bloques pendientes (orden de prioridad)
```
A (restante): A2 auto-reconnect, A3 documents endpoint, A4 export setTenantTrainingData
B: MIIA como contacto propio WhatsApp
C: Audio inteligente
D: Limpieza técnica P3-P7
E: Rediseño visual QA
F: Multi-negocio + grupos CRUD
G: Sistema Inteligencia Fase 1 (proactivo, cascada, aprendizaje)
H: Sistema Inteligencia Fase 2 (motor patrones, ADN vendedor)
I: Reportes email quincenal
J: Features independientes (P8-P11, config IA)
K: Fase futura (voz MIIA, mini app, verticales)
```
