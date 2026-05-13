# MEMO Git Legacy Cleanup — EXTRA #4.d

**Fecha:** 2026-05-12
**Autor:** Vi (Técnico MIIA)
**Trigger:** mail Wi EXTRA #4.d — *"Limpieza git legacy: commits no pusheados, scripts one-shot, anonimización prompts.js, archivo huérfano frontend"*

---

## 1. Commits no pusheados a `origin/main` (4 commits)

| SHA | Rama | Tipo | Acción recomendada |
|---|---|---|---|
| `02a2d90` | `feature/c4-log-sanitizer` | C4 log sanitizer legacy | **Obsoleto.** Reemplazado por mi EXTRA #1 commit `0f09474` direct a main. La feature branch puede archivarse o borrarse local. |
| `024c335` | `backup-feature-fortaleza-pre-c397` | V2 voice_seed_center.md + sanitize hardcodes | **Backup pre-C397.** Mantener como salvaguarda. NO mergear a main. |
| `8780d45` | `feature/fortaleza` | C-392 B.1+B.2 master key + dashboard owner-view | **§2-ter Fortaleza inerte.** Requiere firma Mariano C-392+ para merge. **NO TOCAR sin ceremonia.** |
| `91191bc` | `feature/fortaleza` | C-390 Privacy Vault construcción completa | **§2-ter Fortaleza inerte.** Igual. NO mergear sin firma. |

**Acción operativa de Vi:** NO mergear ni borrar nada. Los 2 commits Fortaleza están bajo doctrina §2-ter (rama aislada, inerte). Los 2 commits backup son salvaguardas. El feature/c4-log-sanitizer está obsoleto pero su existencia no daña.

**Decisión que requiere Mariano:**
1. ¿Borrar `feature/c4-log-sanitizer` local? (commit obsoleto reemplazado por `0f09474` ya en main)
2. ¿Cleanup de `backup-feature-fortaleza-pre-c397`? Era backup pre-C397, ya pasamos esa carta.

---

## 2. Commit mezclado `f386daf` (mencionado por Wi)

```
f386daf2  feat(ai): dynamic route + tests, emoji v2 ajustes, gitignore huerfanos
          Mariano De Stefano <mariano.destefano@gmail.com>
          Mon Apr 20 17:53:04 2026
```

**Cambios consolidados:**
- `ai/dynamic_route.js` + `__tests__/dynamic_route.test.js` (175+316 líneas) — feat ruteo dinámico
- `core/miia_emoji.js` (5 líneas) — ajustes menores
- `core/prompt_registry.js` (13 líneas) — mantenimiento
- `package.json` (1 línea) — sync deps
- `.gitignore` (16 líneas) — excluir `adn_*.js`, `adn_ventas_raw.json`, scripts/benchmark, .bak

**Estado:** ya pusheado a `origin/main`. NO requiere acción retroactiva.

**Diagnóstico:** Wi sugirió "separar o documentar". Como ya está integrado en main y no rompe nada, **se documenta acá y no se separa retroactivamente** (eso requeriría rebase interactivo + force-push, riesgo alto). Si en el futuro alguien quiere bisect entre los 5 cambios, el commit es atómico para revertir features pero conlleva tocar 6 archivos juntos.

---

## 3. Scripts one-shot candidatos a archivar (54 scripts en `scripts/`)

Auditoría: muchos scripts son de incidentes ya cerrados o son v1/v2/v3 duplicados.

### Candidatos a archivar (versiones legacy con vN newer disponible)

| Script | Razón | Recomendación |
|---|---|---|
| `audit_incident_20260414.js` | v1 reemplazado por v2/v3/v4 | Mover a `scripts/_archivados/` |
| `audit_incident_20260414_v2.js` | v2 reemplazado por v3/v4 | Mover a `scripts/_archivados/` |
| `audit_incident_20260414_v3.js` | v3 reemplazado por v4 | Mover a `scripts/_archivados/` |
| `audit_incident_20260414_v4.js` | Versión final (último audit del incidente) | **MANTENER** como referencia |
| `adn_ventas_extract.js` | v1 reemplazado por v3 | Mover a archivado |
| `camino_d_pase1_sampler.js` | v1 reemplazado por v2 | Mover a archivado |
| `inventario_celular_personal.js` | v1 reemplazado por v2 | Mover a archivado |
| `reclasificar_opus47_local.js` | v1 reemplazado por v2 | Mover a archivado |
| `fix_agenda_boca.js` | v1 reemplazado por v2 | Mover a archivado |

