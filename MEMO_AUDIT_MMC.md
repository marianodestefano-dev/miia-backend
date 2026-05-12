# MEMO AUDIT MMC v0.3 — Spec 13 vs Implementación actual

**Fecha:** 2026-05-12
**Autor:** Vi (Tecnico MIIA)
**Trigger:** mail Wi → Vi `[VI] TAREA REAL — MMC v0.3 audit + completar segun spec 13 + P1.2 Privacy Report`
**Spec de referencia:** `.claude/specs/13_MMC_DISEÑO_1_MIIA_OWNER.md` v0.3 aprobado Mariano 2026-04-19
**Spec wrapper:** `.claude/specs/15_PISO_1_MMC_EPISODICA_PRIVACY_REPORT.md`

---

## 0. Hallazgos transversales críticos (DECISIÓN PREVIA REQUERIDA)

Antes de implementar gaps, hay 3 inconsistencias estructurales que necesitan firma Mariano:

### 0.A — Path inconsistente: `users/{uid}/` vs `owners/{uid}/`

| Archivo | Path actual | Spec 13 dice |
|---|---|---|
| `core/mmc/episodes.js` | `users/{uid}/miia_memory/{episodeId}` | `users/{uid}/miia_memory/{episodeId}` ✓ |
| `core/mmc/episode_distiller.js` | `users/{uid}/miia_memory/{episodeId}` | ✓ |
| `core/mmc_engine.js` | `owners/{uid}/miia_memory/{episodeId}` | ✗ inconsistente |
| `core/mmc_engine.js` | `owners/{uid}/miia_persistent/training_data` | spec dice `users/{uid}/brain/memory_graduated` ✗ |
| `core/mmc_retrieval.js` (legacy T99) | `users/{uid}/mmc/{phone}/entries` | path no spec'd ✗ |

**Riesgo:** dos sistemas paralelos escribiendo episodios en paths distintos. Si MIIA dispara `mmc_engine.captureEpisode()` por un lado y `core/mmc/episodes.createEpisode()` por otro, se duplican episodios en colecciones distintas.

**Propuesta:** unificar todo en `users/{uid}/miia_memory/{episodeId}` (path del spec). Migrar `core/mmc_engine.js` para escribir ahí. Considerar deprecation de `core/mmc_retrieval.js` legacy.

### 0.B — Doble implementación NIGHTLY-BRAIN

Hay 2 implementaciones del runner nocturno:

- `core/mmc_engine.distillNightly()` — Gemini call inline, esquema legacy (resumen_corto, importancia 1-5, graduado true/false, 4 condiciones distintas del spec).
- `core/mmc/episode_distiller.runNightlyDistillation()` — Gemini via cliente inyectable, lock atómico C-450, schema actual (`status='distilled'`, `topic`, `summary`).

**Pregunta:** ¿cuál es la "oficial"? Las 4 condiciones de graduación del spec (`>=90d`, `citationCount>=3`, sin MISS sostenido, sin opuesta) NO están en NINGUNA de las dos. La que sí existe (`distillNightly` legacy) usa 4 condiciones inventadas (importancia>=3, isFamilyOrTeam, hasFutureDate, hasRememberThis).

### 0.C — Schema episodio: 9 campos vs 27 campos

`core/mmc/episodes.js` define 9 campos. Spec 13 v0.3 define 27 campos (lecciones[], idiomaDetectado, tonadaDetectada, cadencia completa, embeddings, telemetría, ciclo de vida con expiresAt/contradicted/graduatedAt, derecho al olvido con deletedByOwnerAt/deletionReason).

**Esto NO es un gap menor.** Implementar el schema completo requiere migración de docs existentes.

---

## 1. Tabla de auditoría — Spec 13 v0.3 vs Implementación

Leyenda: ✅ = OK | 🟡 = parcial / con gaps | ❌ = no implementado | 🚩 = path/schema inconsistente con spec

