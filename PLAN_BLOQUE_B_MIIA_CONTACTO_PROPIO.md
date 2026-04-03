# BLOQUE B: MIIA como Contacto Propio — Plan Completo

**Fecha**: 2026-04-03
**Standard**: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
**Principio fundamental**: DUAL MODE — self-chat Y contacto propio coexisten. El usuario elige.

---

## 1. CONCEPTO ARQUITECTURAL

### El problema actual
MIIA vive en el self-chat del owner. Esto causa:
- Complejidad LID vs phone number (Device ID no matchea ADMIN_PHONES)
- `type=append` vs `type=notify` en self-chat
- Confusión del usuario: "¿por qué me hablo a mí mismo?"
- Los agentes no tienen forma natural de hablar con MIIA

### La solución: DUAL MODE
MIIA puede funcionar en **dos modos** que coexisten:

| Modo | Cómo funciona | Para quién |
|------|--------------|-----------|
| **Self-Chat** (actual) | Owner habla en su propio chat, MIIA responde ahí | Backward compatible, no requiere número extra |
| **Contacto Propio** (nuevo) | Owner/agentes agregan el número de MIIA como contacto y chatean directo | Más natural, escalable, elimina bugs de self-chat |

**Regla clave**: El modo se configura por usuario. Admin configura el número de MIIA. Cada owner/agente decide si usa self-chat o contacto propio. **Ambos modos deben funcionar simultáneamente.**

---

## 2. ARQUITECTURA TÉCNICA

### 2.1 Nuevo tenant: MIIA Bot

```
tenants Map:
├── tenant-{ownerUid}     → WhatsApp del owner (para leads, familia, etc.)
├── tenant-{agentUid}     → WhatsApp del agente
└── tenant-MIIA-BOT       → WhatsApp de MIIA (número propio) ← NUEVO
```

El "MIIA Bot tenant" es un tenant especial que:
- Tiene su propia sesión Baileys con su propio número
- Recibe mensajes de owners y agentes que le escriben
- Identifica QUIÉN le escribe comparando el número contra Firestore
- Rutea al contexto correcto (owner's cerebro, agente's contexto)

### 2.2 Estructura Firestore

```
miia_config/
├── bot_number        → { phone: '573054169969', enabled: true, sessionId: 'tenant-MIIA-BOT' }
│
users/{uid}/
├── (campos existentes)
├── miia_mode: 'self-chat' | 'contact' | 'both'    ← NUEVO
├── miia_bot_phone: '573054169969'                   ← NUEVO (referencia al bot)
│
users/{uid}/agents/{agentUid}/
├── miia_mode: 'self-chat' | 'contact' | 'both'    ← NUEVO (por agente)
```

### 2.3 Flujo de mensajes — Modo Contacto Propio

```
Owner escribe al número de MIIA (+573054169969)
    ↓
Baileys del MIIA Bot recibe el mensaje
    ↓
handleMiiaBotMessage(from, body, msg)   ← NUEVA FUNCIÓN
    ↓
Identificar quién escribe:
    ├── ¿Es un owner registrado? → Buscar en Firestore por phone number
    ├── ¿Es un agente registrado? → Buscar en Firestore por phone number
    └── ¿Es un desconocido? → Responder con info de registro / ignorar
    ↓
Cargar contexto del owner/agente:
    ├── Cerebro del negocio
    ├── Affinity data
    ├── Conversation history (separada: owner-miia vs owner-leads)
    └── Personal data (solo si es owner, no agente)
    ↓
Generar respuesta con IA (misma lógica que processMiiaResponse para self-chat)
    ↓
Enviar respuesta VIA EL NÚMERO DE MIIA (no via el WhatsApp del owner)
```

### 2.4 Flujo de mensajes — Los leads NO cambian

```
Lead escribe al WhatsApp del OWNER
    ↓
Baileys del OWNER recibe
    ↓
handleIncomingMessage() (SIN CAMBIOS)
    ↓
processMiiaResponse() responde COMO EL OWNER
    ↓
safeSendMessage() envía DESDE EL WHATSAPP DEL OWNER
```

**Los leads NUNCA interactúan con el número de MIIA.** Solo owners y agentes usan el contacto propio.

### 2.5 Flujo de mensajes — Contacto Grupo (familia, equipo, etc.)

