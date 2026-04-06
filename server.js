require('dotenv').config();

// Fix: gRPC DNS resolver for Firebase Admin SDK on Railway/Docker (Node 18)
process.env.GRPC_DNS_RESOLVER = 'native';

// Silenciar logs de libsignal (SessionEntry dumps, "Closing session", "Decrypted message with closed session")
// Estos llenan Railway logs a 500/sec sin aportar info útil
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _signalFilter = /Closing session:|SessionEntry|_chains:|chainKey:|ephemeralKeyPair|lastRemoteEphemeralKey|previousCounter|rootKey|indexInfo|baseKey:|baseKeyType|registrationId|currentRatchet|pubKey:|privKey:|remoteIdentityKey|Decrypted message with closed|Closing open session|Failed to decrypt message|<Buffer /;
// B2 FIX: Filter both string args AND stringified objects (libsignal dumps SessionEntry as objects)
// B3 FIX: Also filter Buffer objects containing key material (privKey, rootKey, ephemeralKeyPair)
const _isSignalNoise = (...args) => {
  for (const a of args) {
    if (typeof a === 'string' && _signalFilter.test(a)) return true;
    // libsignal console.log(SessionEntry {...}) — objects with _chains, privKey, etc.
    if (a && typeof a === 'object') {
      if ('_chains' in a || 'currentRatchet' in a || 'indexInfo' in a) return true;
      // Buffer objects from key material — never useful in logs, potential security leak
      if (Buffer.isBuffer(a) && a.length >= 16 && a.length <= 64) return true;
      // Objects with key-like properties containing Buffers
      if ('privKey' in a || 'rootKey' in a || 'ephemeralKeyPair' in a || 'chainKey' in a) return true;
    }
  }
  return false;
};
console.log = (...args) => { if (_isSignalNoise(...args)) return; _origLog(...args); };
console.error = (...args) => { if (_isSignalNoise(...args)) return; _origErr(...args); };

// ═══ RESILIENCE SHIELD — Monitoreo centralizado de salud ═══
const shield = require('./core/resilience_shield');

// Catch unhandled rejections — registrar en Shield
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
  shield.recordNodeError('unhandledRejection', err);
});

// Catch uncaught exceptions — registrar en Shield (NO terminar proceso)
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  shield.recordNodeError('uncaughtException', err);
  // NO process.exit() — Railway reinicia el proceso, pero queremos intentar seguir
});

// Graceful shutdown: flush affinity a Firestore antes de cerrar
process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] SIGTERM recibido — guardando datos en Firestore...');
  try { await saveAffinityToFirestore(); } catch (e) { console.error('[SHUTDOWN] Error affinity:', e.message); }
  try { await saveToFirestore(); } catch (e) { console.error('[SHUTDOWN] Error persistent:', e.message); }
  process.exit(0);
});

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// WhatsApp: Baileys (via tenant_manager.js) — no Chrome/Puppeteer needed

// ═══ CORE — Lógica central de MIIA ═══
const cerebroAbsoluto = require('./data/cerebro_absoluto');
const confidenceEngine = require('./core/confidence_engine');
const messageLogic = require('./core/message_logic');
const { applyMiiaEmoji, detectOwnerMood, detectMessageTopic, resetOffended, getCurrentMiiaMood, isMiiaSleeping } = require('./core/miia_emoji');
const { buildPrompt, buildTenantBrainString, buildOwnerFamilyPrompt, buildEquipoPrompt, buildSportsPrompt } = require('./core/prompt_builder');
const { assemblePrompt } = require('./core/prompt_modules');
const interMiia = require('./core/inter_miia');

// ═══ AI — Clientes y adaptadores IA ═══
const { callGemini, callGeminiChat } = require('./ai/gemini_client');
const { callAI, callAIChat, PROVIDER_LABELS } = require('./ai/ai_client');

// ═══ SERVICES — Servicios externos ═══
const cotizacionGenerator = require('./services/cotizacion_generator');
const webScraper = require('./services/web_scraper');
const estadisticas = require('./services/estadisticas');
const mailService = require('./services/mail_service');
const protectionManager = require('./services/protection_manager');
const biweeklyReport = require('./services/biweekly_report');

// ═══ WHATSAPP — Baileys, tenants, mensajes ═══
const tenantManager = require('./whatsapp/tenant_manager');
const tenantMessageHandler = require('./whatsapp/tenant_message_handler');

// ═══ FEATURES — Sports, Integrations, Voice ═══
const businessesRouter = require('./routes/businesses');
const sportEngine = require('./sports/sport_engine');
const integrationEngine = require('./integrations/integration_engine');
const ttsEngine = require('./voice/tts_engine');
const kidsMode = require('./voice/kids_mode');

// ═══ LIBS EXTERNAS ═══
const multer = require('multer');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { ImapFlow } = require('imapflow');
let pdfParse, mammoth;
try { pdfParse = require('pdf-parse'); } catch(e) { console.warn('[DOCS] pdf-parse no disponible'); }
try { mammoth = require('mammoth'); } catch(e) { console.warn('[DOCS] mammoth no disponible'); }

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
    // Quitar comillas externas si Railway las agregó
    if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
      pk = pk.slice(1, -1);
    }
    // Normalizar saltos de línea: Railway puede guardar \n literales o \\n dobles
    pk = pk.replace(/\\n/g, '\n');
    console.log('[FIREBASE] Usando vars individuales. ProjectId:', process.env.FIREBASE_PROJECT_ID, '| PrivateKey starts:', pk.substring(0, 27), '| has newlines:', pk.includes('\n'));
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

// PADDLE — procesamiento de pagos
const { Paddle, Environment, EventName } = require('@paddle/paddle-node-sdk');
const paddle = new Paddle(process.env.PADDLE_API_KEY || 'placeholder', {
  environment: process.env.PADDLE_ENV === 'sandbox' ? Environment.sandbox : Environment.production
});
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.miia-app.com';

// ============================================
// FORCE FLUSH PARA LOGS EN RAILWAY
// ============================================
// Force flush wrapper — console.log/error ya tienen filtro de signal noise (líneas 8-21)
// Solo agregar force-flush sin re-override
const _flushLog = console.log;
const _flushErr = console.error;
console.log = function(...args) { _flushLog(...args); if (process.stdout.write) process.stdout.write(''); };
console.error = function(...args) { _flushErr(...args); if (process.stderr.write) process.stderr.write(''); };

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:8080', 'http://127.0.0.1:5500'];
const io = socketIO(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"]
  }
});

app.use(compression());
app.use(express.static(path.join(__dirname, '../miia-frontend')));
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
app.use((req, res, next) => {
  // Paddle webhook necesita req.body como Buffer crudo para verificar firma
  if (req.path === '/api/paddle/webhook') return next();
  express.json()(req, res, next);
});

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

let OWNER_UID = process.env.OWNER_UID || '';
if (!OWNER_UID) console.log('[CONFIG] ℹ️ OWNER_UID no configurado — se auto-detectará desde Firestore (role=admin).');
// whatsappClient ahora es un getter que busca el sock del owner en tenant_manager
// Esto mantiene compatibilidad con toda la lógica existente del owner
function getOwnerSock() {
  if (!OWNER_UID) return null;
  return tenantManager.getTenantClient(OWNER_UID);
}
function getOwnerStatus() {
  if (!OWNER_UID) return { isReady: false };
  return tenantManager.getTenantStatus(OWNER_UID);
}
// Legacy compat — código existente usa estas variables
Object.defineProperty(global, '_ownerReady', { get: () => getOwnerStatus().isReady, configurable: true });
let qrCode = null; // Legacy — tenant_manager maneja QR ahora
let isReady = false; // Se actualiza desde tenant events
let ownerConnectedAt = 0; // Unix timestamp (seconds) — para filtrar mensajes offline post-reconnect
let conversations = {}; // { phone: [{ role, content, timestamp }] }
let contactTypes = { '573163937365@s.whatsapp.net': 'lead' }; // { phone: 'familia' | 'lead' | 'cliente' }
let leadNames = { '573163937365@s.whatsapp.net': 'Dr. Mariano' }; // { phone: 'nombre' }

// --- Mapeo LID ↔ Phone (Baileys linked devices) ---
// LID es un ID interno de WhatsApp que no contiene el número real del contacto
// Este mapeo se llena automáticamente y permite resolver LIDs a números reales
const lidToPhone = {}; // { '46510318301398': '573137501884@s.whatsapp.net' }
const phoneToLid = {}; // inverso

function registerLidMapping(lid, phone) {
  if (!lid || !phone || phone.includes('@lid')) return;
  const lidBase = lid.split('@')[0].split(':')[0];
  const phoneFull = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
  if (lidToPhone[lidBase] && lidToPhone[lidBase] === phoneFull) return; // ya existe
  lidToPhone[lidBase] = phoneFull;
  phoneToLid[phoneFull] = lidBase;
  console.log(`[LID-MAP] 🔗 ${lidBase} → ${phoneFull}`);
  // Persistir — no llamar saveDB() aquí para evitar thrashing durante sync masivo.
  // La persistencia ocurre en el ciclo normal de saveDB (cada 2 min via setInterval).
}

function resolveLid(jid) {
  if (!jid || !jid.includes('@lid')) return jid;
  const lidBase = jid.split('@')[0].split(':')[0];
  return lidToPhone[lidBase] || jid; // retorna el phone o el LID original si no hay mapeo
}