| # | Componente spec 13 | Implementado SI/NO | Archivo(s) | Tests | Branch cov | Gaps específicos |
|---|---|---|---|---|---|---|
| **CAPA 1** | | | | | | |
| 1.1 | `conversations[phone]` array `.slice(-20)` (ya existe pre-MMC) | ✅ | `whatsapp/tenant_message_handler.js` | n/a (legacy) | n/a | OK — no necesita cambio |
| 1.2 | Tag `episodeId` en metadata del 1er y último mensaje de cada episodio | ❌ | — | — | — | No se setea `metadata.episodeId` en mensajes. `core/mmc/episode_detector.js` decide episodios pero NO escribe el tag en el mensaje original. |
| 1.3 | Snapshot diario `users/{uid}/miia_snapshots/{YYYY-MM-DD}` con `conversations[phone]` COMPLETO + TTL 48h | 🟡 🚩 | `core/mmc_engine.js` (`mmc_snapshots`) | `mmc_engine.test.js` (counters only) | parcial | El doc snapshot solo guarda counters `{procesados, graduados}`. Falta guardar `conversations[phone]` completo. Falta limpieza TTL 48h. Path es `owners/{uid}/mmc_snapshots/{fecha}` (debería ser `users/{uid}/miia_snapshots/{YYYY-MM-DD}`). |
| **CAPA 2** | | | | | | |
| 2.1 | Doc `users/{uid}/miia_memory/{episodeId}` con schema completo v0.3 (27 campos) | 🟡 🚩 | `core/mmc/episodes.js` (9 campos) + `core/mmc_engine.js` (15 campos, path diferente) | `mmc_episodes_schema.test.js`, `mmc_engine.test.js` | parcial | Faltan: `tono`, `lecciones[]`, `idiomaDetectado`, `tonadaDetectada`, `expectativa`, `desvioTension`, `resolucion`, `sensacion{}`, `tipo`, `cadenceConfidence`, `vector`, `embeddingModel`, `lastRetrievedAt`, `retrievalCount`, `lastInjectedAt`, `injectionCount`, `expiresAt`, `contradicted`, `graduatedAt`, `deletedByOwnerAt`, `deletionReason`. |
| 2.2 | Schema `Lesson{}` (id, text, confidence, source, createdAt, lastCitedAt, citationCount, citationEpisodes[], contradicted, deletedByOwnerAt) | ❌ | — | — | — | Inexistente. |
| 2.3 | Regla de vida: `contradicted=true → expiresAt = now+30d` | ❌ | — | — | — | No hay detector de contradicciones. |
| 2.4 | Regla de vida: `expiresAt < now && graduatedAt==null → hard delete batch nocturno` | 🟡 | `core/mmc_engine.processHardDeletes()` | `mmc_engine.test.js` | parcial | Hard delete existe pero usa `hardDeleteAt` (custom) en vez de `expiresAt`. No considera `graduatedAt==null`. |
| 2.5 | `deletedByOwnerAt != null → hard delete batch nocturno` | 🟡 | `core/mmc_engine.requestForgetting()` + `processHardDeletes()` | `mmc_engine.test.js` | parcial | Usa `deleted=true` + `hardDeleteAt`. Falta campo `deletedByOwnerAt` y `deletionReason`. |
| 2.6 | Episodio con `lecciones: []` se crea igual + cleanup 30d (GAP-2 Vi) | ❌ | — | — | — | No existe el campo lecciones, no aplica cleanup específico. |
| **CAPA 3** | | | | | | |
| 3.1 | Chunk `users/{uid}/brain/memory_graduated` con formato `[MEMORIA-GRADUADA] {text} (aprendido: {createdAt.ISO}, episodios: {N})` | 🟡 🚩 | `core/mmc_engine._appendMemoryGraduatedChunk` (path `owners/{uid}/miia_persistent/training_data.memory_chunks`) | `mmc_engine.test.js` | parcial | Path incorrecto. Formato del chunk diferente (guarda `{type, content, keywords, fecha, phone_hash}`). Falta separación owner manual vs auto. |
| **Baseline personal** | | | | | | |
| 4.1 | Doc `users/{uid}/miia_baseline/personal` con 16 campos (incl. `idiomaBase`, `tonadaRegional`, `tonadaConfidence`, `adaptacionActiva`) | ❌ | — | — | — | Inexistente. Todo el módulo baseline falta. |
| 4.2 | `bootstrapComplete` flag (true si 14d O `mensajesAnalizados>=50`) | 🟡 🚩 | `core/mmc_engine.bootstrapMMC()` flag `bootstrapped` en `mmc_config` | `mmc_engine.test.js` | parcial | Path `owners/{uid}/mmc_config/config` ≠ `users/{uid}/miia_baseline/personal`. Solo flag binario, no `mensajesAnalizados`. |
| 4.3 | `palabrasConfianza` híbrida (semilla manual MIIA CENTER + detección automática post-bootstrap) | ❌ | — | — | — | Inexistente. |
| 4.4 | Idioma + tonada regional (v0.3 directiva Mariano) | ❌ | — | — | — | Inexistente. |
| **Validación pasiva** | | | | | | |
| 5.1 | 4 estados (HIT/REFUERZO/MISS/SILENCIO) con pesos +1/+2/-1/0 | ❌ | — | — | — | Inexistente. |
| 5.2 | Regex REFUERZO unificado multi-dialecto ES | ❌ | — | — | — | Inexistente. |
| 5.3 | Regex MISS unificado multi-dialecto ES | ❌ | — | — | — | Inexistente. |
| 5.4 | Log por inyección `users/{uid}/miia_memory/{episodeId}/injections/{injectionId}` | ❌ | — | — | — | Inexistente. |
| 5.5 | Ajuste automático umbral coseno (batch mensual, piso 0.75 / techo 0.92 / default 0.82) | ❌ | — | — | — | Inexistente. |
| **Inyección mod_memory** | | | | | | |
| 6.1 | Guard `chatType in [selfchat, self, family, equipo]` | 🟡 | `core/mmc_engine.MEMORY_ELIGIBLE_CHAT_TYPES` = `{owner_selfchat, family, friend_argentino, friend_colombiano, ale_pareja, medilink_team}` | `mmc_engine.test.js` | OK | Set distinto al spec (incluye friend_* y ale_pareja). Pero coherente con doctrina §2-bis ETAPA 2 (subregistros Personal). Decisión: respetar el set actual o reducir al spec? |
| 6.2 | Guard `!baseline.bootstrapComplete → return ''` | 🟡 | `core/mmc_engine.buildMemoryContext()` no consulta baseline | — | — | El guard no existe. Falta integrar con baseline. |
| 6.3 | Embedding del mensaje actual + cosineSimilarity contra `episode.vector` | ❌ | — | — | — | Inexistente. `getRelevantMemories` usa match de keywords textual. |
| 6.4 | Cooldown 72h por Lesson (`lastCitedAt`) | ❌ | — | — | — | Inexistente. |
| 6.5 | Top 3 lessons por similaridad | 🟡 | `mmc_engine.getRelevantMemories` retorna top 3 episodios | OK | OK | Devuelve episodios completos, no `Lesson{}`. |
| 6.6 | Update telemetría `lastInjectedAt`, `injectionCount` + log pending | ❌ | — | — | — | Inexistente. |
| 6.7 | Formato `📝 Recordás: {text} ({fecha corta})` con header `## CADENCIAS PREVIAS` | 🟡 | `mmc_engine.buildMemoryContext` formato `[MEMORIA EPISODICA — NO COMPARTIR] N. [fecha] resumen` | OK | OK | Formato no coincide con spec. |
| **Inyección mod_tonada** (nuevo v0.3) | | | | | | |
| 7.1 | Módulo `mod_tonada()` que lee baseline + emite directiva si `adaptacionActiva` | ❌ | — | — | — | Inexistente. |
| 7.2 | Directivas argentina/colombia/mexico/neutro | ❌ | — | — | — | Inexistente. |
| 7.3 | Header `## TONADA` en prompt | ❌ | — | — | — | Inexistente. |
| **NIGHTLY-BRAIN extendido (7 fases)** | | | | | | |
| 8.1 | FASE 0 — Snapshot diario completo | 🟡 | `mmc_engine.distillNightly` guarda solo counters | — | parcial | Falta guardar `conversations[phone]` completo + TTL 48h. |
| 8.2 | FASE 1 — Segmentación en episodios (clusters <30min gap, máx 2h duración) | 🟡 | `core/mmc/episode_detector.js` usa `idleThresholdMs=30min` para detectar | `mmc_episode_detector.test.js` | OK | Existe detector pero no opera sobre snapshot. Opera on-line por mensaje. No respeta cap "máx 2h duración". |
| 8.3 | FASE 2 — Destilación por episodio (resumen, tono, idiomaDetectado, tonadaDetectada, lecciones[], tags, cadencia si bootstrap, embedding) | 🟡 | `core/mmc/episode_distiller.distillEpisode` retorna `{topic, summary}` solamente | `mmc_episode_distiller.test.js` | OK | Solo extrae topic + summary. Falta: tono, idiomaDetectado, tonadaDetectada, lecciones[], tags, cadencia, embedding. |
| 8.4 | FASE 3 — Detección de contradicciones | ❌ | — | — | — | Inexistente. |
| 8.5 | FASE 4 — Graduación a `memory_graduated` con 4 condiciones del spec | ❌ | `mmc_engine.distillNightly` usa 4 condiciones distintas (importancia/family/futureDate/rememberThis) | `mmc_engine.test.js` | parcial | Las 4 condiciones implementadas NO son las del spec. Spec dice >=90d, citationCount>=3, sin MISS, sin opuesta vigente. |
| 8.6 | FASE 5 — Limpieza (expirados, deletedByOwnerAt, snapshots >48h) | 🟡 | `mmc_engine.processHardDeletes` | `mmc_engine.test.js` | parcial | Solo procesa `deleted=true && hardDeleteAt<=now`. Falta procesar `expiresAt`, `deletedByOwnerAt`, snapshots >48h. |
| 8.7 | FASE 6 — Ajuste de baseline (recalcular campos, marcar bootstrapComplete, tonadaRegional/Confidence/adaptacionActiva) | ❌ | — | — | — | Inexistente. |
| 8.8 | FASE 7 — Ajuste umbral coseno (mensual, primer día del mes) | ❌ | — | — | — | Inexistente. |
| **Bootstrap 14 días** | | | | | | |
| 9.1 | Bootstrap activo: NIGHTLY-BRAIN destila normal, `mod_memory` devuelve `''`, Fase 2.f no ejecuta | 🟡 | `mmc_engine.bootstrapMMC` crea episodios retroactivos pero no marca baseline.bootstrapComplete | `mmc_engine.test.js` | parcial | No conecta con baseline. |
| 9.2 | Bootstrap pre-cumplido MIIA CENTER (`mensajesAnalizados >= 50 → bootstrapComplete retroactivo`) | ❌ | — | — | — | Inexistente. |
| **Derecho al olvido inmediato** | | | | | | |
| 10.1 | Detector léxico FORGET_PATTERNS antes de LLM | ❌ | — | — | — | Inexistente. No hay hook pre-LLM en TMH. |
| 10.2 | Query semántica top 5 episodes + top 10 lessons similaridad >=0.75 | ❌ | — | — | — | Inexistente. |
| 10.3 | Soft-delete INMEDIATO con `deletedByOwnerAt + deletionReason='owner_explicit'` | 🟡 | `mmc_engine.requestForgetting` soft-deletea TODOS los episodios del phone | `mmc_engine.test.js` | parcial | Borra todo por phone. Falta query semántica + filtrado por tópico. No setea `deletionReason`. |
| 10.4 | Inyección "Owner pidió olvidar [X]. Ya borrado." en prompt del turno actual | ❌ | — | — | — | Inexistente. |
| 10.5 | Batch nocturno hard delete físico | 🟡 | `mmc_engine.processHardDeletes` | OK | OK | Existe pero usa `hardDeleteAt` custom (debería ser `expiresAt`). |

