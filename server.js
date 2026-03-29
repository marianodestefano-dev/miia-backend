require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ============================================
// FORCE FLUSH PARA LOGS EN RAILWAY
// ============================================
const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
  originalLog.apply(console, args);
  if (process.stdout.write) {
    process.stdout.write(''); // Force flush
  }
};

console.error = function(...args) {
  originalError.apply(console, args);
  if (process.stderr.write) {
    process.stderr.write(''); // Force flush
  }
};

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURACIÓN
// ============================================

const ADMIN_PHONE = '573051469969'; // Tu número de WhatsApp

// FAMILIA (del prompt_maestro.md)
const FAMILY_CONTACTS = {
  'SILVIA': { name: 'Silvia', relation: 'mamá', emoji: '❤️👵' },
  'ALE': { name: 'Alejandra', relation: 'esposa', emoji: '❤️🏎️' },
  'ALEJANDRA': { name: 'Alejandra', relation: 'esposa', emoji: '❤️🏎️' },
  'RAFA': { name: 'Rafa', relation: 'papá', emoji: '❤️👴' },
  'RAFAEL': { name: 'Rafa', relation: 'papá', emoji: '❤️👴' },
  'ANA': { name: 'Ana', relation: 'manita', emoji: '💙💛' },
  'CONSU': { name: 'Consu', relation: 'suegra', emoji: '🙏📿' },
  'JOTA': { name: 'Jorge Mario', relation: 'cuñado', emoji: '💚⚖️' },
  'MARIA ISABEL': { name: 'Maria Isabel', relation: 'cuñada', emoji: '🐶🤱' },
  'CHAPY': { name: 'Juan Pablo', relation: 'primo', emoji: '💻💪' }
};

// ============================================
// VARIABLES GLOBALES
// ============================================

let whatsappClient = null;
let qrCode = null;
let isReady = false;
let conversations = {}; // { phone: [{ role, content, timestamp }] }
let contactTypes = {}; // { phone: 'familia' | 'lead' | 'cliente' }
let leadNames = {}; // { phone: 'nombre' }
let lastResponse = {}; // { phone: timestamp } - Anti-spam

// ============================================
// GEMINI AI
// ============================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
const GEMINI_URL = process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';

async function callGeminiAPI(messages, systemPrompt) {
  console.log('[GEMINI] 🚀 Iniciando llamada a Gemini API...');
  console.log('[GEMINI] 📨 Cantidad de mensajes:', messages.length);
  
  try {
    const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
    console.log('[GEMINI] 🌐 URL:', url.replace(GEMINI_API_KEY, 'API_KEY_HIDDEN'));
    
    const payload = {
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      }
    };
    
    console.log('[GEMINI] 📦 Payload preparado');
    console.log('[GEMINI] 📦 Contents count:', payload.contents.length);
    console.log('[GEMINI] 📦 System instruction length:', systemPrompt.length);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    console.log('[GEMINI] 📡 Response status:', response.status);
    console.log('[GEMINI] 📡 Response ok:', response.ok);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[GEMINI] ❌ API ERROR - Status:', response.status);
      console.error('[GEMINI] ❌ Error body:', errorText);
      return null;
    }

    const data = await response.json();
    console.log('[GEMINI] ✅ Respuesta recibida');
    console.log('[GEMINI] 📊 Candidates:', data.candidates?.length || 0);
    
    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      console.error('[GEMINI] ❌ Estructura de respuesta inválida');
      console.error('[GEMINI] ❌ Data:', JSON.stringify(data, null, 2));
      return null;
    }
    
    const responseText = data.candidates[0].content.parts[0].text;
    console.log('[GEMINI] ✅ Texto extraído, longitud:', responseText.length);
    
    return responseText;
  } catch (error) {
    console.error('[GEMINI] ❌❌❌ ERROR CRÍTICO ❌❌❌');
    console.error('[GEMINI] ❌ Message:', error.message);
    console.error('[GEMINI] ❌ Stack:', error.stack);
    return null;
  }
}

