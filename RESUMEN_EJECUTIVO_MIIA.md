# 🚀 RESUMEN EJECUTIVO MIIA — LEE ESTO PRIMERO DESPUÉS DE CADA COMPACTACIÓN

**ÚLTIMA ACTUALIZACIÓN**: 2026-04-01 06:30 AM
**ESTADO**: P1 ✅ FUNCIONA | P2-P11 PENDIENTES
**URGENCIA**: CRITICA — Sin P2, WhatsApp se desconecta en cada restart

---

## 🎯 LA ESENCIA DE MIIA (NO OLVIDES NUNCA ESTO)

**MIIA vive en el WhatsApp del usuario y responde en su SELF-CHAT (el chat consigo mismo).**

```
Mariano escribe "Hola MIIA" en su self-chat (Mis contactos) en WhatsApp
    ↓
Baileys recibe el mensaje con JID: 136417472712832@lid
    ↓
Backend procesa y llama a Gemini AI
    ↓
MIIA genera respuesta (151 caracteres en el último test)
    ↓
Backend INTENTA enviar a 136417472712832@s.whatsapp.net
    ❌ PROBLEMA: El mensaje NO llega al self-chat de Mariano (se pierde en Baileys)
```

**PROBLEMA ACTUAL (P1 PARCIAL):**
- ✅ MIIA recibe, procesa, genera respuesta
- ✅ Log dice "[SENT] Mensaje enviado"
- ❌ **Mariano NO recibe el mensaje en su WhatsApp**
- ❌ El self-chat en Baileys requiere lógica especial para ENVÍO

---

## 📊 ARQUITECTURA MIIA (RESUMIDA)

### Stack Técnico
```
FRONTEND:  Vercel (HTML/JS) → miia-frontend-one.vercel.app
BACKEND:   Railway (Node.js) → miia-backend-production.up.railway.app
DATABASE:  Firebase Firestore
AI:        Google Gemini 2.5-Flash
WHATSAPP:  Baileys (@whiskeysockets/baileys) — WebSocket directo, sin Puppeteer
PAGOS:     Paddle (merchant of record para Latinoamérica)
```

### Flujo Multi-Tenant
```
Usuario Mariano (Admin/Owner)
├── UID: bq2BbtCVF8cZo30tum584zrGATJ3
├── WhatsApp: 136417472712832 (número de Mariano)
├── Sesión Baileys: tenant-bq2BbtCVF8cZo30tum584zrGATJ3
├── Creds en Firestore: baileys_sessions/tenant-{uid}/data/creds
└── Comportamiento especial: Self-chat, responde siempre (sin silencio nocturno)

Usuario Tenant (Vendedor B2B)
├── UID: {otro uid}
├── WhatsApp: Su número
├── Sesión Baileys: tenant-{uid}
└── Comportamiento: Normal, responde solo en horarios (9AM-9PM, no domingos)
```

---

## 🔴 PROBLEMAS CRÍTICOS ACTUALES

### P1: ✅ PARCIALMENTE RESUELTO (¿Necesita fix en envío a self-chat?)
**Status**: MIIA recibe y procesa mensajes en self-chat, PERO:
- ✅ Mensaje llega al backend: `"Hola miia"`
- ✅ Se abre sesión: `136417472712832@s.whatsapp.net`
- ✅ Gemini genera respuesta (151 caracteres)
- ✅ Log dice: `[SENT] Mensaje enviado`
- ❌ **PERO**: Mariano NO recibe el mensaje en su WhatsApp
- **Raíz probable**: Baileys envía a JID incorrecto o self-chat requiere método especial

**Fix requerido**:
- Revisar envío a self-chat en server.js línea ~1000-1100
- Probablemente usar `sock.sendMessage()` con opciones especiales
- O enviar a Saved Messages / Broadcast List en lugar de self-chat directo

### P2: Auto-reconnect sin clic manual
**Status**: BLOQUEADO
- Sesiones se guardan en Firestore ✅
- Al restart, busca sesiones ✅
- PERO: Las credenciales se pierden/expiran, Baileys rechaza reconectar ❌
- Resultado: Mariano debe hacer clic "Conectar" y escanear QR nuevamente

**Investigación pendiente**:
- Firestore tiene las credenciales con estructura correcta?
- Baileys deserializa Buffers correctamente?
- Las credenciales expiran después de X tiempo?