**Sin cambios.** Los contactos grupo siguen escribiendo al WhatsApp del owner. MIIA responde ahí como siempre. El contacto propio de MIIA es solo para la comunicación owner/agente ↔ MIIA.

### 2.6 Comandos vía contacto propio

Cuando el owner escribe al número de MIIA, puede hacer **todo** lo que hoy hace en self-chat:
- "Hola MIIA" / "Chau MIIA"
- "Dile a [nombre] [mensaje]" → MIIA envía desde el WhatsApp del OWNER
- "STOP" / "REACTIVAR"
- "RESET AFFINITY [contacto]"
- "Cotización Colombia 1 usuario" → MIIA genera y envía al OWNER (o al lead si se especifica)
- "Aprende: [dato]"
- Preguntas, órdenes, conversación casual

**Diferencia clave con self-chat**: La respuesta llega como mensaje de MIIA (contacto), no como mensaje propio.

---

## 3. IMPLEMENTACIÓN — BACKEND

### 3.1 Nuevo archivo: `miia_bot_handler.js`

```javascript
/**
 * MIIA Bot Handler — Procesa mensajes que llegan al número propio de MIIA
 * 
 * Responsabilidades:
 * 1. Identificar quién escribe (owner, agente, desconocido)
 * 2. Cargar contexto del usuario (cerebro, affinity, historial)
 * 3. Rutear al procesamiento correcto
 * 4. Enviar respuesta VIA el número de MIIA
 * 
 * Standard: Google + Amazon + NASA
 * - Fail loudly: cada error se logea con [MIIA-BOT] prefix
 * - Exhaustive logging: cada paso del routing se logea
 * - Zero silent failures: si no puede identificar al usuario, responde con error
 */

const admin = require('firebase-admin');

// Cache de usuarios por número de teléfono (TTL 5 min)
const _userPhoneCache = {};
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Identifica quién escribe al número de MIIA
 * @param {string} phone - Número del remitente (sin @s.whatsapp.net)
 * @returns {object|null} { uid, role, name, ownerUid, miiaMode }
 */
async function identifyUser(phone) {
  // 1. Check cache
  const cached = _userPhoneCache[phone];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  
  // 2. Buscar en Firestore por whatsapp_owner_number
  try {
    // Buscar owners
    const ownerSnap = await admin.firestore().collection('users')
      .where('whatsapp_owner_number', '==', phone)
      .limit(1)
      .get();
    
    if (!ownerSnap.empty) {
      const doc = ownerSnap.docs[0];
      const data = { 
        uid: doc.id, 
        role: doc.data().role || 'client',
        name: doc.data().name || '',
        ownerUid: doc.id, // owners son su propio owner
        miiaMode: doc.data().miia_mode || 'self-chat'
      };
      _userPhoneCache[phone] = { data, ts: Date.now() };
      console.log(`[MIIA-BOT] ✅ Identificado: ${data.name} (${data.role}) — uid=${data.uid}`);
      return data;
    }
    
    // Buscar agentes (tienen whatsapp field del registro)
    const agentSnap = await admin.firestore().collection('users')
      .where('whatsapp', '==', phone)
      .where('role', '==', 'agent')
      .limit(1)
      .get();
    
    if (!agentSnap.empty) {
      const doc = agentSnap.docs[0];
      const data = {
        uid: doc.id,
        role: 'agent',
        name: doc.data().name || '',
        ownerUid: doc.data().parent_client_uid || doc.id,
        miiaMode: doc.data().miia_mode || 'contact'
      };
      _userPhoneCache[phone] = { data, ts: Date.now() };
      console.log(`[MIIA-BOT] ✅ Identificado agente: ${data.name} — owner=${data.ownerUid}`);
      return data;
    }
    
    // No encontrado
    console.log(`[MIIA-BOT] ❓ Número desconocido: ${phone}`);
    _userPhoneCache[phone] = { data: null, ts: Date.now() };
    return null;
    
  } catch (e) {
    console.error(`[MIIA-BOT] ❌ Error identificando ${phone}:`, e.message);
    return null;
  }
}

/**
 * Procesa un mensaje que llegó al número propio de MIIA
 * @param {string} from - JID del remitente
 * @param {string} body - Texto del mensaje
 * @param {object} baileysMsg - Mensaje original de Baileys
 * @param {object} miiaBotSock - Socket de Baileys del bot de MIIA
 * @param {object} deps - Dependencias { processMiiaResponse, safeSendMessage, ... }
 */
async function handleMiiaBotMessage(from, body, baileysMsg, miiaBotSock, deps) {
  const phone = from.split('@')[0];
  console.log(`[MIIA-BOT] 📩 Mensaje de ${phone}: "${body?.substring(0, 80)}..."`);
  
  // 1. Identificar quién escribe
  const user = await identifyUser(phone);
  
  if (!user) {
    // Desconocido: responder con info de registro
    await miiaBotSock.sendMessage(from, { 
      text: '¡Hola! Soy MIIA. Para usar mis servicios, tu empresa debe estar registrada. Visitá miia.app para más info.' 
    });
    console.log(`[MIIA-BOT] 🚫 Número desconocido ${phone} — enviado mensaje de registro`);
    return;
  }
  
  // 2. Verificar que el usuario tiene modo contacto habilitado
  if (user.miiaMode === 'self-chat') {
    // El usuario configuró solo self-chat — notificarle
    await miiaBotSock.sendMessage(from, {
      text: `${user.name}, tenés configurado el modo self-chat. Si querés hablarme por acá, activá el modo "contacto" en tu dashboard.`
    });
    console.log(`[MIIA-BOT] ℹ️ ${user.name} tiene modo self-chat — notificado`);
    return;
  }
  
  // 3. Rutear al procesamiento correcto
  // El mensaje se procesa como si fuera self-chat del owner/agente,
  // pero la respuesta se envía por el número de MIIA (no por self-chat)
  console.log(`[MIIA-BOT] 🔀 Ruteando mensaje de ${user.name} (${user.role}) al procesamiento`);
  
  // Guardar en historial separado: miia_bot_conversations
  const conversationKey = `miia-bot:${user.uid}`;
  
  // Delegar al procesamiento existente con flag especial
  await deps.processMiiaBotResponse({
    userUid: user.uid,
    ownerUid: user.ownerUid,
    role: user.role,
    userName: user.name,
    phone: from,
    body,
    baileysMsg,
    miiaBotSock,
    conversationKey
  });
}

module.exports = {
  handleMiiaBotMessage,
  identifyUser
};
```