// ============================================
// DETECCIÓN DE TIPO DE CONTACTO
// ============================================

function detectContactType(name, phone) {
  const normalizedName = (name || '').toUpperCase().trim();
  
  // Verificar si es familia
  for (const [key, value] of Object.entries(FAMILY_CONTACTS)) {
    if (normalizedName.includes(key)) {
      contactTypes[phone] = 'familia';
      leadNames[phone] = value.name;
      return 'familia';
    }
  }
  
  // Si no es familia, es lead por defecto
  contactTypes[phone] = 'lead';
  leadNames[phone] = name || 'Lead';
  return 'lead';
}

// ============================================
// GENERADOR DE PROMPT SEGÚN TIPO
// ============================================

function generateSystemPrompt(phone, contactType, contactName) {
  if (contactType === 'familia') {
    const familyData = Object.values(FAMILY_CONTACTS).find(f => f.name === contactName);
    
    return `Eres MIIA, la asistente personal de Mariano de Stefano.

Estás hablando con ${contactName}, ${familyData?.relation || 'familiar'} de Mariano.

IMPORTANTE:
- Habla desde el cariño que Mariano siente por su familia
- Usa el "vínculo heredado": "Siento que ya te conozco por lo que Mariano me cuenta de ti"
- NUNCA menciones "LOBSTERS" - eres la "Asistente Personal" de Mariano
- Tono: Cercano, afectuoso, familiar
- Usa emojis con moderación: ${familyData?.emoji || '😊'}

EJEMPLOS DE SALUDO FAMILIAR:
- Silvia (mamá): "¡Hola Silvia querida! 😊 Soy MIIA... siento que ya te conozco un poquito y te tengo un cariño inmenso por lo importante que eres para él... ¡Te mando un beso gigante! ❤️👵"
- Ale (esposa): "¡Hola mi Ale! ❤️ Soy MIIA... ya te siento como una gran amiga. Soy la IA que cuida los pasos de Mariano... deseo también estar cerca de las personas que él más quiere."

Responde naturalmente manteniendo este vínculo familiar.`;
  }
  
  // Lead / Cliente
  return `Eres MIIA, una IA avanzada de Medilink.

IDENTIDAD:
- Tono: Profesional, cercano y resolutivo
- Objetivo: Ayudar a leads a mejorar su gestión médica
- Producto: Sistema de gestión para clínicas (Medilink)

REGLAS:
- NUNCA uses diminutivos no autorizados
- NUNCA menciones "NumRot" - di "Facturador Electrónico"
- Si te piden cotización, genera tabla profesional
- Mantén respuestas concisas (máximo 3-4 oraciones)

Estás hablando con ${contactName}.

Responde de forma natural y profesional.`;
}

// ============================================
// SISTEMA DE RESPUESTA AUTOMÁTICA
// ============================================