---

## 📁 ARCHIVOS CRÍTICOS (NO MODIFICAR SIN AVISAR A MARIANO)

### server.js (ZONA CRÍTICA 🚨)
```javascript
Líneas 933-954: Lógica de silencio nocturno + bypass para self-chat
Línea 936-939: HARDCODE: 136417472712832 (número Mariano) para bypass
Línea 944-954: Si NO es owner/familia/admin → silencio 9PM-6AM + domingos
Líneas 1000-1100: ENVÍO DE MENSAJE (AQUÍ ESTÁ EL BUG DE P1)
Líneas 4533-4663: Auto-init y auto-reconnect (busca sesiones en Firestore)
```

**PROBLEMA EN ENVÍO**: El código probablemente hace:
```javascript
sock.sendMessage('136417472712832@s.whatsapp.net', { text: respuesta })
```
Pero self-chat en Baileys es especial. Necesita:
- Usar `@lid` en lugar de `@s.whatsapp.net`?
- O usar método diferente (`sendTextMessage` vs `sendMessage`)?
- O enviar a un chat del tipo "Saved Messages"?

### tenant_manager.js (ZONA CRÍTICA 🚨)
```javascript
Líneas 90-146: processTenantMessage() — recibe mensajes de Baileys
Líneas 304-342: Filtrado de mensajes (permite fromMe para owner)
Línea 301: Event listener creds.update → guarda en Firestore
Líneas 208-290: startBaileysConnection() — reconecta Baileys
```

**PROBLEMA EN P2**: startBaileysConnection() busca creds pero:
- ¿Las deserializa correctamente?
- ¿Están expiradas?
- ¿Faltan campos críticos?

### baileys_session_store.js
```javascript
Línea 31: readCreds() → lee desde Firestore/baileys_sessions/{id}/data/creds
Línea 43: writeCreds() → escribe en Firestore
```
Usa BufferJSON para serializar Buffers. Si hay bug aquí, creds se corrompen.

---

## 🔑 CREDENCIALES Y JIDs (CRÍTICO)

### JID Format (Baileys vs WhatsApp Web)
```
OLD (whatsapp-web.js): 573161937365@c.us
NEW (Baileys):         573161937365@s.whatsapp.net  ← números normales
                       136417472712832@lid           ← linked device (self-chat)
```

### Número de Mariano
```
Número: 136417472712832
JID en self-chat: 136417472712832@lid
JID en envío: 136417472712832@s.whatsapp.net (¿INCORRECTO?)
UID: bq2BbtCVF8cZo30tum584zrGATJ3
```

### Firestore Paths
```
baileys_sessions/tenant-{uid}/data/creds        ← credenciales (Buffers)
users/{uid}                                      ← perfil usuario
users/{uid}/conversationHistory/{contactJid}    ← historial por contacto
```

---

## 📋 ÚLTIMOS 10 COMMITS (MÁS RECIENTES PRIMERO)

```
d12bb78  fix: restaurar variable isSelfChat para evitar ReferenceError
9cd901d  🔥 HOTFIX: Hardcodear número owner para bypass silencio nocturno
7a86c32  debug: agregar logging para creds.update y saveCreds
6da357c  debug: agregar logging de phone y basePhone en processMiiaResponse
2d785ed  fix: self-chat SIEMPRE responde (bypass silencio nocturno)
7200737  debug: logging para isSelfChat detection en silencio nocturno
bf3c22c  docs: agregar PLAN PENDIENTE con 11 tareas ordenadas por criticidad
53c2a3d  fix: detección robusta de self-chat para bypass de silencio nocturno
52cc2aa  fix: CRITICAL — remove broken onMessage handler, use normal Baileys flow
b662507  docs: update CLAUDE.md to reflect Baileys architecture
```

---

## 🧪 ÚLTIMOS LOGS DE ÉXITO (P1 Parcial)

```
[QR] ✅ Tenant is READY
[TM:bq2BbtCVF8cZo30tum584zrGATJ3] 📨 Message from 136417472712832@lid: "Hola miia"
[MIIA] ✅ Sesión abierta para 136417472712832@s.whatsapp.net
[GEMINI] Respuesta recibida, longitud: 151
[MIIA] Enviando mensaje a 136417472712832@s.whatsapp.net | isReady=true
[SENT] Mensaje enviado a 136417472712832
```