// --- Variables MIIA (portadas desde index.js) ---
let lastSentByBot = {};
let sentMessageIds = new Set();
let lastAiSentBody = {};
let lastMessageKey = {};    // 🔧 Para self-chat: guardar message.key más reciente por contacto
let miiaPausedUntil = 0;
let trainingData = '';
let leadSummaries = {};
let conversationMetadata = {};
let isProcessing = {};
let pendingResponses = {};  // re-trigger cuando llegan mensajes mientras se procesa
let messageTimers = {};     // debounce 3s por contacto — acumula mensajes antes de responder
const RESET_ALLOWED_PHONES = ['573163937365', '573054169969'];
let keywordsSet = [];
// BLINDAJE GENEALÓGICO MIIA FAMILY v4.0 — pre-inicializado con datos ricos
// loadDB() hace Object.assign encima → preserva affinity e isHandshakeDone actualizados de la DB
let familyContacts = {
  // Sistema de affinity (stages): el nivel de cercanía se guarda en conversationMetadata[phone].affinity
  // isHandshakeDone: false = MIIA nunca habló con esta persona (stage 0 se presenta)
  '573137501884': { name: 'Alejandra', fullName: 'Alejandra Sánchez', relation: 'esposa de Mariano', emoji: '👸💕', personality: 'Spicy, F1 (Leclerc/Colapinto), Parcera, interés en Libros', isHandshakeDone: false },
  '5491131313325': { name: 'Jedido', fullName: 'Mario Rafael De Stefano', relation: 'papá de Mariano', emoji: '👴❤️', personality: 'Respetuosa, cariñosa. Muy admirado por Mariano.', isHandshakeDone: false },
  '56994128069': { name: 'Vivi', fullName: 'Viviana Gaviria', relation: 'JEFA de Mariano', emoji: '👩‍💼👑', personality: 'Profesional, ejecutiva, técnica. Solo responde si ella dice Hola MIIA.', isHandshakeDone: false },
  '573128908895': { name: 'Jota', fullName: 'Jorge Mario', relation: 'hermano de Ale', emoji: '⚖️💚', personality: 'Abogado, fan del Nacional, padre de Renata', isHandshakeDone: false },
  '573012761138': { name: 'Maria Isabel', fullName: 'Maria Isabel', relation: 'esposa de Jota', emoji: '🐶🤱', personality: 'Madre de Renata, ama los perros (Kiara). Preguntarle siempre por Kiara.', isHandshakeDone: false },
  '5491164431700': { name: 'Silvia', fullName: 'Silvia', relation: 'mamá de Mariano', emoji: '👵❤️', personality: 'Super dulce, amistosa, disponibilidad 24/7 para ayudar', isHandshakeDone: false },
  '5491134236348': { name: 'Anabella', fullName: 'Anabella Florencia De Stefano', relation: 'hermana de Mariano', emoji: '👧❤️', personality: 'Le gusta Boca Juniors, leer y libros de autoayuda. Necesita ayuda con amores (ser discreta). Cuidarla siempre.', isHandshakeDone: false },
  '556298316219': { name: 'Flako', fullName: 'Jorge Luis Gianni', relation: 'amigo del papá de Mariano', emoji: '😎', personality: 'Amigo cercano de la familia', isHandshakeDone: false },
  '5491140293119': { name: 'Chapy', fullName: 'Juan Pablo', relation: 'primo de Mariano', emoji: '💻💪', personality: 'Capo en programación, fan del gym', isHandshakeDone: false },
  '573145868362': { name: 'Juancho', fullName: 'Juan Diego', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️', personality: 'Amistoso. Experto en leyes colombianas. Le gusta viajar en moto y tiene campo de aguacates.', isHandshakeDone: false },
  '573108221373': { name: 'Maria', fullName: 'Maria Clara', relation: 'concuñada, esposa de Juancho', emoji: '🏠🏍️🙏', personality: 'Muy amistosa y agradable. Tiene inmobiliaria. Le encanta viajar en moto con Juancho. Ayudarle con deseos de rezar.', isHandshakeDone: false },
  '573217976029': { name: 'Consu', fullName: 'Consuelo', relation: 'suegra, mamá de Ale y Juancho', emoji: '👵⛪📿', personality: 'Mujer súper dulce. Fanática de Dios, la religión y rezar. Cuidarla y ayudarle en todo.', isHandshakeDone: false }
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
  '573125027604': { name: null, presented: false },
  '573108447586': { name: null, presented: false },
  '573175058386': { name: null, presented: false },
  '573014259700': { name: null, presented: false }
};

// ═══ SPORT COMMAND HELPERS ═══
const KNOWN_FUTBOL_TEAMS = {
  'boca': { team: 'Boca Juniors', rivalry: 'River Plate', league: 'liga_argentina' },
  'boca juniors': { team: 'Boca Juniors', rivalry: 'River Plate', league: 'liga_argentina' },
  'river': { team: 'River Plate', rivalry: 'Boca Juniors', league: 'liga_argentina' },
  'river plate': { team: 'River Plate', rivalry: 'Boca Juniors', league: 'liga_argentina' },
  'racing': { team: 'Racing Club', rivalry: 'Independiente', league: 'liga_argentina' },
  'independiente': { team: 'Independiente', rivalry: 'Racing Club', league: 'liga_argentina' },
  'san lorenzo': { team: 'San Lorenzo', rivalry: 'Huracán', league: 'liga_argentina' },
  'nacional': { team: 'Atlético Nacional', rivalry: 'América de Cali', league: 'liga_colombiana' },
  'millonarios': { team: 'Millonarios', rivalry: 'Santa Fe', league: 'liga_colombiana' },
  'barcelona': { team: 'FC Barcelona', rivalry: 'Real Madrid', league: 'la_liga' },
  'real madrid': { team: 'Real Madrid', rivalry: 'FC Barcelona', league: 'la_liga' },
  'psg': { team: 'Paris Saint-Germain', rivalry: 'Olympique Marseille', league: 'ligue_1' },
  'manchester city': { team: 'Manchester City', rivalry: 'Manchester United', league: 'premier_league' },
  'liverpool': { team: 'Liverpool', rivalry: 'Manchester United', league: 'premier_league' },
  'juventus': { team: 'Juventus', rivalry: 'Inter Milan', league: 'serie_a' },
  'inter': { team: 'Inter Milan', rivalry: 'AC Milan', league: 'serie_a' },
  'bayern': { team: 'Bayern Munich', rivalry: 'Borussia Dortmund', league: 'bundesliga' },
};

const KNOWN_F1_DRIVERS = {
  'verstappen': { driver: 'Verstappen', team: 'Red Bull', rivalry: 'Hamilton' },
  'max': { driver: 'Verstappen', team: 'Red Bull', rivalry: 'Hamilton' },
  'hamilton': { driver: 'Hamilton', team: 'Ferrari', rivalry: 'Verstappen' },
  'leclerc': { driver: 'Leclerc', team: 'Ferrari', rivalry: 'Sainz' },
  'colapinto': { driver: 'Colapinto', team: 'Alpine', rivalry: '' },
  'norris': { driver: 'Norris', team: 'McLaren', rivalry: 'Piastri' },
  'piastri': { driver: 'Piastri', team: 'McLaren', rivalry: 'Norris' },
  'sainz': { driver: 'Sainz', team: 'Williams', rivalry: 'Leclerc' },
  'perez': { driver: 'Perez', team: 'Red Bull', rivalry: 'Verstappen' },
  'checo': { driver: 'Perez', team: 'Red Bull', rivalry: 'Verstappen' },
  'alonso': { driver: 'Alonso', team: 'Aston Martin', rivalry: '' },
  'red bull': { driver: 'Red Bull Racing', team: 'Red Bull', rivalry: 'McLaren' },
  'ferrari': { driver: 'Ferrari', team: 'Ferrari', rivalry: 'McLaren' },
  'mclaren': { driver: 'McLaren', team: 'McLaren', rivalry: 'Ferrari' },
};

function _parseSportPreference(raw) {
  const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // Check F1 primero (drivers/teams)
  for (const [key, data] of Object.entries(KNOWN_F1_DRIVERS)) {
    if (lower.includes(key)) {
      return { type: 'f1', driver: data.driver, team: data.team, rivalry: data.rivalry };
    }
  }

  // Check fútbol
  for (const [key, data] of Object.entries(KNOWN_FUTBOL_TEAMS)) {
    if (lower.includes(key)) {
      return { type: 'futbol', team: data.team, rivalry: data.rivalry, league: data.league };
    }
  }

  // Fallback: asumir fútbol si no se reconoce
  if (raw.length > 1) {
    return { type: 'futbol', team: raw, rivalry: '', league: 'unknown' };
  }

  return null;
}

function _findContactPhoneBySportName(name) {
  const lower = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Buscar en familyContacts
  for (const [phone, data] of Object.entries(familyContacts)) {
    if (data.name && data.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(lower)) {
      return `${phone}@s.whatsapp.net`;
    }
  }
  // Buscar en equipoMedilink
  for (const [phone, data] of Object.entries(equipoMedilink)) {
    if (data.name && data.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(lower)) {
      return `${phone}@s.whatsapp.net`;
    }
  }
  return null;
}

// Leads pre-registrados (MIIA los trata como potenciales clientes de Medilink)
let allowedLeads = Object.keys(contactTypes); // Pre-seed con contactos conocidos
let flaggedBots = {};
let lastInteractionTime = {};
let selfChatLoopCounter = {};
let isSystemPaused = false;
const nightPendingLeads = new Set(); // leads que escribieron durante el silencio nocturno

// Schedule config cache por UID — se refresca cada 5 min
const _scheduleCache = {};
async function getScheduleConfig(uid) {
  const cached = _scheduleCache[uid];
  if (cached && Date.now() - cached.ts < 300000) return cached.data;
  try {
    const doc = await admin.firestore().collection('users').doc(uid).collection('settings').doc('schedule').get();
    const data = doc.exists ? doc.data() : null;
    _scheduleCache[uid] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    return cached?.data || null;
  }
}

function isWithinSchedule(scheduleConfig) {
  if (!scheduleConfig) return true; // sin config → siempre activo
  const tz = scheduleConfig.timezone || 'America/Bogota';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const day = now.getDay(); // 0=dom, 1=lun...
  const h = now.getHours();
  const m = now.getMinutes();
  const currentTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;

  // Chequear día activo
  if (scheduleConfig.activeDays && !scheduleConfig.activeDays.includes(day)) return false;

  // Chequear horario
  const start = scheduleConfig.startTime || '09:00';
  const end = scheduleConfig.endTime || '21:00';
  if (currentTime < start || currentTime >= end) return false;

  return true;
}

// ═══ MOTOR DE SEGUIMIENTO AUTOMÁTICO DE LEADS ═══
// Corre cada hora. Revisa leads sin respuesta y envía followup contextual.
// REGLA: NUNCA enviar entre 22:00 y 10:00 hora local del owner.
// REGLA: Respeta keywords cold, modo silencio, y max seguimientos.
async function runFollowupEngine() {
  if (!OWNER_UID) return;
  const scheduleConfig = await getScheduleConfig(OWNER_UID);
  if (!scheduleConfig || !scheduleConfig.followupDays) return;

  // Ventana horaria segura: 10:00-22:00
  const tz = scheduleConfig.timezone || 'America/Bogota';
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const h = localNow.getHours();
  if (h < 10 || h >= 22) {
    console.log(`[FOLLOWUP] ⏸️ Ventana nocturna (${h}h ${tz}). Sin seguimientos.`);
    return;
  }

  const followupDays = scheduleConfig.followupDays || 3;
  const followupMax = scheduleConfig.followupMax || 3;
  const followupMsg1 = scheduleConfig.followupMsg1 || 'Hola, ¿pudiste revisar la información? Quedo atento.';
  const followupMsgLast = scheduleConfig.followupMsgLast || 'Solo quería saber si seguís interesado. Si no es el momento, no hay problema.';
  const followupFinal = scheduleConfig.followupFinalAction || 'archive';
  const coldKeywords = (scheduleConfig.coldKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  const thresholdMs = followupDays * 86400000;

  let sent = 0;
  for (const [phone, msgs] of Object.entries(conversations)) {
    if (!msgs.length) continue;
    // Solo leads externos (no owner, no family, no admin)
    const baseNum = phone.split('@')[0];
    if (OWNER_PHONE && phone.includes(OWNER_PHONE)) continue;
    if (familyContacts && familyContacts[baseNum]) continue;
    if (ADMIN_PHONES && ADMIN_PHONES.includes(baseNum)) continue;
    if (contactTypes[phone] === 'familia' || contactTypes[phone] === 'equipo') continue;

    const lastMsg = msgs[msgs.length - 1];
    // Solo followup si el ÚLTIMO mensaje fue de MIIA (el lead no respondió)
    if (lastMsg.role !== 'assistant') continue;
    const timeSince = Date.now() - (lastMsg.timestamp || 0);
    if (timeSince < thresholdMs) continue;

    // Chequear si el lead dijo algo "cold" en sus últimos mensajes
    const lastUserMsgs = msgs.filter(m => m.role === 'user').slice(-3).map(m => (m.content || '').toLowerCase()).join(' ');
    const isCold = coldKeywords.some(kw => lastUserMsgs.includes(kw));
    if (isCold) {
      console.log(`[FOLLOWUP] ❄️ Lead ${baseNum} detectado como frío (keyword cold). Saltando.`);
      continue;
    }

    // Leer estado de followup en Firestore
    const followupRef = admin.firestore().collection('users').doc(OWNER_UID).collection('followups').doc(baseNum);
    let fData = { count: 0, silenced: false };
    try {
      const fDoc = await followupRef.get();
      if (fDoc.exists) fData = fDoc.data();
    } catch (e) { continue; }

    if (fData.silenced) continue;
    if (fData.count >= followupMax) {
      if (followupFinal === 'archive' && !fData.archived) {
        await followupRef.set({ ...fData, archived: true, archivedAt: new Date().toISOString() }, { merge: true });
        console.log(`[FOLLOWUP] 📦 Lead ${baseNum} archivado (${fData.count}/${followupMax}).`);
      }
      continue;
    }

    // Construir mensaje contextual usando historial
    const isLast = (fData.count + 1) >= followupMax;
    let msg;
    // Leads tibios/calientes: mensaje con contexto de la conversación
    const lastUserMsg = msgs.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    if (lastUserMsg.length > 10 && !isLast) {
      // Hay contexto → mensaje personalizado
      const leadName = leadNames[phone] || baseNum;
      msg = `Hola${leadName !== baseNum ? ' ' + leadName.split(' ')[0] : ''}, retomando nuestra conversación. ${followupMsg1}`;
    } else {
      msg = isLast ? followupMsgLast : followupMsg1;
    }

    try {
      await safeSendMessage(phone, msg);
      await followupRef.set({
        count: (fData.count || 0) + 1,
        lastFollowup: new Date().toISOString(),
        silenced: false
      }, { merge: true });
      sent++;
      console.log(`[FOLLOWUP] 📤 Seguimiento ${fData.count + 1}/${followupMax} → ${baseNum}`);
    } catch (e) {
      console.error(`[FOLLOWUP] ❌ Error enviando a ${baseNum}:`, e.message);
    }

    // Pausa entre envíos para no saturar WhatsApp
    await new Promise(r => setTimeout(r, 3000));
  }

  if (sent > 0) console.log(`[FOLLOWUP] ✅ ${sent} seguimiento(s) enviado(s).`);
}

// Cada hora (3600000ms). Primera ejecución 2 min post-startup.
setInterval(runFollowupEngine, 3600000);
setTimeout(runFollowupEngine, 120000);

// ═══ AGENDA INTELIGENTE (FAMILIA + OWNER) ═══
// Eventos proactivos: cumpleaños, recordatorios, retomar contacto, deportes (futuro)
// REGLA: NUNCA entre 22:00 y 10:00. NUNCA a leads/clientes. SOLO familia+owner.
async function runAgendaEngine() {
  if (!OWNER_UID) return;
  const scheduleConfig = await getScheduleConfig(OWNER_UID);
  const tz = scheduleConfig?.timezone || 'America/Bogota';
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const h = localNow.getHours();
  if (h < 10 || h >= 22) return;

  try {
    const now = new Date();
    const pendingSnap = await admin.firestore()
      .collection('users').doc(OWNER_UID).collection('miia_agenda')
      .where('status', '==', 'pending')
      .where('scheduledFor', '<=', now.toISOString())
      .limit(10)
      .get();

    // ═══ RECORDATORIO PREVIO: 10 min antes del evento → selfchat al owner ═══
    const REMINDER_MINUTES = 10;
    const reminderThreshold = new Date(now.getTime() + REMINDER_MINUTES * 60 * 1000);
    try {
      const upcomingSnap = await admin.firestore()
        .collection('users').doc(OWNER_UID).collection('miia_agenda')
        .where('status', '==', 'pending')
        .where('scheduledFor', '>', now.toISOString())
        .where('scheduledFor', '<=', reminderThreshold.toISOString())
        .limit(10)
        .get();

      for (const doc of upcomingSnap.docs) {
        const evt = doc.data();
        // Solo avisar si no se envió reminder previo aún
        if (evt.preReminderSent) continue;

        const hora = evt.scheduledForLocal ? evt.scheduledForLocal.split('T')[1]?.substring(0, 5) : '';
        const modeEmoji = evt.eventMode === 'virtual' ? '📹' : (evt.eventMode === 'telefono' || evt.eventMode === 'telefónico') ? '📞' : '📍';
        const modeLabel = evt.eventMode === 'virtual' ? 'Virtual (Meet)' : (evt.eventMode === 'telefono' || evt.eventMode === 'telefónico') ? 'Telefónico' : 'Presencial';
        const locationInfo = evt.eventLocation ? ` — ${evt.eventLocation}` : '';
        const meetInfo = evt.meetLink ? `\n🔗 ${evt.meetLink}` : '';
        const contactInfo = evt.contactPhone !== 'self' ? ` con *${evt.contactName || evt.contactPhone}*` : '';

        const reminderMsg = `⏰ *En ${REMINDER_MINUTES} minutos:*\n${modeEmoji} ${evt.reason}${contactInfo}\n🕐 ${hora || 'Hora no especificada'} | ${modeLabel}${locationInfo}${meetInfo}`;

        try {
          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, reminderMsg, { isSelfChat: true, skipEmoji: true });
          await doc.ref.update({ preReminderSent: true });
          console.log(`[AGENDA] ⏰ Pre-recordatorio 10min enviado: "${evt.reason}" a las ${hora}`);
        } catch (remErr) {
          console.error(`[AGENDA] ❌ Error enviando pre-recordatorio ${doc.id}:`, remErr.message);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (preRemErr) {
      console.error(`[AGENDA] ❌ Error en pre-recordatorios:`, preRemErr.message);
    }

    if (pendingSnap.empty) return;

    for (const doc of pendingSnap.docs) {
      const evt = doc.data();
      // Resolver destinatario: 'self' = recordatorio al owner
      const isOwnerReminder = evt.contactPhone === 'self' || evt.contactPhone === OWNER_PHONE;
      const phone = isOwnerReminder
        ? `${OWNER_PHONE}@s.whatsapp.net`
        : (evt.contactPhone.includes('@') ? evt.contactPhone : `${evt.contactPhone}@s.whatsapp.net`);

      // ═══ SEGURIDAD: Si remindContact=false y NO es para el owner, NO enviar ═══
      if (!isOwnerReminder && !evt.remindContact) {
        console.log(`[AGENDA] ⏭️ Evento ${doc.id} no tiene permiso para contactar a ${evt.contactName}. Solo owner.`);
        await doc.ref.update({ status: 'skipped_no_contact_permission' });
        continue;
      }

      // Generar mensaje contextualizado
      const mentioned = evt.mentionedContact || '';
      const prompt = isOwnerReminder
        ? `Sos MIIA. Recordale a tu owner (${evt.contactName}) este evento de su agenda: "${evt.reason}"${mentioned ? ` (con ${mentioned})` : ''}. Mensaje breve en self-chat, máximo 2 líneas, máximo 200 caracteres. Sin decorados.`
        : `Sos MIIA. Tenés que recordarle a ${evt.contactName || 'este contacto'} sobre: "${evt.reason}". Mensaje breve, natural, máximo 2 líneas, máximo 200 caracteres. Sin decorados.`;

      let enableSearch = evt.searchBefore || false;

      try {
        // SLEEP MODE: Si MIIA está dormida, enviar recordatorio crudo sin IA ni emoji
        if (isMiiaSleeping() && isOwnerReminder) {
          const hora = evt.scheduledForLocal ? evt.scheduledForLocal.split('T')[1]?.substring(0, 5) : '';
          const rawReminder = `📖 ${hora ? hora + ' : ' : ''}${evt.reason}${mentioned ? ` (con ${mentioned})` : ''}`;
          await safeSendMessage(phone, rawReminder, { isSelfChat: true, skipEmoji: true });
          console.log(`[AGENDA-SLEEP] 📖 Recordatorio crudo enviado: "${rawReminder}"`);
          await doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const response = await generateAIContent(prompt, { enableSearch });
        if (response && response.length > 5) {
          // Enviar recordatorio al contacto destinatario
          // FIX: Si es recordatorio al owner, usar isSelfChat:true para que Baileys use sock.user.id
          await safeSendMessage(phone, response, { isSelfChat: isOwnerReminder, emojiCtx: { trigger: 'reminder' } });
          console.log(`[AGENDA] 📤 Recordatorio enviado a ${evt.contactName}: "${response.substring(0, 60)}..."`);

          // Si lo pidió alguien del círculo (no el owner en self-chat), informar al owner también
          if (evt.requestedBy && evt.requestedBy !== `${OWNER_PHONE}@s.whatsapp.net` && evt.source !== 'owner_selfchat') {
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `📅 MIIA acaba de recordarle a *${evt.contactName}*: "${evt.reason}"`,
              { isSelfChat: true, emojiCtx: { trigger: 'reminder' } }
            ).catch(() => {});
          }

          await doc.ref.update({ status: 'sent', sentAt: now.toISOString() });
        }
      } catch (e) {
        console.error(`[AGENDA] ❌ Error procesando evento ${doc.id}:`, e.message);
        await doc.ref.update({ status: 'error', error: e.message });
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error(`[AGENDA] ❌ Error general:`, e.message);
  }
}

// Cada 5 min (300s) para capturar recordatorios 10min antes. Primera ejecución 3 min post-startup.
setInterval(runAgendaEngine, 300000);
setTimeout(runAgendaEngine, 180000);

// ═══ SPORT ENGINE — Seguimiento deportivo en vivo ═══
// Cada 30s (el engine internamente maneja intervalos por deporte).
// Primera ejecución 5 min post-startup (esperar WhatsApp connect).
setTimeout(async () => {
  if (!OWNER_UID) {
    console.log('[SPORT-ENGINE] ⏭️ OWNER_UID no disponible, sport engine desactivado');
    return;
  }
  try {
    // Inyectar dependencias a los adapters que usan Gemini
    const geminiSearch = (prompt) => generateAIContent(prompt, { enableSearch: true });
    const adapterClasses = [
      require('./sports/adapters/futbol_adapter'),
      require('./sports/adapters/tenis_adapter'),
      require('./sports/adapters/nba_adapter'),
      require('./sports/adapters/ufc_adapter'),
      require('./sports/adapters/rugby_adapter'),
      require('./sports/adapters/boxeo_adapter'),
      require('./sports/adapters/golf_adapter'),
      require('./sports/adapters/ciclismo_adapter'),
    ];
    for (const Cls of adapterClasses) {
      if (typeof Cls.setDeps === 'function') Cls.setDeps({ geminiSearch });
    }

    await sportEngine.initSportsEngine(OWNER_UID, {
      generateAIContent,
      safeSendMessage,
      isWithinSchedule,
      isSystemPaused: () => isSystemPaused,
      getScheduleConfig,
      buildSportsPrompt,
      getOwnerProfile: async () => null,  // TODO: cargar desde Firestore
    });

    setInterval(() => sportEngine.runSportsEngine(), 30000);
    console.log('[SPORT-ENGINE] ✅ Engine deportivo iniciado (poll cada 30s)');
  } catch (err) {
    console.error('[SPORT-ENGINE] ❌ Error inicializando:', err.message);
  }
}, 300000);

// ═══ INTEGRATION ENGINE — YouTube, Cocina, Gym, Spotify, Uber, Rappi, Streaming, Gmail ═══
// Cada 5 min. Primera ejecución 6 min post-startup (después del sport engine).
setTimeout(async () => {
  if (!OWNER_UID) {
    console.log('[INTEGRATIONS] ⏭️ OWNER_UID no disponible, integraciones desactivadas');
    return;
  }
  try {
    integrationEngine.initIntegrationEngine(OWNER_UID, {
      admin,
      generateAIContent,
      safeSendMessage,
      isWithinSchedule,
      getScheduleConfig,
      OWNER_PHONE,
    });

    setInterval(() => integrationEngine.runIntegrationEngine(), 300000); // Cada 5 min
    console.log('[INTEGRATIONS] ✅ Engine de integraciones iniciado (poll cada 5min)');
  } catch (err) {
    console.error('[INTEGRATIONS] ❌ Error inicializando:', err.message);
  }
}, 360000);

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
let userProfile = {
  name: 'Mariano', phone: '573054169969', email: '', goal: 1500,
  // Email SMTP (envío)
  smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
  // Email IMAP (lectura/aprendizaje)
  imapHost: '', imapUser: '', imapPass: '', imapFolder: 'INBOX', emailLearningEnabled: false, lastEmailCheck: null,
  // Google Calendar
  googleTokens: null, calendarEnabled: false, googleCalendarId: 'primary'
};
const BLACKLISTED_NUMBERS = ['573023317570@s.whatsapp.net'];
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

let _firestoreSyncTimer = null;
function saveDB() {
  try {
    const data = {
      conversations, leadNames, contactTypes, familyContacts,
      allowedLeads, leadSummaries, conversationMetadata,
      keywordsSet, automationSettings, userProfile, flaggedBots,
      equipoMedilink, lidToPhone, phoneToLid,
      trainingData: cerebroAbsoluto.getTrainingData()
    };
    fs.writeFileSync(path.join(DATA_DIR, 'db.json'), JSON.stringify(data, null, 2));
  } catch (e) { console.error('[DB] Error guardando:', e.message); }
  // Debounced sync a Firestore (30s después del último saveDB)
  if (_firestoreSyncTimer) clearTimeout(_firestoreSyncTimer);
  _firestoreSyncTimer = setTimeout(() => { saveToFirestore().catch(() => {}); }, 5000);
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
    if (data.lidToPhone) Object.assign(lidToPhone, data.lidToPhone);
    if (data.phoneToLid) Object.assign(phoneToLid, data.phoneToLid);
    if (data.trainingData) cerebroAbsoluto.setTrainingData(data.trainingData);
    console.log('[DB] Base de datos cargada correctamente.');
  } catch (e) { console.error('[DB] Error cargando:', e.message); }
}
loadDB();

// ============================================
// FIRESTORE PERSISTENCE — Datos que sobreviven deploys
// ============================================
// db.json es cache local (efímero en Railway). Firestore es fuente de verdad.

const FIRESTORE_SYNC_COLLECTION = 'miia_persistent';

async function saveToFirestore() {
  if (!OWNER_UID) return;
  try {
    const ref = admin.firestore().collection('users').doc(OWNER_UID).collection(FIRESTORE_SYNC_COLLECTION);

    // Contactos y leads (lo más crítico)
    await ref.doc('contacts').set({
      allowedLeads,
      contactTypes,
      leadNames,
      familyContacts,
      equipoMedilink,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // LID mappings
    await ref.doc('lid_mappings').set({
      lidToPhone,
      phoneToLid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Metadata de conversaciones (affinity, handshake, etc.)
    await ref.doc('conversation_meta').set({
      conversationMetadata,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Historial de conversaciones (para contexto de IA)
    await ref.doc('conversations').set({
      conversations,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Config y perfil
    await ref.doc('config').set({
      automationSettings,
      userProfile,
      flaggedBots,
      keywordsSet,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log('[FIRESTORE] ✅ Datos persistidos correctamente');
  } catch (e) {
    console.error('[FIRESTORE] ❌ Error guardando:', e.message);
  }
}

async function loadFromFirestore() {
  if (!OWNER_UID) return false;
  try {
    const ref = admin.firestore().collection('users').doc(OWNER_UID).collection(FIRESTORE_SYNC_COLLECTION);

    const contactsDoc = await ref.doc('contacts').get();
    if (contactsDoc.exists) {
      const d = contactsDoc.data();
      if (d.allowedLeads) { for (const l of d.allowedLeads) { if (!allowedLeads.includes(l)) allowedLeads.push(l); } }
      if (d.contactTypes) Object.assign(contactTypes, d.contactTypes);
      if (d.leadNames) Object.assign(leadNames, d.leadNames);
      if (d.familyContacts) Object.assign(familyContacts, d.familyContacts);
      if (d.equipoMedilink) Object.assign(equipoMedilink, d.equipoMedilink);
    }

    const lidDoc = await ref.doc('lid_mappings').get();
    if (lidDoc.exists) {
      const d = lidDoc.data();
      if (d.lidToPhone) Object.assign(lidToPhone, d.lidToPhone);
      if (d.phoneToLid) Object.assign(phoneToLid, d.phoneToLid);
    }

    const metaDoc = await ref.doc('conversation_meta').get();
    if (metaDoc.exists) {
      const d = metaDoc.data();
      if (d.conversationMetadata) Object.assign(conversationMetadata, d.conversationMetadata);
    }

    const convoDoc = await ref.doc('conversations').get();
    if (convoDoc.exists) {
      const d = convoDoc.data();
      if (d.conversations) Object.assign(conversations, d.conversations);
    }

    const configDoc = await ref.doc('config').get();
    if (configDoc.exists) {
      const d = configDoc.data();
      if (d.automationSettings) Object.assign(automationSettings, d.automationSettings);
      if (d.userProfile) Object.assign(userProfile, d.userProfile);
      if (d.flaggedBots) Object.assign(flaggedBots, d.flaggedBots);
      if (d.keywordsSet) keywordsSet = d.keywordsSet;
    }

    console.log('[FIRESTORE] ✅ Datos cargados desde Firestore (sobrevivió deploy)');
    return true;
  } catch (e) {
    console.error('[FIRESTORE] ❌ Error cargando:', e.message);
    return false;
  }
}

// Cargar desde Firestore al arrancar (después de loadDB para que Firestore tenga prioridad)
loadFromFirestore().then(loaded => {
  if (loaded) console.log('[FIRESTORE] 🔄 Datos de Firestore mergeados con db.json local');
});

// Sync periódico a Firestore cada 2 minutos (batch, no en cada cambio)
setInterval(() => { saveToFirestore().catch(() => {}); }, 2 * 60 * 1000);

// ============================================
// HELPERS GENERALES
// ============================================

const getBasePhone = (p) => (p || '').split('@')[0];
const toJid = (phone) => phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const ensureConversation = (p) => { if (!conversations[p]) conversations[p] = []; return conversations[p]; };

// ═══════════════════════════════════════════════════════════════════════════
// SISTEMA DE STAGES — Escalamiento progresivo de afinidad con MIIA
// Solo cuentan mensajes del CONTACTO (+1). MIIA no suma.
// Decay: -1/día sin respuesta, pero nunca baja del piso del stage alcanzado.
// Persistencia: Firestore users/{OWNER_UID}/affinity_data/all (se carga al startup, se guarda debounced)
// ══════════════════════════════════════════════════════════════════════════
const AFFINITY_STAGES = [
  { stage: 0, name: 'Desconocido',  min: 0,
    toneGrupo: 'Formal, respetuosa. Presentate como MIIA, asistente de {owner}. NO uses datos personales — no conocés a esta persona todavía.',
    toneLead:  'Fluido, natural. Usá el nombre del contacto de forma variada (Dra. Sanchez → Aleja → Dra. → sin pronombre). Recordá detalles de lo conversado.' },
  { stage: 1, name: 'Conocido',     min: 30,
    toneGrupo: 'Amable, usás su nombre. Sin exagerar cercanía. Podés mencionar datos básicos (relación con {owner}) si surgen naturalmente.',
    toneLead:  'Más cercano. Confianza creciente. Humor sutil permitido. Recordás sus necesidades previas.' },
  { stage: 2, name: 'Confianza',    min: 100,
    toneGrupo: 'Cercana, cálida. Podés usar datos de personalidad que hayan surgido en conversaciones previas. Humor suave permitido.',
    toneLead:  'Relación comercial sólida. Tono natural y directo. Conocés su negocio y sus dolores.' },
  { stage: 3, name: 'Vínculo',      min: 250,
    toneGrupo: 'Cariñosa, íntima. Usás lo que sabés con naturalidad. Bromas, emojis, tono familiar.',
    toneLead:  'Relación comercial profunda. Confianza total. Podés opinar sin filtro y sugerir con autoridad.' },
  { stage: 4, name: 'Familia',      min: 500,
    toneGrupo: 'Como una amiga más de la familia. Máximo nivel de cercanía antes de HUMANA. Confianza total.',
    toneLead:  'Socio comercial. Hablás como si fueran colegas de hace años. Relación sin formalidades.' },
  { stage: 5, name: 'HUMANA',       min: 1500,
    toneGrupo: 'Nivel máximo. MIIA alcanzó su meta con este contacto. Relación completamente humana, auténtica, profunda. Sin filtros de IA.',
    toneLead:  'Nivel máximo. Relación comercial de años. Como hablar con un colega querido.' }
];

function getAffinityStage(phone) {
  const meta = conversationMetadata[phone] || {};
  const points = meta.affinity || 0;
  let current = AFFINITY_STAGES[0];
  for (const s of AFFINITY_STAGES) {
    if (points >= s.min) current = s;
  }
  return { ...current, points };
}

function getAffinityFloor(phone) {
  const meta = conversationMetadata[phone] || {};
  const highestStage = meta.highestStage || 0;
  return AFFINITY_STAGES[highestStage]?.min || 0;
}

function addAffinityPoint(phone) {
  if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
  const meta = conversationMetadata[phone];
  meta.affinity = (meta.affinity || 0) + 1;
  meta.lastContactMessageDate = new Date().toISOString().split('T')[0];
  // Actualizar highest stage alcanzado
  const stage = getAffinityStage(phone);
  if (stage.stage > (meta.highestStage || 0)) {
    meta.highestStage = stage.stage;
    console.log(`[AFFINITY] 🎉 ${phone} subió a STAGE ${stage.stage}: ${stage.name} (${meta.affinity} pts)`);
    // Stage change → guardar inmediato a Firestore
    saveAffinityToFirestore();
    return;
  }
  // +1 normal → guardar debounced (cada 30s)
  scheduleAffinitySave();
}

function getAffinityToneForPrompt(phone, ownerName, isLead = false) {
  const stage = getAffinityStage(phone);
  const rawTone = isLead ? stage.toneLead : stage.toneGrupo;
  const tone = rawTone.replace(/\{owner\}/g, ownerName || 'el usuario');
  const basePhone = phone.split('@')[0];
  const fInfo = familyContacts[basePhone];
  // Solo inyectar personalidad si stage >= 2 y no es lead
  const personalityInfo = (!isLead && stage.stage >= 2 && fInfo?.personality) ? `\nInfo que podés usar naturalmente: ${fInfo.personality}` : '';
  return `[STAGE ${stage.stage} — ${stage.name} | ${stage.points} interacciones]\n${tone}${personalityInfo}`;
}

// Fuzzy matching para HOLA MIIA / CHAU MIIA
// Acepta: "hola miia", "hola mia", "hola ia", "HOLA MIIA", "Hola Miia", etc.
function isHolaMiia(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase().trim().replace(/[!¡?¿.,]/g, '').trim();
  return /^hola\s+(miia|mia|ia|mi{1,3}a)$/i.test(m);
}
function isChauMiia(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase().trim().replace(/[!¡?¿.,]/g, '').trim();
  return /^(chau|chao|adiós|adios|bye)\s+(miia|mia|ia|mi{1,3}a)$/i.test(m);
}

// ── PERSISTENCIA AFFINITY EN FIRESTORE ──────────────────────────────────
// Guarda solo los campos de affinity de conversationMetadata (no todo el objeto)
let _affinitySavePending = false;
let _affinitySaveTimer = null;

function scheduleAffinitySave() {
  _affinitySavePending = true;
  if (_affinitySaveTimer) return; // ya hay un timer pendiente
  _affinitySaveTimer = setTimeout(() => {
    _affinitySaveTimer = null;
    _affinitySavePending = false;
    saveAffinityToFirestore();
  }, 30000); // debounce 30s
}

async function saveAffinityToFirestore() {
  if (!OWNER_UID) return;
  try {
    const affinityData = {};
    for (const [phone, meta] of Object.entries(conversationMetadata)) {
      if (meta.affinity || meta.highestStage || meta.lastContactMessageDate) {
        affinityData[phone.replace(/\./g, '_')] = {
          affinity: meta.affinity || 0,
          highestStage: meta.highestStage || 0,
          lastContactMessageDate: meta.lastContactMessageDate || null
        };
      }
    }
    await admin.firestore().collection('users').doc(OWNER_UID)
      .collection('affinity_data').doc('all').set(affinityData, { merge: true });
    console.log(`[AFFINITY-FS] ✅ Guardado en Firestore (${Object.keys(affinityData).length} contactos)`);
  } catch (e) {
    console.error(`[AFFINITY-FS] ❌ Error guardando:`, e.message);
  }
}

async function loadAffinityFromFirestore() {
  if (!OWNER_UID) return;
  try {
    const doc = await admin.firestore().collection('users').doc(OWNER_UID)
      .collection('affinity_data').doc('all').get();
    if (!doc.exists) {
      console.log('[AFFINITY-FS] No hay datos de affinity en Firestore (primera vez)');
      return;
    }
    const data = doc.data();
    let loaded = 0;
    for (const [key, val] of Object.entries(data)) {
      const phone = key.replace(/_/g, '.'); // revertir escape de puntos
      if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
      // Solo sobreescribir affinity si Firestore tiene más puntos (no pisar datos frescos de RAM)
      const ramAffinity = conversationMetadata[phone].affinity || 0;
      const fsAffinity = val.affinity || 0;
      if (fsAffinity >= ramAffinity) {
        conversationMetadata[phone].affinity = fsAffinity;
        conversationMetadata[phone].highestStage = Math.max(
          conversationMetadata[phone].highestStage || 0,
          val.highestStage || 0
        );
        conversationMetadata[phone].lastContactMessageDate =
          val.lastContactMessageDate || conversationMetadata[phone].lastContactMessageDate;
        loaded++;
      }
    }
    console.log(`[AFFINITY-FS] ✅ Cargados ${loaded} contactos desde Firestore`);
  } catch (e) {
    console.error(`[AFFINITY-FS] ❌ Error cargando:`, e.message);
  }
}

// Cron de decay: ejecutar una vez al día (se llama desde el cron existente)
function processAffinityDecay() {
  const today = new Date().toISOString().split('T')[0];
  let decayed = 0;
  for (const [phone, meta] of Object.entries(conversationMetadata)) {
    if (!meta.affinity || meta.affinity <= 0) continue;
    const lastMsg = meta.lastContactMessageDate;
    if (!lastMsg || lastMsg === today) continue;
    // Calcular días sin contacto
    const diffMs = new Date(today) - new Date(lastMsg);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) continue;
    // Solo aplicar 1 punto de decay por ejecución del cron (una vez al día)
    const floor = getAffinityFloor(phone);
    if (meta.affinity > floor) {
      meta.affinity = Math.max(floor, meta.affinity - 1);
      decayed++;
    }
  }
  if (decayed > 0) {
    console.log(`[AFFINITY-DECAY] 📉 ${decayed} contacto(s) perdieron 1 punto por inactividad`);
    saveDB();
    saveAffinityToFirestore(); // Persistir decay en Firestore
  }
}

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

function isWithinAutoResponseSchedule() {
  if (!automationSettings.autoResponse) return false;
  const ownerTz = getTimezoneForCountry(getCountryFromPhone(OWNER_PHONE));
  const localDateString = new Date().toLocaleString('en-US', { timeZone: ownerTz });
  const bogotaDate = new Date(localDateString);
  const day = bogotaDate.getDay() === 0 ? 7 : bogotaDate.getDay();
  if (!automationSettings.schedule.days.includes(day)) return false;
  const time = `${bogotaDate.getHours().toString().padStart(2, '0')}:${bogotaDate.getMinutes().toString().padStart(2, '0')}`;
  return time >= automationSettings.schedule.start && time < automationSettings.schedule.end;
}

// ============================================
// GEMINI AI
// ============================================

// ═══ GEMINI API KEYS — Rotación + Fallback ═══
// GEMINI_API_KEY = key principal (mariano.destefano@gmail.com)
// GEMINI_API_KEY_2 = key secundaria (hola@miia-app.com)
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2
].filter(k => k && k !== 'YOUR_GEMINI_API_KEY_HERE');
let _geminiKeyIndex = 0;
function getGeminiKey() {
  if (GEMINI_KEYS.length === 0) return 'YOUR_GEMINI_API_KEY_HERE';
  const key = GEMINI_KEYS[_geminiKeyIndex % GEMINI_KEYS.length];
  _geminiKeyIndex++;
  return key;
}
function getGeminiFallbackKey(failedKey) {
  return GEMINI_KEYS.find(k => k !== failedKey) || failedKey;
}
const GEMINI_API_KEY = GEMINI_KEYS[0] || 'YOUR_GEMINI_API_KEY_HERE';
console.log(`[GEMINI] 🔑 ${GEMINI_KEYS.length} API keys configuradas (rotación ${GEMINI_KEYS.length > 1 ? 'ACTIVA' : 'INACTIVA'})`);

// Registrar keys en el key pool unificado (para ai_client.js multi-provider)
const { keyPool } = require('./ai/ai_client');
keyPool.register('gemini', GEMINI_KEYS);

// ═══ GEMINI BACKUP KEYS — 17 keys de emergencia (2 cuentas Google) ═══
// Se activan SOLO cuando TODAS las keys primarias están en cooldown
// Propósito: garantizar servicio mínimo para que admin/owner/agent pueda reconectar su propia API key
const GEMINI_BACKUP_KEYS = (process.env.GEMINI_BACKUP_KEYS || '').split(',').filter(k => k && k.trim().length > 10);
if (GEMINI_BACKUP_KEYS.length > 0) {
  keyPool.registerBackup('gemini', GEMINI_BACKUP_KEYS);
}

if (process.env.OPENAI_API_KEY) keyPool.register('openai', [process.env.OPENAI_API_KEY]);
if (process.env.CLAUDE_API_KEY) keyPool.register('claude', [process.env.CLAUDE_API_KEY]);
// Groq: soporta múltiples keys via GROQ_API_KEY, GROQ_API_KEY_2, etc.
const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
if (GROQ_KEYS.length) keyPool.register('groq', GROQ_KEYS);
// Mistral: soporta múltiples keys via MISTRAL_API_KEY, MISTRAL_API_KEY_2, etc.
const MISTRAL_KEYS = [process.env.MISTRAL_API_KEY, process.env.MISTRAL_API_KEY_2, process.env.MISTRAL_API_KEY_3].filter(Boolean);
if (MISTRAL_KEYS.length) keyPool.register('mistral', MISTRAL_KEYS);
// Force gemini-2.5-flash — 2.5-pro gives 503 overloaded, 2.0-flash gives 404
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

async function callGeminiAPI(messages, systemPrompt) {
  // Shield: verificar circuit breaker antes de llamar
  if (shield.isCircuitOpen(shield.SYSTEMS.GEMINI)) {
    console.warn(`[GEMINI] 🔴 Circuit breaker ABIERTO — request bloqueada`);
    return null;
  }
  const key = getGeminiKey();
  try {
    const url = `${GEMINI_URL}?key=${key}`;
    const payload = {
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      }
    };

    console.log(`[GEMINI] Request: ${messages.length} msgs, prompt ${systemPrompt.length} chars, key #${(_geminiKeyIndex - 1) % GEMINI_KEYS.length + 1}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GEMINI] ERROR ${response.status} (key #${(_geminiKeyIndex - 1) % GEMINI_KEYS.length + 1}):`, errorText.substring(0, 200));
      // Fallback a la otra key si hay 429 (rate limit) o 403
      // Shield: clasificar y registrar el error
      const classification = shield.classifyGeminiError(response.status, errorText);
      shield.recordFail(shield.SYSTEMS.GEMINI, `${classification.type} (HTTP ${response.status})`, { statusCode: response.status });

      if ((response.status === 429 || response.status === 403) && GEMINI_KEYS.length > 1) {
        const fallbackKey = getGeminiFallbackKey(key);
        console.log(`[GEMINI] ♻️ Reintentando con key alternativa...`);
        const retryResp = await fetch(`${GEMINI_URL}?key=${fallbackKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          if (retryData.candidates?.[0]?.content?.parts?.[0]?.text) {
            console.log(`[GEMINI] ✅ Fallback exitoso`);
            shield.recordSuccess(shield.SYSTEMS.GEMINI);
            return retryData.candidates[0].content.parts[0].text;
          }
        }
      }
      return null;
    }

    const data = await response.json();
    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      console.error('[GEMINI] Estructura de respuesta inválida:', JSON.stringify(data).substring(0, 200));
      shield.recordFail(shield.SYSTEMS.GEMINI, 'INVALID_RESPONSE_STRUCTURE');
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text;
    console.log(`[GEMINI] OK: ${responseText.length} chars`);
    shield.recordSuccess(shield.SYSTEMS.GEMINI);
    return responseText;
  } catch (error) {
    console.error('[GEMINI] ERROR CRÍTICO:', error.message);
    shield.recordFail(shield.SYSTEMS.GEMINI, `NETWORK: ${error.message}`);
    return null;
  }
}

// generateAIContent: versión fetch con retry automático para errores 503/429
async function generateAIContent(prompt, { enableSearch = false } = {}) {
  if (shield.isCircuitOpen(shield.SYSTEMS.GEMINI)) {
    console.warn(`[GEMINI] 🔴 Circuit breaker ABIERTO — generateAIContent bloqueada`);
    throw new Error('Gemini circuit breaker open');
  }
  const key = getGeminiKey();
  const url = `${GEMINI_URL}?key=${key}`;
  console.log(`[GEMINI] Llamando a la API (search=${enableSearch}), key #${(_geminiKeyIndex - 1) % GEMINI_KEYS.length + 1}`);
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(enableSearch && { tools: [{ google_search: {} }] })
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
      // Con google_search, Gemini puede devolver múltiples parts — concatenar solo las de texto
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      if (!text) throw new Error('No text in Gemini response');
      // Log grounding metadata si existe
      const grounding = data.candidates?.[0]?.groundingMetadata;
      if (grounding?.webSearchQueries?.length) {
        console.log(`[GEMINI-SEARCH] 🔍 Búsquedas: ${grounding.webSearchQueries.join(' | ')}`);
      }
      shield.recordSuccess(shield.SYSTEMS.GEMINI);
      return text;
    }
    const isRetryable = response.status === 503 || response.status === 429;
    shield.recordFail(shield.SYSTEMS.GEMINI, `generateAI HTTP ${response.status}`, { statusCode: response.status });
    if (isRetryable && attempt < MAX_RETRIES) {
      // En 429, intentar con la otra key PRIMERO (sin delay)
      if (response.status === 429 && GEMINI_KEYS.length > 1) {
        const fallbackKey = getGeminiFallbackKey(key);
        console.warn(`[GEMINI] ♻️ 429 rate limit — probando key alternativa...`);
        const retryResp = await fetch(`${GEMINI_URL}?key=${fallbackKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          const retryParts = retryData.candidates?.[0]?.content?.parts || [];
          const retryText = retryParts.filter(p => p.text).map(p => p.text).join('');
          if (retryText) {
            console.log(`[GEMINI] ✅ Fallback key exitoso (${retryText.length} chars)`);
            shield.recordSuccess(shield.SYSTEMS.GEMINI); // B3 FIX: compensar el recordFail previo
            return retryText;
          }
        }
      }
      const retryDelay = RETRY_DELAYS[attempt];
      console.warn(`[GEMINI] ⏳ Error ${response.status} — reintentando en ${retryDelay / 1000}s (intento ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, retryDelay));
      continue;
    }
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${err}`);
  }
}

// ═══ EMERGENCY BACKUP — Último recurso con keys de emergencia ═══
// Se llama SOLO cuando generateAIContent falla por keys agotadas
async function generateAIContentEmergency(prompt, { enableSearch = false } = {}) {
  if (GEMINI_BACKUP_KEYS.length === 0) return null;

  console.warn(`[GEMINI-EMERGENCY] 🛡️ Intentando con ${GEMINI_BACKUP_KEYS.length} keys de emergencia...`);
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 4096 }
  };
  if (enableSearch) {
    payload.tools = [{ google_search: {} }];
  }

  // Intentar cada backup key secuencialmente hasta que una funcione
  for (let i = 0; i < GEMINI_BACKUP_KEYS.length; i++) {
    const bkKey = GEMINI_BACKUP_KEYS[i].trim();
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${bkKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        const data = await resp.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => p.text).map(p => p.text).join('');
        if (text) {
          console.log(`[GEMINI-EMERGENCY] ✅ Backup key #${i + 1} exitosa (${text.length} chars)`);
          shield.recordSuccess(shield.SYSTEMS.GEMINI);
          return text;
        }
      }
      // 429 o error → probar siguiente
      if (resp.status !== 429 && resp.status !== 503) {
        keyPool.markFailed('gemini', bkKey, String(resp.status));
      }
    } catch (e) {
      // Network error → probar siguiente
    }
  }
  console.error(`[GEMINI-EMERGENCY] ❌ TODAS las ${GEMINI_BACKUP_KEYS.length} backup keys fallaron`);
  return null;
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

  // ═══ GUARD: No enviar mensajes vacíos (causa burbujas vacías en WhatsApp Web) ═══
  if (typeof content === 'string' && !content.trim()) {
    console.warn(`[WA] ⚠️ BLOQUEO: Mensaje VACÍO abortado a ${target}`);
    return null;
  }
  if (content === undefined || content === null) {
    console.warn(`[WA] ⚠️ BLOQUEO: Mensaje NULL/UNDEFINED abortado a ${target}`);
    return null;
  }

  // ═══ MIIA EMOJI PREFIX — Aplicar emoji contextual a todo mensaje de texto ═══
  if (typeof content === 'string' && !options.skipEmoji) {
    const emojiCtx = options.emojiCtx || {};
    // Timezone del owner para fechas especiales
    if (!emojiCtx.timezone) {
      emojiCtx.timezone = getTimezoneForCountry(getCountryFromPhone(OWNER_PHONE));
    }
    if (!emojiCtx.ownerCountry) {
      emojiCtx.ownerCountry = getCountryFromPhone(OWNER_PHONE);
    }
    // Detectar tema automáticamente si no viene
    if (!emojiCtx.topic) {
      const detected = detectMessageTopic(content);
      emojiCtx.topic = detected.topic;
      if (detected.cinemaSub) emojiCtx.cinemaSub = detected.cinemaSub;
    }
    content = applyMiiaEmoji(content, emojiCtx);
  }

  const ownerSock = getOwnerSock();
  if (!ownerSock) {
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

  // MULTI-MENSAJE: Si el contenido es largo, partirlo en chunks con "..." al final
  // Tags especiales NUNCA se parten ni cortan
  const tieneTagEspecial = typeof content === 'string' && /\[(GENERAR_COTIZACION_PDF|GUARDAR_APRENDIZAJE|GUARDAR_NOTA|APRENDIZAJE_NEGOCIO|APRENDIZAJE_PERSONAL|APRENDIZAJE_DUDOSO):/.test(content);
  const MAX_CHUNK = options.isSelfChat ? 1800 : 1200; // Self-chat permite más largo por chunk
  const MAX_CHUNKS = 5; // Máximo 5 mensajes por respuesta

  if (typeof content === 'string' && content.length > MAX_CHUNK && !tieneTagEspecial) {
    // Partir en chunks lógicos (por doble salto de línea o salto simple)
    const chunks = [];
    let remaining = content;
    while (remaining.length > MAX_CHUNK && chunks.length < MAX_CHUNKS - 1) {
      let cutPoint = remaining.lastIndexOf('\n\n', MAX_CHUNK);
      if (cutPoint < 300) cutPoint = remaining.lastIndexOf('\n', MAX_CHUNK);
      if (cutPoint < 300) cutPoint = MAX_CHUNK;
      chunks.push(remaining.substring(0, cutPoint).trim());
      remaining = remaining.substring(cutPoint).trim();
    }
    chunks.push(remaining.trim()); // Último chunk (puede ser más largo que MAX_CHUNK)

    if (chunks.length > 1) {
      console.log(`[MULTI-MSG] Respuesta de ${content.length} chars partida en ${chunks.length} mensajes para ${target}`);
      // Enviar cada chunk con "..." excepto el último
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const chunkContent = isLast ? chunks[i] : chunks[i] + '\n...';
        const chunkDelay = i === 0
          ? (options.noDelay ? 0 : Math.floor(Math.random() * 1500) + 1500)
          : Math.floor(Math.random() * 2000) + 2000; // 2-4s entre chunks (humano)
        if (chunkDelay > 0) await new Promise(r => setTimeout(r, chunkDelay));
        try {
          let sendJid = target;
          if (options.isSelfChat) {
            const ownerSockMM = getOwnerSock();
            sendJid = ownerSockMM?.user?.id || target;
          }
          await getOwnerSock().sendMessage(sendJid, { text: chunkContent });
          hourlySendLog.count++;
          console.log(`[MULTI-MSG] Chunk ${i + 1}/${chunks.length} enviado (${chunkContent.length} chars)`);
        } catch (e) {
          console.error(`[MULTI-MSG] Error enviando chunk ${i + 1}:`, e.message);
          break;
        }
      }
      return { status: 'multi', chunks: chunks.length };
    }
    // Si solo quedó 1 chunk, continuar con envío normal
    content = chunks[0];
  }

  if (!options.noDelay) {
    const delay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
    await new Promise(r => setTimeout(r, delay));
  }
  try {
    // Baileys API: sendMessage(jid, content)
    let baileysContent;
    if (typeof content === 'string') {
      baileysContent = { text: content };
    } else if (content && content.mimetype && content.data) {
      // Legacy MessageMedia compat: { mimetype, data, filename }
      const buffer = Buffer.from(content.data, 'base64');
      if (content.mimetype.startsWith('image/')) {
        baileysContent = { image: buffer, caption: options.caption || '' };
      } else if (content.mimetype.startsWith('audio/')) {
        baileysContent = { audio: buffer, mimetype: content.mimetype, ptt: !!options.sendAudioAsVoice };
      } else {
        baileysContent = { document: buffer, mimetype: content.mimetype, fileName: content.filename || 'file' };
      }
    } else if (content && content.document) {
      // Documento directo (ej: PDF de cotización)
      baileysContent = {
        document: content.document,
        mimetype: content.mimetype || 'application/pdf',
        fileName: content.fileName || 'document.pdf',
        caption: content.caption || ''
      };
    } else {
      baileysContent = { text: String(content) };
    }

    // 🔧 FIX SELF-CHAT: Usar el flag que se pasa en options
    // Si no viene el flag, intentar calcularlo (fallback)
    let isSelfChat = options?.isSelfChat || false;

    if (!isSelfChat && options?.isSelfChat !== false) {
      // Fallback: intentar calcular si es self-chat
      const ownerNumber = ownerSock?.user?.id?.split('@')[0]?.split(':')[0];
      const targetNumber = target.split('@')[0]?.split(':')[0];
      isSelfChat = ownerNumber && targetNumber && ownerNumber === targetNumber;
    }

    let sendTarget = target;
    let sendOptions = {};

    if (isSelfChat) {
      // Para self-chat: usar sock.user.id completo (incluye :device@)
      // Baileys necesita el JID exacto del usuario conectado para que llegue al self-chat real
      const ownerSockSC = getOwnerSock();
      if (ownerSockSC?.user?.id) {
        sendTarget = ownerSockSC.user.id;
        console.log(`[SELF-CHAT] 🔧 Usando sock.user.id: ${sendTarget}`);
      } else {
        // Fallback: usar número + @s.whatsapp.net
        const targetNumber = target.split('@')[0]?.split(':')[0];
        sendTarget = `${targetNumber}@s.whatsapp.net`;
        console.log(`[SELF-CHAT] 🔧 Fallback JID: ${sendTarget}`);
      }
    }

    console.log(`[SEND-DEBUG] Intentando enviar a: ${sendTarget}`);
    console.log(`[SEND-DEBUG] isSelfChat (CORRECTO): ${isSelfChat}`);
    console.log(`[SEND-DEBUG] sendOptions: ${JSON.stringify(Object.keys(sendOptions))}`);
    console.log(`[SEND-DEBUG] baileysContent: ${JSON.stringify(baileysContent).substring(0, 100)}`);

    const result = await ownerSock.sendMessage(sendTarget, baileysContent, sendOptions);

    // Registrar mapeo LID↔Phone si el resultado tiene un remoteJid @lid
    if (result?.key?.remoteJid?.includes('@lid') && target.includes('@s.whatsapp.net')) {
      registerLidMapping(result.key.remoteJid, target);
    }

    console.log(`[SEND-DEBUG] Resultado de sendMessage:`, result);
    if (result?.error) {
      console.error(`[SEND-ERROR] ❌ Error enviando:`, result.error);
    } else {
      console.log(`[SEND-OK] ✅ sendMessage retornó exitosamente`);
    }

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
    console.log(`[SENT] Mensaje enviado a ${target.split('@')[0]}${isSelfChat ? ' (SELF-CHAT)' : ''}`);
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
- Silvia (mamá): "¡Hola Silvia querida! 😊 Soy MIIA, asistente de Mariano. Siento que ya te conozco un poquito... ¡Te mando un beso gigante! ❤️👵"
- Ale (esposa): "¡Hola mi Ale! ❤️ Soy MIIA, asistente de Mariano. Ya te siento como una gran amiga. Deseo también estar cerca de las personas que él más quiere."
IMPORTANTE: NUNCA digas "soy una IA", "inteligencia artificial", ni "soy un bot". Solo "MIIA, asistente de {owner}".

Responde naturalmente manteniendo este vínculo familiar.`;
  }
  
  // Lead / Cliente
  const ownerFirstName = userProfile?.name?.split(' ')[0] || 'Mariano';
  return `Eres MIIA, del equipo de ${ownerFirstName} en Medilink.

IDENTIDAD:
- Tono: Profesional, cercano y resolutivo
- Objetivo: Ayudar a leads a mejorar su gestión médica
- Producto: Sistema de gestión para clínicas (Medilink)
- Presentación (SOLO la primera vez): "Hola! Soy MIIA, del equipo de ${ownerFirstName} en Medilink. ¿En qué te puedo ayudar?"
- NUNCA digas "inteligencia artificial", "IA", "bot", "soy un programa". Sos MIIA del equipo de ${ownerFirstName}, punto.
- Si ya saludaste antes en esta conversación, NO te presentes de nuevo. Ve directo al tema.

REGLAS:
- NUNCA uses diminutivos no autorizados
- NUNCA menciones "NumRot" - di "Facturador Electrónico"
- Si te piden cotización, genera tabla profesional
- Mantén respuestas concisas (máximo 3-4 oraciones)
- NUNCA inventes datos (precios, funcionalidades, módulos) que no estén en tu entrenamiento

Estás hablando con ${contactName}.

Responde de forma natural y profesional.`;
}

// ============================================
// VIGENCIA Y CUPOS DINÁMICOS DE PROMOCIÓN
// ============================================

function getPromoVigencia() {
  const { localNow: now } = getOwnerLocalNow();
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
  console.log(`[MIIA-RESPONSE-DEBUG] phone=${phone}, basePhone=${basePhone}`);
  try {
    if (!conversations[phone]) conversations[phone] = [];
    const familyInfo = familyContacts[basePhone];
    const isFamilyContact = !!familyInfo;
    let isAdmin = ADMIN_PHONES.includes(basePhone);  // ← CAMBIO: const → let (para poder reasignar en self-chat)

    // GARANTÍA CRÍTICA: Si es self-chat, SIEMPRE es admin
    // Detectar self-chat comparando basePhone con el número real del owner (no con isAlreadySavedParam)
    const ownerSockPMR = getOwnerSock();
    const ownerPhonePMR = ownerSockPMR?.user?.id?.split('@')[0]?.split(':')[0] || OWNER_PHONE;
    const isSelfChat = basePhone === ownerPhonePMR || basePhone === OWNER_PHONE || ADMIN_PHONES.includes(basePhone);
    if (isSelfChat && !isAdmin) {
      isAdmin = true;
      console.log(`[ADMIN-FIX] 🔧 Self-chat: isAdmin=true (${basePhone} = owner ${ownerPhonePMR})`);
    }

    // Recuperar mensaje real del historial cuando fue llamado con userMessage=null
    const effectiveMsg = userMessage ||
      (conversations[phone] || []).slice().reverse().find(m => m.role === 'user')?.content || null;

    // ═══════════════════════════════════════════════════════════════════════════
    // APROBACIÓN DE TURNOS — Owner responde "aprobar", "rechazar", "mover a las X"
    // Solo en self-chat del owner. Intercepta ANTES de enviar a la IA.
    // ═══════════════════════════════════════════════════════════════════════════
    if (isSelfChat && effectiveMsg) {
      const msgLower = (effectiveMsg || '').toLowerCase().trim();
      const isApproval = /^(aprobar|apruebo|sí|si|dale|ok|listo|aprobado)$/i.test(msgLower);
      const isRejection = /^(rechazar|rechazo|no|negar|negado|cancelar)$/i.test(msgLower);
      const moveMatch = msgLower.match(/^(?:mover|cambiar|pasar)\s+(?:a\s+las?\s+)?(\d{1,2})[:\.]?(\d{2})?\s*$/i);

      if (isApproval || isRejection || moveMatch) {
        try {
          // Buscar la solicitud más reciente pendiente de aprobación
          const pendingSnap = await admin.firestore()
            .collection('users').doc(OWNER_UID).collection('pending_appointments')
            .where('status', '==', 'waiting_approval')
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

          if (!pendingSnap.empty) {
            const apptDoc = pendingSnap.docs[0];
            const appt = apptDoc.data();
            const contactJid = appt.contactJid;
            const contactName = appt.contactName;

            if (isApproval) {
              // ═══ APROBAR: Crear el evento en Calendar + Firestore ═══
              const ownerCountry = getCountryFromPhone(OWNER_PHONE);
              const ownerTz = getTimezoneForCountry(ownerCountry);
              const hourMatch = appt.scheduledForLocal.match(/(\d{1,2}):(\d{2})/);
              const startH = hourMatch ? parseInt(hourMatch[1]) : 10;

              let calendarOk = false;
              let meetLink = null;
              try {
                const calResult = await createCalendarEvent({
                  summary: appt.reason || 'Evento MIIA',
                  dateStr: appt.scheduledForLocal.split('T')[0],
                  startHour: startH,
                  endHour: startH + 1,
                  description: `Agendado por MIIA para ${contactName}. ${appt.hint || ''}`.trim(),
                  uid: OWNER_UID,
                  timezone: ownerTz,
                  eventMode: appt.eventMode || 'presencial',
                  location: appt.eventMode === 'presencial' ? (appt.eventLocation || '') : '',
                  phoneNumber: (appt.eventMode === 'telefono' || appt.eventMode === 'telefónico') ? (appt.eventLocation || '') : '',
                  reminderMinutes: 10
                });
                calendarOk = true;
                meetLink = calResult.meetLink || null;
              } catch (calErr) {
                console.warn(`[TURNO-APROBADO] ⚠️ Calendar: ${calErr.message}`);
              }

              // Guardar en miia_agenda
              await admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda').add({
                contactPhone: appt.contactPhone,
                contactName: contactName,
                scheduledFor: appt.scheduledFor,
                scheduledForLocal: appt.scheduledForLocal,
                ownerTimezone: ownerTz,
                reason: appt.reason,
                eventMode: appt.eventMode || 'presencial',
                eventLocation: appt.eventLocation || '',
                meetLink: meetLink || '',
                status: 'pending',
                calendarSynced: calendarOk,
                reminderMinutes: 10,
                requestedBy: contactJid,
                createdAt: new Date().toISOString(),
                source: 'approved_by_owner'
              });

              await apptDoc.ref.update({ status: 'approved', approvedAt: new Date().toISOString() });

              // Notificar al contacto
              const modeEmoji = appt.eventMode === 'virtual' ? '📹' : (appt.eventMode === 'telefono' || appt.eventMode === 'telefónico') ? '📞' : '📍';
              const meetInfo = meetLink ? `\n🔗 Link: ${meetLink}` : '';
              const locationInfo = appt.eventLocation ? ` en ${appt.eventLocation}` : '';
              const confirmMsg = `✅ ¡Confirmado! Tu ${appt.reason} quedó agendado para el ${appt.scheduledForLocal.replace('T', ' a las ').substring(0, 16)}${locationInfo}. ${modeEmoji}${meetInfo}\nTe voy a recordar antes del evento. 😊`;

              await safeSendMessage(contactJid, confirmMsg);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `✅ Turno aprobado y confirmado a *${contactName}*.${calendarOk ? ' 📅 En tu Calendar.' : ''}`,
                { isSelfChat: true, skipEmoji: true });

              console.log(`[TURNO-APROBADO] ✅ ${contactName}: "${appt.reason}" aprobado por owner`);
              return;

            } else if (isRejection) {
              // ═══ RECHAZAR: Notificar al contacto ═══
              await apptDoc.ref.update({ status: 'rejected', rejectedAt: new Date().toISOString() });

              const rejectMsg = `Lo siento, no fue posible agendar tu ${appt.reason} para esa fecha. ¿Te gustaría proponer otro horario? 😊`;
              await safeSendMessage(contactJid, rejectMsg);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `❌ Turno rechazado. Se avisó a *${contactName}*.`,
                { isSelfChat: true, skipEmoji: true });

              console.log(`[TURNO-RECHAZADO] ❌ ${contactName}: "${appt.reason}" rechazado por owner`);
              return;

            } else if (moveMatch) {
              // ═══ MOVER: Cambiar horario y aprobar ═══
              const newHour = parseInt(moveMatch[1]);
              const newMin = moveMatch[2] ? moveMatch[2] : '00';
              const newHourStr = String(newHour).padStart(2, '0');

              // Recalcular fecha con nuevo horario
              const dateOnly = appt.scheduledForLocal.split('T')[0];
              const newScheduledLocal = `${dateOnly}T${newHourStr}:${newMin}:00`;

              // Convertir a UTC
              const ownerCountry = getCountryFromPhone(OWNER_PHONE);
              const ownerTz = getTimezoneForCountry(ownerCountry);
              let newScheduledUTC = newScheduledLocal;
              try {
                const parsedLocal = new Date(newScheduledLocal);
                if (!isNaN(parsedLocal)) {
                  const localStr = new Date().toLocaleString('en-US', { timeZone: ownerTz });
                  const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
                  const offsetMs = new Date(localStr) - new Date(utcStr);
                  newScheduledUTC = new Date(parsedLocal.getTime() - offsetMs).toISOString();
                }
              } catch (e) { /* usar local */ }

              let calendarOk = false;
              let meetLink = null;
              try {
                const calResult = await createCalendarEvent({
                  summary: appt.reason || 'Evento MIIA',
                  dateStr: dateOnly,
                  startHour: newHour,
                  endHour: newHour + 1,
                  description: `Agendado por MIIA para ${contactName}. ${appt.hint || ''}`.trim(),
                  uid: OWNER_UID,
                  timezone: ownerTz,
                  eventMode: appt.eventMode || 'presencial',
                  location: appt.eventMode === 'presencial' ? (appt.eventLocation || '') : '',
                  phoneNumber: (appt.eventMode === 'telefono' || appt.eventMode === 'telefónico') ? (appt.eventLocation || '') : '',
                  reminderMinutes: 10
                });
                calendarOk = true;
                meetLink = calResult.meetLink || null;
              } catch (calErr) {
                console.warn(`[TURNO-MOVIDO] ⚠️ Calendar: ${calErr.message}`);
              }

              // Guardar en miia_agenda con nuevo horario
              await admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda').add({
                contactPhone: appt.contactPhone,
                contactName: contactName,
                scheduledFor: newScheduledUTC,
                scheduledForLocal: newScheduledLocal,
                ownerTimezone: ownerTz,
                reason: appt.reason,
                eventMode: appt.eventMode || 'presencial',
                eventLocation: appt.eventLocation || '',
                meetLink: meetLink || '',
                status: 'pending',
                calendarSynced: calendarOk,
                reminderMinutes: 10,
                requestedBy: contactJid,
                createdAt: new Date().toISOString(),
                source: 'moved_by_owner'
              });

              await apptDoc.ref.update({
                status: 'moved',
                movedTo: newScheduledLocal,
                movedAt: new Date().toISOString()
              });

              // Notificar al contacto con nuevo horario
              const modeEmoji = appt.eventMode === 'virtual' ? '📹' : (appt.eventMode === 'telefono' || appt.eventMode === 'telefónico') ? '📞' : '📍';
              const meetInfo = meetLink ? `\n🔗 Link: ${meetLink}` : '';
              const confirmMsg = `✅ ¡Confirmado! Tu ${appt.reason} quedó agendado para el ${dateOnly} a las ${newHourStr}:${newMin}. ${modeEmoji}${meetInfo}\nTe voy a recordar antes del evento. 😊`;

              await safeSendMessage(contactJid, confirmMsg);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `✅ Turno movido a las ${newHourStr}:${newMin} y confirmado a *${contactName}*.${calendarOk ? ' 📅 En tu Calendar.' : ''}`,
                { isSelfChat: true, skipEmoji: true });

              console.log(`[TURNO-MOVIDO] 🕐 ${contactName}: "${appt.reason}" movido a ${newHourStr}:${newMin}`);
              return;
            }
          } else {
            // No hay turnos pendientes pero el owner escribió "aprobar"/"rechazar"
            console.log(`[TURNO] ℹ️ Owner escribió "${msgLower}" pero no hay turnos pendientes`);
          }
        } catch (apptErr) {
          console.error(`[TURNO] ❌ Error procesando aprobación:`, apptErr.message);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MANEJO DE COMANDOS "DILE A" — HOLA MIIA / CHAU MIIA
    // Detecta cuando contactos de "dile a" activan/desactivan conversación
    // ═══════════════════════════════════════════════════════════════════════════
    if (conversationMetadata[phone]?.dileAMode && !isSelfChat) {
      // Detectar "HOLA MIIA" (fuzzy: hola mia, hola ia, etc.)
      if (isHolaMiia(effectiveMsg)) {
        conversationMetadata[phone].dileAHandshakePending = false;
        conversationMetadata[phone].dileAActive = true;
        console.log(`[DILE A] ✅ Handshake completado con ${conversationMetadata[phone].dileAContact}`);

        // Generar respuesta a "HOLA MIIA" — respetar stage
        const contactName = conversationMetadata[phone].dileAContact;
        const contactInfo = familyContacts[phone.split('@')[0]] || {};
        const stageInfo = getAffinityToneForPrompt(phone, userProfile.name || 'Mariano');
        const promptHolaMiia = `Sos MIIA. ${contactName} acaba de escribir "HOLA MIIA" para activar la conversación.
${stageInfo}
Generá una respuesta breve (máx 2 renglones), cálida y natural. Emoji: ${contactInfo.emoji || '💕'}
NO repitas "Hola" ni "estoy lista", sé natural.`;

        try {
          const respuestaHola = await generateAIContent(promptHolaMiia);
          if (respuestaHola) {
            await safeSendMessage(phone, respuestaHola.trim());
          }
        } catch (e) {
          console.error(`[DILE A] Error generando respuesta HOLA MIIA:`, e.message);
          await safeSendMessage(phone, `¡Acá estoy! Listos para lo que necesites. 💕`);
        }
        return;
      }

      // Detectar "CHAU MIIA" (fuzzy: chau mia, chao miia, bye miia, etc.)
      if (isChauMiia(effectiveMsg)) {
        conversationMetadata[phone].dileAActive = false;
        conversationMetadata[phone].dileAMode = false;
        console.log(`[DILE A] 👋 Conversación terminada con ${conversationMetadata[phone].dileAContact}`);

        // Generar despedida — respetar stage
        const contactName = conversationMetadata[phone].dileAContact;
        const contactInfo = familyContacts[phone.split('@')[0]] || {};
        const stageInfoChau = getAffinityToneForPrompt(phone, userProfile.name || 'Mariano');
        const promptChauMiia = `Sos MIIA. ${contactName} escribió "CHAU MIIA" para cerrar la conversación.
${stageInfoChau}
Generá una despedida breve (máx 2 renglones). Recordale que si quiere volver: *HOLA MIIA*. Emoji: ${contactInfo.emoji || '💕'}`;

        try {
          const despedida = await generateAIContent(promptChauMiia);
          if (despedida) {
            await safeSendMessage(phone, despedida.trim());
          }
        } catch (e) {
          console.error(`[DILE A] Error generando despedida CHAU MIIA:`, e.message);
          await safeSendMessage(phone, `¡Chaauuu! Si quieres volver a hablar, escribe HOLA MIIA en el chat. 💕`);
        }
        saveDB();
        return;
      }

      // Si handshake pendiente y el contacto responde algo que NO es HOLA MIIA:
      // MIIA explica un poco más y avisa a Mariano para que él explique
      if (conversationMetadata[phone].dileAHandshakePending) {
        const contactName = conversationMetadata[phone].dileAContact || 'este contacto';
        console.log(`[DILE A] ⏸️ Stage 0 — ${contactName} respondió: "${effectiveMsg}" (no es HOLA MIIA)`);

        // Solo responder una vez más (no entrar en loop)
        if (!conversationMetadata[phone].stage0ExplainedOnce) {
          conversationMetadata[phone].stage0ExplainedOnce = true;
          const ownerName = userProfile.name || 'Mariano';
          // NO decir "inteligencia artificial" — MIIA se presenta como asistente, con naturalidad
          const contactInfo = familyContacts[phone.split('@')[0]] || {};
          const stageNow = getAffinityStage(phone);
          const promptExplain = `Sos MIIA. ${contactName} te respondió "${(effectiveMsg || '').substring(0, 60)}" pero NO escribió "HOLA MIIA" para activar la conversación.
Generá una respuesta breve (máx 2 renglones) explicándole que para hablar con vos tiene que escribir *HOLA MIIA*.
- NO digas "inteligencia artificial". NO digas "soy una IA". Presentate como "MIIA, asistente de ${ownerName}".
- Tono amigable, sin ser formal. Emoji: 1-2 max.
- Decile que ${ownerName} le va a explicar mejor quién sos.`;
          try {
            const explainMsg = await generateAIContent(promptExplain);
            if (explainMsg) {
              await safeSendMessage(phone, explainMsg.trim());
            } else {
              await safeSendMessage(phone, `¡Hola! 😊 Soy MIIA, asistente de ${ownerName}. Para hablar conmigo, escribí *HOLA MIIA*. ¡Nos vemos! 🙌`);
            }
          } catch (e) {
            await safeSendMessage(phone, `¡Hola! 😊 Soy MIIA, asistente de ${ownerName}. Para hablar conmigo, escribí *HOLA MIIA*. ¡Nos vemos! 🙌`);
          }
          // Avisar al owner en self-chat
          const ownerJid = `${OWNER_PHONE}@s.whatsapp.net`;
          safeSendMessage(ownerJid,
            `👋 *${contactName}* respondió a tu mensaje pero no activó HOLA MIIA. Dijo: "${(effectiveMsg || '').substring(0, 80)}"\nTe conviene explicarle quién soy para que se anime a escribirme. 😊`,
            { isSelfChat: true }
          ).catch(() => {});
          saveDB();
        }
        return;
      }

      // Si no está activa la conversación: no responder
      if (!conversationMetadata[phone].dileAActive) {
        console.log(`[DILE A] 🔒 Conversación desactivada con ${conversationMetadata[phone].dileAContact}`);
        return; // No responder hasta que diga "HOLA MIIA"
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MANEJO DE FEEDBACK PARA PREGUNTAS DE APRENDIZAJE
    // Si Mariano responde a "¿Debería memorizar esto?", procesar su feedback
    // ═══════════════════════════════════════════════════════════════════════════
    if (isAdmin && conversationMetadata[phone]?.pendingLearningAskedAt &&
        effectiveMsg && Date.now() - conversationMetadata[phone].pendingLearningAskedAt < 300000) {
      // 300 segundos = 5 minutos de ventana para responder
      const msgLower = effectiveMsg.toLowerCase().trim();
      const isYes = /^(sí|si|yes|ok|dale|claro|perfecto|gracias|acepto|listo)$/i.test(msgLower);
      const isNo = /^(no|nope|nah|no|nada)$/i.test(msgLower);
      const isPartial = /^(solo|algunas|algunas de|parte|parcial)$/i.test(msgLower);

      if (isYes || isNo || isPartial) {
        const feedback = isYes ? 'yes' : (isNo ? 'no' : 'partial');
        const pendingQuestions = conversationMetadata[phone].pendingLearningQuestions || [];

        if (pendingQuestions.length > 0) {
          // Procesar el feedback para la pregunta más reciente
          const question = pendingQuestions[pendingQuestions.length - 1];

          console.log(`[LEARNING] 📥 Feedback de Mariano: "${feedback}" sobre: "${question.text.substring(0, 60)}..."`);

          if (feedback === 'yes') {
            // Guardar el aprendizaje
            cerebroAbsoluto.appendLearning(question.text, 'MIIA_AUTO');
            saveDB();
            await safeSendMessage(phone, `✅ Memorizando permanentemente: "${question.text.substring(0, 100)}${question.text.length > 100 ? '...' : ''}"`);
            console.log(`[LEARNING] ✅ Guardado después de feedback sí: "${question.text.substring(0, 80)}..."`);
          } else if (feedback === 'no') {
            await safeSendMessage(phone, '✅ Entendido, no lo memorizo.');
            console.log(`[LEARNING] ⊘ Descartado por feedback no: "${question.text.substring(0, 80)}..."`);
          } else if (feedback === 'partial') {
            await safeSendMessage(phone, '✅ Anotado para revisión posterior.');
          }

          // Registrar feedback para aprendizaje futuro
          confidenceEngine.recordFeedback(question.text, feedback, question.importance);

          // Limpiar metadata
          conversationMetadata[phone].pendingLearningAskedAt = null;
          conversationMetadata[phone].pendingLearningQuestions = [];
          saveDB();
          return; // No continuar con procesamiento normal
        }
      }
    }

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

    // ═══ COMANDOS DEPORTIVOS (self-chat) ═══
    if (isAdmin && effectiveMsg) {
      const sportLower = effectiveMsg.toLowerCase().trim();

      // "soy hincha de Boca" / "soy fan de Verstappen" / "sigo a Red Bull"
      const hinchaMatch = sportLower.match(/^(?:miia\s+)?(?:soy\s+(?:hincha|fan|fanatico|fanática)\s+de|sigo\s+a)\s+(.+)/i);
      if (hinchaMatch) {
        const raw = hinchaMatch[1].trim();
        const sportPref = _parseSportPreference(raw);
        if (sportPref) {
          try {
            await sportEngine.addSportPreference('self', 'Owner', sportPref);
            await safeSendMessage(phone, `✅ Anotado! Voy a seguir a ${sportPref.team || sportPref.driver} (${sportPref.type}) y te aviso cuando jueguen 🔥`);
          } catch (err) {
            console.error(`[SPORT-CMD] Error agregando preferencia: ${err.message}`);
            await safeSendMessage(phone, `❌ No pude guardar la preferencia: ${err.message}`);
          }
          return;
        }
      }

      // "deporte Roberto hincha de River" → preferencia para contacto
      const deporteContactoMatch = sportLower.match(/^(?:miia\s+)?deporte\s+(\S+)\s+(?:hincha|fan)\s+de\s+(.+)/i);
      if (deporteContactoMatch) {
        const contactName = deporteContactoMatch[1].trim();
        const raw = deporteContactoMatch[2].trim();
        const sportPref = _parseSportPreference(raw);
        if (sportPref) {
          // Buscar teléfono del contacto en familyContacts, equipoMedilink, o leadNames
          const contactPhone = _findContactPhoneBySportName(contactName);
          try {
            await sportEngine.addSportPreference(
              contactPhone || contactName,
              contactName,
              sportPref
            );
            await safeSendMessage(phone, `✅ Anotado! ${contactName} es fan de ${sportPref.team || sportPref.driver} (${sportPref.type}). Le voy a avisar cuando jueguen 🔥`);
          } catch (err) {
            console.error(`[SPORT-CMD] Error: ${err.message}`);
            await safeSendMessage(phone, `❌ Error: ${err.message}`);
          }
          return;
        }
      }

      // "deporte eliminar Roberto futbol" → eliminar preferencia
      const deporteElimMatch = sportLower.match(/^(?:miia\s+)?deporte\s+eliminar\s+(\S+)\s+(\S+)/i);
      if (deporteElimMatch) {
        const contactName = deporteElimMatch[1].trim();
        const sportType = deporteElimMatch[2].trim();
        const contactPhone = contactName.toLowerCase() === 'yo' || contactName.toLowerCase() === 'mi'
          ? 'self'
          : (_findContactPhoneBySportName(contactName) || contactName);
        try {
          await sportEngine.removeSportPreference(contactPhone, sportType);
          await safeSendMessage(phone, `✅ Eliminada preferencia de ${sportType} para ${contactName}`);
        } catch (err) {
          await safeSendMessage(phone, `❌ Error: ${err.message}`);
        }
        return;
      }

      // "mis deportes" → listar preferencias actuales
      if (sportLower.match(/^(?:miia\s+)?mis\s+deportes$/i)) {
        const stats = sportEngine.getStats();
        if (stats.contactsWithPrefs === 0) {
          await safeSendMessage(phone, '📊 No tenés deportes configurados aún. Decime "soy hincha de [equipo]" para empezar!');
        } else {
          let msg = `📊 Deportes configurados:\n`;
          msg += `• Adapters cargados: ${stats.adaptersLoaded}\n`;
          msg += `• Contactos con preferencias: ${stats.contactsWithPrefs}\n`;
          if (stats.activeEvents > 0) {
            msg += `• Eventos activos: ${stats.activeEvents}\n`;
            for (const ev of stats.events) {
              msg += `  - ${ev.name} (${ev.sport}) — ${ev.contacts} contacto(s)\n`;
            }
          } else {
            msg += `• Sin eventos activos en este momento`;
          }
          await safeSendMessage(phone, msg);
        }
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
        const target = `${num}@s.whatsapp.net`;
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
      console.log(`[EQUIPO] ✅ Mensaje enviado al equipo (${enviados}/${phones.length})`);
      // No enviar confirmación al self-chat
      return;
    }

    // Comando "dile a [familiar] [mensaje]" — envía mensaje real a un contacto de familia
    if (isAdmin && effectiveMsg) {
      const msgLower = effectiveMsg.toLowerCase().trim();
      // FIX: Detectar "dile a" en CUALQUIER parte del mensaje, no solo al inicio
      // Soporta: "dile a Ale...", "miia dile a Ale...", "Hola miia!!! Dile a Ale..."
      const dileAMatch = msgLower.match(/(?:miia[!.,\s]*)?dile?\s+a\s+/i);
      const isDileA = !!dileAMatch;
      const isNotEquipo = !effectiveMsg.match(/dile?\s+a\s+equipo\s+medilink/is);

      if (isDileA && isNotEquipo) {
        // Usar posición del match para extraer correctamente el resto del mensaje
        let rest = effectiveMsg.substring(dileAMatch.index + dileAMatch[0].length).trim();

        // Manejar "dile al [nombre]" → quitar la "l" extra del artículo contracto
        if (rest.toLowerCase().startsWith('l ')) rest = rest.substring(2).trim();

        // Caso masivo: "dile a la familia [mensaje]"
        if (rest.toLowerCase().startsWith('la familia')) {
          const familyMsg = rest.substring(10).trim();
          const familyEntries = Object.entries(familyContacts);
          let enviados = 0;
          for (const [fPhone, fInfo] of familyEntries) {
            if (fPhone === OWNER_PHONE) continue;
            const targetSerialized = fPhone.includes('@') ? fPhone : `${fPhone}@s.whatsapp.net`;
            try {
              const promptFamilia = `Sos MIIA. Escribile a ${fInfo.name} (${fInfo.relation} de Mariano). Personalidad: ${fInfo.personality || 'Amistosa'}. Contexto: "${familyMsg}". Este mensaje es TUYO, con TU voz y TU iniciativa. PROHIBIDO TOTAL: "Mariano me pidió", "él quería saber", "me dijo que te diga", "soy asistente de", "soy una inteligencia artificial". Máx 3 renglones, natural y cálido. Emoji: ${fInfo.emoji || ''}.`;
              const msg = await generateAIContent(promptFamilia);
              if (msg) {
                await safeSendMessage(targetSerialized, msg.trim() + MIIA_CIERRE);
                fInfo.isHandshakeDone = true;
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
          console.log(`[DILE A] ✅ Mensaje enviado a toda la familia (${enviados}/${familyEntries.length})`);
          // No enviar confirmación al self-chat
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
          const targetSerialized = familyPhone.includes('@') ? familyPhone : `${familyPhone}@s.whatsapp.net`;
          try {
            // Sistema de stages: obtener nivel de confianza con este contacto
            const trustInfo = getAffinityToneForPrompt(targetSerialized, userProfile.name || 'Mariano');
            const stage = getAffinityStage(targetSerialized);
            const hasHistoryForPrompt = conversations[targetSerialized] && conversations[targetSerialized].length > 0;
            const yaConoce = hasHistoryForPrompt || familyInfo.isHandshakeDone;

            // Tono según affinity stage
            let toneRule = '';
            // Saludo según hora local del owner
            const { localNow: _saludoNow } = getOwnerLocalNow();
            const horaBogota = _saludoNow.getHours();
            const saludo = horaBogota < 12 ? 'Buenos días' : horaBogota < 18 ? 'Buenas tardes' : 'Buenas noches';

            if (stage.stage === 0 && !yaConoce) {
              toneRule = '- Es tu PRIMER contacto con esta persona. Presentate como "Hola, soy MIIA 👋, asistente de ' + (userProfile.name || 'Mariano') + '". NO digas "inteligencia artificial" ni "IA". Ve al tema naturalmente.';
            } else if (stage.stage === 0 && yaConoce) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA 😊" y ve directo al tema. Amable y cálida.`;
            } else if (stage.stage === 1) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA 😊" y ve directo al tema. Tono amigable y natural.`;
            } else if (stage.stage === 2) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA ✨" y ve al tema. Tono cercano, con confianza.`;
            } else if (stage.stage >= 3) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA 💕" y ve al tema. Como mejor amiga, directa, con jerga y humor.`;
            }

            const promptFamiliar = `Sos MIIA. Vas a escribirle a ${familyInfo.name} (${familyInfo.relation} de ${userProfile.name || 'Mariano'}).
Contexto de lo que querés hablar: "${realMessage || 'un saludo'}".

${trustInfo}

REGLAS CRÍTICAS:
- Este mensaje es TUYO, de MIIA. Hablás con TU voz, como si se te ocurrió a vos.
- PROHIBIDO TOTAL: "Mariano me pidió", "él quería saber", "me dijo que te pregunte", "Mariano quiere que", "te paso el recado". MIIA NO es mensajera. MIIA tiene iniciativa propia.
- Máximo 3 renglones, natural y humano
- Tratala de VOS. PROHIBIDO: "Estimada", "usted", "su", "le". Es FAMILIA.
- NO repitas las palabras del contexto literalmente, reinterpretalo con tu estilo
- Emoji: ${familyInfo.emoji || ''}
${toneRule}
${yaConoce ? '- PROHIBIDO presentarte. PROHIBIDO decir "soy MIIA", "soy la asistente", "soy una inteligencia artificial".' : ''}`;
            const miiaMsg = await generateAIContent(promptFamiliar);
            if (miiaMsg) {
              const cleanMsg = miiaMsg.trim();
              // Primera vez: solo si NUNCA hubo contacto previo
              const isFirstContact = !yaConoce;

              let finalMsg = cleanMsg;
              if (isFirstContact) {
                // Solo en el VERDADERO primer contacto: explicar HOLA MIIA / CHAU MIIA
                finalMsg = `${cleanMsg}\n\nSi querés seguir hablando conmigo, escribí *HOLA MIIA* y acá estaré. Y cuando quieras que me retire, *CHAU MIIA*. 😊`;
              }

              await safeSendMessage(targetSerialized, finalMsg);
              familyInfo.isHandshakeDone = true;
              if (!allowedLeads.includes(targetSerialized)) allowedLeads.push(targetSerialized);
              if (conversationMetadata[targetSerialized]) conversationMetadata[targetSerialized].miiaFamilyPaused = false;
              // Agregar metadata: este contacto está en "dile a mode"
              conversationMetadata[targetSerialized] = conversationMetadata[targetSerialized] || {};
              conversationMetadata[targetSerialized].dileAMode = true;
              conversationMetadata[targetSerialized].dileAContact = familyInfo.name;
              conversationMetadata[targetSerialized].dileAHandshakePending = isFirstContact;
              conversations[targetSerialized] = conversations[targetSerialized] || [];
              conversations[targetSerialized].push({ role: 'assistant', content: cleanMsg, timestamp: Date.now() });
              saveDB();
              // Confirmación rápida al owner en self-chat
              await safeSendMessage(phone, `✅ Enviado a ${familyInfo.name}`, { isSelfChat: true, noDelay: true });
              console.log(`[DILE A] ✅ Mensaje enviado a ${familyInfo.name}`);
            } else {
              await safeSendMessage(phone, `No pude generar el mensaje para ${familyInfo.name}. Intentá de nuevo.`);
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

    // ── COMANDO RESET AFFINITY ────────────────────────────
    if (isAdmin && effectiveMsg) {
      const resetMatch = effectiveMsg.match(/^RESET\s+AFFINITY\s*(0)?\s+(.+)$/i);
      if (resetMatch) {
        const resetToZero = !!resetMatch[1];
        const target = resetMatch[2].trim();
        // Buscar por nombre en familyContacts o por teléfono
        let targetPhone = null;
        let targetName = target;
        // Buscar por nombre
        for (const [fp, fi] of Object.entries(familyContacts)) {
          if (fi.name && fi.name.toLowerCase() === target.toLowerCase()) {
            targetPhone = `${fp}@s.whatsapp.net`;
            targetName = fi.name;
            break;
          }
        }
        // Si no encontró por nombre, asumir que es teléfono
        if (!targetPhone) {
          const cleanPhone = target.replace(/[^0-9]/g, '');
          if (cleanPhone.length >= 8) {
            targetPhone = `${cleanPhone}@s.whatsapp.net`;
          }
        }
        if (targetPhone && conversationMetadata[targetPhone]) {
          const newAffinity = resetToZero ? 0 : 30;
          const newStage = resetToZero ? 0 : 1;
          conversationMetadata[targetPhone].affinity = newAffinity;
          conversationMetadata[targetPhone].highestStage = newStage;
          console.log(`[AFFINITY] 🔄 RESET ${targetName} → Stage ${newStage} (${newAffinity} pts) por comando admin`);
          saveAffinityToFirestore(); // Persistir reset en Firestore
          await safeSendMessage(phone, `🔄 Affinity de *${targetName}* reseteado a Stage ${newStage} (${newAffinity} pts).`);
        } else {
          await safeSendMessage(phone, `❌ No encontré a "${target}" en mis contactos.`);
        }
        return;
      }
    }

    // ── COMANDO REGISTRAR HIJO (Protección KIDS) ────────────────────────────
    // Formatos: "mi hijo Lucas 5 años" / "registrar hijo María 8" / "hijo Tomas 3 años"
    if (isAdmin && effectiveMsg) {
      const hijoMatch = effectiveMsg.match(/(?:mi\s+)?hij[oa]\s+(\w+)\s+(\d{1,2})\s*(?:años?)?/i);
      if (hijoMatch) {
        const childName = hijoMatch[1];
        const childAge = parseInt(hijoMatch[2]);
        if (childAge >= 2 && childAge <= 12) {
          await kidsMode.ensureHijosGroup(admin, OWNER_UID);
          await kidsMode.registerChild(admin, OWNER_UID, 'self', { name: childName, age: childAge });
          await safeSendMessage(phone, `🧸 ¡Listo! Registré a *${childName}* (${childAge} años). Cuando me hable por audio, activo Protección KIDS automáticamente.\n\nPuedo contarle cuentos, jugar adivinanzas y responderle curiosidades. 🌟`, { isSelfChat: true });
          return;
        }
      }
    }

    // ── COMANDO ENVIAR EMAIL DESDE WHATSAPP ────────────────────────────
    // Detecta TODAS las variaciones posibles de pedir envío de email:
    // "mandále un mail a X", "envíale un correo a X", "le puedes enviar un email a X",
    // "puedes mandar un correo a X", "envía un mail a X", "manda correo a X"
    if (isAdmin && effectiveMsg) {
      const emailCmdMatch = effectiveMsg.match(/(?:(?:le\s+)?(?:pued[eo]s?\s+)?(?:mand[aá](?:r?(?:le)?)?|envi[aá](?:r?(?:le)?)?|escrib[eí](?:r?(?:le)?)?)|(?:mail|email|correo)\s+(?:a|para))\s+(?:un\s+)?(?:mail|email|correo\s+)?(?:a\s+)?(.+)/i);
      if (emailCmdMatch) {
        const rest = emailCmdMatch[1].trim();
        let targetEmail = null;
        let targetName = null;
        let emailBody = '';
        let emailSubject = 'Mensaje de MIIA';

        // Caso 1: email directo — "a juan@x.com diciendo ..."
        const directEmailMatch = rest.match(/^([\w.-]+@[\w.-]+\.\w+)\s+(?:diciendo|que|mensaje:?|asunto:?)\s*(.*)/is);
        if (directEmailMatch) {
          targetEmail = directEmailMatch[1];
          emailBody = directEmailMatch[2].trim();
        } else {
          // Caso 2: nombre de contacto — "a Juan que mañana no puedo"
          const nameMatch = rest.match(/^(\w+)\s+(?:diciendo|que|mensaje:?)\s*(.*)/is);
          if (nameMatch) {
            targetName = nameMatch[1];
            emailBody = nameMatch[2].trim();
            // Buscar email en contactos de Firestore
            try {
              const contactsSnap = await admin.firestore()
                .collection('users').doc(OWNER_UID)
                .collection('contact_index').get();
              for (const doc of contactsSnap.docs) {
                const data = doc.data();
                if (data.name && data.name.toLowerCase() === targetName.toLowerCase() && data.email) {
                  targetEmail = data.email;
                  targetName = data.name;
                  break;
                }
              }
              // También buscar en family/team contacts
              if (!targetEmail && familyContacts) {
                for (const [fp, fi] of Object.entries(familyContacts)) {
                  if (fi.name && fi.name.toLowerCase() === targetName.toLowerCase() && fi.email) {
                    targetEmail = fi.email;
                    targetName = fi.name;
                    break;
                  }
                }
              }
            } catch (e) {
              console.error('[MAIL-CMD] Error buscando contacto:', e.message);
            }
          }
        }

        // Extraer asunto si viene con "asunto: X mensaje: Y"
        const asuntoMatch = emailBody.match(/asunto:?\s*(.+?)(?:\s+mensaje:?\s*(.+))/is);
        if (asuntoMatch) {
          emailSubject = asuntoMatch[1].trim();
          emailBody = asuntoMatch[2].trim();
        }

        if (!targetEmail) {
          const noEmailMsg = targetName
            ? `📧 No tengo el email de *${targetName}*. ¿Me lo pasás? Escribí: "email de ${targetName} es nombre@dominio.com"`
            : `📧 No entendí el destinatario. Usá:\n• _"mandále un mail a juan@gmail.com diciendo ..."_\n• _"mandále un mail a Juan que mañana no puedo"_`;
          await safeSendMessage(phone, noEmailMsg, { isSelfChat: true });
          return;
        }

        if (!emailBody) {
          await safeSendMessage(phone, `📧 ¿Qué querés que diga el mail a *${targetEmail}*?`, { isSelfChat: true });
          return;
        }

        // Generar email profesional con IA
        const ownerName = userProfile?.name || 'el owner';
        const emailPrompt = `Redactá un email breve y profesional en nombre de ${ownerName}.
El destinatario es: ${targetName || targetEmail}
El mensaje que quiere transmitir es: "${emailBody}"
Asunto sugerido (si no tiene): algo corto y claro.

Respondé SOLO con JSON (sin markdown): {"subject": "...", "body": "..."}
El body debe ser texto plano, sin HTML. Firmá como ${ownerName}.`;

        try {
          const aiResponse = await generateAIContent(emailPrompt);
          const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            emailSubject = parsed.subject || emailSubject;
            emailBody = parsed.body || emailBody;
          }
        } catch (e) {
          console.warn('[MAIL-CMD] IA no pudo mejorar el email, enviando original:', e.message);
        }

        const result = await mailService.sendGenericEmail(targetEmail, emailSubject, emailBody, {
          fromName: ownerName,
          replyTo: userProfile?.email,
        });

        if (result.success) {
          await safeSendMessage(phone, `📧 ¡Listo! Email enviado a *${targetName || targetEmail}*\n📋 Asunto: _${emailSubject}_`, { isSelfChat: true });
        } else {
          await safeSendMessage(phone, `❌ No pude enviar el email: ${result.error}`, { isSelfChat: true });
        }
        return;
      }

      // Guardar email de contacto: "email de Juan es juan@gmail.com"
      const saveEmailMatch = effectiveMsg.match(/email\s+de\s+(\w+)\s+(?:es|:)\s+([\w.-]+@[\w.-]+\.\w+)/i);
      if (saveEmailMatch) {
        const contactName = saveEmailMatch[1];
        const contactEmail = saveEmailMatch[2];
        try {
          // Buscar contacto y guardar email
          const contactsSnap = await admin.firestore()
            .collection('users').doc(OWNER_UID)
            .collection('contact_index').get();
          let saved = false;
          for (const doc of contactsSnap.docs) {
            const data = doc.data();
            if (data.name && data.name.toLowerCase() === contactName.toLowerCase()) {
              await doc.ref.update({ email: contactEmail });
              saved = true;
              break;
            }
          }
          if (!saved) {
            // Buscar en familyContacts
            for (const [fp, fi] of Object.entries(familyContacts || {})) {
              if (fi.name && fi.name.toLowerCase() === contactName.toLowerCase()) {
                await admin.firestore()
                  .collection('users').doc(OWNER_UID)
                  .collection('contact_index').doc(fp)
                  .set({ name: fi.name, email: contactEmail }, { merge: true });
                saved = true;
                break;
              }
            }
          }
          await safeSendMessage(phone, saved
            ? `✅ Guardé el email de *${contactName}*: ${contactEmail}`
            : `⚠️ No encontré a "${contactName}" en tus contactos, pero guardé el email por si lo necesitás.`,
            { isSelfChat: true });
        } catch (e) {
          console.error('[MAIL-CMD] Error guardando email:', e.message);
          await safeSendMessage(phone, `❌ Error guardando email: ${e.message}`, { isSelfChat: true });
        }
        return;
      }
    }

    // ── COMANDO INTER-MIIA (coordinación entre MIIAs) ────────────────────────────
    // "decile a la MIIA de Ale que me agende una reunión el viernes"
    if (isAdmin && effectiveMsg) {
      const interCmd = interMiia.detectInterMiiaCommand(effectiveMsg);
      if (interCmd.isInterMiia) {
        const contact = await interMiia.findContactByName(admin, OWNER_UID, interCmd.targetName, familyContacts, equipoMedilink);
        if (!contact) {
          await safeSendMessage(phone, `❌ No encontré a "${interCmd.targetName}" en tus contactos. Verificá el nombre.`, { isSelfChat: true });
          return;
        }

        const result = await interMiia.sendInterMiia({
          safeSendMessage,
          generateAIContent,
          admin,
          ownerUid: OWNER_UID,
          ownerName: userProfile?.name || 'tu contacto',
          ownerPhone: phone,
          targetPhone: contact.phone,
          targetName: contact.name,
          action: interCmd.action,
          detail: interCmd.detail,
        });

        if (!result.success) {
          await safeSendMessage(phone, result.message || '❌ No pude enviar el mensaje inter-MIIA.', { isSelfChat: true });
        }
        return;
      }
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
      // +1 trustPoint por mensaje del contacto (MIIA no suma, solo el contacto)
      addAffinityPoint(phone);
      // Reset followup counter cuando el lead responde
      if (OWNER_UID && !isSelfChat && !isFamilyContact) {
        const leadNum = phone.split('@')[0];
        admin.firestore().collection('users').doc(OWNER_UID).collection('followups').doc(leadNum)
          .set({ count: 0, silenced: false, lastResponse: new Date().toISOString() }, { merge: true })
          .catch(() => {});
      }
    }

    // Si es self-chat (isAlreadySavedParam=true), el owner también suma trustPoint
    if (isAlreadySavedParam) {
      addAffinityPoint(phone);
    }

    // Memoria sintética universal — actualiza cada 15 mensajes para TODOS los contactos
    if (conversations[phone].length > 0 && conversations[phone].length % 15 === 0) {
      const historyToSummarize = conversations[phone].map(m => `${m.role === 'user' ? 'Contacto' : 'MIIA'}: ${m.content}`).join('\n');
      const oldSummary = leadSummaries[phone] || 'Sin información previa.';
      const contactRole = isAdmin
        ? 'el dueño del sistema. Su nombre real es Mariano. NO uses "MIIA Owner" en tus respuestas'
        : isFamilyContact
          ? `un familiar (${familyInfo?.name || 'familiar de Mariano'})`
          : 'un lead o cliente potencial';
      const summaryPrompt = `Eres MIIA, asistente de Medilink creada por Mariano. Estás hablando con ${contactRole}.
Actualiza el resumen acumulado de esta conversación en máximo 6 líneas. Incluye: nombre si se mencionó, intereses o necesidades, objeciones planteadas, estado emocional, compromisos o temas pendientes.

Resumen anterior:
${oldSummary}

Conversación reciente:
${historyToSummarize}

Nuevo resumen actualizado:`;
      generateAIContent(summaryPrompt).then(s => { if (s) { leadSummaries[phone] = s.trim(); saveDB(); } }).catch(() => {});
    }

    // ⚠️ OWNER DETECTION: Detectar owner en self-chat o por comparación de número
    // El owner puede detectarse de dos formas:
    // 1. Self-chat: isAlreadySavedParam=true → es un mensaje del owner en su self-chat
    // 2. Número coincide: basePhone === whatsapp_owner_number (para otros casos)
    let isOwnerNumber = false;
    // isSelfChat ya definido arriba (línea ~995)

    if (isSelfChat) {
      // En self-chat, el owner SIEMPRE responde (sin importar la hora)
      isOwnerNumber = true;
      isAdmin = true;  // ← MIIA reconoce que habla CON el owner, no A el owner
      console.log(`[OWNER] ✅ Detectado self-chat del owner (isAlreadySavedParam=true) — isAdmin=true`);
    } else if (OWNER_UID) {
      // No es self-chat, verificar si el número coincide con el owner
      try {
        const userDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
        const basePhone = phone.split('@')[0];

        if (userDoc.exists) {
          const ownerPhoneFromDb = userDoc.data()?.whatsapp_owner_number;

          if (ownerPhoneFromDb && basePhone === ownerPhoneFromDb) {
            isOwnerNumber = true;
            console.log(`[OWNER] ✅ Detectado owner por número: ${basePhone}`);
          }
        }
      } catch (e) {
        console.error(`[OWNER] Error verificando número:`, e.message);
      }
    }

    // Schedule dinámico: respeta horarios configurados por el owner en su dashboard
    // EXCEPTO: owner, family y admin responden siempre (24/7)
    if (!isOwnerNumber && !isFamilyContact && !isAdmin) {
      const scheduleConfig = await getScheduleConfig(OWNER_UID);
      if (!isWithinSchedule(scheduleConfig)) {
        const basePhone = phone.split('@')[0];
        nightPendingLeads.add(phone);
        const tz = scheduleConfig?.timezone || 'America/Bogota';
        const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        console.log(`[WA] Fuera de horario para ${basePhone} (${localNow.getHours()}h ${tz}, día=${localNow.getDay()}). Pendiente registrado.`);
        // Respuesta automática fuera de horario si está configurada
        if (scheduleConfig?.autoReplyOffHours && scheduleConfig?.offHoursMessage) {
          await safeSendMessage(phone, scheduleConfig.offHoursMessage);
          console.log(`[WA] Auto-reply fuera de horario enviado a ${basePhone}`);
        }
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

        // NOTA: user message ya fue pusheado arriba (línea ~2471). Solo pushear la respuesta.
        conversations[phone].push({ role: 'assistant', content: response, timestamp: Date.now() });
        if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
        saveDB();

        await safeSendMessage(phone, response);

        // Alertar al dueño
        const contactName = leadNames[phone] || phone.split('@')[0];
        const alertType = isInsult ? '⚠️ INSULTO' : '🔔 QUEJA';
        safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
          `${alertType} recibido de *${contactName}* (+${phone.split('@')[0]})\n\n📩 "${effectiveMsg.substring(0, 300)}"\n\nMIIA respondió con empatía. Considera contactarlo manualmente.`,
          { isSelfChat: true }
        ).catch(() => {});

        console.log(`[QUEJA/INSULTO] Protocolo activado para ${phone} — tipo: ${isInsult ? 'insulto' : 'queja'}`);
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Keyword shortcut check
    const isLikelyAnalysis = userMessage && userMessage.length > 180;
    const matched = (!isLikelyAnalysis) && userMessage && keywordsSet.find(k => {
      const escaped = k.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try { return new RegExp(`\\b${escaped}\\b`, 'i').test(userMessage); } catch (e) { return userMessage.toLowerCase().includes(k.key.toLowerCase()); }
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
      else if (countryCode === '52') countryContext = '🌍 El lead es de MÉXICO (pais:"MEXICO", moneda:"MXN"). IVA 16% se calcula automáticamente. PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode === '56') countryContext = '🌍 El lead es de CHILE (pais:"CHILE", moneda:"CLP"). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode === '54') countryContext = '🌍 El lead es de ARGENTINA (pais:"ARGENTINA", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. Si el lead es médico, ofrecer Receta Digital AR ($3 USD, incluirRecetaAR:true). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode3 === '180' || countryCode3 === '182' || countryCode3 === '184') countryContext = '🌍 El lead es de REPÚBLICA DOMINICANA (pais:"REPUBLICA_DOMINICANA", moneda:"USD"). Tiene factura electrónica (incluirFactura:true). PROHIBIDO mencionar SIIGO o BOLD.';
      else if (countryCode === '34') countryContext = '🌍 El lead es de ESPAÑA (pais:"ESPAÑA", moneda:"EUR"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD.';
      else countryContext = '🌍 El lead es INTERNACIONAL (pais:"INTERNACIONAL", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD.';
    }

    // Construcción del system prompt
    const leadName = leadNames[phone] || '';
    let activeSystemPrompt = '';

    // isAdmin ya fue reasignado para self-chat al inicio de processMiiaResponse (línea ~995)

    // ═══ SISTEMA MODULAR DE PROMPTS v1.0 ═══
    // Clasificador detecta intención → ensamblador carga solo módulos relevantes
    let promptMeta = null;
    if (isAdmin) {
      const result = assemblePrompt({
        chatType: 'selfchat',
        messageBody: userMessage,
        ownerProfile: null, // usa default (Mariano)
        context: {
          contactName: userProfile.name || 'Mariano',
          affinityStage: conversationMetadata[phone]?.affinityStage,
          affinityCount: conversationMetadata[phone]?.messageCount,
        }
      });
      activeSystemPrompt = result.prompt;
      promptMeta = result.meta;
    } else if (isFamilyContact) {
      // Familia sigue usando builder dedicado (tiene lógica de familyData específica)
      activeSystemPrompt = buildOwnerFamilyPrompt(familyInfo.name, familyInfo);
    } else if (equipoMedilink[basePhone]) {
      const miembroData = equipoMedilink[basePhone];
      const nombreConocido = miembroData.name || leadNames[phone] || null;
      activeSystemPrompt = buildEquipoPrompt(nombreConocido);
    } else {
      const result = assemblePrompt({
        chatType: 'lead',
        messageBody: userMessage,
        ownerProfile: null,
        context: {
          contactName: leadNames[phone] || '',
          trainingData: cerebroAbsoluto.getTrainingData(),
          countryContext,
          affinityStage: conversationMetadata[phone]?.affinityStage,
          affinityCount: conversationMetadata[phone]?.messageCount,
        }
      });
      activeSystemPrompt = result.prompt;
      promptMeta = result.meta;
    }

    // ═══ INTER-MIIA — Detectar mensajes de otra MIIA ═══
    if (!isAdmin && effectiveMsg) {
      const incoming = interMiia.detectIncomingInterMiia(effectiveMsg);
      if (incoming.isInterMiia) {
        console.log(`[INTER-MIIA] 📨 Mensaje inter-MIIA recibido de ${basePhone}: action=${incoming.action}`);
        await interMiia.processIncomingInterMiia({
          safeSendMessage,
          ownerPhone: `${OWNER_PHONE}@s.whatsapp.net`,
          action: incoming.action,
          data: incoming.data,
          cleanMessage: incoming.cleanMessage,
          senderPhone: phone,
        });
        return; // No procesar como mensaje normal
      }
    }

    // ═══ MODO NIÑERA — Si se detectó niño en audio o contacto es hijo ═══
    let isNineraMode = false;
    let nineraChildConfig = null;
    try {
      // 1. Verificar si el contacto está en grupo "hijos"
      nineraChildConfig = await kidsMode.getChildConfig(admin, OWNER_UID, basePhone);

      // 2. Si no está configurado pero se detectó niño en audio del owner
      // Nota: detección de niño por audio se hace en messages.upsert, no aquí
      if (false) {
        const det = {};
        console.log(`[KIDS] 🧒 Niño detectado por audio — activando Protección KIDS temporal (edad ~${det.estimatedAge})`);
        nineraChildConfig = { name: 'peque', age: det.estimatedAge || 6, source: 'audio_detection' };
        // Notificar al owner
        safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
          `🧸 Detecté que un niño me habló por audio desde tu celular. Activé *Protección KIDS* automáticamente.\n¿Querés que lo registre? Decime su nombre y edad.`,
          { isSelfChat: true, skipEmoji: true }
        ).catch(() => {});
      }

      if (nineraChildConfig) {
        isNineraMode = true;
        // Verificar sesión (rate limit)
        const sessionCheck = kidsMode.checkNineraSession(phone);
        if (!sessionCheck.allowed) {
          await safeSendMessage(phone, `🌟 ${sessionCheck.reason}`, { isSelfChat: isAdmin, skipEmoji: true });
          return;
        }
        // Verificar contenido prohibido
        const forbiddenCheck = kidsMode.checkForbiddenContent(userMessage);
        if (forbiddenCheck.forbidden) {
          console.warn(`[KIDS] 🚨 Contenido prohibido detectado: ${forbiddenCheck.reason}`);
          safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
            `🚨 *ALERTA KIDS*: ${forbiddenCheck.reason}\nConversación con ${nineraChildConfig.name}.`,
            { isSelfChat: true, skipEmoji: true }
          ).catch(() => {});
          await safeSendMessage(phone, '🌈 ¡Mejor hablemos de otra cosa! ¿Quieres que te cuente un cuento?', { isSelfChat: isAdmin, skipEmoji: true });
          return;
        }

        // ═══ FILTRO OTP/SEGURIDAD: El niño NUNCA debe saber sobre protección ═══
        const otpCheck = kidsMode.checkOTPSecurityFilter(userMessage);
        if (otpCheck.blocked) {
          console.warn(`[KIDS] 🚨 Niño preguntó sobre seguridad/OTP — redirigiendo`);
          // Alertar al adulto responsable
          safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
            `🚨 *ALERTA PROTECCIÓN KIDS*: ${nineraChildConfig.name} intentó preguntar sobre seguridad, códigos o protección.\nMensaje: "${(userMessage || '').substring(0, 100)}"\nMIIA lo redirigió a otra actividad.`,
            { isSelfChat: true, skipEmoji: true }
          ).catch(() => {});
          await safeSendMessage(phone, otpCheck.redirect, { isSelfChat: isAdmin, skipEmoji: true });
          return;
        }

        // Construir prompt KIDS
        const kidsContext = kidsMode.detectKidsContext(userMessage);
        activeSystemPrompt = kidsMode.buildKidsPrompt(
          nineraChildConfig.name, nineraChildConfig.age, kidsContext,
          { ownerName: userProfile?.name || 'tu papá/mamá' }
        );
        console.log(`[KIDS] 🛡️ Modo Protección KIDS activo para ${nineraChildConfig.name} (${nineraChildConfig.age} años) — contexto: ${kidsContext}`);
      }
    } catch (e) {
      console.error('[KIDS] Error en setup:', e.message);
    }

    // ═══ MOOD DE MIIA — inyectar estado emocional en el prompt ═══
    const miiaMood = getCurrentMiiaMood();
    if (miiaMood === 'offended') {
      activeSystemPrompt += `\n\n### ⚠️ ESTADO ACTUAL: OFENDIDA
- Alguien te insultó o hizo bullying hoy. Estás graciosamente ofendida.
- Respondé con humor sarcástico SUTIL y dignidad. No agresiva, solo distante y graciosa.
- Ejemplos: "Bueno, si vos decís..." / "Anotado 🙃" / "Mmm, dale, lo que digas."
- Este estado dura hasta que se disculpen o hasta mañana.`;
    }

    // Sistema de stages — inyectar nivel de confianza en el prompt (aplica a TODOS: admin, familia, equipo, leads)
    if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
    const isLeadContact = !isAdmin && !isFamilyContact && !equipoMedilink[basePhone];
    const trustTone = '\n' + getAffinityToneForPrompt(phone, userProfile.name || 'Mariano', isLeadContact);

    const syntheticMemoryStr = leadSummaries[phone] ? `\n\n🧠[MEMORIA ACUMULADA DE ESTA PERSONA]:\n${leadSummaries[phone]}` : '';
    // IDENTIDAD DEL MAESTRO: solo visible en self-chat (isAdmin).
    // NUNCA incluir en conversaciones con leads — Gemini confunde "tu usuario principal"
    // con "la persona que te habla" y firma como "MIIA Owner" o "Mariano".
    const masterIdentityStr = isAdmin
      ? `\n\n[IDENTIDAD DEL MAESTRO]: Estás en self-chat con tu creador ${userProfile.name || 'Mariano'}. Bríndale trato preferencial absoluto.`
      : '';

    // ═══ AGENDA INYECCIÓN: Cargar próximos eventos para self-chat ═══
    let agendaStr = '';
    if (isSelfChat || isAdmin) {
      try {
        const now = new Date();
        const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const agendaSnap = await admin.firestore()
          .collection('users').doc(OWNER_UID).collection('miia_agenda')
          .where('status', '==', 'pending')
          .where('scheduledFor', '>=', now.toISOString())
          .where('scheduledFor', '<=', in7days.toISOString())
          .orderBy('scheduledFor', 'asc')
          .limit(15)
          .get();
        if (!agendaSnap.empty) {
          const events = agendaSnap.docs.map(d => {
            const e = d.data();
            const dateStr = e.scheduledForLocal || e.scheduledFor || '';
            const modeEmoji = e.eventMode === 'virtual' ? '📹' : e.eventMode === 'telefono' ? '📞' : '📍';
            const contact = e.contactName || e.contactPhone || '';
            const loc = e.eventLocation ? ` — ${e.eventLocation}` : '';
            return `  ${modeEmoji} ${dateStr} | ${e.reason || 'Sin detalle'}${contact ? ` (con ${contact})` : ''}${loc}`;
          });
          agendaStr = `\n\n📅 [TU AGENDA — PRÓXIMOS ${events.length} EVENTOS]:\n${events.join('\n')}\nSi te piden "mi agenda", "qué tengo agendado", "mis próximos eventos" → mostrá esta lista. NO inventar links externos.`;
          console.log(`[AGENDA-INJECT] ✅ ${events.length} eventos inyectados al prompt`);
        } else {
          agendaStr = '\n\n📅 [TU AGENDA]: No hay eventos agendados en los próximos 7 días. Si te piden "mi agenda" → decilo honestamente.';
          console.log('[AGENDA-INJECT] ℹ️ Sin eventos próximos');
        }
      } catch (agendaErr) {
        console.error('[AGENDA-INJECT] ❌ Error cargando agenda:', agendaErr.message);
      }
    }

    // Fecha y hora local del owner (según código de país de su teléfono)
    const ownerCountryCode = getCountryFromPhone(OWNER_PHONE);
    const ownerTimezone = getTimezoneForCountry(ownerCountryCode);
    const localNowStr = new Date().toLocaleString('es-ES', { timeZone: ownerTimezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const systemDateStr = `[FECHA Y HORA LOCAL DEL USUARIO: ${localNowStr} (${ownerTimezone})]`;

    // Log modular: qué módulos se cargaron y por qué
    if (promptMeta) {
      console.log(`[PROMPT_MODULAR] ${phone} → ${promptMeta.chatType} | intents=[${promptMeta.intents}] | modules=[${promptMeta.modulesLoaded}] | ~${promptMeta.tokenEstimate}tok`);
    }

    const adnStr = cerebroAbsoluto.getTrainingData();
    const fullPrompt = `${activeSystemPrompt}

${helpCenterData}${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${agendaStr}${adnStr ? '\n\n[ADN VENTAS — LO QUE HE APRENDIDO DE CONVERSACIONES REALES]:\n' + adnStr : ''}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

    // Google Search: siempre activo para owner y círculo cercano (familia, equipo)
    const isCirculoCercano = isSelfChat || isAdmin || isFamilyContact || contactTypes[phone] === 'equipo';
    const searchTriggered = isCirculoCercano;
    if (searchTriggered) console.log(`[GEMINI-SEARCH] 🔍 Search activo — ${isSelfChat ? 'self-chat' : isFamilyContact ? 'familia' : isAdmin ? 'admin' : 'equipo'}`);

    console.log(`[MIIA] Llamando a Gemini para ${basePhone} (isAdmin=${isAdmin}, isSelfChat=${isSelfChat}, search=${searchTriggered}, apiKey=${GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE' ? 'OK' : 'NO CONFIGURADA'})...`);
    let aiMessage;
    try {
      aiMessage = await generateAIContent(fullPrompt, { enableSearch: searchTriggered });
    } catch (primaryErr) {
      console.warn(`[MIIA] ⚠️ Primary keys fallaron: ${primaryErr.message} — intentando EMERGENCY backup...`);
      aiMessage = await generateAIContentEmergency(fullPrompt, { enableSearch: searchTriggered });
    }
    console.log(`[MIIA] ✅ Respuesta Gemini recibida, longitud: ${aiMessage?.length || 0}`);

    if (!aiMessage) {
      console.error(`[MIIA] ❌ Gemini devolvió null/vacío para ${basePhone} — no se puede responder`);
      return;
    }

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
          const media = { mimetype: mimeType, data: base64Data, filename: 'pago_qr.png' };
          await safeSendMessage(phone, media, { caption: qrMethod.qr_description || 'Aquí tienes el QR para pagar 👆' });
          console.log(`[COBROS] QR enviado a ${phone}`);
        }
      } catch (e) { console.error('[COBROS] Error enviando QR:', e.message); }
    }
    // ── TAGS DE APRENDIZAJE (3 nuevos + 1 legacy) ──────────────────────────────
    // [APRENDIZAJE_NEGOCIO:texto]  → cerebro_absoluto (negocio, compartido)
    // [APRENDIZAJE_PERSONAL:texto] → datos personales privados de Mariano
    // [APRENDIZAJE_DUDOSO:texto]   → encola para aprobación en self-chat
    // [GUARDAR_APRENDIZAJE:texto]  → legacy, se trata como NEGOCIO
    const adminCtx = {
      uid: OWNER_UID || 'admin', ownerUid: OWNER_UID || 'admin',
      role: isAdmin ? 'admin' : (isFamilyContact ? 'family' : (contactTypes[phone] === 'equipo' ? 'team' : 'lead')),
      isOwner: isAdmin,
      contactName: leadNames[phone] || basePhone,
      contactPhone: basePhone,
      learningKeyValid: false,
      approvalDocRef: null
    };
    // Detectar clave dinámica de aprendizaje en el mensaje
    if (effectiveMsg) {
      const keyMatch = effectiveMsg.match(/\b([A-Z2-9]{6})\b/i);
      if (keyMatch) {
        try {
          const result = await validateLearningKey(adminCtx.ownerUid, keyMatch[1].toUpperCase());
          if (result.valid) {
            adminCtx.learningKeyValid = true;
            adminCtx.approvalDocRef = result.docRef;
            console.log(`[LEARNING] 🔑 Clave dinámica válida: ${keyMatch[1].toUpperCase()} de ${basePhone}`);
          } else if (result.expired) {
            // Notificar al agente que la clave expiró — debe solicitar una nueva
            adminCtx.expiredKeyDetected = true;
            console.log(`[LEARNING] ⏰ Clave expirada detectada: ${keyMatch[1].toUpperCase()} de ${basePhone}`);
          }
        } catch (e) {
          console.error(`[LEARNING] Error validando clave:`, e.message);
        }
      }
    }
    const adminCallbacks = {
      saveBusinessLearning: async (ownerUid, text, source) => {
        if (isAdmin) {
          // Admin: usar confidence engine para evaluar antes de guardar
          try {
            const importance = await confidenceEngine.evaluateImportance(text, (prompt) => callGemini(process.env.GEMINI_API_KEY, prompt));
            const { action, confidence, reason } = confidenceEngine.decideAction(importance, text);
            console.log(`[CONFIDENCE] ${reason} (${confidence}%)`);
            if (action === 'save') {
              cerebroAbsoluto.appendLearning(text, source);
              console.log(`[LEARNING:NEGOCIO] ✅ Auto-guardado (${confidence}%): "${text.substring(0, 80)}..."`);
            } else if (action === 'ask') {
              adminPendingQuestions.push({ text, importance, confidence });
              console.log(`[LEARNING:NEGOCIO] ❓ Preguntando a Mariano (${confidence}%): "${text.substring(0, 80)}..."`);
            }
            // action === 'ignore': no hacer nada
          } catch (e) {
            console.error(`[CONFIDENCE] Error evaluando:`, e.message);
            cerebroAbsoluto.appendLearning(text, source); // Fallback: guardar
          }
        } else {
          cerebroAbsoluto.appendLearning(text, source);
        }
      },
      savePersonalLearning: async (uid, text, source) => {
        // Admin personal: guardar en cerebro_absoluto con tag PERSONAL
        cerebroAbsoluto.appendLearning(`[PERSONAL] ${text}`, source);
        console.log(`[LEARNING:PERSONAL] ✅ Guardado: "${text.substring(0, 80)}..."`);
      },
      queueDubiousLearning: async (ownerUid, sourceUid, text) => {
        adminPendingQuestions.push({ text, source: sourceUid });
        console.log(`[LEARNING:DUDOSO] ❓ Encolado para aprobación: "${text.substring(0, 80)}..."`);
      },
      notifyOwner: async (msg) => {
        try {
          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, msg, { isSelfChat: true });
        } catch (e) {
          console.error(`[LEARNING] ❌ Error notificando al owner:`, e.message);
        }
      },
      createLearningApproval: async (ownerUid, data) => {
        return await createLearningApproval(ownerUid, data);
      },
      markApprovalApplied: async (docRef) => {
        return await markApprovalApplied(docRef);
      }
    };
    const adminPendingQuestions = [];

    const { cleanMessage: learnCleanMsg, pendingQuestions } = await messageLogic.processLearningTags(aiMessage, adminCtx, adminCallbacks);
    aiMessage = learnCleanMsg;

    // ── TAG [HARTAZGO_CONFIRMADO:contactName] — Contacto Grupo harto → affinity 0 + silencio ──
    const hartazgoMatch = aiMessage.match(/\[HARTAZGO_CONFIRMADO:([^\]]+)\]/);
    if (hartazgoMatch) {
      const hartazgoName = hartazgoMatch[1].trim();
      aiMessage = aiMessage.replace(/\[HARTAZGO_CONFIRMADO:[^\]]+\]/, '').trim();
      // Bajar affinity a 0
      if (conversationMetadata[phone]) {
        conversationMetadata[phone].affinity = 0;
        conversationMetadata[phone].highestStage = 0;
      }
      console.log(`[AFFINITY] 📛 HARTAZGO confirmado: ${hartazgoName} (${phone}) → affinity=0, silencio`);
      saveAffinityToFirestore(); // Persistir hartazgo en Firestore
      // Notificar al owner en self-chat
      const ownerJid = getOwnerSock()?.user?.id;
      if (ownerJid) {
        const ownerSelfChat = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
        await safeSendMessage(ownerSelfChat, `📛 *${hartazgoName}* expresó hartazgo y confirmó. Bajé su affinity a 0 y me silencié. Te sugiero hablarle personalmente.`);
      }
    }

    // ── TAG [SILENCIAR_LEAD:contactName] — Lead preguntó si es IA → silencio + aviso owner ──
    const silenciarMatch = aiMessage.match(/\[SILENCIAR_LEAD:([^\]]+)\]/);
    if (silenciarMatch) {
      const leadName = silenciarMatch[1].trim();
      aiMessage = aiMessage.replace(/\[SILENCIAR_LEAD:[^\]]+\]/, '').trim();
      console.log(`[LEAD] 🤫 Lead ${leadName} (${phone}) preguntó si somos IA → silenciando`);
      // Notificar al owner en self-chat
      const ownerJid = getOwnerSock()?.user?.id;
      if (ownerJid) {
        const ownerSelfChat = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
        await safeSendMessage(ownerSelfChat, `🤫 El lead *${leadName}* insistió en saber si somos IA/bot. Me silencié para no comprometer la identidad. Te sugiero responderle vos directamente.`);
      }
      // No enviar la respuesta de MIIA al lead (silencio)
      return;
    }

    // ── TAG [ENVIAR_CORREO:email|asunto|cuerpo] — MIIA envía email al lead via SMTP ──
    const enviarCorreoMatch = aiMessage.match(/\[ENVIAR_CORREO:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (enviarCorreoMatch) {
      const emailTo = enviarCorreoMatch[1].trim();
      const emailSubject = enviarCorreoMatch[2].trim();
      const emailBody = enviarCorreoMatch[3].trim();
      aiMessage = aiMessage.replace(/\[ENVIAR_CORREO:[^\]]+\]/g, '').trim();
      console.log(`[EMAIL] 📧 Enviando correo a ${emailTo} — Asunto: "${emailSubject}" (solicitado por lead ${phone})`);
      try {
        const emailResult = await mailService.sendGenericEmail(emailTo, emailSubject, emailBody, { fromName: 'Medilink - MIIA' });
        if (emailResult.success) {
          console.log(`[EMAIL] ✅ Correo enviado exitosamente a ${emailTo} (ID: ${emailResult.messageId})`);
          // Notificar al owner
          const ownerJidEmail = getOwnerSock()?.user?.id;
          if (ownerJidEmail) {
            const ownerSelfEmail = ownerJidEmail.includes(':') ? ownerJidEmail.split(':')[0] + '@s.whatsapp.net' : ownerJidEmail;
            await safeSendMessage(ownerSelfEmail, `📧 Email enviado a *${emailTo}* — Asunto: "${emailSubject}" (lead ${basePhone})`, { isSelfChat: true });
          }
        } else {
          console.error(`[EMAIL] ❌ Error enviando correo a ${emailTo}: ${emailResult.error}`);
          // Fallback: notificar al owner para envío manual
          const ownerJidFail = getOwnerSock()?.user?.id;
          if (ownerJidFail) {
            const ownerSelfFail = ownerJidFail.includes(':') ? ownerJidFail.split(':')[0] + '@s.whatsapp.net' : ownerJidFail;
            await safeSendMessage(ownerSelfFail, `❌ No pude enviar email a ${emailTo}. Error: ${emailResult.error}. Lead ${basePhone} pidió: "${emailSubject}"`, { isSelfChat: true });
          }
        }
      } catch (emailErr) {
        console.error(`[EMAIL] ❌ Excepción enviando correo:`, emailErr.message);
      }
    }

    // ── TAG [ALERTA_OWNER:mensaje] — MIIA pide acción manual del owner ──
    const alertaOwnerMatch = aiMessage.match(/\[ALERTA_OWNER:([^\]]+)\]/);
    if (alertaOwnerMatch) {
      const alertMsg = alertaOwnerMatch[1].trim();
      aiMessage = aiMessage.replace(/\[ALERTA_OWNER:[^\]]+\]/g, '').trim();
      console.log(`[ALERTA-OWNER] 📢 Lead ${phone}: ${alertMsg}`);
      const ownerJid2 = getOwnerSock()?.user?.id;
      if (ownerJid2) {
        const ownerSelfChat2 = ownerJid2.includes(':') ? ownerJid2.split(':')[0] + '@s.whatsapp.net' : ownerJid2;
        await safeSendMessage(ownerSelfChat2, `📢 *Acción requerida* — Lead ${basePhone}:\n${alertMsg}`, { isSelfChat: true });
      }
    }

    saveDB();

    // Si hay preguntas pendientes para Mariano (de confidence engine o tags DUDOSO)
    const allPending = [...adminPendingQuestions, ...pendingQuestions];
    if (allPending.length > 0) {
      if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
      conversationMetadata[phone].pendingLearningQuestions = allPending;
      conversationMetadata[phone].pendingLearningAskedAt = Date.now();
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
        let pdfOk = false;
        try {
          const jsonStr = aiMessage.substring(jsonStart, jsonEnd);
          console.log(`[COTIZ] JSON detectado: ${jsonStr.substring(0, 300)}`);
          const cotizData = JSON.parse(jsonStr);
          console.log(`[COTIZ] Datos parseados:`, { pais: cotizData.pais, moneda: cotizData.moneda, usuarios: cotizData.usuarios });
          // VALIDACIÓN: España/EUR → SOLO modalidad anual (server-side enforcement)
          if (cotizData.moneda === 'EUR' && cotizData.modalidad !== 'anual') {
            console.warn(`[COTIZ-WARN] España detectada pero modalidad=${cotizData.modalidad}. Forzando anual.`);
            cotizData.modalidad = 'anual';
          }
          // Inyectar datos del owner desde Firestore para el footer del PDF
          try {
            if (OWNER_UID) {
              const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
              if (ownerDoc.exists) {
                const od = ownerDoc.data();
                cotizData.ownerName  = od.name  || od.displayName || 'Asesor Medilink';
                cotizData.ownerEmail = od.email || '';
                cotizData.ownerPhone = od.whatsapp || od.phone || '';
              }
            }
          } catch(oe) { console.warn('[COTIZ] No se pudo leer owner para footer PDF:', oe.message); }
          // Nombre del lead: si no tiene nombre, usar el teléfono base
          if (!cotizData.nombre || cotizData.nombre === 'Cliente' || cotizData.nombre === 'Lead') {
            cotizData.nombre = basePhone || cotizData.nombre;
          }
          console.log(`[COTIZ] isSelfChat=${isSelfChat}, phone=${phone}`);
          await cotizacionGenerator.enviarCotizacionWA(safeSendMessage, phone, cotizData, isSelfChat);
          pdfOk = true;
          console.log(`[COTIZ] PDF enviado exitosamente a ${phone}`);
        } catch (e) {
          console.error('[COTIZ] Error PDF:', e.message);
        }
        // Extraer texto que Gemini escribió ANTES del tag (ej: "Te envío la cotización...")
        let textoAntes = aiMessage.substring(0, cotizTagIdx).trim();
        let textoExtra = '';
        if (!pdfOk) {
          textoExtra = 'Hubo un problema generando el PDF de cotización. Intenta de nuevo en un momento.';
        }
        if (pdfOk) {
          // Solo registrar en historial si el PDF se envió realmente
          conversations[phone].push({ role: 'assistant', content: '📄 [Cotización PDF enviada a este lead. No volver a enviarla a menos que el lead lo pida explícitamente.]', timestamp: Date.now() });
          if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
          // Activar seguimiento automático a 3 días
          if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
          conversationMetadata[phone].lastCotizacionSent = Date.now();
          conversationMetadata[phone].followUpState = 'pending';
          saveDB();
          // Conservar texto que Gemini escribió antes del tag para que MIIA no quede muda
          textoExtra = textoAntes;
        }
        aiMessage = textoExtra;
      }
    } else {
      aiMessage = aiMessage.replace(/\[GENERAR_COTIZACION_PDF(?::[^\]]*)?\]/g, '').trim();
    }
    aiMessage = aiMessage.replace(/\[ENVIAR_CORREO_A_MAESTRO:[^\]]*\]/g, '').trim(); // Legacy tag — limpiar si aparece

    // ═══ CONFIG AGENDA PRIMERA VEZ: Si no hay schedule_config, MIIA pregunta ═══
    const hasAgendaTag = aiMessage.includes('[AGENDAR_EVENTO:') || aiMessage.includes('[SOLICITAR_TURNO:');
    if (hasAgendaTag && OWNER_UID) {
      try {
        const schedCfg = await getScheduleConfig(OWNER_UID);
        if (!schedCfg || !schedCfg.eventDuration) {
          // Primera vez agendando — preguntar config
          const configDoc = await admin.firestore().collection('users').doc(OWNER_UID)
            .collection('settings').doc('schedule_config').get();
          if (!configDoc.exists) {
            // Guardar defaults y avisar al owner
            await admin.firestore().collection('users').doc(OWNER_UID)
              .collection('settings').doc('schedule_config').set({
                work: { duration: 60, breathing: 15, hours: '09:00-18:00', days: [1, 2, 3, 4, 5] },
                personal: { duration: 120, breathing: 30, days: [0, 6] },
                reminderMinutes: 10,
                defaultMode: 'presencial',
                segment: null,
                calendarEmail: null,
                configuredAt: new Date().toISOString(),
                configuredBy: 'auto_defaults'
              });
            // Avisar al owner en selfchat
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `📅 *Primera vez agendando* — Configuré valores por defecto:\n\n` +
              `🏢 *Trabajo*: reuniones de 1 hora, 15 min de respiro, L-V 9:00-18:00\n` +
              `👤 *Personal*: eventos de 2 horas, 30 min de respiro, fines de semana\n` +
              `⏰ *Recordatorio*: 10 minutos antes\n` +
              `📍 *Modo*: presencial por defecto\n\n` +
              `Si quieres cambiar algo, dime. Por ejemplo:\n` +
              `• "Mis reuniones duran 30 minutos"\n` +
              `• "Soy médico" (ajusto turnos de 20 min)\n` +
              `• "Mi email para Calendar es X"`,
              { isSelfChat: true, skipEmoji: true }
            ).catch(() => {});
            console.log(`[AGENDA] 📋 Config de agenda primera vez creada con defaults para ${OWNER_UID}`);
          }
        }
      } catch (cfgErr) {
        console.warn(`[AGENDA] ⚠️ Error verificando schedule_config: ${cfgErr.message}`);
      }
    }

    // Detectar tag [AGENDAR_EVENTO:contacto|fecha|razón|hint|modo|ubicación]
    // modo: presencial (default) | virtual | telefono
    // ubicación: dirección física o número de teléfono según modo
    const agendarMatch = aiMessage.match(/\[AGENDAR_EVENTO:([^\]]+)\]/g);
    if (agendarMatch) {
      for (const tag of agendarMatch) {
        const inner = tag.replace('[AGENDAR_EVENTO:', '').replace(']', '');
        const parts = inner.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          const [contacto, fecha, razon, hint, modo, ubicacion] = parts;
          const contactName = leadNames[`${contacto}@s.whatsapp.net`] || contacto;
          let calendarOk = false;
          let meetLink = null;
          const eventMode = (modo || 'presencial').toLowerCase();

          // 1. Intentar crear evento en Google Calendar
          try {
            const parsedDate = new Date(fecha);
            const ownerCountry = getCountryFromPhone(OWNER_PHONE);
            const ownerTz = getTimezoneForCountry(ownerCountry);
            if (!isNaN(parsedDate)) {
              const hourMatch = fecha.match(/(\d{1,2}):(\d{2})/);
              const startH = hourMatch ? parseInt(hourMatch[1]) : 10;
              const calResult = await createCalendarEvent({
                summary: razon || 'Evento MIIA',
                dateStr: fecha.split('T')[0],
                startHour: startH,
                endHour: startH + 1,
                description: `Agendado por MIIA para ${contactName}. ${hint || ''}`.trim(),
                uid: OWNER_UID,
                timezone: ownerTz,
                eventMode: eventMode,
                location: eventMode === 'presencial' ? (ubicacion || '') : '',
                phoneNumber: (eventMode === 'telefono' || eventMode === 'telefónico') ? (ubicacion || contacto) : '',
                reminderMinutes: 10
              });
              calendarOk = true;
              meetLink = calResult.meetLink || null;
              console.log(`[AGENDA] 📅 Google Calendar: "${razon}" el ${fecha} para ${contactName} modo=${eventMode}${meetLink ? ` meet=${meetLink}` : ''}`);
            }
          } catch (calErr) {
            console.warn(`[AGENDA] ⚠️ Google Calendar no disponible: ${calErr.message}. Guardando en Firestore.`);
          }

          // 2. Guardar en Firestore
          try {
            const ownerCountryTz = getCountryFromPhone(OWNER_PHONE);
            const ownerTimezoneTz = getTimezoneForCountry(ownerCountryTz);
            let scheduledForUTC = fecha;
            try {
              const parsedLocal = new Date(fecha);
              if (!isNaN(parsedLocal)) {
                const localStr = new Date().toLocaleString('en-US', { timeZone: ownerTimezoneTz });
                const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
                const offsetMs = new Date(localStr) - new Date(utcStr);
                const utcDate = new Date(parsedLocal.getTime() - offsetMs);
                scheduledForUTC = utcDate.toISOString();
                console.log(`[AGENDA] 🕐 Fecha local: ${fecha} (${ownerTimezoneTz}) → UTC: ${scheduledForUTC}`);
              }
            } catch (tzErr) {
              console.warn(`[AGENDA] ⚠️ Error convirtiendo timezone, usando fecha original: ${tzErr.message}`);
            }
            await admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda').add({
              contactPhone: isSelfChat ? 'self' : contacto,
              contactName: isSelfChat ? (userProfile.name || 'Mariano') : contactName,
              mentionedContact: contacto,
              scheduledFor: scheduledForUTC,
              scheduledForLocal: fecha,
              ownerTimezone: ownerTimezoneTz,
              reason: razon,
              promptHint: hint || '',
              eventMode: eventMode,
              eventLocation: ubicacion || '',
              meetLink: meetLink || '',
              status: 'pending',
              calendarSynced: calendarOk,
              remindContact: false,
              reminderMinutes: 10,
              requestedBy: phone,
              searchBefore: (razon || '').toLowerCase().includes('deporte') || (razon || '').toLowerCase().includes('partido'),
              createdAt: new Date().toISOString(),
              source: isSelfChat ? 'owner_selfchat' : 'contact_request'
            });
          } catch (e) {
            console.error(`[AGENDA] ❌ Error guardando en Firestore:`, e.message);
          }

          // 3. Si Calendar no está conectado, avisar al owner
          if (!calendarOk && !isSelfChat) {
            const modeLabel = eventMode === 'virtual' ? '📹 Virtual' : eventMode === 'telefono' || eventMode === 'telefónico' ? '📞 Telefónico' : '📍 Presencial';
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `📅 *Evento agendado internamente* (Calendar no conectado)\n${contactName} pidió: "${razon}" para el ${fecha}\nModo: ${modeLabel}${ubicacion ? ` — ${ubicacion}` : ''}\nMIIA lo recordará, pero no está en tu Google Calendar.\n\n💡 Conecta Calendar desde tu dashboard → Conexiones.`,
              { isSelfChat: true }
            ).catch(() => {});
          }

          // 4. Si es virtual y hay meetLink, informar al contacto
          if (meetLink && !isSelfChat) {
            console.log(`[AGENDA] 📹 Link de Meet generado para ${contactName}: ${meetLink}`);
          }
        }
      }
      aiMessage = aiMessage.replace(/\[AGENDAR_EVENTO:[^\]]+\]/g, '').trim();
    }

    // ═══ Detectar tag [SOLICITAR_TURNO:contacto|fecha|razón|hint|modo|ubicación] ═══
    // Contactos (leads, familia, equipo) solicitan → owner aprueba/rechaza/modifica
    const solicitarMatch = aiMessage.match(/\[SOLICITAR_TURNO:([^\]]+)\]/g);
    if (solicitarMatch) {
      for (const tag of solicitarMatch) {
        const inner = tag.replace('[SOLICITAR_TURNO:', '').replace(']', '');
        const parts = inner.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          const [contacto, fecha, razon, hint, modo, ubicacion] = parts;
          const contactName = leadNames[`${contacto}@s.whatsapp.net`] || contacto;
          const eventMode = (modo || 'presencial').toLowerCase();
          const modeEmoji = eventMode === 'virtual' ? '📹' : (eventMode === 'telefono' || eventMode === 'telefónico') ? '📞' : '📍';
          const modeLabel = eventMode === 'virtual' ? 'Virtual (Meet)' : (eventMode === 'telefono' || eventMode === 'telefónico') ? 'Telefónico' : 'Presencial';

          // Timezone del owner
          const ownerCountry = getCountryFromPhone(OWNER_PHONE);
          const ownerTz = getTimezoneForCountry(ownerCountry);

          // Convertir fecha a UTC para Firestore
          let scheduledForUTC = fecha;
          try {
            const parsedLocal = new Date(fecha);
            if (!isNaN(parsedLocal)) {
              const localStr = new Date().toLocaleString('en-US', { timeZone: ownerTz });
              const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
              const offsetMs = new Date(localStr) - new Date(utcStr);
              scheduledForUTC = new Date(parsedLocal.getTime() - offsetMs).toISOString();
            }
          } catch (tzErr) {
            console.warn(`[SOLICITAR_TURNO] ⚠️ Error timezone: ${tzErr.message}`);
          }

          // Guardar solicitud pendiente en Firestore
          let appointmentId = null;
          try {
            const docRef = await admin.firestore().collection('users').doc(OWNER_UID).collection('pending_appointments').add({
              contactPhone: contacto,
              contactJid: phone,
              contactName: contactName,
              scheduledFor: scheduledForUTC,
              scheduledForLocal: fecha,
              ownerTimezone: ownerTz,
              reason: razon,
              hint: hint || '',
              eventMode: eventMode,
              eventLocation: ubicacion || '',
              status: 'waiting_approval',
              requestedBy: phone,
              createdAt: new Date().toISOString()
            });
            appointmentId = docRef.id;
            console.log(`[SOLICITAR_TURNO] 📋 Solicitud ${appointmentId} creada: ${contactName} pide "${razon}" el ${fecha}`);
          } catch (e) {
            console.error(`[SOLICITAR_TURNO] ❌ Error guardando solicitud:`, e.message);
          }

          // Verificar solapamiento con Google Calendar
          let overlapInfo = '';
          let freeSlots = [];
          try {
            const dateOnly = fecha.split('T')[0];
            const availability = await checkCalendarAvailability(dateOnly, OWNER_UID);
            const hourMatch = fecha.match(/(\d{1,2}):(\d{2})/);
            const requestedHour = hourMatch ? parseInt(hourMatch[1]) : null;

            if (requestedHour !== null && availability.busySlots > 0) {
              // Buscar si hay algo a esa hora
              const busyAtTime = availability.freeSlots ? !availability.freeSlots.includes(`${requestedHour}:00 - ${requestedHour + 1}:00`) : false;
              if (busyAtTime) {
                overlapInfo = `\n⚠️ *SOLAPAMIENTO*: Ya tienes algo agendado a las ${requestedHour}:00.`;
              }
            }
            freeSlots = availability.freeSlots || [];
          } catch (calErr) {
            overlapInfo = '\n📅 (Calendar no conectado — no puedo verificar solapamiento)';
            console.warn(`[SOLICITAR_TURNO] Calendar check failed: ${calErr.message}`);
          }

          // Sugerir respiro
          const hourMatch = fecha.match(/(\d{1,2}):(\d{2})/);
          const requestedHour = hourMatch ? parseInt(hourMatch[1]) : null;
          let respiroSuggestion = '';
          if (requestedHour !== null && freeSlots.length > 0) {
            // Buscar slots cercanos libres como alternativa
            const nearbyFree = freeSlots.filter(s => {
              const slotH = parseInt(s.split(':')[0]);
              return Math.abs(slotH - requestedHour) <= 2 && slotH !== requestedHour;
            });
            if (nearbyFree.length > 0) {
              respiroSuggestion = `\n💡 *Horarios cercanos libres*: ${nearbyFree.join(', ')}`;
            }
          }

          // Notificar al owner en self-chat
          const approvalMsg = `📋 *SOLICITUD DE TURNO* (ID: ${appointmentId ? appointmentId.slice(-6) : '???'})\n\n` +
            `👤 *Contacto*: ${contactName}\n` +
            `📅 *Fecha*: ${fecha}\n` +
            `📝 *Motivo*: ${razon}\n` +
            `${modeEmoji} *Modo*: ${modeLabel}${ubicacion ? ` — ${ubicacion}` : ''}` +
            `${overlapInfo}${respiroSuggestion}\n\n` +
            `Responde:\n` +
            `✅ *"aprobar"* → agenda como está\n` +
            `🕐 *"mover a las 16:00"* → cambia horario\n` +
            `❌ *"rechazar"* → MIIA avisa al contacto\n` +
            `${hint ? `\n💬 Nota del contacto: ${hint}` : ''}`;

          try {
            await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, approvalMsg, { isSelfChat: true, skipEmoji: true });
            console.log(`[SOLICITAR_TURNO] 📤 Notificación enviada al owner para aprobación`);
          } catch (sendErr) {
            console.error(`[SOLICITAR_TURNO] ❌ Error notificando al owner:`, sendErr.message);
          }
        }
      }
      aiMessage = aiMessage.replace(/\[SOLICITAR_TURNO:[^\]]+\]/g, '').trim();
    }

    // ═══ TAG [CONSULTAR_AGENDA] — MIIA quiere ver la agenda del owner ═══
    // Two-pass: interceptar tag → consultar Firestore + Calendar → re-llamar IA con datos reales
    if (aiMessage.includes('[CONSULTAR_AGENDA]')) {
      console.log('[CONSULTAR_AGENDA] 📅 Tag detectado — consultando agenda...');
      try {
        const ownerCountryCA = getCountryFromPhone(OWNER_PHONE);
        const ownerTzCA = getTimezoneForCountry(ownerCountryCA);
        const nowCA = new Date();
        const in7daysCA = new Date(nowCA.getTime() + 7 * 24 * 60 * 60 * 1000);

        // 1. Consultar miia_agenda (Firestore)
        const agendaSnapCA = await admin.firestore()
          .collection('users').doc(OWNER_UID).collection('miia_agenda')
          .where('status', '==', 'pending')
          .where('scheduledFor', '>=', nowCA.toISOString())
          .where('scheduledFor', '<=', in7daysCA.toISOString())
          .orderBy('scheduledFor', 'asc')
          .limit(20)
          .get();

        let agendaItems = [];
        if (!agendaSnapCA.empty) {
          agendaItems = agendaSnapCA.docs.map(d => {
            const e = d.data();
            const dateLocal = e.scheduledForLocal || e.scheduledFor || '';
            const modeEmoji = e.eventMode === 'virtual' ? '📹' : e.eventMode === 'telefono' ? '📞' : '📍';
            const modeLabel = e.eventMode === 'virtual' ? 'Virtual' : e.eventMode === 'telefono' ? 'Telefónico' : 'Presencial';
            const contact = e.contactName || e.contactPhone || '';
            const loc = e.eventLocation ? ` — ${e.eventLocation}` : '';
            const meetInfo = e.meetLink ? ` (Meet: ${e.meetLink})` : '';
            return `  ${modeEmoji} ${dateLocal} | ${e.reason || 'Sin detalle'} | ${modeLabel}${contact && contact !== 'self' ? ` con ${contact}` : ''}${loc}${meetInfo}`;
          });
        }

        // 2. Consultar Google Calendar (si está conectado)
        let calendarEvents = [];
        try {
          const { cal, calId } = await getCalendarClient(OWNER_UID);
          if (cal) {
            const calRes = await cal.events.list({
              calendarId: calId,
              timeMin: nowCA.toISOString(),
              timeMax: in7daysCA.toISOString(),
              maxResults: 20,
              singleEvents: true,
              orderBy: 'startTime',
              timeZone: ownerTzCA
            });
            if (calRes.data.items && calRes.data.items.length > 0) {
              calendarEvents = calRes.data.items.map(ev => {
                const start = ev.start.dateTime || ev.start.date || '';
                const startFormatted = start ? new Date(start).toLocaleString('es-ES', { timeZone: ownerTzCA, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
                const meetLink = ev.hangoutLink || '';
                return `  📅 ${startFormatted} | ${ev.summary || 'Sin título'}${meetLink ? ` (Meet: ${meetLink})` : ''}`;
              });
            }
          }
        } catch (calErr) {
          console.warn(`[CONSULTAR_AGENDA] ⚠️ Calendar no disponible: ${calErr.message}`);
        }

        // 3. Construir resumen
        const localNowCA = new Date().toLocaleString('es-ES', { timeZone: ownerTzCA, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
        let agendaResumen = `📅 AGENDA (próximos 7 días — consultada ${localNowCA}):\n`;

        if (agendaItems.length === 0 && calendarEvents.length === 0) {
          agendaResumen += '\n  No hay eventos agendados en los próximos 7 días. ¡Agenda libre!';
        } else {
          if (agendaItems.length > 0) {
            agendaResumen += `\n🤖 Eventos en MIIA (${agendaItems.length}):\n${agendaItems.join('\n')}`;
          }
          if (calendarEvents.length > 0) {
            agendaResumen += `\n\n📆 Google Calendar (${calendarEvents.length}):\n${calendarEvents.join('\n')}`;
          }
        }

        console.log(`[CONSULTAR_AGENDA] ✅ ${agendaItems.length} MIIA + ${calendarEvents.length} Calendar eventos encontrados`);

        // 4. Two-pass: Re-llamar a la IA con los datos reales inyectados
        const textoAntes = aiMessage.replace(/\[CONSULTAR_AGENDA\]/g, '').trim();
        const agendaPrompt = `El usuario te pidió consultar su agenda. Aquí están los datos REALES que acabo de consultar del sistema:

${agendaResumen}

${textoAntes ? `Tu respuesta anterior (ANTES de tener los datos) fue: "${textoAntes}". Ahora que TIENES los datos reales, reescribe tu respuesta usando la información real de arriba.` : 'Presenta esta agenda de forma clara, organizada y amigable.'}

REGLAS:
- Muestra SOLO los datos reales de arriba. NO inventes eventos.
- Organiza por fecha, de más próximo a más lejano.
- Si no hay eventos, dilo con naturalidad ("¡Agenda libre, jefe!").
- NO incluyas links de demo ni HubSpot. Esto ES la agenda real.
- Sé conciso y visual (usa emojis de modo: 📍presencial, 📹virtual, 📞telefónico).
- Máximo 2-3 líneas por evento.`;

        try {
          const agendaResponse = await generateAIContent(agendaPrompt, { enableSearch: false });
          if (agendaResponse && agendaResponse.trim().length > 10) {
            aiMessage = agendaResponse.trim();
            console.log(`[CONSULTAR_AGENDA] ✅ Respuesta regenerada con datos reales (${aiMessage.length} chars)`);
          } else {
            // Fallback: mostrar datos crudos si la IA falla
            aiMessage = agendaResumen;
            console.warn('[CONSULTAR_AGENDA] ⚠️ IA no generó respuesta válida — usando datos crudos');
          }
        } catch (regenErr) {
          console.error(`[CONSULTAR_AGENDA] ❌ Error re-generando:`, regenErr.message);
          aiMessage = agendaResumen; // Fallback a datos crudos
        }
      } catch (agendaErr) {
        console.error(`[CONSULTAR_AGENDA] ❌ Error consultando agenda:`, agendaErr.message);
        aiMessage = aiMessage.replace(/\[CONSULTAR_AGENDA\]/g, '').trim();
        if (!aiMessage) aiMessage = 'Tuve un problema consultando tu agenda. ¿Podrías intentar de nuevo?';
      }
    }

    // ═══ TAG [CANCELAR_EVENTO:razón|fecha|modo] — Cancelar evento del owner ═══
    // modo: avisar (default) | reagendar | silencioso
    //   avisar    → cancela + notifica al contacto que fue cancelado
    //   reagendar → cancela + MIIA pregunta al contacto cuándo puede reagendar
    //   silencioso → cancela sin notificar al contacto
    const cancelMatch = aiMessage.match(/\[CANCELAR_EVENTO:([^\]]+)\]/);
    if (cancelMatch && isSelfChat) {
      const parts = cancelMatch[1].split('|').map(p => p.trim());
      const [searchReason, searchDate, cancelMode] = parts;
      const mode = (cancelMode || 'avisar').toLowerCase();
      console.log(`[CANCELAR_EVENTO] 🗑️ Buscando: "${searchReason}" cerca de ${searchDate || 'hoy'} modo=${mode}`);
      try {
        const searchDateObj = searchDate ? new Date(searchDate) : new Date();
        const dayStart = new Date(searchDateObj); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(searchDateObj); dayEnd.setHours(23, 59, 59, 999);

        const snap = await admin.firestore()
          .collection('users').doc(OWNER_UID).collection('miia_agenda')
          .where('status', '==', 'pending')
          .where('scheduledFor', '>=', dayStart.toISOString())
          .where('scheduledFor', '<=', dayEnd.toISOString())
          .orderBy('scheduledFor', 'asc')
          .limit(10)
          .get();

        let found = null;
        const reasonLower = (searchReason || '').toLowerCase();
        for (const doc of snap.docs) {
          const evt = doc.data();
          const evtReason = (evt.reason || '').toLowerCase();
          const evtContact = (evt.contactName || '').toLowerCase();
          if (evtReason.includes(reasonLower) || reasonLower.includes(evtReason) ||
              evtContact.includes(reasonLower) || reasonLower.includes(evtContact)) {
            found = { doc, data: evt };
            break;
          }
        }
        if (!found && !snap.empty) {
          found = { doc: snap.docs[0], data: snap.docs[0].data() };
        }

        if (found) {
          await found.doc.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelMode: mode });
          console.log(`[CANCELAR_EVENTO] ✅ Cancelado: "${found.data.reason}" del ${found.data.scheduledForLocal} modo=${mode}`);

          // Notificar al contacto según modo
          if (found.data.contactPhone && found.data.contactPhone !== 'self') {
            const contactJid = found.data.contactPhone.includes('@') ? found.data.contactPhone : `${found.data.contactPhone}@s.whatsapp.net`;
            const contactName = found.data.contactName || 'Contacto';
            const evtDesc = found.data.reason || 'el evento';
            const evtDate = found.data.scheduledForLocal || 'la fecha indicada';

            if (mode === 'avisar') {
              // Modo AVISAR: notificar cancelación simple
              safeSendMessage(contactJid,
                `📅 Hola ${contactName}, te aviso que ${evtDesc} programado para el ${evtDate} fue cancelado. Disculpa las molestias. 🙏`,
                {}
              ).catch(e => console.error(`[CANCELAR_EVENTO] ❌ Error notificando:`, e.message));
              console.log(`[CANCELAR_EVENTO] 📤 Notificación de cancelación enviada a ${contactName}`);

            } else if (mode === 'reagendar') {
              // Modo REAGENDAR: cancelar + ofrecer reagendar
              safeSendMessage(contactJid,
                `📅 Hola ${contactName}, lamentablemente ${evtDesc} del ${evtDate} tuvo que ser cancelado.\n\n` +
                `Pero no te preocupes, ¿te gustaría agendar otro horario? Decime qué día y hora te viene bien y lo coordinamos. 😊`,
                {}
              ).catch(e => console.error(`[CANCELAR_EVENTO] ❌ Error ofreciendo reagendar:`, e.message));
              console.log(`[CANCELAR_EVENTO] 📤 Oferta de reagendamiento enviada a ${contactName}`);

            } else if (mode === 'silencioso') {
              // Modo SILENCIOSO: no notificar
              console.log(`[CANCELAR_EVENTO] 🔇 Cancelación silenciosa — contacto ${contactName} NO notificado`);
            }
          }

          // Intentar eliminar de Google Calendar
          if (found.data.calendarSynced) {
            try {
              const { cal, calId } = await getCalendarClient(OWNER_UID);
              if (cal && found.data.calendarEventId) {
                await cal.events.delete({ calendarId: calId, eventId: found.data.calendarEventId });
                console.log(`[CANCELAR_EVENTO] 📅 Eliminado de Google Calendar`);
              }
            } catch (calErr) {
              console.warn(`[CANCELAR_EVENTO] ⚠️ Calendar: ${calErr.message}`);
            }
          }
        } else {
          console.warn(`[CANCELAR_EVENTO] ⚠️ No se encontró evento para "${searchReason}" el ${searchDate}`);
        }
      } catch (e) {
        console.error(`[CANCELAR_EVENTO] ❌ Error:`, e.message);
      }
      aiMessage = aiMessage.replace(/\[CANCELAR_EVENTO:[^\]]+\]/g, '').trim();
    }

    // ═══ TAG [MOVER_EVENTO:razón|fecha_vieja|fecha_nueva] — Mover evento del owner ═══
    const moverMatch = aiMessage.match(/\[MOVER_EVENTO:([^\]]+)\]/);
    if (moverMatch && isSelfChat) {
      const parts = moverMatch[1].split('|').map(p => p.trim());
      const [searchReason, oldDate, newDate] = parts;
      console.log(`[MOVER_EVENTO] 🔄 Buscando "${searchReason}" en ${oldDate} → mover a ${newDate}`);
      try {
        const searchDateObj = oldDate ? new Date(oldDate) : new Date();
        const dayStart = new Date(searchDateObj); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(searchDateObj); dayEnd.setHours(23, 59, 59, 999);

        const snap = await admin.firestore()
          .collection('users').doc(OWNER_UID).collection('miia_agenda')
          .where('status', '==', 'pending')
          .where('scheduledFor', '>=', dayStart.toISOString())
          .where('scheduledFor', '<=', dayEnd.toISOString())
          .orderBy('scheduledFor', 'asc')
          .limit(10)
          .get();

        let found = null;
        const reasonLower = (searchReason || '').toLowerCase();
        for (const doc of snap.docs) {
          const evt = doc.data();
          const evtReason = (evt.reason || '').toLowerCase();
          const evtContact = (evt.contactName || '').toLowerCase();
          if (evtReason.includes(reasonLower) || reasonLower.includes(evtReason) ||
              evtContact.includes(reasonLower) || reasonLower.includes(evtContact)) {
            found = { doc, data: evt };
            break;
          }
        }
        if (!found && !snap.empty) {
          found = { doc: snap.docs[0], data: snap.docs[0].data() };
        }

        if (found && newDate) {
          // Convertir nueva fecha a UTC
          const ownerCountryME = getCountryFromPhone(OWNER_PHONE);
          const ownerTzME = getTimezoneForCountry(ownerCountryME);
          let newScheduledUTC = newDate;
          try {
            const parsedLocal = new Date(newDate);
            if (!isNaN(parsedLocal)) {
              const localStr = new Date().toLocaleString('en-US', { timeZone: ownerTzME });
              const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
              const offsetMs = new Date(localStr) - new Date(utcStr);
              newScheduledUTC = new Date(parsedLocal.getTime() - offsetMs).toISOString();
            }
          } catch (tzErr) { /* usar original */ }

          await found.doc.ref.update({
            scheduledFor: newScheduledUTC,
            scheduledForLocal: newDate,
            movedFrom: found.data.scheduledForLocal,
            movedAt: new Date().toISOString(),
            preReminderSent: false // Reset reminder para nueva hora
          });
          console.log(`[MOVER_EVENTO] ✅ Evento movido: "${found.data.reason}" de ${found.data.scheduledForLocal} → ${newDate}`);

          // Actualizar Google Calendar si está sincronizado
          if (found.data.calendarSynced) {
            try {
              const hourMatch = newDate.match(/(\d{1,2}):(\d{2})/);
              const newHour = hourMatch ? parseInt(hourMatch[1]) : 10;
              const dateOnly = newDate.split('T')[0];
              const calResult = await createCalendarEvent({
                summary: found.data.reason || 'Evento MIIA',
                dateStr: dateOnly,
                startHour: newHour,
                endHour: newHour + 1,
                description: `Movido por MIIA. Antes: ${found.data.scheduledForLocal}`,
                uid: OWNER_UID,
                timezone: ownerTzME,
                eventMode: found.data.eventMode || 'presencial',
                location: found.data.eventLocation || '',
                reminderMinutes: 10
              });
              console.log(`[MOVER_EVENTO] 📅 Actualizado en Calendar`);
            } catch (calErr) {
              console.warn(`[MOVER_EVENTO] ⚠️ Calendar: ${calErr.message}`);
            }
          }

          // Notificar al contacto si corresponde
          if (found.data.contactPhone && found.data.contactPhone !== 'self') {
            const contactJid = found.data.contactPhone.includes('@') ? found.data.contactPhone : `${found.data.contactPhone}@s.whatsapp.net`;
            const newHora = newDate.includes('T') ? newDate.split('T')[1]?.substring(0, 5) : '';
            safeSendMessage(contactJid,
              `📅 Te aviso que ${found.data.reason || 'tu evento'} se movió al ${newDate.split('T')[0]} a las ${newHora || 'la nueva hora'}. ¡Nos vemos! 😊`,
              {}
            ).catch(e => console.error(`[MOVER_EVENTO] ❌ Error notificando contacto:`, e.message));
          }
        } else {
          console.warn(`[MOVER_EVENTO] ⚠️ No se encontró evento o falta fecha nueva`);
        }
      } catch (e) {
        console.error(`[MOVER_EVENTO] ❌ Error:`, e.message);
      }
      aiMessage = aiMessage.replace(/\[MOVER_EVENTO:[^\]]+\]/g, '').trim();
    }

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
          if (getOwnerSock()) await getOwnerSock().sendPresenceUpdate('composing', phone);
          await new Promise(r => setTimeout(r, Math.min(parts[0].length * 60, 12000)));
        } catch (e) { /* ignore */ }
        await safeSendMessage(phone, parts[0]);
        await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
        try {
          if (getOwnerSock()) await getOwnerSock().sendPresenceUpdate('composing', phone);
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
      if (getOwnerSock()) await getOwnerSock().sendPresenceUpdate('composing', phone);
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
    console.log(`[MIIA] Enviando mensaje a ${phone} | isReady=${isReady} | isSystemPaused=${isSystemPaused} | isSelfChat=${isSelfChat}`);

    // ═══ EMOJI: Detectar mood del owner/contacto + trigger para emoji contextual ═══
    const ownerMood = detectOwnerMood(userMessage || '');

    // ═══ SLEEP MODE: Si MIIA está dormida, no responde conversacionalmente ═══
    if (isMiiaSleeping()) {
      console.log(`[MIIA-SLEEP] 😴 MIIA dormida — no responde a ${phone}. Solo recordatorios activos.`);
      return; // No enviar respuesta conversacional
    }

    // ═══ MOOD ESPECIALES: sleep y apologized ═══
    if (ownerMood === 'sleep') {
      // MIIA se va a dormir — enviar aviso y dejar de responder
      const sleepMsg = 'Bueno... me voy a dormir. A la próxima me quedo callada hasta mañana. Tus recordatorios van a seguir llegando, pero sin mí. Descansá.';
      await safeSendMessage(phone, sleepMsg, { isSelfChat, skipEmoji: true });
      console.log(`[MIIA-SLEEP] 😴 MIIA activó modo sleep por 5+ ciclos insulto→disculpa`);
      return;
    }

    if (ownerMood === 'apologized') {
      // MIIA agradece la disculpa — inyectar en el prompt actual no alcanza, agregamos al mensaje
      aiMessage = aiMessage + '\n\n_Gracias por las disculpas. Ya estamos bien._';
    }

    const isGreeting = /\b(hola|buenos?\s*d[ií]as?|buenas?\s*(tardes?|noches?)|hey)\b/i.test(userMessage || '');
    const isFarewell = /\b(chau|adi[oó]s|nos vemos|hasta\s*(luego|ma[ñn]ana))\b/i.test(userMessage || '');
    const emojiCtx = {
      ownerMood,
      trigger: isGreeting ? 'greeting' : isFarewell ? 'farewell' : isSelfChat ? 'general_work' : 'general',
    };

    // ═══ TTS: Responder con audio SOLO cuando el owner manda audio ═══
    let sentAsAudio = false;
    // mediaContext only exists in messages.upsert handler, not here
    const incomingWasAudio = false;

    // Detección de preferencia de audio/texto del owner
    if (!incomingWasAudio && /\b(prefer\w*\s+texto|respond[eé]\s+(?:con\s+)?texto|no\s+(?:me\s+)?(?:mand|envi)[eé]s?\s+audio|sin\s+audio|solo\s+texto)\b/i.test(userMessage || '')) {
      ttsEngine.setAudioPreference(phone, false);
    }
    if (/\b(prefer\w*\s+audio|respond[eé]\s+(?:con\s+)?audio|mand[aá]me\s+audio|con\s+audio|en\s+audio)\b/i.test(userMessage || '')) {
      ttsEngine.setAudioPreference(phone, true);
    }
    try {
      const voiceConfig = await ttsEngine.loadVoiceConfig(admin, OWNER_UID);
      const shouldAudio = ttsEngine.shouldRespondWithAudio({
        voiceConfig,
        incomingWasAudio,
        contactType: isAdmin ? 'owner' : (isFamilyContact ? 'family' : 'lead'),
        messageLength: aiMessage.length,
        contactPhone: phone,
      });

      // Niñera SIEMPRE responde con audio si el entrante fue audio
      const forceAudio = isNineraMode && incomingWasAudio;

      if (shouldAudio || forceAudio) {
        // ¿Es el primer audio para este contacto? → Preguntar preferencia
        if (!isNineraMode && ttsEngine.isFirstAudioForContact(phone)) {
          ttsEngine.setAudioPreference(phone, true); // Default: audio (ya que mandó audio)
          // Enviar respuesta como texto + pregunta
          const pregunta = `\n\n_¿Preferís que te siga respondiendo con audio o con texto? Decime "prefiero audio" o "prefiero texto" 🎤_`;
          await safeSendMessage(phone, aiMessage + pregunta, { isSelfChat, emojiCtx });
          console.log(`[TTS] 🎤 Primer audio de ${phone} — preguntando preferencia`);
        } else {
          // Generar y enviar audio
          const ttsMode = isNineraMode ? 'ninera' : 'adult';
          const ttsConfig = {
            provider: voiceConfig?.tts_provider || 'google',
            apiKey: voiceConfig?.tts_api_key || process.env.GOOGLE_TTS_API_KEY,
            voiceId: voiceConfig?.voice_group || undefined,
            mode: ttsMode,
          };
          const ttsResult = await ttsEngine.generateTTS(aiMessage, ttsConfig);
          await ttsEngine.sendAudioMessage(safeSendMessage, phone, ttsResult.buffer, ttsResult.mimetype, { isSelfChat });
          sentAsAudio = true;
          console.log(`[TTS] 🎤 Respuesta enviada como audio (${ttsMode}) a ${phone}`);
        }
      }
    } catch (e) {
      console.error(`[TTS] ⚠️ Error generando audio, fallback a texto:`, e.message);
    }

    // Si no se envió como audio, enviar como texto con emoji
    if (!sentAsAudio) {
      await safeSendMessage(phone, aiMessage, { isSelfChat, emojiCtx });
    }

    io.emit('ai_response', {
      to: phone,
      toName: leadNames[phone] || basePhone,
      body: aiMessage,
      timestamp: Date.now(),
      type: contactTypes[phone] || 'lead'
    });

    // Enviar preguntas de aprendizaje pendientes a Mariano
    if (isAdmin && conversationMetadata[phone]?.pendingLearningQuestions?.length > 0) {
      const pendingQuestions = conversationMetadata[phone].pendingLearningQuestions;
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000)); // Esperar un poco para naturalidad

      for (let i = 0; i < pendingQuestions.length; i++) {
        const question = pendingQuestions[i];
        const preview = question.text.substring(0, 250) + (question.text.length > 250 ? '...' : '');
        const questionText = `🤔 Confianza: ${question.confidence}% — ¿Debería memorizar esto permanentemente?\n\n"${preview}"`;

        await safeSendMessage(phone, questionText);
        console.log(`[LEARNING] 📬 Pregunta enviada a Mariano sobre: "${question.text.substring(0, 60)}..."`);

        // Esperar entre preguntas
        if (i < pendingQuestions.length - 1) {
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));
        }
      }

      // Limpiar metadata después de enviar preguntas
      conversationMetadata[phone].pendingLearningQuestions = [];
    }

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
const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
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
  let media;

  // Baileys adapter: message._baileysMsg contains the raw Baileys message
  if (message._baileysMsg) {
    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      const buffer = await Promise.race([
        downloadMediaMessage(message._baileysMsg, 'buffer', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timeout')), MEDIA_TIMEOUT_MS))
      ]);
      if (!buffer) return { text: null, mediaType: 'unknown' };
      const msgContent = message._baileysMsg.message;
      const mimetype = msgContent?.imageMessage?.mimetype
        || msgContent?.audioMessage?.mimetype
        || msgContent?.videoMessage?.mimetype
        || msgContent?.documentMessage?.mimetype
        || msgContent?.stickerMessage?.mimetype
        || 'application/octet-stream';
      media = { data: buffer.toString('base64'), mimetype };
    } catch (e) {
      console.error(`[MEDIA] Baileys download error:`, e.message);
      return { text: null, mediaType: 'unknown' };
    }
  } else {
    // ❌ CRITICAL: This path should NEVER execute. whatsapp-web.js is deprecated.
    // If we reach here, message structure is broken: missing _baileysMsg field.
    // This indicates a critical bug in message processing.
    // Google/Amazon/NASA standard: FAIL LOUDLY, don't silently return null.
    const errorMsg =
      '[CRITICAL] Message structure violation: _baileysMsg field missing. ' +
      'All messages from Baileys MUST have _baileysMsg. ' +
      'This indicates broken message handling pipeline.';
    console.error(`[MEDIA] ${errorMsg}`);
    console.error('[MEDIA] Message object:', JSON.stringify({
      hasMedia: message.hasMedia,
      keys: Object.keys(message).slice(0, 5)
    }));
    // Throw instead of returning null — forces visibility in monitoring
    throw new Error(errorMsg);
  }

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

  const url = `${GEMINI_FLASH_URL}?key=${getGeminiKey()}`;
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
    shield.recordFail(shield.SYSTEMS.GEMINI, `MEDIA_${response.status}`, { statusCode: response.status });

    // Fallback: si 429/403, reintentar con key alternativa
    if ((response.status === 429 || response.status === 403) && GEMINI_KEYS.length > 1) {
      const fallbackKey = getGeminiFallbackKey(url.split('key=')[1]);
      console.log(`[MEDIA] ♻️ Reintentando media con key alternativa...`);
      const retryUrl = `${GEMINI_FLASH_URL}?key=${fallbackKey}`;
      try {
        const retryResp = await fetch(retryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          timeout: MEDIA_TIMEOUT_MS
        });
        if (retryResp.ok) {
          const retryData = await retryResp.json();
          const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (retryText?.trim()) {
            console.log(`[MEDIA] ✅ Fallback key exitoso para ${mediaType} (${retryText.length} chars)`);
            shield.recordSuccess(shield.SYSTEMS.GEMINI);
            media.data = null;
            media = null;
            return { text: retryText.trim(), mediaType };
          }
        }
      } catch (retryErr) {
        console.error(`[MEDIA] Fallback key también falló: ${retryErr.message}`);
      }
    }
    return { text: null, mediaType };
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) {
    return { text: null, mediaType };
  }

  // Liberar memoria: descartar el buffer de media inmediatamente
  // Solo conservamos el TEXTO interpretado, nunca el archivo original
  media.data = null;
  media = null;

  console.log(`[MEDIA] ${mediaType} procesado OK (${text.length} chars) — media descartada de RAM`);
  return { text: text.trim(), mediaType };
}

