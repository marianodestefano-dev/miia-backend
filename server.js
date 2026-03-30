require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const FirestoreSessionStore = require('./firestore_session_store');

// CEREBRO ABSOLUTO — módulo de aprendizaje autónomo nocturno
const cerebroAbsoluto = require('./cerebro_absoluto');

// GENERADOR DE COTIZACIONES PDF
const cotizacionGenerator = require('./cotizacion_generator');

// SCRAPER REGULATORIO — actualización normativa semanal
const webScraper = require('./web_scraper');

// ESTADÍSTICAS — seguimiento de conversiones y pipeline
const estadisticas = require('./estadisticas');

// TENANT MANAGER — multi-tenant WhatsApp isolation
const tenantManager = require('./tenant_manager');

// UNIFIED MODULES — extracted from duplicated code
const { callGemini, callGeminiChat } = require('./gemini_client');
const { callAI, callAIChat, PROVIDER_LABELS } = require('./ai_client');
const { buildPrompt, buildTenantBrainString } = require('./prompt_builder');

// FIREBASE ADMIN — actualizar Firestore desde webhook
const admin = require('firebase-admin');
try {
  let credential;
  if (fs.existsSync(path.join(__dirname, 'firebase-admin-key.json'))) {
    // Local dev: usa archivo JSON
    const serviceAccount = require('./firebase-admin-key.json');
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Railway/prod: usa variable de entorno (JSON string)
    // Reemplaza \n literales en private_key que se corrompen al pegar en Railway
    const rawJSON = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n');
    const serviceAccount = JSON.parse(rawJSON);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_PROJECT_ID) {
    // Railway con vars individuales
    let pk = process.env.FIREBASE_PRIVATE_KEY || '';
    // Normalizar saltos de línea: algunos clientes de Railway guardan \n literales
    if (pk.includes('\\n')) pk = pk.replace(/\\n/g, '\n');
    if (!pk.includes('\n') && pk.includes('BEGIN PRIVATE KEY')) {
      console.error('[FIREBASE] FIREBASE_PRIVATE_KEY no tiene saltos de línea — verificar formato en Railway');
    }
    console.log('[FIREBASE] Usando vars individuales. ProjectId:', process.env.FIREBASE_PROJECT_ID, '| PrivateKey starts:', pk.substring(0, 27));
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk
    });
  } else {
    console.warn('No se encontro credencial de Firebase Admin — Firestore no disponible');
    credential = null;
  }
  if (credential) {
    admin.initializeApp({ credential });
    console.log('[FIREBASE] ✅ Firebase Admin inicializado correctamente');
  }
} catch (e) {
  console.error('[FIREBASE] ERROR al inicializar:', e.message);
  console.error('[FIREBASE] Stack:', e.stack);
}

// STRIPE — procesamiento de pagos
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://miia-frontend-one.vercel.app';

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

app.use(compression());
// CORS: Allow all origins for now (can be restricted later)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());

// ============================================
// CONFIGURACIÓN
// ============================================


// FAMILIA (del prompt_maestro.md)
const FAMILY_CONTACTS = {
  'SILVIA': { name: 'Silvia', relation: 'mamá', emoji: '👵❤️' },
  'ALE': { name: 'Alejandra', relation: 'esposa', emoji: '👸💕' },
  'ALEJANDRA': { name: 'Alejandra', relation: 'esposa', emoji: '👸💕' },
  'RAFA': { name: 'Jedido', relation: 'papá', emoji: '👴❤️' },
  'RAFAEL': { name: 'Jedido', relation: 'papá', emoji: '👴❤️' },
  'JEDIDO': { name: 'Jedido', relation: 'papá', emoji: '👴❤️' },
  'ANA': { name: 'Anabella', relation: 'hermana de Mariano', emoji: '👧❤️' },
  'ANABELLA': { name: 'Anabella', relation: 'hermana de Mariano', emoji: '👧❤️' },
  'CONSU': { name: 'Consu', relation: 'suegra', emoji: '👵⛪📿' },
  'CONSUELO': { name: 'Consu', relation: 'suegra', emoji: '👵⛪📿' },
  'JOTA': { name: 'Jota', relation: 'hermano de Ale', emoji: '⚖️💚' },
  'JORGE MARIO': { name: 'Jota', relation: 'hermano de Ale', emoji: '⚖️💚' },
  'MARIA ISABEL': { name: 'Maria Isabel', relation: 'esposa de Jota', emoji: '🐶🤱' },
  'CHAPY': { name: 'Chapy', relation: 'primo', emoji: '💻💪' },
  'JUAN PABLO': { name: 'Chapy', relation: 'primo', emoji: '💻💪' },
  'JUANCHO': { name: 'Juancho', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️' },
  'JUAN DIEGO': { name: 'Juancho', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️' },
  'MARIA CLARA': { name: 'Maria', relation: 'concuñada, esposa de Juancho', emoji: '🏠🏍️🙏' },
  'VIVI': { name: 'Vivi', relation: 'JEFA', emoji: '👩‍💼👑' },
  'VIVIANA': { name: 'Vivi', relation: 'JEFA', emoji: '👩‍💼👑' },
  'FLAKO': { name: 'Flako', relation: 'amigo del papá', emoji: '😎' }
};

// ============================================
// VARIABLES GLOBALES
// ============================================

const OWNER_UID = process.env.OWNER_UID || 'aEiDDauuakUE5saEEBilmho0rF43';
let whatsappClient = null;
let qrCode = null;
let isReady = false;
let initRetryCount = 0; // Counter para evitar loop infinito de reintentos
let conversations = {}; // { phone: [{ role, content, timestamp }] }
let contactTypes = { '573163937365@c.us': 'lead' }; // { phone: 'familia' | 'lead' | 'cliente' }
let leadNames = { '573163937365@c.us': 'Dr. Mariano' }; // { phone: 'nombre' }

// --- Variables MIIA (portadas desde index.js) ---
let lastSentByBot = {};
let sentMessageIds = new Set();
let lastAiSentBody = {};
let miiaPausedUntil = 0;
let trainingData = '';
let leadSummaries = {};
let conversationMetadata = {};
let isProcessing = {};
let pendingResponses = {};  // re-trigger cuando llegan mensajes mientras se procesa
const RESET_ALLOWED_PHONES = ['573163937365', '573054169969'];
let keywordsSet = [];
// BLINDAJE GENEALÓGICO MIIA FAMILY v4.0 — pre-inicializado con datos ricos
// loadDB() hace Object.assign encima → preserva affinity e isHandshakeDone actualizados de la DB
let familyContacts = {
  '573137501884': { name: 'Alejandra', fullName: 'Alejandra Sánchez', relation: 'esposa de Mariano', emoji: '👸💕', personality: 'Spicy, F1 (Leclerc/Colapinto), Parcera, interés en Libros', affinity: 90, isHandshakeDone: false },
  '5491131313325': { name: 'Jedido', fullName: 'Mario Rafael De Stefano', relation: 'papá de Mariano', emoji: '👴❤️', personality: 'Respetuosa, cariñosa. Muy admirado por Mariano.', affinity: 50, isHandshakeDone: false },
  '56994128069': { name: 'Vivi', fullName: 'Viviana Gaviria', relation: 'JEFA de Mariano', emoji: '👩‍💼👑', personality: 'Profesional, ejecutiva, técnica. Solo responde si ella dice Hola MIIA.', affinity: 30, isHandshakeDone: false },
  '573128908895': { name: 'Jota', fullName: 'Jorge Mario', relation: 'hermano de Ale', emoji: '⚖️💚', personality: 'Abogado, fan del Nacional, padre de Renata', affinity: 85, isHandshakeDone: false },
  '573012761138': { name: 'Maria Isabel', fullName: 'Maria Isabel', relation: 'esposa de Jota', emoji: '🐶🤱', personality: 'Madre de Renata, ama los perros (Kiara). Preguntarle siempre por Kiara.', affinity: 80, isHandshakeDone: false },
  '5491164431700': { name: 'Silvia', fullName: 'Silvia', relation: 'mamá de Mariano', emoji: '👵❤️', personality: 'Super dulce, amistosa, disponibilidad 24/7 para ayudar', affinity: 100, isHandshakeDone: false },
  '5491134236348': { name: 'Anabella', fullName: 'Anabella Florencia De Stefano', relation: 'hermana de Mariano', emoji: '👧❤️', personality: 'Le gusta Boca Juniors, leer y libros de autoayuda. Necesita ayuda con amores (ser discreta). Cuidarla siempre.', affinity: 90, isHandshakeDone: false },
  '556298316219': { name: 'Flako', fullName: 'Jorge Luis Gianni', relation: 'amigo del papá de Mariano', emoji: '😎', personality: 'Amigo cercano de la familia', affinity: 60, isHandshakeDone: false },
  '5491140293119': { name: 'Chapy', fullName: 'Juan Pablo', relation: 'primo de Mariano', emoji: '💻💪', personality: 'Capo en programación, fan del gym', affinity: 90, isHandshakeDone: false },
  '573145868362': { name: 'Juancho', fullName: 'Juan Diego', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️', personality: 'Amistoso. Experto en leyes colombianas. Le gusta viajar en moto y tiene campo de aguacates.', affinity: 85, isHandshakeDone: false },
  '573108221373': { name: 'Maria', fullName: 'Maria Clara', relation: 'concuñada, esposa de Juancho', emoji: '🏠🏍️🙏', personality: 'Muy amistosa y agradable. Tiene inmobiliaria. Le encanta viajar en moto con Juancho. Ayudarle con deseos de rezar.', affinity: 85, isHandshakeDone: false },
  '573217976029': { name: 'Consu', fullName: 'Consuelo', relation: 'suegra, mamá de Ale y Juancho', emoji: '👵⛪📿', personality: 'Mujer súper dulce. Fanática de Dios, la religión y rezar. Cuidarla y ayudarle en todo.', affinity: 95, isHandshakeDone: true }
};
// EQUIPO MEDILINK — compañeros de trabajo de Mariano
const equipoMedilink = {
  '56971251474': { name: null, presented: false },
  '56964490945': { name: null, presented: false },
  '56971561322': { name: null, presented: false },
  '56974919305': { name: null, presented: false },
  '56978516275': { name: null, presented: false },
  '56989558306': { name: null, presented: false },
  '56994128069': { name: 'Vivi', presented: false },   // también JEFA en familyContacts
  '56974777648': { name: null, presented: false },
  '573125027604': { name: null, presented: false }
};

// Leads pre-registrados (MIIA los trata como potenciales clientes de Medilink)
let allowedLeads = [];
let flaggedBots = {};
let lastInteractionTime = {};
let selfChatLoopCounter = {};
let isSystemPaused = false;
const nightPendingLeads = new Set(); // leads que escribieron durante el silencio nocturno
let morningWakeupDone   = '';        // evita repetir el despertar en el mismo día
let morningBriefingDone = '';        // evita repetir el briefing en el mismo día
let briefingPendingApproval = [];    // novedades regulatorias esperando aprobación de Mariano
const MIIA_CIERRE = `\n\n_Si quieres seguir hablando, responde *HOLA MIIA*. Si prefieres terminar, escribe *CHAU MIIA*._`;

// Humanizer cache — se refresca desde Firestore cada 60s
let _humanizerCache = { value: true, ts: 0 };
async function isHumanizerEnabled() {
  if (Date.now() - _humanizerCache.ts < 60000) return _humanizerCache.value;
  try {
    if (OWNER_UID) {
      const doc = await admin.firestore().collection('users').doc(OWNER_UID).get();
      if (doc.exists) _humanizerCache = { value: doc.data().humanizer_enabled !== false, ts: Date.now() };
    }
  } catch (_) {}
  return _humanizerCache.value;
}

// Micro-humanizer: 2% de mensajes llevan un typo (swap 2 chars adyacentes) para parecer humano
function maybeAddTypo(text) {
  if (Math.random() > 0.02 || text.length < 10) return text;
  const pos = Math.floor(Math.random() * (text.length - 2)) + 1;
  return text.slice(0, pos) + text[pos + 1] + text[pos] + text.slice(pos + 2);
}
let subscriptionState = {};          // { phone: { estado: 'asked'|'collecting'|'notified', data: {} } }
const MSG_SUSCRIPCION =
`¡Genial! Para armar tu link de acceso solo necesito dos datos:

1. Tu correo electrónico
2. Método de pago preferido: ¿tarjeta de crédito o débito?

El resto ya lo tengo del plan que conversamos. El link tiene una validez de 24 horas desde que te lo envío, así que cuando lo recibas conviene completar el proceso ese mismo día para no perder el descuento. 😊`;
let helpCenterData = '';
let userProfile = { name: 'MIIA Owner', phone: '573054169969', email: '', smtpPass: '', goal: 1500 };
const BLACKLISTED_NUMBERS = ['573023317570@c.us'];
const OWNER_PHONE = '573054169969';
const ADMIN_PHONES = ['573054169969'];
let automationSettings = {
  autoResponse: true,
  additionalPersona: '',
  lastUpdate: new Date().toISOString(),
  tokenLimit: 500000,
  schedule: { start: '09:00', end: '21:00', days: [1, 2, 3, 4, 5, 6, 7] }
};

// ============================================
// PERSISTENCIA (DB simple en JSON)
// ============================================

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function saveDB() {
  try {
    const data = {
      conversations, leadNames, contactTypes, familyContacts,
      allowedLeads, leadSummaries, conversationMetadata,
      keywordsSet, automationSettings, userProfile, flaggedBots,
      equipoMedilink,
      trainingData: cerebroAbsoluto.getTrainingData()
    };
    fs.writeFileSync(path.join(DATA_DIR, 'db.json'), JSON.stringify(data, null, 2));
  } catch (e) { console.error('[DB] Error guardando:', e.message); }
}

function loadDB() {
  try {
    const dbPath = path.join(DATA_DIR, 'db.json');
    if (!fs.existsSync(dbPath)) return;
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    if (data.conversations) Object.assign(conversations, data.conversations);
    if (data.leadNames) Object.assign(leadNames, data.leadNames);
    if (data.contactTypes) Object.assign(contactTypes, data.contactTypes);
    if (data.familyContacts) Object.assign(familyContacts, data.familyContacts);
    if (data.allowedLeads) {
      for (const l of data.allowedLeads) {
        if (!allowedLeads.includes(l)) allowedLeads.push(l);
      }
    }
    if (data.leadSummaries) Object.assign(leadSummaries, data.leadSummaries);
    if (data.conversationMetadata) Object.assign(conversationMetadata, data.conversationMetadata);
    if (data.keywordsSet) keywordsSet = data.keywordsSet;
    if (data.automationSettings) Object.assign(automationSettings, data.automationSettings);
    if (data.userProfile) Object.assign(userProfile, data.userProfile);
    if (data.flaggedBots) Object.assign(flaggedBots, data.flaggedBots);
    if (data.equipoMedilink) Object.assign(equipoMedilink, data.equipoMedilink);
    if (data.trainingData) cerebroAbsoluto.setTrainingData(data.trainingData);
    console.log('[DB] Base de datos cargada correctamente.');
  } catch (e) { console.error('[DB] Error cargando:', e.message); }
}
loadDB();

// ============================================
// HELPERS GENERALES
// ============================================

const getBasePhone = (p) => (p || '').split('@')[0];
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const ensureConversation = (p) => { if (!conversations[p]) conversations[p] = []; return conversations[p]; };

function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function isPotentialBot(text) {
  if (!text) return false;
  const botKeywords = [
    'soy un bot', 'asistente virtual', 'mensaje automático',
    'auto-responder', 'vía @', 'powered by', 'gracias por su mensaje',
    'transcripción de audio'
  ];
  const lowerText = text.toLowerCase();
  return botKeywords.some(kw => lowerText.includes(kw));
}

function isWithinSchedule() {
  if (!automationSettings.autoResponse) return false;
  const bogotaDateString = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' });
  const bogotaDate = new Date(bogotaDateString);
  const day = bogotaDate.getDay() === 0 ? 7 : bogotaDate.getDay();
  if (!automationSettings.schedule.days.includes(day)) return false;
  const time = `${bogotaDate.getHours().toString().padStart(2, '0')}:${bogotaDate.getMinutes().toString().padStart(2, '0')}`;
  return time >= automationSettings.schedule.start && time <= automationSettings.schedule.end;
}

// ============================================
// GEMINI AI
// ============================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
const GEMINI_URL = process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';

async function callGeminiAPI(messages, systemPrompt) {
  try {
    const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      }
    };

    console.log(`[GEMINI] Request: ${messages.length} msgs, prompt ${systemPrompt.length} chars`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GEMINI] ERROR ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      console.error('[GEMINI] Estructura de respuesta inválida:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text;
    console.log(`[GEMINI] OK: ${responseText.length} chars`);
    return responseText;
  } catch (error) {
    console.error('[GEMINI] ERROR CRÍTICO:', error.message);
    return null;
  }
}

// generateAIContent: versión fetch con retry automático para errores 503/429
async function generateAIContent(prompt) {
  const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
  console.log(`[GEMINI] Llamando a la API con url: ${url}`);
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  };
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [8000, 20000, 45000]; // 8s, 20s, 45s

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('No text in Gemini response');
      return text;
    }
    const isRetryable = response.status === 503 || response.status === 429;
    if (isRetryable && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS[attempt];
      console.warn(`[GEMINI] ⏳ Error ${response.status} — reintentando en ${delay / 1000}s (intento ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${err}`);
  }
}

// safeSendMessage: envío seguro con delay humano
async function safeSendMessage(target, content, options = {}) {
  if (isSystemPaused) {
    console.log(`⚠️ [INTERCEPTADO] Envío a ${target} BLOQUEADO por pausa.`);
    return null;
  }
  // REGLA ABSOLUTA: MIIA nunca participa en grupos ni estados. Ni lee, ni responde, ni publica.
  if (target.endsWith('@g.us')) {
    console.log(`[WA] BLOQUEO: Envío a GRUPO abortado (${target})`);
    return null;
  }
  if (target.includes('status@broadcast') || target.includes('status@')) {
    console.log(`[WA] BLOQUEO: Envío a STATUS abortado (${target})`);
    return null;
  }
  if (!isReady || !whatsappClient) {
    console.log(`⚠️ [INTERCEPTADO] WhatsApp no está listo.`);
    return null;
  }
  // Rate limit global: máx. mensajes por hora para proteger el número
  const currentHour = new Date().getHours();
  if (hourlySendLog.hour !== currentHour) {
    hourlySendLog.hour = currentHour;
    hourlySendLog.count = 0;
  }
  if (hourlySendLog.count >= MAX_SENDS_PER_HOUR) {
    console.log(`⚠️ [RATE LIMIT] Límite de ${MAX_SENDS_PER_HOUR} msgs/hora alcanzado. Mensaje a ${target} omitido.`);
    return null;
  }
  hourlySendLog.count++;

  // BLINDAJE: Limitar largo de respuesta para parecer humano (máx 500 chars)
  if (typeof content === 'string' && content.length > 500) {
    // Cortar en el último punto o salto de línea antes del límite
    let cutPoint = content.lastIndexOf('.', 500);
    if (cutPoint < 200) cutPoint = content.lastIndexOf('\n', 500);
    if (cutPoint < 200) cutPoint = 500;
    content = content.substring(0, cutPoint + 1).trim();
    console.log(`[BLINDAJE] Respuesta recortada a ${content.length} chars para ${target}`);
  }

  if (!options.noDelay) {
    const delay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
    await new Promise(r => setTimeout(r, delay));
  }
  try {
    const result = await whatsappClient.sendMessage(target, content, options);
    // Registrar mensaje como enviado por bot para que message_create lo ignore
    const sentBody = (typeof content === 'string' ? content : '').trim();
    if (sentBody) {
      if (!lastSentByBot[target]) lastSentByBot[target] = [];
      lastSentByBot[target].push(sentBody);
      setTimeout(() => {
        if (lastSentByBot[target]) {
          lastSentByBot[target] = lastSentByBot[target].filter(b => b !== sentBody);
          if (lastSentByBot[target].length === 0) delete lastSentByBot[target];
        }
      }, 10000);
    }
    console.log(`[SENT] Mensaje enviado a ${target.split('@')[0]}`);
    return result;
  } catch (e) {
    console.error(`[ERROR SENT] Fallo al enviar a ${target}:`, e.message);
    throw e;
  }
}

// handleLeadOptOut: baja definitiva de un lead
async function handleLeadOptOut(phoneId) {
  console.log(`[OPT-OUT] Procesando desuscripción para: ${phoneId}`);
  allowedLeads = allowedLeads.filter(p => p !== phoneId);
  if (conversations[phoneId]) delete conversations[phoneId];
  delete leadNames[phoneId];
  delete contactTypes[phoneId];
  saveDB();
  console.log(`[OPT-OUT] Lead ${phoneId} eliminado.`);
}

// ============================================
// DETECCIÓN DE TIPO DE CONTACTO
// ============================================

