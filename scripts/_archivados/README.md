# Scripts archivados

Scripts one-shot que ya fueron ejecutados y se preservan acá como referencia
histórica. NO se ejecutan en cron, NO se referencian desde código activo.

Origen: EXTRA #4.d cleanup git legacy (firma Mariano 2026-05-12).

## Por categoría

### Versiones legacy reemplazadas por vN newer
- `audit_incident_20260414.js` (v1, reemplazado por v4 vigente)
- `audit_incident_20260414_v2.js` (v2)
- `audit_incident_20260414_v3.js` (v3)
- `adn_ventas_extract.js` (v1, vigente: `adn_ventas_extract_v3.js`)
- `camino_d_pase1_sampler.js` (v1, vigente: v2)
- `inventario_celular_personal.js` (v1, vigente: v2)
- `reclasificar_opus47_local.js` (v1, vigente: v2)
- `fix_agenda_boca.js` (v1, vigente: v2)

### One-shots de cleanup ya ejecutados
- `delete_peru_cotizacion.js` — borró cotización pre-política Perú
- `run_cleanup_mariano_esposa.js` — cleanup específico ya corrido
- `migrate_contact_index_status.js` — migración 1-time

### Diagnostics puntuales / smokes cerrados
- `check_agenda_boca.js`
- `generate_8_mocks_fase_c.js`
- `generate_demo_ar_links.js`
- `smoke_c355_broadcast.js`
- `test_presentate_broadcast_dryrun.js`
- `paso2_apply_reclasificacion_v2.js`
- `run_forget_me_executor.js`

## Recuperar uno

```bash
git mv scripts/_archivados/<script>.js scripts/
```

## Borrar definitivamente

Requiere firma viva Mariano.
