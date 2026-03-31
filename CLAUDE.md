# MIIA Backend — Instrucciones para Claude Code

Este archivo es leído automáticamente en CADA conversación, con cualquier modelo, después de cualquier compactación de contexto.

---

## ⛔ ZONA CRÍTICA — WHATSAPP (NO MODIFICAR SIN AVISO)

Los siguientes archivos y funciones son **críticos para la conexión WhatsApp**. Modificarlos sin cuidado rompe toda la vinculación.

### Archivos protegidos:
- `server.js` — funciones: `initWhatsApp`, `whatsappClient`, eventos `qr`/`ready`/`authenticated`/`disconnected`, endpoints `/api/tenant/:uid/qr` y `/api/tenant/:uid/request-pairing-code`
- `tenant_manager.js` — TODO EL ARCHIVO. Especialmente: `initTenant`, `RemoteAuth`, `LocalAuth`, eventos `qr`/`authenticated`/`ready`/`disconnected`, opciones de `puppeteer`
- `firestore_session_store.js` — TODO EL ARCHIVO

### Regla obligatoria ANTES de tocar cualquiera de estos archivos:
1. Decirle a Mariano QUÉ vas a cambiar y POR QUÉ
2. Esperar su confirmación explícita
3. Cambiar SOLO lo mínimo necesario
4. Documentar el cambio en `WHATSAPP_PROTECTION.md`

### ¿Por qué esta regla existe?
En sesiones anteriores se modificaron estas zonas sin cuidado y se rompió la conexión WhatsApp. WhatsApp Web + Puppeteer en Railway es frágil. Cualquier cambio pequeño puede romper el flujo QR→authenticated→ready.

---

## Arquitectura MIIA (resumen)

- **Frontend**: Vercel → `miia-frontend/` (HTML/JS estático, Firebase Auth)
- **Backend**: Railway → `miia-backend/` (Node.js/Express)
- **DB**: Firebase Firestore
- **IA**: Google Gemini API
- **WhatsApp**: whatsapp-web.js + Puppeteer (RemoteAuth con Firestore)

### Dos flujos de WhatsApp:
1. **Owner** (`server.js`): el WhatsApp principal de MIIA (cuenta de Mariano como dueño del sistema). Logs con prefijo `[WA]`.
2. **Tenants** (`tenant_manager.js`): WhatsApp de cada cliente pago. Logs con prefijo `[TM:uid]`.

### Owner UID: `bq2BbtCVF8cZo30tum584zrGATJ3`

---

## Convenciones de código

- Logs con prefijos claros: `[WA]`, `[TM:uid]`, `[QR]`, `[PAIRING]`, `[AUTH]`
- No usar backslashes en URLs fetch del frontend (usar `/`)
- El frontend usa `BACKEND_URL` / `API` constants para las URLs del backend
- Railway autodeploy desde GitHub push a `main`
- Vercel autodeploy desde GitHub push a `main`