### 3.2 Cambios en `server.js`

#### A. Configuración del MIIA Bot al startup

```javascript
// En la sección de auto-init (línea ~5520)

// 1.6. Inicializar MIIA Bot si está configurado
const miiaBotConfig = await admin.firestore().collection('miia_config').doc('bot_number').get();
if (miiaBotConfig.exists && miiaBotConfig.data().enabled) {
  const botPhone = miiaBotConfig.data().phone;
  console.log(`[MIIA-BOT] 🤖 Bot configurado con número: ${botPhone}`);
  
  const miiaBotTenant = tenantManager.initTenant(
    'MIIA-BOT',
    process.env.GEMINI_API_KEY || geminiApiKey,
    io,
    {},
    {
      onMessage: (baileysMsg, from, body) => {
        // No procesar mensajes propios del bot
        if (baileysMsg.key.fromMe) return;
        
        const { handleMiiaBotMessage } = require('./miia_bot_handler');
        handleMiiaBotMessage(from, body, baileysMsg, miiaBotTenant.sock, {
          processMiiaBotResponse: processMiiaBotResponse
        });
      },
      onReady: (sock) => {
        const realNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
        console.log(`[MIIA-BOT] ✅ MIIA Bot conectado — número: ${realNumber}`);
      },
      ownerUid: 'MIIA-BOT',
      role: 'owner'
    }
  );
} else {
  console.log('[MIIA-BOT] ℹ️ Bot no configurado o deshabilitado');
}
```

#### B. Nueva función: processMiiaBotResponse

