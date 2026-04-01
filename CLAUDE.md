# MIIA Backend — Instrucciones para Claude Code

Este archivo es leído automáticamente en CADA conversación, con cualquier modelo, después de cualquier compactación de contexto.

---

## 🚨 DESPUÉS DE COMPACTACIÓN — ACCIÓN INMEDIATA

**SI VES ESTE MENSAJE, LA COMPACTACIÓN ACABA DE OCURRIR Y PERDISTE CONTEXTO.**

**ANTES de responder a Mariano, DEBES:**
1. **Leer `RESUMEN_EJECUTIVO_MIIA.md`** — Contiene TODO lo necesario para no perder el hilo
2. **Recordar LA ESENCIA**: MIIA responde en el self-chat de WhatsApp del usuario (no es un bot separado)
3. **Recordar ESTADO ACTUAL**: Ver sección ESTADO en RESUMEN_EJECUTIVO (se actualiza cada sesión)
4. **Recordar URGENCIA**: Ver sección URGENCIA en RESUMEN_EJECUTIVO (crítica siempre)
5. **⚠️ OBLIGATORIO - Actualizar el `RESUMEN_EJECUTIVO_MIIA.md`**: APENAS regresas de compactación, ANTES de responder a Mariano. Registra:
   - Commits nuevos realizados en esta sesión
   - Estado actual de P1-P11
   - Problemas encontrados
   - Siguientes pasos
   - Costo REAL de esta sesión
6. absolutamente todo siempre le respondes, piensas y hablas en ESPAÑOL

**NO RESPONDAS HASTA HABER: (1) LEÍDO RESUMEN_EJECUTIVO COMPLETO, (2) ACTUALIZADO CON NUEVOS DATOS**

**RECUERDA**: Mariano se frustra cuando gastas su contexto investigando lo que ya sabías. El RESUMEN es tu responsabilidad actualizarlo INMEDIATAMENTE.

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
- Todos los mensajes de commit, explicaciones y alertas deben estar EN ESPAÑOL

---

## 📋 PLAN PENDIENTE — Tareas ordenadas por criticidad

> **REGLA**: Cada tarea se trabaja en orden. Después de hacer commit, pedir aprobación a Mariano. Si aprueba → marcar ✅ y eliminar del plan. Si rechaza → revertir y discutir.

### 🔴 CRÍTICOS (MIIA no funciona correctamente sin estos)

- [ ] **P1: Verificar que MIIA responda en self-chat** — El fix de isSelfChat ya está deployed. Mariano debe probar mandando "Hola MIIA" y confirmar que responde. Si no responde, revisar logs. | Modelo: ninguno (test manual) | Costo: $0
- [ ] **P2: Auto-reconnect sin clic manual** — Los logs muestran "0 sesiones de Baileys encontradas" al startup, Mariano tuvo que hacer clic en "Conectar". La sesión debería persistir en Firestore y reconectar sola. Investigar por qué no encuentra la sesión. | Modelo: Haiku | Costo: ~$0.50
- [ ] **P3: Endpoint documentos roto en admin-dashboard** — El frontend llama a `/api/tenant/:uid/documents/upload` pero el backend tiene `/api/documents/upload` (sin tenant). Tab "Documentos" en admin no funciona. | Modelo: Haiku | Costo: ~$0.10
- [ ] **P4: Exportar setTenantTrainingData en tenant_manager** — La función existe (línea 630) pero NO está en module.exports (línea 650-661). Training data no persiste correctamente en auto-reconexión. | Modelo: Haiku | Costo: ~$0.10

### 🟡 IMPORTANTES (Funcionan pero tienen problemas)

- [ ] **P5: Limpiar código muerto de whatsapp-web.js** — Fallback en processMediaMessage() (server.js línea ~1585) referencia API vieja. Código muerto que puede confundir. | Modelo: Haiku | Costo: ~$0.10
- [ ] **P6: cerebro_absoluto.js usa getChats() de whatsapp-web.js** — Verificación fallida silenciosa. No rompe nada pero el minado nocturno no funciona. | Modelo: Sonnet | Costo: ~$0.50
- [ ] **P7: Archivos obsoletos** — firestore_session_store.js, messageProcessor.js, cerebro_medilink_backup.js ya no se usan. Eliminar para limpieza. | Modelo: Haiku | Costo: ~$0.05

### 🟢 MEJORAS (Nice to have, no urgentes)

- [ ] **P8: Detección de festivos en silencio nocturno** — Actualmente solo bloquea domingos + 9PM-6AM. No detecta festivos de Colombia/Argentina. | Modelo: Haiku | Costo: ~$0.30
- [ ] **P9: Paddle — crear productos y configurar webhook** — El código está 100% implementado. Mariano necesita crear productos en Paddle dashboard y configurar webhook URL. | Modelo: ninguno (manual) | Costo: $0
- [ ] **P10: "Ver como usuario" en sidebar admin** — Funcionalidad de impersonación incompleta. | Modelo: Sonnet | Costo: ~$1.00
- [ ] **P11: Notificación email cuando WhatsApp se desconecta** — Para saber si MIIA se cayó sin estar mirando logs. | Modelo: Sonnet | Costo: ~$0.50

### 💰 RESUMEN DE COSTOS ESTIMADOS
| Prioridad | Tareas | Costo estimado | Modelo recomendado |
|-----------|--------|----------------|-------------------|
| 🔴 Críticos | P1-P4 | ~$0.70 | Haiku (P2-P4), Manual (P1) |
| 🟡 Importantes | P5-P7 | ~$0.65 | Haiku (P5,P7), Sonnet (P6) |
| 🟢 Mejoras | P8-P11 | ~$1.80 | Haiku (P8), Sonnet (P10-P11), Manual (P9) |
| **TOTAL** | **11 tareas** | **~$3.15 USD** | **Haiku para 70% de tareas** |

> **CONSEJO PARA MARIANO**: Usá **Haiku** para tareas simples (P2-P5, P7-P8). Solo usá **Sonnet** cuando la tarea necesite entender mucho contexto (P6, P10, P11). **Opus** solo para debugging complejo donde Haiku/Sonnet fallen. Esto te ahorra ~90% vs usar Opus para todo.