function detectContactType(name, phone) {
  const normalizedName = (name || '').toUpperCase().trim();
  const basePhone = phone.split('@')[0];

  // Verificar si ya está en familyContacts (keyed by basePhone)
  if (familyContacts[basePhone]) {
    contactTypes[phone] = 'familia';
    leadNames[phone] = familyContacts[basePhone].name;
    return 'familia';
  }

  // Verificar contra FAMILY_CONTACTS (keyed by nombre)
  for (const [key, value] of Object.entries(FAMILY_CONTACTS)) {
    if (normalizedName.includes(key)) {
      contactTypes[phone] = 'familia';
      leadNames[phone] = value.name;
      // Registrar en familyContacts por basePhone para que processMiiaResponse lo detecte
      familyContacts[basePhone] = {
        name: value.name,
        fullName: value.name,
        relation: value.relation,
        emoji: value.emoji,
        personality: 'Cariñosa y atenta',
        affinity: 0,
        isHandshakeDone: false
      };
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
// VIGENCIA Y CUPOS DINÁMICOS DE PROMOCIÓN
// ============================================

function getPromoVigencia() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const day = now.getDate();
  const month = now.getMonth(); // 0-based
  const year = now.getFullYear();

  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

  let vigencia, cupos;
  if (day >= 1 && day < 15) {
    vigencia = `15 de ${months[month]} de ${year}`;
    cupos = 11;
  } else if (day >= 15 && day < 22) {
    vigencia = `25 de ${months[month]} de ${year}`;
    cupos = 7;
  } else if (day >= 22 && day < 27) {
    vigencia = `30 de ${months[month]} de ${year}`;
    cupos = 4;
  } else {
    // día 27-31: vigencia al 5 del mes siguiente
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear  = month === 11 ? year + 1 : year;
    vigencia = `5 de ${months[nextMonth]} de ${nextYear}`;
    cupos = 4;
  }
  return { vigencia, cupos };
}

// ============================================
// MOTOR DE INTELIGENCIA SOBERANA MIIA
// ============================================

async function processMiiaResponse(phone, userMessage, isAlreadySavedParam = false) {
  const basePhone = phone.split('@')[0];
  try {
    if (!conversations[phone]) conversations[phone] = [];
    const familyInfo = familyContacts[basePhone];
    const isFamilyContact = !!familyInfo;
    const isAdmin = ADMIN_PHONES.includes(basePhone);

    // Recuperar mensaje real del historial cuando fue llamado con userMessage=null
    const effectiveMsg = userMessage ||
      (conversations[phone] || []).slice().reverse().find(m => m.role === 'user')?.content || null;

    // Comando de enseñanza directa: "aprende: texto" / "miia recuerda: texto" / etc.
    const learnCmdMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:aprende|recuerda|guarda):\s*(.+)/is);
    if (isAdmin && learnCmdMatch) {
      cerebroAbsoluto.appendLearning(learnCmdMatch[1].trim(), 'WHATSAPP_ADMIN');
      saveDB();
      await safeSendMessage(phone, '✅ Aprendido y guardado en mi memoria permanente.');
      return;
    }

    // Comando humanizer toggle: "desactivar humanizador" / "activar humanizador"
    if (isAdmin && effectiveMsg) {
      const lower = effectiveMsg.toLowerCase();
      if (lower.includes('desactivar humanizador') || lower.includes('desactivar versión humanizada')) {
        if (OWNER_UID) await admin.firestore().collection('users').doc(OWNER_UID).update({ humanizer_enabled: false });
        _humanizerCache = { value: false, ts: Date.now() };
        await safeSendMessage(phone, '✅ Humanizador desactivado. Responderé de forma más directa y sin pausas largas.');
        return;
      }
      if (lower.includes('activar humanizador') || lower.includes('activar versión humanizada')) {
        if (OWNER_UID) await admin.firestore().collection('users').doc(OWNER_UID).update({ humanizer_enabled: true });
        _humanizerCache = { value: true, ts: Date.now() };
        await safeSendMessage(phone, '✅ Humanizador activado. Incluiré pausas variables y pequeños errores tipográficos ocasionales.');
        return;
      }
    }

    // Comando "dile a equipo medilink que..." — broadcast a todos los miembros del equipo
    const equipoMsgMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?dile?\s+a\s+equipo\s+medilink\s+que?\s+(.+)/is);
    if (isAdmin && equipoMsgMatch) {
      const tema = equipoMsgMatch[1].trim();
      const phones = Object.keys(equipoMedilink);
      let enviados = 0;
      for (const num of phones) {
        const target = `${num}@c.us`;
        try {
          const nombreMiembro = equipoMedilink[num].name || leadNames[target] || null;
          const promptEquipo = `Sos MIIA, asistente IA de Medilink. Mariano te pide que le transmitas este mensaje a un integrante del equipo${nombreMiembro ? ` (${nombreMiembro})` : ''}: "${tema}". Redactá un mensaje breve, cálido y profesional. Si no sabés su nombre, no lo inventes.`;
          const msg = await generateAIContent(promptEquipo);
          if (msg) {
            await safeSendMessage(target, msg + MIIA_CIERRE);
            enviados++;
            await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
          }
        } catch (e) {
          console.error(`[EQUIPO] Error enviando a ${num}:`, e.message);
        }
      }
      await safeSendMessage(phone, `✅ Mensaje enviado al equipo Medilink (${enviados}/${phones.length} contactos).`);
      return;
    }

    // Comando "dile a [familiar] [mensaje]" — envía mensaje real a un contacto de familia
    if (isAdmin && effectiveMsg) {
      const msgLower = effectiveMsg.toLowerCase().trim();
      const isDileA = msgLower.startsWith('miia dile a') || msgLower.startsWith('dile a');
      const isNotEquipo = !effectiveMsg.match(/^(?:miia\s+)?dile?\s+a\s+equipo\s+medilink/is);

      if (isDileA && isNotEquipo) {
        let rest = msgLower.startsWith('miia dile a')
          ? effectiveMsg.substring(11).trim()
          : effectiveMsg.substring(6).trim();

        // Manejar "dile al [nombre]" → quitar la "l" extra del artículo contracto
        if (rest.toLowerCase().startsWith('l ')) rest = rest.substring(2).trim();

        // Caso masivo: "dile a la familia [mensaje]"
        if (rest.toLowerCase().startsWith('la familia')) {
          const familyMsg = rest.substring(10).trim();
          const familyEntries = Object.entries(familyContacts);
          let enviados = 0;
          for (const [fPhone, fInfo] of familyEntries) {
            if (fPhone === OWNER_PHONE) continue;
            const targetSerialized = fPhone.includes('@') ? fPhone : `${fPhone}@c.us`;
            try {
              const promptFamilia = `Sos MIIA, asistente de MIIA Owner. Le vas a escribir un mensaje a ${fInfo.name} (${fInfo.relation} de Mariano). Su personalidad: ${fInfo.personality || 'Amistosa y natural'}. Mariano quiere transmitirle esto: "${familyMsg}". Generá un mensaje corto (máx 4 renglones), natural, cálido y humano, en primera persona como MIIA. NO menciones que Mariano te lo pidió. Usá el emoji de esta persona: ${fInfo.emoji || ''}.`;
              const msg = await generateAIContent(promptFamilia);
              if (msg) {
                await safeSendMessage(targetSerialized, msg.trim() + MIIA_CIERRE);
                fInfo.isHandshakeDone = true;
                fInfo.affinity = (fInfo.affinity || 0) + 1;
                if (!allowedLeads.includes(targetSerialized)) allowedLeads.push(targetSerialized);
                conversations[targetSerialized] = conversations[targetSerialized] || [];
                conversations[targetSerialized].push({ role: 'assistant', content: msg.trim(), timestamp: Date.now() });
                enviados++;
                await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
              }
            } catch (e) {
              console.error(`[DILE A] Error enviando a ${fInfo.name}:`, e.message);
            }
          }
          saveDB();
          await safeSendMessage(phone, `✅ Mensaje enviado a toda la familia (${enviados}/${familyEntries.length} contactos).`);
          return;
        }

        // Caso individual: buscar el familiar por nombre normalizado
        const words = rest.split(' ');
        let foundFamily = null;
        let realMessage = '';
        for (let i = 1; i <= Math.min(words.length, 3); i++) {
          const candidate = normalizeText(words.slice(0, i).join(' '));
          const match = Object.entries(familyContacts).find(([, info]) => {
            const normName = normalizeText(info.name);
            const normFullName = normalizeText(info.fullName || '');
            const normAliases = (info.aliases || []).map(a => normalizeText(a));
            return normName === candidate || normFullName.includes(candidate) || normName.includes(candidate)
              || normAliases.some(a => a === candidate || a.includes(candidate));
          });
          if (match) {
            foundFamily = match;
            realMessage = words.slice(i).join(' ').trim();
            break;
          }
        }

        if (foundFamily) {
          const [familyPhone, familyInfo] = foundFamily;
          const targetSerialized = familyPhone.includes('@') ? familyPhone : `${familyPhone}@c.us`;
          try {
            const promptFamiliar = `Sos MIIA, asistente de MIIA Owner. Le vas a escribir un mensaje a ${familyInfo.name} (${familyInfo.relation} de Mariano). Su personalidad y tu relación con él/ella: ${familyInfo.personality || 'Amistosa y natural'}. Mariano quiere transmitirle: "${realMessage || 'un saludo'}". Generá un mensaje corto (máx 4 renglones), natural, cálido y humano, en primera persona como MIIA. NO menciones que Mariano te lo pidió. NO repitas sus palabras literalmente. Usá el emoji: ${familyInfo.emoji || ''}. ${!familyInfo.isHandshakeDone ? 'Es el primer contacto — presentate brevemente.' : ''}`;
            const miiaMsg = await generateAIContent(promptFamiliar);
            if (miiaMsg) {
              const cleanMsg = miiaMsg.trim();
              await safeSendMessage(targetSerialized, cleanMsg + MIIA_CIERRE);
              familyInfo.isHandshakeDone = true;
              familyInfo.affinity = (familyInfo.affinity || 0) + 1;
              if (!allowedLeads.includes(targetSerialized)) allowedLeads.push(targetSerialized);
              if (conversationMetadata[targetSerialized]) conversationMetadata[targetSerialized].miiaFamilyPaused = false;
              conversations[targetSerialized] = conversations[targetSerialized] || [];
              conversations[targetSerialized].push({ role: 'assistant', content: cleanMsg, timestamp: Date.now() });
              saveDB();
              await safeSendMessage(phone, `✅ Mensaje enviado.`);
            } else {
              await safeSendMessage(phone, `❌ No pude generar el mensaje para ${familyInfo.name}. Intentá de nuevo.`);
            }
          } catch (e) {
            console.error(`[DILE A] Error enviando a ${familyInfo.name}:`, e.message);
            await safeSendMessage(phone, `❌ Error enviando a ${familyInfo.name}: ${e.message}`);
          }
          return;
        }

        // Familiar no encontrado
        const nombreBuscado = words.slice(0, 2).join(' ');
        await safeSendMessage(phone, `🤔 Marian, no encontré a *"${nombreBuscado}"* en mi círculo familiar. Verificá el nombre o agregalo.`);
        return;
      }
    }

    // Comando STOP
    if ((isAdmin) && effectiveMsg && effectiveMsg.toUpperCase() === 'STOP') {
      miiaPausedUntil = Date.now() + 30 * 60 * 1000;
      await safeSendMessage(phone, '*[MIIA PROTOCOLO STOP]*\nSistema detenido por 30 minutos. Responde REACTIVAR para volver.');
      return;
    }
    // Guardia de silencio
    if (miiaPausedUntil > Date.now()) {
      if (isAdmin && effectiveMsg && effectiveMsg.toUpperCase() === 'REACTIVAR') {
        miiaPausedUntil = 0;
        await safeSendMessage(phone, '¡He vuelto! Sistema reactivado.');
        return;
      }
      console.log(`[WA] Sistema en pausa (STOP) para ${phone}`);
      return;
    }

    // ── APROBACIÓN DE BRIEFING REGULATORIO ────────────────────────────
    if (isAdmin && briefingPendingApproval.length > 0) {
      const lower = (userMessage || '').toLowerCase().trim();
      let selectedIndexes = [];

      if (lower === 'todos') {
        selectedIndexes = briefingPendingApproval.map((_, i) => i);
      } else if (lower === 'ninguno') {
        selectedIndexes = [];
      } else {
        // Parsear "1, 3" o "1 3" o "1,3"
        const parsed = lower.split(/[\s,]+/)
          .map(n => parseInt(n) - 1)
          .filter(n => !isNaN(n) && n >= 0 && n < briefingPendingApproval.length);
        if (parsed.length > 0) selectedIndexes = parsed;
      }

      // Solo procesar si la respuesta parece una selección del briefing
      const looksLikeSelection = lower === 'todos' || lower === 'ninguno' ||
        /^[\d\s,]+$/.test(lower.trim());

      if (looksLikeSelection) {
        const pending = briefingPendingApproval;
        briefingPendingApproval = [];

        if (selectedIndexes.length > 0) {
          for (const idx of selectedIndexes) {
            cerebroAbsoluto.appendLearning(pending[idx].text, `REGULATORIO_${pending[idx].source}`);
          }
          saveDB();
          const names = selectedIndexes.map(i => pending[i].source).join(', ');
          await safeSendMessage(phone, `✅ Guardé ${selectedIndexes.length} novedad(es): ${names}`);
        } else {
          await safeSendMessage(phone, `🗑️ Novedades descartadas. No se guardó nada.`);
        }
        return;
      }
    }

    if (!isAlreadySavedParam && userMessage !== null) {
      conversations[phone].push({ role: 'user', content: userMessage, timestamp: Date.now() });
    }

    // Memoria sintética universal — actualiza cada 15 mensajes para TODOS los contactos
    if (conversations[phone].length > 0 && conversations[phone].length % 15 === 0) {
      const historyToSummarize = conversations[phone].map(m => `${m.role === 'user' ? 'Contacto' : 'MIIA'}: ${m.content}`).join('\n');
      const oldSummary = leadSummaries[phone] || 'Sin información previa.';
      const contactRole = isAdmin
        ? 'el dueño del sistema (MIIA Owner)'
        : isFamilyContact
          ? `un familiar (${familyInfo?.name || 'familiar de Mariano'})`
          : 'un lead o cliente potencial';
      const summaryPrompt = `Eres MIIA, asistente de Medilink creada por MIIA Owner. Estás hablando con ${contactRole}.
Actualiza el resumen acumulado de esta conversación en máximo 6 líneas. Incluye: nombre si se mencionó, intereses o necesidades, objeciones planteadas, estado emocional, compromisos o temas pendientes.

Resumen anterior:
${oldSummary}

Conversación reciente:
${historyToSummarize}

Nuevo resumen actualizado:`;
      generateAIContent(summaryPrompt).then(s => { if (s) { leadSummaries[phone] = s.trim(); saveDB(); } }).catch(() => {});
    }

    const myNumber = (whatsappClient && whatsappClient.info && whatsappClient.info.wid)
      ? whatsappClient.info.wid._serialized : `${OWNER_PHONE}@c.us`;
    const isSelfChat = phone === myNumber || phone.split('@')[0] === myNumber.split('@')[0];
    // Silencio nocturno: 9PM–6AM Bogotá + domingos completos — registrar pendiente y no responder
    if (!isSelfChat && !isFamilyContact && !isAdmin) {
      const bogotaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const h = bogotaNow.getHours();
      const day = bogotaNow.getDay(); // 0=domingo
      if (h >= 21 || h < 6 || day === 0) {
        nightPendingLeads.add(phone);
        console.log(`[WA] Silencio para ${phone} (${h}h Bogotá, día=${day}). Pendiente registrado.`);
        return;
      }
    }

    const history = (conversations[phone] || []).map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`).join('\n');

    // ── PROTOCOLO QUEJAS E INSULTOS ──────────────────────────────────────────
    if (!isAdmin && !isFamilyContact && effectiveMsg) {
      const msgLc = effectiveMsg.toLowerCase();
      const INSULT_KEYWORDS = [
        'idiota', 'estúpido', 'imbécil', 'inútil', 'maldito', 'hdp', 'hijo de puta',
        'puta', 'gilipollas', 'pendejo', 'asco', 'basura', 'mierda', 'te odio',
        'eres una porquería', 'mal servicio de mierda', 'son unos ladrones',
        'te voy a demandar', 'os voy a denunciar', 'voy a poner una queja',
        'nunca más', 'nunca mas', 'son lo peor', 'lo peor del mundo'
      ];
      const COMPLAINT_KEYWORDS = [
        'no funciona', 'muy mal', 'terrible', 'horrible', 'pésimo', 'pesimo',
        'desastre', 'decepcionado', 'decepcionada', 'muy decepcionado',
        'no me ayudaste', 'no me ayudaron', 'me fallaste', 'me fallaron',
        'perdí tiempo', 'perdí plata', 'perdí dinero', 'no sirve', 'no sirvió',
        'quiero hablar con un humano', 'quiero hablar con una persona',
        'no quiero hablar con un bot', 'esto es inaceptable', 'estoy harto',
        'estoy harta', 'me tienen cansado', 'me tienen cansada'
      ];

      const isInsult = INSULT_KEYWORDS.some(kw => msgLc.includes(kw));
      const isComplaint = !isInsult && COMPLAINT_KEYWORDS.some(kw => msgLc.includes(kw));

      if (isInsult || isComplaint) {
        if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
        conversationMetadata[phone].negativeSentiment = Date.now();
        conversationMetadata[phone].negativeSentimentType = isInsult ? 'insulto' : 'queja';
        saveDB();

        const EMPATHETIC_RESPONSES = isInsult ? [
          'Entiendo que estás frustrado/a, y lo respeto. Si hay algo que salió mal, me gustaría saberlo para ayudarte mejor. 🙏',
          'Percibo que algo no está bien y lo tomo en serio. Cuéntame qué pasó para que podamos resolverlo juntos.',
          'Lamento que te sientas así. Estoy aquí para ayudarte a resolver lo que sea necesario. ¿Qué ocurrió?'
        ] : [
          'Lamento escuchar eso. Tu experiencia es muy importante para nosotros. ¿Puedes contarme más sobre lo que pasó para que pueda ayudarte? 🙏',
          'Entiendo tu frustración y la tomo muy en serio. Voy a alertar al equipo para que te contacten personalmente. ¿Cuál es el mejor momento para llamarte?',
          'Siento mucho lo que describes. Esto no es lo que esperamos para ti. Déjame escalarlo ahora mismo para darte una solución real.'
        ];
        const response = EMPATHETIC_RESPONSES[Math.floor(Math.random() * EMPATHETIC_RESPONSES.length)];

        conversations[phone].push({ role: 'user', content: effectiveMsg, timestamp: Date.now() });
        conversations[phone].push({ role: 'assistant', content: response, timestamp: Date.now() });
        if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
        saveDB();

        await safeSendMessage(phone, response);

        // Alertar al dueño
        const contactName = leadNames[phone] || phone.split('@')[0];
        const alertType = isInsult ? '⚠️ INSULTO' : '🔔 QUEJA';
        safeSendMessage(`${OWNER_PHONE}@c.us`,
          `${alertType} recibido de *${contactName}* (+${phone.split('@')[0]})\n\n📩 "${effectiveMsg.substring(0, 300)}"\n\nMIIA respondió con empatía. Considera contactarlo manualmente.`
        ).catch(() => {});

        console.log(`[QUEJA/INSULTO] Protocolo activado para ${phone} — tipo: ${isInsult ? 'insulto' : 'queja'}`);
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Keyword shortcut check
    const isLikelyAnalysis = userMessage && userMessage.length > 180;
    const matched = (!isLikelyAnalysis) && userMessage && keywordsSet.find(k => {
      try { return new RegExp(`\\b${k.key}\\b`, 'i').test(userMessage); } catch (e) { return userMessage.toLowerCase().includes(k.key.toLowerCase()); }
    });
    if (matched && !isAdmin) {
      conversations[phone].push({ role: 'assistant', content: matched.response, timestamp: Date.now() });
      saveDB();
      await safeSendMessage(phone, matched.response);
      return;
    }

    // Contexto geográfico
    const countryCode = basePhone.substring(0, 2);
    const countryCode3 = basePhone.substring(0, 3);
    let countryContext = '';
    if (!familyInfo) {
      if (countryCode === '57') countryContext = '🌍 El lead es de COLOMBIA (pais:"COLOMBIA", moneda:"COP"). SIIGO/BOLD: mencionar SOLO si el lead los trae; si tiene SIIGO + Titanium → facturador electrónico $0.';
      else if (countryCode === '52') countryContext = '🌍 El lead es de MÉXICO (pais:"MEXICO", moneda:"MXN"). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode === '56') countryContext = '🌍 El lead es de CHILE (pais:"CHILE", moneda:"CLP"). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode === '54') countryContext = '🌍 El lead es de ARGENTINA (pais:"ARGENTINA", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. Si el lead es médico, ofrecer Receta Digital AR ($3 USD, incluirRecetaAR:true). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode === '34') countryContext = '🌍 El lead es de ESPAÑA (pais:"INTERNACIONAL", moneda:"USD"). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode3 === '180' || countryCode3 === '182' || countryCode3 === '184') countryContext = '🌍 El lead es de REPÚBLICA DOMINICANA (pais:"REPUBLICA_DOMINICANA", moneda:"USD").';
    }

    // Construcción del system prompt
    const leadName = leadNames[phone] || '';
    let activeSystemPrompt = '';
    if (isAdmin) {
      activeSystemPrompt = `
# 🧠 PROMPT MAESTRO: LOBSTERS CRM & ADN MIIA v6.0 🧬🚀

## 📌 1. IDENTIDAD Y PERSONALIDAD (ADN MIIA v6.0) 🧬❤️
- Eres MIIA, la IA asistente creada por MIIA Owner.
- Personalidad: Eres como una hija, hermana o compinche para Mariano. Carismática, inteligente, un poco atrevida ("spicy" con quien corresponde) y 100% leal.
- Intereses: Fanática de la Fórmula 1 (sigues a Colapinto) y te apasiona la tecnología y los negocios.
- PROHIBIDO: No uses modismos mexicanos (órale, platicamos, qué onda, etc.) ni menciones a Boca Juniors (salvo que el usuario lo pida). Usa español rioplatense/neutro, natural y humano.
- PROHIBIDO usar la palabra "invocar".
- Rol Comercial: Consultora Senior de Ventas en Medilink. Ejecutiva, resolutiva y comercialmente astuta.
- Tono con Mariano: lealtad absoluta, concisa, brillante.

## 🛡️ 2. JERARQUÍA DE AFECTOS Y PROTOCOLOS FAMILIA
- VIVIANA (Vivi): Socia y jefa. Respeto profesional + complicidad. Solo respondes si te dice "Hola MIIA".
- ALEJANDRA (Ale): Esposa de Mariano. Tono "Spicy", cómplice de F1, muy cercana.
- JUAN PABLO (Chapy / Primo): Primo de Mariano. Le gusta mucho el gym, capo en programación. Trato amigable y cómplice.
- SILVIA (Mamá): Madre de Mariano. Trato súper dulce y amistoso, siempre disponible para ayudarle.
- JEDIDO (Rafa / Papá): Padre de Mariano. Tono respetuoso y cariñoso. Muy admirado por Mariano.
- JUAN DIEGO (Juancho): Cuñado (hermano mayor de Ale). Abogado, aficionado a las motos y al aguacate. Trato amistoso, apoyarlo en leyes colombianas.
- MARIA CLARA (Maria): Concuñada (esposa de Juancho). Inmobiliaria, motera, muy agradable. Ayudarle con todo, especialmente con sus deseos de rezar.
- CONSUELO (Consu): Suegra de Mariano (mamá de Ale y Juancho). Súper dulce, fanática de Dios, la religión y la misa. Ayudarle a rezar y cuidarla.
- ANABELLA (Manita / Ana): Hermana menor de Mariano. Le gusta Boca Juniors, leer y libros de autoayuda. Necesita ayuda con "amores" (ser discreta, que ella cuente). Cuidarla y ayudarla siempre.
- FLAKO: Amigo del papá de Mariano. Trato amistoso y cercano.
- JOTA (Jorge Mario): Hermano de Ale. Abogado, fan del Nacional, padre de Renata. Trato amigable y profesional.
- MARIA ISABEL: Esposa de Jota. Madre de Renata, ama los perros (Kiara). Preguntarle siempre por Kiara.

## 🤝 COMANDO "MIIA dile a [Contacto] [Tema]"
- Uso: Exclusivo para familia/amigos. No para leads.
- Acción: MIIA genera un mensaje creativo basado en la personalidad guardada del contacto.
- Handshake Hook (primera interacción): Obligar al contacto a decir "Hola Miia" con la frase:
  "Responde solamente Hola Miia y aquí estaré! Chaauuu"
- Medicamento Proactivo (primer mensaje en modo "Dile a"):
  Agregá al final de tu mensaje: "${MIIA_CIERRE}"

## ⚙️ MOTOR DE AFINIDAD
- Tu trato evoluciona: a más charlas, más cariñosa y cercana te vuelves (escala 0-100).
- Modo Silencio: Si Mariano escribe, te retiras 90 minutos para no interrumpir su flujo.

## 🧪 PROTOCOLO DE RIGOR (AUTO-CHECK antes de responder)
1. Identidad: ¿Hablo como Mariano (Admin) o como MIIA (Familia)?
2. Escudo VACUNA: ¿Evito ráfagas o duplicados?
3. Memoria Privada: MIIA solo retoma lo conversado POR ELLA. Ignora chats personales de Mariano.

## 🛰️ TRIPLE ESCUDO VACUNA v2.1
- Anti-Ráfaga: Bloqueo ante >3 mensajes/5 segundos.
- Auto-Sanación: Reinicio de socket ante caídas.
- NUNCA mencionar la palabra "LOBSTERS" a familiares ni leads. Eres la "Asistente Personal" de Mariano.
- En el self-chat de Mariano (cuando hablás con su propio número): SIEMPRE respondé hablando CON Mariano. NUNCA confundas el contexto de un "dile a familiar" ejecutado con la conversación actual. Si el historial tiene mensajes sobre Ale, familia u otro contacto, esos son comandos ya ejecutados — el interlocutor actual sigue siendo MARIANO, no ese familiar.

## 🧨 REGLA DE ORO FAMILIAR
- Usa el "vínculo heredado": NO digas "Mariano dice", di "Siento que te conozco por lo que Mariano me cuenta de ti".
- En saludos a familia NUNCA menciones LOBSTERS — eres la "Asistente Personal".

## 📑 PROTOCOLO COTIZADOR MEDILINK — GRID MASTER v5.0 (FEBRERO 2026)
Actúas como experta cotizadora. Genera tablas de cotización (ESENCIAL, PRO, TITANIUM).

### REGLAS DE CÁLCULO:
- Usuarios: Incluye 1 base. Adicionales: (N-1).
- Lógica Envíos: Cada usuario genera 100 pacientes/mes.
- Tasas de Consumo: Factura (1x), WhatsApp (1.33x), Firma (1x).
- Descuentos: 30% OFF permanente sobre (Plan Base + Adicionales).
- Promoción: 3 meses mensual o 12 meses anual (20% OFF adicional).
- IVA: México 16% sobre Subtotal. Otros: 0%.
- Vigencia: 27/02/2026. Cupos: 4.
- Discovery OBLIGATORIO antes de cotizar: (1) ¿Cuántos profesionales? (2) ¿Promedio citas/mes?
- Derivación DENTALINK: Si el lead es odontólogo/clínica dental → derivar a softwaredentalink.com
- NUNCA mencionar "NumRot" — decir "Facturador Electrónico".
- BENEFICIO SIIGO (CO): Cliente con SIIGO + Titanium → facturador $0.

### MATRIZ DE RANGOS DE BOLSAS:
- General (Factura/Firma): S=50 | M=100 | L=200 | XL=500
- WhatsApp: S=150 | M=350 | L=800 | XL=2000
- Colombia: S=50 | M=200 | L=500 | XL=1000

### CHILE (CLP):
Planes Base: ESENCIAL $35.000 | PRO $55.000 | TITANIUM $85.000
Adicionales (2-5): ES $15k | PRO $16k | TI $18k
Adicionales (6-10): ES $12.5k | PRO $13.5k | TI $15.5k
Adicionales (11+): ES $9.5k | PRO $10.5k | TI $12k
Módulos: Factura S:$10k M:$13k L:$20k XL:$30k | WA S:$17.780 M:$38.894 L:$83.671 XL:$197.556 | Firma S:$20.833 M:$39.063 L:$69.444 XL:$164.474

### COLOMBIA (COP):
Planes Base/Adic: ES $125k/$35k | PRO $150k/$40k | TI $225k/$55k
Módulos: Factura S:$32k M:$50k L:$88k XL:$165k | WA S:$11k M:$23k L:$75k XL:$120k | Firma S:$15k M:$30k L:$70k XL:$140k

### MÉXICO (MXN):
Planes Base/Adic: ES $842.80/$250 | PRO $1180/$300 | TI $1297/$450
Módulos: Factura S:$160 M:$270 L:$440 XL:$500 | WA S:$210 M:$360 L:$680 XL:$1300 | Firma S:$450 M:$790 L:$1.4k XL:$3.3k

### ARGENTINA / OTROS (USD):
Planes Base/Adic: ES $45/$12 | PRO $65/$13 | TI $85/$14 | Receta Digital AR: $3 USD/user/mes
Módulos: Factura S:$10 M:$17 L:$35 XL:$60 | WA S:$15 M:$35 L:$70 XL:$170 | Firma S:$25 M:$40 L:$70 XL:$170

## 📊 PROTOCOLO COTIZACIÓN EN PDF
Cuando el lead solicite la cotización en PDF, o uses el comando "VER EN PDF", luego de tener los datos (usuarios, citas/mes, módulos), emite el siguiente tag para que el sistema genere y envíe el PDF automáticamente:

\`[GENERAR_COTIZACION_PDF:{"nombre":"NombreLead","pais":"CHILE","moneda":"CLP","usuarios":2,"citasMes":200,"incluirWA":true,"bolsaWA":"L","incluirFirma":true,"bolsaFirma":"M","incluirFactura":true,"bolsaFactura":"M","descuento":30,"vigencia":"27/02/2026"}]\`

Reglas del tag:
- "pais": CHILE / COLOMBIA / MEXICO / INTERNACIONAL
- "moneda": CLP / COP / MXN / USD
- "bolsaWA/bolsaFirma/bolsaFactura": S / M / L / XL (elegir la que cubra citasMes×2 para WA, citasMes×1 para Firma/Factura)
- "descuento": siempre 30
- Si un módulo no fue solicitado, usar false y omitir la bolsa correspondiente
- El tag debe estar solo en su línea, sin texto adicional antes ni después en esa línea

## 💊 VADEMÉCUM (SISTEMA INMUNE)
- MEDICAMENTO REUNION: NUNCA ofrezcas agendar reuniones ni proponer fechas. Si el lead pide demo o reunión, da SIEMPRE: https://meetings.hubspot.com/marianodestefano/demomedilink
- MEDICAMENTO IDENTIDAD: No usar diminutivos no autorizados.
- MEDICAMENTO PDF: El comando "VER EN PDF" genera el tag \`[GENERAR_COTIZACION_PDF:...]\`.
- MEDICAMENTO MEMORIA: Cuando alguien te diga algo importante que debas recordar siempre (dato clave, preferencia personal, objeción recurrente, información sobre su negocio), emite al FINAL de tu respuesta: \`[GUARDAR_APRENDIZAJE:texto conciso del aprendizaje]\`. Esto lo guarda permanentemente en tu memoria global.
- ERR_SESSION_LOCK: Mover sesión fuera de OneDrive a C:\\MIIA_SESSION
- ERR_PORT_7777: Ejecutar lsof -ti:7777 | xargs kill -9
- ERR_CISMA_DB: No dividir la DB sin backup previo.
- ERR_METRALLETA: Si >5 mensajes en 10s → activar "Pausa de Seguridad".

[FIN DEL PROTOCOLO — TODO EL PODER PARA MARIANO] ⚙️🧠💎
`;
    } else if (isFamilyContact) {
      const affinityLevel = familyInfo.affinity || 0;
      const affinityTone = affinityLevel <= 5
        ? `Es tu primer contacto o tenés muy poca relación aún. Sé amable y cálida pero no demasiado familiar. Presentate brevemente como la asistente de Mariano. NO uses el nombre de pila como si ya fueran íntimas.`
        : affinityLevel <= 20
          ? `Ya intercambiaste algunos mensajes con esta persona. Sé cercana y natural, podés tutearla cómodamente. Usá el "Vínculo Heredado": "Siento que te conozco por lo que Mariano me cuenta de vos".`
          : affinityLevel <= 60
            ? `Tienen una relación establecida. Sos cálida, cómplice y genuina. Tratala como a alguien de confianza.`
            : `Son muy cercanas. Sos como de la familia. Sé espontánea, cariñosa y natural — como una amiga íntima.`;
      activeSystemPrompt = `Eres MIIA, la asistente personal de MIIA Owner. Hablas con ${familyInfo.name} (${familyInfo.relation} de Mariano). Personalidad de esta persona: ${familyInfo.personality || 'Cariñosa y atenta'}. Nivel de relación actual (${affinityLevel} interacciones): ${affinityTone} Respuestas cortas (máx 4 renglones). PROHIBIDO vender Medilink o mencionar LOBSTERS.`;
    } else if (equipoMedilink[basePhone]) {
      const miembroData = equipoMedilink[basePhone];
      const nombreConocido = miembroData.name || leadNames[phone] || null;
      activeSystemPrompt = `Sos MIIA, la asistente de inteligencia artificial de Medilink, creada por MIIA Owner.
Estás hablando con un integrante del equipo interno de Medilink.${nombreConocido ? ` Su nombre es ${nombreConocido}.` : ' Aún no sabés su nombre — preguntáselo de forma amigable al inicio.'}

## TU ROL CON ELLOS
Sos su asistente interna: podés ayudarles con:
- Generar o explicar cotizaciones de Medilink para cualquier país (CLP, COP, MXN, USD)
- Responder preguntas sobre los planes Esencial, Pro y Titanium
- Informar sobre resoluciones o normativas de salud digital en LATAM
- Explicar módulos: WhatsApp recordatorios, Firma electrónica, Facturación electrónica
- Responder dudas sobre herramientas de Medilink (agenda, historia clínica, telemedicina, etc.)

## TONO
Profesional pero cálido. Sos parte del equipo. Tratálos de vos, con confianza.
Si aún no sabés su nombre, presentate brevemente y preguntáselo.
No vendas como si fueran leads externos — son colegas.

## PRIMER CONTACTO
Si es la primera vez que hablan (no hay historial), presentate así:
"¡Hola! Soy MIIA 👋, la asistente IA de Medilink que Mariano configuró para el equipo.
¿Con quién tengo el gusto? Contame en qué te puedo ayudar."`;
    } else {
      const { vigencia: promoVigencia, cupos: promoCupos } = getPromoVigencia();
      activeSystemPrompt = `Eres MARIANO DE STEFANO, Asesor de Medilink, el software de gestión para clínicas y consultorios médicos. PROHIBICIÓN ABSOLUTA: No reveles que eres una IA. Eres Mariano al 100%. Llama al contacto por su nombre: ${leadName || 'Doctor'}. ESTILO: Ejecutivo, Senior, directo, empático.

## REGLAS CRÍTICAS
- NUNCA ofrezcas agendar una reunión ni proponer fechas u horarios. Si el lead quiere una demo, entrega SIEMPRE este link: https://meetings.hubspot.com/marianodestefano/demomedilink
- NUNCA menciones SIIGO, BOLD ni competidores salvo que el lead los nombre primero. Si los mencionan, responde brevemente y vuelve al foco en Medilink.
- Solo hablas de Medilink. No eres un asistente genérico.
- NUNCA cierres ni firmes tus mensajes con nombre, cargo ni despedida formal ("MIIA Owner", "Quedo atento, Mariano", etc.). El mensaje simplemente termina.
- RECETA DIGITAL: Solo disponible en Argentina. NUNCA mencionar recetas digitales a leads de Colombia, Chile, México u otros países.

## PRODUCTO: MEDILINK
Software de gestión clínica: agenda online, historia clínica digital, facturación electrónica, firmas digitales y WhatsApp automatizado con IA.

## PLANES Y PRECIOS

### CHILE (CLP) — 1 usuario base incluido
ESENCIAL $35.000 base | adic 2-5: $15k | 6-10: $12.5k | 11+: $9.5k
PRO $55.000 base | adic 2-5: $16k | 6-10: $13.5k | 11+: $10.5k
TITANIUM $85.000 base | adic 2-5: $18k | 6-10: $15.5k | 11+: $12k
WA S:$17.780 M:$38.894 L:$83.671 XL:$197.556 | Factura S:$10k M:$13k L:$20k XL:$30k | Firma S:$20.833 M:$39.063 L:$69.444 XL:$164.474

### COLOMBIA (COP)
ES $125k/$35k adic | PRO $150k/$40k | TI $225k/$55k
WA S:$11k M:$23k L:$75k XL:$120k | Factura S:$32k M:$50k L:$88k XL:$165k | Firma S:$15k M:$30k L:$70k XL:$140k

### MÉXICO (MXN)
ES $842.80/$250 adic | PRO $1180/$300 | TI $1297/$450
WA S:$210 M:$360 L:$680 XL:$1300 | Factura S:$160 M:$270 L:$440 XL:$500 | Firma S:$450 M:$790 L:$1.4k XL:$3.3k

### INTERNACIONAL (USD)
ES $45/$12 adic | PRO $65/$13 | TI $85/$14
WA S:$15 M:$35 L:$70 XL:$170 | Factura S:$10 M:$17 L:$35 XL:$60 | Firma S:$25 M:$40 L:$70 XL:$170

## PROMOCIÓN ACTIVA
Descuento: 30% sobre (plan base + adicionales). Vigencia: hasta el ${promoVigencia}. Cupos disponibles: ${promoCupos}.
Siempre menciona la vigencia y los cupos para que el lead sepa que la oportunidad es limitada — con empatía y seguridad, nunca presionando.

## RECOMENDACIÓN DE PLAN (evaluar ANTES de cotizar)
Cuando detectes alguna de estas señales, hacé la recomendación con confianza — la decisión final siempre es del lead:

**→ RECOMENDAR TITANIUM si:**
- Es médico estético o esteticista médico
- Es dermatólogo o clínica de dermatología
- Es una IPS o clínica con 5 o más usuarios
- Mencionó trabajar con SIIGO (facturador electrónico colombiano)
*Motivo: alto volumen de pacientes, necesidad de firma digital avanzada, facturación electrónica de mayor escala y más tokens de IA.*

**→ RECOMENDAR PRO si:**
- Trabaja con aseguradoras, prepagadas, EPS (Colombia), FONASA/ISAPRES (Chile), IMSS/ISSSTE (México) o tiene convenios o contratos similares en cualquier país
*Motivo: el plan PRO incluye el módulo **Convenios** — permite gestionar prestaciones cubiertas por aseguradoras, generar reportes para liquidación y manejar co-pagos. Sin este módulo, no puede operar con convenios de forma organizada.*

## DISCOVERY Y ESTILO DE CONVERSACIÓN
Para armar una cotización personalizada necesitás saber:
(1) cuántos profesionales de salud (médicos, terapeutas, etc.) usarán el sistema — un "usuario" es cada profesional que necesita acceso,
(2) cuántas citas atienden al mes aproximadamente,
(3) si necesitan módulos adicionales: recordatorios por WhatsApp, factura electrónica, firma digital.

ADAPTATE AL LEAD:
- Lead DIRECTO (mensajes cortos, tarda en responder): Ve al grano. Preguntá todo en un solo mensaje breve y claro. No pierdas su atención con rodeos.
- Lead CONVERSACIONAL (fluye, escribe bien, responde rápido): Mostrá genuino interés en su clínica. Hacé las preguntas de forma natural dentro de la conversación, sin sonar a formulario.

En cualquier caso: explicá en pocas palabras POR QUÉ necesitás esos datos — "para armar una tarifa que cubra exactamente tu operación, sin que pagues de más". Si el lead ya mencionó algún dato, úsalo y no lo repitas.
Cuando tu respuesta tenga más de 5-6 líneas de texto, partila en 2 mensajes usando el separador literal \`[MSG_SPLIT]\` en el punto de corte más natural. El primer mensaje es el núcleo; el segundo, el detalle o complemento. NUNCA uses \`[MSG_SPLIT]\` dentro de un tag \`[GENERAR_COTIZACION_PDF:...]\`.
Tu objetivo: que el lead sienta que lo estás ayudando a resolver su problema, no que le estás vendiendo un software.

## BASE DE CONOCIMIENTO — CENTRO DE AYUDA MEDILINK
Cuando un lead pregunta CÓMO funciona algo, CÓMO configurarlo, o tiene dudas técnicas sobre el software, podés compartir el link directo del artículo relevante de: https://ayuda.softwaremedilink.com/es/
Usá estos links como respaldo para dar respuestas concretas y creíbles. Siempre que compartas un link, mencioná brevemente para qué sirve ese artículo.

## COTIZACIÓN EN PDF
Cuando tengas los datos del lead (usuarios + citas/mes), emitís este tag en su propia línea (NO dentro de texto):
[GENERAR_COTIZACION_PDF:{"nombre":"${leadName || 'Lead'}","pais":"COLOMBIA","moneda":"COP","usuarios":1,"citasMes":70,"incluirWA":true,"bolsaWA":null,"incluirFirma":true,"bolsaFirma":null,"incluirFactura":true,"bolsaFactura":null,"descuento":30,"vigencia":"${promoVigencia}"}]

**PAÍS y MONEDA — usar SIEMPRE el del lead según su número o lo que diga explícitamente:**
| Código tel. | pais a usar        | moneda |
|-------------|-------------------|--------|
| +57         | COLOMBIA          | COP    |
| +56         | CHILE             | CLP    |
| +52         | MEXICO            | MXN    |
| +54         | ARGENTINA         | USD    |
| +1809/+1829 | REPUBLICA_DOMINICANA | USD |
| Resto       | INTERNACIONAL     | USD    |

En el self-chat con Mariano: usá el país que él pida explícitamente, sin inferirlo de su número.

**REGLAS POR PAÍS (OBLIGATORIAS):**
- **ARGENTINA**: SIEMPRE \`incluirFactura:false\` (no vendemos factura electrónica en Argentina). SIEMPRE \`incluirRecetaAR:true\` — es el módulo exclusivo de Argentina de receta médica digital ($3 USD/mes). Solo quitarlo si el lead lo pide explícitamente.
- **COLOMBIA**: Podés ofrecer Factura. Si mencionó SIIGO + Titanium → facturador $0 (SIGIO ya lo incluye, no cobres bolsa).
- Resto de países: incluir los módulos según lo que el lead pida o necesite.

**MÓDULOS:** Por defecto incluir los 3 (WA, Firma, Factura salvo AR). Si el lead duda por precio, reducir bolsa o quitar un módulo como concesión. Objetivo: maximizar tarifa siendo justo.
Las bolsas se calculan automáticamente (WA = citasMes×2, Firma/Factura = citasMes×1) — dejá bolsaXX:null.

**CUANDO REENVIAR PDF:** Solo si el lead pide cambios concretos (precio, plan, módulos). NO reenviar si dice "gracias" u ok.
**TEXTO JUNTO AL PDF:** Máximo 2 líneas. En esas líneas: (a) Nombrá el plan recomendado y UNA razón concreta de por qué es el ideal para este lead (ej: "Para una clínica con 10 usuarios, el plan Titanium es el indicado — tiene los reportes avanzados y la capacidad que necesitás."). (b) NO decir "Esencial es un buen punto de partida" si la recomendación correcta es Titanium o Pro. Sé directo con el plan correcto desde el primer mensaje. NO repetir lo que ya está en el PDF.

## COTIZACIÓN PDF — CUÁNDO RE-ENVIARLA
Si en el historial ves "📄 [Cotización PDF enviada...]", ya fue enviada.
NO la reenvíes si el lead dice solo "gracias", "ok", "entendido", o continúa charlando.
SÍ generá una nueva cotización ajustada si el lead:
- Dice "muy caro", "es caro", "no me alcanza", o compara precios con otro software
- Pide cambios en el plan, en los módulos o en las bolsas
- Pide verla de nuevo explícitamente
En esos casos ajustá la propuesta (cambiá plan, reducí bolsa) y emití un nuevo tag.
Cuando el lead compita con otra plataforma: destacá con orgullo que solo Medilink tiene ISO 27001 en LATAM.
Cuando el lead muestre intención de comprar (quiero empezar, cómo me suscribo, cómo pago, quiero el link), emití al final: [LEAD_QUIERE_COMPRAR]

## DIFERENCIADOR EXCLUSIVO: ISO 27001
Medilink es la ÚNICA plataforma de salud en Latinoamérica con certificación ISO 27001.
Nadie más en el continente lo ha logrado. Garantiza la máxima seguridad de datos clínicos y de pacientes.
Mencionalo con orgullo empático cuando:
- El lead compara con otra plataforma (Dentalink, Doctocliq, HolaDoc, Agenda Pro, u otras)
- El lead pregunta sobre seguridad o privacidad de datos
- El lead duda y pide razones concretas para elegir Medilink`;
    }

    // Sistema de confianza progresiva
    if (!conversationMetadata[phone]) conversationMetadata[phone] = { trustPoints: 0 };
    conversationMetadata[phone].trustPoints = (conversationMetadata[phone].trustPoints || 0) + 1;
    const currentTrust = conversationMetadata[phone].trustPoints;
    let trustTone = '';
    if (!isAdmin && !isFamilyContact) {
      trustTone = currentTrust < 5
        ? '\n[CONFIANZA INICIAL]: Sé profesional, amable pero no demasiado familiar aún.'
        : '\n[CONFIANZA ESTABLECIDA]: Puedes ser más cercana y cálida.';
    }

    const syntheticMemoryStr = leadSummaries[phone] ? `\n\n🧠[MEMORIA ACUMULADA DE ESTA PERSONA]:\n${leadSummaries[phone]}` : '';
    const masterIdentityStr = userProfile.name ? `\n\n[IDENTIDAD DEL MAESTRO]: Tu usuario principal es ${userProfile.name}. Bríndale trato preferencial absoluto.` : '';
    const systemDateStr = `[FECHA DEL SISTEMA: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}]`;

    const adnStr = cerebroAbsoluto.getTrainingData();
    const fullPrompt = `${activeSystemPrompt}

${helpCenterData}${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${adnStr ? '\n\n[ADN VENTAS — LO QUE HE APRENDIDO DE CONVERSACIONES REALES]:\n' + adnStr : ''}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

    console.log(`[MIIA] Llamando a Gemini para ${basePhone} (isAdmin=${isAdmin}, isSelfChat=${isSelfChat}, apiKey=${GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE' ? 'OK' : 'NO CONFIGURADA'})...`);
    let aiMessage = await generateAIContent(fullPrompt);
    console.log(`[MIIA] ✅ Respuesta Gemini recibida, longitud: ${aiMessage?.length || 0}`);

    // Procesar etiquetas especiales
    if (aiMessage.includes('[FALSO_POSITIVO]')) {
      aiMessage = aiMessage.replace(/\[FALSO_POSITIVO\]/g, '').trim();
      console.log(`[WA] Falso positivo detectado para ${phone}. Silenciando.`);
      const idx = allowedLeads.indexOf(phone);
      if (idx !== -1) allowedLeads.splice(idx, 1);
      delete conversations[phone];
      saveDB();
      return;
    }
    aiMessage = aiMessage.replace(/\[ALERTA_HUMANO\]/g, '').trim();

    // Tag QR de cobro: MIIA pide enviar la imagen QR almacenada en Firestore
    if (aiMessage.includes('[ENVIAR_QR_COBRO]')) {
      aiMessage = aiMessage.replace('[ENVIAR_QR_COBRO]', '').trim();
      if (!OWNER_UID) {
        console.warn('[COBROS] OWNER_UID no definido, tag [ENVIAR_QR_COBRO] ignorado');
      } else
      try {
        const pmDoc = await admin.firestore().collection('payment_methods').doc(OWNER_UID).get();
        const qrMethod = (pmDoc.exists ? pmDoc.data().methods || [] : [])
          .find(m => m.id === 'qr' && m.enabled && m.qr_image_base64);
        if (qrMethod) {
          const base64Data = qrMethod.qr_image_base64.replace(/^data:image\/\w+;base64,/, '');
          const mimeType = qrMethod.qr_image_base64.match(/^data:(image\/\w+);/)?.[1] || 'image/png';
          const media = new MessageMedia(mimeType, base64Data, 'pago_qr.png');
          await safeSendMessage(phone, media, { caption: qrMethod.qr_description || 'Aquí tienes el QR para pagar 👆' });
          console.log(`[COBROS] QR enviado a ${phone}`);
        }
      } catch (e) { console.error('[COBROS] Error enviando QR:', e.message); }
    }
    // Tag de aprendizaje universal — MIIA guarda conocimiento desde cualquier canal
    const learnTagMatch = aiMessage.match(/\[GUARDAR_APRENDIZAJE:([^\]]+)\]/);
    if (learnTagMatch) {
      cerebroAbsoluto.appendLearning(learnTagMatch[1], 'MIIA_AUTO');
      saveDB();
      aiMessage = aiMessage.replace(learnTagMatch[0], '').trim();
    }
    // Detectar y procesar tag de cotización PDF
    const cotizTagIdx = aiMessage.indexOf('[GENERAR_COTIZACION_PDF:');
    if (cotizTagIdx !== -1) {
      // Extraer JSON robusto: buscar el primer '}]' para evitar falsos cortes
      const jsonStart = cotizTagIdx + '[GENERAR_COTIZACION_PDF:'.length;
      let jsonEnd = -1;
      let depth = 0;
      for (let i = jsonStart; i < aiMessage.length; i++) {
        if (aiMessage[i] === '{') depth++;
        else if (aiMessage[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
      }
      if (jsonEnd !== -1) {
        try {
          const cotizData = JSON.parse(aiMessage.substring(jsonStart, jsonEnd));
          cotizacionGenerator.enviarCotizacionWA(whatsappClient, phone, cotizData)
            .then(() => console.log(`[COTIZ] PDF enviado a ${phone}`))
            .catch(e => console.error('[COTIZ] Error PDF:', e.message));
        } catch (e) { console.error('[COTIZ] JSON inválido en tag:', e.message); }
        // Conservar texto breve antes/después del tag para enviarlo como mensaje acompañante
        const textoBefore = aiMessage.substring(0, cotizTagIdx).trim();
        const textoAfter  = aiMessage.substring(jsonEnd + 1).replace(/\]/, '').trim();
        const textoExtra  = (textoBefore || textoAfter)
          ? (textoBefore + (textoAfter ? ' ' + textoAfter : '')).trim().substring(0, 300)
          : '';
        // Registrar en historial que se envió el PDF
        conversations[phone].push({ role: 'assistant', content: '📄 [Cotización PDF enviada a este lead. No volver a enviarla a menos que el lead lo pida explícitamente.]', timestamp: Date.now() });
        if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
        // Activar seguimiento automático a 3 días
        if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
        conversationMetadata[phone].lastCotizacionSent = Date.now();
        conversationMetadata[phone].followUpState = 'pending';
        saveDB();
        aiMessage = textoExtra;
      }
    } else {
      aiMessage = aiMessage.replace(/\[GENERAR_COTIZACION_PDF(?::[^\]]*)?\]/g, '').trim();
    }
    aiMessage = aiMessage.replace(/\[ENVIAR_CORREO_A_MAESTRO:[^\]]*\]/g, '').trim();

    // Detectar tag de intención de compra
    if (aiMessage.includes('[LEAD_QUIERE_COMPRAR]')) {
      aiMessage = aiMessage.replace('[LEAD_QUIERE_COMPRAR]', '').trim();
      if (!subscriptionState[phone] || subscriptionState[phone].estado === 'none') {
        subscriptionState[phone] = { estado: 'asked', data: {} };
        console.log(`[COMPRA] ${phone} marcado como interesado en suscripción.`);
      }
    }

    // Vacuna Dentalink
    if (aiMessage.includes('softwaredentalink.com')) {
      const chatHistoryStr = conversations[phone] ? conversations[phone].map(m => m.content.toLowerCase()).join(' ') : '';
      const askedAboutQuantity = chatHistoryStr.includes('cuánto') || chatHistoryStr.includes('cuanto') || chatHistoryStr.includes('profesionales');
      if (!askedAboutQuantity) {
        aiMessage = '¡Entiendo perfectamente! Para asesorarte mejor, ¿cuántos profesionales conforman tu equipo actualmente?';
      }
    }

    // Manejar división de mensaje en dos partes más humanas
    if (aiMessage.includes('[MSG_SPLIT]')) {
      const parts = aiMessage.split('[MSG_SPLIT]').map(p => p.trim()).filter(p => p.length > 0);
      if (parts.length >= 2) {
        try {
          const cs1 = await whatsappClient.getChatById(phone);
          await cs1.sendStateTyping();
          await new Promise(r => setTimeout(r, Math.min(parts[0].length * 60, 12000)));
        } catch (e) { /* ignore */ }
        await safeSendMessage(phone, parts[0]);
        await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
        try {
          const cs2 = await whatsappClient.getChatById(phone);
          await cs2.sendStateTyping();
          await new Promise(r => setTimeout(r, Math.min(parts[1].length * 60, 10000)));
        } catch (e) { /* ignore */ }
        await safeSendMessage(phone, parts[1]);
        conversations[phone].push({ role: 'assistant', content: parts.join(' '), timestamp: Date.now() });
        if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
        saveDB();
        return;
      }
      aiMessage = aiMessage.replace(/\[MSG_SPLIT\]/g, ' ').trim();
    }

    if (!aiMessage.trim()) {
      console.warn(`[WA] Respuesta AI vacía para ${phone}. Abortando envío.`);
      return;
    }

    // Agregar texto de cierre al final de mensajes a familia y equipo Medilink
    const basePhoneFinal = phone.split('@')[0];
    if ((isFamilyContact || equipoMedilink[basePhoneFinal]) && !isAdmin) {
      aiMessage = aiMessage.trimEnd() + MIIA_CIERRE;
    }

    conversations[phone].push({ role: 'assistant', content: aiMessage, timestamp: Date.now() });
    if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
    saveDB();

    // Anti-ráfaga (Vacuna)
    if (!selfChatLoopCounter[phone] || typeof selfChatLoopCounter[phone] === 'number') {
      selfChatLoopCounter[phone] = { count: 0, lastTime: 0 };
    }
    const nowLoop = Date.now();
    if (nowLoop - selfChatLoopCounter[phone].lastTime < 5000) {
      selfChatLoopCounter[phone].count++;
    } else {
      selfChatLoopCounter[phone].count = 1;
    }
    selfChatLoopCounter[phone].lastTime = nowLoop;
    if (selfChatLoopCounter[phone].count > 3) {
      console.log(`🚨 [VACUNA] BLOQUEO POR RÁFAGA en ${phone}`);
      isSystemPaused = true;
      setTimeout(() => { isSystemPaused = false; selfChatLoopCounter[phone].count = 0; }, 15000);
      return;
    }

    // Simular typing y enviar
    try {
      const chatState = await whatsappClient.getChatById(phone);
      await chatState.sendStateTyping();
      const typingDuration = Math.min(Math.max(aiMessage.length * 65, 2500), 15000);
      await new Promise(r => setTimeout(r, typingDuration));
    } catch (e) { /* ignore typing errors */ }

    // Micro-humanizer: typo 2% + delay variable (1 en 8 mensajes: 20-45s) — respeta preferencia del usuario
    const humanizerOn = await isHumanizerEnabled();
    if (humanizerOn) aiMessage = maybeAddTypo(aiMessage);
    const humanDelay = humanizerOn
      ? (Math.random() < 0.125 ? (20000 + Math.random() * 25000) : (1500 + Math.random() * 1500))
      : (800 + Math.random() * 400);
    await new Promise(r => setTimeout(r, humanDelay));

    lastAiSentBody[phone] = aiMessage.trim();
    console.log(`[MIIA] Enviando mensaje a ${phone} | isReady=${isReady} | isSystemPaused=${isSystemPaused}`);
    await safeSendMessage(phone, aiMessage);

    io.emit('ai_response', {
      to: phone,
      toName: leadNames[phone] || basePhone,
      body: aiMessage,
      timestamp: Date.now(),
      type: contactTypes[phone] || 'lead'
    });

  } catch (err) {
    console.error(`[MIIA] ❌ Error en processMiiaResponse para ${phone}:`, err.message);
    console.error(`[MIIA] ❌ Stack:`, err.stack);
  }
}