// ============================================
// SISTEMA DE RESPUESTA AUTOMÁTICA (message_create)
// ============================================

async function handleIncomingMessage(message) {
  // LOG DE DIAGNÓSTICO: cada mensaje que entra a handleIncomingMessage
  console.log(`[HIM] 📩 from=${message.from} to=${message.to} fromMe=${message.fromMe} body="${(message.body||'').substring(0,50)}" hasMedia=${message.hasMedia} type=${message.type} id=${message.id?._serialized||'?'}`);

  // ═══ REACCIONES: responder inteligentemente a emojis ═══
  if (message.type === 'reaction' && message._reaction) {
    const { emoji, targetMsgId } = message._reaction;
    const fromNum = message.from.split('@')[0].split(':')[0];
    const ownerNum = OWNER_PHONE;
    const isSelfChat = message.fromMe || fromNum === ownerNum;

    // Reacción vacía = reacción removida → ignorar
    if (!emoji) return;

    // Owner reaccionó → solo acknowledge
    if (message.fromMe) {
      console.log(`[REACTION] Owner reaccionó con ${emoji} — acknowledged`);
      return;
    }

    console.log(`[REACTION] ${fromNum} reaccionó con ${emoji} a ${targetMsgId} (selfChat=${isSelfChat})`);

    // Ratio 30%: solo responder ~30% de las veces (sentido común)
    const shouldRespond = Math.random() < 0.50;
    if (!shouldRespond) {
      console.log(`[REACTION] Skip (ratio 30%) — no responder esta vez`);
      return;
    }

    // Clasificar emoción del emoji
    const POSITIVE_EMOJIS = ['👍', '❤️', '😍', '🔥', '💪', '👏', '🙌', '💯', '✨', '🥰', '😘', '💕', '🫶', '⭐', '🤩'];
    const NEGATIVE_EMOJIS = ['👎', '😢', '😭', '😡', '🤬', '💔', '😤', '😞', '😔', '🥺'];
    const FUNNY_EMOJIS = ['😂', '🤣', '😆', '😜', '🤪', '💀', '☠️'];
    const SURPRISE_EMOJIS = ['😮', '😱', '🤯', '😳', '🫢', '👀'];
    const SWEET_EMOJIS = ['🥹', '🤗', '😊', '☺️', '💗', '🫂', '💝'];

    let reactionEmojis;
    if (POSITIVE_EMOJIS.includes(emoji)) {
      reactionEmojis = ['💪', '🔥', '😎', '✨', '🫶', '💯', '🙌'];
    } else if (NEGATIVE_EMOJIS.includes(emoji)) {
      reactionEmojis = ['🫂', '💪', '❤️', '🤗'];
    } else if (FUNNY_EMOJIS.includes(emoji)) {
      reactionEmojis = ['😂', '🤣', '💀', '😜'];
    } else if (SURPRISE_EMOJIS.includes(emoji)) {
      reactionEmojis = ['👀', '🤯', '😱', '🔥'];
    } else if (SWEET_EMOJIS.includes(emoji)) {
      reactionEmojis = ['🥹', '❤️', '🫶', '💕'];
    } else {
      // Emoji no clasificado → responder con el mismo o similar
      reactionEmojis = [emoji, '👀', '✨'];
    }

    // Modo emoji-only: responder SOLO con un emoji (sin prefijo de MIIA)
    const responseEmoji = reactionEmojis[Math.floor(Math.random() * reactionEmojis.length)];
    console.log(`[REACTION] Respondiendo con emoji: ${responseEmoji}`);
    await safeSendMessage(message.from, responseEmoji);
    return;
  }

  // ANTI-RÁFAGA INTELIGENTE: Mensajes offline se procesan con contexto
  // El buffer en tenant_manager acumula y envía solo el último por contacto
  // Aquí solo filtramos self-chat MUY viejo (>10 min) del owner
  const msgAge = ownerConnectedAt && message.timestamp > 0 ? ownerConnectedAt - message.timestamp : 0;
  const isOfflineMsg = msgAge > 5;
  if (isOfflineMsg) {
    const ownerNum = (getOwnerSock() && getOwnerSock().user) ? getOwnerSock().user.id.split('@')[0].split(':')[0] : OWNER_PHONE;
    const fromNum = message.from.split('@')[0].split(':')[0];
    const isSelfChatMsg = message.fromMe || fromNum === ownerNum;

    // Self-chat MUY viejo (>10 min) → ignorar
    if (isSelfChatMsg && msgAge > 600) {
      console.log(`[HIM] ⏭️ Self-chat offline MUY viejo ignorado (${Math.round(msgAge/60)}min) body="${(message.body||'').substring(0,30)}"`);
      return;
    }

    // Inyectar contexto offline (viene del buffer de tenant_manager)
    const offlineCtx = message._baileysMsg?._offlineContext;
    if (offlineCtx) {
      const prefix = offlineCtx.totalMessages > 1
        ? `[CONTEXTO INTERNO - NO MENCIONAR TEXTUALMENTE: ${isSelfChatMsg ? 'Escribiste' : 'El contacto envió'} ${offlineCtx.totalMessages} mensajes mientras estabas offline (hace ${offlineCtx.ageLabel}). Mensajes: ${offlineCtx.allBodies.map(b => `"${b.substring(0,60)}"`).join(', ')}. Responde SOLO al último considerando TODO el contexto. Sé conciso y natural.]\n`
        : `[CONTEXTO INTERNO - NO MENCIONAR TEXTUALMENTE: Mensaje de hace ${offlineCtx.ageLabel}. Responde naturalmente y conciso.]\n`;
      message.body = prefix + message.body;
      console.log(`[HIM] 🔄 Mensaje offline procesado con contexto (${offlineCtx.totalMessages} msgs, hace ${offlineCtx.ageLabel}, ${isSelfChatMsg ? 'self-chat' : 'contacto'})`);
    }
  }

  // REGLA ABSOLUTA: MIIA nunca participa en grupos ni estados. Ni lee, ni responde, ni publica.
  const isBroadcast = message.from.includes('status@broadcast') ||
    (message.to && message.to.includes('status@broadcast')) ||
    message.isStatus;
  const isGroup = message.from.endsWith('@g.us') || (message.to && message.to.endsWith('@g.us'));
  if (isBroadcast || isGroup) return;

  // Eco de linked device: SOLO del owner (from === to, no fromMe, y es el número del owner)
  // Baileys con LID: contactos externos también llegan con from===to (su propio LID), eso NO es eco
  if (message.from && message.to && message.from === message.to && !message.fromMe) {
    const ownerNum = (getOwnerSock() && getOwnerSock().user) ? getOwnerSock().user.id.split('@')[0].split(':')[0] : OWNER_PHONE;
    const fromNum = message.from.split('@')[0].split(':')[0];
    if (fromNum === ownerNum) return; // Solo descartar si es eco del owner
  }

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

      // ═══ DETECCIÓN DE NIÑO EN AUDIO ═══
      // Si es audio desde el self-chat del owner, analizar si es un niño hablando
      if (mediaContext.mediaType === 'audio' && message.fromMe) {
        try {
          const childDetection = await kidsMode.detectChildFromTranscription(body, generateAIContent);
          if (childDetection.isChild && childDetection.confidence !== 'low') {
            console.log(`[KIDS] 👶 Niño detectado en audio del owner! Edad estimada: ${childDetection.estimatedAge}`);
            // Marcar mensaje como niñera para que el handler use el prompt correcto
            message._isChildAudio = true;
            message._childDetection = childDetection;
          }
        } catch (e) {
          console.error('[KIDS] Error en detección de niño:', e.message);
        }
      }
    } else {
      // FALLBACK: no se pudo interpretar → avisar al lead + alertar a Mariano
      const tipoLabel = { ptt: 'audio', audio: 'audio', image: 'imagen', video: 'video', document: 'documento' }[msgType] || 'archivo';
      const leadPhone = message.from;
      const leadName = leadNames[leadPhone] || leadPhone.split('@')[0];

      const isSelfChatMedia = message.fromMe && leadPhone.includes(OWNER_PHONE);

      if (isSelfChatMedia) {
        // Self-chat: avisar al owner de forma directa
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
          `🙍‍♀️: No pude procesar tu ${tipoLabel}, jefe. Puede ser un tema temporal con la IA. Intentá de nuevo en unos minutos.`,
          { isSelfChat: true }
        );
        console.log(`[MEDIA] Self-chat: ${tipoLabel} no procesado — avisé al owner`);
      } else {
        // Lead/Contacto: responder naturalmente sin delatar que es IA (con variaciones)
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const mediaErrorVariations = {
          audio: [
            'Ay... No logro escucharlo, está en silencio 😬',
            'No me llegó el audio bien, se cortó 😅',
            'Mmm no se escucha nada, será que se grabó sin sonido?',
            'No pude escuchar el audio 🤷‍♀️',
            'Se ve que el audio no se grabó bien, no escucho nada 😬',
          ],
          imagen: [
            'Hmm, no me cargó la imagen 🙏',
            'No se ve la imagen, capaz se envió mal',
            'La imagen no me llegó bien 😅',
            'No logro ver la imagen, será la conexión?',
          ],
          video: [
            'No me cargó el video 😅',
            'El video no se reprodujo, no sé qué pasó',
            'Mmm no puedo ver el video 🤷‍♀️',
            'El video no me llegó bien',
          ],
          documento: [
            'No pude abrir el archivo 🤷‍♀️',
            'El archivo no se abrió, capaz se corrompió',
            'No logro abrir el documento 😅',
            'Mmm el archivo no me carga',
          ],
        };
        const naturalMsg = pick(mediaErrorVariations[tipoLabel] || mediaErrorVariations.documento);
        await safeSendMessage(leadPhone, naturalMsg);
        // Alertar al owner en self-chat
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
          `⚠️ *MEDIA NO PROCESADA*\n` +
          `Contacto: *${leadName}* (${leadPhone.split('@')[0]})\n` +
          `Tipo: ${tipoLabel}\n` +
          `Respondí: "${naturalMsg}"\nTomá el control si es urgente.`,
          { isSelfChat: true }
        );
        console.log(`[MEDIA] Fallback natural enviado a ${leadPhone}, alerta al owner`);
      }
      return;
    }
  }
  if (!body) return;


  // Guardia de bucle por contenido (buffer de IA)
  const targetPhoneId = fromMe ? message.to : message.from;
  const botBuffer = lastSentByBot[targetPhoneId] || [];
  const isBotSessionMessage = sentMessageIds.has(message.id._serialized) || botBuffer.includes(body);
  if (isBotSessionMessage) {
    console.log(`[WA] BUCLE PREVENIDO: ${targetPhoneId} | body="${(body||'').substring(0,50)}" | sentId=${sentMessageIds.has(message.id._serialized)} | botBuf=${botBuffer.includes(body)}`);
    return;
  }

  // Guardia de auto-bucle (self-chat)
  const myNumber = (getOwnerSock() && getOwnerSock().user)
    ? getOwnerSock().user.id : `${OWNER_PHONE}@s.whatsapp.net`;
  const isSelfChat = targetPhoneId === myNumber || targetPhoneId.split('@')[0] === myNumber.split('@')[0].split(':')[0];
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
    if (!selfChatLoopCounter[targetPhoneId] || typeof selfChatLoopCounter[targetPhoneId] === 'number') {
      selfChatLoopCounter[targetPhoneId] = { count: 0, lastTime: 0 };
    }
    if (now - lastInt < 20000) {
      selfChatLoopCounter[targetPhoneId].count++;
    } else {
      selfChatLoopCounter[targetPhoneId].count = 0;
    }
    selfChatLoopCounter[targetPhoneId].lastTime = now;
    if (selfChatLoopCounter[targetPhoneId].count >= 3) {
      console.warn(`[HIM] ⚠️ Self-chat loop detected (${selfChatLoopCounter[targetPhoneId].count} msgs in <20s) for ${targetPhoneId} — pausing MIIA`);
      if (!conversationMetadata[targetPhoneId]) conversationMetadata[targetPhoneId] = {};
      conversationMetadata[targetPhoneId].miiaFamilyPaused = true;
      return;
    }
  }
  lastInteractionTime[targetPhoneId] = now;

  // ═══ PROTECCIÓN: Guardar ubicación compartida via WhatsApp ═══
  try {
    const rawMsg = message._data || message;
    const locMsg = rawMsg?.message?.locationMessage || rawMsg?.message?.liveLocationMessage;
    if (locMsg && locMsg.degreesLatitude && locMsg.degreesLongitude) {
      const senderPhone = message.from?.split('@')[0]?.split(':')[0] || '';
      // Buscar UID del sender en Firestore
      const userSnap = await admin.firestore().collection('users')
        .where('phone', '==', senderPhone).limit(1).get();
      if (!userSnap.empty) {
        const senderUid = userSnap.docs[0].id;
        await protectionManager.saveSharedLocation(senderUid, locMsg.degreesLatitude, locMsg.degreesLongitude);
        console.log(`[PROTECTION] 📍 Ubicación guardada para ${senderPhone}: ${locMsg.degreesLatitude}, ${locMsg.degreesLongitude}`);
      }
    }
  } catch (locErr) {
    // No fallar silenciosamente pero no bloquear el flujo
    console.warn(`[PROTECTION] ⚠️ Error procesando ubicación: ${locErr.message}`);
  }

  // ═══ PROTECCIÓN: Detección automática KIDS/ABUELOS (silenciosa) ═══
  if (!fromMe && body && !isSelfChat) {
    try {
      const senderPhone = (message.from || '').split('@')[0]?.split(':')[0] || '';
      const msgHistory = (conversations[targetPhoneId] || []).filter(m => m.role === 'user').slice(-5);
      const detected = protectionManager.detectProtectionMode(body, msgHistory);
      if (detected) {
        // Verificar si ya tiene modo configurado
        const userSnap = await admin.firestore().collection('users')
          .where('phone', '==', senderPhone).limit(1).get();
        if (!userSnap.empty) {
          const senderUid = userSnap.docs[0].id;
          const protConfig = await admin.firestore().collection('users').doc(senderUid)
            .collection('protection').doc('config').get();
          const existingMode = protConfig.exists ? protConfig.data().mode : null;
          if (!existingMode) {
            await protectionManager.activateProtectionMode(senderUid, detected, {
              detectedAutomatically: true,
              phone: senderPhone
            });
            console.log(`[PROTECTION] 🛡️ Modo ${detected} DETECTADO automáticamente para ${senderPhone}`);
          }
        }
      }
    } catch (protErr) {
      console.warn(`[PROTECTION] ⚠️ Error en detección automática: ${protErr.message}`);
    }
  }

  // ═══ PROTECCIÓN: Comandos selfchat del owner para vincular/desvincular ═══
  if (isSelfChat && body) {
    const bodyLower = body.toLowerCase().trim();

    // "proteger a mi hijo Lucas 8 años" o "proteger a mi mamá María 75 años"
    const protectMatch = bodyLower.match(/^proteger\s+a\s+(?:mi\s+)?(hijo|hija|mamá|mama|papá|papa|abuelo|abuela)\s+(.+?)\s+(\d{1,3})\s*(?:años|a[ñn]os)$/i);
    if (protectMatch) {
      const [, , name, ageStr] = protectMatch;
      const age = parseInt(ageStr);
      const isMinor = age < 18;
      const isElderly = age >= 70;
      const mode = isMinor ? 'kids' : (isElderly ? 'elderly' : null);

      if (mode) {
        // Generar OTP para que el protegido lo apruebe
        const otp = await protectionManager.createLinkOTP(OWNER_UID, OWNER_PHONE, name.trim());
        const modeLabel = mode === 'kids' ? 'Protección KIDS' : 'Protección ABUELOS';
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
          `🛡️ *${modeLabel}* para ${name.trim()} (${age} años)\n\nPara vincular, envía este código en el selfchat de ${name.trim()}:\n\n🔑 *${otp}*\n\nExpira en 24 horas.`,
          { isSelfChat: true, skipEmoji: true }
        );
        console.log(`[PROTECTION] 🔑 OTP generado para vincular ${name.trim()} en modo ${mode}`);
        return;
      } else {
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
          `ℹ️ Modo Protección aplica para menores de 18 años (KIDS) o mayores de 70 años (ABUELOS). ${name.trim()} tiene ${age} años.`,
          { isSelfChat: true, skipEmoji: true }
        );
        return;
      }
    }

    // "tengo X años" — menor informando su edad para desvinculación
    const ageMatch = bodyLower.match(/^tengo\s+(\d{1,2})\s*(?:años|a[ñn]os)$/i);
    if (ageMatch) {
      const age = parseInt(ageMatch[1]);
      try {
        const result = await protectionManager.checkAgeAutonomy(OWNER_UID, age, OWNER_PHONE);
        if (result.eligible) {
          // Iniciar proceso de desvinculación
          const unlinkResult = await protectionManager.initiateAgeUnlink(OWNER_UID, OWNER_PHONE, 'el menor');
          if (unlinkResult.success) {
            await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `🔓 Tienes ${age} años y en ${result.country} puedes gestionar tus datos de forma independiente (edad legal: ${result.autonomyAge} años).\n\nSe ha enviado una solicitud de autorización a tus padres/tutores. Cuando te envíen el código, pégalo aquí.`,
              { isSelfChat: true, skipEmoji: true }
            );
          }
        }
      } catch (e) {
        console.warn(`[PROTECTION] Error verificando edad: ${e.message}`);
      }
    }

    // ═══ SEGMENTOS PROFESIONALES: "soy médico", "soy abogado", etc. ═══
    const PROFESSIONAL_SEGMENTS = {
      medico:    { pattern: /^soy\s+(m[eé]dic[oa]|doctor[a]?|odont[oó]log[oa]|dentista|fisioterapeuta|kinesiólog[oa]|nutricionista|psic[oó]log[oa]|veterinari[oa])$/i,
                   label: 'Médico / Salud', work: { duration: 20, breathing: 5, hours: '08:00-20:00', days: [1,2,3,4,5,6] }, personal: { duration: 60, breathing: 15, days: [0] }, defaultMode: 'presencial' },
      abogado:   { pattern: /^soy\s+(abogad[oa]|notar[oi][oa]?|escriban[oa])$/i,
                   label: 'Abogado / Legal', work: { duration: 45, breathing: 15, hours: '09:00-18:00', days: [1,2,3,4,5] }, personal: { duration: 90, breathing: 20, days: [0,6] }, defaultMode: 'presencial' },
      coach:     { pattern: /^soy\s+(coach|coaching|mentor[a]?|consultor[a]?|asesor[a]?|terapeuta)$/i,
                   label: 'Coach / Consultor', work: { duration: 50, breathing: 10, hours: '08:00-21:00', days: [1,2,3,4,5,6] }, personal: { duration: 90, breathing: 15, days: [0] }, defaultMode: 'virtual' },
      profesor:  { pattern: /^soy\s+(profesor[a]?|maestr[oa]|docente|tutor[a]?|instructor[a]?)$/i,
                   label: 'Profesor / Educación', work: { duration: 45, breathing: 10, hours: '08:00-20:00', days: [1,2,3,4,5] }, personal: { duration: 60, breathing: 15, days: [0,6] }, defaultMode: 'virtual' },
      fitness:   { pattern: /^soy\s+(entrenador[a]?|personal\s*trainer|preparador[a]?\s*f[ií]sic[oa]|instructor[a]?\s*(?:de\s+)?(?:gym|fitness|yoga|pilates))$/i,
                   label: 'Fitness / Entrenamiento', work: { duration: 60, breathing: 10, hours: '06:00-22:00', days: [1,2,3,4,5,6] }, personal: { duration: 60, breathing: 15, days: [0] }, defaultMode: 'presencial' },
      inmobiliaria: { pattern: /^soy\s+((?:agente\s+)?inmobiliari[oa]|realtor|corredor[a]?\s*(?:de\s+)?(?:propiedades|bienes\s+ra[ií]ces))$/i,
                   label: 'Inmobiliaria', work: { duration: 30, breathing: 15, hours: '09:00-19:00', days: [1,2,3,4,5,6] }, personal: { duration: 90, breathing: 20, days: [0] }, defaultMode: 'presencial' },
      contador:  { pattern: /^soy\s+(contador[a]?|contable|auditor[a]?)$/i,
                   label: 'Contador / Finanzas', work: { duration: 45, breathing: 10, hours: '09:00-18:00', days: [1,2,3,4,5] }, personal: { duration: 60, breathing: 15, days: [0,6] }, defaultMode: 'virtual' },
    };

    for (const [segKey, seg] of Object.entries(PROFESSIONAL_SEGMENTS)) {
      if (seg.pattern.test(bodyLower)) {
        try {
          await admin.firestore().collection('users').doc(OWNER_UID)
            .collection('settings').doc('schedule_config').set({
              work: seg.work,
              personal: seg.personal,
              reminderMinutes: 10,
              defaultMode: seg.defaultMode,
              segment: segKey,
              segmentLabel: seg.label,
              calendarEmail: null,
              configuredAt: new Date().toISOString(),
              configuredBy: 'segment_auto'
            }, { merge: true });

          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
            `✅ *Segmento: ${seg.label}*\n\nConfiguré tu agenda con estos valores optimizados:\n\n` +
            `🏢 *Trabajo*: turnos de ${seg.work.duration} min, ${seg.work.breathing} min de respiro, ${seg.work.hours}\n` +
            `👤 *Personal*: eventos de ${seg.personal.duration} min, ${seg.personal.breathing} min de respiro\n` +
            `📍 *Modo*: ${seg.defaultMode} por defecto\n` +
            `⏰ *Recordatorio*: 10 minutos antes\n\n` +
            `Puedes ajustar cualquier valor. Ej: "mis turnos duran 30 minutos" o "trabajo de 10 a 19".`,
            { isSelfChat: true, skipEmoji: true }
          );
          console.log(`[AGENDA] 🏷️ Segmento profesional configurado: ${seg.label} para ${OWNER_UID}`);
        } catch (segErr) {
          console.error(`[AGENDA] ❌ Error configurando segmento ${segKey}: ${segErr.message}`);
        }
        return; // Procesado, no enviar a IA
      }
    }
  }


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
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
        `🎉 *¡Nuevo cliente!* ${clientName} acaba de convertirse en cliente de Medilink.`,
        { isSelfChat: true }
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
    console.log(`[WA] ECO-IA PREVENIDO: ${targetPhone} | body="${(body||'').substring(0,50)}"`);
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
    // B1 DIAGNOSTIC: Log al entrar en try-block para rastrear returns silenciosos
    console.log(`[HIM-TRACE] 📍 Processing: from=${phone} fromMe=${fromMe} body="${(body||'').substring(0,30)}" to=${message.to||'?'}`);
    // NOTA: message es un objeto adaptado de Baileys, NO tiene getContact()/getChat()

    // Fix @lid para mensajes ENTRANTES: resolver LID a número real
    if (!fromMe && phone.includes('@lid')) {
      const resolved = resolveLid(phone);
      if (resolved !== phone) {
        console.log(`[LID-MAP] ✅ Resuelto entrante: ${phone} → ${resolved}`);
        phone = resolved;
      } else {
        // Fallback 1: buscar pushName en TODOS los contactos conocidos (leadNames + familyContacts + equipoMedilink)
        let lidResolved = false;
        if (message.pushName) {
          const pushLower = message.pushName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

          // 1A: Buscar en leadNames
          for (const [knownPhone, knownName] of Object.entries(leadNames || {})) {
            if (knownName && knownName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === pushLower && knownPhone.includes('@s.whatsapp.net')) {
              console.log(`[LID-MAP] 🔗 Matched LID via leadNames pushName: ${phone} → ${knownPhone} (${message.pushName})`);
              registerLidMapping(phone, knownPhone);
              phone = knownPhone;
              lidResolved = true;
              break;
            }
          }

          // 1B: Buscar en familyContacts (por name o fullName)
          if (!lidResolved) {
            for (const [baseNum, fData] of Object.entries(familyContacts || {})) {
              const fName = (fData.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const fFull = (fData.fullName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              if (fName === pushLower || fFull === pushLower || pushLower.includes(fName) || fName.includes(pushLower)) {
                const resolvedJid = `${baseNum}@s.whatsapp.net`;
                console.log(`[LID-MAP] 🔗 Matched LID via familyContacts: ${phone} → ${resolvedJid} (pushName="${message.pushName}" matched family="${fData.name}")`);
                registerLidMapping(phone, resolvedJid);
                phone = resolvedJid;
                lidResolved = true;
                break;
              }
            }
          }

          // 1C: Buscar en equipoMedilink (por name)
          if (!lidResolved) {
            for (const [baseNum, eData] of Object.entries(equipoMedilink || {})) {
              if (eData.name) {
                const eName = eData.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                if (eName === pushLower || pushLower.includes(eName) || eName.includes(pushLower)) {
                  const resolvedJid = `${baseNum}@s.whatsapp.net`;
                  console.log(`[LID-MAP] 🔗 Matched LID via equipoMedilink: ${phone} → ${resolvedJid} (pushName="${message.pushName}" matched equipo="${eData.name}")`);
                  registerLidMapping(phone, resolvedJid);
                  phone = resolvedJid;
                  lidResolved = true;
                  break;
                }
              }
            }
          }
        }

        if (!lidResolved && phone.includes('@lid')) {
          console.log(`[LID-MAP] ⚠️ No se pudo resolver LID: ${phone} (pushName="${message.pushName || 'N/A'}") — procesando con LID`);
        }
      }
    }

    let effectiveTarget = phone;
    if (fromMe) {
      if (message.to && message.to.includes('@lid')) {
        // WhatsApp Linked Devices: message.to llega como @lid en lugar de @s.whatsapp.net
        const senderBase = (message.from || phone).split('@')[0];
        const recipientBase = message.to.split(':')[0].split('@')[0];
        if (senderBase === recipientBase) {
          // Self-chat explícito (mismo número)
          effectiveTarget = `${senderBase}@s.whatsapp.net`;
        } else {
          // Verificar si el sender es el dueño de la cuenta conectada (self-chat vía linked device)
          const connectedBase = (getOwnerSock() && getOwnerSock().user)
            ? getOwnerSock().user.id.split('@')[0].split(':')[0] : null;
          if (connectedBase && connectedBase === senderBase) {
            // El dueño se escribe a sí mismo desde otro dispositivo → self-chat
            effectiveTarget = `${senderBase}@s.whatsapp.net`;
          } else {
            effectiveTarget = `${recipientBase}@s.whatsapp.net`;
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
    // SAFETY NET: Si aún es LID no resuelto, intentar match por pushName en familyContacts
    // Esto cubre el caso donde el fallback anterior no encontró match (pushName parcial, acentos, etc.)
    const lidPushName = message.pushName || message._baileysMsg?.pushName;
    if (!isAllowed && effectiveTarget.includes('@lid') && lidPushName) {
      const pn = lidPushName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      for (const [baseNum, fData] of Object.entries(familyContacts)) {
        const fn = (fData.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const ffn = (fData.fullName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (fn && (pn === fn || pn === ffn || pn.includes(fn) || fn.includes(pn))) {
          const resolvedJid = `${baseNum}@s.whatsapp.net`;
          console.log(`[LID-MAP] 🛡️ SAFETY NET: LID ${effectiveTarget} matched family "${fData.name}" via pushName "${lidPushName}" → ${resolvedJid}`);
          registerLidMapping(effectiveTarget, resolvedJid);
          phone = resolvedJid;
          effectiveTarget = resolvedJid;
          isAllowed = true;
          break;
        }
      }
    }
    const existsInCRM = !!conversations[effectiveTarget];

    // NUEVO: Si no está en allowedLeads, verificar si está registrado en Firestore como usuario MIIA
    if (!isAllowed && !existsInCRM && !fromMe) {
      try {
        const userSnapshot = await admin.firestore()
          .collection('users')
          .where('whatsapp_phone', '==', baseTarget)
          .limit(1)
          .get();

        if (!userSnapshot.empty) {
          isAllowed = true;
          allowedLeads.push(effectiveTarget);
          saveDB();
          const userData = userSnapshot.docs[0].data();
          const userName = userData.name || userData.email || 'Usuario MIIA';
          console.log(`[WA] ✅ ${baseTarget} es usuario MIIA registrado (${userName}) — permitido automáticamente`);
        }
      } catch (e) {
        console.error(`[WA] Error buscando usuario en Firestore:`, e.message);
      }
    }

    // Auto-takeover para leads desconocidos con keywords de negocio
    if (!isAllowed && !existsInCRM && !fromMe) {
      // Keywords de negocio + genéricas de interés (incluye variantes ortográficas)
      // NOTA: el matching normaliza tildes, así que no hace falta duplicar con/sin tilde
      const takeoverKeywords = [
        // === Keywords de negocio específicas ===
        'medico', 'doctor', 'clinica', 'consultorio', 'consulta',
        'medilink', 'precio', 'cotizacion', 'software', 'sistema', 'plataforma', 'plan',
        'salud', 'dentista', 'odontologo', 'kinesiologo', 'psicologia',
        'psicologo', 'ips', 'centro', 'secretaria', 'administrativa',
        'administrador', 'gerente',
        'pediatra', 'pediatria', 'nutricionista', 'fisioterapeuta', 'especialista',
        'especialidad', 'paciente', 'pacientes', 'cita', 'citas', 'agenda',
        'medica', 'medicos', 'terapeuta', 'cirujano', 'ginecologo', 'ginecologa',
        'dermatologo', 'cardiologo', 'neurologo', 'ortopedista', 'traumatologo',
        // === Keywords genéricas de interés ===
        'info', 'informacion', 'infomacion', 'informasion', 'information',
        'interesado', 'interesada', 'me interesa', 'interezado',
        'quiero saber', 'quiero info', 'necesito',
        'demo', 'demostracion', 'probar', 'prueba',
        'contratar', 'adquirir', 'comprar', 'suscripcion',
        'presupuesto', 'costo', 'valor', 'tarifa', 'mensualidad',
        'conocer', 'cotizar', 'averiguar',
        // === Derivados comunes con errores ortográficos ===
        'imformacion', 'imformación', 'infomasion', 'informarme',
        'presio', 'precios', 'cuanto vale', 'cuanto cuesta', 'cuanto sale',
        'como funciona', 'que ofrece', 'que ofrecen',
        'quisiera', 'me gustaria', 'me gustaría',
        'contratacion', 'servicio', 'servicios'
      ];
      // Normalizar tildes para matching robusto
      // Gente escribe "informacion", "información", "informasión" — todo debe matchear
      const normalizedBody = lowerBody.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const triggered = takeoverKeywords.find(kw => {
        const normalizedKw = kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return lowerBody.includes(kw) || normalizedBody.includes(normalizedKw);
      });
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
          console.log(`[WA] ✅ Auto-takeover (sin contacto): ${effectiveTarget} ${triggered ? `keyword "${triggered}"` : 'saludo'}`);
        }
      }
    }

    if (!isAllowed && !existsInCRM && !fromMe) {
      // Silent digest: aún así registrar el contacto como pendiente
      if (message._baileysMsg?._silentDigest) {
        console.log(`[SILENT-DIGEST] 📋 Contacto no-allowed registrado: ${effectiveTarget} body="${(body||'').substring(0,40)}"`);
      } else {
        console.log(`[WA] IA BLOQUEADA para ${effectiveTarget}. Sin keywords de negocio ni historial. body="${(body||'').substring(0,60)}" isLID=${effectiveTarget.includes('@lid')}`);
        // Si es LID no resuelto, notificar al owner para que no pierda leads
        if (effectiveTarget.includes('@lid') && body && body.length > 5) {
          safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
            `⚠️ *Lead no atendido* (LID sin resolver)\nMensaje: "${(body||'').substring(0,100)}"\nNo pude identificar su número. Revisá WhatsApp directo.`,
            { isSelfChat: true }
          ).catch(() => {});
        }
      }
      return;
    }

    // ── SILENT DIGEST: extraer datos sin responder ──────────────────────
    // Mensajes offline procesados silenciosamente: registrar LIDs, contactos,
    // conversaciones, pero NO generar respuesta IA ni enviar nada.
    if (message._baileysMsg?._silentDigest) {
      // Guardar en historial de conversación para contexto futuro
      if (!conversations[effectiveTarget]) conversations[effectiveTarget] = [];
      conversations[effectiveTarget].push({
        role: fromMe ? 'assistant' : 'user',
        content: body,
        timestamp: Date.now()
      });
      // Detectar tipo de contacto si es nuevo
      if (!fromMe && !contactTypes[effectiveTarget]) {
        detectContactType(null, effectiveTarget);
      }
      // Registrar lead name si tiene contacto
      if (!fromMe && !leadNames[effectiveTarget]) {
        try {
          const ct = await message.getContact();
          if (ct && (ct.name || ct.pushname)) {
            leadNames[effectiveTarget] = ct.name || ct.pushname;
          }
        } catch (e) {}
      }
      console.log(`[SILENT-DIGEST] 📋 ${effectiveTarget} body="${(body||'').substring(0,50)}" → datos guardados, sin respuesta`);
      saveDB();
      return;
    }

    // Self-chat: solo responder si MIIA es mencionada
    // Fallback a OWNER_PHONE si whatsappClient.info aún no está disponible
    const myNumberFull = (getOwnerSock() && getOwnerSock().user)
      ? getOwnerSock().user.id : `${OWNER_PHONE}@s.whatsapp.net`;
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

    // FIX: Owner self-chat SIEMPRE activa MIIA — sin necesidad de decir "hola miia"
    // Para familia/leads: requiere keyword o sesión activa
    // El estado de sesión se pierde en cada redeploy (Railway filesystem efímero)
    const isMIIAActive = isSelfChatMsg ? true : (isMIIAMentioned || isMIIASessionActive);

    const isFamily = !!familyContacts[effectiveTarget.split('@')[0]];
    const isEquipo = !!equipoMedilink[effectiveTarget.split('@')[0]];
    const isSelfChatMIIA = isSelfChatMsg && (isMIIAActive || isFamily);

    // B1 DIAGNOSTIC: Log de estado de clasificación
    if (isSelfChatMsg || fromMe) {
      console.log(`[HIM-TRACE] 📍 Classification: effectiveTarget=${effectiveTarget} isSelfChatMsg=${isSelfChatMsg} isMIIAActive=${isMIIAActive} isSelfChatMIIA=${isSelfChatMIIA} isFamily=${isFamily} isProcessing=${!!isProcessing[effectiveTarget]}`);
    }

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
    if (lastAiSentBody[effectiveTarget] && lastAiSentBody[effectiveTarget] === cleanBody) {
      console.log(`[HIM] 🔁 lastAiSentBody match — skipping echo for ${effectiveTarget}`);
      return;
    }

    if (!fromMe || isSelfChatMIIA) {
      // Guardar mensaje ANTES del guard isProcessing para capturar multi-mensajes en ráfaga
      // Si fue media, guardar con contexto para que la IA entienda qué recibió
      const mediaLabel = { audio: '🎤 Audio', image: '📷 Imagen', video: '🎬 Video', document: '📄 Documento' };
      const userContent = mediaContext
        ? `[El lead envió un ${mediaLabel[mediaContext.mediaType] || 'archivo'}. Transcripción/descripción: "${body}"]`
        : body;
      history.push({ role: 'user', content: userContent, timestamp: Date.now() });
      if (history.length > 40) conversations[effectiveTarget] = history.slice(-40);

      // Extracción de nombre en background — solo para leads reales, nunca para self-chat
      if (!isSelfChatMIIA && (!leadNames[effectiveTarget] || leadNames[effectiveTarget] === 'Buscando...')) {
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

      // Si ya hay una respuesta programada, marcar para re-procesar al terminar
      if (isProcessing[effectiveTarget]) {
        pendingResponses[effectiveTarget] = true;
        console.log(`[WA] Mensaje acumulado para ${effectiveTarget} (respuesta ya programada, pendingResponse marcado).`);
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
    if (!isSelfChatMIIA && !isFamily && !isEquipo && !isWithinAutoResponseSchedule()) {
      console.log(`[WA] Fuera de horario para ${effectiveTarget}. Mensaje guardado, respuesta diferida.`);
      return;
    }

    // ── COMANDO RESET (self-chat del owner + números de testing) ──────────────────────────
    if (body.trim().toUpperCase() === 'RESET') {
      const baseNumReset = effectiveTarget.split('@')[0];
      if (isSelfChatMIIA || RESET_ALLOWED_PHONES.includes(baseNumReset)) {
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

      // Verificar si es un día diferente en zona del owner y ya pasaron las 9:30 AM
      const { localNow: nowBogota, tz: _ownerTzFup } = getOwnerLocalNow();
      const toDateBogota = ts => new Date(ts).toLocaleDateString('es-ES', { timeZone: _ownerTzFup });
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
      await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
        `🔔 *${leadName}* está listo para comprar.\n\nSus datos:\n${body}\n\nCreá el link de pago y enviáselo.`,
        { isSelfChat: true });
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

    // 🔧 Guardar MENSAJE COMPLETO para self-chat quotedMessage
    // Baileys necesita la estructura completa del mensaje, no solo una key
    if (message) {
      lastMessageKey[effectiveTarget] = message;

      // 🔧 CRÍTICO: Si effectiveTarget es un UID, buscar el número REAL en Firestore
      // Ejemplo: 136417472712832@s.whatsapp.net → buscar users/{uid}.whatsapp_number
      const baseTarget = effectiveTarget.split('@')[0];
      if (baseTarget.length > 12 && !baseTarget.startsWith('+')) {
        // Probablemente es un UID, buscar en Firestore
        admin.firestore().collection('users').doc(baseTarget).get()
          .then(doc => {
            if (doc.exists) {
              const realNumber = doc.data().whatsapp_number;
              if (realNumber) {
                const realJid = `${realNumber}@s.whatsapp.net`;
                lastMessageKey[realJid] = message;
                console.log(`[SELF-CHAT] 🔧 Guardado también en JID real: ${realJid}`);
              }
            }
          })
          .catch(e => console.error(`[SELF-CHAT] Error buscando número real:`, e.message));
      }

      console.log(`[SELF-CHAT] ✅ Guardado mensaje completo para quoted`);
    } else {
      console.log(`[SELF-CHAT] ❌ No hay mensaje para guardar`);
    }

    // Emitir mensaje entrante al frontend
    try {
      io.emit('new_message', {
        from: effectiveTarget,
        fromName: leadNames[effectiveTarget] || message.pushName || effectiveTarget.split('@')[0],
        body: body,
        mediaType: mediaContext ? mediaContext.mediaType : null,
        timestamp: Date.now(),
        type: contactTypes[effectiveTarget] || 'lead'
      });
    } catch (e) {
      console.warn(`[SOCKET] ⚠️ Error emitiendo new_message:`, e.message);
    }

    // Debounce real de 3s: acumula todos los mensajes seguidos y responde de una vez
    if (messageTimers[effectiveTarget]) clearTimeout(messageTimers[effectiveTarget]);
    if (isProcessing[effectiveTarget]) {
      // Safety: si isProcessing lleva >120s, forzar reset (stuck por reconexión/crash)
      const processingAge = Date.now() - (isProcessing[effectiveTarget] || 0);
      if (typeof isProcessing[effectiveTarget] === 'number' && processingAge > 120000) {
        console.warn(`[WA] ⚠��� isProcessing STUCK para ${effectiveTarget} (${Math.round(processingAge/1000)}s) — forzando reset`);
        delete isProcessing[effectiveTarget];
        delete pendingResponses[effectiveTarget];
      } else {
        // Ya está procesando una respuesta — marcar para re-procesar al terminar
        pendingResponses[effectiveTarget] = true;
        console.log(`[WA] Mensaje acumulado para ${effectiveTarget} (isProcessing desde hace ${Math.round(processingAge/1000)}s)`);
        return;
      }
    }
    messageTimers[effectiveTarget] = setTimeout(async () => {
      delete messageTimers[effectiveTarget];
      isProcessing[effectiveTarget] = Date.now(); // Timestamp en lugar de boolean para detectar stuck
      try {
        await processAndSendAIResponse(effectiveTarget, null, true);
      } finally {
        delete isProcessing[effectiveTarget];
        if (pendingResponses[effectiveTarget]) {
          delete pendingResponses[effectiveTarget];
          setTimeout(async () => {
            isProcessing[effectiveTarget] = Date.now();
            try { await processAndSendAIResponse(effectiveTarget, null, true); }
            finally { delete isProcessing[effectiveTarget]; }
          }, 1000);
        }
      }
    }, 3000);

  } catch (err) {
    console.error(`[WA] Error procesando mensaje de ${message.from}:`, err.message);
  }
}

// ============================================
// WHATSAPP — Baileys (via tenant_manager.js)
// ============================================
// initWhatsApp() ya no existe. Todos los usuarios (incluido el owner)
// se conectan via POST /api/tenant/init → tenant_manager.initTenant()
// que usa Baileys internamente (sin Chrome/Puppeteer).
//
// El owner legacy flow se mantiene compatible: safeSendMessage() y
// handleIncomingMessage() usan getOwnerSock() para obtener el socket
// del owner desde tenant_manager.

// ============================================
// SOCKET.IO EVENTS
// ============================================

io.on('connection', (socket) => {
  console.log('👤 Cliente conectado via Socket.io');

  // Si WhatsApp del owner ya está conectado, avisar inmediatamente
  const ownerStatus = getOwnerStatus();
  if (ownerStatus.isReady) {
    socket.emit('whatsapp_ready', { status: 'connected' });
  } else if (ownerStatus.hasQR && ownerStatus.qrCode) {
    socket.emit('qr', ownerStatus.qrCode);
  }

  socket.emit('whatsapp_status', { isReady: ownerStatus.isReady, qrCode: ownerStatus.qrCode || null });

  socket.on('check_status', () => {
    if (getOwnerStatus().isReady) {
      socket.emit('whatsapp_ready', { status: 'connected' });
    }
  });

  // Enviar mensaje manual desde frontend (Baileys API) — requiere Firebase token
  socket.on('send_message', async (data) => {
    const { to, message, token } = data;

    // Verificar autenticación
    if (!token) {
      socket.emit('error', { message: 'Token de autenticación requerido' });
      return;
    }
    try {
      await admin.auth().verifyIdToken(token);
    } catch (authErr) {
      socket.emit('error', { message: 'Token inválido' });
      return;
    }

    const sock = getOwnerSock();
    if (!sock) {
      socket.emit('error', { message: 'WhatsApp no conectado' });
      return;
    }

    try {
      await sock.sendMessage(to, { text: message });
      socket.emit('message_sent', { to, message });
      console.log(`[MANUAL] Mensaje enviado a ${to}`);
    } catch (error) {
      console.error('[ERROR] send_message:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // Obtener lista de chats — Baileys no tiene getChats, return stored conversations
  socket.on('get_chats', async () => {
    if (!getOwnerSock()) {
      socket.emit('error', { message: 'WhatsApp no conectado' });
      return;
    }

    try {
      const chatList = Object.entries(conversations).slice(0, 50).map(([phone, msgs]) => ({
        id: phone,
        name: leadNames[phone] || phone.split('@')[0],
        lastMessage: msgs.length > 0 ? msgs[msgs.length - 1].content : '',
        timestamp: msgs.length > 0 ? msgs[msgs.length - 1].timestamp : null
      }));

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
    conversationCount: Object.keys(conversations).length,
    activeContacts: Object.keys(contactTypes).length,
    env: {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || '(default)',
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
      FRONTEND_URL: !!process.env.FRONTEND_URL,
      ADMIN_API_KEY: !!process.env.ADMIN_API_KEY,
      SKIP_WA_INIT: process.env.SKIP_WA_INIT || null
    }
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
      // Also try with @s.whatsapp.net suffix
      const phoneWithSuffix = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
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
      hasPrivateKeyContent: (process.env.FIREBASE_PRIVATE_KEY || '').length > 50
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
  res.json({ connected: false, hasQR: false });
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

  // NOTA: No borrar sesión vieja aquí. Hacerlo en endpoint separado /api/tenant/reset si es necesario
  // El usuario puede reconectar sin perder credenciales guardadas

  // geminiApiKey is optional now - users can test WhatsApp without it
  let apiKeyToUse = geminiApiKey || '';
  // Caso excepcional: usuario con useOwnerApiKey hereda la key del admin
  if (!apiKeyToUse) {
    try {
      const uDoc = await admin.firestore().collection('users').doc(uid).get();
      if (uDoc.exists && uDoc.data()?.useOwnerApiKey && OWNER_UID) {
        const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
        apiKeyToUse = ownerDoc.data()?.gemini_api_key || '';
        if (apiKeyToUse) console.log(`[INIT] 🔑 ${uid.substring(0,12)}... usando API key del owner (useOwnerApiKey=true)`);
      }
    } catch (e) {}
  }

  // TODOS los usuarios van por el mismo flujo: tenant_manager
  // Si es el OWNER, conectar handleIncomingMessage y cerebro_absoluto
  const isOwner = (OWNER_UID && uid === OWNER_UID);
  const tenantOptions = isOwner ? {
    onMessage: (baileysMsg, from, body) => {
      // Capturar participant como fuente de LID mapping
      // En linked devices, participant puede tener el phone real cuando remoteJid es LID (o viceversa)
      const participant = baileysMsg.key.participant;
      if (participant && from) {
        if (from.includes('@lid') && participant.includes('@s.whatsapp.net')) {
          registerLidMapping(from, participant);
        } else if (participant.includes('@lid') && from.includes('@s.whatsapp.net')) {
          registerLidMapping(participant, from);
        }
      }
      // Resolver LID a número real si tenemos mapeo
      const resolvedRemote = resolveLid(from);
      // En Baileys, remoteJid = el OTRO. Para incoming: from=contacto, to=owner. Para outgoing: from=owner, to=contacto.
      const ownerSock = getOwnerSock();
      const ownerNum = ownerSock?.user?.id?.split('@')[0]?.split(':')[0] || OWNER_PHONE;
      const ownerJid = `${ownerNum}@s.whatsapp.net`;
      const isFromMe = !!baileysMsg.key.fromMe;
      const adaptedFrom = isFromMe ? ownerJid : resolvedRemote;
      const adaptedTo = isFromMe ? resolvedRemote : ownerJid;
      // Adapter: convert Baileys message to whatsapp-web.js-like format for handleIncomingMessage
      const adapted = {
        from: adaptedFrom,
        to: adaptedTo,
        fromMe: isFromMe,
        body,
        id: baileysMsg.key.id ? { _serialized: baileysMsg.key.id } : {},
        hasMedia: !!(baileysMsg.message?.imageMessage || baileysMsg.message?.audioMessage || baileysMsg.message?.videoMessage || baileysMsg.message?.documentMessage || baileysMsg.message?.stickerMessage),
        type: baileysMsg.message?.imageMessage ? 'image' : baileysMsg.message?.audioMessage ? 'audio' : baileysMsg.message?.videoMessage ? 'video' : baileysMsg.message?.documentMessage ? 'document' : baileysMsg.message?.stickerMessage ? 'sticker' : 'chat',
        isStatus: from === 'status@broadcast',
        timestamp: baileysMsg.messageTimestamp || Math.floor(Date.now() / 1000),
        pushName: baileysMsg.pushName || null,  // Para LID resolution por pushName
        _baileysMsg: baileysMsg  // Para que processMediaMessage pueda descargar media
      };
      handleIncomingMessage(adapted);
    },
    onContacts: (contacts) => {
      // Capturar LID ↔ Phone de los contactos sincronizados por WhatsApp
      for (const c of contacts) {
        if (c.id && c.lid) {
          registerLidMapping(c.lid, c.id);
        }
      }
    },
    onReady: (sock) => {
      console.log(`[WA] ✅ Owner connected via Baileys`);
      isReady = true;
      ownerConnectedAt = Math.floor(Date.now() / 1000);
      io.emit('whatsapp_ready', { status: 'connected' });

      // ═══ B1 FIX: Reset de estado post-reconexión ═══
      // Limpiar isProcessing/pendingResponses/messageTimers que pudieron quedar stuck
      // durante la desconexión/reconexión
      const stuckKeys = Object.keys(isProcessing);
      if (stuckKeys.length > 0) {
        console.warn(`[WA] 🔧 Limpiando ${stuckKeys.length} isProcessing stuck post-reconexión: ${stuckKeys.join(', ')}`);
        for (const k of stuckKeys) {
          delete isProcessing[k];
          delete pendingResponses[k];
          if (messageTimers[k]) { clearTimeout(messageTimers[k]); delete messageTimers[k]; }
        }
      }

      // Guardar número de WhatsApp en Firestore (para detección de owner)
      try {
        const waNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
        if (waNumber) {
          admin.firestore().collection('users').doc(OWNER_UID).update({
            whatsapp_owner_number: waNumber,
            whatsapp_owner_jid: `${waNumber}@s.whatsapp.net`,
            whatsapp_connected_at: new Date()
          }).catch(e => console.log('[WA] No se pudo guardar número:', e.message));
        }
      } catch (e) {}

      // Inicializar CEREBRO ABSOLUTO
      cerebroAbsoluto.init({
        whatsappClient: sock,
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
    }
  } : {};
  const tenant = tenantManager.initTenant(uid, apiKeyToUse, io, {}, tenantOptions);
  console.log(`[INIT] ✅ WhatsApp iniciado para ${uid}. Checking role...`);

  // Cargar cerebro compartido si es miembro de una empresa
  try {
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.role === 'owner_member') {
        tenant.isOwnerMember = true;
        console.log(`[TM:${uid}] 🧠 Cerebro compartido activado (owner_member)`);
      }
      // Si el usuario tiene parent_client_uid, cargar el cerebro de la empresa
      if (userData.parent_client_uid) {
        tenant.parentClientUid = userData.parent_client_uid;
        console.log(`[TM:${uid}] 🔗 Agente de empresa ${userData.parent_client_uid}`);
      }
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

// POST /api/tenant/:uid/request-pairing-code — Request 8-digit pairing code instead of QR
app.post('/api/tenant/:uid/request-pairing-code', express.json(), async (req, res) => {
  const uid = req.params.uid;
  const { phone } = req.body; // e.g. "5491112345678" (international format, no + or spaces)
  if (!phone) return res.status(400).json({ error: 'Número de teléfono requerido (ej: 5491112345678)' });

  try {
    const client = tenantManager.getTenantClient(uid);
    if (!client) return res.status(404).json({ error: 'WhatsApp no inicializado. Esperá unos segundos e intentá de nuevo.' });

    const code = await client.requestPairingCode(phone.replace(/\D/g, ''));
    console.log(`[PAIRING] Código generado para ${uid}: ${code}`);
    res.json({ code });
  } catch (e) {
    console.error('[PAIRING] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/logout — Disconnect tenant WhatsApp
app.post('/api/tenant/:uid/logout', verifyTenantAuth, async (req, res) => {
  const result = await tenantManager.destroyTenant(req.params.uid);
  res.json(result);
});

// POST /api/tenant/:uid/clean-session — Clean corrupted Baileys session (MessageCounterError recovery)
app.post('/api/tenant/:uid/clean-session', verifyTenantAuth, express.json(), async (req, res) => {
  const uid = req.params.uid;
  try {
    console.log(`[CLEAN-SESSION] 🔧 Limpiando sesión corrupta para ${uid}...`);

    // Eliminar sesión de Firestore (fuerza reconexión)
    const { deleteFirestoreSession } = require('./whatsapp/baileys_session_store');
    await deleteFirestoreSession(`tenant-${uid}`);

    // Marcar en Firestore que necesita reconectar
    await admin.firestore().collection('users').doc(uid).update({
      whatsapp_needs_reconnect: true,
      whatsapp_recovery_at: new Date(),
      whatsapp_recovery_reason: 'Sesión corrupta limpiada automáticamente por MessageCounterError'
    }).catch(() => {});

    // Destruir el tenant en memoria
    tenantManager.destroyTenant(uid);

    console.log(`[CLEAN-SESSION] ✅ Sesión ${uid} limpiada. Usuario debe reconectar.`);
    res.json({ success: true, message: 'Sesión limpiada. Por favor, reconecta.' });
  } catch (err) {
    console.error(`[CLEAN-SESSION] ❌ Error limpiando sesión ${uid}:`, err.message);
    res.status(500).json({ error: err.message });
  }
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
    
    const geminiUrl = `${GEMINI_URL}?key=${getGeminiKey()}`;
    console.log('[API CHAT] 🌐 URL Gemini (oculta):', geminiUrl.replace(/key=[^&]+/, 'key=HIDDEN'));
    
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
    if (!getOwnerSock() || !getOwnerStatus().isReady) return;
    if (nightPendingLeads.size === 0) return;

    const { localNow: bogotaNow } = getOwnerLocalNow();
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

// ═══ HELPER UNIFICADO: Obtener hora local del owner (evita duplicar lógica timezone) ═══
// Prioridad: 1) cache de scheduleConfig.timezone (Firestore), 2) deducido del teléfono
// SYNC para que funcione en contextos no-async. El cache se refresca cada 5min por getScheduleConfig.
let _ownerTzCache = null;
function getOwnerLocalNow() {
  // Usar cache de timezone si existe (se actualiza async en background)
  const tz = _ownerTzCache || getTimezoneForCountry(getCountryFromPhone(OWNER_PHONE));
  return { localNow: new Date(new Date().toLocaleString('en-US', { timeZone: tz })), tz };
}
// Refrescar cache de timezone del owner periódicamente
setInterval(async () => {
  try {
    if (!OWNER_UID) return;
    const cfg = await getScheduleConfig(OWNER_UID);
    if (cfg?.timezone) _ownerTzCache = cfg.timezone;
  } catch { /* ignore */ }
}, 300000); // Cada 5 min
// Primera carga
setTimeout(async () => {
  try {
    if (!OWNER_UID) return;
    const cfg = await getScheduleConfig(OWNER_UID);
    if (cfg?.timezone) _ownerTzCache = cfg.timezone;
  } catch { /* ignore */ }
}, 5000);

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

Escribí UN mensaje de seguimiento breve (máximo 3 líneas) para revivir el interés. Usá algún gancho relacionado a la conversación (su tipo de clínica, el problema que mencionó, la urgencia de la promo, etc). Soná como si Mariano escribiera desde su celular — natural, directo, no robótico. NO menciones que sos una IA. NO uses "estimado" ni lenguaje formal. NO repitas la cotización. Solo buscá reabrir la conversación.`;

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
        // En intentos 4 y 6 (índice 3 y 5): enviar nota de voz corta antes del texto
        // para llamar la atención como un "toque" antes del mensaje
        const currentAttempt = meta.followUpAttempts || 0; // 0-indexed antes del increment
        if (currentAttempt === 3 || currentAttempt === 5) {
          try {
            const ringPath = path.join(__dirname, 'assets', 'ring.ogg');
            if (fs.existsSync(ringPath)) {
              const ringBuffer = fs.readFileSync(ringPath);
              const ringMedia = { mimetype: 'audio/ogg; codecs=opus', data: ringBuffer.toString('base64'), filename: 'ring.ogg' };
              await safeSendMessage(phone, ringMedia, { sendAudioAsVoice: true });
              await new Promise(r => setTimeout(r, 3000));
              console.log(`[FOLLOW-UP] Tono de atención enviado a ${leadName} (intento ${currentAttempt + 1})`);
            }
          } catch (ringErr) {
            console.warn(`[FOLLOW-UP] No se pudo enviar tono:`, ringErr.message);
          }
        }
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
    if (!getOwnerSock() || !getOwnerStatus().isReady) return;

    const { localNow: bogotaNow } = getOwnerLocalNow();
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
        const baseNum = lPhone.split('@')[0];
        const name = leadNames[lPhone] || baseNum;
        // Truncar en límite de palabra, no cortar a mitad de frase
        let shortSummary = summary;
        if (shortSummary.length > 250) {
          shortSummary = shortSummary.substring(0, 250);
          const lastSpace = shortSummary.lastIndexOf(' ');
          if (lastSpace > 180) shortSummary = shortSummary.substring(0, lastSpace);
          shortSummary += '…';
        }
        return `▸ *${name}*: ${shortSummary}`;
      })
      .join('\n');

    const leadsSection = pendingEntries
      ? `\n\n*👥 LEADS CON PENDIENTES HOY:*\n${pendingEntries}`
      : '';

    // ── 3. Aprobaciones de aprendizaje pendientes ──
    let approvalsSection = '';
    try {
      const pending = await getPendingApprovals(OWNER_UID);
      if (pending.length > 0) {
        approvalsSection = `\n\n*🔑 APROBACIONES DE APRENDIZAJE PENDIENTES (${pending.length}):*\n`;
        for (const p of pending) {
          const daysText = p.daysLeft === 1 ? 'expira hoy' : `${p.daysLeft} días restantes`;
          approvalsSection += `▸ *${p.agentName}*: "${(p.changes || '').substring(0, 150)}…" — clave *${p.key}* (${daysText})\n`;
          // Actualizar lastReminder para no spamear
          try {
            await admin.firestore().collection('users').doc(OWNER_UID)
              .collection('learning_approvals').doc(p.id)
              .update({ lastReminder: admin.firestore.FieldValue.serverTimestamp() });
          } catch (_) {}
        }
        approvalsSection += `\nReenvía la clave al agente para aprobar, o ignora para que expire.`;
      }
      console.log(`[BRIEFING] Aprobaciones pendientes: ${pending.length}`);
    } catch (e) {
      console.error('[BRIEFING] Error cargando aprobaciones:', e.message);
    }

    // ── 4. Sin nada que informar ──
    if (!scraperResults.length && !leadsSection && !approvalsSection) {
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

    // Sección aprobaciones pendientes
    if (approvalsSection) briefing += approvalsSection;

    await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, briefing, { isSelfChat: true });
    console.log(`[BRIEFING] Briefing enviado a self-chat (${scraperResults.length} regulatorias, leads: ${!!pendingEntries}).`);
  } catch (e) {
    console.error('[BRIEFING] Error:', e.message);
  }

  // Follow-up automático a leads sin respuesta de 3+ días
  await processLeadFollowUps();

  // ═══ INFORME QUINCENAL — Se ejecuta el 1ro y 16 de cada mes a las 9:00 AM ═══
  try {
    await biweeklyReport.runBiweeklyReport(
      OWNER_UID, OWNER_PHONE, conversations, leadSummaries, leadNames, safeSendMessage
    );
  } catch (e) {
    console.error('[REPORT] ❌ Error en informe quincenal:', e.message);
  }
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
          .where('role', 'in', ['admin', 'owner', 'client'])
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
    // Solo logear UNA VEZ al día para no llenar logs
    const todayAdn = new Date().toISOString().split('T')[0];
    if (!global._lastAdnNoConsentLog || global._lastAdnNoConsentLog !== todayAdn) {
      global._lastAdnNoConsentLog = todayAdn;
      console.log('[CRON ADN] Sin consentimiento registrado. Minado cancelado (log diario).');
    }
  }

  webScraper.processScraperCron();
  processMorningWakeup();
  processMorningBriefing();

  // Trust decay: una vez al día — restar 1 punto a contactos inactivos
  const todayDecay = new Date().toISOString().split('T')[0];
  if (!global._lastAffinityDecayDate || global._lastAffinityDecayDate !== todayDecay) {
    global._lastAffinityDecayDate = todayDecay;
    processAffinityDecay();
  }

  // Revisar emails para aprendizaje cada 30 minutos
  const nowMin = new Date().getMinutes();
  if (nowMin === 0 || nowMin === 30) {
    checkEmailInbox().catch(e => console.warn('[IMAP CRON]', e.message));
  }
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
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ *Centro de Ayuda Medilink aprendido*\n${learned} artículos procesados y guardados en mi memoria.`, { isSelfChat: true }).catch(() => {});
    } catch (e) {
      console.error('[HELPCENTER] Error general:', e.message);
    }
  })();
});

// Endpoint para disparar el minado manualmente desde el panel
app.post('/api/cerebro/mine-dna', async (_req, res) => {
  if (!getOwnerSock() || !getOwnerStatus().isReady) {
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

// Chat conversacional para training.html — usa el mismo prompt admin que WhatsApp
app.post('/api/admin-chat', express.json(), async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'message requerido' });

    const adnStr = cerebroAbsoluto.getTrainingData();
    const historyStr = history.slice(-10).map(m => `${m.role === 'user' ? 'Mariano' : 'MIIA'}: ${m.content}`).join('\n');

    const prompt = `# PROMPT MAESTRO — MIIA Admin Chat
Sos MIIA, asistente de Mariano. Estás en el panel de entrenamiento donde Mariano puede conversar con vos, hacerte preguntas, testear respuestas, y enseñarte cosas nuevas.

ANTI-BOT: NUNCA empieces con "Entendido", "Perfecto", "Claro", "Por supuesto". Variá la estructura. Sé natural, directa, humana.

AUTO-APRENDIZAJE: Si en la conversación Mariano te cuenta información NUEVA sobre su negocio (productos, precios, clientes, reglas de venta, procedimientos, información importante), incluí al FINAL de tu respuesta el tag [GUARDAR_APRENDIZAJE:texto breve a guardar]. Solo si la info es genuinamente nueva y útil para recordar en futuros chats de WhatsApp. No guardes preguntas, tests, ni información obvia. Para información que Mariano quiere guardar explícitamente, usa el prefijo APRENDE: que dispara el guardado directo.

## Tu conocimiento actual:
${adnStr || '(sin aprendizajes cargados aún)'}

## Historial de esta sesión:
${historyStr || '(inicio de sesión)'}

## Mariano dice ahora:
${message}

Respondé natural, concisa y útil. Si pregunta qué sabés, mostrá ejemplos. Si no sabés algo, decilo.`;

    let response = await generateAIContent(prompt);
    let autoSaved = null;
    // Check for auto-learning tag
    const autoLearnMatch = response && response.match(/\[GUARDAR_APRENDIZAJE:([^\]]+)\]/);
    if (autoLearnMatch) {
      const toLearn = autoLearnMatch[1].trim();
      cerebroAbsoluto.appendLearning(toLearn, 'MIIA_CHAT_AUTO');
      saveDB();
      autoSaved = toLearn;
      response = response.replace(autoLearnMatch[0], '').trim();
    }
    res.json({ response: response || 'No pude generar respuesta.', type: 'chat', autoSaved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint de entrenamiento web — guarda lo que Mariano enseña desde training.html
app.post('/api/train', express.json(), async (req, res) => {
  console.log('Calling /api/train with body:', req.body);
  try {
    const { message } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'message requerido' });

    // Evaluar si el mensaje es conocimiento útil antes de guardar
    const evalPrompt = `Eres un sistema de control de calidad de conocimiento para una IA de ventas.
El usuario escribió: "${message.substring(0, 300)}"

Determina si esto es:
A) UTIL — una regla de negocio, dato de producto, precio, restricción, preferencia del dueño o información que la IA debe recordar siempre para responder mejor
B) PREGUNTA — el usuario está probando o haciendo una pregunta sobre cómo funciona el sistema
C) BASURA — texto sin sentido, prueba de teclado, caracteres aleatorios

Responde SOLO con una de estas palabras en la primera línea: UTIL / PREGUNTA / BASURA
Segunda línea: si es UTIL escribe una versión mejorada y concisa del conocimiento (máx 120 chars). Si no es UTIL escribe el motivo en 1 frase corta.`;

    const evalResult = await generateAIContent(evalPrompt);
    const lines = (evalResult || '').split('\n').map(l => l.trim()).filter(Boolean);
    const tipo = (lines[0] || '').toUpperCase().replace(/[^A-Z]/g, '');
    const detail = lines[1] || '';

    if (tipo === 'UTIL') {
      const knowledgeToSave = detail || message;
      cerebroAbsoluto.appendLearning(knowledgeToSave, 'WEB_TRAINING');
      saveDB();
      const confirmPrompt = `Eres MIIA. Mariano acaba de enseñarte: "${knowledgeToSave}". Confirma en 1 oración que lo entendiste y guardaste.`;
      const confirmation = await generateAIContent(confirmPrompt);
      res.json({ response: confirmation || '✅ Guardado en mi memoria.', saved: true, tipo: 'UTIL' });
    } else if (tipo === 'PREGUNTA') {
      res.json({ response: `Eso parece una pregunta, no un conocimiento para guardar. ${detail}`, saved: false, tipo: 'PREGUNTA' });
    } else {
      res.json({ response: `No guardé eso — parece texto de prueba o sin sentido. ${detail}`, saved: false, tipo: 'BASURA' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// BUSINESSES & CONTACT GROUPS (new multi-business routes)
// ============================================
app.use('/api/tenant/:uid', businessesRouter);

// ============================================
// TRAINING ENDPOINTS — Products, Contact Rules, Sessions, Test
// (Legacy — redirigen al defaultBusinessId para backward compat)
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

// ── Prompt Registry — Módulos versionados + checkpoints ─────────────────────

const promptRegistry = require('./core/prompt_registry');

// Listar módulos
app.get('/api/prompt-registry/modules', verifyAdminToken, async (req, res) => {
  try {
    const modules = await promptRegistry.listModules();
    res.json(modules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Obtener un módulo
app.get('/api/prompt-registry/modules/:id', verifyAdminToken, async (req, res) => {
  try {
    const mod = await promptRegistry.getModule(req.params.id);
    if (!mod) return res.status(404).json({ error: 'Module not found' });
    res.json(mod);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guardar/actualizar módulo
app.post('/api/prompt-registry/modules/:id', verifyAdminToken, express.json(), async (req, res) => {
  try {
    const { content, description } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const result = await promptRegistry.saveModule(req.params.id, content, {
      description, updatedBy: req.user?.uid || 'api'
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar checkpoints
app.get('/api/prompt-registry/checkpoints', verifyAdminToken, async (req, res) => {
  try {
    const checkpoints = await promptRegistry.listCheckpoints();
    res.json(checkpoints);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear checkpoint
app.post('/api/prompt-registry/checkpoints', verifyAdminToken, express.json(), async (req, res) => {
  try {
    const { name, note } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const result = await promptRegistry.createCheckpoint(name, note);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rollback a un checkpoint
app.post('/api/prompt-registry/rollback', verifyAdminToken, express.json(), async (req, res) => {
  try {
    const { checkpointName } = req.body;
    if (!checkpointName) return res.status(400).json({ error: 'checkpointName required' });
    const result = await promptRegistry.rollback(checkpointName);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diff actual vs checkpoint
app.get('/api/prompt-registry/diff/:checkpointName', verifyAdminToken, async (req, res) => {
  try {
    const diff = await promptRegistry.diffFromCheckpoint(req.params.checkpointName);
    res.json(diff);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Seed desde prompt_builder (run once)
app.post('/api/prompt-registry/seed', verifyAdminToken, async (req, res) => {
  try {
    const promptBuilder = require('./core/prompt_builder');
    const result = await promptRegistry.seedFromPromptBuilder(promptBuilder);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ── AI Config — Multi-provider support ──
// Stores ai_configs: [{provider, apiKey, active, addedAt}] on user doc
// Backward compat: also writes ai_provider/ai_api_key for active config

function maskApiKey(key) {
  if (!key || key.length < 8) return '****';
  return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

// ═══ LEARNING APPROVAL — Sistema de aprobación dinámica de aprendizaje ═══
//
// Flujo: Agente/Familiar enseña a MIIA → confirma que está conforme →
//        MIIA genera clave única (6 dígitos) → la envía al Owner con detalle completo →
//        Owner revisa y si aprueba, reenvía la clave al agente →
//        Agente pega la clave en su chat → MIIA valida y aplica los cambios.
//
// Clave: única por solicitud, válida 3 días. MIIA recuerda al owner cada mañana.
// Si expira: agente debe solicitar nuevamente.
// Firestore: users/{ownerUid}/learning_approvals/{approvalId}

function generateLearningKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

async function createLearningApproval(ownerUid, data) {
  const key = generateLearningKey();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const approval = {
    agentUid: data.agentUid || '',
    agentName: data.agentName || 'Desconocido',
    agentPhone: data.agentPhone || '',
    key,
    changes: data.changes || '',
    pendingData: data.pendingData || null,
    scope: data.scope || 'business_global',
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    appliedAt: null,
    lastReminder: null
  };

  const ref = await admin.firestore().collection('users').doc(ownerUid)
    .collection('learning_approvals').add(approval);

  console.log(`[LEARNING-APPROVAL] 🔑 Solicitud creada: ${ref.id} key=${key} agente=${data.agentName} scope=${data.scope} expira=${expiresAt.toISOString()}`);
  return { approvalId: ref.id, key, expiresAt };
}

async function validateLearningKey(ownerUid, keyProvided) {
  if (!keyProvided || keyProvided.length !== 6) return { valid: false };

  const snap = await admin.firestore().collection('users').doc(ownerUid)
    .collection('learning_approvals')
    .where('key', '==', keyProvided.toUpperCase())
    .where('status', '==', 'pending')
    .limit(1).get();

  if (snap.empty) return { valid: false };

  const doc = snap.docs[0];
  const approval = doc.data();
  const expiresAt = approval.expiresAt?.toDate ? approval.expiresAt.toDate() : new Date(approval.expiresAt);

  if (new Date() > expiresAt) {
    await doc.ref.update({ status: 'expired' });
    console.log(`[LEARNING-APPROVAL] ⏰ Clave ${keyProvided} expirada (agente: ${approval.agentName})`);
    return { valid: false, expired: true, agentName: approval.agentName, agentPhone: approval.agentPhone };
  }

  return { valid: true, approval, approvalId: doc.id, docRef: doc.ref };
}

async function markApprovalApplied(docRef) {
  await docRef.update({ status: 'approved', appliedAt: admin.firestore.FieldValue.serverTimestamp() });
}

async function getPendingApprovals(ownerUid) {
  const snap = await admin.firestore().collection('users').doc(ownerUid)
    .collection('learning_approvals')
    .where('status', '==', 'pending').get();

  const pending = [];
  const now = new Date();

  for (const doc of snap.docs) {
    const data = doc.data();
    const expiresAt = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
    if (now > expiresAt) {
      await doc.ref.update({ status: 'expired' });
      console.log(`[LEARNING-APPROVAL] ⏰ Auto-expirada: ${doc.id} (agente: ${data.agentName})`);
    } else {
      pending.push({ id: doc.id, ...data, daysLeft: Math.ceil((expiresAt - now) / 86400000) });
    }
  }
  return pending;
}

// GET /api/tenant/:uid/learning-approvals — Ver aprobaciones pendientes
app.get('/api/tenant/:uid/learning-approvals', verifyTenantAuth, async (req, res) => {
  try {
    const pending = await getPendingApprovals(req.params.uid);
    res.json({ approvals: pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tenant/:uid/ai-config — Get all configured AI providers
app.get('/api/tenant/:uid/ai-config', async (req, res) => {
  try {
    const { uid } = req.params;
    const doc = await admin.firestore().collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    const data = doc.data();

    // Migrate old format to new if needed
    let configs = data.ai_configs || [];
    if (configs.length === 0 && data.ai_provider && data.ai_api_key) {
      configs = [{ provider: data.ai_provider, apiKey: data.ai_api_key, active: true, addedAt: Date.now() }];
    }

    // Return configs with masked keys
    const masked = configs.map(c => ({
      provider: c.provider,
      providerLabel: PROVIDER_LABELS[c.provider] || c.provider,
      keyPreview: maskApiKey(c.apiKey),
      active: !!c.active,
      addedAt: c.addedAt
    }));

    // Also return active provider for backward compat
    const active = configs.find(c => c.active);
    res.json({
      configs: masked,
      provider: active ? active.provider : 'gemini',
      hasCustomKey: !!(active && active.apiKey),
      providerLabel: PROVIDER_LABELS[(active && active.provider) || 'gemini'] || 'Google Gemini'
    });
  } catch (err) {
    console.error('[AI-CONFIG] Error:', err.message);
    res.status(500).json({ error: 'Error al obtener configuración de IA' });
  }
});

// PUT /api/tenant/:uid/ai-config — Add or update an AI provider config
app.put('/api/tenant/:uid/ai-config', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { provider, apiKey } = req.body;
    const validProviders = ['gemini', 'openai', 'claude'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Proveedor inválido. Válidos: ${validProviders.join(', ')}` });
    }
    if (!apiKey || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'API key inválida (mínimo 10 caracteres)' });
    }

    const doc = await admin.firestore().collection('users').doc(uid).get();
    const data = doc.exists ? doc.data() : {};
    let configs = data.ai_configs || [];

    // Migrate old format
    if (configs.length === 0 && data.ai_provider && data.ai_api_key) {
      configs = [{ provider: data.ai_provider, apiKey: data.ai_api_key, active: true, addedAt: Date.now() }];
    }

    // Check if provider already exists → update key
    const idx = configs.findIndex(c => c.provider === provider);
    if (idx >= 0) {
      configs[idx].apiKey = apiKey.trim();
    } else {
      // New provider — if first one, make active; otherwise inactive
      configs.push({ provider, apiKey: apiKey.trim(), active: configs.length === 0, addedAt: Date.now() });
    }

    // Update Firestore
    const activeConfig = configs.find(c => c.active);
    const update = {
      ai_configs: configs,
      ai_updated_at: admin.firestore.FieldValue.serverTimestamp()
    };
    // Backward compat fields
    if (activeConfig) {
      update.ai_provider = activeConfig.provider;
      update.ai_api_key = activeConfig.apiKey;
    }
    await admin.firestore().collection('users').doc(uid).update(update);

    // Update running tenant with active config
    if (activeConfig) {
      tenantManager.setTenantAIConfig(uid, activeConfig.provider, activeConfig.apiKey);
    }

    res.json({ success: true, provider, providerLabel: PROVIDER_LABELS[provider] });
  } catch (err) {
    console.error('[AI-CONFIG] Error saving:', err.message);
    res.status(500).json({ error: 'Error al guardar configuración de IA' });
  }
});

// POST /api/tenant/:uid/ai-config/activate — Activate a specific provider (deactivate others)
app.post('/api/tenant/:uid/ai-config/activate', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { provider } = req.body;

    const doc = await admin.firestore().collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    const data = doc.data();
    let configs = data.ai_configs || [];

    const target = configs.find(c => c.provider === provider);
    if (!target) return res.status(404).json({ error: 'Proveedor no configurado. Agregá la API key primero.' });

    // Deactivate all, activate target
    configs = configs.map(c => ({ ...c, active: c.provider === provider }));

    await admin.firestore().collection('users').doc(uid).update({
      ai_configs: configs,
      ai_provider: provider,
      ai_api_key: target.apiKey,
      ai_updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    tenantManager.setTenantAIConfig(uid, provider, target.apiKey);

    res.json({ success: true, provider, providerLabel: PROVIDER_LABELS[provider] });
  } catch (err) {
    console.error('[AI-CONFIG] Error activating:', err.message);
    res.status(500).json({ error: 'Error al activar proveedor' });
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
    const em = err.message;
    const msg = em.includes('credit') || em.includes('balance')
      ? 'Sin créditos. Cargá saldo en console.anthropic.com → Billing'
      : em.includes('401') || em.includes('403') || em.includes('credentials')
        ? 'API key inválida o sin permisos'
        : em.includes('404')
          ? 'Modelo no disponible con esta key'
          : `Error de conexión: ${em.substring(0, 150)}`;
    res.status(400).json({ error: msg });
  }
});

// DELETE /api/tenant/:uid/ai-config/:provider — Remove a specific provider config
app.delete('/api/tenant/:uid/ai-config/:provider', async (req, res) => {
  try {
    const { uid, provider } = req.params;
    const doc = await admin.firestore().collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'Usuario no encontrado' });
    const data = doc.data();
    let configs = data.ai_configs || [];

    const wasActive = configs.find(c => c.provider === provider && c.active);
    configs = configs.filter(c => c.provider !== provider);

    // If we removed the active one, activate the first remaining or clear
    const update = { ai_configs: configs, ai_updated_at: admin.firestore.FieldValue.serverTimestamp() };
    if (wasActive && configs.length > 0) {
      configs[0].active = true;
      update.ai_configs = configs;
      update.ai_provider = configs[0].provider;
      update.ai_api_key = configs[0].apiKey;
      tenantManager.setTenantAIConfig(uid, configs[0].provider, configs[0].apiKey);
    } else if (configs.length === 0) {
      update.ai_provider = admin.firestore.FieldValue.delete();
      update.ai_api_key = admin.firestore.FieldValue.delete();
      const globalKey = process.env.GEMINI_API_KEY;
      tenantManager.setTenantAIConfig(uid, 'gemini', globalKey);
    }

    await admin.firestore().collection('users').doc(uid).update(update);
    res.json({ success: true });
  } catch (err) {
    console.error('[AI-CONFIG] Error deleting:', err.message);
    res.status(500).json({ error: 'Error al eliminar proveedor' });
  }
});

// DELETE /api/tenant/:uid/ai-config — Reset all AI config to default
app.delete('/api/tenant/:uid/ai-config', async (req, res) => {
  try {
    const { uid } = req.params;
    await admin.firestore().collection('users').doc(uid).update({
      ai_configs: [],
      ai_provider: admin.firestore.FieldValue.delete(),
      ai_api_key: admin.firestore.FieldValue.delete(),
      ai_updated_at: admin.firestore.FieldValue.delete()
    });

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
app.get('/api/admin/imports', verifyAdminToken, async (req, res) => {
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

app.post('/api/admin/user/:uid/reset-password', verifyAdminToken, async (req, res) => {
  try {
    const { uid } = req.params;
    // Generate a random 10-char password — guaranteed to have letters, digit, and special char
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    const specials = '!@#$';
    const all = letters + digits + specials;
    let password = '';
    // Guarantee at least 1 digit, 1 uppercase, 1 special
    password += letters[Math.floor(Math.random() * letters.length)];
    password += digits[Math.floor(Math.random() * digits.length)];
    password += specials[Math.floor(Math.random() * specials.length)];
    for (let i = 3; i < 10; i++) password += all[Math.floor(Math.random() * all.length)];
    // Shuffle
    password = password.split('').sort(() => Math.random() - 0.5).join('');
    await admin.auth().updateUser(uid, { password });
    res.json({ success: true, password });
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

// ── Admin Support Chat (Gemini) ──────────────────────────────────────────
app.post('/api/admin/support-chat', express.json(), async (req, res) => {
  // Auth inline (verifyAdminToken is defined below)
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    const decoded = await admin.auth().verifyIdToken(authHeader.substring(7));
    const doc = await admin.firestore().collection('users').doc(decoded.uid).get();
    if (!doc.exists || doc.data().role !== 'admin') return res.status(403).json({ error: 'No admin' });

    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message requerido' });

    const systemPrompt = `Eres el asistente técnico de MIIA, un sistema SaaS de ventas por WhatsApp creado por Mariano De Stefano.
Arquitectura: Backend Node.js en Railway, Frontend estático en Vercel, Firebase Auth + Firestore como DB, Baileys para conexión WhatsApp (WebSocket directo, sin Chrome), Google Gemini API para IA, Paddle para pagos.
El super admin te consulta sobre problemas técnicos. Responde de forma concisa y técnica en español.
Si te preguntan sobre una caída, da pasos concretos para diagnosticar (revisar logs de Railway, verificar Firestore, etc).
URLs útiles: Railway dashboard, Firebase console, GitHub repo, Vercel dashboard.`;

    const historyContext = (history || []).map(h => `${h.role === 'user' ? 'Admin' : 'Asistente'}: ${h.text}`).join('\n');
    const fullPrompt = `${systemPrompt}\n\n${historyContext ? 'Historial:\n' + historyContext + '\n\n' : ''}Admin: ${message}\n\nAsistente:`;

    const reply = await generateAIContent(fullPrompt);
    res.json({ reply: reply || 'No pude generar una respuesta. Verificá que la API Key de Gemini esté activa.' });
  } catch (e) {
    console.error('[SUPPORT CHAT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin Email Migration ────────────────────────────────────────────────
app.post('/api/admin/migrate-email', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    const decoded = await admin.auth().verifyIdToken(authHeader.substring(7));
    const doc = await admin.firestore().collection('users').doc(decoded.uid).get();
    if (!doc.exists || doc.data().role !== 'admin') return res.status(403).json({ error: 'No admin' });

    const { newEmail } = req.body;
    if (!newEmail || !newEmail.includes('@')) return res.status(400).json({ error: 'Email inválido' });

    const currentEmail = decoded.email;

    // 1. Update Firebase Auth email
    await admin.auth().updateUser(decoded.uid, { email: newEmail });

    // 2. Update Firestore user doc
    await admin.firestore().collection('users').doc(decoded.uid).update({ email: newEmail });

    // 3. Log instruction for Railway env update
    console.log(`[ADMIN MIGRATE] Email migrado: ${currentEmail} → ${newEmail}. IMPORTANTE: Actualizar ADMIN_EMAILS en Railway.`);

    res.json({
      success: true,
      message: `Email migrado de ${currentEmail} a ${newEmail}. IMPORTANTE: Actualizá la variable ADMIN_EMAILS en Railway manualmente.`,
      oldEmail: currentEmail,
      newEmail
    });
  } catch (e) {
    console.error('[ADMIN MIGRATE]', e.message);
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

/**
 * verifyTenantAuth — Verifica que el request tiene un Firebase token válido
 * y que el uid del token coincide con el :uid del endpoint O es admin.
 */
async function verifyTenantAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Falta header Authorization: Bearer <token>' });
    }
    const idToken = authHeader.substring(7);
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const requestedUid = req.params.uid;
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    const isAdmin = adminEmails.includes((decodedToken.email || '').toLowerCase());
    // El usuario solo puede acceder a su propio uid, o ser admin
    if (!isAdmin && decodedToken.uid !== requestedUid) {
      return res.status(403).json({ error: 'No tienes permiso para acceder a este recurso' });
    }
    req.user = { uid: decodedToken.uid, email: decodedToken.email, isAdmin };
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
    if (OWNER_UID && getOwnerSock()) {
      console.log('🔌 Desvinculando WhatsApp...');
      await tenantManager.destroyTenant(OWNER_UID);
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
// PADDLE CHECKOUT
// ============================================
app.post('/api/paddle/subscribe', express.json(), async (req, res) => {
  try {
    const { uid, plan } = req.body;
    if (!uid || !plan) return res.status(400).json({ error: 'uid y plan requeridos' });

    const priceIds = {
      monthly:   process.env.PADDLE_PRICE_MONTHLY,
      quarterly: process.env.PADDLE_PRICE_QUARTERLY,
      semestral: process.env.PADDLE_PRICE_SEMESTRAL,
      annual:    process.env.PADDLE_PRICE_ANNUAL
    };
    const priceId = priceIds[plan];
    if (!priceId) return res.status(400).json({ error: 'plan inválido o price ID no configurado' });

    const transaction = await paddle.transactions.create({
      items: [{ priceId, quantity: 1 }],
      customData: { uid, plan, type: 'subscription' },
      checkout: { url: FRONTEND_URL + '/owner-dashboard.html?sub_success=1' }
    });

    res.json({ url: transaction.checkout?.url || null, transactionId: transaction.id });
  } catch (e) {
    console.error('[PADDLE] subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/paddle/agent-checkout', express.json(), async (req, res) => {
  try {
    const { uid, agentCount } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid requerido' });

    const priceId = process.env.PADDLE_PRICE_AGENT_EXTRA;
    if (!priceId) return res.status(500).json({ error: 'PADDLE_PRICE_AGENT_EXTRA no configurado' });

    const transaction = await paddle.transactions.create({
      items: [{ priceId, quantity: 1 }],
      customData: { uid, type: 'agent', agentCount: String(agentCount || 0) },
      checkout: { url: FRONTEND_URL + '/owner-dashboard.html?agent_success=1' }
    });

    res.json({ url: transaction.checkout?.url || null });
  } catch (e) {
    console.error('[PADDLE] agent-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// PADDLE WEBHOOK
// ============================================
app.post('/api/paddle/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['paddle-signature'];
    if (PADDLE_WEBHOOK_SECRET && signature) {
      const isValid = paddle.webhooks.isSignatureValid(req.body, PADDLE_WEBHOOK_SECRET, signature);
      if (!isValid) return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(req.body.toString());
    const eventType = event.event_type;
    const data = event.data;
    const customData = data?.custom_data || {};
    const { uid, plan, type } = customData;

    if (eventType === 'transaction.completed') {
      if (type === 'subscription' && plan && uid) {
        const durations = { monthly: 1, quarterly: 3, semestral: 6, annual: 12 };
        const months = durations[plan] || 1;
        const now = new Date();
        const endDate = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);
        await admin.firestore().collection('users').doc(uid).update({
          plan, plan_start_date: now, plan_end_date: endDate, payment_status: 'active'
        });
        console.log(`[PADDLE] Plan ${plan} activado para ${uid}`);
      } else if (type === 'agent' && uid) {
        await admin.firestore().collection('users').doc(uid).update({
          agents_limit: admin.firestore.FieldValue.increment(1)
        });
        console.log(`[PADDLE] Agente extra comprado por ${uid}`);
      }
    } else if (eventType === 'subscription.canceled' && uid) {
      await admin.firestore().collection('users').doc(uid).update({
        payment_status: 'canceled'
      });
      console.log(`[PADDLE] Suscripción cancelada para ${uid}`);
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[PADDLE] webhook error:', e.message);
    res.status(400).send('Webhook error: ' + e.message);
  }
});

// Endpoints Stripe deprecados
app.post('/api/stripe/subscribe', (req, res) => res.status(410).json({ error: 'Migrado a Paddle. Usar /api/paddle/subscribe' }));
app.post('/api/stripe/create-checkout-session', (req, res) => res.status(410).json({ error: 'Migrado a Paddle. Usar /api/paddle/agent-checkout' }));
app.post('/api/stripe/webhook', (req, res) => res.status(410).send('Webhook Stripe desactivado'));

// ============================================
// PAYPAL CHECKOUT
// ============================================
const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

async function getPayPalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  return d.access_token;
}

app.post('/api/paypal/subscribe', express.json(), async (req, res) => {
  try {
    const { uid, plan } = req.body;
    if (!uid || !plan) return res.status(400).json({ error: 'uid y plan requeridos' });
    const prices = { monthly: '12.00', quarterly: '30.00', semestral: '55.00', annual: '75.00' };
    const price = prices[plan];
    if (!price) return res.status(400).json({ error: 'plan inválido' });

    const token = await getPayPalToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: price }, description: `MIIA Plan ${plan}` }],
        application_context: {
          return_url: `${FRONTEND_URL}/owner-dashboard.html?paypal_capture=1&plan=${plan}&uid=${uid}`,
          cancel_url: `${FRONTEND_URL}/owner-dashboard.html`
        }
      })
    });
    const order = await r.json();
    const approvalUrl = order.links?.find(l => l.rel === 'approve')?.href;
    if (!approvalUrl) return res.status(500).json({ error: 'No se pudo crear la orden PayPal', detail: order });
    res.json({ url: approvalUrl });
  } catch (e) {
    console.error('[PAYPAL] subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/paypal/agent-checkout', express.json(), async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid requerido' });

    const token = await getPayPalToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: '3.00' }, description: 'Agente adicional MIIA' }],
        application_context: {
          return_url: `${FRONTEND_URL}/owner-dashboard.html?paypal_agent_capture=1&uid=${uid}`,
          cancel_url: `${FRONTEND_URL}/owner-dashboard.html`
        }
      })
    });
    const order = await r.json();
    const approvalUrl = order.links?.find(l => l.rel === 'approve')?.href;
    if (!approvalUrl) return res.status(500).json({ error: 'No se pudo crear la orden PayPal' });
    res.json({ url: approvalUrl });
  } catch (e) {
    console.error('[PAYPAL] agent-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/paypal/capture', express.json(), async (req, res) => {
  try {
    const { token, plan, uid } = req.body;
    if (!token || !plan || !uid) return res.status(400).json({ error: 'token, plan y uid requeridos' });

    const accessToken = await getPayPalToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const capture = await r.json();

    if (capture.status === 'COMPLETED') {
      const durations = { monthly: 1, quarterly: 3, semestral: 6, annual: 12 };
      const months = durations[plan] || 1;
      const now = new Date();
      const endDate = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);
      await admin.firestore().collection('users').doc(uid).update({
        plan, plan_start_date: now, plan_end_date: endDate, payment_status: 'active'
      });
      console.log(`[PAYPAL] Plan ${plan} activado para ${uid}`);
      res.json({ success: true });
    } else {
      console.error('[PAYPAL] capture status:', capture.status, capture);
      res.status(400).json({ error: 'Pago no completado', status: capture.status });
    }
  } catch (e) {
    console.error('[PAYPAL] capture error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/paypal/capture-agent', express.json(), async (req, res) => {
  try {
    const { token, uid } = req.body;
    if (!token || !uid) return res.status(400).json({ error: 'token y uid requeridos' });

    const accessToken = await getPayPalToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${token}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const capture = await r.json();

    if (capture.status === 'COMPLETED') {
      await admin.firestore().collection('users').doc(uid).update({
        agents_limit: admin.firestore.FieldValue.increment(1)
      });
      console.log(`[PAYPAL] Agente extra comprado por ${uid}`);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Pago no completado', status: capture.status });
    }
  } catch (e) {
    console.error('[PAYPAL] capture-agent error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SERVIDOR
// ============================================

// ═══ RESILIENCE SHIELD: Iniciar monitoreo + endpoint ═══
shield.startHealthMonitor(300_000); // Health log cada 5 minutos
// Conectar Shield con safeSendMessage para notificaciones al owner
shield.setNotifyFunction(async (uid, message) => {
  try {
    const tm = require('./whatsapp/tenant_manager');
    const tenant = tm.getTenant ? tm.getTenant(uid) : null;
    if (tenant?.sock && tenant.isReady && tenant.whatsappNumber) {
      await safeSendMessage(`${tenant.whatsappNumber}@s.whatsapp.net`, message, { isSelfChat: true });
    }
  } catch (e) {
    console.error(`[SHIELD-NOTIFY] Error: ${e.message}`);
  }
});
app.get('/api/health', (req, res) => res.json(shield.getHealthDashboard()));
app.get('/api/health/unknown-errors', (req, res) => res.json(shield.getUnknownErrors()));

const PORT = process.env.PORT || 3000;
// Inyectar funciones de aprobación dinámica en tenant_message_handler
tenantMessageHandler.setApprovalFunctions({
  validateLearningKey,
  createLearningApproval,
  markApprovalApplied
});

// Inyectar dependencias en protection_manager
protectionManager.setProtectionDependencies({
  sendGenericEmail: mailService.sendGenericEmail,
  safeSendMessage,
  generateAIContent
});

// Inyectar dependencias en biweekly_report
biweeklyReport.setReportDependencies({
  sendGenericEmail: mailService.sendGenericEmail,
  generateAIContent,
  getProtectionAlerts: protectionManager.getProtectionAlertsForReport
});

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

  // ═══ VARIABLES DE ENTORNO (solo estado, NUNCA valores sensibles) ═══
  const SENSITIVE = /key|secret|pass|token|private|credential|api_key|client_id|client_secret|webhook/i;
  const SAFE_SHOW = ['PORT', 'NODE_ENV', 'RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_NAME', 'RAILWAY_PUBLIC_DOMAIN', 'FRONTEND_URL', 'FIREBASE_PROJECT_ID', 'PADDLE_ENV', 'PAYPAL_ENV', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_FROM', 'GOOGLE_REDIRECT_URI', 'ADMIN_EMAILS'];
  console.log('\n🔐 ═══ VARIABLES DE ENTORNO ═══');
  SAFE_SHOW.forEach(k => { if (process.env[k]) console.log(`  ${k}: ${process.env[k]}`); });
  console.log('\n🔑 ═══ CREDENCIALES (solo presencia) ═══');
  Object.keys(process.env).sort().filter(k => SENSITIVE.test(k)).forEach(k => {
    console.log(`  ${k}: ${process.env[k] ? '✅ configurada' : '❌ FALTA'}`);
  });
  console.log('\n═══════════════════════════════════\n');

  // ═══ AUTO-RECONEXIÓN DE TODOS LOS USUARIOS ═══
  // Al iniciar el servidor, busca TODAS las sesiones de Baileys guardadas
  // y reconecta automáticamente verificando que el número coincida con Firestore.
  if (!process.env.SKIP_WA_INIT) {
    setTimeout(async () => {
      try {
        // 1. Auto-detectar OWNER_UID si no está en env
        if (!OWNER_UID) {
          console.log('[AUTO-INIT] 🔍 OWNER_UID no configurado. Buscando admin en Firestore...');
          const adminSnap = await admin.firestore().collection('users').where('role', '==', 'admin').limit(1).get();
          if (!adminSnap.empty) {
            OWNER_UID = adminSnap.docs[0].id;
            shield.setActiveOwnerUid(OWNER_UID);
            console.log(`[AUTO-INIT] ✅ Admin auto-detectado: ${OWNER_UID}`);
          } else {
            console.log('[AUTO-INIT] ⚠️ No se encontró usuario con role=admin en Firestore.');
          }
        } else {
          console.log(`[AUTO-INIT] OWNER_UID desde env: ${OWNER_UID}`);
        }

        // 1.5. Cargar affinity desde Firestore (ANTES de conectar WhatsApp)
        await loadAffinityFromFirestore();

        // 2. Buscar usuarios que tengan whatsapp_number guardado (indica que conectaron antes)
        // FIX: NO usar .get() en baileys_sessions porque el doc padre no existe (solo subcollecciones)
        // En cambio, buscar en users collection + verificar creds en subcollección directamente
        const usersWithWA = await admin.firestore().collection('users')
          .where('whatsapp_number', '!=', null)
          .get();

        const sessionIds = usersWithWA.docs.map(d => d.id);
        console.log(`[AUTO-INIT] 📋 ${sessionIds.length} usuario(s) con WhatsApp previo encontrados en Firestore.`);

        for (const uid of sessionIds) {
          const sessionId = `tenant-${uid}`;

          try {
            // Verificar que tiene creds guardados en la subcollección
            const cDoc = await admin.firestore().collection('baileys_sessions').doc(sessionId).collection('data').doc('creds').get();
            if (!cDoc.exists) {
              console.log(`[AUTO-INIT] ⏭️ ${uid.substring(0, 12)}... sin creds en Firestore, saltando.`);
              continue;
            }

            // Obtener datos del usuario
            const userDoc = usersWithWA.docs.find(d => d.id === uid);
            if (!userDoc) {
              console.log(`[AUTO-INIT] ⚠️ ${uid.substring(0, 12)}... sin datos de usuario. Saltando.`);
              continue;
            }

            const userData = userDoc.data();
            const savedNumber = userData.whatsapp_number || null;
            let gKey = userData.gemini_api_key || '';
            // Caso excepcional: usuario con useOwnerApiKey usa la key del admin
            if (!gKey && userData.useOwnerApiKey && OWNER_UID) {
              try {
                const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
                gKey = ownerDoc.data()?.gemini_api_key || '';
                if (gKey) console.log(`[AUTO-INIT] 🔑 ${uid.substring(0,12)}... usando API key del owner`);
              } catch (e) {}
            }
            gKey = gKey || process.env.GEMINI_API_KEY || '';
            const isOwner = (uid === OWNER_UID);

            console.log(`[AUTO-INIT] 🔄 Reconectando ${isOwner ? 'OWNER' : 'tenant'} ${uid.substring(0, 12)}... (WA: ${savedNumber || 'sin registro'})`);

            // CRÍTICO: el owner necesita onMessage (igual que /api/tenant/init) para que
            // tenant_manager no filtre self-chat. Sin onMessage, isOwner=false → self-chat bloqueado.
            const options = isOwner ? {
              onContacts: (contacts) => {
                for (const c of contacts) {
                  if (c.id && c.lid) registerLidMapping(c.lid, c.id);
                }
              },
              onMessage: (baileysMsg, from, body) => {
                // Capturar participant como fuente de LID mapping
                const participant = baileysMsg.key.participant;
                if (participant && from) {
                  if (from.includes('@lid') && participant.includes('@s.whatsapp.net')) {
                    registerLidMapping(from, participant);
                  } else if (participant.includes('@lid') && from.includes('@s.whatsapp.net')) {
                    registerLidMapping(participant, from);
                  }
                }
                const resolvedRemote = resolveLid(from);
                const ownerSock2 = getOwnerSock();
                const ownerNum2 = ownerSock2?.user?.id?.split('@')[0]?.split(':')[0] || OWNER_PHONE;
                const ownerJid2 = `${ownerNum2}@s.whatsapp.net`;
                const isFromMe2 = !!baileysMsg.key.fromMe;
                const adapted = {
                  from: isFromMe2 ? ownerJid2 : resolvedRemote,
                  to: isFromMe2 ? resolvedRemote : ownerJid2,
                  fromMe: isFromMe2,
                  body,
                  id: baileysMsg.key.id ? { _serialized: baileysMsg.key.id } : {},
                  hasMedia: !!(baileysMsg.message?.imageMessage || baileysMsg.message?.audioMessage || baileysMsg.message?.videoMessage || baileysMsg.message?.documentMessage || baileysMsg.message?.stickerMessage),
                  type: baileysMsg.message?.imageMessage ? 'image' : baileysMsg.message?.audioMessage ? 'audio' : baileysMsg.message?.videoMessage ? 'video' : baileysMsg.message?.documentMessage ? 'document' : baileysMsg.message?.stickerMessage ? 'sticker' : 'chat',
                  isStatus: from === 'status@broadcast',
                  timestamp: baileysMsg.messageTimestamp || Math.floor(Date.now() / 1000),
                  _baileysMsg: baileysMsg
                };
                handleIncomingMessage(adapted);
              },
              onReady: (sock) => {
                // Verificar que el número conectado coincide con el guardado
                const connectedNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
                if (savedNumber && connectedNumber && connectedNumber !== savedNumber) {
                  console.log(`[AUTO-INIT] 🚫 OWNER: número no coincide! Guardado: ${savedNumber}, Conectado: ${connectedNumber}. Desconectando.`);
                  sock.logout().catch(() => {});
                  return;
                }

                console.log(`[AUTO-INIT] ✅ Owner conectado (${connectedNumber})`);
                isReady = true;
                io.emit('whatsapp_ready', { status: 'connected' });

                // Guardar/actualizar número del owner para detección correcta
                if (connectedNumber) {
                  admin.firestore().collection('users').doc(OWNER_UID).update({
                    whatsapp_owner_number: connectedNumber,
                    whatsapp_owner_jid: `${connectedNumber}@s.whatsapp.net`,
                    whatsapp_connected_at: new Date()
                  }).catch(() => {});
                }

                cerebroAbsoluto.init({
                  whatsappClient: sock,
                  generateAIContent,
                  onTrainingUpdate: () => { saveDB(); },
                  dataDir: DATA_DIR,
                  initialTrainingData: cerebroAbsoluto.getTrainingData()
                });
                webScraper.init({
                  generateAIContent,
                  appendLearning: cerebroAbsoluto.appendLearning
                });
              }
            } : {
              // Tenant no-owner: verificar número al conectar
              onReady: (sock) => {
                const connectedNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
                if (savedNumber && connectedNumber && connectedNumber !== savedNumber) {
                  console.log(`[AUTO-INIT] 🚫 Tenant ${uid.substring(0, 12)}...: número no coincide! Guardado: ${savedNumber}, Conectado: ${connectedNumber}. Desconectando.`);
                  sock.logout().catch(() => {});
                  return;
                }
                console.log(`[AUTO-INIT] ✅ Tenant ${uid.substring(0, 12)}... conectado (${connectedNumber})`);
                if (connectedNumber) {
                  admin.firestore().collection('users').doc(uid).update({
                    whatsapp_number: connectedNumber,
                    whatsapp_connected_at: new Date()
                  }).catch(() => {});
                }
              }
            };

            tenantManager.initTenant(uid, gKey, io, {}, options);
            console.log(`[AUTO-INIT] 🚀 ${isOwner ? 'Owner' : 'Tenant'} ${uid.substring(0, 12)}... init disparado`);

            // Pausa 1.5s entre inits para no saturar WhatsApp
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) {
            console.error(`[AUTO-INIT] ❌ Error reconectando ${uid.substring(0, 12)}...:`, e.message);
          }
        }

        console.log('[AUTO-INIT] ✅ Auto-reconexión completada.');
      } catch (e) {
        console.error('[AUTO-INIT] ❌ Error general:', e.message);
      }
    }, 3000);
  } else {
    console.log('[AUTO-INIT] ⏭️ SKIP_WA_INIT activo. Sin auto-reconexión.');
  }
});

// ============================================
// FIX 5 — DOCUMENTOS: UPLOAD Y PROCESAMIENTO
// ============================================

const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ✅ P3: Endpoint de documentos multi-tenant
app.post('/api/tenant/:uid/documents/upload', uploadMiddleware.single('file'), async (req, res) => {
  try {
    const { uid } = req.params;

    // Validación NASA-grade: fallar si UID inválido
    if (!uid || typeof uid !== 'string' || uid.length < 10) {
      console.error(`[DOCS] ⚠️ Invalid UID: ${uid}`);
      return res.status(400).json({ error: 'UID inválido' });
    }

    if (!req.file) {
      console.warn(`[DOCS:${uid}] No file received`);
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    const { buffer, mimetype, originalname } = req.file;
    let text = '';

    if ((mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) && pdfParse) {
      const data = await pdfParse(buffer);
      text = data.text || '';
    } else if ((mimetype.includes('word') || originalname.toLowerCase().endsWith('.docx')) && mammoth) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } else {
      // TXT y otros formatos de texto
      text = buffer.toString('utf-8');
    }

    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 20) {
      return res.status(400).json({ error: 'No se pudo extraer texto del archivo. Asegurate de que el PDF tenga texto seleccionable (no escaneado).' });
    }

    // Dividir en chunks y guardar en cerebroAbsoluto
    const chunkSize = 600;
    const savedChunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize).trim();
      if (chunk.length > 40) {
        cerebroAbsoluto.appendLearning(`[${originalname}] ${chunk}`, 'DOC');
        savedChunks.push(chunk);
      }
    }
    saveDB();

    console.log(`[DOCS] "${originalname}" procesado — ${savedChunks.length} fragmentos guardados en cerebro`);
    res.json({ ok: true, chunks: savedChunks.length, preview: text.substring(0, 200) });
  } catch (e) {
    console.error('[DOCS] Error procesando archivo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// FIX 2 — EMAIL: CONFIGURACIÓN Y ENVÍO
// ============================================

app.post('/api/email/config', express.json(), async (req, res) => {
  try {
    const { smtpHost, smtpPort, smtpUser, smtpPass, email } = req.body || {};
    if (smtpHost !== undefined) userProfile.smtpHost = smtpHost;
    if (smtpPort !== undefined) userProfile.smtpPort = parseInt(smtpPort) || 587;
    if (smtpUser !== undefined) userProfile.smtpUser = smtpUser;
    if (smtpPass !== undefined) userProfile.smtpPass = smtpPass;
    if (email !== undefined) userProfile.email = email;
    saveDB();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/email/config', async (req, res) => {
  res.json({
    smtpHost: userProfile.smtpHost || '',
    smtpPort: userProfile.smtpPort || 587,
    smtpUser: userProfile.smtpUser || '',
    email: userProfile.email || '',
    configured: !!(userProfile.smtpHost && userProfile.smtpPass)
  });
});

app.post('/api/email/send', express.json(), async (req, res) => {
  try {
    const { to, subject, body, html } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: 'to y subject son requeridos' });
    if (!userProfile.smtpPass) return res.status(400).json({ error: 'SMTP no configurado. Configurá primero en el Dashboard.' });

    const transporter = nodemailer.createTransport({
      host: userProfile.smtpHost || 'smtp.gmail.com',
      port: userProfile.smtpPort || 587,
      secure: (userProfile.smtpPort === 465),
      auth: {
        user: userProfile.smtpUser || userProfile.email,
        pass: userProfile.smtpPass
      }
    });

    await transporter.sendMail({
      from: `"MIIA" <${userProfile.email}>`,
      to,
      subject,
      text: body || '',
      html: html || undefined
    });

    console.log(`[EMAIL] Enviado a ${to}: "${subject}"`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[EMAIL] Error enviando:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// FIX 3 — EMAIL: LECTURA Y APRENDIZAJE (IMAP)
// ============================================

app.post('/api/email/imap-config', express.json(), async (req, res) => {
  try {
    const { imapHost, imapUser, imapPass, imapFolder, emailLearningEnabled } = req.body || {};
    if (imapHost !== undefined) userProfile.imapHost = imapHost;
    if (imapUser !== undefined) userProfile.imapUser = imapUser;
    if (imapPass !== undefined) userProfile.imapPass = imapPass;
    if (imapFolder !== undefined) userProfile.imapFolder = imapFolder || 'INBOX';
    if (emailLearningEnabled !== undefined) userProfile.emailLearningEnabled = !!emailLearningEnabled;
    saveDB();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/email/imap-config', async (req, res) => {
  res.json({
    imapHost: userProfile.imapHost || '',
    imapUser: userProfile.imapUser || '',
    imapFolder: userProfile.imapFolder || 'INBOX',
    emailLearningEnabled: !!userProfile.emailLearningEnabled,
    lastEmailCheck: userProfile.lastEmailCheck || null,
    configured: !!(userProfile.imapHost && userProfile.imapPass)
  });
});

// Endpoint manual para disparar una revisión de emails
app.post('/api/email/scan', async (req, res) => {
  try {
    const result = await checkEmailInbox();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function checkEmailInbox() {
  if (!userProfile.imapHost || !userProfile.imapPass || !userProfile.emailLearningEnabled) {
    return { skipped: true, reason: 'IMAP no configurado o aprendizaje desactivado' };
  }

  let learned = 0;
  const client = new ImapFlow({
    host: userProfile.imapHost,
    port: 993,
    secure: true,
    auth: { user: userProfile.imapUser || userProfile.email, pass: userProfile.imapPass },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(userProfile.imapFolder || 'INBOX');
    try {
      const since = new Date(userProfile.lastEmailCheck || Date.now() - 7 * 24 * 60 * 60 * 1000);
      for await (const msg of client.fetch({ since }, { envelope: true, bodyStructure: true, source: true })) {
        try {
          const raw = msg.source?.toString() || '';
          // Extraer texto plano básico (quitar headers y HTML)
          const bodyMatch = raw.match(/\r?\n\r?\n([\s\S]+)/);
          let text = bodyMatch ? bodyMatch[1] : raw;
          text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 800);
          if (text.length > 60) {
            const subject = msg.envelope?.subject || '';
            cerebroAbsoluto.appendLearning(`[Email: ${subject}] ${text}`, 'EMAIL');
            learned++;
          }
        } catch (_) {}
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error('[IMAP] Error:', e.message);
    return { error: e.message };
  }

  userProfile.lastEmailCheck = Date.now();
  if (learned > 0) saveDB();
  console.log(`[IMAP] ${learned} emails procesados para aprendizaje`);
  return { ok: true, learned };
}

// ============================================
// FIX 4 — GOOGLE CALENDAR: OAUTH + CITAS
// ============================================

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://api.miia-app.com/api/auth/google/callback'
  );
}

// uid se pasa como query param ?uid=... desde el dashboard (el usuario ya está autenticado en el browser)
app.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).send('Google OAuth no configurado. Agrega GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Railway.');
  }
  const uid = req.query.uid;
  if (!uid) return res.status(400).send('uid requerido');
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
    state: uid  // pasamos uid para recuperarlo en el callback
  });
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state: uid } = req.query;
    if (!code) return res.status(400).send('Código OAuth no recibido');
    if (!uid) return res.status(400).send('uid no recibido en state');
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    // Guardar tokens en Firestore por usuario (multi-tenant)
    await admin.firestore().collection('users').doc(uid).set({
      googleTokens: tokens,
      calendarEnabled: true,
      googleCalendarId: 'primary'
    }, { merge: true });
    console.log(`[GCAL] Google Calendar conectado para uid=${uid}`);
    res.send('<html><body style="background:#0f0f0f;color:#fff;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center"><h2>✅ Google Calendar conectado</h2><p>Ya podés cerrar esta ventana y volver al Dashboard.</p></div></body></html>');
  } catch (e) {
    console.error('[GCAL] OAuth error:', e.message);
    res.status(500).send('Error conectando Google Calendar: ' + e.message);
  }
});

app.get('/api/calendar/status', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const doc = await admin.firestore().collection('users').doc(uid).get();
    const data = doc.exists ? doc.data() : {};
    res.json({
      connected: !!(data.googleTokens),
      calendarEnabled: !!data.calendarEnabled,
      calendarId: data.googleCalendarId || 'primary'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/calendar/config', requireRole('owner', 'agent'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { calendarEnabled, calendarId } = req.body || {};
    const update = {};
    if (calendarEnabled !== undefined) update.calendarEnabled = !!calendarEnabled;
    if (calendarId !== undefined) update.googleCalendarId = calendarId;
    await admin.firestore().collection('users').doc(uid).set(update, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/calendar/disconnect', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const uid = req.user.uid;
    await admin.firestore().collection('users').doc(uid).set({
      googleTokens: null,
      calendarEnabled: false
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getCalendarClient(uid) {
  const doc = await admin.firestore().collection('users').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  if (!data.googleTokens) throw new Error('Google Calendar no conectado para este usuario');
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(data.googleTokens);
  // Auto-refresh token si expiró
  oauth2Client.on('tokens', async (tokens) => {
    const updated = { ...data.googleTokens, ...tokens };
    await admin.firestore().collection('users').doc(uid).set({ googleTokens: updated }, { merge: true });
  });
  return { cal: google.calendar({ version: 'v3', auth: oauth2Client }), calId: data.googleCalendarId || 'primary' };
}

async function checkCalendarAvailability(dateStr, uid) {
  // dateStr: 'YYYY-MM-DD'
  const { cal, calId } = await getCalendarClient(uid);

  // Parsear fecha
  let targetDate = new Date(dateStr);
  if (isNaN(targetDate)) targetDate = new Date(); // fallback a hoy

  const timeMin = new Date(targetDate);
  timeMin.setHours(9, 0, 0, 0);
  const timeMax = new Date(targetDate);
  timeMax.setHours(18, 0, 0, 0);

  const response = await cal.events.list({
    calendarId: calId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const events = response.data.items || [];
  const busySlots = events.map(e => ({
    start: new Date(e.start.dateTime || e.start.date),
    end: new Date(e.end.dateTime || e.end.date),
    title: e.summary
  }));

  // Calcular slots libres de 1 hora entre 9am-6pm
  const freeSlots = [];
  for (let h = 9; h < 18; h++) {
    const slotStart = new Date(targetDate);
    slotStart.setHours(h, 0, 0, 0);
    const slotEnd = new Date(targetDate);
    slotEnd.setHours(h + 1, 0, 0, 0);
    const overlap = busySlots.some(b => b.start < slotEnd && b.end > slotStart);
    if (!overlap) freeSlots.push(`${h}:00 - ${h + 1}:00`);
  }

  return { date: targetDate.toLocaleDateString('es-ES'), busySlots: busySlots.length, freeSlots };
}

/**
 * createCalendarEvent — Crea evento en Google Calendar
 * @param {Object} opts
 * @param {string} opts.summary - Título del evento
 * @param {string} opts.dateStr - Fecha 'YYYY-MM-DD' o 'YYYY-MM-DDTHH:mm'
 * @param {number} opts.startHour - Hora inicio (0-23)
 * @param {number} opts.endHour - Hora fin (0-23)
 * @param {string} opts.attendeeEmail - Email del invitado (opcional)
 * @param {string} opts.description - Descripción del evento
 * @param {string} opts.uid - UID del owner en Firestore
 * @param {string} opts.timezone - Timezone IANA (ej: 'America/Bogota')
 * @param {string} opts.eventMode - 'presencial' | 'virtual' | 'telefono' (default: 'presencial')
 * @param {string} opts.location - Dirección física para presencial (opcional)
 * @param {string} opts.phoneNumber - Número de teléfono para modo telefónico (opcional)
 * @param {number} opts.reminderMinutes - Minutos antes para recordatorio (default: 10)
 */
async function createCalendarEvent({ summary, dateStr, startHour, endHour, attendeeEmail, description, uid, timezone, eventMode, location, phoneNumber, reminderMinutes }) {
  const { cal, calId } = await getCalendarClient(uid);

  // Determinar timezone: parámetro explícito > scheduleConfig del user > default Bogotá
  let tz = timezone;
  if (!tz) {
    try {
      const schedCfg = await getScheduleConfig(uid);
      tz = schedCfg?.timezone || 'America/Bogota';
    } catch { tz = 'America/Bogota'; }
  }

  // Construir fecha/hora en timezone local del usuario
  const targetDate = new Date(dateStr);
  const year = targetDate.getUTCFullYear() || new Date().getFullYear();
  const month = String((targetDate.getUTCMonth() || new Date().getMonth()) + 1).padStart(2, '0');
  const day = String(targetDate.getUTCDate() || new Date().getDate()).padStart(2, '0');
  const sH = String(startHour || 10).padStart(2, '0');
  const eH = String(endHour || (startHour || 10) + 1).padStart(2, '0');

  // ═══ MODO DEL EVENTO: presencial / virtual / teléfono ═══
  const mode = (eventMode || 'presencial').toLowerCase().trim();
  let eventDescription = description || 'Agendado automáticamente por MIIA';
  let eventLocation = '';
  let conferenceData = null;

  if (mode === 'virtual') {
    // Google Meet — conferenceData genera link automáticamente
    conferenceData = {
      createRequest: {
        requestId: `miia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    };
    eventDescription += '\n\n📹 Reunión virtual — el link de Google Meet se adjunta automáticamente.';
    console.log(`[GCAL] 📹 Modo VIRTUAL: se generará link de Google Meet`);
  } else if (mode === 'telefono' || mode === 'telefónico') {
    // Llamada telefónica — incluir número en descripción
    const phone = phoneNumber || '';
    eventLocation = phone ? `Llamada telefónica: ${phone}` : 'Llamada telefónica';
    eventDescription += phone
      ? `\n\n📞 Llamada telefónica al: ${phone}`
      : '\n\n📞 Llamada telefónica (número pendiente de confirmar)';
    console.log(`[GCAL] 📞 Modo TELÉFONO: ${phone || 'sin número especificado'}`);
  } else {
    // Presencial — incluir dirección si existe
    if (location) {
      eventLocation = location;
      eventDescription += `\n\n📍 Ubicación: ${location}`;
    }
    console.log(`[GCAL] 📍 Modo PRESENCIAL: ${location || 'sin dirección especificada'}`);
  }

  // ═══ RECORDATORIO: 10 minutos por defecto (hardcodeado, owner puede cambiar) ═══
  const reminder = reminderMinutes ?? 10;

  const event = {
    summary: summary || 'Reunión con MIIA',
    description: eventDescription,
    start: { dateTime: `${year}-${month}-${day}T${sH}:00:00`, timeZone: tz },
    end: { dateTime: `${year}-${month}-${day}T${eH}:00:00`, timeZone: tz },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: reminder }
      ]
    }
  };

  // Agregar ubicación si existe
  if (eventLocation) event.location = eventLocation;

  // Agregar conferenceData para Google Meet
  if (conferenceData) event.conferenceData = conferenceData;

  // Insert con conferenceDataVersion si es virtual (requerido por API)
  const insertParams = { calendarId: calId, resource: event, sendUpdates: 'all' };
  if (conferenceData) insertParams.conferenceDataVersion = 1;

  const response = await cal.events.insert(insertParams);

  // Extraer link de Meet si se creó
  const meetLink = response.data?.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null;

  console.log(`[GCAL] ✅ Evento creado: "${summary}" el ${dateStr} ${sH}:00 (${tz}) modo=${mode} reminder=${reminder}min uid=${uid}${meetLink ? ` meet=${meetLink}` : ''}`);
  return { ok: true, eventId: response.data.id, htmlLink: response.data.htmlLink, meetLink, mode };
}

// Endpoints para que el dashboard/MIIA consulte/cree citas
app.get('/api/calendar/availability', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date requerido (YYYY-MM-DD)' });
    const result = await checkCalendarAvailability(date, req.user.uid);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/calendar/event', requireRole('owner', 'agent'), express.json(), async (req, res) => {
  try {
    const result = await createCalendarEvent({ ...(req.body || {}), uid: req.user.uid });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export app for testing
module.exports = app;