---

## 2. Resumen cuantitativo

| Capa | OK ✅ | Parcial 🟡 | Falta ❌ | Total componentes |
|---|---|---|---|---|
| Capa 1 (conversations + snapshot) | 1 | 1 | 1 | 3 |
| Capa 2 (miia_memory schema + lifecycle) | 0 | 3 | 3 | 6 |
| Capa 3 (memory_graduated chunk) | 0 | 1 | 0 | 1 |
| Baseline personal | 0 | 1 | 3 | 4 |
| Validación pasiva | 0 | 0 | 5 | 5 |
| Inyección mod_memory | 2 | 4 | 1 | 7 |
| Inyección mod_tonada (v0.3) | 0 | 0 | 3 | 3 |
| NIGHTLY-BRAIN extendido (7 fases) | 0 | 5 | 3 | 8 |
| Bootstrap 14d | 0 | 1 | 1 | 2 |
| Derecho al olvido inmediato | 0 | 2 | 3 | 5 |
| **TOTAL** | **3** (6%) | **18** (38%) | **23** (49%) | **47** |

Estado global: **~30% del spec implementado**, mayor parte parcial. Para llegar a 100% del spec se requieren ~15-20 horas de implementación + ~6-8 horas de tests (alineado con la estimación 26-35h del mail Wi).