```javascript
/**
 * Procesa un mensaje que llegó al MIIA Bot y genera respuesta
 * Reutiliza la lógica de processMiiaResponse pero envía por el bot
 * 
 * @param {object} ctx - Contexto del mensaje
 */
async function processMiiaBotResponse(ctx) {
  const { userUid, ownerUid, role, userName, phone, body, miiaBotSock, conversationKey } = ctx;
  
  console.log(`[MIIA-BOT] 🧠 Procesando para ${userName} (${role}, owner=${ownerUid})`);
  
  try {
    // 1. Cargar perfil del owner (para cerebro, familyContacts, etc.)
    const ownerDoc = await admin.firestore().collection('users').doc(ownerUid).get();
    if (!ownerDoc.exists) {
      console.error(`[MIIA-BOT] ❌ Owner ${ownerUid} no existe en Firestore`);
      await miiaBotSock.sendMessage(phone, { text: 'Error: no encontré tu perfil. Contactá soporte.' });
      return;
    }
    
    // 2. Inicializar conversación si no existe
    if (!conversations[conversationKey]) conversations[conversationKey] = [];
    conversations[conversationKey].push({ role: 'user', content: body, timestamp: Date.now() });
    
    // Mantener últimos 40 mensajes
    if (conversations[conversationKey].length > 40) {
      conversations[conversationKey] = conversations[conversationKey].slice(-40);
    }
    
    // 3. Construir prompt — MISMA lógica que self-chat del owner
    // Pero indicando que es via contacto propio (no self-chat)
    const activeSystemPrompt = buildOwnerSelfChatPrompt(ownerDoc.data());
    
    // 4. Inyectar contexto de affinity y fecha
    const trustTone = '\n' + getAffinityToneForPrompt(phone, userName, false);
    
    // 5. Generar historial para IA
    const historyForAI = conversations[conversationKey].map(m => ({
      role: m.role, content: m.content
    }));
    
    // 6. Llamar a IA
    const aiResponse = await generateAIContent(
      activeSystemPrompt + trustTone + '\n\n' +
      historyForAI.map(m => `${m.role === 'user' ? userName : 'MIIA'}: ${m.content}`).join('\n')
    );
    
    if (!aiResponse) {
      console.error(`[MIIA-BOT] ❌ IA no generó respuesta para ${userName}`);
      return;
    }
    
    // 7. Procesar tags de aprendizaje
    let cleanResponse = aiResponse;
    // (reutilizar processLearningTags con contexto del owner)
    
    // 8. Interceptar comandos (DILE A, STOP, RESET, etc.)
    const isCommand = await processAdminCommand(cleanResponse, body, ownerUid, phone, role);
    if (isCommand) return; // El comando ya fue ejecutado
    
    // 9. Guardar respuesta en historial
    conversations[conversationKey].push({ role: 'assistant', content: cleanResponse, timestamp: Date.now() });
    
    // 10. Enviar respuesta VIA EL NÚMERO DE MIIA (no self-chat)
    await miiaBotSock.sendMessage(phone, { text: cleanResponse });
    console.log(`[MIIA-BOT] ✅ Respuesta enviada a ${userName} (${cleanResponse.length} chars)`);
    
    // 11. Persistir
    saveDB();
    
  } catch (e) {
    console.error(`[MIIA-BOT] ❌ Error procesando mensaje de ${userName}:`, e.message);
    await miiaBotSock.sendMessage(phone, { text: 'Ups, tuve un error procesando tu mensaje. Intentá de nuevo.' });
  }
}
```

#### C. Comando "DILE A" desde contacto propio

Cuando el owner dice "dile a mamá que la quiero" al contacto de MIIA:
1. MIIA procesa el comando
2. MIIA envía el mensaje **DESDE EL WHATSAPP DEL OWNER** (no desde su propio número)
3. La mamá ve que el mensaje viene de su hijo (no de MIIA)

```javascript
// Dentro de processAdminCommand():
if (isAdmin && effectiveMsg.match(/^dile\s+a\s+/i)) {
  // ... parsing existente ...
  
  // DIFERENCIA: enviar desde el WhatsApp del owner, no del bot
  const ownerSock = tenantManager.getTenantClient(ownerUid);
  if (!ownerSock) {
    console.error(`[MIIA-BOT] ❌ Owner ${ownerUid} no tiene WhatsApp conectado`);
    await miiaBotSock.sendMessage(phone, { text: 'Tu WhatsApp no está conectado. Conectalo desde el dashboard.' });
    return true;
  }
  
  await ownerSock.sendMessage(targetSerialized, { text: mensajeGenerado });
  console.log(`[MIIA-BOT] ✅ "Dile a" ejecutado: ${familyInfo.name} ← via WhatsApp del owner`);
  
  // Confirmar al owner VIA el contacto de MIIA
  await miiaBotSock.sendMessage(phone, { text: `Listo, le escribí a ${familyInfo.name}.` });
  return true;
}
```

### 3.3 Cambios en `tenant_manager.js`

**Mínimos.** El MIIA Bot es un tenant normal. Solo necesitamos:

