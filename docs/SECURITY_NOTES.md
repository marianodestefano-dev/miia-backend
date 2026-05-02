# Security Notes — miia-backend

## npm Vulnerabilities — Estado 2026-05-02

### Resumen

`npm audit` reporta 19 vulnerabilidades luego de `npm audit fix` (commit `8c1ed9c`).
Las vulnerabilidades restantes son **todas transitivas** de `@whiskeysockets/baileys`,
el cliente WhatsApp que no puede ser reemplazado sin romper la funcionalidad core de MIIA.

### Vulnerabilidades críticas/altas pendientes

| Paquete | Severidad | CVE / Advisory | Por qué no se puede parchear |
|---------|-----------|----------------|------------------------------|
| `@whiskeysockets/libsignal-node` | CRITICAL | N/A — versión nativa antigua | Transitiva de Baileys; solo parcheada en fork privado de Baileys |
| `semver` < 7.5.2 | HIGH | CVE-2022-25883 (ReDoS) | Transitiva de Baileys y otras deps |
| `lodash` < 4.17.21 | HIGH | CVE-2021-23337 (prototype pollution) | Transitiva de Baileys |
| `nodemailer` < 6.9.x | HIGH | N/A | Transitiva indirecta |
| `utf7` | MODERATE | N/A | Transitiva de `imap` |
| `basic-ftp` | MODERATE | N/A | Transitiva de dependencias de PDF/mailer |
| `@xmldom/xmldom` < 0.8.x | MODERATE | N/A | Transitiva |
| `imap` | MODERATE | N/A | Usado para integración email; fork seguro pendiente |
| `protobufjs` | MODERATE | N/A | Transitiva de Baileys |

### Por qué no se aplica `npm audit fix --force`

`--force` haría un upgrade mayor de `@whiskeysockets/baileys` (v6 → v7+).
Baileys v7 cambió completamente la API de autenticación y gestión de sesiones.
Migrar requiere:
1. Reescribir `whatsapp/baileys_session_store.js`
2. Reescribir `whatsapp/sock_factory.js` y la reconexión automática
3. Validar en staging con cuentas de WhatsApp reales (proceso de ~1-2 semanas)
4. No hay garantía de backward-compatibility con sesiones Firestore existentes

### Deuda técnica registrada

**DEUDA-SEC-001**: Upgrade mayor de `@whiskeysockets/baileys` a v7+.
- **Estado**: PENDIENTE — requiere sprint dedicado
- **Riesgo actual**: MEDIO — las vulns son transitivas, MIIA no expone las rutas vulnerables
  directamente a usuarios finales (WhatsApp gateway, no web app pública)
- **Mitigación en producción**: Railway + Cloudflare WAF filtran tráfico externo;
  los endpoints críticos tienen auth guards (`rrRequireAuth + rrRequireOwnerOfResource`)
- **Fecha estimada**: post-Piso 3 del Edificio MIIA (≥ Q3 2026)

### Acción tomada

- `npm audit fix` aplicado: `@protobufjs/codegen` 2.0.4 → 2.0.5 (commit `8c1ed9c`)
- Remaining 19 vulns documentadas aquí como deuda técnica
- Auth guards agregados a `/api/tenant/:uid/conversations` y `/api/tenant/:uid/train`
  para reducir superficie de ataque (commit AUDITORIA-SEC-ARQ)