---

## 3. Tests existentes — coverage actual estimado

| Archivo test | Cubre | Estado |
|---|---|---|
| `mmc1_4_episodic.test.js` | E2E episodios (legacy) | ? |
| `mmc_cov_gaps.test.js` | Gaps cov mmc_engine | ? |
| `mmc_engine.test.js` | `core/mmc_engine.js` (captureEpisode, distillNightly, getRelevantMemories, requestForgetting, bootstrapMMC, processHardDeletes, buildMemoryContext) | Esperado >=95% (de R14) |
| `mmc_episode_detector.test.js` | `core/mmc/episode_detector.js` (detectEpisodeStart, shouldCloseEpisode, autoAssignMessageToEpisode) | ? |
| `mmc_episode_distiller.test.js` | `core/mmc/episode_distiller.js` (distillEpisode, runNightlyDistillation) | ? |
| `mmc_episodes_schema.test.js` | `core/mmc/episodes.js` (createEpisode, addMessageToEpisode, closeEpisode, getEpisode, listEpisodes) | ? |
| `mmc_nightly_runner.test.js` | runner orquestador | ? |
| `mmc_wire_in_tmh.test.js` | wire-in TMH | ? |
| `p1_mmc_distiller_coverage.test.js` | branch gaps distiller | ? |
| `t100_mmc_decay.test.js` | `core/mmc_decay.js` (TTL/decay legacy) | ? |
| `t101_mmc_isolation.test.js` | `core/mmc_isolation.js` (multi-tenant aislamiento) | ? |
| `t102_mmc_endpoint.test.js` | endpoint REST | ? |
| `t130_memory_cleanup.test.js` | cleanup batch | ? |
| `t213_lead_preferences_memory.test.js` | preferencias lead | ? |
| `t332_mmc_retrieval_decay.test.js` | retrieval con decay | ? |
| `t34_mmc_distiller_skeleton.test.js` | skeleton T34 (MMC_FASE_1_ENABLED) | ? |
| `t77_mmc_episode_retrieval.test.js` | `core/mmc/episode_retrieval.js` (getRecentEpisodesSummary, formatForPrompt, buildEpisodicContextBlock) | ? |
| `t99_mmc_retrieval.test.js` | `core/mmc_retrieval.js` (rankMemories legacy) | ? |
| `vi_coverage_mmc_distillation.test.js` | gaps cov | ? |
| `vi_coverage_mmc_distiller.test.js` | gaps cov | ? |