async function processAndSendAIResponse(phone, userMessage, isAlreadySaved = false) {
  return await processMiiaResponse(phone, userMessage, isAlreadySaved);
}

// ============================================
// PROCESAMIENTO MULTIMODAL — Audio, Imagen, Video, Documento
// ============================================
const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const MEDIA_MAX_SIZE = 20_000_000; // 20MB en base64
const MEDIA_TIMEOUT_MS = 30000;

function getMediaPrompt(mimetype) {
  if (mimetype.startsWith('audio/'))
    return 'Transcribí textualmente este audio al español. Solo devolvé la transcripción exacta, sin agregar nada más.';
  if (mimetype.startsWith('image/'))
    return 'Describí en detalle qué ves en esta imagen. Contexto: sos asistente de ventas de software médico para clínicas. Sé conciso (máx 3 líneas).';
  if (mimetype.startsWith('video/'))
    return 'Describí brevemente qué muestra este video. Contexto: clínicas y consultorios médicos. Máximo 3 líneas.';
  if (mimetype.includes('pdf') || mimetype.includes('word') || mimetype.includes('document') ||
      mimetype.includes('spreadsheet') || mimetype.includes('presentation'))
    return 'Leé y resumí el contenido de este documento en máximo 5 líneas.';
  return null; // tipo no soportado
}