1. **No minar ADN** del bot (no tiene conversaciones históricas propias):
```javascript
// En startBaileysConnection(), sección de ADN mining:
if (uid === 'MIIA-BOT') {
  console.log('[MIIA-BOT] Skipping ADN mining for bot tenant');
  return; // No minar
}
```

2. **Logging diferenciado**:
```javascript
const logPrefix = uid === 'MIIA-BOT' ? '[MIIA-BOT]' : `[TM:${uid}]`;
```

### 3.4 Nuevos endpoints en `server.js`

```javascript
// ── MIIA BOT CONFIG ────────────────────────────────────────────

// GET /api/miia-bot/status — Estado del bot
app.get('/api/miia-bot/status', authenticateToken, async (req, res) => {
  try {
    const config = await admin.firestore().collection('miia_config').doc('bot_number').get();
    const tenant = tenantManager.getTenantStatus('MIIA-BOT');
    res.json({
      configured: config.exists,
      enabled: config.exists ? config.data().enabled : false,
      phone: config.exists ? config.data().phone : null,
      connected: tenant?.isReady || false,
      qrCode: tenant?.qrCode || null
    });
  } catch (e) {
    console.error('[MIIA-BOT] Error obteniendo status:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/miia-bot/configure — Configurar número del bot (solo admin)
app.post('/api/miia-bot/configure', authenticateToken, requireAdmin, express.json(), async (req, res) => {
  try {
    const { phone, enabled } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    
    await admin.firestore().collection('miia_config').doc('bot_number').set({
      phone: phone.replace(/[^0-9]/g, ''),
      enabled: enabled !== false,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    
    console.log(`[MIIA-BOT] ✅ Configurado: ${phone}, enabled=${enabled}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[MIIA-BOT] Error configurando:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/miia-bot/connect — Iniciar conexión del bot (genera QR)