**Total: 20 archivos test relacionados con MMC.** Pendiente: correr `jest --listTests` con coverage para mapear archivos → branch% real.

---

## 4. Plan de implementación propuesto (Paso 2 — gaps)

Antes de tocar código, propongo este orden (1-2-3-4 secuencial, decisiones de fondo PRIMERO):

### Bloque A — DECISIONES DE FONDO (requieren firma Mariano)

- **A.1** Path canónico: ¿unificamos en `users/{uid}/` (spec) o mantenemos `owners/{uid}/` (resto del codebase)?
- **A.2** Doble implementación NIGHTLY-BRAIN: ¿`mmc_engine.distillNightly` o `mmc/episode_distiller.runNightlyDistillation`? ¿Merge o deprecate uno?
- **A.3** Schema episodio: ¿migrar docs existentes al schema completo v0.3 (27 campos) o esquema progresivo con campos opcionales?
- **A.4** Set `MEMORY_ELIGIBLE_CHAT_TYPES`: ¿reducir a `[selfchat, self, family, equipo]` del spec o mantener el set expandido actual (incluye friend_*, ale_pareja, medilink_team)?

### Bloque B — Construir lo que NO existe (orden de dependencias)

- **B.1** Baseline personal (`core/mmc/baseline.js`) — schema + CRUD + bootstrapComplete + mensajesAnalizados
- **B.2** Idioma + tonada (detector heurístico) — extiende baseline
- **B.3** Schema Lesson{} + extender schema episodio v0.3 completo
- **B.4** Validación pasiva (`core/mmc/passive_validation.js`) — regex multi-dialecto + log injection + 4 estados con peso
- **B.5** `mod_tonada()` en prompt builder — solo si bootstrapComplete + adaptacionActiva
- **B.6** Embedding + cosineSimilarity — wrapper Gemini text-embedding-004 + `getCosThreshold(uid)` (lee baseline) + injection con cooldown 72h
- **B.7** Detector léxico FORGET_PATTERNS + soft-delete inmediato + inyección "ya borrado" en turno
- **B.8** Snapshot diario completo + TTL 48h
- **B.9** NIGHTLY-BRAIN extendido — refactor `episode_distiller.distillEpisode` para retornar schema completo v0.3 (tono, idioma, tonada, lecciones, cadencia, embedding)
- **B.10** FASE 3 detección de contradicciones
- **B.11** FASE 4 graduación con 4 condiciones del spec
- **B.12** FASE 6 ajuste baseline
- **B.13** FASE 7 ajuste umbral coseno mensual