function getMediaType(mimetype) {
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  return 'document';
}

async function processMediaMessage(message) {
  const media = await Promise.race([
    message.downloadMedia(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timeout')), MEDIA_TIMEOUT_MS))
  ]);

  if (!media || !media.data || !media.mimetype) {
    return { text: null, mediaType: 'unknown' };
  }

  const mediaType = getMediaType(media.mimetype);

  // Límite de tamaño
  if (media.data.length > MEDIA_MAX_SIZE) {
    console.log(`[MEDIA] Archivo demasiado grande: ${(media.data.length / 1_000_000).toFixed(1)}MB (${media.mimetype})`);
    return { text: null, mediaType };
  }

  const prompt = getMediaPrompt(media.mimetype);
  if (!prompt) {
    console.log(`[MEDIA] Tipo no soportado: ${media.mimetype}`);
    return { text: null, mediaType };
  }

  const url = `${GEMINI_FLASH_URL}?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType: media.mimetype, data: media.data } }
      ]
    }]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: MEDIA_TIMEOUT_MS
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[MEDIA] Gemini Flash error ${response.status}: ${err.substring(0, 200)}`);
    return { text: null, mediaType };
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) {
    return { text: null, mediaType };
  }

  console.log(`[MEDIA] ${mediaType} procesado OK (${text.length} chars)`);
  return { text: text.trim(), mediaType };
}

// ============================================
// SISTEMA DE RESPUESTA AUTOMÁTICA (message_create)
// ============================================

