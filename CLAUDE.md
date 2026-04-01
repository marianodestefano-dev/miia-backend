# MIIA Backend — Instrucciones para Claude Code

Este archivo es leído automáticamente en CADA conversación, con cualquier modelo, después de cualquier compactación de contexto.

---

## 🚨🔴⚠️ ALERTA — ZONA CRÍTICA DE WHATSAPP — NO MODIFICAR SIN AVISO 🔴🚨⚠️

Los siguientes archivos y funciones son **CRÍTICOS para la conexión WhatsApp**. Modificarlos sin cuidado **ROMPE toda la vinculación**.

### 📁 Archivos protegidos:
- `server.js` — bloque de auto-reconnect (líneas ~4533-4647), endpoints `/api/tenant/:uid/qr`, manejo de mensajes del owner
- `tenant_manager.js` — **TODO EL ARCHIVO**. Especialmente: `startBaileysConnection()`, lógica de filtrado de mensajes (líneas ~304-342), eventos `qr`/`authenticated`/`ready`/`disconnected`

### ✋ Regla OBLIGATORIA ANTES de tocar cualquiera de estos archivos:
1. **Explicar a Mariano EN ESPAÑOL** qué se va a cambiar y por qué
2. **Esperar su confirmación EXPLÍCITA** (no asumir que acepta)
3. Cambiar **SOLO lo mínimo necesario**
4. Mostrar ejemplos concretos del comportamiento ANTES vs DESPUÉS
5. **SIEMPRE usar en la descripción del comando Bash (campo description)** el prefijo: `🚨🔴⚠️ ALERTA: ZONA CRÍTICA —` seguido del archivo y resumen del cambio. Esto aplica a CUALQUIER git commit, git add, o edición que toque `server.js` o `tenant_manager.js`. Mariano necesita ver esta alerta en el popup "Allow this bash command" para estar atento.

### ❓ ¿Por qué esta regla existe?
En sesiones anteriores se modificaron estas zonas sin cuidado y se rompió la conexión WhatsApp. El auto-reconnect y el message filtering de Baileys son delicados. Cualquier cambio pequeño puede romper el flujo QR→authenticated→ready o bloquear mensajes legítimos.

---

## Arquitectura MIIA (resumen)

- **Frontend**: Vercel → `miia-frontend/` (HTML/JS estático, Firebase Auth)
- **Backend**: Railway → `miia-backend/` (Node.js/Express/Socket.io)
- **DB**: Firebase Firestore
- **IA**: Google Gemini API (gemini-2.5-flash)
- **WhatsApp**: Baileys (@whiskeysockets/baileys) — WebSocket directo a WhatsApp, sin Puppeteer (~20-30MB RAM por sesión)
- **Pagos**: Paddle (merchant of record para Latinoamérica, PayPal fallback)

### Dos flujos de WhatsApp:
1. **Owner**: El WhatsApp principal de MIIA. Auto-reconnect en cada startup. Responde en self-chat.
2. **Tenants**: WhatsApp de cada usuario pago. Auto-reconnect para tenants también.

### Credenciales clave:
- **OWNER_UID**: Auto-detectado desde Firestore (usuario con role='admin')
- **Sesiones**: Almacenadas en Firestore en `baileys_sessions/tenant-{uid}/data/`
- **JID format**: Baileys usa `@s.whatsapp.net` (no `@c.us`)

---

## Convenciones de código

- Logs con prefijos claros: `[WA]`, `[TM:uid]`, `[QR]`, `[PAIRING]`, `[AUTH]`
- No usar backslashes en URLs fetch del frontend (usar `/`)
- El frontend usa `BACKEND_URL` / `API` constants para las URLs del backend
- Railway autodeploy desde GitHub push a `main`
- Vercel autodeploy desde GitHub push a `main`