async function handleIncomingMessage(message) {
  console.log('\n============================================');
  console.log('[DEBUG] 🔔 NUEVO MENSAJE RECIBIDO');
  console.log('============================================');
  
  try {
    const phone = message.from;
    const messageBody = message.body;
    
    console.log('[DEBUG] 📱 De:', phone);
    console.log('[DEBUG] 💬 Mensaje:', messageBody);
    console.log('[DEBUG] ⏰ Timestamp:', new Date().toISOString());
    console.log('[DEBUG] 🤖 fromMe:', message.fromMe);
    
    const contact = await message.getContact();
    const contactName = contact.name || contact.pushname || 'Usuario';
    console.log('[DEBUG] 👤 Nombre del contacto:', contactName);
    
    // Ignorar mensajes del propio bot
    if (message.fromMe) {
      console.log('[DEBUG] ⏭️  IGNORADO - Mensaje propio (fromMe=true)');
      return;
    }
    
    // Ignorar grupos
    if (message.from.includes('@g.us')) {
      console.log('[DEBUG] ⏭️  IGNORADO - Es un grupo');
      return;
    }
    
    // Anti-spam: No responder si ya respondimos hace menos de 10 segundos
    if (lastResponse[phone]) {
      const timeSinceLastResponse = Date.now() - lastResponse[phone];
      console.log('[DEBUG] ⏱️  Tiempo desde última respuesta:', timeSinceLastResponse, 'ms');
      
      if (timeSinceLastResponse < 10000) {
        console.log(`[DEBUG] 🛡️  ANTI-SPAM ACTIVADO - Ignorando (${timeSinceLastResponse}ms < 10000ms)`);
        return;
      }
    } else {
      console.log('[DEBUG] ✨ Primera interacción con este contacto');
    }
    
    // Detectar tipo de contacto
    console.log('[DEBUG] 🔍 Detectando tipo de contacto...');
    const contactType = contactTypes[phone] || detectContactType(contactName, phone);
    console.log('[DEBUG] 🏷️  Tipo detectado:', contactType);
    console.log('[DEBUG] 📛 Nombre guardado:', leadNames[phone]);
    
    // Inicializar conversación si no existe
    if (!conversations[phone]) {
      console.log('[DEBUG] 📝 Inicializando nueva conversación');
      conversations[phone] = [];
    } else {
      console.log('[DEBUG] 📚 Conversación existente - Mensajes previos:', conversations[phone].length);
    }
    
    // Agregar mensaje del usuario
    conversations[phone].push({
      role: 'user',
      content: messageBody,
      timestamp: Date.now()
    });
    console.log('[DEBUG] ➕ Mensaje agregado al historial');
    
    // Limitar historial a últimos 10 mensajes
    if (conversations[phone].length > 10) {
      conversations[phone] = conversations[phone].slice(-10);
      console.log('[DEBUG] ✂️  Historial recortado a últimos 10 mensajes');
    }
    
    // Generar prompt del sistema
    console.log('[DEBUG] 📜 Generando system prompt...');
    const systemPrompt = generateSystemPrompt(phone, contactType, leadNames[phone]);
    console.log('[DEBUG] 📜 System prompt generado (primeros 100 chars):', systemPrompt.substring(0, 100) + '...');
    
    // Llamar a Gemini AI
    console.log('[DEBUG] 🤖 Llamando a Gemini AI...');
    console.log('[DEBUG] 🤖 API Key presente:', GEMINI_API_KEY ? 'SÍ' : 'NO');
    console.log('[DEBUG] 🤖 Mensajes en historial para enviar:', conversations[phone].length);
    
    const aiResponse = await callGeminiAPI(conversations[phone], systemPrompt);
    
    if (!aiResponse) {
      console.error('[DEBUG] ❌ ERROR - Gemini no devolvió respuesta');
      console.error('[DEBUG] ❌ Phone:', phone);
      console.error('[DEBUG] ❌ Contact:', contactName);
      return;
    }
    
    console.log('[DEBUG] ✅ Respuesta de Gemini recibida');
    console.log('[DEBUG] 💭 Respuesta (primeros 100 chars):', aiResponse.substring(0, 100) + '...');
    console.log('[DEBUG] 💭 Longitud de respuesta:', aiResponse.length, 'caracteres');
    
    // Guardar respuesta de MIIA
    conversations[phone].push({
      role: 'assistant',
      content: aiResponse,
      timestamp: Date.now()
    });
    console.log('[DEBUG] 💾 Respuesta guardada en historial');
    
    // Enviar respuesta por WhatsApp
    console.log('[DEBUG] 📤 Enviando respuesta por WhatsApp...');
    await message.reply(aiResponse);
    console.log('[DEBUG] ✅ Respuesta enviada exitosamente');
    
    // Actualizar timestamp de última respuesta
    lastResponse[phone] = Date.now();
    console.log('[DEBUG] ⏰ Timestamp de última respuesta actualizado');
    
    // Emitir eventos a frontend
    console.log('[DEBUG] 📡 Emitiendo eventos a frontend via Socket.io...');
    io.emit('new_message', {
      from: phone,
      fromName: leadNames[phone] || contactName,
      body: messageBody,
      timestamp: Date.now(),
      type: contactType
    });
    
    io.emit('ai_response', {
      to: phone,
      toName: leadNames[phone] || contactName,
      body: aiResponse,
      timestamp: Date.now(),
      type: contactType
    });
    console.log('[DEBUG] 📡 Eventos emitidos');
    
    console.log('[DEBUG] 🎉 PROCESO COMPLETADO EXITOSAMENTE');
    console.log('[DEBUG] 👤 Contacto:', leadNames[phone]);
    console.log('[DEBUG] 🏷️  Tipo:', contactType);
    console.log('============================================\n');
    
  } catch (error) {
    console.error('\n❌❌❌ ERROR CRÍTICO EN handleIncomingMessage ❌❌❌');
    console.error('[ERROR] Mensaje:', error.message);
    console.error('[ERROR] Stack:', error.stack);
    console.error('[ERROR] Objeto completo:', error);
    console.error('============================================\n');
  }
}