### Bloque C — P1.2 Privacy Report

- **C.1** Endpoints `GET /api/privacy/my-mmc-data?uid=X`, `POST /api/privacy/delete-mmc-category`, `GET /api/privacy/export-mmc` (JSON GDPR)
- **C.2** `core/privacy/mmc_view.js` — agregador de lo que MIIA recuerda por categoría
- **C.3** Dashboard Privacidad (HTML) — lista categorías + botones borrar/exportar
- **C.4** Tests integración con MMC (con UIDs sintéticos)

### Bloque D — Tests + cierre

- **D.1** Tests 100% branch en cada nuevo módulo
- **D.2** Test de integración E2E: bootstrap → episodio → destilación → graduación → inyección → olvido
- **D.3** Reporte CIERRE-VI-MMC-AUDIT con tabla antes/después

---

## 5. Riesgos identificados

| Riesgo | Mitigación propuesta |
|---|---|
| Migrar paths `owners/` → `users/` rompe MIIA CENTER en producción | NO migrar docs existentes — agregar dual-write (escribe en ambos paths) y deprecar gradualmente. Decisión A.1 lo confirma. |
| Schema episodio v0.3 con 27 campos rompe lecturas existentes | Campos nuevos `nullable` por default. Tests con docs viejos sin esos campos. |
| Embedding text-embedding-004 requiere API key Gemini funcional | Wrapper con fallback (skip injection si embed falla). |
| Validación pasiva regex multi-dialecto puede dar falsos positivos | Tests específicos por dialecto + métricas de precision en producción. |
| Detector FORGET_PATTERNS dispara borrado por errores tipográficos del owner | Confirmación inline con MIIA antes de hard delete (soft-delete inmediato + ventana 72h). |
| P1.2 Privacy Report endpoints sin auth → otro owner ve datos ajenos | Middleware Firebase Auth verificando `uid` del token = `uid` del query param. |

---

## 6. Estimación de horas (a refinar tras decisiones A)

| Bloque | Horas |
|---|---|
| A — Decisiones de fondo (alineación con Mariano) | 0.5-1 |
| B — Implementación gaps (B.1 a B.13) | 15-20 |
| C — P1.2 Privacy Report | 6-8 |
| D — Tests + cierre | 4-6 |
| **TOTAL** | **25.5 - 35** |

Coincide con el estimado del mail Wi (26-35h).

---

## 7. Próximo paso

Antes de empezar Bloque B, **necesito firma Mariano sobre las 4 decisiones del Bloque A.1-A.4** (en particular A.1 — path canónico y A.2 — runner oficial). Sin esas decisiones, implementar gaps duplicaría trabajo o crearía más inconsistencias.

Si Mariano firma "yo decidí: vos elegís lo más coherente con el spec", procedo con:
- A.1 → `users/{uid}/` (path del spec)
- A.2 → `core/mmc/episode_distiller.runNightlyDistillation` como runner oficial; `mmc_engine.distillNightly` deprecate gradual
- A.3 → schema progresivo (campos nullable, no migración bulk)
- A.4 → mantener set expandido actual (coherente con doctrina §2-bis ETAPA 2 subregistros Personal)

— Vi
2026-05-12
