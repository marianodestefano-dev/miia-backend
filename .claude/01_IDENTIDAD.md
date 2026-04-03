# IDENTIDAD MIIA

## Qué es
Asistente IA de WhatsApp para negocios (SaaS multi-tenant). Responde en el **self-chat** del usuario (no es un bot separado). Cada usuario conecta SU WhatsApp.

## Stack
| Capa | Tecnología | Deploy |
|------|-----------|--------|
| Frontend | HTML/JS, Firebase Auth | Vercel (`miia-frontend/`) |
| Backend | Node.js, Express, Socket.IO | Railway (`miia-backend/`), rama `main-test` |
| DB | Firebase Firestore | Google Cloud |
| IA | Gemini 2.5 Flash | API key por usuario |
| WhatsApp | Baileys (WebSocket, ~20-30MB/sesión) | En backend |
| Pagos | Paddle + PayPal fallback | Paddle dashboard |

## Credenciales
- `OWNER_UID`: Auto-detectado (Firestore `role='admin'`)
- Sesiones: `baileys_sessions/tenant-{uid}/data/`
- JID: `@s.whatsapp.net` (no `@c.us`)

## Archivos críticos (NO tocar sin confirmar con Mariano)
- `server.js` — auto-reconnect, endpoints QR, manejo mensajes owner
- `tenant_manager.js` — TODO (startBaileysConnection, filtrado, QR/auth/ready/disconnect)
- `baileys_session_store.js` — Fortress v2.0, identity/session separation
- `cotizacion_generator.js` — Matrices de precios, generación PDF
- `prompt_builder.js` — Todos los prompts de MIIA

## Convenciones
- Logs: `[WA]`, `[TM:uid]`, `[QR]`, `[PAIRING]`, `[AUTH]`, `[BAILEYS-STORE]`, `[MIIA]`
- URLs frontend: forward slashes, `BACKEND_URL`/`API` constants
- Deploy: push a `main-test` → Railway autodeploy
- **Todo en ESPAÑOL** (commits, explicaciones, alertas)