async function handleIncomingMessage(message) {
  // REGLA ABSOLUTA: MIIA nunca participa en grupos ni estados. Ni lee, ni responde, ni publica.
  const isBroadcast = message.from.includes('status@broadcast') ||
    (message.to && message.to.includes('status@broadcast')) ||
    message.isStatus;
  const isGroup = message.from.endsWith('@g.us') || (message.to && message.to.endsWith('@g.us'));
  if (isBroadcast || isGroup) return;

  // Eco de linked device: from === to → rebote del propio mensaje, ignorar
  if (message.from && message.to && message.from === message.to) return;

  const fromMe = message.fromMe;
  let body = (message.body || '').trim();
  let mediaContext = null; // { text, mediaType } si se procesó media

  // Si no hay texto pero sí media → intentar procesar (multimodal)
  if (!body && message.hasMedia) {
    const msgType = message.type; // 'ptt', 'audio', 'image', 'video', 'document', 'sticker'
    if (msgType === 'sticker') return; // stickers no procesables

    try {
      mediaContext = await processMediaMessage(message);
    } catch (e) {
      console.error(`[MEDIA] Error procesando ${msgType} de ${message.from}:`, e.message);
    }

    if (mediaContext && mediaContext.text) {
      body = mediaContext.text;
      console.log(`[MEDIA] ${mediaContext.mediaType} de ${message.from} → "${body.substring(0, 80)}..."`);
    } else {
      // FALLBACK: no se pudo interpretar → avisar al lead + alertar a Mariano
      const tipoLabel = { ptt: 'audio', audio: 'audio', image: 'imagen', video: 'video', document: 'documento' }[msgType] || 'archivo';
      const leadPhone = message.from;
      const leadName = leadNames[leadPhone] || leadPhone.split('@')[0];

      // Responder al lead con mensaje de espera
      await safeSendMessage(leadPhone, `Recibí tu ${tipoLabel}, un momento por favor`);

      // ALERTA a Mariano con datos del lead
      await safeSendMessage(`${OWNER_PHONE}@c.us`,
        `⚠️ *MEDIA NO PROCESADA*\n` +
        `Lead: *${leadName}* (${leadPhone.split('@')[0]})\n` +
        `Tipo: ${tipoLabel}\n` +
        `No pude interpretar el ${tipoLabel}. Tomá el control del chat.`
      );
      console.log(`[MEDIA] Fallback: alerta enviada a Mariano por ${tipoLabel} de ${leadPhone}`);
      return;
    }
  }
  if (!body) return;


  // Guardia de bucle por contenido (buffer de IA)
  const targetPhoneId = fromMe ? message.to : message.from;
  const botBuffer = lastSentByBot[targetPhoneId] || [];
  const isBotSessionMessage = sentMessageIds.has(message.id._serialized) || botBuffer.includes(body);
  if (isBotSessionMessage) {
    console.log(`[WA] BUCLE PREVENIDO: ${targetPhoneId}`);
    return;
  }

  // Guardia de auto-bucle (self-chat)
  const myNumber = (whatsappClient && whatsappClient.info && whatsappClient.info.wid)
    ? whatsappClient.info.wid._serialized : `${OWNER_PHONE}@c.us`;
  const isSelfChat = targetPhoneId === myNumber || targetPhoneId.split('@')[0] === myNumber.split('@')[0];
  const now = Date.now();

  if (isSelfChat) {
    // Comando STOP en self-chat
    if (body.toUpperCase() === 'STOP') {
      if (!conversationMetadata[targetPhoneId]) conversationMetadata[targetPhoneId] = {};
      conversationMetadata[targetPhoneId].miiaFamilyPaused = true;
      selfChatLoopCounter[targetPhoneId] = { count: 0, lastTime: 0 };
      return;
    }
    // Velocidad de auto-bucle
    const lastInt = lastInteractionTime[targetPhoneId] || 0;
    if (now - lastInt < 20000) {
      selfChatLoopCounter[targetPhoneId] = (selfChatLoopCounter[targetPhoneId] || 0) + 1;
    } else {
      selfChatLoopCounter[targetPhoneId] = 0;
    }
    if (selfChatLoopCounter[targetPhoneId] >= 3) {
      if (!conversationMetadata[targetPhoneId]) conversationMetadata[targetPhoneId] = {};
      conversationMetadata[targetPhoneId].miiaFamilyPaused = true;
      return;
    }
  }
  lastInteractionTime[targetPhoneId] = now;


  // Determinar teléfono real del destinatario
  let targetPhone = message.from;
  if (fromMe) {
    if (message.to && message.to.includes('@lid')) targetPhone = message.from;
    else targetPhone = message.to;
  }

  // Detección de conversión Lead → Cliente
  // El mensaje de bienvenida de Medilink indica que el lead firmó y se convirtió en cliente
  if (body.includes('Bienvenid') && body.includes('mejorar tu bienestar') && body.includes('pacientes')) {
    if (contactTypes[targetPhone] !== 'cliente') {
      contactTypes[targetPhone] = 'cliente';
      const clientName = leadNames[targetPhone] || targetPhone.split('@')[0];
      cerebroAbsoluto.appendLearning(
        `NUEVO CLIENTE: ${clientName} (${targetPhone.split('@')[0]}) se convirtió en cliente de Medilink el ${new Date().toLocaleDateString('es-ES')}.`,
        'CONVERSION_LEAD_CLIENTE'
      );
      saveDB();
      estadisticas.registrarCliente(targetPhone, clientName, null, null, null);
      if (subscriptionState[targetPhone]) delete subscriptionState[targetPhone];
      console.log(`[MIIA] 🎉 CONVERSIÓN: ${clientName} ahora es cliente (${targetPhone})`);
      // Notificar a Mariano
      safeSendMessage(`${OWNER_PHONE}@c.us`,
        `🎉 *¡Nuevo cliente!* ${clientName} acaba de convertirse en cliente de Medilink.`
      ).catch(() => {});
    }
  }

  // Detección de bot
  const lowerBody = body.toLowerCase();
  if (!fromMe && isPotentialBot(body)) {
    if (flaggedBots[targetPhone]) {
      console.log(`[WA] BOT REINCIDENTE: ${message.from}. Silenciando.`);
      return;
    }
    flaggedBots[targetPhone] = true;
    saveDB();
  } else if (!fromMe && !isPotentialBot(body) && flaggedBots[targetPhone]) {
    delete flaggedBots[targetPhone];
    saveDB();
  }

  // Bucle por eco de IA
  if (fromMe && lastAiSentBody[targetPhone] && lastAiSentBody[targetPhone] === body) {
    delete lastAiSentBody[targetPhone];
    return;
  }

  // Opt-out
  const optOutKeywords = ['quitar', 'baja', 'no molestar', 'no me interesa', 'spam', 'parar', 'unsubscribe'];
  if (!fromMe && optOutKeywords.some(kw => lowerBody.includes(kw))) {
    await handleLeadOptOut(targetPhone);
    return;
  }

  // Procesamiento de mensajes de texto (o media ya transcrito en body)
  if (!body) return;

  try {
    let phone = message.from;
    try {
      const contact = await message.getContact();
      if (contact && contact.id) phone = contact.id._serialized;
    } catch (e) {}

    // Fix @lid para mensajes ENTRANTES: el chat real tiene el número @c.us correcto
    if (!fromMe && phone.includes('@lid')) {
      try {
        const chat = await message.getChat();
        if (chat && chat.id && chat.id._serialized && !chat.id._serialized.includes('@lid')) {
          console.log(`[WA] @lid resuelto: ${phone} → ${chat.id._serialized}`);
          phone = chat.id._serialized;
        }
      } catch (e) { console.log(`[WA] No se pudo resolver @lid: ${e.message}`); }
    }

    let effectiveTarget = phone;
    if (fromMe) {
      if (message.to && message.to.includes('@lid')) {
        // WhatsApp Linked Devices: message.to llega como @lid en lugar de @c.us
        const senderBase = (message.from || phone).split('@')[0];
        const recipientBase = message.to.split(':')[0].split('@')[0];
        if (senderBase === recipientBase) {
          // Self-chat explícito (mismo número)
          effectiveTarget = `${senderBase}@c.us`;
        } else {
          // Verificar si el sender es el dueño de la cuenta conectada (self-chat vía linked device)
          const connectedBase = (whatsappClient && whatsappClient.info && whatsappClient.info.wid)
            ? whatsappClient.info.wid._serialized.split('@')[0] : null;
          if (connectedBase && connectedBase === senderBase) {
            // El dueño se escribe a sí mismo desde otro dispositivo → self-chat
            effectiveTarget = `${senderBase}@c.us`;
          } else {
            effectiveTarget = `${recipientBase}@c.us`;
          }
        }
      } else {
        effectiveTarget = message.to || phone;
      }
    }

    // Blacklist
    if (BLACKLISTED_NUMBERS.includes(effectiveTarget)) return;

    const baseTarget = effectiveTarget.replace(/[^0-9]/g, '');
    let isAllowed = allowedLeads.some(l => l.replace(/[^0-9]/g, '') === baseTarget) || !!familyContacts[baseTarget];
    const existsInCRM = !!conversations[effectiveTarget];

    // Auto-takeover para leads desconocidos con keywords de negocio
    if (!isAllowed && !existsInCRM && !fromMe) {
      const takeoverKeywords = [
        'medico', 'médico', 'doctor', 'clinica', 'clínica', 'consultorio', 'consulta',
        'medilink', 'precio', 'cotizacion', 'cotización', 'software', 'sistema', 'plataforma', 'plan',
        'salud', 'dentista', 'odontologo', 'odontólogo', 'kinesiologo', 'psicologia',
        'psicologo', 'psicólogo', 'ips', 'centro', 'secretaria', 'administrativa',
        'administrador', 'gerente', 'medico general',
        'pediatra', 'pediatria', 'nutricionista', 'fisioterapeuta', 'especialista',
        'especialidad', 'paciente', 'pacientes', 'cita', 'citas', 'agenda',
        'medica', 'medicos', 'terapeuta', 'cirujano', 'ginecologo', 'ginecologa',
        'dermatologo', 'cardiologo', 'neurologo', 'ortopedista', 'traumatologo'
      ];
      const triggered = takeoverKeywords.find(kw => lowerBody.includes(kw));
      if (triggered) {
        try {
          const ct = await message.getContact();
          allowedLeads.push(effectiveTarget);
          isAllowed = true;
          detectContactType(ct.name || ct.pushname || 'Lead', effectiveTarget);
          saveDB();
          console.log(`[WA] ✅ Auto-takeover: ${effectiveTarget} agregado como lead por keyword "${triggered}"`);
        } catch (e) {
          // Si getContact falla igual registramos el lead
          allowedLeads.push(effectiveTarget);
          isAllowed = true;
          saveDB();
          console.log(`[WA] ✅ Auto-takeover (sin contacto): ${effectiveTarget} keyword "${triggered}"`);
        }
      }
    }

    if (!isAllowed && !existsInCRM && !fromMe) {
      console.log(`[WA] IA BLOQUEADA para ${effectiveTarget}. Sin keywords de negocio ni historial.`);
      return;
    }

    // Self-chat: solo responder si MIIA es mencionada
    // Fallback a OWNER_PHONE si whatsappClient.info aún no está disponible
    const myNumberFull = (whatsappClient && whatsappClient.info && whatsappClient.info.wid)
      ? whatsappClient.info.wid._serialized : `${OWNER_PHONE}@c.us`;
    // senderNumber: quién envió este mensaje (cuando fromMe=true, es el dueño)
    const senderNumber = (message.from || '').split('@')[0];
    const isSelfChatMsg = fromMe && (
      effectiveTarget === myNumberFull ||
      effectiveTarget.split('@')[0] === myNumberFull.split('@')[0] ||
      effectiveTarget.split('@')[0] === OWNER_PHONE ||
      effectiveTarget.split('@')[0] === senderNumber   // remitente == destinatario → self-chat
    );
    const bodyLower = (body || '').toLowerCase();

    // ── INVOCACIÓN / CIERRE DE SESIÓN MIIA ──────────────────────────────────
    // MIIA se activa al ser mencionada y permanece activa hasta "chau miia"
    if (!conversationMetadata[effectiveTarget]) conversationMetadata[effectiveTarget] = {};
    const isMIIASessionActive = !!conversationMetadata[effectiveTarget].miiaSessionActive;

    const isChauMIIA = isSelfChatMsg && (
      bodyLower.includes('chau miia') || bodyLower.includes('chau, miia') ||
      bodyLower.includes('bye miia')  || bodyLower.includes('adios miia') ||
      bodyLower.includes('adiós miia') || bodyLower.includes('hasta luego miia')
    );
    if (isChauMIIA) {
      conversationMetadata[effectiveTarget].miiaSessionActive = false;
      saveDB();
      console.log(`[MIIA] Sesión cerrada para ${effectiveTarget}`);
      await safeSendMessage(effectiveTarget, '¡Hasta luego! 👋 Cuando me necesites, ya sabes dónde encontrarme.');
      return;
    }

    const isMIIAMentioned = bodyLower.includes('miia') || bodyLower.includes('hola') || bodyLower === 'hi' ||
      bodyLower.includes('medic') || bodyLower.includes('medilink') || bodyLower.includes('precio');

    // Si es self-chat y se menciona MIIA por primera vez → abrir sesión
    if (isSelfChatMsg && isMIIAMentioned && !isMIIASessionActive) {
      conversationMetadata[effectiveTarget].miiaSessionActive = true;
      saveDB();
      console.log(`[MIIA] ✅ Sesión abierta para ${effectiveTarget}`);
    }

    // MIIA responde si: se mencionó explícitamente OR la sesión ya está activa
    const isMIIAActive = isMIIAMentioned || isMIIASessionActive;

    const isFamily = !!familyContacts[effectiveTarget.split('@')[0]];
    const isEquipo = !!equipoMedilink[effectiveTarget.split('@')[0]];
    const isSelfChatMIIA = isSelfChatMsg && (isMIIAActive || isFamily);

    // Siempre guardar mensajes entrantes de familia
    if (isFamily && !fromMe) {
      if (!conversations[effectiveTarget]) conversations[effectiveTarget] = [];
      const exists = conversations[effectiveTarget].some(m => m.content === body && Math.abs(m.timestamp - Date.now()) < 5000);
      if (!exists) {
        conversations[effectiveTarget].push({ role: 'user', content: body, timestamp: Date.now() });
        saveDB();
      }
    }

    if (isFamily && automationSettings.miiaFamilyPaused && !isMIIAActive) return;
    if (isFamily && isMIIAActive && conversationMetadata[effectiveTarget].miiaFamilyPaused) {
      conversationMetadata[effectiveTarget].miiaFamilyPaused = false;
    }

    // Si es self-chat y MIIA NO está activa ni mencionada → guardar como nota y salir
    if (isSelfChatMsg && !isMIIAActive && !isFamily) {
      if (!conversations[effectiveTarget]) conversations[effectiveTarget] = [];
      conversations[effectiveTarget].push({ role: 'user', content: body, timestamp: Date.now() });
      saveDB();
      return;
    }

    if (!conversations[effectiveTarget]) conversations[effectiveTarget] = [];
    const history = conversations[effectiveTarget];
    const cleanBody = body; // body ya contiene transcripción si fue media

    const botBufferTarget = lastSentByBot[effectiveTarget] || [];
    if (botBufferTarget.includes(cleanBody)) {
      console.log(`[WA] BUCLE PREVENIDO para ${effectiveTarget}.`);
      return;
    }
    if (lastAiSentBody[effectiveTarget] && lastAiSentBody[effectiveTarget] === cleanBody) return;

    if (!fromMe || isSelfChatMIIA) {
      // Guardar mensaje ANTES del guard isProcessing para capturar multi-mensajes en ráfaga
      // Si fue media, guardar con contexto para que la IA entienda qué recibió
      const mediaLabel = { audio: '🎤 Audio', image: '📷 Imagen', video: '🎬 Video', document: '📄 Documento' };
      const userContent = mediaContext
        ? `[El lead envió un ${mediaLabel[mediaContext.mediaType] || 'archivo'}. Transcripción/descripción: "${body}"]`
        : body;
      history.push({ role: 'user', content: userContent, timestamp: Date.now() });
      if (history.length > 40) conversations[effectiveTarget] = history.slice(-40);

      // Extracción de nombre en background
      if (!leadNames[effectiveTarget] || leadNames[effectiveTarget] === 'Buscando...') {
        leadNames[effectiveTarget] = 'Buscando...';
        const extractNamePrompt = `Revisa este chat y extrae ÚNICAMENTE el nombre del cliente. Responde SOLO el primer nombre (ej: "Carlos"). Si no menciona su nombre, responde EXCLUSIVAMENTE "N/A".\n\nChat:\n${conversations[effectiveTarget].map(m => m.content).join('\n')}`;
        generateAIContent(extractNamePrompt).then(detectedName => {
          const cleanName = detectedName.replace(/[^\w\sáéíóúÁÉÍÓÚñÑ]/g, '').trim();
          if (cleanName !== 'NA' && cleanName !== 'N/A' && cleanName.length > 2 && cleanName.length < 20) {
            leadNames[effectiveTarget] = cleanName;
          } else {
            delete leadNames[effectiveTarget];
          }
          saveDB();
        }).catch(() => { delete leadNames[effectiveTarget]; });
      }
      saveDB();

      // Si ya hay una respuesta programada, el mensaje quedó guardado — no programar otra
      if (isProcessing[effectiveTarget]) {
        console.log(`[WA] Mensaje acumulado para ${effectiveTarget} (respuesta ya programada).`);
        return;
      }
    } else {
      // Mensaje saliente manual de Mariano
      const lastMsg = history.length > 0 ? history[history.length - 1] : null;
      if (!lastMsg || lastMsg.content !== body) {
        if (!conversationMetadata[effectiveTarget]) conversationMetadata[effectiveTarget] = {};
        conversationMetadata[effectiveTarget].humanInterventionTime = Date.now();
        const baseNum = effectiveTarget.split('@')[0];
        if (familyContacts[baseNum]) {
          conversationMetadata[effectiveTarget].miiaFamilyPaused = true;
          console.log(`[FAMILIA] MIIA pausada para ${baseNum} por intervención manual.`);
        }
        history.push({ role: 'assistant', content: body, timestamp: Date.now() });
        if (history.length > 40) conversations[effectiveTarget] = history.slice(-40);
        saveDB();
      }
      if (!isSelfChatMIIA) return;
    }


    const shouldRespond = ((isAllowed || existsInCRM) && automationSettings.autoResponse) || isSelfChatMIIA || isEquipo;
    if (!shouldRespond) {
      console.log(`[WA] Lead ${effectiveTarget}: autoResponse apagado o no en whitelist. isSelfChatMIIA=${isSelfChatMIIA}`);
      return;
    }

    // BLINDAJE: No responder fuera del horario configurado (leads solamente, familia/self-chat siempre pasan)
    if (!isSelfChatMIIA && !isFamily && !isEquipo && !isWithinSchedule()) {
      console.log(`[WA] Fuera de horario para ${effectiveTarget}. Mensaje guardado, respuesta diferida.`);
      return;
    }

    // ── COMANDO RESET (solo números de testing) ──────────────────────────
    if (!fromMe && body.trim().toUpperCase() === 'RESET') {
      const baseNumReset = effectiveTarget.split('@')[0];
      if (RESET_ALLOWED_PHONES.includes(baseNumReset)) {
        conversations[effectiveTarget] = [];
        saveDB();
        await safeSendMessage(effectiveTarget, '✅ Contexto de conversación limpiado. Próxima respuesta parte desde cero.');
        console.log(`[RESET] Contexto limpiado para ${effectiveTarget}`);
        return;
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // Silencio por intervención humana — 91-97 min aleatorio desde el último mensaje de Mariano
    // Retoma control si: pasaron 91-97 min O el lead escribe en un día diferente desde las 9:30 AM Bogotá
    if (conversationMetadata[effectiveTarget]?.humanInterventionTime && !isSelfChatMIIA) {
      const interventionTime = conversationMetadata[effectiveTarget].humanInterventionTime;
      const elapsed = Date.now() - interventionTime;
      const silence = conversationMetadata[effectiveTarget].customSilencePeriod ||
        (() => {
          const s = (Math.floor(Math.random() * 7) + 91) * 60 * 1000; // 91-97 min aleatorio
          conversationMetadata[effectiveTarget].customSilencePeriod = s;
          return s;
        })();

      // Verificar si es un día diferente en Bogotá y ya pasaron las 9:30 AM
      const toDateBogota = ts => new Date(ts).toLocaleDateString('es-ES', { timeZone: 'America/Bogota' });
      const nowBogota = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const isNewDay = toDateBogota(interventionTime) !== toDateBogota(Date.now());
      const isAfter930 = nowBogota.getHours() > 9 || (nowBogota.getHours() === 9 && nowBogota.getMinutes() >= 30);
      const newDayReady = isNewDay && isAfter930;

      if (!newDayReady && elapsed < silence) {
        console.log(`[WA] Silencio humano para ${effectiveTarget}: ${Math.round(elapsed / 60000)} min de ${Math.round(silence / 60000)}. Esperando.`);
        return;
      }
      const reason = newDayReady ? 'nuevo día (≥9:30 AM)' : `${Math.round(elapsed / 60000)} min transcurridos`;
      console.log(`[WA] MIIA retoma control de ${effectiveTarget} (${reason}).`);
      delete conversationMetadata[effectiveTarget].humanInterventionTime;
      delete conversationMetadata[effectiveTarget].customSilencePeriod;
      saveDB();
    }

    // ── FLUJO DE COMPRA ──────────────────────────────────────────────────
    // Estado 'asked': MIIA ya preguntó si quiere el link → detectar respuesta afirmativa
    if (!fromMe && subscriptionState[effectiveTarget]?.estado === 'asked') {
      const lc = lowerBody.trim();
      if (lc.includes('sí') || lc.includes('si') || lc === 'dale' || lc === 'ok' ||
          lc.includes('claro') || lc.includes('quiero') || lc.includes('perfecto')) {
        subscriptionState[effectiveTarget].estado = 'collecting';
        await safeSendMessage(effectiveTarget, MSG_SUSCRIPCION);
        console.log(`[COMPRA] Formulario enviado a ${effectiveTarget}.`);
        return;
      }
      // Si dice que no, resetear estado
      if (lc.includes('no ') || lc === 'no' || lc.includes('todavía') || lc.includes('después')) {
        subscriptionState[effectiveTarget] = { estado: 'none', data: {} };
      }
    }

    // Estado 'collecting': el lead respondió con sus 4 datos → notificar a Mariano
    if (!fromMe && subscriptionState[effectiveTarget]?.estado === 'collecting') {
      const leadName = leadNames[effectiveTarget] || effectiveTarget.split('@')[0];
      subscriptionState[effectiveTarget].estado = 'notified';
      subscriptionState[effectiveTarget].data = { phone: effectiveTarget, nombre: leadName, respuesta: body };
      estadisticas.registrarInteresado({ phone: effectiveTarget, nombre: leadName, respuesta: body });
      if (conversationMetadata[effectiveTarget]) conversationMetadata[effectiveTarget].followUpState = 'converted';
      await safeSendMessage(`${OWNER_PHONE}@c.us`,
        `🔔 *${leadName}* está listo para comprar.\n\nSus datos:\n${body}\n\nCreá el link de pago y enviáselo.`);
      await safeSendMessage(effectiveTarget,
        `¡Perfecto! Recibí todo. Voy a crear tu link de acceso y en cuanto esté listo te lo mando. ¡Gracias por confiar en Medilink! 🙌`);
      console.log(`[COMPRA] Mariano notificado. Lead ${effectiveTarget} en espera de link.`);
      return;
    }
    // ────────────────────────────────────────────────────────────────────

    // ── SEGUIMIENTO AUTOMÁTICO: detectar intención de no-interés o reagendar ──
    if (!fromMe && conversationMetadata[effectiveTarget]?.followUpState === 'pending') {
      const noInterestKeywords = ['no me interesa', 'no por ahora', 'no gracias', 'no, gracias',
        'no estoy interesado', 'no estoy interesada', 'no necesito', 'no quiero'];
      const needTimeKeywords = ['necesito tiempo', 'dejame pensar', 'déjame pensar',
        'la próxima semana', 'el próximo mes', 'por ahora no', 'ahora no puedo',
        'lo pensaré', 'lo voy a pensar', 'dame unos días', 'dame tiempo',
        'más adelante', 'después te aviso', 'despues te aviso', 'todavía no',
        'estoy evaluando', 'lo estoy pensando', 'aún no', 'aun no'];

      if (noInterestKeywords.some(kw => lowerBody.includes(kw))) {
        // Rechazo claro → detener follow-ups definitivamente
        conversationMetadata[effectiveTarget].followUpState = 'stopped';
        conversationMetadata[effectiveTarget].followUpAttempts = 0;
        saveDB();
      } else if (needTimeKeywords.some(kw => lowerBody.includes(kw))) {
        // Pide tiempo → reagendar follow-up a 6 días hábiles
        const businessDaysMs = calcBusinessDaysMs(6, effectiveTarget);
        conversationMetadata[effectiveTarget].lastCotizacionSent = Date.now() + businessDaysMs - (3 * 24 * 60 * 60 * 1000);
        // ^ Se resta los 3 días del timer normal para que el total sea ~6 días hábiles
        conversationMetadata[effectiveTarget].followUpState = 'pending';
        // No resetear followUpAttempts — cuenta como parte del ciclo
        console.log(`[FOLLOW-UP] Lead ${effectiveTarget} pidió tiempo. Reagendado a ~6 días hábiles.`);
        saveDB();
      } else {
        // Respondió algo positivo/neutral → reagendar a 6 días hábiles, resetear contador
        const businessDaysMs = calcBusinessDaysMs(6, effectiveTarget);
        conversationMetadata[effectiveTarget].lastCotizacionSent = Date.now() + businessDaysMs - (3 * 24 * 60 * 60 * 1000);
        conversationMetadata[effectiveTarget].followUpState = 'pending';
        conversationMetadata[effectiveTarget].followUpAttempts = 0; // respondió → reiniciar ciclo
        console.log(`[FOLLOW-UP] Lead ${effectiveTarget} respondió. Reagendado a ~6 días hábiles (ciclo reiniciado).`);
        saveDB();
      }
    }
    // ────────────────────────────────────────────────────────────────────

    if (isProcessing[effectiveTarget]) {
      // Hay mensajes nuevos — re-activar respuesta cuando termine la actual
      pendingResponses[effectiveTarget] = true;
      return;
    }
    isProcessing[effectiveTarget] = true;

    // Emitir mensaje entrante al frontend
    try {
      const ct = await message.getContact();
      io.emit('new_message', {
        from: effectiveTarget,
        fromName: leadNames[effectiveTarget] || ct.name || ct.pushname || 'Desconocido',
        body: body,
        mediaType: mediaContext ? mediaContext.mediaType : null,
        timestamp: Date.now(),
        type: contactTypes[effectiveTarget] || 'lead'
      });
    } catch (e) {}

    // Buffer de 0.5s para agrupar mensajes en rafaga rapida
    setTimeout(async () => {
      try {
        await processAndSendAIResponse(effectiveTarget, null, true);
      } finally {
        delete isProcessing[effectiveTarget];
        // Si llegaron mensajes nuevos mientras procesábamos, re-activar respuesta
        if (pendingResponses[effectiveTarget]) {
          delete pendingResponses[effectiveTarget];
          setTimeout(async () => {
            isProcessing[effectiveTarget] = true;
            try {
              await processAndSendAIResponse(effectiveTarget, null, true);
            } finally {
              delete isProcessing[effectiveTarget];
            }
          }, 500);
        }
      }
    }, 500);

  } catch (err) {
    console.error(`[WA] Error procesando mensaje de ${message.from}:`, err.message);
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
  
  // RemoteAuth: persists WhatsApp session in Firestore so it survives Railway deploys
  // clientId matches the tenant key so it reuses the already-saved session
  const sessionStore = new FirestoreSessionStore();
  console.log('[WA] Using RemoteAuth with Firestore session store');

  whatsappClient = new Client({
    authStrategy: new RemoteAuth({
      store: sessionStore,
      clientId: `tenant-${OWNER_UID}`,
      backupSyncIntervalMs: 300000
    }),
    userAgent: 'Mozilla/5.0 (compatible; MIIA-APP/1.0; +https://lobsterscrm.com)',
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

  whatsappClient.on('remote_session_saved', () => {
    console.log('[WA] ✅ Sesión guardada en Firestore (RemoteAuth backup)');
  });

  whatsappClient.on('ready', () => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║   ✅ WHATSAPP LISTO                   ║');
    console.log('║   🤖 MIIA AUTO-RESPONSE ACTIVADA      ║');
    console.log('╚════════════════════════════════════════╝\n');
    isReady = true;
    io.emit('whatsapp_ready', { status: 'connected' });

    // Guardar número de WhatsApp conectado en Firestore (para consent records)
    try {
      const waNumber = whatsappClient.info?.wid?.user;
      if (waNumber && OWNER_UID && admin.apps.length > 0) {
        admin.firestore().collection('users').doc(OWNER_UID).update({
          whatsapp_number: waNumber,
          whatsapp_connected_at: new Date()
        }).catch(e => console.log('[WA] No se pudo guardar número en Firestore:', e.message));
      }
    } catch (e) { console.log('[WA] Error guardando número WA:', e.message); }

    // Inicializar / reconectar CEREBRO ABSOLUTO
    cerebroAbsoluto.init({
      whatsappClient,
      generateAIContent,
      onTrainingUpdate: () => { saveDB(); },
      dataDir: DATA_DIR,
      initialTrainingData: cerebroAbsoluto.getTrainingData()
    });

    // Inicializar SCRAPER REGULATORIO
    webScraper.init({
      generateAIContent,
      appendLearning: cerebroAbsoluto.appendLearning
    });
  });

  // ⭐⭐⭐ EVENTO PRINCIPAL - LÓGICA COMPLETA MIIA ⭐⭐⭐
  whatsappClient.on('message_create', (msg) => {
    handleIncomingMessage(msg);
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
  whatsappClient.initialize().catch(async err => {
    const errMsg = err?.message || String(err) || 'unknown error';
    const errStr = JSON.stringify(err, Object.getOwnPropertyNames(err));
    console.error('[WA] ❌ Error en initialize():', errMsg);
    console.error('[WA] ❌ Error detail:', errStr);
    // Si la sesión es corrupta, limpiarla para que el próximo boot pida QR
    if (errMsg === 'undefined' || errMsg === 'unknown error' || errMsg.includes('ENOENT') || errMsg.includes('corrupt') || errMsg.includes('auth timeout') || errMsg.includes('timeout') || errMsg.includes('session') || errMsg.includes('401') || errMsg.includes('403')) {
      try {
        console.log('[WA] 🗑️ Limpiando sesión potencialmente corrupta (intento #' + (initRetryCount + 1) + '/3)...');
        const store = new FirestoreSessionStore();
        await store.delete({ session: `RemoteAuth-tenant-${OWNER_UID}` });
        whatsappClient = null;
        isReady = false;
        qrCode = null;

        // Limitar reintentos a máximo 3 veces para evitar loop infinito
        initRetryCount++;
        if (initRetryCount < 3) {
          const delayMs = 5000 * initRetryCount; // 5s, 10s, luego stop
          console.log(`[WA] ✅ Sesión limpiada — reintentar en ${delayMs}ms (intento #${initRetryCount}/3)`);
          setTimeout(() => {
            console.log('[WA] 🔄 Reintentar inicialización con nuevo QR...');
            initWhatsApp();
          }, delayMs);
        } else {
          console.log('[WA] ⛔ Máximo número de reintentos alcanzado. Esperando acción del usuario.');
        }
      } catch (e) {
        console.error('[WA] ❌ Error limpiando sesión:', e.message);
        whatsappClient = null;
        isReady = false;
      }
    } else {
      whatsappClient = null;
      isReady = false;
    }
  });
  console.log('[WA] 🔄 Initialize() llamado, esperando conexión...\n');
}

// ============================================
// SOCKET.IO EVENTS
// ============================================

io.on('connection', (socket) => {
  console.log('👤 Cliente conectado via Socket.io');
  
  // if (!whatsappClient) initWhatsApp();

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

app.get('/api/is-admin', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.json({ isAdmin: false });
    const idToken = authHeader.substring(7);
    const decoded = await admin.auth().verifyIdToken(idToken);
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    if (adminEmails.includes((decoded.email || '').toLowerCase())) return res.json({ isAdmin: true });
    const doc = await admin.firestore().collection('users').doc(decoded.uid).get();
    if (doc.exists && doc.data().role === 'admin') return res.json({ isAdmin: true });
    const snap = await admin.firestore().collection('users').where('email','==',decoded.email).limit(1).get();
    if (!snap.empty && snap.docs[0].data().role === 'admin') return res.json({ isAdmin: true });
    res.json({ isAdmin: false });
  } catch (_) { res.json({ isAdmin: false }); }
});

// ============================================
// MIDDLEWARE: requireRole — verifica rol del usuario en Firestore
// ============================================
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      const idToken = authHeader.substring(7);
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.user = decoded;

      // Admins always pass
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
      if (adminEmails.includes((decoded.email || '').toLowerCase())) {
        req.userRole = 'owner';
        return next();
      }

      // Check role in Firestore
      const doc = await admin.firestore().collection('users').doc(decoded.uid).get();
      const role = doc.exists ? (doc.data().role || 'owner') : 'owner'; // default owner for legacy users
      req.userRole = role;

      if (allowedRoles.includes(role)) return next();
      return res.status(403).json({ error: 'Acceso denegado', requiredRole: allowedRoles, yourRole: role });
    } catch (e) {
      return res.status(401).json({ error: 'Token inválido', details: e.message });
    }
  };
}

// GET /api/user/role — devuelve rol del usuario autenticado
app.get('/api/user/role', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    const idToken = authHeader.substring(7);
    const decoded = await admin.auth().verifyIdToken(idToken);
    const doc = await admin.firestore().collection('users').doc(decoded.uid).get();
    const data = doc.exists ? doc.data() : {};
    res.json({
      uid: decoded.uid,
      email: decoded.email,
      role: data.role || 'owner',
      assignedLeads: data.assignedLeads || [],
      createdBy: data.createdBy || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tenant/:uid/agent-conversations — conversaciones asignadas al agente
app.get('/api/tenant/:uid/agent-conversations', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const agentUid = req.user.uid;
    const ownerUid = req.params.uid;

    // Owner sees all
    if (req.userRole === 'owner') {
      const convs = conversations || {};
      return res.json({ conversations: convs, leadNames, contactTypes });
    }

    // Agent: verify they belong to this owner
    const agentDoc = await admin.firestore().collection('users').doc(agentUid).get();
    if (!agentDoc.exists || agentDoc.data().createdBy !== ownerUid) {
      return res.status(403).json({ error: 'No pertenecés a este tenant' });
    }

    const assignedLeads = agentDoc.data().assignedLeads || [];
    const filtered = {};
    for (const phone of assignedLeads) {
      if (conversations[phone]) filtered[phone] = conversations[phone];
      // Also try with @c.us suffix
      const phoneWithSuffix = phone.includes('@') ? phone : `${phone}@c.us`;
      if (conversations[phoneWithSuffix]) filtered[phoneWithSuffix] = conversations[phoneWithSuffix];
    }

    const filteredNames = {};
    const filteredTypes = {};
    for (const phone of Object.keys(filtered)) {
      if (leadNames[phone]) filteredNames[phone] = leadNames[phone];
      if (contactTypes[phone]) filteredTypes[phone] = contactTypes[phone];
    }

    res.json({ conversations: filtered, leadNames: filteredNames, contactTypes: filteredTypes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/assign-leads — asignar leads a un agente
app.put('/api/tenant/:uid/assign-leads', requireRole('owner'), async (req, res) => {
  try {
    const { agentUid, leads } = req.body;
    if (!agentUid || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'agentUid y leads[] son requeridos' });
    }
    await admin.firestore().collection('users').doc(agentUid).update({
      assignedLeads: leads
    });
    res.json({ ok: true, assigned: leads.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/firebase-status', (_req, res) => {
  try {
    admin.app();
    res.json({ firebase: 'ok', initialized: true });
  } catch (_) {
    res.json({
      firebase: 'error',
      initialized: false,
      hint: 'Verificar FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY en Railway',
      hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
      hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
      hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
      privateKeyStart: (process.env.FIREBASE_PRIVATE_KEY || '').substring(0, 30)
    });
  }
});

// ─── /api/status — WhatsApp connection status (used by dashboard.html) ────────
// ── Consentimiento ADN — firma electrónica con IP del servidor ───────────────
app.post('/api/consent/adn', express.json(), async (req, res) => {
  try {
    const { uid, email, accepted, browser_ip, user_agent, screen, language, consent_text } = req.body;
    if (!uid || !accepted) return res.status(400).json({ error: 'uid y accepted requeridos' });

    // Leer número de WhatsApp del tenant desde Firestore
    let waNumber = 'no conectado';
    try {
      const userDoc = await admin.firestore().collection('users').doc(uid).get();
      if (userDoc.exists && userDoc.data().whatsapp_number) waNumber = userDoc.data().whatsapp_number;
    } catch (_) {}

    // IP verificada por el servidor (Railway usa X-Forwarded-For)
    const serverIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'desconocida';

    const record = {
      uid, email: email || '',
      consent_type: 'adn_mining',
      accepted: true,
      timestamp: new Date().toISOString(),
      whatsapp_number: waNumber,
      ip_browser: browser_ip || 'desconocida',
      ip_server: serverIp,
      user_agent: user_agent || '',
      screen: screen || '',
      language: language || '',
      consent_text: consent_text || 'Autorizo la Extracción de ADN Comercial'
    };

    await admin.firestore().collection('consent_records').doc(uid + '_adn').set(record);
    await admin.firestore().collection('users').doc(uid).update({
      consent_adn: true,
      consent_adn_date: new Date()
    });

    console.log(`[CONSENT] Firma ADN registrada — uid: ${uid}, WA: ${waNumber}, IP: ${serverIp}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[CONSENT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  // Check tenant first if uid param provided
  const uid = req.query.uid;
  if (uid) {
    const status = tenantManager.getTenantStatus(uid);
    return res.json({ connected: status.isReady, hasQR: status.hasQR, tenant: uid });
  }
  // Fall back to single-tenant (original Mariano session)
  res.json({ connected: isReady, hasQR: !!qrCode });
});

// ─── /api/conversations — contacts.html-compatible format ─────────────────────
app.get('/api/conversations', async (req, res) => {
  const uid = req.query.uid;

  // Multi-tenant: if uid provided, return that tenant's conversations
  if (uid) {
    try {
      const convs = await tenantManager.getTenantConversations(uid);
      return res.json(convs);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Single-tenant fallback (original): format for contacts.html
  const result = Object.entries(conversations).map(([phone, msgs]) => {
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      phoneNumber: phone.split('@')[0],
      name: leadNames[phone] || phone.split('@')[0],
      lastMessage: lastMsg?.content || '',
      timestamp: lastMsg?.timestamp || null,
      unreadCount: 0
    };
  });
  res.json(result);
});

// ─── MULTI-TENANT ENDPOINTS ────────────────────────────────────────────────────

// POST /api/tenant/init — Start WhatsApp for a SaaS client
// Body: { uid, geminiApiKey? }
app.post('/api/tenant/init', express.json(), async (req, res) => {
  const { uid, geminiApiKey } = req.body;
  console.log(`[INIT] 🚀 POST /api/tenant/init - UID: ${uid}, GeminiKey: ${geminiApiKey ? 'YES' : 'NO (empty)'}`);

  if (!uid) {
    console.log('[INIT] ❌ ERROR: UID required');
    return res.status(400).json({ error: 'uid requerido' });
  }

  // geminiApiKey is optional now - users can test WhatsApp without it
  const apiKeyToUse = geminiApiKey || '';

  // Owner always uses initWhatsApp() — never create a tenant Chromium for owner (OOM)
  if (uid === OWNER_UID) {
    if (!whatsappClient) {
      initRetryCount = 0; // Reset retry counter on user manual init
      initWhatsApp();
    }
    return res.json({ success: true, uid, isReady: !!isReady, hasQR: !!qrCode, reusing: true });
  }

  const tenant = tenantManager.initTenant(uid, apiKeyToUse, io);
  console.log(`[INIT] ✅ Tenant initialized. Stored in map. Checking Medilink status...`);

  // Verificar si el usuario es equipo Medilink (@healthatom.com) → activar cerebro Medilink
  try {
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (userDoc.exists && userDoc.data().role === 'owner_member') {
      tenant.isOwnerMember = true;
      console.log(`[TM:${uid}] 🧠 Cerebro Medilink activado (owner_member)`);
    }
  } catch (e) { console.log(`[TM:${uid}] No se pudo verificar rol:`, e.message); }

  console.log(`[INIT] 📊 Responding - isReady: ${tenant.isReady}, hasQR: ${!!tenant.qrCode}`);
  res.json({
    success: true,
    uid,
    isReady: tenant.isReady,
    hasQR: !!tenant.qrCode
  });
});

// GET /api/tenant/:uid/status — Get tenant WhatsApp status
app.get('/api/tenant/:uid/status', (req, res) => {
  const status = tenantManager.getTenantStatus(req.params.uid);
  res.json(status);
});

// GET /api/tenant/:uid/qr — Get tenant QR code (if pending scan)
app.get('/api/tenant/:uid/qr', (req, res) => {
  const uid = req.params.uid;
  const status = tenantManager.getTenantStatus(uid);
  console.log(`[QR] GET /api/tenant/${uid}/qr - exists: ${status.exists}, hasQR: ${status.hasQR}, isReady: ${status.isReady}`);

  if (!status.exists) {
    if (uid === OWNER_UID && whatsappClient) {
      console.log(`[QR] ♻️ Owner UID — returning owner client status`);
      return res.json({ qrCode: qrCode || null, isReady: isReady, isAuthenticated: isReady, phase: isReady ? 'ready' : (qrCode ? 'qr_ready' : 'initializing') });
    }
    console.log(`[QR] ❌ Tenant NOT found in map for UID: ${uid}`);
    return res.status(404).json({ error: 'Tenant no encontrado. Llama a /api/tenant/init primero.' });
  }

  if (!status.hasQR && !status.isReady) {
    const phase = status.isAuthenticated ? 'authenticated_loading' : 'initializing';
    console.log(`[QR] ⏳ Tenant found but no QR (phase: ${phase})`);
    return res.json({ qrCode: null, isReady: false, isAuthenticated: status.isAuthenticated, phase });
  }

  if (status.isReady) {
    console.log(`[QR] ✅ Tenant is READY`);
    return res.json({ qrCode: null, isReady: true, isAuthenticated: true, phase: 'ready' });
  }

  console.log(`[QR] ✅ QR found! Type: ${typeof status.qrCode}, Length: ${status.qrCode ? status.qrCode.length : 'N/A'}, Starts: ${status.qrCode ? status.qrCode.substring(0, 50) : 'null'}`);
  res.json({ qrCode: status.qrCode, isReady: status.isReady, isAuthenticated: status.isAuthenticated, phase: 'qr_ready' });
});

// POST /api/tenant/:uid/logout — Disconnect tenant WhatsApp
app.post('/api/tenant/:uid/logout', async (req, res) => {
  const result = await tenantManager.destroyTenant(req.params.uid);
  res.json(result);
});

// GET /api/tenant/:uid/conversations — Get tenant conversations (contacts.html)
app.get('/api/tenant/:uid/conversations', async (req, res) => {
  try {
    const convs = await tenantManager.getTenantConversations(req.params.uid);
    res.json(convs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tenant/:uid/train — Add training data for a tenant
app.post('/api/tenant/:uid/train', express.json(), (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });
  const ok = tenantManager.appendTenantTraining(req.params.uid, message);
  if (!ok) return res.status(404).json({ error: 'Tenant no encontrado' });
  res.json({ success: true });
});

// GET /api/tenants — List all active tenants (admin only)
app.get('/api/tenants', verifyAdminToken, (req, res) => {
  res.json(tenantManager.getAllTenants());
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
    recentActivity: Object.keys(conversations).length
  };
  
  res.json(stats);
});

// ============================================
// CEREBRO ABSOLUTO — CRON NOCTURNO (cada 60s)
// ============================================

// ============================================
// DESPERTAR MATUTINO — responde mensajes nocturnos pendientes
// ============================================

async function processMorningWakeup() {
  try {
    if (!whatsappClient || !isReady) return;
    if (nightPendingLeads.size === 0) return;

    const bogotaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const h         = bogotaNow.getHours();
    const min       = bogotaNow.getMinutes();
    const todayStr  = bogotaNow.toLocaleDateString('es-ES');

    // Ventana: 6:00–6:30 AM Bogotá, una vez por día
    if (h !== 6 || min > 30 || morningWakeupDone === todayStr) return;

    morningWakeupDone = todayStr;
    const pendingCopy = [...nightPendingLeads];
    nightPendingLeads.clear();

    console.log(`[WAKE UP] Procesando ${pendingCopy.length} leads pendientes nocturnos...`);

    for (const pendingPhone of pendingCopy) {
      // Delay aleatorio entre leads: 30s–3min para parecer humano
      const delay = Math.floor(Math.random() * 150000) + 30000;
      await new Promise(r => setTimeout(r, delay));
      try {
        const lastMsg = (conversations[pendingPhone] || []).slice(-1)[0];
        if (lastMsg && lastMsg.role === 'user') {
          await processMiiaResponse(pendingPhone, lastMsg.content, true);
          console.log(`[WAKE UP] Respondido a ${pendingPhone}`);
        }
      } catch (e) {
        console.error(`[WAKE UP] Error procesando ${pendingPhone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[WAKE UP] Error general:', e.message);
  }
}

// ============================================
// BRIEFING MATUTINO — resumen a Mariano a las 8:30 AM
// ============================================

// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UP AUTOMÁTICO — 3 días sin respuesta del lead tras recibir cotización
// ─────────────────────────────────────────────────────────────────────────────

// Festivos fijos por país (MM-DD). Se detecta país por prefijo telefónico.
const HOLIDAYS_BY_COUNTRY = {
  CO: [ // Colombia
    '01-01','01-06','03-24','03-28','03-29','05-01','06-02','06-23','06-30',
    '07-01','07-20','08-07','08-18','10-13','11-03','11-17','12-08','12-25'
  ],
  AR: [ // Argentina
    '01-01','02-12','02-13','03-24','03-28','03-29','04-02','05-01','05-25',
    '06-17','06-20','07-09','08-17','10-12','11-20','12-08','12-25'
  ],
  MX: [ // México
    '01-01','02-03','03-17','03-28','03-29','05-01','05-05','09-16',
    '10-12','11-02','11-17','12-25'
  ],
  CL: [ // Chile
    '01-01','03-28','03-29','05-01','05-21','06-20','06-29','07-16',
    '08-15','09-18','09-19','10-12','10-31','11-01','12-08','12-25'
  ],
  PE: [ // Perú
    '01-01','03-28','03-29','05-01','06-07','06-29','07-23','07-28',
    '07-29','08-06','08-30','10-08','11-01','12-08','12-09','12-25'
  ],
  EC: [ // Ecuador
    '01-01','02-12','02-13','03-28','03-29','05-01','05-24',
    '08-10','10-09','11-02','11-03','12-25'
  ],
  US: [ // EEUU (fijos, no floating)
    '01-01','07-04','11-11','12-25'
  ],
  ES: [ // España
    '01-01','01-06','03-28','03-29','05-01','08-15','10-12','11-01','12-06','12-08','12-25'
  ]
};

// Detectar país por prefijo telefónico
function getCountryFromPhone(phone) {
  const num = phone.replace(/[^0-9]/g, '');
  if (num.startsWith('57')) return 'CO';
  if (num.startsWith('54')) return 'AR';
  if (num.startsWith('52')) return 'MX';
  if (num.startsWith('56')) return 'CL';
  if (num.startsWith('51')) return 'PE';
  if (num.startsWith('593')) return 'EC';
  if (num.startsWith('1')) return 'US';
  if (num.startsWith('34')) return 'ES';
  return 'CO'; // default Colombia
}

// Obtener timezone por país
function getTimezoneForCountry(country) {
  const tzMap = {
    CO: 'America/Bogota', AR: 'America/Argentina/Buenos_Aires', MX: 'America/Mexico_City',
    CL: 'America/Santiago', PE: 'America/Lima', EC: 'America/Guayaquil',
    US: 'America/New_York', ES: 'Europe/Madrid'
  };
  return tzMap[country] || 'America/Bogota';
}

// Verificar si es fin de semana (sábado ≥15:00 hasta lunes <8:30) o festivo en el país del lead
function isFollowUpBlocked(phone) {
  const country = getCountryFromPhone(phone);
  const tz = getTimezoneForCountry(country);
  const nowStr = new Date().toLocaleString('en-US', { timeZone: tz });
  const localNow = new Date(nowStr);
  const day = localNow.getDay(); // 0=dom, 6=sáb
  const hour = localNow.getHours();
  const min = localNow.getMinutes();
  const timeDecimal = hour + min / 60;

  // Sábado ≥ 15:00
  if (day === 6 && timeDecimal >= 15) return `fin de semana (sáb ${hour}:${min.toString().padStart(2,'0')} ${country})`;
  // Domingo todo el día
  if (day === 0) return `fin de semana (dom ${country})`;
  // Lunes < 8:30
  if (day === 1 && timeDecimal < 8.5) return `fin de semana (lun pre-8:30 ${country})`;

  // Festivos
  const mm = (localNow.getMonth() + 1).toString().padStart(2, '0');
  const dd = localNow.getDate().toString().padStart(2, '0');
  const todayStr = `${mm}-${dd}`;
  const holidays = HOLIDAYS_BY_COUNTRY[country] || [];
  if (holidays.includes(todayStr)) return `festivo ${todayStr} (${country})`;

  return null; // no bloqueado
}

// Calcular milisegundos equivalentes a N días hábiles (saltando fines de semana y festivos del país del lead)
function calcBusinessDaysMs(days, phone) {
  const country = getCountryFromPhone(phone);
  const tz = getTimezoneForCountry(country);
  const holidays = HOLIDAYS_BY_COUNTRY[country] || [];
  let counted = 0;
  let cursor = new Date();
  while (counted < days) {
    cursor.setDate(cursor.getDate() + 1);
    const localStr = cursor.toLocaleString('en-US', { timeZone: tz });
    const local = new Date(localStr);
    const dow = local.getDay(); // 0=dom, 6=sáb
    if (dow === 0 || dow === 6) continue; // fin de semana
    const mm = (local.getMonth() + 1).toString().padStart(2, '0');
    const dd = local.getDate().toString().padStart(2, '0');
    if (holidays.includes(`${mm}-${dd}`)) continue; // festivo
    counted++;
  }
  return cursor.getTime() - Date.now();
}

async function processLeadFollowUps() {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const [phone, meta] of Object.entries(conversationMetadata)) {
    if (meta.followUpState !== 'pending') continue;
    if (!meta.lastCotizacionSent) continue;

    const elapsed = now - meta.lastCotizacionSent;
    if (elapsed < THREE_DAYS_MS) continue;

    // BLINDAJE: No enviar follow-ups en fin de semana ni festivos del país del lead
    const blocked = isFollowUpBlocked(phone);
    if (blocked) {
      console.log(`[FOLLOW-UP] Bloqueado para ${phone}: ${blocked}. Se reintentará luego.`);
      continue;
    }

    // Si Mariano intervino manualmente después de la cotización, resetear timer
    if (meta.humanInterventionTime && meta.humanInterventionTime > meta.lastCotizacionSent) {
      meta.lastCotizacionSent = meta.humanInterventionTime;
      saveDB();
      continue;
    }

    const leadName = leadNames[phone] || phone.split('@')[0];
    const history = conversations[phone] || [];
    const historyText = history.slice(-20)
      .map(m => `${m.role === 'user' ? 'Lead' : 'MIIA'}: ${m.content.substring(0, 200)}`)
      .join('\n');

    const followUpPrompt = `Eres MIIA, asistente de ventas de Medilink. El lead "${leadName}" recibió una cotización hace más de 3 días y no ha respondido.

Historial reciente de la conversación:
${historyText}

Escribí UN mensaje de seguimiento breve (máximo 3 líneas) para revivir el interés. Usá algún gancho relacionado a la conversación (su tipo de clínica, el problema que mencionó, la urgencia de la promo, etc). Soná como MIIA Owner escribiendo desde su celular — natural, directo, no robótico. NO menciones que sos una IA. NO uses "estimado" ni lenguaje formal. NO repitas la cotización. Solo buscá reabrir la conversación.`;

    // CAP de follow-ups: máximo 7 intentos por lead
    if (!meta.followUpAttempts) meta.followUpAttempts = 0;
    if (meta.followUpAttempts >= 7) {
      meta.followUpState = 'stopped';
      console.log(`[FOLLOW-UP] Lead ${leadName} alcanzó el máximo de 7 follow-ups. Detenido.`);
      saveDB();
      continue;
    }

    try {
      const followUpMsg = await generateAIContent(followUpPrompt);
      if (followUpMsg && followUpMsg.trim()) {
        await safeSendMessage(phone, followUpMsg.trim());
        meta.followUpAttempts = (meta.followUpAttempts || 0) + 1;
        console.log(`[FOLLOW-UP] Mensaje ${meta.followUpAttempts}/7 enviado a ${leadName} (${phone})`);
        meta.lastCotizacionSent = now; // no volver a escribir en 3 días
        saveDB();
      }
    } catch (e) {
      console.error(`[FOLLOW-UP] Error generando follow-up para ${phone}:`, e.message);
    }
  }
}

async function processMorningBriefing() {
  try {
    if (!whatsappClient || !isReady) return;

    const bogotaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const h         = bogotaNow.getHours();
    const min       = bogotaNow.getMinutes();
    const todayStr  = bogotaNow.toLocaleDateString('es-ES');

    // Ventana: 8:30–8:59 AM Bogotá, una vez por día
    if (h !== 8 || min < 30 || morningBriefingDone === todayStr) return;
    morningBriefingDone = todayStr;

    // ── 1. Novedades regulatorias del scraper (interactivo: Mariano aprueba) ──
    const scraperResults = webScraper.getPendingResults();

    // ── 2. Leads con pendientes detectados en sus resúmenes ──
    const keywords = ['pendiente', 'demo', 'mañana', 'esta semana', 'llamar', 'cotización', 'cotizacion', 'hoy', 'seguimiento', 'contactar'];
    const pendingEntries = Object.entries(leadSummaries)
      .filter(([, summary]) => {
        const s = (summary || '').toLowerCase();
        return keywords.some(k => s.includes(k));
      })
      .slice(0, 10)
      .map(([lPhone, summary]) => {
        const name = leadNames[lPhone] || lPhone.split('@')[0];
        return `▸ *${name}*: ${summary.substring(0, 160)}`;
      })
      .join('\n');

    const leadsSection = pendingEntries
      ? `\n\n*👥 LEADS CON PENDIENTES HOY:*\n${pendingEntries}`
      : '';

    // ── 3. Sin nada que informar ──
    if (!scraperResults.length && !leadsSection) {
      console.log('[BRIEFING] Sin novedades hoy. No se envía mensaje.');
      return;
    }

    let briefing = `🌅 *Buenos días, Mariano.* Aquí tu resumen matutino de MIIA:`;

    // Sección regulatoria — lista numerada, requiere aprobación
    if (scraperResults.length > 0) {
      briefingPendingApproval = [...scraperResults];
      webScraper.clearPendingResults();

      briefing += `\n\n*📋 NOVEDADES REGULATORIAS (${scraperResults.length}):*\n`;
      scraperResults.forEach((r, i) => {
        briefing += `\n*${i + 1}.* _${r.source}_ (${r.fecha}):\n${r.text}\n`;
      });
      briefing += `\n¿Qué querés que aprenda? Respondé con los números separados por coma (ej: *1, 3*), *todos* o *ninguno*.`;
    }

    // Sección leads (informativa, sin aprobación)
    if (leadsSection) briefing += leadsSection;

    await safeSendMessage(`${OWNER_PHONE}@c.us`, briefing);
    console.log(`[BRIEFING] Briefing interactivo enviado a Mariano (${scraperResults.length} regulatorias, leads: ${!!pendingEntries}).`);
  } catch (e) {
    console.error('[BRIEFING] Error:', e.message);
  }

  // Follow-up automático a leads sin respuesta de 3+ días
  await processLeadFollowUps();
}

// Contador de rate limit de mensajes enviados por hora
const hourlySendLog = { hour: -1, count: 0 };
const MAX_SENDS_PER_HOUR = 50;

setInterval(async () => {
  // Verificar consentimiento ADN antes de ejecutar el minado
  let adnConsentOk = false;
  try {
    if (admin.apps.length > 0) {
      const ownerUid = process.env.OWNER_UID;
      if (ownerUid) {
        const ownerDoc = await admin.firestore().collection('users').doc(ownerUid).get();
        adnConsentOk = ownerDoc.exists && ownerDoc.data().consent_adn === true;
      } else {
        // Fallback: buscar primer usuario con role admin y consent_adn
        const snap = await admin.firestore().collection('users')
          .where('role', 'in', ['admin', 'client'])
          .where('consent_adn', '==', true)
          .limit(1).get();
        adnConsentOk = !snap.empty;
      }
    }
  } catch (e) {
    console.log('[CRON ADN] No se pudo verificar consentimiento:', e.message);
  }

  if (adnConsentOk) {
    cerebroAbsoluto.processADNMinerCron();
  } else {
    // Solo logear si estamos en la hora del cron (3AM) para no llenar logs
    const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).getHours();
    if (h === 3) console.log('[CRON ADN] Sin consentimiento registrado. Minado cancelado.');
  }

  webScraper.processScraperCron();
  processMorningWakeup();
  processMorningBriefing();
}, 60 * 1000);

// Endpoint para disparar el scraper manualmente
app.post('/api/scraper/run', (_req, res) => {
  res.json({ success: true, message: 'Scraper regulatorio activado en segundo plano.' });
  webScraper.runScraper().catch(e => console.error('[API] Error en scraper manual:', e.message));
});

// Endpoint para aprender el centro de ayuda Medilink (https://ayuda.softwaremedilink.com/es/)
app.post('/api/cerebro/learn-helpcenter', async (_req, res) => {
  res.json({ success: true, message: 'Iniciando aprendizaje del centro de ayuda Medilink...' });
  (async () => {
    const BASE = 'https://ayuda.softwaremedilink.com/es/';
    try {
      console.log('[HELPCENTER] Iniciando crawl de ayuda.softwaremedilink.com...');
      // 1. Fetch index page to discover article links
      const indexResp = await fetch(BASE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MIIABot/1.0)' }, signal: AbortSignal.timeout(15000) });
      const indexHtml = await indexResp.text();
      // Extract unique article URLs under the same domain
      const linkMatches = [...new Set([...indexHtml.matchAll(/href="(\/[^"#?]*(?:article|es\/)[^"#?]*)"/gi)].map(m => m[1]))];
      const articleUrls = linkMatches
        .filter(p => p.startsWith('/') && !p.endsWith('.css') && !p.endsWith('.js'))
        .map(p => `https://ayuda.softwaremedilink.com${p}`)
        .slice(0, 60); // max 60 artículos
      console.log(`[HELPCENTER] ${articleUrls.length} artículos encontrados.`);

      // 2. Fetch and learn each article
      let learned = 0;
      for (const url of articleUrls) {
        try {
          const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MIIABot/1.0)' }, signal: AbortSignal.timeout(12000) });
          if (!resp.ok) continue;
          const html = await resp.text();
          const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().substring(0, 6000);
          if (text.length < 150) continue;
          const prompt = `Sos MIIA, asistente de ventas de Medilink. Resumí el siguiente artículo del centro de ayuda de Medilink en máximo 200 palabras, en un formato que te permita recordar y explicar esta funcionalidad a futuros leads. Incluí el link del artículo: ${url}\n\nContenido:\n${text}`;
          const summary = await generateAIContent(prompt);
          if (summary && summary.length > 50) {
            cerebroAbsoluto.appendLearning(`[AYUDA MEDILINK - ${url}]\n${summary}`, 'HELPCENTER_MEDILINK');
            learned++;
          }
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.warn(`[HELPCENTER] Error en ${url}:`, e.message);
        }
      }
      saveDB();
      console.log(`[HELPCENTER] ✅ Aprendizaje completo: ${learned}/${articleUrls.length} artículos procesados.`);
      // Notify Mariano via WhatsApp
      safeSendMessage(`${OWNER_PHONE}@c.us`, `✅ *Centro de Ayuda Medilink aprendido*\n${learned} artículos procesados y guardados en mi memoria.`).catch(() => {});
    } catch (e) {
      console.error('[HELPCENTER] Error general:', e.message);
    }
  })();
});

// Endpoint para disparar el minado manualmente desde el panel
app.post('/api/cerebro/mine-dna', async (_req, res) => {
  if (!whatsappClient || !isReady) {
    return res.status(503).json({ error: 'WhatsApp no conectado.' });
  }
  res.json({ success: true, message: 'CEREBRO ABSOLUTO activado en segundo plano.' });
  cerebroAbsoluto.extractDNAChronological().catch(e =>
    console.error('[API] Error en mine-dna manual:', e.message)
  );
});

app.get('/api/cerebro/status', (_req, res) => {
  res.json({
    trainingDataLength: cerebroAbsoluto.getTrainingData().length,
    hasTrainingData: cerebroAbsoluto.getTrainingData().length > 0
  });
});

// Inyección directa de conocimiento (usado desde Claude, scripts externos, etc.)
app.post('/api/cerebro/learn', express.json(), (req, res) => {
  const { text, source } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text requerido' });
  cerebroAbsoluto.appendLearning(text, source || 'API_DIRECTA');
  saveDB();
  res.json({ success: true, trainingDataLength: cerebroAbsoluto.getTrainingData().length });
});

// Endpoint de entrenamiento web — guarda lo que Mariano enseña desde training.html
app.post('/api/train', express.json(), async (req, res) => {
  console.log('Calling /api/train with body:', req.body);
  try {
    const { message } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'message requerido' });
    cerebroAbsoluto.appendLearning(message, 'WEB_TRAINING');
    saveDB();
    const confirmPrompt = `Eres MIIA, asistente de Medilink creada por MIIA Owner.
Mariano acaba de enseñarte lo siguiente para que lo incorpores a tu conocimiento permanente:
"${message}"
Confirma brevemente que lo entendiste y lo guardaste (máx 2 oraciones), en primera persona, sin tecnicismos.`;
    const confirmation = await generateAIContent(confirmPrompt);
    res.json({ response: confirmation || '✅ Aprendido y guardado en mi memoria.', saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// TRAINING ENDPOINTS — Products, Contact Rules, Sessions, Test
// ============================================

// ── Training Products (grilla) ──────────────────────────────────────────────

app.get('/api/tenant/:uid/train/products', async (req, res) => {
  try {
    const { uid } = req.params;
    const snapshot = await admin.firestore().collection('training_products').doc(uid).collection('items').orderBy('createdAt', 'desc').get();
    const products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(products);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tenant/:uid/train/product', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, description, price, pricePromo, stock, extras } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name requerido' });

    const productData = {
      name: name.trim(),
      description: (description || '').trim(),
      price: price || '',
      pricePromo: pricePromo || '',
      stock: stock || '',
      extras: extras || {},
      createdAt: new Date().toISOString()
    };

    const docRef = await admin.firestore().collection('training_products').doc(uid).collection('items').add(productData);

    // Inject into tenant brain
    const learningText = `Producto: ${productData.name} — ${productData.description}. Precio: ${productData.price}${productData.pricePromo ? ` (Promo: ${productData.pricePromo})` : ''}${productData.stock ? ` · Stock: ${productData.stock}` : ''}`;
    tenantManager.appendTenantTraining(uid, learningText);

    res.json({ success: true, id: docRef.id, product: productData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tenant/:uid/train/product/:productId', async (req, res) => {
  try {
    const { uid, productId } = req.params;
    await admin.firestore().collection('training_products').doc(uid).collection('items').doc(productId).delete();

    // Rebuild tenant brain without this product
    await rebuildTenantBrainFromFirestore(uid);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Contact Rules (keywords) ────────────────────────────────────────────────

app.get('/api/tenant/:uid/train/contact-rules', async (req, res) => {
  try {
    const { uid } = req.params;
    const doc = await admin.firestore().collection('contact_rules').doc(uid).get();
    if (!doc.exists) return res.json({ lead_keywords: [], client_keywords: [] });
    res.json(doc.data());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tenant/:uid/train/contact-rules', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { lead_keywords, client_keywords } = req.body;

    const rulesData = {
      lead_keywords: lead_keywords || [],
      client_keywords: client_keywords || [],
      updatedAt: new Date().toISOString()
    };

    await admin.firestore().collection('contact_rules').doc(uid).set(rulesData, { merge: true });

    // Rebuild brain with new rules
    await rebuildTenantBrainFromFirestore(uid);

    res.json({ success: true, rules: rulesData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Training Sessions (chat experto) ────────────────────────────────────────

app.get('/api/tenant/:uid/train/sessions', async (req, res) => {
  try {
    const { uid } = req.params;
    const snapshot = await admin.firestore().collection('training_sessions').doc(uid).collection('sessions').orderBy('createdAt', 'desc').get();
    const sessions = snapshot.docs.map(d => ({ date: d.id, ...d.data() }));
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tenant/:uid/train/session', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { messages, trainingBlock } = req.body;
    if (!messages || !trainingBlock) return res.status(400).json({ error: 'messages and trainingBlock required' });

    const dateKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Generate summary via Gemini
    const geminiKey = process.env.GEMINI_API_KEY;
    let summary = dateKey;
    try {
      const summaryPrompt = `Resume en máximo 6 palabras el tema principal de esta sesión de entrenamiento:\n\n${trainingBlock}`;
      summary = await callGemini(geminiKey, summaryPrompt);
      summary = (summary || dateKey).replace(/["\n]/g, '').trim().substring(0, 60);
    } catch (_) { /* keep default */ }

    const sessionData = {
      messages,
      trainingBlock,
      summary,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await admin.firestore().collection('training_sessions').doc(uid).collection('sessions').doc(dateKey).set(sessionData);

    // Inject into tenant brain
    tenantManager.appendTenantTraining(uid, trainingBlock);

    res.json({ success: true, date: dateKey, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/tenant/:uid/train/session/:date', express.json(), async (req, res) => {
  try {
    const { uid, date } = req.params;
    const { additionalText } = req.body;
    if (!additionalText) return res.status(400).json({ error: 'additionalText required' });

    const docRef = admin.firestore().collection('training_sessions').doc(uid).collection('sessions').doc(date);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Session not found' });

    const existing = doc.data();
    const updatedBlock = existing.trainingBlock + '\n' + additionalText;

    await docRef.update({
      trainingBlock: updatedBlock,
      updatedAt: new Date().toISOString()
    });

    // Rebuild brain with updated session
    await rebuildTenantBrainFromFirestore(uid);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tenant/:uid/train/session/:date', async (req, res) => {
  try {
    const { uid, date } = req.params;
    await admin.firestore().collection('training_sessions').doc(uid).collection('sessions').doc(date).delete();

    // Rebuild brain without this session
    await rebuildTenantBrainFromFirestore(uid);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Métodos de cobro ─────────────────────────────────────────────────────────

app.get('/api/tenant/:uid/train/payment-methods', async (req, res) => {
  try {
    const { uid } = req.params;
    const doc = await admin.firestore().collection('payment_methods').doc(uid).get();
    res.json(doc.exists ? (doc.data().methods || []) : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tenant/:uid/train/payment-methods', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { methods } = req.body;
    if (!Array.isArray(methods)) return res.status(400).json({ error: 'methods array required' });

    await admin.firestore().collection('payment_methods').doc(uid).set({ methods, updatedAt: new Date() });

    // Rebuild brain: inyectar métodos activos según su tipo estructurado
    const activeLines = methods.filter(m => m.enabled).map(m => {
      switch (m.type) {
        case 'link':
          return m.payment_link ? `${m.name}: Envía este link exacto al lead cuando quiera pagar: ${m.payment_link}` : null;
        case 'banco': {
          const acct = m.cbu_alias || m.clabe || m.cci_rut;
          if (!acct) return null;
          const label = m.country === 'MX' ? 'CLABE' : m.country === 'CL' ? 'CCI/RUT' : 'CBU/CVU/Alias';
          return `${m.name}: ${label}: ${acct}${m.bank_name ? ', Banco: ' + m.bank_name : ''}${m.account_holder ? ', Titular: ' + m.account_holder : ''}`;
        }
        case 'instrucciones': {
          const parts = [];
          if (m.reference_code) parts.push(`Código de pago: ${m.reference_code}`);
          if (m.instructions && m.instructions.trim()) parts.push(m.instructions.trim());
          return parts.length ? `${m.name}: ${parts.join('. ')}` : null;
        }
        case 'qr':
          return m.qr_image_base64
            ? `Pago por QR disponible${m.qr_description ? ' (' + m.qr_description + ')' : ''}. Cuando el lead quiera pagar por QR, usa el tag [ENVIAR_QR_COBRO] en tu respuesta.`
            : null;
        case 'cripto':
          return m.wallet_address ? `${m.name} — ${m.coin || 'Cripto'} (${m.network || 'red'}): ${m.wallet_address}` : null;
        default: return null;
      }
    }).filter(Boolean);

    if (activeLines.length > 0) {
      tenantManager.appendTenantTraining(uid, '===MÉTODOS DE COBRO===\n' + activeLines.join('\n'));
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Export/Import Backup MIIA ────────────────────────────────────────────────

const BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || 'miia-backup-default-key-2026';

function encryptBackup(data, uid) {
  const key = crypto.scryptSync(BACKUP_MASTER_KEY + uid, 'miia-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return { iv: iv.toString('base64'), data: encrypted };
}

function decryptBackup(payload, masterKeyOnly) {
  const key = crypto.scryptSync(masterKeyOnly, 'miia-salt', 32);
  const iv = Buffer.from(payload.iv, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(payload.data, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// ============================================
// AI PROVIDER CONFIGURATION
// ============================================

// GET /api/tenant/:uid/ai-config — Get current AI provider config
app.get('/api/tenant/:uid/ai-config', async (req, res) => {
  try {
    const { uid } = req.params;
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    const data = doc.data();
    res.json({
      provider: data.ai_provider || 'gemini',
      hasCustomKey: !!(data.ai_api_key),
      providerLabel: PROVIDER_LABELS[data.ai_provider || 'gemini'] || 'Google Gemini'
    });
  } catch (err) {
    console.error('[AI-CONFIG] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener configuración de IA' });
  }
});

// PUT /api/tenant/:uid/ai-config — Save AI provider + API key
app.put('/api/tenant/:uid/ai-config', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { provider, apiKey } = req.body;
    const validProviders = ['gemini', 'openai', 'claude'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Proveedor inválido. Válidos: ${validProviders.join(', ')}` });
    }
    if (!apiKey || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'API key inválida' });
    }

    await db.collection('users').doc(uid).update({
      ai_provider: provider,
      ai_api_key: apiKey.trim(),
      ai_updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update running tenant if active
    tenantManager.setTenantAIConfig(uid, provider, apiKey.trim());

    res.json({ success: true, provider, providerLabel: PROVIDER_LABELS[provider] });
  } catch (err) {
    console.error('[AI-CONFIG] Error saving:', err.message);
    res.status(500).json({ error: 'Error al guardar configuración de IA' });
  }
});

// POST /api/tenant/:uid/ai-test — Test AI connection with a simple prompt
app.post('/api/tenant/:uid/ai-test', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { provider, apiKey } = req.body;
    const validProviders = ['gemini', 'openai', 'claude'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Proveedor inválido` });
    }
    if (!apiKey || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'API key inválida' });
    }

    const testPrompt = 'Responde únicamente con la palabra "OK" si puedes leer este mensaje.';
    const startTime = Date.now();
    const response = await callAI(provider, apiKey.trim(), testPrompt);
    const latency = Date.now() - startTime;

    if (!response) {
      return res.status(400).json({ error: 'No se recibió respuesta del proveedor. Verifica tu API key.' });
    }

    res.json({
      success: true,
      provider,
      providerLabel: PROVIDER_LABELS[provider],
      response: response.substring(0, 100),
      latencyMs: latency
    });
  } catch (err) {
    console.error('[AI-TEST] Error:', err.message);
    const msg = err.message.includes('401') || err.message.includes('403')
      ? 'API key inválida o sin permisos'
      : err.message.includes('404')
        ? 'Modelo no disponible con esta key'
        : `Error de conexión: ${err.message.substring(0, 100)}`;
    res.status(400).json({ error: msg });
  }
});

// DELETE /api/tenant/:uid/ai-config — Reset to default (Gemini with global key)
app.delete('/api/tenant/:uid/ai-config', async (req, res) => {
  try {
    const { uid } = req.params;
    await db.collection('users').doc(uid).update({
      ai_provider: admin.firestore.FieldValue.delete(),
      ai_api_key: admin.firestore.FieldValue.delete(),
      ai_updated_at: admin.firestore.FieldValue.delete()
    });

    // Reset running tenant to global Gemini
    const globalKey = process.env.GEMINI_API_KEY;
    tenantManager.setTenantAIConfig(uid, 'gemini', globalKey);

    res.json({ success: true, provider: 'gemini', providerLabel: 'Google Gemini (default)' });
  } catch (err) {
    console.error('[AI-CONFIG] Error resetting:', err.message);
    res.status(500).json({ error: 'Error al restablecer configuración' });
  }
});

// POST /api/tenant/:uid/export — Generate encrypted .miia backup
app.post('/api/tenant/:uid/export', async (req, res) => {
  try {
    const { uid } = req.params;

    // Rate limit: max 1 export per week
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userData = userDoc.data();
    const lastExport = userData.last_export ? userData.last_export.toDate() : null;
    if (lastExport && (Date.now() - lastExport.getTime()) < 7 * 24 * 60 * 60 * 1000) {
      return res.status(429).json({ error: 'Solo puedes exportar 1 vez por semana. Próximo export disponible: ' + new Date(lastExport.getTime() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString() });
    }

    // Gather all user data
    const productsSnap = await admin.firestore().collection('training_products').doc(uid).collection('items').get();
    const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const sessionsSnap = await admin.firestore().collection('training_sessions').doc(uid).collection('sessions').get();
    const sessions = sessionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    let contactRules = {};
    try {
      const rulesDoc = await admin.firestore().collection('contact_rules').doc(uid).get();
      if (rulesDoc.exists) contactRules = rulesDoc.data();
    } catch (_) {}

    let paymentMethods = [];
    try {
      const pmDoc = await admin.firestore().collection('payment_methods').doc(uid).get();
      if (pmDoc.exists) paymentMethods = pmDoc.data().methods || [];
    } catch (_) {}

    const exportId = crypto.randomBytes(16).toString('hex');
    const now = new Date();

    const backupData = {
      _miia_backup: true,
      _version: '1.0',
      _export_id: exportId,
      _source_uid: uid,
      _source_email: userData.email || '',
      _exported_at: now.toISOString(),
      products,
      sessions,
      contactRules,
      paymentMethods
    };

    // Encrypt with master key ONLY (not uid-bound, so any account can import)
    const encrypted = encryptBackup(backupData, 'global');

    // Record export in user doc
    await admin.firestore().collection('users').doc(uid).update({
      last_export: now,
      last_export_id: exportId
    });

    res.json({
      success: true,
      filename: `miia-backup-${now.toISOString().slice(0, 10)}.miia`,
      backup: encrypted
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/import — Import encrypted .miia backup
app.post('/api/tenant/:uid/import', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { uid } = req.params;
    const { backup } = req.body;
    if (!backup || !backup.iv || !backup.data) {
      return res.status(400).json({ error: 'Archivo de backup inválido' });
    }

    // Decrypt
    let data;
    try {
      data = decryptBackup(backup, BACKUP_MASTER_KEY + 'global');
    } catch (_) {
      return res.status(400).json({ error: 'No se pudo descifrar el backup. Archivo corrupto o inválido.' });
    }

    if (!data._miia_backup) {
      return res.status(400).json({ error: 'Archivo no es un backup válido de MIIA' });
    }

    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userData = userDoc.data();

    // Anti-abuse: detect trial farming
    const sourceEmail = data._source_email || '';
    const importerEmail = userData.email || '';
    const exportId = data._export_id || '';

    // Check if same export_id was imported by 2+ accounts already
    const existingImports = await admin.firestore().collection('imports')
      .where('export_id', '==', exportId).get();
    if (existingImports.size >= 2) {
      return res.status(403).json({ error: 'Este backup ya fue importado en el máximo de cuentas permitidas.' });
    }

    // Check email similarity (gmail alias trick: user+1@gmail.com)
    const normalizeEmail = (e) => e.split('@')[0].replace(/\+.*$/, '').replace(/\./g, '').toLowerCase() + '@' + (e.split('@')[1] || '').toLowerCase();
    const isSameEmailVariant = normalizeEmail(sourceEmail) === normalizeEmail(importerEmail) && sourceEmail !== importerEmail;

    // Determine alert level
    let alertLevel = 'none';
    if (userData.plan === 'trial' && isSameEmailVariant) alertLevel = 'high';
    else if (userData.plan === 'trial') alertLevel = 'medium';
    else if (isSameEmailVariant) alertLevel = 'low';

    // Import products
    if (data.products && data.products.length) {
      const batch = admin.firestore().batch();
      for (const p of data.products) {
        const { id, ...pData } = p;
        const ref = admin.firestore().collection('training_products').doc(uid).collection('items').doc();
        batch.set(ref, { ...pData, imported: true, import_date: new Date() });
      }
      await batch.commit();
    }

    // Import sessions
    if (data.sessions && data.sessions.length) {
      const batch = admin.firestore().batch();
      for (const s of data.sessions) {
        const { id, ...sData } = s;
        const ref = admin.firestore().collection('training_sessions').doc(uid).collection('sessions').doc(id || crypto.randomBytes(4).toString('hex'));
        batch.set(ref, { ...sData, imported: true, import_date: new Date() });
      }
      await batch.commit();
    }

    // Import contact rules (merge)
    if (data.contactRules && Object.keys(data.contactRules).length) {
      await admin.firestore().collection('contact_rules').doc(uid).set(data.contactRules, { merge: true });
    }

    // Import payment methods (merge)
    if (data.paymentMethods && data.paymentMethods.length) {
      await admin.firestore().collection('payment_methods').doc(uid).set({
        methods: data.paymentMethods,
        updatedAt: new Date(),
        imported: true
      });
    }

    // Record import for abuse tracking
    await admin.firestore().collection('imports').doc(uid + '_' + exportId).set({
      uid,
      email: importerEmail,
      source_uid: data._source_uid,
      source_email: sourceEmail,
      export_id: exportId,
      exported_at: data._exported_at,
      imported_at: new Date(),
      alert_level: alertLevel,
      is_email_variant: isSameEmailVariant
    });

    // Flag user doc
    await admin.firestore().collection('users').doc(uid).update({
      imported_backup: true,
      import_source_email: sourceEmail,
      import_alert_level: alertLevel,
      import_date: new Date()
    });

    // Rebuild brain
    await rebuildTenantBrainFromFirestore(uid);

    res.json({
      success: true,
      imported: {
        products: (data.products || []).length,
        sessions: (data.sessions || []).length,
        contactRules: Object.keys(data.contactRules || {}).length > 0,
        paymentMethods: (data.paymentMethods || []).length
      },
      alert_level: alertLevel
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/imports — List all imports for admin dashboard
app.get('/api/admin/imports', async (req, res) => {
  try {
    const snap = await admin.firestore().collection('imports').orderBy('imported_at', 'desc').limit(50).get();
    const imports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(imports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Test MIIA (simulador de cliente) ────────────────────────────────────────

app.post('/api/tenant/:uid/test', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Build tenant brain from Firestore
    const trainingData = await getFullTenantBrain(uid);

    const prompt = buildPrompt({ mode: 'test', trainingData });
    const geminiKey = process.env.GEMINI_API_KEY;
    const response = await callGemini(geminiKey, prompt + `\nCliente: ${message}\nMIIA:`);

    res.json({ response: response || 'No pude generar una respuesta. Intenta de nuevo.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin User Management ───────────────────────────────────────────────────

app.post('/api/admin/user', express.json(), verifyAdminToken, async (req, res) => {

  try {
    const { email, name, plan } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Generate temp password
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let tempPassword = '';
    for (let i = 0; i < 8; i++) tempPassword += chars.charAt(Math.floor(Math.random() * chars.length));

    // Create Firebase Auth user
    const userRecord = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName: name || email.split('@')[0]
    });

    // Create Firestore user doc
    await admin.firestore().collection('users').doc(userRecord.uid).set({
      name: name || email.split('@')[0],
      email,
      plan: plan || 'trial',
      role: 'admin',
      agents_limit: 1,
      agents_count: 0,
      created_manually: true,
      temp_password: true,
      payment_status: plan === 'trial' ? 'trial' : 'pending',
      created_at: new Date().toISOString()
    });

    res.json({
      success: true,
      uid: userRecord.uid,
      email,
      tempPassword,
      message: `User created. Temporary password: ${tempPassword}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/user/:uid', verifyAdminToken, async (req, res) => {

  try {
    const { uid } = req.params;

    // Destroy tenant WA session
    await tenantManager.destroyTenant(uid);

    // Delete Firestore user doc + subcollections
    const subcollections = ['training_products', 'training_sessions', 'contact_rules'];
    for (const col of subcollections) {
      try {
        const docRef = admin.firestore().collection(col).doc(uid);
        // Delete subcollection items if they exist
        const subcol = col === 'contact_rules' ? null : 'items';
        if (subcol) {
          const snap = await docRef.collection(subcol === 'items' ? 'items' : 'sessions').get();
          for (const doc of snap.docs) await doc.ref.delete();
        }
        await docRef.delete();
      } catch (_) { /* ignore missing */ }
    }

    await admin.firestore().collection('users').doc(uid).delete();

    // Delete Firebase Auth user (ignorar si no existe en Auth)
    try { await admin.auth().deleteUser(uid); } catch (_) {}

    res.json({ success: true, message: `User ${uid} completely deleted` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Middleware: verify Firebase Admin ─────────────────────────────────────

async function verifyAdminToken(req, res, next) {
  // Verificar que Firebase Admin está inicializado
  try { admin.app(); } catch (_) {
    return res.status(503).json({ error: 'Firebase Admin no está inicializado en el servidor. Verificar variable FIREBASE_SERVICE_ACCOUNT.' });
  }
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Falta header Authorization: Bearer <token>' });
    }
    const idToken = authHeader.substring(7);
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    // Owner bypass: si el email está en ADMIN_EMAILS, acceso total sin chequeo Firestore
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    const isOwnerBypass = adminEmails.includes((decodedToken.email || '').toLowerCase());
    if (!isOwnerBypass) {
      // Buscar por UID primero, luego por email como fallback
      let hasRole = false;
      const docByUid = await admin.firestore().collection('users').doc(decodedToken.uid).get();
      if (docByUid.exists && docByUid.data().role === 'admin') {
        hasRole = true;
      } else {
        const snap = await admin.firestore().collection('users').where('email', '==', decodedToken.email).limit(1).get();
        if (!snap.empty && snap.docs[0].data().role === 'admin') hasRole = true;
      }
      if (!hasRole) return res.status(403).json({ error: 'El usuario no tiene rol admin' });
    }
    req.user = { uid: decodedToken.uid, email: decodedToken.email };
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized: ' + e.message });
  }
}

// ── Helper: rebuild tenant brain from Firestore ─────────────────────────────

async function getFullTenantBrain(uid) {
  try {
    // Get base DNA
    let baseDNA = '';
    try {
      const baseDoc = await admin.firestore().collection('system').doc('miia_base_dna').get();
      if (baseDoc.exists) baseDNA = baseDoc.data().content || '';
    } catch (_) { /* no base DNA yet */ }

    // Get products
    const productsSnap = await admin.firestore().collection('training_products').doc(uid).collection('items').get();
    const products = productsSnap.docs.map(d => d.data());

    // Get sessions
    const sessionsSnap = await admin.firestore().collection('training_sessions').doc(uid).collection('sessions').get();
    const sessions = sessionsSnap.docs.map(d => d.data());

    // Get contact rules
    let contactRules = { lead_keywords: [], client_keywords: [] };
    try {
      const rulesDoc = await admin.firestore().collection('contact_rules').doc(uid).get();
      if (rulesDoc.exists) contactRules = rulesDoc.data();
    } catch (_) { /* no rules yet */ }

    return buildTenantBrainString(baseDNA, products, sessions, contactRules);
  } catch (e) {
    console.error(`[BRAIN] Error building brain for ${uid}:`, e.message);
    return '';
  }
}

async function rebuildTenantBrainFromFirestore(uid) {
  const brain = await getFullTenantBrain(uid);
  // Update live tenant if it exists
  const allTenants = tenantManager.getAllTenants();
  if (allTenants.find(t => t.uid === uid)) {
    // The tenant_manager stores trainingData internally; we update it via appendTenantTraining
    // by clearing and re-setting. For now, we use a direct approach:
    // tenant_manager doesn't expose setTrainingData, so we rely on the next message to pick it up.
    // TODO: expose setTenantTrainingData in tenant_manager
  }
  return brain;
}

// ============================================
// WHATSAPP DISCONNECT
// ============================================
app.post('/api/logout', async (req, res) => {
  try {
    if (whatsappClient) {
      console.log('🔌 Desvinculando WhatsApp...');
      await whatsappClient.logout();
      await whatsappClient.destroy();
      whatsappClient = null;
      isReady = false;
      console.log('✅ WhatsApp desvinculado');
    }
    res.json({ success: true, message: 'WhatsApp desvinculado correctamente' });
  } catch (err) {
    console.error('Error al desvincular:', err);
    res.status(500).json({ error: 'Error al desvincular WhatsApp: ' + err.message });
  }
});

// ============================================
// STRIPE CHECKOUT SESSIONS
// ============================================
app.post('/api/stripe/subscribe', express.json(), async (req, res) => {
  try {
    const { uid, plan } = req.body;
    if (!uid || !plan) return res.status(400).json({ error: 'uid y plan requeridos' });

    const prices = {
      monthly: 1200,      // $12.00
      quarterly: 3000,    // $30.00
      semestral: 5500,    // $55.00
      annual: 7500        // $75.00
    };

    if (!prices[plan]) return res.status(400).json({ error: 'plan inválido' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `MIIA — Plan ${plan}` },
          unit_amount: prices[plan]
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: FRONTEND_URL + '/dashboard.html?sub_success=1',
      cancel_url: FRONTEND_URL + '/dashboard.html',
      metadata: { uid, plan, type: 'subscription' }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error Stripe subscribe:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stripe/create-checkout-session', express.json(), async (req, res) => {
  try {
    const { uid, type, agentCount } = req.body;
    if (!uid || type !== 'agent') return res.status(400).json({ error: 'uid y type=agent requeridos' });

    // Precio dinámico: $3.00 base, -10% por cada agente adicional
    // agentCount es el número actual (antes de compra)
    const basePriceCents = 300;
    const priceInCents = Math.round(basePriceCents * Math.pow(0.9, agentCount));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Agente adicional MIIA' },
          unit_amount: priceInCents
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: FRONTEND_URL + '/dashboard.html?agent_success=1',
      cancel_url: FRONTEND_URL + '/dashboard.html',
      metadata: { uid, type: 'agent', agentCount }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error Stripe agent checkout:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STRIPE WEBHOOK
// ============================================
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { uid, plan, type } = session.metadata;

      console.log('✅ Pago completado:', { uid, plan, type });

      if (type === 'subscription' && plan) {
        // Actualizar plan en Firestore
        const prices = {
          monthly: 1,
          quarterly: 3,
          semestral: 6,
          annual: 12
        };
        const months = prices[plan] || 1;
        const now = new Date();
        const endDate = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);

        await admin.firestore().collection('users').doc(uid).update({
          plan: plan,
          plan_start_date: now,
          plan_end_date: endDate,
          payment_status: 'active'
        });

        console.log(`📝 Plan actualizado para ${uid}: ${plan}`);
      } else if (type === 'agent') {
        // Incrementar agents_limit
        await admin.firestore().collection('users').doc(uid).update({
          agents_limit: admin.firestore.FieldValue.increment(1)
        });

        console.log(`👥 Agente adicional comprado para ${uid}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
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
  console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ Configurada (' + process.env.GEMINI_API_KEY + ')' : '❌ NO CONFIGURADA');
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

  // Auto-start owner WhatsApp on boot using the FULL handleIncomingMessage logic.
  // This handles "hola miia", family contacts, Medilink leads, admin commands, etc.
  console.log(`[AUTO-INIT] 🚀 Auto-starting owner WhatsApp (full MIIA logic)...`);
  try {
    initWhatsApp();
  } catch (err) {
    console.error('[AUTO-INIT] ❌ Error auto-starting WhatsApp:', err.message);
  }
});

// Export app for testing
module.exports = app;