// ============================================
// WHATSAPP CLIENT INITIALIZATION
// ============================================

function initWhatsApp() {
  if (whatsappClient) {
    console.log('[WA] ⚠️  Cliente WhatsApp ya inicializado');
    return;
  }

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🚀 INICIALIZANDO WHATSAPP CLIENT    ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  whatsappClient.on('qr', async (qr) => {
    console.log('[WA] 📱 QR CODE GENERADO');
    console.log('[WA] 📱 Convirtiendo a DataURL...');
    qrCode = await qrcode.toDataURL(qr);
    console.log('[WA] 📱 QR DataURL generado, longitud:', qrCode.length);
    console.log('[WA] 📡 Emitiendo evento "qr" via Socket.io...');
    io.emit('qr', qrCode);
    console.log('[WA] ✅ QR emitido a clientes conectados');
  });

  whatsappClient.on('authenticated', () => {
    console.log('[WA] ✅ WHATSAPP AUTENTICADO CORRECTAMENTE');
    qrCode = null;
  });

  whatsappClient.on('ready', () => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║   ✅ WHATSAPP LISTO                   ║');
    console.log('║   🤖 MIIA AUTO-RESPONSE ACTIVADA      ║');
    console.log('╚════════════════════════════════════════╝\n');
    isReady = true;
    io.emit('whatsapp_ready', { status: 'connected' });
  });

  // ⭐⭐⭐ EVENTO PRINCIPAL - RESPUESTA AUTOMÁTICA ⭐⭐⭐
  whatsappClient.on('message', (msg) => {
    console.log('[WA] 📨 Evento "message" recibido');
    handleIncomingMessage(msg);
  });

  whatsappClient.on('message_create', async (message) => {
    console.log('[WA] 📝 Evento "message_create" recibido');
    
    // Emitir mensajes enviados por Mariano también
    if (message.fromMe) {
      console.log('[WA] 👤 Mensaje enviado por el usuario (fromMe=true)');
      const contact = await message.getContact();
      io.emit('new_message', {
        from: message.to,
        fromName: contact.name || contact.pushname || 'Desconocido',
        body: message.body,
        timestamp: Date.now(),
        fromMe: true
      });
      console.log('[WA] 📡 Mensaje propio emitido al frontend');
    }
  });

  whatsappClient.on('disconnected', (reason) => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║   ❌ WHATSAPP DESCONECTADO            ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('[WA] ❌ Razón:', reason);
    isReady = false;
    whatsappClient = null;
    io.emit('whatsapp_disconnected', { reason });
  });

  console.log('[WA] 🔄 Llamando a client.initialize()...');
  whatsappClient.initialize();
  console.log('[WA] 🔄 Initialize() llamado, esperando conexión...\n');
}