### Candidatos a archivar (one-shot de cleanup ya ejecutado)

| Script | Función | Recomendación |
|---|---|---|
| `delete_peru_cotizacion.js` | Borró 1 cotización pre-Perú política | Archivar |
| `check_agenda_boca.js` | Diagnostic puntual | Archivar |
| `run_cleanup_mariano_esposa.js` | Cleanup específico ya ejecutado | Archivar |
| `migrate_contact_index_status.js` | Migración 1-time ya corrida | Archivar |
| `paso2_apply_reclasificacion_v2.js` | Paso específico ya completado | Archivar |
| `generate_8_mocks_fase_c.js` | Fase C cerrada | Archivar |
| `generate_demo_ar_links.js` | Demo puntual AR | Archivar |
| `smoke_c355_broadcast.js` | Smoke test cerrado | Archivar |
| `test_presentate_broadcast_dryrun.js` | Test dry-run cerrado | Archivar |
| `run_forget_me_executor.js` | One-shot GDPR | Archivar |

### Mantener (scripts activos o referencia útil)

| Script | Función |
|---|---|
| `_health_smoke_harness.py` | Health checks recurrentes |
| `_vi_daily_digest.py` | Digest activo Vi |
| `backup_firestore.js` | Backup periódico |
| `backup_prompt_engine_v0.js` | Backup referencia |
| `rotate_credentials.js` | Rotación periódica |
| `r_v0_smoke.sh` | Smoke producción R-V0 |
| `f1_seed_2025.js` + `f1_seed_2026.js` | F1 seed activo |
| `run_mmc_nightly_distillation.js` | Cron MMC activo |
| `sanitize_logs.js` | Sanitize tool activa |
| `test_v2_smoke.js` | Smoke V2 activo |
| `env_validator.js` | EXTRA #2 R22-B activo |
| `inspect_keys_cambios.py` | Audit ciclo activo |

**Acción operativa Vi:** NO mover scripts ahora (requiere firma Mariano sobre criterios de "archivar" vs "borrar"). Memo queda como inventario.

---

## 4. Anonimización `prompt_builder.js` (PII hardcodeada)

**Audit ejecutado:** búsqueda de phone E.164, emails personales (gmail/hotmail/yahoo), cédulas CO, números reales de Mariano (`573054169969`, `573163937365`).

**Resultado:**
- ✅ `core/prompt_builder.js` línea 923-925: ejemplos `+573001234567` — **ejemplo sintético**, no PII real.
- ✅ Línea 940, 1404, 1405: `5491155001234`, `5491155005678`, `5491155009999` — todos **ejemplos sintéticos** (números no asignados).
- ✅ **CERO hits del phone real de Mariano** (`+573054169969` MIIA CENTER ni `+573163937365` Personal).
- ✅ **CERO hits de email personal** (gmail/hotmail/yahoo).

**Conclusión:** `prompt_builder.js` ya está sano de PII real. No requiere anonimización. Los números visibles son ejemplos sintéticos para que Gemini entienda el formato.

---

## 5. Archivo huérfano en `miia-frontend`

**No aplica a este repo.** `miia-frontend` es otro repo multi-repo. Si Mariano quiere que audite huérfanos en `miia-frontend`, requiere apertura separada (CLAUDE.md §5-bis protocolo multi-repo). Pendiente firma.

---

## 6. Resumen acciones

| Item | Acción Vi | Requiere firma Mariano |
|---|---|---|
| 4 commits no pusheados | Documentados acá. NO mergear. | Sí para borrar feature/c4-log-sanitizer |
| Commit f386daf mezclado | Documentado. Ya en main. NO retrocambiar. | No (decisión "no separar") |
| 19 scripts one-shot candidatos a archivar | Inventariados con recomendación. NO movidos. | Sí para mover a `scripts/_archivados/` |
| `prompt_builder.js` PII | Audit OK — sin PII real. **No requiere acción.** | No |
| Huérfano miia-frontend | Skip (multi-repo) | Sí para abrir auditoría del otro repo |

---

— Vi
2026-05-12