**PERO**: Mariano NO recibió el mensaje en su WhatsApp. El mensaje se pierde en algún lugar.

---

## ⚙️ VARIABLES CRÍTICAS EN RAILWAY

```
FIREBASE_PROJECT_ID=miia-app-8cbd0
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@miia-app-8cbd0.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=[1734 chars]
GEMINI_API_KEY=AIzaSyAnmgNUtrP1YhAXNiOf25J1U2uxObQuk28
PADDLE_API_KEY=[69 chars]
PADDLE_WEBHOOK_SECRET=[33 chars]
PADDLE_ENV=production
PADDLE_PRICE_MONTHLY=pri_01kn0wve28jw27wb5hacyayf1
PADDLE_PRICE_QUARTERLY=pri_01kn0wy9g89m0t7ez4n6wxbxy5
PADDLE_PRICE_SEMESTRAL=pri_01kn0wzbe1kxcrqr56pfafg960
PADDLE_PRICE_ANNUAL=pri_01kn0wzx5h68408femv77m7zpq
PADDLE_PRICE_AGENT_EXTRA=pri_01kn0x2qmvf740ww2ym132jfw5
PAYPAL_CLIENT_ID=[comienza con Absaff...]
PAYPAL_CLIENT_SECRET=[80 chars]
PAYPAL_ENV=production
```

---

## 📑 PLAN PENDIENTE (11 Tareas)

### 🔴 CRÍTICOS (P1-P4)
- [✅] **P1**: MIIA responde en self-chat — PARCIALMENTE (recibe/procesa pero no entrega)
- [ ] **P2**: Auto-reconnect sin clic manual — BLOQUEADO
- [ ] **P3**: Endpoint documentos roto en admin-dashboard
- [ ] **P4**: Exportar setTenantTrainingData en tenant_manager

### 🟡 IMPORTANTES (P5-P7)
- [ ] **P5**: Limpiar código muerto de whatsapp-web.js
- [ ] **P6**: cerebro_absoluto.js usa getChats() de whatsapp-web.js
- [ ] **P7**: Eliminar archivos obsoletos

### 🟢 MEJORAS (P8-P11)
- [ ] **P8**: Detección de festivos en silencio nocturno
- [ ] **P9**: Paddle — crear productos y configurar webhook
- [ ] **P10**: "Ver como usuario" en sidebar admin
- [ ] **P11**: Notificación email cuando WhatsApp se desconecta

---

## 🔍 CHECKLIST DE DEBUG PARA NUEVA SESIÓN

Si compactación ocurre:

1. ✅ Leer ESTE ARCHIVO (RESUMEN_EJECUTIVO_MIIA.md)
2. ✅ Leer CLAUDE.md para ALERTA CRÍTICA
3. ✅ Recordar: **LA ESENCIA = MIIA responde en self-chat**
4. ✅ Recordar: **P1 está 80% hecho, falta fix en envío a self-chat**
5. ✅ Revisar logs de Railway para estado actual
6. ✅ No asumir que Mariano perdió contexto — ÉL SÍ LO TIENE, TÚ NO
7. ✅ Preguntar primero qué está pasando, no sugerir soluciones

---

## 🎓 CONTEXTO EMPRESARIAL

**MIIA** = Bot de WhatsApp con IA para ventas B2B en Latinoamérica

- **Owner**: Mariano De Stefano (Admin UID: bq2BbtCVF8cZo30tum584zrGATJ3)
- **Modelo**: SaaS multi-tenant (cada vendedor tiene su MIIA en su WhatsApp)
- **IA**: Google Gemini 2.5-Flash (los modelos 2.0 y 1.5 devuelven 404, 2.5-pro devuelve 503)
- **Pagos**: Paddle (porque Stripe no opera en Colombia/Argentina)
- **Presupuesto gastado**: $250 USD en 3 días (Mariano controla costos, usa Haiku para 70% de tareas)

---

**RECUERDA**: Mariano lleva HORAS en esto. Cada compactación te roba contexto crítico.
Si pierdes información → pregunta, no adivines.
Si no entiendas algo → lee TODO este archivo antes de responder.

**URGENCIA ACTUAL**: Fix P1 (envío a self-chat) — TODO lo demás es espera.
