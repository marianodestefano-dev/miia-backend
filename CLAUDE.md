# MIIA Backend — Instrucciones para Claude Code

## PROTOCOLO DE ARRANQUE — OBLIGATORIO en cada sesión y compactación
## STANDARD DE CÓDIGO: 
Google + Amazon + APPLE + NASA (fail loudly, exhaustive logging, desing style, zero silent failures) siempre leyendo completamente (CLAUDE.md) y (RESUMEN_EJECUTIVO_MIIA.md)
## SIEMPRE EN ESPAÑOL.

**Paso 1**: Leer estos sub-archivos EN ORDEN (están diseñados para ser cortos y atómicos):

| # | Archivo | Qué contiene | Cuándo leer |
|---|---------|-------------|-------------|
| 1 | `.claude/01_IDENTIDAD.md` | Qué es MIIA, stack, archivos críticos | SIEMPRE |
| 2 | `.claude/02_ESTADO_ACTUAL.md` | Qué funciona, qué no, última sesión | SIEMPRE |
| 3 | `.claude/03_REGLAS_MARIANO.md` | Cómo trabajar con Mariano | SIEMPRE |
| 4 | `.claude/04_COTIZACIONES.md` | Sistema de cotizaciones, precios, reglas por país | Si toca cotizaciones |
| 5 | `.claude/05_BAILEYS_FORTRESS.md` | Protección de sesión WhatsApp | Si toca Baileys/sesiones |
| 6 | `.claude/06_HISTORIAL_SESIONES.md` | Qué se hizo en cada sesión | Si necesita contexto previo |

**Paso 2**: Actualizar `02_ESTADO_ACTUAL.md` con lo que se hizo en esta sesión ANTES de responder.

**Paso 3**: Responder a Mariano en ESPAÑOL, con código concreto, nivel NASA.

---

## REGLA DE ORO POST-COMPACTACIÓN

Al detectar compactación:
1. **NO investigar** lo que ya está en los sub-archivos
2. **NO preguntar** "¿en qué estábamos?" — leer 02_ESTADO_ACTUAL
3. **NO repetir** lo que Mariano ya sabe
4. Leer los 3 primeros archivos (< 2 min total), actualizar estado, continuar

---

## ZONA CRÍTICA DE WHATSAPP

Antes de tocar `server.js` o `tenant_manager.js`:
1. Explicar a Mariano qué se cambia y por qué
2. Esperar confirmación explícita
3. Prefijo en descripción Bash: `🚨🔴⚠️ ALERTA: ZONA CRÍTICA —`

---

## COPIAS DE SEGURIDAD

**Ruta**: `C:\Users\usuario\DOCUMENTOS\NEGOCIOS\Miia-App\COPIA SEGURIDAD MIIA\`
**Frecuencia**: Cada 5 sesiones. Última: Sesión 9.

---