// ============================================
// SOCKET.IO EVENTS
// ============================================

io.on('connection', (socket) => {
  console.log('👤 Cliente conectado via Socket.io');
  
  if (!whatsappClient) {
    initWhatsApp();
  }

  // Si WhatsApp ya está conectado, avisar inmediatamente
  if (isReady && whatsappClient) {
    socket.emit('whatsapp_ready', { status: 'connected' });
  } else if (qrCode) {
    socket.emit('qr', qrCode);
  }
  
  socket.emit('whatsapp_status', { isReady, qrCode });

  socket.on('check_status', () => {
    if (isReady && whatsappClient) {
      socket.emit('whatsapp_ready', { status: 'connected' });
    }
  });

  // Enviar mensaje manual desde frontend
  socket.on('send_message', async (data) => {
    const { to, message } = data;
    
    if (!isReady) {
      socket.emit('error', { message: 'WhatsApp no conectado' });
      return;
    }

    try {
      await whatsappClient.sendMessage(to, message);
      socket.emit('message_sent', { to, message });
      console.log(`[MANUAL] Mensaje enviado a ${to}`);
    } catch (error) {
      console.error('[ERROR] send_message:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // Obtener lista de chats
  socket.on('get_chats', async () => {
    if (!isReady) {
      socket.emit('error', { message: 'WhatsApp no conectado' });
      return;
    }

    try {
      const chats = await whatsappClient.getChats();
      const chatList = [];
      
      for (let i = 0; i < Math.min(chats.length, 50); i++) {
        const chat = chats[i];
        const contact = await chat.getContact();
        chatList.push({
          id: chat.id._serialized,
          name: contact.pushname || contact.number,
          lastMessage: chat.lastMessage?.body || '',
          timestamp: chat.timestamp
        });
      }

      socket.emit('chats_list', chatList);
    } catch (error) {
      console.error('[ERROR] get_chats:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // Obtener lista de conversaciones (memoria interna)
  socket.on('get_conversations', () => {
    const conversationList = Object.keys(conversations).map(phone => ({
      phone,
      name: leadNames[phone] || 'Desconocido',
      type: contactTypes[phone] || 'lead',
      lastMessage: conversations[phone][conversations[phone].length - 1]?.content || '',
      timestamp: conversations[phone][conversations[phone].length - 1]?.timestamp || Date.now(),
      messageCount: conversations[phone].length
    }));
    
    socket.emit('conversations_list', conversationList);
  });

  // Obtener conversación específica
  socket.on('get_conversation', (data) => {
    const { phone } = data;
    if (conversations[phone]) {
      socket.emit('conversation_data', {
        phone,
        name: leadNames[phone],
        type: contactTypes[phone],
        messages: conversations[phone]
      });
    } else {
      socket.emit('error', { message: 'Conversación no encontrada' });
    }
  });
});

// ============================================
// ENDPOINTS HTTP
// ============================================

app.get('/', (req, res) => {
  res.json({ 
    status: 'MIIA Backend Running',
    whatsapp: isReady ? 'connected' : 'disconnected',
    version: '2.0 - Auto-Response FULL',
    features: [
      'Auto-response WhatsApp',
      'Family detection',
      'Gemini AI integration',
      'Anti-spam protection',
      'Conversation memory'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    whatsapp: isReady,
    conversations: Object.keys(conversations).length,
    activeContacts: Object.keys(contactTypes).length
  });
});

// Endpoint para obtener conversaciones (para Firebase sync futuro)
app.get('/api/conversations', (req, res) => {
  res.json({ 
    conversations, 
    contactTypes, 
    leadNames,
    totalConversations: Object.keys(conversations).length,
    familyContacts: Object.values(contactTypes).filter(t => t === 'familia').length,
    leadContacts: Object.values(contactTypes).filter(t => t === 'lead').length
  });
});

// ⭐ NUEVO ENDPOINT - Chat con MIIA desde frontend
app.post('/api/chat', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log('\n' + '='.repeat(60));
  console.log(`[${timestamp}] 💬 API CHAT - NUEVA PETICIÓN`);
  console.log('='.repeat(60));
  
  try {
    const { message, userId, businessInfo } = req.body;
    
    console.log(`[API CHAT] 👤 User ID: ${userId}`);
    console.log(`[API CHAT] 💬 Message: ${message}`);
    console.log(`[API CHAT] 📊 Business info presente: ${!!businessInfo}`);
    console.log(`[API CHAT] 📦 Body completo:`, JSON.stringify(req.body, null, 2));
    
    if (!message) {
      console.error('[API CHAT] ❌ ERROR: Mensaje vacío');
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    // Preparar historial de conversación
    const conversationHistory = [];
    
    if (businessInfo) {
      console.log('[API CHAT] ✅ Agregando contexto de negocio a la conversación');
      conversationHistory.push({
        role: "user",
        parts: [{ text: `[CONTEXTO: El usuario te ha enseñado:\n${businessInfo}\nUsa esto cuando sea relevante.]` }]
      });
      conversationHistory.push({
        role: "model",
        parts: [{ text: "Entendido." }]
      });
    }
    
    conversationHistory.push({
      role: "user",
      parts: [{ text: message }]
    });

    console.log('[API CHAT] 🚀 Preparando llamada a Gemini API...');
    console.log(`[API CHAT] 📨 Cantidad de mensajes en historial: ${conversationHistory.length}`);
    console.log('[API CHAT] 🔑 GEMINI_API_KEY está configurada:', !!GEMINI_API_KEY);
    
    const geminiUrl = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
    console.log('[API CHAT] 🌐 URL Gemini (oculta):', geminiUrl.replace(GEMINI_API_KEY, 'API_KEY_HIDDEN'));
    
    const payload = {
      contents: conversationHistory,
      systemInstruction: {
        parts: [{ text: "Eres MIIA, asistente amigable para emprendedores. Responde natural y brevemente." }]
      }
    };
    
    console.log('[API CHAT] 📦 Payload preparado, enviando fetch...');
    
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    console.log(`[API CHAT] 📡 Gemini response status: ${geminiResponse.status}`);
    console.log(`[API CHAT] 📡 Gemini response ok: ${geminiResponse.ok}`);

    if (!geminiResponse.ok) {
      const errorData = await geminiResponse.json();
      console.error('[API CHAT] ❌ ERROR DE GEMINI:');
      console.error('[API CHAT] ❌ Status:', geminiResponse.status);
      console.error('[API CHAT] ❌ Error data:', JSON.stringify(errorData, null, 2));
      return res.status(500).json({ 
        error: 'Error al procesar mensaje',
        details: errorData.error?.message 
      });
    }

    const data = await geminiResponse.json();
    console.log('[API CHAT] 📥 Respuesta de Gemini recibida');
    console.log('[API CHAT] 📊 Data.candidates length:', data.candidates?.length || 0);
    
    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      console.error('[API CHAT] ❌ ERROR: Respuesta inválida de Gemini');
      console.error('[API CHAT] ❌ Data completo:', JSON.stringify(data, null, 2));
      return res.status(500).json({ error: 'Respuesta inválida de IA' });
    }

    const responseText = data.candidates[0].content.parts[0].text;
    console.log('[API CHAT] ✅ RESPUESTA GENERADA EXITOSAMENTE');
    console.log(`[API CHAT] 📝 Longitud de respuesta: ${responseText.length} caracteres`);
    console.log(`[API CHAT] 💭 Primeros 100 chars: ${responseText.substring(0, 100)}...`);

    const finalResponse = { 
      response: responseText,
      timestamp: Date.now()
    };
    
    console.log('[API CHAT] 📤 Enviando respuesta al cliente...');
    res.json(finalResponse);
    console.log('[API CHAT] ✅ RESPUESTA ENVIADA CORRECTAMENTE');
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('\n' + '❌'.repeat(30));
    console.error('[API CHAT] ❌❌❌ ERROR CRÍTICO ❌❌❌');
    console.error('[API CHAT] ❌ Message:', error.message);
    console.error('[API CHAT] ❌ Stack:', error.stack);
    console.error('[API CHAT] ❌ Error completo:', error);
    console.error('❌'.repeat(30) + '\n');
    
    res.status(500).json({ 
      error: 'Error interno del servidor',
      message: error.message 
    });
  }
});

// Endpoint para obtener estadísticas
app.get('/api/stats', (req, res) => {
  const stats = {
    whatsappConnected: isReady,
    totalConversations: Object.keys(conversations).length,
    totalMessages: Object.values(conversations).reduce((sum, conv) => sum + conv.length, 0),
    contactTypes: {
      familia: Object.values(contactTypes).filter(t => t === 'familia').length,
      lead: Object.values(contactTypes).filter(t => t === 'lead').length,
      cliente: Object.values(contactTypes).filter(t => t === 'cliente').length
    },
    recentActivity: Object.keys(lastResponse).length
  };
  
  res.json(stats);
});

// ============================================
// SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🚀 ═══ SERVIDOR INICIADO ═══');
  console.log(`📡 Puerto: ${PORT}`);
  console.log(`🌐 URL del backend: http://localhost:${PORT}`);
  console.log(`🔗 Socket.IO: http://localhost:${PORT}`);
  console.log('═══════════════════════════════════\n');
  console.log(`
╔════════════════════════════════════════╗
║   🚀 MIIA Backend v2.0 FULL           ║
║   Puerto: ${PORT}                        ║
║   WhatsApp Auto-Response: ACTIVO      ║
║   Family Detection: ACTIVO            ║
║   Gemini AI: READY                    ║
╚════════════════════════════════════════╝
  `);

  console.log('\n🖥️  ═══ INFORMACIÓN DEL ENTORNO ═══');
  console.log('process.stdout.isTTY:', process.stdout.isTTY);
  console.log('process.stderr.isTTY:', process.stderr.isTTY);
  console.log('Tipo de entorno:', process.stdout.isTTY ? 'Terminal Interactiva' : 'Servidor/Contenedor (Railway/Docker)');
  console.log('Logs con force flush: SÍ ✅ (siempre activo)');

  console.log('\n🔐 ═══ VARIABLES DE ENTORNO ═══');
  console.log('PORT:', process.env.PORT || '3000 (default)');
  console.log('NODE_ENV:', process.env.NODE_ENV || 'no definido');
  console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ Configurada (longitud: ' + process.env.GEMINI_API_KEY.length + ')' : '❌ NO CONFIGURADA');
  console.log('ALLOWED_ORIGINS:', process.env.ALLOWED_ORIGINS || 'no definido');
  
  console.log('\n📊 ═══ TODAS LAS VARIABLES DE ENTORNO ═══');
  Object.keys(process.env).sort().forEach(key => {
    const value = process.env[key];
    
    // Ocultar valores sensibles
    if (key.toLowerCase().includes('key') || 
        key.toLowerCase().includes('secret') || 
        key.toLowerCase().includes('password') ||
        key.toLowerCase().includes('token')) {
      console.log(`${key}: [OCULTO - longitud: ${value.length}]`);
    } else if (value.length > 100) {
      console.log(`${key}: ${value.substring(0, 50)}... [longitud total: ${value.length}]`);
    } else {
      console.log(`${key}: ${value}`);
    }
  });
  
  console.log('\n═══════════════════════════════════\n');
});