app.post('/api/miia-bot/connect', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const config = await admin.firestore().collection('miia_config').doc('bot_number').get();
    if (!config.exists || !config.data().enabled) {
      return res.status(400).json({ error: 'Bot no configurado o deshabilitado' });
    }
    
    const tenant = tenantManager.initTenant('MIIA-BOT', geminiApiKey, io, {}, {
      onMessage: (baileysMsg, from, body) => {
        if (baileysMsg.key.fromMe) return;
        const { handleMiiaBotMessage } = require('./miia_bot_handler');
        handleMiiaBotMessage(from, body, baileysMsg, tenant.sock, {
          processMiiaBotResponse
        });
      },
      onReady: (sock) => {
        console.log(`[MIIA-BOT] ✅ Conectado: ${sock.user?.id}`);
      },
      ownerUid: 'MIIA-BOT',
      role: 'owner'
    });
    
    res.json({ ok: true, status: 'initializing' });
  } catch (e) {
    console.error('[MIIA-BOT] Error conectando:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/miia-mode — Cambiar modo MIIA del usuario
app.put('/api/tenant/:uid/miia-mode', authenticateToken, express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { mode } = req.body; // 'self-chat' | 'contact' | 'both'
    
    if (!['self-chat', 'contact', 'both'].includes(mode)) {
      return res.status(400).json({ error: 'mode debe ser: self-chat, contact, o both' });
    }
    
    await admin.firestore().collection('users').doc(uid).update({
      miia_mode: mode,
      miia_mode_updated_at: new Date().toISOString()
    });
    
    console.log(`[MIIA-BOT] ✅ Modo de ${uid} cambiado a: ${mode}`);
    res.json({ ok: true, mode });
  } catch (e) {
    console.error('[MIIA-BOT] Error cambiando modo:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

---

## 4. IMPLEMENTACIÓN — REGISTRO DE AGENTES

### 4.1 Flujo completo

```
Owner va a dashboard → "Invitar Agente"
    ↓
Sistema genera link único: miia.app/register-agent?invite={inviteId}
    ↓
Owner comparte link con el agente (email, WhatsApp, etc.)
    ↓
Agente abre link → Web de registro
    ↓
Formulario:
  - Nombre completo (obligatorio)
  - Número WhatsApp (obligatorio)
  - Email (obligatorio)
  - Contraseña (obligatorio)
  - Pasiones / intereses (opcional)
  - Contactos familiares (opcional — para que MIIA los conozca)
    ↓
Agente envía formulario
    ↓
Backend:
  1. Valida invite en Firestore
  2. Crea usuario en Firebase Auth
  3. Crea doc en Firestore con role='agent', parent_client_uid=ownerUid
  4. Envía email de verificación
  5. Envía email al owner: "Tu agente X se registró"
    ↓
Agente verifica email → Accede a agent-dashboard.html
    ↓
Agente agrega +573054169969 a sus contactos de WhatsApp
    ↓
MIIA Bot detecta al agente → Le da bienvenida personalizada
```

### 4.2 Nuevo archivo frontend: `register-agent.html`

**Campos del formulario:**

| Campo | Obligatorio | Para qué |
|-------|------------|----------|
| Nombre completo | ✅ | Identificación en el sistema |
| Número WhatsApp | ✅ | Para que MIIA lo reconozca cuando le escriba |
| Email | ✅ | Login + notificaciones |
| Contraseña | ✅ | Firebase Auth |
| Pasiones / intereses | ❌ | MIIA personaliza sus interacciones |
| Contactos familiares | ❌ | MIIA conoce el círculo del agente |

**Explicación de cada campo en la UI:**

- **Nombre completo**: "Así te llamará MIIA y aparecerás en el panel de tu equipo."
- **WhatsApp**: "MIIA te escribirá por acá. Agrega +573054169969 a tus contactos para hablar con ella."
- **Pasiones**: "MIIA se adapta a vos. Contale qué te apasiona: fútbol, cocina, F1... Ella usará esto para conectar mejor."
- **Contactos familiares**: "Si querés, contale de tu familia. MIIA puede ayudarte con recordatorios, cumpleaños, y más."

### 4.3 Nuevo endpoint backend

```javascript
// POST /api/agent/register — Auto-registro de agente via invite link
app.post('/api/agent/register', express.json(), async (req, res) => {
  try {
    const { inviteId, name, whatsapp, email, password, passions, familyContacts } = req.body;
    
    // 1. Validar invite
    if (!inviteId) return res.status(400).json({ error: 'inviteId requerido' });
    
    const inviteDoc = await admin.firestore().collection('agent_invites').doc(inviteId).get();
    if (!inviteDoc.exists) return res.status(404).json({ error: 'Invitación no encontrada' });
    
    const invite = inviteDoc.data();
    if (invite.used) return res.status(400).json({ error: 'Invitación ya utilizada' });
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'Invitación expirada' });
    }
    
    // 2. Validar campos obligatorios
    if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    if (!whatsapp?.trim()) return res.status(400).json({ error: 'WhatsApp requerido' });
    if (!email?.trim()) return res.status(400).json({ error: 'Email requerido' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
    
    // 3. Crear usuario en Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: email.trim(),
      password,
      displayName: name.trim()
    });
    
    // 4. Crear documento en Firestore
    const cleanPhone = whatsapp.replace(/[^0-9]/g, '');
    await admin.firestore().collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      name: name.trim(),
      email: email.trim(),
      whatsapp: cleanPhone,
      role: 'agent',
      parent_client_uid: invite.ownerUid,
      plan: invite.plan || 'trial',
      passions: passions?.trim() || '',
      familyContacts: familyContacts || [],
      miia_mode: 'contact', // Agentes usan contacto propio por defecto
      registered_at: new Date().toISOString(),
      invite_id: inviteId,
      approved: true
    });
    
    // 5. Marcar invite como usada
    await admin.firestore().collection('agent_invites').doc(inviteId).update({
      used: true,
      usedBy: userRecord.uid,
      usedAt: new Date().toISOString()
    });
    
    // 6. Notificar al owner
    const ownerDoc = await admin.firestore().collection('users').doc(invite.ownerUid).get();
    if (ownerDoc.exists) {
      console.log(`[AGENT-REG] ✅ Agente ${name} registrado para owner ${ownerDoc.data().name}`);
      // TODO: enviar email al owner
    }
    
    console.log(`[AGENT-REG] ✅ Agente creado: ${userRecord.uid} (${name}, ${cleanPhone})`);
    res.json({ ok: true, uid: userRecord.uid });
    
  } catch (e) {
    console.error('[AGENT-REG] ❌ Error registrando agente:', e.message);
    if (e.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email ya registrado' });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/invite — Owner crea invitación para agente
app.post('/api/agent/invite', authenticateToken, express.json(), async (req, res) => {
  try {
    const { uid } = req.user; // Owner que invita
    const { agentName, agentEmail } = req.body;
    
    if (!agentName?.trim()) return res.status(400).json({ error: 'Nombre del agente requerido' });
    
    // Verificar límite de agentes del plan
    const ownerDoc = await admin.firestore().collection('users').doc(uid).get();
    const plan = ownerDoc.data()?.plan || 'trial';
    const agentsLimit = ownerDoc.data()?.agents_limit || 1;
    
    const existingAgents = await admin.firestore().collection('users')
      .where('parent_client_uid', '==', uid)
      .where('role', '==', 'agent')
      .get();
    
    if (existingAgents.size >= agentsLimit) {
      return res.status(400).json({ error: `Tu plan permite máximo ${agentsLimit} agente(s)` });
    }
    
    // Crear invitación
    const inviteRef = admin.firestore().collection('agent_invites').doc();
    const invite = {
      id: inviteRef.id,
      ownerUid: uid,
      ownerName: ownerDoc.data()?.name || '',
      agentName: agentName.trim(),
      agentEmail: agentEmail?.trim() || '',
      plan,
      used: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 días
    };
    
    await inviteRef.set(invite);
    
    const inviteUrl = `https://miia-frontend-one.vercel.app/register-agent.html?invite=${inviteRef.id}`;
    
    console.log(`[AGENT-INVITE] ✅ Invitación creada: ${inviteRef.id} para ${agentName}`);
    res.json({ ok: true, inviteId: inviteRef.id, inviteUrl });
    
  } catch (e) {
    console.error('[AGENT-INVITE] ❌ Error creando invitación:', e.message);
    res.status(500).json({ error: e.message });
  }
});
```

---

## 5. IMPLEMENTACIÓN — FRONTEND

### 5.1 Cambios en `admin-dashboard.html`

Nueva sección en Conexiones → "MIIA Bot":
- Card con estado del bot (conectado/desconectado)
- Input para configurar número del bot
- Botón "Conectar" → muestra QR
- Toggle enabled/disabled

### 5.2 Cambios en `owner-dashboard.html`

- Nueva sección: "Modo MIIA" con toggle:
  - Self-Chat (actual)
  - Contacto Propio (nuevo)
  - Ambos
- Si elige "Contacto Propio": mostrar instrucciones para agregar a MIIA como contacto
- Botón "Invitar Agente" → genera link y lo muestra/copia/envía por email

### 5.3 Cambios en `agent-dashboard.html`

- Mostrar modo MIIA configurado
- Si modo contacto: instrucciones para agregar a MIIA
- Botón para cambiar modo

### 5.4 Nuevo archivo: `register-agent.html`

Página standalone para registro de agentes vía invite link.
- Diseño limpio, mobile-first
- Explicación de cada campo
- Validación en frontend antes de enviar
- Redirect a agent-dashboard.html después de verificación

---

## 6. COEXISTENCIA DE MODOS — REGLAS

### 6.1 Modo Self-Chat
- MIIA responde en el self-chat del usuario
- Comandos se procesan en self-chat
- Notificaciones (hartazgo, patrones, etc.) llegan al self-chat
- **Sin cambios** respecto a la implementación actual

### 6.2 Modo Contacto Propio
- MIIA responde en el chat con su número propio
- Comandos se procesan vía el contacto de MIIA
- Notificaciones llegan vía el contacto de MIIA
- "Dile a" se envía DESDE el WhatsApp del owner (no desde MIIA)

### 6.3 Modo Ambos
- MIIA responde en AMBOS canales
- El usuario puede escribir en cualquiera de los dos
- Las notificaciones van al contacto de MIIA (preferencia)
- El historial se comparte entre ambos modos (misma conversationKey)
- Si el usuario escribe en self-chat, MIIA responde en self-chat
- Si el usuario escribe al contacto de MIIA, MIIA responde ahí

### 6.4 Transición de modos
- Si el usuario cambia de self-chat a contacto → el historial migra
- Si cambia de contacto a self-chat → el historial migra
- La affinity NO se pierde al cambiar de modo
- Los comandos funcionan igual en ambos modos

---

## 7. SEGURIDAD

### 7.1 Quién puede escribir al MIIA Bot
- Solo usuarios registrados en Firestore (owners + agentes)
- Desconocidos reciben mensaje genérico de registro
- Rate limiting por número: máx 60 msg/hora (igual que leads)

### 7.2 Aislamiento de datos
- Cada owner/agente solo ve su propio contexto
- MIIA Bot identifica al usuario por número antes de procesar
- Un agente no puede ver datos de otro owner
- El cerebro del negocio es compartido entre owner y sus agentes

### 7.3 Invitaciones
- Expiran en 7 días
- Solo se pueden usar una vez
- El owner puede revocarlas desde el dashboard
- Validación de límite de agentes por plan

---

## 8. LOGGING — Standard NASA

Todos los logs del MIIA Bot usan el prefijo `[MIIA-BOT]`:

| Log | Significado |
|-----|-----------|
| `[MIIA-BOT] 📩 Mensaje de 573054169969: "Hola MIIA..."` | Mensaje recibido |
| `[MIIA-BOT] ✅ Identificado: Mariano (client) — uid=bq2BbtCVF8...` | Usuario reconocido |
| `[MIIA-BOT] ❓ Número desconocido: 573001234567` | No está en Firestore |
| `[MIIA-BOT] 🔀 Ruteando mensaje de Mariano (client) al procesamiento` | Routing |
| `[MIIA-BOT] ✅ Respuesta enviada a Mariano (145 chars)` | Respuesta OK |
| `[MIIA-BOT] ❌ Error procesando mensaje de Mariano: timeout` | Error con contexto |
| `[MIIA-BOT] 🚫 Número desconocido 573001234567 — enviado mensaje de registro` | Desconocido |
| `[MIIA-BOT] ℹ️ Mariano tiene modo self-chat — notificado` | Modo incorrecto |
| `[AGENT-REG] ✅ Agente Juan creado: abc123 (573001234567)` | Registro agente |
| `[AGENT-INVITE] ✅ Invitación creada: inv789 para Juan` | Invite creada |

---

## 9. MIGRACIÓN — Sin breaking changes

### Paso 1: Agregar campos a Firestore (sin afectar producción)
- `miia_config/bot_number` → documento nuevo
- `users/{uid}.miia_mode` → campo nuevo, default 'self-chat' (backward compatible)

### Paso 2: Agregar miia_bot_handler.js (archivo nuevo, sin tocar existentes)

### Paso 3: Agregar endpoints nuevos en server.js (no modifican endpoints existentes)

### Paso 4: Agregar lógica de init del MIIA Bot al startup (con guard `if config exists`)

### Paso 5: Frontend — nuevas secciones en dashboards (no reemplazan las existentes)

### Paso 6: register-agent.html (archivo nuevo)

**CERO breaking changes.** Todo es aditivo. El sistema actual sigue funcionando exactamente igual.

---

## 10. ORDEN DE IMPLEMENTACIÓN

```
B1. [Backend] Crear miia_bot_handler.js                    ← 1-2 horas
B2. [Backend] Agregar processMiiaBotResponse en server.js   ← 2-3 horas
B3. [Backend] Agregar endpoints MIIA Bot config              ← 1 hora
B4. [Backend] Agregar init MIIA Bot al startup               ← 30 min
B5. [Backend] Agregar endpoints agent invite/register        ← 1-2 horas
B6. [Firestore] Crear miia_config/bot_number                 ← 5 min
B7. [Frontend] Sección MIIA Bot en admin-dashboard           ← 1-2 horas
B8. [Frontend] Modo MIIA + Invitar Agente en owner-dashboard ← 2-3 horas
B9. [Frontend] register-agent.html                           ← 2-3 horas
B10. [Frontend] Actualizar agent-dashboard con modo MIIA     ← 1 hora
B11. [Testing] Probar dual mode end-to-end                   ← 1-2 horas
B12. [Deploy] Push + verificar en Railway/Vercel              ← 30 min
```

**Estimación total: 12-18 horas de implementación**

---

## 11. DECISIONES TÉCNICAS CLAVE

| Decisión | Justificación |
|----------|-------------|
| MIIA Bot es un tenant normal | Reutiliza toda la infraestructura de Baileys + Firestore |
| Un solo número de MIIA para todos | Simplifica. Multi-número es fase futura |
| Historial separado por (bot:uid) | Aísla conversaciones owner↔MIIA de owner↔leads |
| Default self-chat para owners existentes | Zero breaking changes |
| Default contacto para agentes nuevos | Los agentes no tienen self-chat útil |
| Invites con expiración 7 días | Seguridad sin friccón |
| Cache de identifyUser con TTL 5min | Evita N queries a Firestore por mensaje |

---

*Plan generado — Sesión 9, 2026-04-03*
*Standard: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)*
