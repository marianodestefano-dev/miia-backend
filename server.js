const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

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

// ============================================
// GEMINI AI (deberás agregar tu API key)
// ============================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';

async function callGeminiAPI(messages, systemPrompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        }
      })
    });

    if (!response.ok) {
      throw new Error('Gemini API error');
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Error calling Gemini:', error);
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

let lastResponse = {}; // { phone: timestamp } - Anti-spam

async function handleIncomingMessage(message) {
  try {
    const phone = message.from;
    const messageBody = message.body;
    const contact = await message.getContact();
    const contactName = contact.name || contact.pushname || 'Usuario';
    
    // Ignorar mensajes del propio bot
    if (message.fromMe) return;
    
    // Ignorar grupos
    if (message.from.includes('@g.us')) return;
    
    // Anti-spam: No responder si ya respondimos hace menos de 10 segundos
    if (lastResponse[phone] && (Date.now() - lastResponse[phone] < 10000)) {
      console.log(`[ANTI-SPAM] Ignorando mensaje rápido de ${phone}`);
      return;
    }
    
    // Detectar tipo de contacto
    const contactType = contactTypes[phone] || detectContactType(contactName, phone);
    
    // Inicializar conversación si no existe
    if (!conversations[phone]) {
      conversations[phone] = [];
    }
    
    // Agregar mensaje del usuario
    conversations[phone].push({
      role: 'user',
      content: messageBody,
      timestamp: Date.now()
    });
    
    // Limitar historial a últimos 10 mensajes
    if (conversations[phone].length > 10) {
      conversations[phone] = conversations[phone].slice(-10);
    }
    
    // Generar prompt del sistema
    const systemPrompt = generateSystemPrompt(phone, contactType, leadNames[phone]);
    
    // Llamar a Gemini AI
    const aiResponse = await callGeminiAPI(conversations[phone], systemPrompt);
    
    if (!aiResponse) {
      console.error(`[AI] Error generando respuesta para ${phone}`);
      return;
    }
    
    // Guardar respuesta de MIIA
    conversations[phone].push({
      role: 'assistant',
      content: aiResponse,
      timestamp: Date.now()
    });
    
    // Enviar respuesta por WhatsApp
    await message.reply(aiResponse);
    
    // Actualizar timestamp de última respuesta
    lastResponse[phone] = Date.now();
    
    // Emitir evento a frontend
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
    
    console.log(`[MIIA] Respondió a ${leadNames[phone]} (${contactType})`);
    
  } catch (error) {
    console.error('[ERROR] handleIncomingMessage:', error);
  }
}

// ============================================
// WHATSAPP CLIENT
// ============================================

function initWhatsApp() {
  if (whatsappClient) {
    console.log('⚠️ Cliente WhatsApp ya inicializado');
    return;
  }

  console.log('🚀 Inicializando cliente WhatsApp...');
  
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
    console.log('📱 QR generado');
    qrCode = await qrcode.toDataURL(qr);
    io.emit('qr', qrCode);
  });

  whatsappClient.on('authenticated', () => {
    console.log('✅ WhatsApp autenticado');
    qrCode = null;
  });

  whatsappClient.on('ready', () => {
    console.log('✅ WhatsApp listo - MIIA activada');
    isReady = true;
    io.emit('whatsapp_ready', { status: 'connected' });
  });

  // ⭐ EVENTO PRINCIPAL - RESPUESTA AUTOMÁTICA
  whatsappClient.on('message', handleIncomingMessage);

  whatsappClient.on('disconnected', (reason) => {
    console.log('❌ Desconectado:', reason);
    isReady = false;
    whatsappClient = null;
    io.emit('whatsapp_disconnected', { reason });
  });

  whatsappClient.initialize();
}

// ============================================
// SOCKET.IO EVENTS
// ============================================

io.on('connection', (socket) => {
  console.log('Cliente conectado via Socket.io');
  
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
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  // Obtener lista de conversaciones
  socket.on('get_conversations', () => {
    const conversationList = Object.keys(conversations).map(phone => ({
      phone,
      name: leadNames[phone] || 'Desconocido',
      type: contactTypes[phone] || 'lead',
      lastMessage: conversations[phone][conversations[phone].length - 1]?.content || '',
      timestamp: conversations[phone][conversations[phone].length - 1]?.timestamp || Date.now()
    }));
    
    socket.emit('conversations_list', conversationList);
  });
});

// ============================================
// ENDPOINTS HTTP
// ============================================

app.get('/', (req, res) => {
  res.json({ 
    status: 'MIIA Backend Running',
    whatsapp: isReady ? 'connected' : 'disconnected',
    version: '2.0 - Auto-Response'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    whatsapp: isReady,
    conversations: Object.keys(conversations).length
  });
});

// Endpoint para obtener conversaciones (para Firebase sync futuro)
app.get('/api/conversations', (req, res) => {
  res.json({ conversations, contactTypes, leadNames });
});

// ============================================
// SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MIIA Backend v2.0 en puerto ${PORT}`);
  console.log(`📱 WhatsApp Auto-Response: ACTIVO`);
});
