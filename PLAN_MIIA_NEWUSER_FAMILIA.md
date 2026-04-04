# PLAN: MIIA NewUser — Familia Gratuita (v3 simplificado)

**Fecha**: 2026-04-04
**Estado**: APROBADO por Mariano, pendiente implementación

---

## Concepto

Contactos del grupo "familia" de cualquier usuario con MIIA pueden tener su propia MIIA gratis. El sistema es viral (∞ niveles), cada MIIA promueve con sentido común.

---

## Reglas de referidos

1. Todo referido DEBE existir como contacto del referente (validación por número de WhatsApp)
2. Primeros 3 contactos de familia → `familia_free` (gratis siempre)
3. Del 4to en adelante → trial estándar (7 días → pago)
4. Si el registrante NO existe en contactos del referente → rechazar con mensaje claro
5. Todas las MIIA pueden referir (viral ∞ niveles)
6. Todas las MIIA promueven (auto-venta con sentido común)

---

## Flujo del nuevo usuario

### FASE 1: Descubrimiento (WhatsApp)
- MIIA habla naturalmente con familiar → menciona que puede tener su propia MIIA gratis
- Contacto dice "sí" → MIIA envía link firmado: `www.miia-app.com/registro?ref=fam_[uid]_[hmac]`

### FASE 2: Registro (Web)
- Validar número WhatsApp contra contactos del referente
- Si existe → registro auto-aprobado, `plan: familia_free`
- Número WhatsApp pre-llenado (ya lo tenemos del grupo)
- Usuario solo elige: Google Auth o Email+Password
- Firestore crea:
  ```
  users/{newUid} = {
    plan: 'familia_free',
    referredBy: ownerUid,
    referralType: 'familia',
    approved: true,
    useOwnerApiKey: true,  // temporal
    payment_status: 'familia_free',  // NUNCA toca Paddle
    onboarding_step: 1,
    authProvider: 'google'|'email'
  }
  ```

### FASE 3: Onboarding via WhatsApp (MIIA Original guía en self-chat)

**PASO 1/3: Conectá tu WhatsApp**
- MIIA Original envía tutorial con imagen al self-chat del NewUser
- Sistema detecta conexión → auto-avanza

**PASO 2/3: Configurá tu IA**
- Guía para crear API key en aistudio.google.com/apikey (o IA favorita)
- Verificación paralela de la key
- Si válida → `useOwnerApiKey = false`, notificar éxito en self-chat
- Si inválida 1ra vez → guía detallada para reintentar
- Si inválida 2da vez → "Ya le avisé a [Owner], hablá con él/ella"
- **NO existe botón skip**

**PASO 3/3: Agregá tus contactos**
- MIIA NewUser (ya con su key) guía al usuario
- "¿Tenés novio/novia? ¿Mejor amigo? ¿Familiar cercano?"
- "Solo necesito nombre o número" → crear grupo y asignar
- Probar con 1 contacto primero

---

## Sistema de fallback (cuando la IA del NewUser se cae)

### Modo ONBOARDING_ONLY
Cuando `aiKeyStatus = 'fallback_admin'`:
- **Self-chat del NewUser**: responder con prompt reducido (max 500 tokens), SOLO temas de configuración
- **Mensajes externos (leads, contactos)**: NO responder. Guardar en cola con timestamp
- **Cola expira a los 3 días**. Al restaurar key: procesar si < 3 días, sino esperar nuevo "Hola MIIA"
- **Dashboard**: Asistente MIIA — Soporte Técnico disponible

### Notificaciones al admin
- **Momento 0**: "👨‍👩‍👧 [Familiar] está usando tu key como respaldo."
- **Momento exacto que NewUser interactúa**: "No te preocupes, ya lo estoy guiando."
- **+15 min sin interacción**: "[Familiar] — 15 min sin responder. Sigue en tu respaldo."
- **+45 min sin resolver**: "[Familiar] no pudo solo. Le dije que te hable."
- **Recordatorio**: Máx 2/día, máx 4 total. Mencionar Asistente MIIA Soporte Técnico en dashboard.

---

## Asistente MIIA — Soporte Técnico

- Existe en `admin-dashboard.html` (renombrar "IA" → "MIIA")
- **AGREGAR** a `owner-dashboard.html` y `agent-dashboard.html`
- Endpoint owner/agent: `/api/tenant/:uid/support-chat` (nuevo)
- Prompt adaptado al rol (owner vs agent vs admin)
- En fallback, mencionar este asistente como alternativa al self-chat

---

## MIIA vs MIIA (simplificado)

**No se necesita sistema anti-loop.** Las reglas actuales lo impiden naturalmente:
- MIIA solo responde a: self-chat, leads clasificados, familiares que dijeron "HOLA MIIA"
- Si Ale habla con Mamá (ambas con MIIA): ninguna MIIA interviene (no hubo "HOLA MIIA")
- Si Ale dice "HOLA MIIA" a Mamá: solo MIIA de Mamá se activa. MIIA de Ale no (Mamá no dijo "HOLA MIIA")
- Solo se necesita `checkIfMiiaUser` como precaución futura, no como sistema activo

---

## MIIA NewUser vs MIIA Original

| Aspecto | Idéntica? |
|---------|-----------|
| Código/features | ✅ SÍ (mismo servidor, mismos updates) |
| WhatsApp propio | ✅ SÍ |
| Referir familia | ✅ SÍ (viral ∞) |
| Auto-venta | ✅ SÍ |
| Cerebro propio | ✅ SÍ |
| Dashboard | ⚠️ CASI (sin sección pagos) |
| Admin panel | ❌ NO (role=client) |
| Costo | ❌ NO ($0 familia) |
| Key ADMIN visible | ❌ NUNCA |

---

## Seguridad

- Link firmado con HMAC (no adivinable)
- Validación contra contactos reales del referente
- Key ADMIN nunca visible en dashboard del NewUser
- Rate limit por tenant en fallback (proteger tokens admin)
- Máx 3 familia_free por referente
- Owner puede revocar desde admin-dashboard

---

## Archivos a modificar

| # | Archivo | Cambio |
|---|---------|--------|
| 1 | `server.js` | Endpoint registro familia, validación contactos, fallback limitado, soporte técnico owner/agent |
| 2 | `tenant_manager.js` | AI health check, modo ONBOARDING_ONLY, cola mensajes pendientes |
| 3 | `login.html` | `?ref=fam_*`, UI simplificada, pre-llenar WhatsApp, max 3 slots |
| 4 | `owner-dashboard.html` | Asistente MIIA Soporte Técnico, ocultar pagos familia_free, ocultar key ADMIN |
| 5 | `agent-dashboard.html` | Asistente MIIA Soporte Técnico |
| 6 | `admin-dashboard.html` | Renombrar "IA" → "MIIA", panel familia/referrals |
| 7 | `prompt_builder.js` | Auto-venta todas las MIIA, prompt onboarding contactos |
| 8 | `message_logic.js` | checkIfMiiaUser (precaución futura) |
