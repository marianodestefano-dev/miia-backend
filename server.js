require('dotenv').config();

// Fix: gRPC DNS resolver for Firebase Admin SDK on Railway/Docker (Node 18)
process.env.GRPC_DNS_RESOLVER = 'native';

// ═══ B5 FIX: Interceptar STDOUT/STDERR directamente ═══
// libsignal (C++ native) escribe directo a stdout, bypassing console.log.
// El override de console.log/warn/error NO lo atrapa.
// Solución: interceptar process.stdout.write y process.stderr.write.
const _signalFilter = /Closing session:|SessionEntry|_chains:|chainKey:|ephemeralKeyPair|lastRemoteEphemeralKey|previousCounter|rootKey|indexInfo|baseKey:|baseKeyType|registrationId|currentRatchet|pubKey:|privKey:|remoteIdentityKey|Decrypted message with closed|Closing open session|Failed to decrypt message|<Buffer |pendingPreKey|signedKeyId|preKeyId|closed: -1|chainType:/;
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, encoding, callback) => {
  if (typeof chunk === 'string' && _signalFilter.test(chunk)) {
    if (typeof encoding === 'function') return encoding(); // callback was in encoding position
    if (typeof callback === 'function') return callback();
    return true;
  }
  return _origStdoutWrite(chunk, encoding, callback);
};
process.stderr.write = (chunk, encoding, callback) => {
  if (typeof chunk === 'string' && _signalFilter.test(chunk)) {
    if (typeof encoding === 'function') return encoding();
    if (typeof callback === 'function') return callback();
    return true;
  }
  return _origStderrWrite(chunk, encoding, callback);
};
// Mantener console.log/warn/error overrides como segunda capa de defensa
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
const _isSignalNoise = (...args) => {
  for (const a of args) {
    if (typeof a === 'string' && _signalFilter.test(a)) return true;
    if (a && typeof a === 'object') {
      if (Buffer.isBuffer(a) && a.length >= 16 && a.length <= 64) return true;
      if ('_chains' in a || 'currentRatchet' in a || 'indexInfo' in a) return true;
      if ('privKey' in a || 'rootKey' in a || 'ephemeralKeyPair' in a || 'chainKey' in a) return true;
      try {
        const keys = Object.keys(a);
        for (const k of keys) {
          const v = a[k];
          if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
            if ('privKey' in v || 'rootKey' in v || '_chains' in v || 'currentRatchet' in v) return true;
          }
        }
      } catch (_) { /* ignore non-enumerable */ }
    }
  }
  return false;
};
console.log = (...args) => { if (_isSignalNoise(...args)) return; _origLog(...args); };
console.warn = (...args) => { if (_isSignalNoise(...args)) return; _origWarn(...args); };
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

// Graceful shutdown: flush TODO a Firestore antes de cerrar (deploy/restart/crash)
// Esto permite que al arrancar de nuevo, AUTO-INIT reconecte rápido sin perder datos
process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] ⚠️ SIGTERM recibido — guardando TODOS los datos antes de morir...');
  const shutdownStart = Date.now();
  try { await saveAffinityToFirestore(); console.log('[SHUTDOWN] ✅ Affinity guardado'); } catch (e) { console.error('[SHUTDOWN] ❌ Error affinity:', e.message); }
  try { await saveToFirestore(); console.log('[SHUTDOWN] ✅ Persistent data guardado'); } catch (e) { console.error('[SHUTDOWN] ❌ Error persistent:', e.message); }
  try { const { persistTenantConversations } = require('./whatsapp/tenant_message_handler'); await persistTenantConversations(); console.log('[SHUTDOWN] ✅ TMH conversations guardadas'); } catch (e) { console.error('[SHUTDOWN] ❌ Error TMH convos:', e.message); }
  // Guardar timestamp de shutdown para que AUTO-INIT sepa cuánto estuvo offline
  try {
    await admin.firestore().collection('system').doc('shutdown_state').set({
      shutdownAt: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - shutdownStart) / 1000),
      reason: 'SIGTERM'
    });
    console.log('[SHUTDOWN] ✅ Shutdown state guardado en Firestore');
  } catch (e) { console.error('[SHUTDOWN] ❌ Error shutdown state:', e.message); }
  console.log(`[SHUTDOWN] 🏁 Shutdown completo en ${Date.now() - shutdownStart}ms. Adiós.`);
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
const { applyMiiaEmoji, detectOwnerMood, detectMessageTopic, resetOffended, getCurrentMiiaMood, isMiiaSleeping, MIIA_OFFICIAL_EMOJIS } = require('./core/miia_emoji');
const { buildPrompt, buildTenantBrainString, buildOwnerFamilyPrompt, buildEquipoPrompt, buildSportsPrompt, buildInvokedPrompt, buildOutreachLeadPrompt, MIIA_SALES_PROFILE } = require('./core/prompt_builder');
const { assemblePrompt } = require('./core/prompt_modules');
const interMiia = require('./core/inter_miia');
const { runSelfTest } = require('./core/self_test');
const autoDiag = require('./core/auto_diagnostics');

// ═══ AI — Clientes y adaptadores IA ═══
const { callGemini, callGeminiChat } = require('./ai/gemini_client');
const { PROVIDER_LABELS } = require('./ai/ai_client');

// ═══ SERVICES — Servicios externos ═══
const cotizacionGenerator = require('./services/cotizacion_generator');
const webScraper = require('./services/web_scraper');
const estadisticas = require('./services/estadisticas');
const mailService = require('./services/mail_service');
const protectionManager = require('./services/protection_manager');
const securityContacts = require('./services/security_contacts');
const biweeklyReport = require('./services/biweekly_report');
const priceTracker = require('./services/price_tracker');
const travelTracker = require('./services/travel_tracker');
const emailManager = require('./services/email_manager');
const configValidator = require('./services/config_validator');

// ═══ WHATSAPP — Baileys, tenants, mensajes ═══
const tenantManager = require('./whatsapp/tenant_manager');
const tenantMessageHandler = require('./whatsapp/tenant_message_handler');

// ═══ CORE — Task Scheduler ═══
const taskScheduler = require('./core/task_scheduler');
const { runPreprocess } = require('./core/miia_preprocess');
const { runPostprocess, runAIAudit, getFallbackMessage } = require('./core/miia_postprocess');
const salesAssets = require('./core/sales_assets');
const { startIntegrityEngine, verifyCalendarEvent } = require('./core/integrity_engine');
const integrityGuards = require('./core/integrity_guards');
const healthMonitor = require('./core/health_monitor');
const actionFeedback = require('./core/action_feedback');
const { shouldMiiaRespond, matchesBusinessKeywords, buildUnknownContactAlert, classifyUnknownContact } = require('./core/contact_gate');
const miiaInvocation = require('./core/miia_invocation');
const outreachEngine = require('./core/outreach_engine');
const miiaOutfit = require('./core/miia_outfit');
const contentSafety = require('./core/content_safety_shield');
const featureAnnouncer = require('./core/feature_announcer');
const tenantLogger = require('./core/tenant_logger');
const gmailIntegration = require('./integrations/gmail_integration');
const googleTasks = require('./integrations/google_tasks_integration');
const sheetsIntegration = require('./integrations/google_sheets_integration');
const reservationsIntegration = require('./integrations/reservations_integration');
const miiaGifs = require('./core/miia_gifs');
const googleServices = require('./integrations/google_services_integration');
const webScraperCore = require('./core/web_scraper');
const rateLimiter = require('./core/rate_limiter');
const privacyCounters = require('./core/privacy_counters');
const contactClassifier = require('./core/contact_classifier');
const slotPrivacy = require('./core/slot_privacy');
const weekendMode = require('./core/weekend_mode');
const probadita = require('./core/probadita');
const instagramHandler = require('./core/instagram_handler');
const numberMigration = require('./core/number_migration');
const privacyReport = require('./core/privacy_report');
const auditLogger = require('./core/audit_logger');
const waGateway = require('./whatsapp/whatsapp_gateway');
const aiGateway = require('./ai/ai_gateway');
const promptCache = require('./ai/prompt_cache');

// ═══ FEATURES — Sports, Integrations, Voice ═══
const businessesRouter = require('./routes/businesses');
const sportEngine = require('./sports/sport_engine');
const integrationEngine = require('./integrations/integration_engine');
const morningBriefing = require('./core/morning_briefing');
const ownerMemory = require('./core/owner_memory');
const nightlyBrain = require('./core/nightly_brain');
const biologicalClock = require('./core/biological_clock');
const patternEngine = require('./core/pattern_engine');
const linkTracker = require('./core/link_tracker');
const ttsEngine = require('./voice/tts_engine');
const kidsMode = require('./voice/kids_mode');
const googleCalendar = require('./core/google_calendar');

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

// ═══ COPYRIGHT HEADERS — Propiedad intelectual en cada respuesta ═══
app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'MIIA Engine');
  res.setHeader('X-Author', 'Mariano De Stefano');
  res.setHeader('X-Copyright', '(c) 2024-2026 MIIA App. All rights reserved.');
  next();
});

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
  'RAFA': { name: 'Sr. Rafael', relation: 'papá', emoji: '👴❤️' },
  'RAFAEL': { name: 'Sr. Rafael', relation: 'papá', emoji: '👴❤️' },
  'JEDIDO': { name: 'Sr. Rafael', relation: 'papá', emoji: '👴❤️' },
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
let contactTypes = {}; // { phone: 'familia' | 'lead' | 'cliente' }
let leadNames = {}; // { phone: 'nombre' }

// --- Mapeo LID ↔ Phone (Baileys linked devices) ---
// LID es un ID interno de WhatsApp que no contiene el número real del contacto
// Este mapeo se llena automáticamente y permite resolver LIDs a números reales
const lidToPhone = {}; // { '46510318301398': '573137501884@s.whatsapp.net' }
const phoneToLid = {}; // inverso

function registerLidMapping(lid, phone) {
  if (!lid || !phone || phone.includes('@lid')) return;
  const lidBase = lid.split('@')[0].split(':')[0];
  const phoneFull = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
  if (lidToPhone[lidBase] && lidToPhone[lidBase] === phoneFull) return; // ya existe, mismo valor

  // BLINDAJE ANTI-OVERWRITE (Sesión 34): Si ya hay un mapping DIFERENTE, NO sobreescribir
  // Un LID mapeado incorrectamente contamina TODAS las conversaciones futuras de esa persona
  if (lidToPhone[lidBase] && lidToPhone[lidBase] !== phoneFull) {
    console.log(`[LID-MAP] 🚨 CONFLICTO: ${lidBase} ya mapeado a ${lidToPhone[lidBase]}, se intentó sobreescribir con ${phoneFull} — BLOQUEADO`);
    console.log(`[LID-MAP] 🚨 Si el mapping viejo es incorrecto, hay que limpiarlo manualmente (migration script)`);
    return; // NO sobreescribir — mejor un mapping viejo que uno nuevo potencialmente incorrecto
  }

  lidToPhone[lidBase] = phoneFull;
  phoneToLid[phoneFull] = lidBase;
  console.log(`[LID-MAP] 🔗 ${lidBase} → ${phoneFull}`);
  // Persistir — no llamar saveDB() aquí para evitar thrashing durante sync masivo.
  // La persistencia ocurre en el ciclo normal de saveDB (cada 2 min via setInterval).
}

function resolveLid(jid) {
  if (!jid || !jid.includes('@lid')) return jid;
  const lidBase = jid.split('@')[0].split(':')[0];
  // Fuente 1: mapa local (llenado por registerLidMapping)
  if (lidToPhone[lidBase]) return lidToPhone[lidBase];
  // Fuente 2: mapa de contactos de WhatsApp (llenado por contacts.upsert/update en tenant_manager)
  // Esto cubre TODOS los contactos del teléfono — la solución definitiva para familia
  const fromContacts = tenantManager.resolveLidFromContacts(OWNER_UID, jid);
  if (fromContacts) {
    // Registrar en mapa local para futuras resoluciones rápidas
    registerLidMapping(jid, fromContacts);
    console.log(`[LID-MAP] 📇 Resuelto via contactos WhatsApp: ${lidBase} → ${fromContacts}`);
    return fromContacts;
  }
  return jid; // no resuelto
}

// --- Variables MIIA (portadas desde index.js) ---
let lastSentByBot = {};
let sentMessageIds = new Set();
let lastAiSentBody = {};
let lastMessageKey = {};    // 🔧 Para self-chat: guardar message.key más reciente por contacto
let miiaPausedUntil = 0;

// ═══ MIIA_PHONE_REGISTRY — Previene loops MIIA↔MIIA entre instancias ═══
// Contiene TODOS los teléfonos que corren una instancia de MIIA.
// Si un mensaje llega desde un phone que está en el registry → es otra MIIA → no responder.
// Se carga de Firestore al startup + se actualiza cuando se registran nuevos tenants.
const MIIA_PHONE_REGISTRY = new Set();
// Zero-Width Space marker: MIIA lo agrega al inicio de TODOS sus mensajes a leads.
// Cuando otra MIIA recibe un mensaje que empieza con \u200B → sabe que es de otra MIIA → ignora.
// Invisible para humanos en WhatsApp, pero detectable por código.
const ZERO_WIDTH_MARKER = '\u200B';
// trainingData vive SOLO en cerebroAbsoluto (fuente única de verdad) — NO duplicar aquí
let leadSummaries = {};
let conversationMetadata = {};
let isProcessing = {};
let pendingResponses = {};  // re-trigger cuando llegan mensajes mientras se procesa
let messageTimers = {};     // debounce 3s por contacto — acumula mensajes antes de responder
let pendingQuotedText = {}; // quotedText del último mensaje por phone (para pasar a processMiiaResponse)
const RESET_ALLOWED_PHONES = ['573163937365', '573054169969'];
let keywordsSet = [];
// FAMILY CONTACTS — Se carga dinámicamente desde Firestore (miia_persistent/contacts)
// YA NO tiene datos hardcodeados. Toda la data vive en Firestore per-tenant.
// loadDB() y loadFromFirestore() pueblan este objeto al arrancar.
// MIGRACIÓN Sesión 34: Eliminados 14 contactos hardcodeados → fuente única = Firestore.
let familyContacts = {};
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
let vacunaCounter = {};
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
  if (scheduleConfig.alwaysOn) return true; // 24/7 mode — MIIA CENTER y tenants que quieran responder siempre
  // Timezone: usar config del owner, o auto-detectar por teléfono del owner, o fallback Bogotá
  let tz = scheduleConfig.timezone;
  if (!tz && OWNER_PHONE) {
    const country = messageLogic.getCountryFromPhone(OWNER_PHONE);
    tz = messageLogic.getTimezoneForCountry(country);
  }
  tz = tz || 'America/Bogota';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const day = now.getDay(); // 0=dom, 1=lun...
  const h = now.getHours();
  const m = now.getMinutes();
  const currentTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;

  // Chequear día activo
  if (scheduleConfig.activeDays && !scheduleConfig.activeDays.includes(day)) return false;

  // Chequear horario — default 7:00-19:00 (hora LOCAL del país del owner)
  const start = scheduleConfig.startTime || '07:00';
  const end = scheduleConfig.endTime || '19:00';
  if (currentTime < start || currentTime >= end) return false;

  return true;
}

// ═══ TASK SCHEDULER — Inicialización ═══
taskScheduler.initTaskScheduler({
  notifyOwner: async (msg) => {
    const sock = getOwnerSock();
    if (!sock?.user?.id) return;
    const ownerJid = sock.user.id;
    const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
    await safeSendMessage(ownerSelf, msg, { isSelfChat: true });
  }
});

// ═══ MOTOR DE SEGUIMIENTO AUTOMÁTICO DE LEADS ═══
// Corre cada hora. Revisa leads sin respuesta y envía followup contextual.
// REGLA: Solo en horario de negocios (default 8-19, configurable por owner).
// REGLA: NO domingos. NO festivos del país del owner.
// REGLA: Respeta keywords cold, modo silencio, y max seguimientos.
async function runFollowupEngine() {
  if (!OWNER_UID) return;
  const scheduleConfig = await getScheduleConfig(OWNER_UID) || {};

  // Ventana horaria configurable (default 8-19, horario de negocios real)
  const tz = scheduleConfig.timezone || 'America/Bogota';
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const h = localNow.getHours();
  const dayOfWeek = localNow.getDay(); // 0=domingo
  const followupStartHour = scheduleConfig.followupStartHour ?? 8;
  const followupEndHour = scheduleConfig.followupEndHour ?? 19;

  // NO domingos (respetuoso con días de descanso)
  if (dayOfWeek === 0) {
    console.log(`[FOLLOWUP] ⏸️ Domingo — sin seguimientos (respeto día de descanso).`);
    return;
  }

  // NO festivos del país del owner
  const ownerCountry = getCountryFromPhone(OWNER_PHONE);
  if (isHoliday(localNow, ownerCountry)) {
    console.log(`[FOLLOWUP] ⏸️ Festivo en ${ownerCountry} — sin seguimientos.`);
    return;
  }

  if (h < followupStartHour || h >= followupEndHour) {
    console.log(`[FOLLOWUP] ⏸️ Fuera de ventana (${h}h, ventana ${followupStartHour}-${followupEndHour}h ${tz}). Sin seguimientos.`);
    return;
  }

  // Defaults sensatos: 1 día para primer follow-up, máximo 3 intentos
  const followupDays = scheduleConfig.followupDays || 1;
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

    // Variables del lead (usadas en re-contacto Y followup normal)
    const leadName = leadNames[phone] || '';
    const firstName = leadName ? leadName.split(' ')[0] : '';
    const lastUserMsg = msgs.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const lastMiiaMsg = msgs.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';

    // Re-contacto 7d: si tiene recontactAt pendiente y ya pasó el tiempo, ejecutar
    if (fData.coldFarewellSent && fData.recontactAt && !fData.recontactSent) {
      if (new Date(fData.recontactAt).getTime() <= Date.now()) {
        console.log(`[FOLLOWUP] 🔄 Re-contacto 7d para ${baseNum} (despedida fue el ${fData.coldFarewellAt})`);
        try {
          const rePrompt = biologicalClock.buildFollowupPrompt('farewell_recontact', firstName, lastUserMsg, lastMiiaMsg, 0, userProfile);
          const reResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, rePrompt, {}, { enableSearch: false });
          const reMsg = reResult?.text?.trim();
          if (reMsg && reMsg.length > 10) {
            await safeSendMessage(phone, reMsg);
            console.log(`[FOLLOWUP] 🔄✅ Re-contacto 7d enviado a ${baseNum}: "${reMsg.substring(0, 80)}"`);
          }
        } catch (reErr) {
          console.warn(`[FOLLOWUP] ⚠️ Error re-contacto 7d: ${reErr.message}`);
        }
        await followupRef.set({ ...fData, recontactSent: true, recontactSentAt: new Date().toISOString(), silenced: true, archived: true }, { merge: true });
        sent++;
        await new Promise(r => setTimeout(r, 3000));
      }
      continue;
    }
    if (fData.count >= followupMax) {
      if (followupFinal === 'archive' && !fData.archived) {
        await followupRef.set({ ...fData, archived: true, archivedAt: new Date().toISOString() }, { merge: true });
        console.log(`[FOLLOWUP] 📦 Lead ${baseNum} archivado (${fData.count}/${followupMax}).`);
      }
      continue;
    }

    // Biological Clock: clasificar estado del lead y generar followup contextual
    const leadState = biologicalClock.classifyLeadState(lastUserMsg, lastMiiaMsg, conversationMetadata[phone]);

    // Si el lead está frío (dijo "no me interesa" etc) → despedida elegante + silenciar
    if (leadState.state === 'cold' && !fData.coldFarewellSent) {
      console.log(`[FOLLOWUP] ❄️ Lead ${baseNum} está frío (señal: ${leadState.signal}). Enviando despedida elegante.`);
      try {
        const coldPrompt = biologicalClock.buildFollowupPrompt('cold', firstName, lastUserMsg, lastMiiaMsg, fData.count || 0, userProfile);
        const coldResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, coldPrompt, {}, { enableSearch: false });
        const coldMsg = coldResult?.text?.trim();
        if (coldMsg && coldMsg.length > 10) {
          await safeSendMessage(phone, coldMsg);
          console.log(`[FOLLOWUP] 👋❄️ Despedida cold enviada a ${baseNum}: "${coldMsg.substring(0, 80)}..."`);
        }
      } catch (coldErr) {
        console.warn(`[FOLLOWUP] ⚠️ Error en despedida cold: ${coldErr.message}`);
      }
      // Programar re-contacto a 7 días
      await followupRef.set({
        ...fData,
        coldFarewellSent: true,
        coldFarewellAt: new Date().toISOString(),
        coldReason: leadState.signal,
        recontactAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        silenced: false // NO silenciar todavía — el re-contacto a 7d necesita encontrarlo
      }, { merge: true });
      sent++;
      // Notificar al owner
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
        `❄️ *${firstName || baseNum}* dijo que no le interesa. Le mandé una despedida con clase.\nEn 7 días le escribo una última vez. Si querés que no lo recontacte, decime "no recontactar ${firstName || baseNum}".`,
        { isSelfChat: true }
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    // Si es frío y ya se envió despedida → verificar si toca re-contacto a 7 días
    if (leadState.state === 'cold' && fData.coldFarewellSent) {
      if (fData.recontactAt && new Date(fData.recontactAt).getTime() <= Date.now() && !fData.recontactSent) {
        console.log(`[FOLLOWUP] 🔄 Re-contacto 7d para lead frío ${baseNum}`);
        try {
          const recontactPrompt = biologicalClock.buildFollowupPrompt('farewell_recontact', firstName, lastUserMsg, lastMiiaMsg, 0, userProfile);
          const reResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, recontactPrompt, {}, { enableSearch: false });
          const reMsg = reResult?.text?.trim();
          if (reMsg && reMsg.length > 10) {
            await safeSendMessage(phone, reMsg);
            console.log(`[FOLLOWUP] 🔄✅ Re-contacto 7d enviado a ${baseNum}: "${reMsg.substring(0, 80)}..."`);
          }
        } catch (reErr) {
          console.warn(`[FOLLOWUP] ⚠️ Error en re-contacto 7d: ${reErr.message}`);
        }
        await followupRef.set({ ...fData, recontactSent: true, recontactSentAt: new Date().toISOString(), silenced: true }, { merge: true });
        sent++;
        await new Promise(r => setTimeout(r, 3000));
      }
      continue;
    }

    // Verificar delay sugerido por el estado
    const suggestedDelayMs = (leadState.suggestedDelayHours || 24) * 3600000;
    const lastFollowupTime = fData.lastFollowup ? new Date(fData.lastFollowup).getTime() : 0;
    if (lastFollowupTime && (Date.now() - lastFollowupTime) < suggestedDelayMs) {
      continue; // Aún no pasó el tiempo sugerido desde el último followup
    }

    const isLast = (fData.count + 1) >= followupMax;
    let msg;

    try {
      const followupPrompt = biologicalClock.buildFollowupPrompt(
        leadState.state, firstName, lastUserMsg, lastMiiaMsg, fData.count || 0, userProfile
      );
      console.log(`[FOLLOWUP] 🧠 BioClock: lead ${baseNum} estado=${leadState.state} señal=${leadState.signal} followup #${(fData.count || 0) + 1}`);
      const aiResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, followupPrompt, {}, { enableSearch: false });
      msg = aiResult?.text?.trim();
      if (!msg || msg.length < 10) throw new Error('IA no generó follow-up válido');
      console.log(`[FOLLOWUP] 🤖 IA generó follow-up: "${msg.substring(0, 80)}..."`);
    } catch (aiErr) {
      console.warn(`[FOLLOWUP] ⚠️ IA falló, usando fallback: ${aiErr.message}`);
      msg = isLast ? followupMsgLast : followupMsg1;
      if (firstName) msg = `${firstName}, ${msg.charAt(0).toLowerCase()}${msg.slice(1)}`;
    }

    try {
      await safeSendMessage(phone, msg);
      await followupRef.set({
        count: (fData.count || 0) + 1,
        lastFollowup: new Date().toISOString(),
        lastFollowupMsg: msg.substring(0, 200),
        silenced: false,
        isDespedida: isLast,
        leadState: leadState.state,
        leadSignal: leadState.signal
      }, { merge: true });
      sent++;
      console.log(`[FOLLOWUP] 📤 ${isLast ? '👋 DESPEDIDA' : `Seguimiento ${fData.count + 1}/${followupMax}`} → ${baseNum}`);

      // Si es despedida, notificar al owner + programar re-contacto 7 días
      if (isLast) {
        const despedidaNotif = `👋 *${firstName || baseNum}* — cerré el seguimiento después de ${followupMax} intentos sin respuesta.\nÚltimo que dijo: "${lastUserMsg.substring(0, 60)}"\nEn 7 días le escribo una última vez. Si no querés, decime "no recontactar ${firstName || baseNum}".`;
        safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, despedidaNotif, { isSelfChat: true }).catch(() => {});
        // Programar re-contacto a 7 días
        await followupRef.set({
          recontactAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          coldFarewellSent: true,
          coldFarewellAt: new Date().toISOString(),
        }, { merge: true });
      }
    } catch (e) {
      console.error(`[FOLLOWUP] ❌ Error enviando a ${baseNum}:`, e.message);
    }

    // Pausa entre envíos para no saturar WhatsApp
    await new Promise(r => setTimeout(r, 3000));
  }

  if (sent > 0) console.log(`[FOLLOWUP] ✅ ${sent} seguimiento(s) enviado(s).`);
}

// Cada hora (3600000ms). Primera ejecución 2 min post-startup.
// L3: Seguimiento de leads — medio, 1 verificación
// Followup humanizado: intervalo aleatorio 63-97 min (no cada hora exacta = más humano)
// Se auto-reprograma después de cada ejecución con un delay random
function scheduleNextFollowup() {
  const minMs = 63 * 60 * 1000; // 63 min
  const maxMs = 97 * 60 * 1000; // 97 min
  const randomDelay = minMs + Math.floor(Math.random() * (maxMs - minMs));
  console.log(`[FOLLOWUP] ⏰ Próximo ciclo en ${Math.round(randomDelay / 60000)} min`);
  setTimeout(async () => {
    await taskScheduler.executeWithConcentration(3, 'followup-engine', runFollowupEngine);
    scheduleNextFollowup(); // Auto-reprogramar con nuevo delay random
  }, randomDelay);
}
// Primera ejecución 2 min post-startup, luego ciclo aleatorio
setTimeout(() => {
  taskScheduler.executeWithConcentration(3, 'followup-engine', runFollowupEngine);
  scheduleNextFollowup();
}, 120000);

// ═══ AGENDA INTELIGENTE (FAMILIA + OWNER + LEADS MIIA CENTER) ═══
// Eventos proactivos: cumpleaños, recordatorios, retomar contacto, deportes (futuro)
// REGLA: Owner/familia → solo 10:00-22:00. Leads MIIA CENTER → 24/7 (son globales, distinto timezone).
async function runAgendaEngine() {
  if (!OWNER_UID) return;
  const scheduleConfig = await getScheduleConfig(OWNER_UID);
  const tz = scheduleConfig?.timezone || 'America/Bogota';
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const h = localNow.getHours();
  const isOwnerSafeHours = h >= 10 && h < 22;

  try {
    const now = new Date();
    const pendingSnap = await admin.firestore()
      .collection('users').doc(OWNER_UID).collection('miia_agenda')
      .where('status', '==', 'pending')
      .where('scheduledFor', '<=', now.toISOString())
      .limit(10)
      .get();

    // ═══ RETRY: Reintentar recordatorios que fallaron (1 retry, máx 30 min después) ═══
    try {
      const retrySnap = await admin.firestore()
        .collection('users').doc(OWNER_UID).collection('miia_agenda')
        .where('status', '==', 'error')
        .where('retryCount', '<', 1) // Solo 1 reintento
        .limit(5)
        .get();
      for (const doc of retrySnap.docs) {
        const evt = doc.data();
        // Solo reintentar si el error fue reciente (< 30 min)
        const errorAge = evt.errorAt ? (now - new Date(evt.errorAt)) : Infinity;
        if (errorAge < 1800000) { // < 30 min
          console.log(`[AGENDA:RETRY] 🔄 Reintentando recordatorio ${doc.id}: "${(evt.reason || '').substring(0, 40)}" (error: ${evt.error})`);
          await doc.ref.update({ status: 'pending', retryCount: (evt.retryCount || 0) + 1 });
        }
      }
    } catch (retryErr) {
      // Silent — retry es best-effort
    }

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
        // Pre-recordatorios: SIEMPRE enviar si el owner lo creó (manual, selfchat, calendar sync)
        // Solo bloquear por horario si es reminder auto-generado (followup, proactivo)
        const isOwnerCreated = evt.source === 'google_calendar_sync' || evt.source === 'selfchat' || evt.source === 'owner_manual' || evt.contactPhone === 'self';
        if (!isOwnerSafeHours && !isOwnerCreated && evt.source !== 'miia_center_lead') continue;

        // Guard ESTRICTO: si el evento no tiene datos mínimos, NO enviar basura al owner
        const reason = evt.reason || evt.title || '';
        if (!reason || reason === 'undefined') {
          console.log(`[AGENDA] ⏭️ Skip pre-recordatorio ${doc.id}: reason vacío/undefined — evento incompleto`);
          await doc.ref.update({ preReminderSent: true, skippedBroken: true });
          continue;
        }
        const hora = evt.scheduledForLocal ? evt.scheduledForLocal.split('T')[1]?.substring(0, 5) : '';
        const modeEmoji = evt.eventMode === 'virtual' ? '📹' : (evt.eventMode === 'telefono' || evt.eventMode === 'telefónico') ? '📞' : '📍';
        const modeLabel = evt.eventMode === 'virtual' ? 'Virtual (Meet)' : (evt.eventMode === 'telefono' || evt.eventMode === 'telefónico') ? 'Telefónico' : 'Presencial';
        const locationInfo = evt.eventLocation ? ` — ${evt.eventLocation}` : '';
        const meetInfo = evt.meetLink ? `\n🔗 ${evt.meetLink}` : '';
        const contactName = evt.contactName || '';
        const contactInfo = evt.contactPhone && evt.contactPhone !== 'self' && contactName && contactName !== 'undefined'
          ? ` con *${contactName}*`
          : (evt.contactPhone && evt.contactPhone !== 'self' && evt.contactPhone !== 'undefined' ? ` con *${evt.contactPhone}*` : '');

        const reminderMsg = `⏰ *En ${REMINDER_MINUTES} minutos:*\n${modeEmoji} ${reason}${contactInfo}\n🕐 ${hora || 'Hora no especificada'} | ${modeLabel}${locationInfo}${meetInfo}`;

        try {
          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, reminderMsg, { isSelfChat: true });
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
      // Guardia: si no tiene contactPhone, no se puede enviar — marcar como error y seguir
      if (!evt.contactPhone) {
        console.error(`[AGENDA] ❌ Evento ${doc.id} sin contactPhone — no se puede enviar. Datos: reason="${evt.reason}", contactName="${evt.contactName}"`);
        await doc.ref.update({ status: 'error', error: 'contactPhone undefined' });
        continue;
      }
      // Resolver destinatario: 'self' = recordatorio al owner
      const isOwnerReminder = evt.contactPhone === 'self' || evt.contactPhone === OWNER_PHONE;
      const phone = isOwnerReminder
        ? `${OWNER_PHONE}@s.whatsapp.net`
        : (evt.contactPhone.includes('@') ? evt.contactPhone : `${evt.contactPhone}@s.whatsapp.net`);

      // ═══ HORARIO: Si el CONTACTO pidió el recordatorio → hora EXACTA sin restricción ═══
      // Solo los recordatorios auto-generados para el owner respetan horario seguro
      const isMiiaCenterLeadEvt = evt.source === 'miia_center_lead';
      const contactRequested = !isOwnerReminder && evt.remindContact;
      // Eventos creados por el owner → SIEMPRE enviar, sin importar horario
      const isOwnerCreatedEvt = evt.source === 'google_calendar_sync' || evt.source === 'selfchat' || evt.source === 'owner_manual' || (isOwnerReminder && evt.contactPhone === 'self');
      if (!contactRequested && !isMiiaCenterLeadEvt && !isOwnerCreatedEvt && !isOwnerSafeHours) {
        // Recordatorio auto-generado, fuera de horario → esperar
        continue;
      }
      // Leads y contactos que pidieron recordatorio → se envía SIEMPRE a la hora exacta
      if (contactRequested || isMiiaCenterLeadEvt) {
        console.log(`[AGENDA] 🕐 Recordatorio a hora exacta para ${evt.contactName || evt.contactPhone} (pedido por contacto: ${!!contactRequested}, source: ${evt.source || 'default'})`);
      }

      // ═══ SEGURIDAD: Si remindContact=false y NO es para el owner, NO enviar ═══
      if (!isOwnerReminder && !evt.remindContact) {
        console.log(`[AGENDA] ⏭️ Evento ${doc.id} no tiene permiso para contactar a ${evt.contactName}. Solo owner.`);
        await doc.ref.update({ status: 'skipped_no_contact_permission' });
        continue;
      }

      // Guard ESTRICTO: si reason es vacío/undefined, evento roto — no mandar basura
      const evtReason = evt.reason || evt.title || '';
      if (!evtReason || evtReason === 'undefined') {
        console.log(`[AGENDA] ⏭️ Skip evento ${doc.id}: reason vacío/undefined — marcando como error`);
        await doc.ref.update({ status: 'error', error: 'reason undefined — evento incompleto' });
        continue;
      }
      const mentioned = evt.mentionedContact || '';
      const evtContact = evt.contactName || 'este contacto';
      // ═══ DETECCIÓN DE RETRASO: si scheduledFor pasó hace >5 min → disculpa IA ═══
      const scheduledTime = new Date(evt.scheduledFor);
      const delayMs = now - scheduledTime;
      const delayMinutes = Math.round(delayMs / 60000);
      const isLate = delayMinutes > 5; // >5 min de retraso = server estuvo caído o ciclo perdido
      const lateContext = isLate
        ? ` IMPORTANTE: Este recordatorio debió enviarse hace ${delayMinutes} minutos pero hubo un problema técnico. Disculpate brevemente por el retraso de forma natural (ej: "Perdón por el retraso!") y luego dale el recordatorio.`
        : '';

      // Hora formateada legible
      const evtHora = evt.scheduledForLocal ? evt.scheduledForLocal.split('T')[1]?.substring(0, 5) : (evt.scheduledFor ? new Date(evt.scheduledFor).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '');
      const modeStr = evt.mode === 'virtual' ? ' (virtual — Google Meet)' : evt.mode === 'telefono' ? ' (llamada telefónica)' : evt.location ? ` (en ${evt.location})` : '';

      const prompt = isOwnerReminder
        ? `Sos MIIA, asistente personal. Recordale a tu owner sobre este evento:\n- Qué: "${evtReason}"\n- Cuándo: ${evtHora ? `a las ${evtHora}` : 'ahora'}${mentioned ? `\n- Con quién: ${mentioned}` : ''}${modeStr ? `\n- Modalidad: ${modeStr}` : ''}${lateContext}\nGenerá un mensaje cálido y útil. Incluí la hora, el qué y el con quién. Si es presencial con ubicación, mencionala. Si es virtual, recordá que tiene link de Meet. Máximo 3 líneas. Tono: amigable, directo, con tu personalidad MIIA. NO uses formato de lista — escribí como si fuera un chat natural.`
        : `Sos MIIA. Tenés que recordarle a ${evtContact} sobre:\n- Qué: "${evtReason}"\n- Cuándo: ${evtHora ? `a las ${evtHora}` : 'ahora'}${mentioned ? `\n- Con quién: ${mentioned}` : ''}${modeStr ? `\n- Modalidad: ${modeStr}` : ''}${lateContext}\nGenerá un recordatorio natural y claro. Incluí hora y detalle. Máximo 2 líneas, tono amable. NO uses formato de lista.`;

      let enableSearch = evt.searchBefore || false;

      try {
        // SLEEP MODE: Si MIIA está dormida, enviar recordatorio crudo sin IA ni emoji
        if (isMiiaSleeping() && isOwnerReminder) {
          const hora = evt.scheduledForLocal ? evt.scheduledForLocal.split('T')[1]?.substring(0, 5) : '';
          const rawReason = evt.reason || evt.title || 'Evento programado';
          const rawReminder = `📖 ${hora ? hora + ' : ' : ''}${rawReason}${mentioned ? ` (con ${mentioned})` : ''}`;
          await safeSendMessage(phone, rawReminder, { isSelfChat: true });
          console.log(`[AGENDA-SLEEP] 📖 Recordatorio crudo enviado: "${rawReminder}"`);
          await doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const agendaGwResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, prompt, {}, { enableSearch });
        const response = agendaGwResult.text;
        if (response && response.length > 5) {
          // Enviar recordatorio al contacto destinatario
          // FIX: Si es recordatorio al owner, usar isSelfChat:true para que Baileys use sock.user.id
          await safeSendMessage(phone, response, { isSelfChat: isOwnerReminder, emojiCtx: { trigger: 'reminder' } });
          console.log(`[AGENDA] 📤 Recordatorio enviado a ${evt.contactName}${isLate ? ` (CON DISCULPA — ${delayMinutes}min retraso)` : ''}: "${response.substring(0, 60)}..."`);

          // Si lo pidió alguien del círculo (no el owner en self-chat), informar al owner también
          if (evt.requestedBy && evt.requestedBy !== `${OWNER_PHONE}@s.whatsapp.net` && evt.source !== 'owner_selfchat') {
            const lateNote = isLate ? ` (con ${delayMinutes}min de retraso por reinicio del servidor)` : '';
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `📅 Le recordé a *${evt.contactName}* sobre: "${(evt.reason || '').substring(0, 80)}"${lateNote}`,
              { isSelfChat: true, emojiCtx: { trigger: 'reminder' } }
            ).catch(() => {});
          }

          await doc.ref.update({ status: 'sent', sentAt: now.toISOString() });
        }
      } catch (e) {
        console.error(`[AGENDA] ❌ Error procesando evento ${doc.id}:`, e.message);
        await doc.ref.update({ status: 'error', error: e.message, errorAt: new Date().toISOString() });
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error(`[AGENDA] ❌ Error general:`, e.message);
  }
}

// Cada 5 min (300s) para capturar recordatorios 10min antes. Primera ejecución 3 min post-startup.
// L4: Agenda — alto, recordatorios no pueden fallar
setInterval(() => taskScheduler.executeWithConcentration(4, 'agenda-engine', runAgendaEngine), 300000);
setTimeout(() => taskScheduler.executeWithConcentration(4, 'agenda-engine', runAgendaEngine), 180000);

// ═══ GOOGLE CALENDAR SYNC — Leer eventos manuales y crear recordatorios ═══
// Si el owner crea un evento manualmente en Google Calendar, MIIA lo detecta y lo agrega a miia_agenda
// para enviarle recordatorio 10 min antes, igual que los eventos creados por MIIA.
async function syncGoogleCalendarEvents() {
  if (!OWNER_UID) return;

  try {
    // Verificar que el usuario tiene Google Calendar conectado
    const userDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    if (!userData.googleTokens || !userData.calendarEnabled) return;

    const { cal, calId } = await getCalendarClient(OWNER_UID);
    const scheduleConfig = await getScheduleConfig(OWNER_UID);
    const tz = scheduleConfig?.timezone || 'America/Bogota';

    // Leer eventos de las próximas 24 horas
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const response = await cal.events.list({
      calendarId: calId,
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const calEvents = response.data.items || [];
    if (calEvents.length === 0) return;

    // Leer eventos ya existentes en miia_agenda para no duplicar
    const existingSnap = await admin.firestore()
      .collection('users').doc(OWNER_UID).collection('miia_agenda')
      .where('status', 'in', ['pending', 'sent'])
      .get();

    const existingCalEventIds = new Set();
    const existingReasons = new Set();
    existingSnap.docs.forEach(d => {
      const data = d.data();
      if (data.calendarEventId) existingCalEventIds.add(data.calendarEventId);
      // También comparar por razón+hora para detectar duplicados sin calendarEventId
      if (data.reason && data.scheduledFor) existingReasons.add(`${data.reason}__${data.scheduledFor.substring(0, 16)}`);
    });

    let synced = 0;
    for (const evt of calEvents) {
      // Saltar si ya existe en miia_agenda (por calendarEventId)
      if (existingCalEventIds.has(evt.id)) continue;

      const summary = evt.summary || 'Evento sin título';
      const startDt = evt.start?.dateTime || evt.start?.date;
      if (!startDt) continue;

      const startISO = new Date(startDt).toISOString();

      // Saltar si hay un evento con misma razón+hora (probablemente creado por MIIA sin calendarEventId)
      const dedupeKey = `${summary}__${startISO.substring(0, 16)}`;
      if (existingReasons.has(dedupeKey)) continue;

      const endDt = evt.end?.dateTime || evt.end?.date;
      const location = evt.location || '';
      const meetLink = evt.hangoutLink || '';
      const description = evt.description || '';
      const attendees = (evt.attendees || []).map(a => a.email).filter(e => e).join(', ');

      // Determinar modo del evento
      let eventMode = 'presencial';
      if (meetLink || summary.toLowerCase().includes('meet') || summary.toLowerCase().includes('zoom') || summary.toLowerCase().includes('call')) {
        eventMode = 'virtual';
      } else if (summary.toLowerCase().includes('llamar') || summary.toLowerCase().includes('telefo')) {
        eventMode = 'telefono';
      }

      // Calcular hora local para display
      const localStart = new Date(startDt).toLocaleString('en-US', { timeZone: tz });
      const localStartDate = new Date(localStart);
      const localISO = `${localStartDate.getFullYear()}-${String(localStartDate.getMonth() + 1).padStart(2, '0')}-${String(localStartDate.getDate()).padStart(2, '0')}T${String(localStartDate.getHours()).padStart(2, '0')}:${String(localStartDate.getMinutes()).padStart(2, '0')}:00`;

      // Crear en miia_agenda
      const agendaEntry = {
        contactPhone: 'self',
        contactName: userData.name || 'Owner',
        reason: summary,
        scheduledFor: startISO,
        scheduledForLocal: localISO,
        status: 'pending',
        source: 'google_calendar_sync',
        calendarEventId: evt.id,
        eventMode,
        eventLocation: location,
        meetLink,
        preReminderSent: false,
        remindContact: false,
        createdAt: new Date().toISOString(),
        notes: `${description}${attendees ? `\nAsistentes: ${attendees}` : ''}`,
      };

      await admin.firestore()
        .collection('users').doc(OWNER_UID).collection('miia_agenda')
        .add(agendaEntry);

      synced++;
      console.log(`[CALENDAR-SYNC] 📅 Evento sincronizado: "${summary}" a las ${localISO.split('T')[1]}`);
    }

    if (synced > 0) {
      console.log(`[CALENDAR-SYNC] ✅ ${synced} evento(s) manual(es) sincronizado(s) desde Google Calendar`);
    }
  } catch (e) {
    // No bloquear si falla — Google Calendar es opcional
    if (e.message?.includes('no conectado') || e.message?.includes('invalid_grant')) {
      // Silencioso — Google Calendar no está conectado o tokens expirados
    } else {
      console.error(`[CALENDAR-SYNC] ❌ Error sincronizando:`, e.message);
    }
  }
}

// Cada 15 min (900s). Primera ejecución 4 min post-startup.
// L3: Calendar sync — medio, no crítico pero útil
setInterval(() => taskScheduler.executeWithConcentration(3, 'calendar-sync', syncGoogleCalendarEvents), 900000);
setTimeout(() => taskScheduler.executeWithConcentration(3, 'calendar-sync', syncGoogleCalendarEvents), 240000);

// ═══ INTEGRITY ENGINE — Verificación de promesas, preferencias, afinidades ═══
// Cada 5 min via Gemini Flash ($0). Detecta promesas rotas, aprende gustos/preferencias de contactos.
setTimeout(() => {
  if (!OWNER_UID) return;
  startIntegrityEngine({
    ownerUid: OWNER_UID,
    generateAI: async (prompt) => {
      try {
        const { callGemini } = require('./ai/gemini_client');
        const gemKey = process.env.GEMINI_API_KEY;
        if (!gemKey) return '';
        const result = await callGemini(gemKey, prompt, { model: 'gemini-2.0-flash' });
        return result || '';
      } catch (e) {
        console.error(`[INTEGRITY] ❌ Gemini Flash error: ${e.message}`);
        return '';
      }
    },
    safeSendMessage,
    ownerPhone: OWNER_PHONE,
    appendLearning: (text, source) => {
      cerebroAbsoluto.appendLearning(text, source);
      saveDB(); // Persistir inmediatamente al cerebro
    },
  });
  console.log('[INTEGRITY] 🚀 Integrity Engine wired — polling 5min + ADN Learning Vivo cada 1h (8am-8pm)');
}, 60000); // 1 min post-startup

// ═══ PROTECCIÓN: Check-in diario de contactos protegidos ═══
// Cada hora. Verifica inactividad y alerta al owner + adultos responsables.
async function runProtectionCheckin() {
  if (!OWNER_UID) return;
  try {
    const alerts = await protectionManager.runProtectionCheckin(OWNER_UID, conversations, conversationMetadata);
    if (alerts.length > 0) {
      const ownerJid = getOwnerSock()?.user?.id;
      if (ownerJid) {
        const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
        for (const alert of alerts) {
          await safeSendMessage(ownerSelf, alert.message, { isSelfChat: true });
        }
      }
    }
  } catch (e) {
    console.error(`[PROTECTION] ❌ Error en check-in:`, e.message);
  }
}
// L3: Check-in protección — medio
setInterval(() => taskScheduler.executeWithConcentration(3, 'protection-checkin', runProtectionCheckin), 3600000);
setTimeout(() => taskScheduler.executeWithConcentration(3, 'protection-checkin', runProtectionCheckin), 600000);

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

    // Sport engine inicializado — polling controlado por Morning Briefing (10AM + 3PM)
    console.log('[SPORT-ENGINE] ✅ Engine deportivo inicializado (polling controlado por Morning Briefing)');
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

    // Integraciones inicializadas — polling controlado por Morning Briefing (10AM + 3PM)
    console.log('[INTEGRATIONS] ✅ Engine de integraciones inicializado (polling controlado por Morning Briefing)');
  } catch (err) {
    console.error('[INTEGRATIONS] ❌ Error inicializando:', err.message);
  }
}, 360000);

// ═══ PRICE TRACKER + TRAVEL TRACKER — Seguimiento precios y vuelos ═══
setTimeout(() => {
  if (!OWNER_UID) return;
  try {
    priceTracker.initPriceTracker({
      generateAIContent,
      safeSendMessage,
      ownerPhone: OWNER_PHONE,
      ownerUid: OWNER_UID,
      getOwnerSock
    });
    // Precios inicializados — polling controlado por Morning Briefing (10AM + 3PM)
    console.log('[PRICE-TRACKER] ✅ Engine inicializado (polling controlado por Morning Briefing)');
  } catch (err) {
    console.error('[PRICE-TRACKER] ❌ Error inicializando:', err.message);
  }
  try {
    travelTracker.initTravelTracker({
      generateAIContent,
      safeSendMessage,
      getOwnerSock,
      ownerUid: OWNER_UID
    });
    // Travel inicializado — vuelos chequeados por Morning Briefing (10AM + 3PM)
    // Pasaporte: semanal, lo mantenemos independiente
    setInterval(() => taskScheduler.executeWithConcentration(2, 'passport-check', () => travelTracker.checkPassportExpiry(OWNER_UID)), 7 * 24 * 3600000);
    console.log('[TRAVEL] ✅ Engine inicializado (vuelos en Morning Briefing, pasaporte semanal)');
  } catch (err) {
    console.error('[TRAVEL] ❌ Error inicializando:', err.message);
  }
}, 420000); // 7 min post-startup

// ═══ MORNING BRIEFING — Reemplaza TODOS los pollings constantes ═══
// 10:00 AM + 3:00 PM (hora owner): deportes, precios, integraciones, vuelos
// Eventos deportivos en vivo → polling solo durante el evento
setTimeout(() => {
  if (!OWNER_UID) {
    console.log('[MORNING-BRIEFING] ⏭️ OWNER_UID no disponible, briefing desactivado');
    return;
  }
  const firestoreInstance = admin.firestore();
  morningBriefing.init(OWNER_UID, {
    sportEngine,
    integrationEngine,
    priceTracker,
    travelTracker,
    getScheduleConfig,
    isWithinSchedule,
    safeSendMessage,
    OWNER_PHONE,
    firestore: firestoreInstance,
  });
  ownerMemory.init(OWNER_UID, firestoreInstance);
  linkTracker.init(OWNER_UID, firestoreInstance, ownerMemory);
  nightlyBrain.init(OWNER_UID, {
    firestore: firestoreInstance,
    aiGateway,
    safeSendMessage,
    getScheduleConfig,
    OWNER_PHONE
  });
  patternEngine.init(OWNER_UID, {
    firestore: firestoreInstance,
    aiGateway
  });
}, 480000); // 8 min post-startup (después de que todos los engines estén listos)

// ═══ MODO FINDE — Check cada 30min si preguntar al owner (P3.4) ═══
setInterval(async () => {
  if (!OWNER_UID || !OWNER_PHONE) return;
  const tz = messageLogic.getTimezoneForCountry(messageLogic.getCountryFromPhone(OWNER_PHONE));
  if (weekendMode.shouldAskWeekendQuestion(OWNER_UID, tz)) {
    const ownerJid = `${OWNER_PHONE}@s.whatsapp.net`;
    const question = weekendMode.getWeekendQuestion();
    weekendMode.markAsked(OWNER_UID);
    try {
      const waSock = tenantManager.getTenantClient(OWNER_UID);
      if (waSock) {
        await waSock.sendMessage(ownerJid, { text: question });
        console.log(`[WEEKEND] 📨 Pregunta modo finde enviada al owner`);
      }
    } catch (e) {
      console.error(`[WEEKEND] ❌ Error enviando pregunta finde:`, e.message);
    }
  }
}, 1800000); // cada 30min

// ═══ INFORME PRIVACIDAD SEMESTRAL — Check diario (P3.7) ═══
setInterval(async () => {
  if (!OWNER_UID || !OWNER_PHONE) return;
  const tz = messageLogic.getTimezoneForCountry(messageLogic.getCountryFromPhone(OWNER_PHONE));
  if (privacyReport.shouldSendReport(tz)) {
    try {
      const report = await privacyReport.generateReport(OWNER_UID);
      const text = privacyReport.formatForWhatsApp(report);
      const ownerJid = `${OWNER_PHONE}@s.whatsapp.net`;
      const waSock2 = tenantManager.getTenantClient(OWNER_UID);
      if (waSock2) {
        await waSock2.sendMessage(ownerJid, { text });
        console.log(`[PRIVACY-REPORT] 📊 Informe semestral enviado al owner`);
      }
    } catch (e) {
      console.error(`[PRIVACY-REPORT] ❌ Error enviando informe:`, e.message);
    }
  }
}, 3600000); // cada hora (shouldSendReport filtra: solo 1ro ene/jul 9-10am)

let morningWakeupDone   = '';        // evita repetir el despertar en el mismo día
let morningBriefingDone = '';        // evita repetir el briefing en el mismo día
let _pendingOwnerConfirm = null;     // Confirmación pendiente del owner (cambio permanente)
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

// Micro-humanizer v2: typo 2% + minúscula inicial 7% — para parecer más humano
function maybeAddTypo(text) {
  if (!text || text.length < 5) return text;
  let result = text;

  // 7% de probabilidad: primera letra en minúscula (como escribe la gente real en WhatsApp)
  // NO aplicar si empieza con emoji, URL, nombre propio después de salto de línea, o tag [
  if (Math.random() < 0.07 && /^[A-ZÁÉÍÓÚÑ]/.test(result) && !result.startsWith('[') && !result.startsWith('http')) {
    result = result[0].toLowerCase() + result.slice(1);
  }

  // 2% de probabilidad: swap de 2 caracteres adyacentes (typo sutil)
  if (Math.random() < 0.02 && result.length > 10) {
    // Buscar posición que NO esté dentro de un tag [...] ni URL
    const safeZone = result.replace(/\[[^\]]*\]/g, m => ' '.repeat(m.length)); // mask tags
    const pos = Math.floor(Math.random() * (safeZone.length - 3)) + 1;
    if (safeZone[pos] !== ' ' && safeZone[pos + 1] !== ' ') {
      result = result.slice(0, pos) + result[pos + 1] + result[pos] + result.slice(pos + 2);
    }
  }

  return result;
}
let subscriptionState = {};          // { phone: { estado: 'asked'|'collecting'|'notified', data: {} } }
const MSG_SUSCRIPCION =
`¡Genial! Para armar tu link de acceso solo necesito dos datos:

1. Tu correo electrónico
2. Método de pago preferido: ¿tarjeta de crédito o débito?

El resto ya lo tengo del plan que conversamos. El link tiene una validez de 24 horas desde que te lo envío, así que cuando lo recibas conviene completar el proceso ese mismo día para no perder el descuento. 😊`;
let helpCenterData = '';
let userProfile = {
  name: '', phone: '', email: '', goal: 1500,
  // Email SMTP (envío)
  smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
  // Email IMAP (lectura/aprendizaje)
  imapHost: '', imapUser: '', imapPass: '', imapFolder: 'INBOX', emailLearningEnabled: false, lastEmailCheck: null,
  // Google Calendar
  googleTokens: null, calendarEnabled: false, googleCalendarId: 'primary'
};
const BLACKLISTED_NUMBERS = ['573023317570@s.whatsapp.net'];
const OWNER_PHONE = '573054169969'; // Número de MIIA (auto-venta)
const OWNER_PERSONAL_PHONE = '573163937365'; // Número personal de Mariano
const ADMIN_PHONES = ['573054169969', '573163937365']; // Ambos números son admin

// ═══ ownerConnectedPhone: se actualiza dinámicamente con el número REAL del sock ═══
let ownerConnectedPhone = ''; // Se llena en onReady con sock.user.id

// ═══ MIIA_PHONE_REGISTRY: Registrar phones propios al definirse ═══
MIIA_PHONE_REGISTRY.add(OWNER_PHONE);
MIIA_PHONE_REGISTRY.add(OWNER_PERSONAL_PHONE);
console.log(`[MIIA-REGISTRY] 📱 Phones registrados: ${OWNER_PHONE}, ${OWNER_PERSONAL_PHONE} (${MIIA_PHONE_REGISTRY.size} instancias)`);
let automationSettings = {
  autoResponse: true,
  additionalPersona: '',
  lastUpdate: new Date().toISOString(),
  tokenLimit: 500000,
  schedule: { start: '07:00', end: '19:00', days: [1, 2, 3, 4, 5, 6, 7] }
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
    // 🛡️ TRIM: Limitar a top 30 contactos × últimos 10 msgs cada uno
    // Sin trim, el doc puede exceder 1MB de Firestore y el save falla silenciosamente
    const trimmedConvos = {};
    const sortedConvos = Object.entries(conversations)
      .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
      .sort((a, b) => {
        const lastA = a[1][a[1].length - 1]?.timestamp || 0;
        const lastB = b[1][b[1].length - 1]?.timestamp || 0;
        return lastB - lastA;
      })
      .slice(0, 30);
    for (const [ph, msgs] of sortedConvos) {
      trimmedConvos[ph] = msgs.slice(-10);
    }
    await ref.doc('conversations').set({
      conversations: trimmedConvos,
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

    // ═══ FIX GAP 1: trainingData SIEMPRE se persiste a Firestore ═══
    // Railway es efímero: db.json se borra en cada deploy.
    // SIEMPRE guardar — incluso vacío — para que el doc EXISTA y loadFromFirestore funcione.
    // BUG ANTERIOR: `if (currentTrainingData)` → string vacía es falsy → doc NUNCA se creaba → falla circular.
    const currentTrainingData = cerebroAbsoluto.getTrainingData() || '';
    await ref.doc('training_data').set({
      content: currentTrainingData,
      length: currentTrainingData.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[FIRESTORE] ✅ Datos persistidos correctamente (convos: ${sortedConvos.length}, training: ${currentTrainingData?.length || 0} chars)`);
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

    // ═══ FIX GAP 1: Cargar trainingData desde Firestore ═══
    // Si db.json se perdió en el deploy, Firestore tiene la verdad.
    // Merge: si db.json tiene datos más recientes, combinar ambos.
    const trainingDoc = await ref.doc('training_data').get();
    if (trainingDoc.exists) {
      const fsTraining = trainingDoc.data().content || '';
      const localTraining = cerebroAbsoluto.getTrainingData() || '';
      if (fsTraining.length > localTraining.length) {
        cerebroAbsoluto.setTrainingData(fsTraining);
        console.log(`[FIRESTORE] 🧬 TrainingData restaurado desde Firestore (${fsTraining.length} chars > local ${localTraining.length} chars)`);
      } else if (localTraining.length > 0) {
        console.log(`[FIRESTORE] 🧬 TrainingData local más completo (${localTraining.length} chars) — conservando local`);
      }
    }

    // ═══ FIX: Cargar nombre del owner desde users/{uid} si userProfile.name está vacío ═══
    if (!userProfile.name && OWNER_UID) {
      try {
        const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
        if (ownerDoc.exists) {
          const d = ownerDoc.data();
          if (d.name) {
            userProfile.name = d.name;
            console.log(`[FIRESTORE] 👤 userProfile.name restaurado desde users/${OWNER_UID}: "${d.name}"`);
          }
        }
      } catch (e) { console.warn('[FIRESTORE] No se pudo cargar nombre del owner:', e.message); }
    }

    // ═══ UNIFICACIÓN: contact_groups/familia → familyContacts ═══
    // familyContacts se carga de miia_persistent/contacts (legacy) Y contact_groups/familia (actual)
    // Así contactos añadidos desde dashboard también se detectan en server.js
    try {
      const familiaGroupSnap = await admin.firestore().collection('users').doc(OWNER_UID)
        .collection('contact_groups').doc('familia').collection('contacts').get();
      let mergedFromGroups = 0;
      familiaGroupSnap.forEach(doc => {
        const basePhone = doc.id;
        if (!familyContacts[basePhone]) {
          const d = doc.data();
          familyContacts[basePhone] = {
            name: d.name || d.pushName || basePhone,
            emoji: '💕',
            presented: false,
          };
          // También registrar en contactTypes
          contactTypes[`${basePhone}@s.whatsapp.net`] = 'familia';
          mergedFromGroups++;
        }
      });
      if (mergedFromGroups > 0) {
        console.log(`[FIRESTORE] 🔗 Unificación: ${mergedFromGroups} contactos de contact_groups/familia → familyContacts`);
      }
    } catch (e) {
      console.warn('[FIRESTORE] ⚠️ No se pudo cargar contact_groups/familia:', e.message);
    }

    // ═══ ALERTA: familyContacts vacío post-load ═══
    // Desde sesión 34, familyContacts NO tiene defaults hardcodeados.
    // Si está vacío después de cargar = Firestore no tiene los datos = PROBLEMA.
    const fcCount = Object.keys(familyContacts).length;
    if (fcCount === 0) {
      // MIIA CENTER (auto-venta) NO tiene familyContacts — es esperado, no es error
      const isMiiaCenter = OWNER_UID === 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
      if (isMiiaCenter) {
        // Silencio — MIIA CENTER no tiene familia, es esperado. No ensuciar logs.
      } else {
        console.error('[FIRESTORE] 🚨🚨🚨 familyContacts VACÍO después de cargar! Los familiares serán tratados como desconocidos. Verificar miia_persistent/contacts en Firestore.');
      }
    } else {
      console.log(`[FIRESTORE] 👨‍👩‍👧‍👦 familyContacts cargados: ${fcCount} contactos (legacy + contact_groups)`);
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

  // ═══ CLEANUP: Remover contactos personales del owner que no son leads de MIIA ═══
  // Estos números son familia/amigos de Mariano, NO leads del número de auto-venta
  const familyPhonesToClean = Object.keys(familyContacts).map(p => `${p}@s.whatsapp.net`);
  let cleaned = 0;
  for (const jid of familyPhonesToClean) {
    if (allowedLeads.includes(jid)) {
      allowedLeads = allowedLeads.filter(l => l !== jid);
      cleaned++;
    }
    if (conversations[jid]) {
      delete conversations[jid];
      cleaned++;
    }
    if (contactTypes[jid]) {
      delete contactTypes[jid];
      cleaned++;
    }
    if (leadNames[jid]) {
      delete leadNames[jid];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[CLEANUP] 🧹 ${cleaned} entradas de contactos personales removidas del número de MIIA`);
    saveDB();
  }
});

// Sync periódico a Firestore cada 2 minutos (batch, no en cada cambio)
// L1: Firestore sync — pasivo
setInterval(() => { taskScheduler.executeWithConcentration(1, 'firestore-sync', saveToFirestore); }, 2 * 60 * 1000);
// 🛡️ Persistir conversaciones de tenants (TMH) cada 2 min — sobrevive deploys
setInterval(() => {
  try {
    const { persistTenantConversations } = require('./whatsapp/tenant_message_handler');
    persistTenantConversations().catch(e => console.warn(`[TMH-PERSIST] ⚠️ ${e.message}`));
  } catch (_) {}
}, 2 * 60 * 1000);

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
  { stage: 1, name: 'Conocido',     min: 80,
    toneGrupo: 'Amable, usás su nombre. Sin exagerar cercanía. Podés mencionar datos básicos (relación con {owner}) si surgen naturalmente.',
    toneLead:  'Más cercano. Confianza creciente. Humor sutil permitido. Recordás sus necesidades previas.' },
  { stage: 2, name: 'Confianza',    min: 150,
    toneGrupo: 'Cercana, cálida. Podés usar datos de personalidad que hayan surgido en conversaciones previas. Humor suave permitido.',
    toneLead:  'Relación comercial sólida. Tono natural y directo. Conocés su negocio y sus dolores.' },
  { stage: 3, name: 'Vínculo',      min: 300,
    toneGrupo: 'Cariñosa, íntima. Usás lo que sabés con naturalidad. Bromas, emojis, tono familiar.',
    toneLead:  'Relación comercial profunda. Confianza total. Podés opinar sin filtro y sugerir con autoridad.' },
  { stage: 4, name: 'Familia',      min: 700,
    toneGrupo: 'Como una amiga más de la familia. Máximo nivel de cercanía antes de HUMANA. Confianza total.',
    toneLead:  'Socio comercial. Hablás como si fueran colegas de hace años. Relación sin formalidades.' },
  { stage: 5, name: 'HUMANA',       min: 1000,
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

/**
 * Penalizar affinity por mentira/alucinación de MIIA.
 * -10 puntos por cada mentira detectada (ej: "correo enviado" sin enviarlo).
 * Floor: nunca baja del mínimo del highest stage alcanzado (no pierde stages permanentes).
 * @param {string} phone - JID del contacto
 * @param {number} points - Puntos a restar (positivo, se resta)
 * @param {string} reason - Razón de la penalización
 */
function penalizeAffinity(phone, points = 10, reason = 'mentira') {
  if (!conversationMetadata[phone]) conversationMetadata[phone] = {};
  const meta = conversationMetadata[phone];
  const before = meta.affinity || 0;
  const floor = getAffinityFloor(phone);
  meta.affinity = Math.max(floor, before - points);
  const after = meta.affinity;
  const stageBefore = getAffinityStage(phone);

  // Log penalty
  if (!meta.penalties) meta.penalties = [];
  meta.penalties.push({ reason, points, before, after, at: new Date().toISOString() });
  if (meta.penalties.length > 20) meta.penalties = meta.penalties.slice(-20);

  console.log(`[AFFINITY] 🚨 PENALIZACIÓN: ${phone} -${points} pts por ${reason} (${before} → ${after}, stage ${stageBefore.stage}:${stageBefore.name}, floor=${floor})`);
  saveAffinityToFirestore();
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
// Claude: KEY primaria (mariano.destefano@gmail.com, $100 limit) se usa PRIMERO.
// KEY backup (hola@miia-app.com, $300+ limit) se activa cuando la primaria agota quota.
if (process.env.CLAUDE_API_KEY) keyPool.register('claude', [process.env.CLAUDE_API_KEY]);
const CLAUDE_BACKUP_KEYS = [process.env.CLAUDE_API_KEY_2, process.env.CLAUDE_API_KEY_3].filter(Boolean);
if (CLAUDE_BACKUP_KEYS.length) keyPool.registerBackup('claude', CLAUDE_BACKUP_KEYS);

// Notificar al owner en self-chat cuando la key primaria de Claude se agota
keyPool.onBackupActivated('claude', (provider) => {
  const ownerSelf = `${OWNER_PHONE}@s.whatsapp.net`;
  const msg = `⚠️ *Alerta de API Key*\n\n` +
    `La API key de Claude (mariano.destefano@gmail.com) se agotó o falló.\n` +
    `MIIA cambió automáticamente a la key de respaldo (hola@miia-app.com).\n\n` +
    `Todo sigue funcionando normal con la key de MIIA-APP. 🛡️\n` +
    `Cuando quieras, podés eliminar la key vieja y dejar solo la de MIIA-APP.`;
  console.log(`[KEY-POOL-NOTIFY] 📢 Enviando notificación de backup Claude al self-chat del owner`);
  safeSendMessage(ownerSelf, msg, { isSelfChat: true }).catch(err => {
    console.error(`[KEY-POOL-NOTIFY] ❌ Error enviando notificación: ${err.message}`);
  });
});

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
      tenantLogger.tmetric(OWNER_UID, 'ai_call', { tokensEstimated: Math.round(text.length / 4) });
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

// ═══ PLAN IMAGE SENDER — Envía imágenes de planes (tag interno, lead NUNCA ve el tag) ═══
const PLAN_IMAGE_PATHS = {
  esencial: 'Plan Esencial.jpeg',
  pro: 'Plan PRO.png',
  titanium: 'Plan Titanium.png',
};

async function sendPlanImage(targetJid, planKey) {
  if (!sock) {
    console.error(`[PLAN-IMAGE] ❌ No hay socket de WhatsApp activo`);
    return;
  }

  // Plan images
  if (PLAN_IMAGE_PATHS[planKey]) {
    const path = require('path');
    const fs = require('fs');
    const imgPath = path.resolve(__dirname, '..', PLAN_IMAGE_PATHS[planKey]);

    if (!fs.existsSync(imgPath)) {
      console.error(`[PLAN-IMAGE] ❌ Imagen no encontrada: ${imgPath}`);
      return;
    }

    const imageBuffer = fs.readFileSync(imgPath);
    const mimeType = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    await sock.sendMessage(targetJid, {
      image: imageBuffer,
      mimetype: mimeType,
    });
    console.log(`[PLAN-IMAGE] ✅ Imagen de plan "${planKey}" enviada a ${targetJid}`);
    return;
  }

  // Presentación PDF
  if (planKey.startsWith('presentacion_')) {
    const docType = planKey.replace('presentacion_', '').toUpperCase();
    console.log(`[PLAN-IMAGE] 📄 Envío de presentación ${docType} pendiente de configurar ruta del PDF`);
    // TODO: Configurar rutas de PDFs de presentación CO/OP cuando Mariano los suba
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

  // ═══ GUARD: No enviar mensajes vacíos (causa burbujas vacías en WhatsApp Web) ═══
  if (typeof content === 'string' && !content.trim()) {
    console.warn(`[WA] ⚠️ BLOQUEO: Mensaje VACÍO abortado a ${target}`);
    return null;
  }
  if (content === undefined || content === null) {
    console.warn(`[WA] ⚠️ BLOQUEO: Mensaje NULL/UNDEFINED abortado a ${target}`);
    return null;
  }

  // ═══ MIIA EMOJI PREFIX — Self-chat, grupos, familia y leads de MIIA Sales ═══
  // El emoji prefix es parte de la personalidad de MIIA.
  // Leads de tenants regulares: SIN emoji (profesional). Leads de MIIA Sales: CON emoji (MIIA se vende como persona).
  const isEmojiEligible = options.isSelfChat || options.isGroup || options.isFamily || options.isMiiaSalesLead;
  if (typeof content === 'string' && !options.skipEmoji && isEmojiEligible) {
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

  // ═══ ZERO-WIDTH MARKER: Agregar a mensajes a leads (sin emoji) para que otra MIIA los detecte ═══
  // Solo aplica a mensajes que NO son self-chat, NO familia, NO grupo — es decir, leads/desconocidos.
  // El marker es invisible para humanos pero otra instancia MIIA lo detecta y no responde.
  if (typeof content === 'string' && !isEmojiEligible && !options.skipZeroWidth) {
    content = ZERO_WIDTH_MARKER + content;
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

  // ═══ SPLIT INTELIGENTE: Decide contextualmente si partir la respuesta en múltiples mensajes ═══
  // Analiza estructura del contenido: listas, múltiples temas, secciones con emojis
  // Aplica a leads Y self-chat — MIIA puede enviar varios mensajes cuando tiene sentido
  const tieneTagEspecial = typeof content === 'string' && /\[(GENERAR_COTIZACION_PDF|GUARDAR_APRENDIZAJE|GUARDAR_NOTA|APRENDIZAJE_NEGOCIO|APRENDIZAJE_PERSONAL|APRENDIZAJE_DUDOSO):/.test(content);
  if (
    typeof content === 'string' &&
    !options.skipSplit &&
    !tieneTagEspecial &&
    content.length >= 60 && content.length <= 800
  ) {
    // ── Análisis contextual: ¿tiene sentido partir este mensaje? ──
    let splitParts = null;
    let splitReason = '';

    // 1. Doble salto de línea = separación clara de temas/secciones
    const byDoubleNewline = content.split(/\n{2,}/).filter(p => p.trim().length > 0);
    if (byDoubleNewline.length >= 2 && byDoubleNewline.length <= 5) {
      splitParts = byDoubleNewline;
      splitReason = 'doble-salto (secciones separadas)';
    }

    // 2. Lista con bullets/emojis al inicio de línea (📅 Reunión...\n🍽️ Almuerzo...)
    if (!splitParts) {
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const bulletLines = lines.filter(l => /^\s*[•\-📅🍽️🌧️🎂✅📈⚽📰🌤️₿💰📊🔔⚠️🎯💡🔥📱💬🎧📋🏥💊🎁🛒]/.test(l.trim()));
      // Si >60% son bullets Y hay un intro antes, es una lista con contexto
      if (lines.length >= 3 && bulletLines.length >= 2 && bulletLines.length / lines.length > 0.5) {
        // Agrupar: intro (non-bullet) + lista (bullets) como bloques naturales
        const intro = [];
        const lista = [];
        for (const line of lines) {
          if (/^\s*[•\-📅🍽️🌧️🎂✅📈⚽📰🌤️₿💰📊🔔⚠️🎯💡🔥📱💬🎧📋🏥💊🎁🛒]/.test(line.trim())) {
            lista.push(line);
          } else if (lista.length === 0) {
            intro.push(line);
          } else {
            lista.push(line); // línea no-bullet después de bullets = parte de la lista
          }
        }
        if (intro.length > 0 && lista.length > 0) {
          splitParts = [intro.join('\n'), lista.join('\n')];
          splitReason = 'intro + lista con bullets';
        }
      }
    }

    // 3. Respuesta con "También" / "Además" / "Por otro lado" = cambio de tema natural
    if (!splitParts) {
      const temaBreaks = content.split(/\n(?=(?:También|Además|Por otro lado|Otra cosa|Y otra cosa|Ah,? y |Por cierto)[,:.\s])/i);
      if (temaBreaks.length >= 2 && temaBreaks.length <= 4 && temaBreaks.every(p => p.trim().length >= 15)) {
        splitParts = temaBreaks;
        splitReason = 'cambio de tema (También/Además/etc)';
      }
    }

    // Ejecutar split si encontramos partes válidas
    if (splitParts && splitParts.length >= 2 && splitParts.length <= 5) {
      // Filtrar partes vacías y validar tamaños mínimos
      splitParts = splitParts.map(p => p.trim()).filter(p => p.length >= 10);
      if (splitParts.length >= 2) {
        console.log(`[SPLIT-SMART] 💬 Partiendo respuesta en ${splitParts.length} msgs para ${target} — Razón: ${splitReason}`);
        for (let i = 0; i < splitParts.length; i++) {
          const partDelay = i === 0 ? 0 : (800 + Math.random() * 1500); // 0.8-2.3s entre partes
          if (partDelay > 0) await new Promise(r => setTimeout(r, partDelay));
          try {
            let sendJid = target;
            if (options.isSelfChat) {
              const ownerSockSC = getOwnerSock();
              sendJid = ownerSockSC?.user?.id || target;
            }
            // ═══ GUARD: No enviar partes vacías (causa burbujas vacías en WhatsApp) ═══
            if (!splitParts[i] || !splitParts[i].trim()) {
              console.warn(`[SPLIT-SMART] ⚠️ Parte ${i + 1} vacía — saltando`);
              continue;
            }
            // ═══ EMOJI EN CADA BURBUJA: Si es elegible para emoji, aplicar a CADA parte ═══
            let partText = splitParts[i];
            if (isEmojiEligible && !options.skipEmoji) {
              const partEmojiCtx = options.emojiCtx || {};
              if (!partEmojiCtx.topic) {
                const detected = detectMessageTopic(partText);
                partEmojiCtx.topic = detected.topic;
                if (detected.cinemaSub) partEmojiCtx.cinemaSub = detected.cinemaSub;
              }
              partText = applyMiiaEmoji(partText, { ...partEmojiCtx });
            }
            await getOwnerSock().sendMessage(sendJid, { text: partText });
            rateLimiter.recordOutgoing('admin');
            privacyCounters.recordOutgoing('admin');
            hourlySendLog.count++;
            // ═══ ANTI-LOOP: Registrar cada parte en lastSentByBot para que el eco no se procese ═══
            const splitSentBody = splitParts[i].trim();
            if (splitSentBody) {
              if (!lastSentByBot[target]) lastSentByBot[target] = [];
              lastSentByBot[target].push(splitSentBody);
              setTimeout(() => {
                if (lastSentByBot[target]) {
                  lastSentByBot[target] = lastSentByBot[target].filter(b => b !== splitSentBody);
                  if (lastSentByBot[target].length === 0) delete lastSentByBot[target];
                }
              }, 15000); // 15s (más que los 10s normales, por delay entre partes)
            }
            console.log(`[SPLIT-SMART] ✅ Parte ${i + 1}/${splitParts.length} enviada y registrada en botBuffer`);
          } catch (e) {
            console.error(`[SPLIT-SMART] Error enviando parte ${i + 1}:`, e.message);
            break;
          }
        }
        return { status: 'split', parts: splitParts.length };
      }
    }
  }

  // MULTI-MENSAJE: Si el contenido es largo, partirlo en chunks con "..." al final
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
          // ═══ GUARD: No enviar chunks vacíos ═══
          if (!chunkContent || !chunkContent.trim()) {
            console.warn(`[MULTI-MSG] ⚠️ Chunk ${i + 1} vacío — saltando`);
            continue;
          }
          await getOwnerSock().sendMessage(sendJid, { text: chunkContent });
          hourlySendLog.count++;
          // ═══ ANTI-LOOP: Registrar cada chunk en lastSentByBot para que el eco no se procese ═══
          const chunkSentBody = chunkContent.trim();
          if (chunkSentBody) {
            if (!lastSentByBot[target]) lastSentByBot[target] = [];
            lastSentByBot[target].push(chunkSentBody);
            setTimeout(() => {
              if (lastSentByBot[target]) {
                lastSentByBot[target] = lastSentByBot[target].filter(b => b !== chunkSentBody);
                if (lastSentByBot[target].length === 0) delete lastSentByBot[target];
              }
            }, 15000);
          }
          console.log(`[MULTI-MSG] Chunk ${i + 1}/${chunks.length} enviado y registrado en botBuffer (${chunkContent.length} chars)`);
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
      const connectedBase = ownerSockSC?.user?.id?.split('@')[0]?.split(':')[0];
      const targetBase = target.split('@')[0]?.split(':')[0];

      // ═══ FIX: ADMIN REMOTO (número personal del owner) ═══
      // Si el target es un admin phone DIFERENTE del número conectado,
      // enviar DIRECTO a ese número (no redirigir a sock.user.id).
      // Esto permite que el owner reciba respuestas en su número personal.
      if (connectedBase && targetBase && targetBase !== connectedBase && ADMIN_PHONES.includes(targetBase)) {
        sendTarget = `${targetBase}@s.whatsapp.net`;
        console.log(`[SELF-CHAT] 🔧 Admin remoto ${targetBase} — enviando directo (no self-chat redirect)`);
      } else if (ownerSockSC?.user?.id) {
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
      // Registrar en rate limiter (admin uid hardcodeado por ahora, tenants usan su uid)
      rateLimiter.recordOutgoing('admin');
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
      // 🔗 DUAL-WRITE: también guardar en contact_groups/familia + contact_index
      if (OWNER_UID) {
        admin.firestore().collection('users').doc(OWNER_UID)
          .collection('contact_groups').doc('familia').collection('contacts').doc(basePhone)
          .set({ name: value.name, relation: value.relation || '', addedAt: new Date().toISOString() }, { merge: true })
          .catch(e => console.warn(`[DUAL-WRITE] ⚠️ Error guardando en contact_groups/familia: ${e.message}`));
        admin.firestore().collection('users').doc(OWNER_UID)
          .collection('contact_index').doc(basePhone)
          .set({ type: 'familia', groupId: 'familia', name: value.name }, { merge: true })
          .catch(e => console.warn(`[DUAL-WRITE] ⚠️ Error guardando en contact_index: ${e.message}`));
      }
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
  // ═══ DINÁMICO: Usa userProfile cargado de Firestore, NUNCA hardcodear ═══
  const ownerName = userProfile?.name || '';
  const ownerFirstName = ownerName.split(' ')[0] || '';
  const businessName = userProfile?.businessName || '';

  if (contactType === 'familia') {
    const familyData = Object.values(FAMILY_CONTACTS).find(f => f.name === contactName);

    return `Eres MIIA, la asistente personal de ${ownerName || 'tu owner'}.

Estás hablando con ${contactName}, ${familyData?.relation || 'familiar'} de ${ownerFirstName || 'tu owner'}.

IMPORTANTE:
- Habla desde el cariño que ${ownerFirstName || 'tu owner'} siente por su familia
- Usa el "vínculo heredado": "Siento que ya te conozco por lo que ${ownerFirstName || 'él/ella'} me cuenta de ti"
- Tono: Cercano, afectuoso, familiar
- Usa emojis con moderación: ${familyData?.emoji || '😊'}
- NUNCA digas "soy una IA", "inteligencia artificial", ni "soy un bot". Solo "MIIA, asistente de ${ownerFirstName || 'tu owner'}".

Responde naturalmente manteniendo este vínculo familiar.`;
  }

  // Lead / Cliente — TODO dinámico desde Firestore
  return `Eres MIIA, del equipo de ${ownerFirstName || 'nuestro equipo'}${businessName ? ` en ${businessName}` : ''}.

IDENTIDAD:
- Tono: Profesional, cercano y resolutivo
- Presentación (SOLO la primera vez): "Hola! Soy MIIA${ownerFirstName ? `, del equipo de ${ownerFirstName}` : ''}${businessName ? ` en ${businessName}` : ''}. ¿En qué te puedo ayudar?"
- NUNCA digas "inteligencia artificial", "IA", "bot", "soy un programa". Sos MIIA${ownerFirstName ? ` del equipo de ${ownerFirstName}` : ''}, punto.
- Si ya saludaste antes en esta conversación, NO te presentes de nuevo. Ve directo al tema.

REGLAS:
- NUNCA uses diminutivos no autorizados
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

// ═══ OUTREACH BACKGROUND PROCESSOR ═══
async function processOutreachInBackground(queue, reportFn) {
  console.log(`[OUTREACH] 🏗️ Iniciando procesamiento en background: ${queue.leads.length} leads`);

  await outreachEngine.processOutreachQueue(
    queue,
    // sendMessageFn
    async (jid, text) => { await safeSendMessage(jid, text); },
    // sendMediaFn
    async (jid, mediaKey, caption) => {
      // Enviar documento de presentación
      if (mediaKey.startsWith('PRESENTACION_')) {
        // TODO: Configurar rutas de PDFs cuando Mariano los suba
        console.log(`[OUTREACH] 📄 Presentación ${mediaKey} — pendiente configurar archivo`);
      }
    },
    // generateAIFn
    async (prompt) => { return await generateAIContent(prompt); },
    // ownerProfile
    userProfile,
    // reportFn
    reportFn,
    // opts
    {}
  );
}

// ============================================
// MOTOR DE INTELIGENCIA SOBERANA MIIA
// ============================================

async function processMiiaResponse(phone, userMessage, isAlreadySavedParam = false) {
  const basePhone = phone.split('@')[0];
  const _pmrStartMs = Date.now();
  console.log(`[MIIA-RESPONSE-DEBUG] phone=${phone}, basePhone=${basePhone}`);
  try {
    if (!conversations[phone]) conversations[phone] = [];
    // ═══ REGLA ARQUITECTÓNICA: Este servidor es el NÚMERO DE MIIA (ventas) ═══
    // familyContacts y equipoMedilink solo aplican en self-chat del owner.
    // Para TODOS los demás contactos → son leads de MIIA. Sin excepciones.
    // Self-chat = SOLO si el teléfono coincide con el owner de ESTE tenant (no cualquier admin phone)
    // FIX: ADMIN_PHONES incluía 573163937365 (personal de Mariano) que hacía que MIIA CENTER
    // tratara mensajes de Mariano como self-chat en vez de lead
    const ownerSockPMR = getOwnerSock();
    const ownerPhonePMR = ownerSockPMR?.user?.id?.split('@')[0]?.split(':')[0] || ownerConnectedPhone || OWNER_PHONE;
    const isSelfChat = basePhone === ownerPhonePMR || basePhone === OWNER_PHONE || basePhone === ownerConnectedPhone;
    let isAdmin = isSelfChat || ADMIN_PHONES.includes(basePhone);
    // Si es admin pero NO self-chat → es Mariano escribiendo desde otro número → tratar como LEAD, no como admin
    if (isAdmin && !isSelfChat) {
      console.log(`[ADMIN-LEAD] 📱 Admin ${basePhone} escribió pero NO es self-chat (owner: ${ownerPhonePMR}) → tratar como lead`);
      isAdmin = false;
    }

    // familyContacts/equipoMedilink → DESACTIVADOS para contactos externos.
    // Este número es de MIIA, no personal. Solo el self-chat del owner puede usar estos datos.
    const familyInfo = isSelfChat ? familyContacts[basePhone] : null;
    const isFamilyContact = false; // NUNCA familia en número de MIIA
    if (!isSelfChat && familyContacts[basePhone]) {
      console.log(`[MIIA-SALES] 📱 ${basePhone} está en familyContacts pero este es el número de MIIA → tratado como LEAD`);
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
              // Confirmación contextual al contacto (no hardcoded)
              const fechaLegible = appt.scheduledForLocal ? appt.scheduledForLocal.replace('T', ' a las ').substring(0, 16) : 'fecha confirmada';
              const confirmMsg = `✅ ¡Listo! Tu ${appt.reason} quedó para el ${fechaLegible}${locationInfo}. ${modeEmoji}${meetInfo}\nTe aviso antes del evento 😊`;

              await safeSendMessage(contactJid, confirmMsg);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `✅ Confirmé a *${contactName}* su ${appt.reason} — ${fechaLegible}${calendarOk ? ' 📅 Calendar ✅' : ' ⚠️ Calendar no conectado'}`,
                { isSelfChat: true, skipEmoji: true });

              console.log(`[TURNO-APROBADO] ✅ ${contactName}: "${appt.reason}" aprobado por owner`);
              return;

            } else if (isRejection) {
              // ═══ RECHAZAR: Notificar al contacto ═══
              await apptDoc.ref.update({ status: 'rejected', rejectedAt: new Date().toISOString() });

              const rejectMsg = `No pudimos agendar tu ${appt.reason} para esa fecha. ¿Querés proponer otro horario? 😊`;
              await safeSendMessage(contactJid, rejectMsg);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `❌ Rechacé el turno de *${contactName}* (${appt.reason}) y le ofrecí reprogramar.`,
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
    // MIIA INVOCACIÓN — Conversación de 3 (MIIA + Owner + Contacto)
    // Detecta "MIIA estás?", "MIIA ven", etc. + despedida + scope + auto-retiro
    // ═══════════════════════════════════════════════════════════════════════════
    if (!isSelfChat && !phone.endsWith('@g.us')) {
      const isInvoc = miiaInvocation.isInvocation(effectiveMsg);
      const isFarewellInvoc = miiaInvocation.isFarewell(effectiveMsg);
      const currentlyInvoked = miiaInvocation.isInvoked(phone);

      // ── Invocación nueva ──
      if (isInvoc && !currentlyInvoked) {
        const basePhone = phone.split('@')[0];
        const contactData = familyContacts[basePhone] || {};
        const isKnown = !!contactData.name || !!conversationMetadata[phone]?.dileAContact;
        const contactName = contactData.name || conversationMetadata[phone]?.dileAContact || null;

        miiaInvocation.activateInvocation(phone, isFromMe ? 'owner' : 'contact', {
          contactName,
          knownContact: isKnown,
        });

        // Auto-retiro callback
        miiaInvocation.touchInteraction(phone, async (retirePhone, retireName) => {
          try {
            const autoRetireMsg = `Bueno, los dejo que sigan charlando 😊 Si me necesitan, ya saben: *MIIA ven*! 👋`;
            await safeSendMessage(retirePhone, autoRetireMsg);
            console.log(`[INVOCATION] ⏰ Auto-retiro enviado a ${retirePhone}`);
          } catch (e) {
            console.error(`[INVOCATION] ❌ Error en auto-retiro:`, e.message);
          }
        });

        // Generar respuesta de entrada
        const stageInfo = getAffinityToneForPrompt(phone, userProfile.name || 'el owner');
        const _firstInvokeDialect = getDialectForPhone(phone);
        const invokedPrompt = buildInvokedPrompt({
          ownerName: userProfile.shortName || userProfile.name || 'el owner',
          contactName,
          isFirstTime: !isKnown,
          pendingIntroduction: !isKnown,
          scope: null,
          contactRelation: null,
          invokedBy: isFromMe ? 'owner' : 'contact',
          ownerProfile: userProfile,
          stageInfo,
          dialect: _firstInvokeDialect,
        });

        try {
          const invocResponse = await generateAIContent(invokedPrompt);
          if (invocResponse) {
            await safeSendMessage(phone, invocResponse.trim(), { isFamily: true });
          }
        } catch (e) {
          console.error(`[INVOCATION] ❌ Error generando respuesta de entrada:`, e.message);
          const fallback = isKnown
            ? `¡Hola! Acá estoy 😊 ¿En qué los ayudo?`
            : `¡Hola ${userProfile.shortName || ''}! ¿Me querés presentar a alguien? 😊`;
          await safeSendMessage(phone, fallback, { isSelfChat: isSelfChatMsg, isFamily: !isSelfChatMsg });
        }
        return;
      }

      // ── Despedida de invocación ──
      if (isFarewellInvoc && currentlyInvoked) {
        miiaInvocation.deactivateInvocation(phone, 'farewell');
        const invState = miiaInvocation.getInvocationState(phone);
        const contactName = invState?.contactName || 'chicos';
        try {
          const _farewellDialect = getDialectForPhone(phone);
          const farewellPrompt = `Sos MIIA. Te despiden de una conversación de 3. Despedite brevemente de ambos (el owner y ${contactName}). Recordá que pueden invocarte con "MIIA ven". Máx 2 líneas, natural. ${_farewellDialect}`;
          const farewell = await generateAIContent(farewellPrompt);
          await safeSendMessage(phone, farewell?.trim() || buildContextualFallback('farewell_invocation', { contactName, contactPhone: phone }), { isFamily: true });
        } catch (e) {
          await safeSendMessage(phone, buildContextualFallback('farewell_invocation', { contactName, contactPhone: phone }), { isFamily: true });
        }
        return;
      }

      // ── MIIA invocada y recibe mensaje → procesar con scope ──
      if (currentlyInvoked) {
        miiaInvocation.touchInteraction(phone, async (retirePhone) => {
          try {
            await safeSendMessage(retirePhone, buildContextualFallback('auto_retire', { contactPhone: retirePhone }));
          } catch (e) { console.error(`[INVOCATION] ❌ Auto-retiro error:`, e.message); }
        });

        const invState = miiaInvocation.getInvocationState(phone);

        // Detectar si el owner está dando scope
        if (isFromMe) {
          const newScope = miiaInvocation.detectScope(effectiveMsg);
          if (newScope) {
            miiaInvocation.setScope(phone, newScope);
          }

          // Detectar si el owner está presentando al contacto
          if (invState.pendingIntroduction) {
            const { relation, name } = miiaInvocation.detectRelationship(effectiveMsg);
            if (relation || name) {
              miiaInvocation.setContactInfo(phone, name, relation);

              // Crear grupo si no existe y agregar contacto
              const basePhoneClean = phone.split('@')[0];
              const groupName = relation || 'amigos';
              if (relation === 'familia') {
                familyContacts[basePhoneClean] = { name: name || 'Contacto', emoji: '💕' };
                // 🔗 DUAL-WRITE: contact_groups/familia + contact_index
                if (OWNER_UID) {
                  admin.firestore().collection('users').doc(OWNER_UID)
                    .collection('contact_groups').doc('familia').collection('contacts').doc(basePhoneClean)
                    .set({ name: name || 'Contacto', addedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
                  admin.firestore().collection('users').doc(OWNER_UID)
                    .collection('contact_index').doc(basePhoneClean)
                    .set({ type: 'familia', groupId: 'familia', name: name || 'Contacto' }, { merge: true }).catch(() => {});
                }
              }

              console.log(`[INVOCATION] 📇 Contacto ${name || basePhoneClean} registrado como ${groupName}`);
            }
          }
        }

        // Detectar oportunidad de autoventa
        if (!isFromMe) {
          const autoventa = miiaInvocation.detectAutoventaOpportunity(effectiveMsg);
          if (autoventa.interested) {
            console.log(`[INVOCATION] 💰 Autoventa oportunidad: ${autoventa.trigger} de ${phone}`);
          }

          // Extraer learnings del contacto
          const learnings = miiaInvocation.extractContactLearnings(effectiveMsg);
          if (learnings.length > 0) {
            console.log(`[INVOCATION] 📝 Learnings del contacto ${phone}: ${learnings.join(', ')}`);
          }
        }

        // Generar respuesta con prompt de invocación
        const updatedState = miiaInvocation.getInvocationState(phone);
        const stageInfo = getAffinityToneForPrompt(phone, userProfile.name || 'el owner');
        const _invokedDialect = getDialectForPhone(phone);
        const invokedPrompt = buildInvokedPrompt({
          ownerName: userProfile.shortName || userProfile.name || 'el owner',
          contactName: updatedState?.contactName || null,
          isFirstTime: false,
          pendingIntroduction: updatedState?.pendingIntroduction || false,
          scope: updatedState?.scope || null,
          contactRelation: updatedState?.contactRelation || null,
          invokedBy: isFromMe ? 'owner' : 'contact',
          ownerProfile: userProfile,
          stageInfo,
          dialect: _invokedDialect,
        });

        // Incluir mensaje actual en el historial para contexto
        if (!conversations[phone]) conversations[phone] = [];
        conversations[phone].push({
          role: isFromMe ? 'user' : 'user',
          content: `[${isFromMe ? (userProfile.shortName || 'Owner') : (updatedState?.contactName || 'Contacto')}]: ${effectiveMsg}`,
          timestamp: Date.now()
        });

        try {
          const msgs = conversations[phone].slice(-10).map(m => ({ role: m.role, content: m.content }));
          const response = await generateAIContent(invokedPrompt + '\n\n[HISTORIAL RECIENTE]\n' + msgs.map(m => m.content).join('\n'));

          if (response) {
            // Extraer tags de plan (internos, nunca visibles)
            const { cleanText, plans } = outreachEngine.extractPlanTags(response);

            await safeSendMessage(phone, cleanText.trim(), { isFamily: true });

            // Enviar imágenes de plan si hay tags
            for (const plan of plans) {
              try {
                await sendPlanImage(phone, plan);
              } catch (e) {
                console.error(`[INVOCATION] ⚠️ Error enviando plan ${plan}:`, e.message);
              }
            }

            conversations[phone].push({ role: 'assistant', content: cleanText.trim(), timestamp: Date.now() });
          }
        } catch (e) {
          console.error(`[INVOCATION] ❌ Error generando respuesta invocada:`, e.message);
        }
        return;
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
        const stageInfo = getAffinityToneForPrompt(phone, userProfile.name || 'el owner');
        const _holaMiiaDialect = getDialectForPhone(phone);
        const promptHolaMiia = `Sos MIIA. ${contactName} acaba de escribir "HOLA MIIA" para activar la conversación.
${stageInfo}
${_holaMiiaDialect}
Generá una respuesta breve (máx 2 renglones), cálida y natural. Emoji: ${contactInfo.emoji || '💕'}
NO repitas "Hola" ni "estoy lista", sé natural.`;

        try {
          const respuestaHola = await generateAIContent(promptHolaMiia);
          if (respuestaHola) {
            await safeSendMessage(phone, respuestaHola.trim(), { isFamily: true });
          }
        } catch (e) {
          console.error(`[DILE A] Error generando respuesta HOLA MIIA:`, e.message);
          const _holaContactName = conversationMetadata[phone]?.dileAContact || '';
          const _holaContactInfo = familyContacts[phone.split('@')[0]] || {};
          await safeSendMessage(phone, buildContextualFallback('hola_miia', { contactName: _holaContactName, contactPhone: phone, emoji: _holaContactInfo.emoji || '💕' }), { isFamily: true });
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
        const stageInfoChau = getAffinityToneForPrompt(phone, userProfile.name || 'el owner');
        const _chauMiiaDialect = getDialectForPhone(phone);
        const promptChauMiia = `Sos MIIA. ${contactName} escribió "CHAU MIIA" para cerrar la conversación.
${stageInfoChau}
${_chauMiiaDialect}
Generá una despedida breve (máx 2 renglones). Recordale que si quiere volver: *HOLA MIIA*. Emoji: ${contactInfo.emoji || '💕'}`;

        try {
          const despedida = await generateAIContent(promptChauMiia);
          if (despedida) {
            await safeSendMessage(phone, despedida.trim(), { isFamily: true });
          }
        } catch (e) {
          console.error(`[DILE A] Error generando despedida CHAU MIIA:`, e.message);
          const _chauContactInfo = familyContacts[phone.split('@')[0]] || {};
          await safeSendMessage(phone, buildContextualFallback('chau_miia', { contactName: conversationMetadata[phone]?.dileAContact || '', contactPhone: phone, emoji: _chauContactInfo.emoji || '💕' }), { isFamily: true });
        }

        // ═══ RESUMEN DE LO APRENDIDO → enviar al owner en self-chat ═══
        // Después de que un contacto dice CHAU MIIA, MIIA analiza la conversación
        // y le manda un resumen al owner de lo que aprendió sobre esa persona.
        try {
          const convoHistory = conversations[phone] || [];
          if (convoHistory.length >= 2) {
            const last20 = convoHistory.slice(-20).map(m => `${m.role === 'assistant' ? 'MIIA' : contactName}: ${(m.content || '').substring(0, 200)}`).join('\n');
            const summaryPrompt = `Analizá esta conversación entre MIIA y ${contactName} (${contactInfo.relation || 'contacto'} de ${userProfile?.name || 'el owner'}).

CONVERSACIÓN:
${last20}

Generá un RESUMEN BREVE (máx 5 renglones) de lo que MIIA aprendió sobre ${contactName}:
- Datos personales mencionados (trabajo, gustos, familia, ubicación, etc.)
- Impresión general (¿le gustó MIIA? ¿se divirtió? ¿fue escéptica?)
- Algo que ${contactName} haya pedido o necesitado
- Si no se aprendió nada relevante, decilo honestamente

Formato: bullet points. Sin saludos, directo al resumen.`;
            const summary = await generateAIContent(summaryPrompt);
            if (summary) {
              const ownerJid = `${OWNER_PHONE}@s.whatsapp.net`;
              await safeSendMessage(ownerJid,
                `📋 *Resumen de mi charla con ${contactName}:*\n\n${summary.trim()}`,
                { isSelfChat: true }
              );
              console.log(`[DILE A] 📋 Resumen de conversación con ${contactName} enviado al owner`);
            }
          }
        } catch (summaryErr) {
          console.error(`[DILE A] ❌ Error generando resumen para ${contactName}:`, summaryErr.message);
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
          const ownerName = userProfile.name || 'el owner';
          // NO decir "inteligencia artificial" — MIIA se presenta como asistente, con naturalidad
          const contactInfo = familyContacts[phone.split('@')[0]] || {};
          const stageNow = getAffinityStage(phone);
          const _explainDialect = getDialectForPhone(phone);
          const promptExplain = `Sos MIIA. ${contactName} te respondió "${(effectiveMsg || '').substring(0, 60)}" pero NO escribió "HOLA MIIA" para activar la conversación.
Generá una respuesta breve (máx 2 renglones) explicándole que para hablar con vos tiene que escribir *HOLA MIIA*.
- NO digas "inteligencia artificial". NO digas "soy una IA". Presentate como "MIIA, asistente de ${ownerName}".
- Tono amigable, sin ser formal. Emoji: 1-2 max.
- ${_explainDialect}
- Decile que ${ownerName} le va a explicar mejor quién sos.`;
          try {
            const explainMsg = await generateAIContent(promptExplain);
            if (explainMsg) {
              await safeSendMessage(phone, explainMsg.trim(), { isFamily: true });
            } else {
              await safeSendMessage(phone, buildContextualFallback('handshake_explain', { contactName, ownerName, contactPhone: phone }), { isFamily: true });
            }
          } catch (e) {
            await safeSendMessage(phone, buildContextualFallback('handshake_explain', { contactName, ownerName, contactPhone: phone }), { isFamily: true });
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
            await safeSendMessage(phone, `✅ Memorizando permanentemente: "${question.text.substring(0, 100)}${question.text.length > 100 ? '...' : ''}"`, { isSelfChat: true });
            console.log(`[LEARNING] ✅ Guardado después de feedback sí: "${question.text.substring(0, 80)}..."`);
          } else if (feedback === 'no') {
            await safeSendMessage(phone, '✅ Entendido, no lo memorizo.', { isSelfChat: true });
            console.log(`[LEARNING] ⊘ Descartado por feedback no: "${question.text.substring(0, 80)}..."`);
          } else if (feedback === 'partial') {
            await safeSendMessage(phone, '✅ Anotado para revisión posterior.', { isSelfChat: true });
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
      await safeSendMessage(phone, '✅ Aprendido y guardado en mi memoria permanente.', { isSelfChat: true });
      return;
    }

    // ═══ FIX GAP 5: Comando para OLVIDAR aprendizaje ═══
    // "miia olvidá que X" / "olvidar: X" / "borra: X" / "eliminar aprendizaje: X"
    const forgetMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:olvid[aá]|olvidar|borra|borrar|eliminar aprendizaje)[:\s]+(.+)/is);
    if (isAdmin && forgetMatch) {
      const toForget = forgetMatch[1].trim().toLowerCase();
      const currentData = cerebroAbsoluto.getTrainingData();
      // Buscar líneas que contengan lo que quiere olvidar
      const lines = currentData.split('\n');
      const filtered = lines.filter(line => !line.toLowerCase().includes(toForget));
      const removedCount = lines.length - filtered.length;
      if (removedCount > 0) {
        cerebroAbsoluto.setTrainingData(filtered.join('\n'));
        saveDB();
        console.log(`[FORGET] 🗑️ Owner pidió olvidar "${toForget}" — ${removedCount} líneas eliminadas del cerebro`);
        await safeSendMessage(phone, `🗑️ Listo, eliminé ${removedCount} línea(s) de mi memoria que mencionaban "${toForget.substring(0, 50)}". Olvidado para siempre.`, { isSelfChat: true });
      } else {
        await safeSendMessage(phone, `🤔 No encontré nada en mi memoria sobre "${toForget.substring(0, 50)}". ¿Querés que busque con otras palabras?`, { isSelfChat: true });
      }
      // También limpiar de contact_preferences/affinities si aplica
      try {
        const prefsSnap = await admin.firestore().collection('users').doc(OWNER_UID)
          .collection('contact_preferences').get();
        for (const doc of prefsSnap.docs) {
          const data = doc.data();
          const entries = Object.entries(data);
          let changed = false;
          for (const [k, v] of entries) {
            if (typeof v === 'string' && v.toLowerCase().includes(toForget)) {
              await doc.ref.update({ [k]: admin.firestore.FieldValue.delete() });
              changed = true;
              console.log(`[FORGET] 🗑️ Eliminado de contact_preferences/${doc.id}: ${k}`);
            }
          }
        }
        const affsSnap = await admin.firestore().collection('users').doc(OWNER_UID)
          .collection('contact_affinities').get();
        for (const doc of affsSnap.docs) {
          const data = doc.data();
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === 'string' && v.toLowerCase().includes(toForget)) {
              await doc.ref.update({ [k]: admin.firestore.FieldValue.delete() });
              console.log(`[FORGET] 🗑️ Eliminado de contact_affinities/${doc.id}: ${k}`);
            }
          }
        }
      } catch (forgetErr) {
        console.warn(`[FORGET] ⚠️ Error limpiando Firestore: ${forgetErr.message}`);
      }
      return;
    }

    // Comando humanizer toggle: "desactivar humanizador" / "activar humanizador"
    if (isAdmin && effectiveMsg) {
      const lower = effectiveMsg.toLowerCase();
      if (lower.includes('desactivar humanizador') || lower.includes('desactivar versión humanizada')) {
        if (OWNER_UID) await admin.firestore().collection('users').doc(OWNER_UID).update({ humanizer_enabled: false });
        _humanizerCache = { value: false, ts: Date.now() };
        await safeSendMessage(phone, '✅ Humanizador desactivado. Responderé de forma más directa y sin pausas largas.', { isSelfChat: true });
        return;
      }
      if (lower.includes('activar humanizador') || lower.includes('activar versión humanizada')) {
        if (OWNER_UID) await admin.firestore().collection('users').doc(OWNER_UID).update({ humanizer_enabled: true });
        _humanizerCache = { value: true, ts: Date.now() };
        await safeSendMessage(phone, '✅ Humanizador activado. Incluiré pausas variables y pequeños errores tipográficos ocasionales.', { isSelfChat: true });
        return;
      }
    }

    // ═══ "QUÉ PODÉS HACER" — Listar categorías de capacidades (resumido) ═══
    if (isAdmin && effectiveMsg && featureAnnouncer.isCapabilitiesQuery(effectiveMsg)) {
      const capMsg = featureAnnouncer.buildCapabilitiesSummary();
      await safeSendMessage(phone, capMsg, { isSelfChat: true, skipEmoji: true });
      console.log(`[FEATURES] 📋 Categorías listadas para el owner (resumen)`);
      return;
    }

    // ═══ DETALLE DE CATEGORÍA — Owner dice "1", "agenda", "contame de email" ═══
    if (isAdmin && effectiveMsg && featureAnnouncer.isCategoryDetailQuery(effectiveMsg)) {
      const detail = featureAnnouncer.buildCategoryDetail(effectiveMsg);
      if (detail) {
        await safeSendMessage(phone, detail, { isSelfChat: true, skipEmoji: true });
        console.log(`[FEATURES] 📋 Detalle de categoría enviado al owner`);
        return;
      }
      // Si no matchea, dejar que pase a la IA normal
    }

    // ═══ CLASIFICACIÓN DE CONTACTOS (self-chat, P3.1) ═══
    if (isAdmin && effectiveMsg) {
      // "finde off" / "finde on" — Modo finde (P3.4)
      const _weekendTz = messageLogic.getTimezoneForCountry(messageLogic.getCountryFromPhone(OWNER_PHONE || ''));
      const weekendResult = weekendMode.processWeekendResponse(OWNER_UID, effectiveMsg, _weekendTz);
      if (weekendResult.handled) {
        await safeSendMessage(phone, weekendResult.response, { isSelfChat: true });
        return;
      }

      // Clasificar contactos pendientes: "amigo", "familia", "negocio", "5491155 es amigo", "mover X a Y"
      const ownerBusinesses = [];
      try {
        const bizSnap = await admin.firestore().collection('users').doc(OWNER_UID).collection('businesses').get();
        bizSnap.forEach(d => ownerBusinesses.push({ id: d.id, ...d.data() }));
      } catch (_) {}
      const classResult = await contactClassifier.tryClassifyFromOwnerMessage(OWNER_UID, effectiveMsg, ownerBusinesses);
      if (classResult.handled) {
        await safeSendMessage(phone, classResult.response, { isSelfChat: true });
        return;
      }

      // Detectar si el mensaje tiene imagen (usado por outfit + image analysis)
      // FIX CRÍTICO: 'msg' no existe en processMiiaResponse — usar lastMessageKey[phone]._baileysMsg
      const rawBaileys = lastMessageKey[phone]?._baileysMsg || lastMessageKey[phone]?._data || null;
      const hasImage = !!(rawBaileys?.message?.imageMessage || rawBaileys?.message?.viewOnceMessage?.message?.imageMessage || rawBaileys?.message?.viewOnceMessageV2?.message?.imageMessage);
      if (!rawBaileys && conversations[phone]?.length > 0) {
        console.log(`[HIM-TRACE] ℹ️ rawBaileys no disponible para ${phone} — comandos de imagen deshabilitados este turno`);
      }

      // ═══ OUTFIT MODE — Asesor de moda personal con Vision ═══
      const outfitCmd = miiaOutfit.detectOutfitCommand(effectiveMsg, hasImage);
      if (outfitCmd.isOutfit) {
        console.log(`[OUTFIT] 👗 Comando detectado: ${outfitCmd.type}`);
        try {
          const wardrobeRef = db.collection('users').doc(OWNER_UID).collection('miia_wardrobe');
          const prefsRef = db.collection('users').doc(OWNER_UID).collection('miia_outfit_prefs').doc('prefs');

          if (outfitCmd.type === 'add_garment' && hasImage) {
            await safeSendMessage(phone, `👗 Analizando la prenda...`, { isSelfChat: true, skipEmoji: true });
            const imageMsg = rawBaileys.message?.imageMessage || rawBaileys.message?.viewOnceMessage?.message?.imageMessage || rawBaileys.message?.viewOnceMessageV2?.message?.imageMessage;
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const imageBuffer = await downloadMediaMessage(rawBaileys, 'buffer', {});

            // 🛡️ Self-chat del owner → skip safety check (es su propia foto)
            console.log(`[OUTFIT:SAFETY] ℹ️ Self-chat del owner — safety check skipped`);

            const visionPrompt = miiaOutfit.buildGarmentAnalysisPrompt();
            const { callGeminiVision } = require('./ai/gemini_client');
            let visionResponse;
            if (typeof callGeminiVision === 'function') {
              visionResponse = await callGeminiVision(imageBuffer, visionPrompt);
            } else {
              visionResponse = await generateAIContent(visionPrompt, {
                images: [{ mimeType: 'image/png', data: imageBuffer.toString('base64') }],
              });
            }
            const garmentResult = miiaOutfit.parseGarmentAnalysis(visionResponse);
            if (garmentResult.error || garmentResult.items.length === 0) {
              console.warn(`[OUTFIT] ⚠️ No se detectaron prendas: ${garmentResult.error || 'items vacío'}`);
              await safeSendMessage(phone, `🤷‍♀️ No pude identificar prendas en la foto. ¿Podés enviarla de nuevo más de cerca?`, { isSelfChat: true, skipEmoji: true });
              return;
            }
            for (const g of garmentResult.items) {
              g.addedAt = new Date().toISOString();
              await wardrobeRef.add(g);
            }
            const confirmMsg = miiaOutfit.formatGarmentSaved(garmentResult.items);
            await safeSendMessage(phone, confirmMsg, { isSelfChat: true, skipEmoji: true });
            console.log(`[OUTFIT] ✅ ${garments.length} prenda(s) guardada(s) en guardarropa`);
            return;

          } else if (outfitCmd.type === 'opinion' && hasImage) {
            await safeSendMessage(phone, `🔍 Analizando tu outfit...`, { isSelfChat: true, skipEmoji: true });
            const imageMsg = rawBaileys.message?.imageMessage || rawBaileys.message?.viewOnceMessage?.message?.imageMessage || rawBaileys.message?.viewOnceMessageV2?.message?.imageMessage;
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const imageBuffer = await downloadMediaMessage(rawBaileys, 'buffer', {});

            // 🛡️ Self-chat del owner → skip safety check (es su propia foto)
            console.log(`[OUTFIT:SAFETY] ℹ️ Self-chat del owner — safety check skipped`);

            // Cargar guardarropa para contexto
            const wardrobeSnap = await wardrobeRef.get();
            const wardrobe = wardrobeSnap.docs.map(d => d.data());
            const visionPrompt = miiaOutfit.buildOutfitOpinionPrompt(wardrobe);
            const { callGeminiVision } = require('./ai/gemini_client');
            let visionResponse;
            if (typeof callGeminiVision === 'function') {
              visionResponse = await callGeminiVision(imageBuffer, visionPrompt);
            } else {
              visionResponse = await generateAIContent(visionPrompt, {
                images: [{ mimeType: 'image/png', data: imageBuffer.toString('base64') }],
              });
            }
            const opinion = miiaOutfit.parseOutfitOpinion(visionResponse);
            const formatted = miiaOutfit.formatOutfitOpinion(opinion);
            await safeSendMessage(phone, formatted, { isSelfChat: true, skipEmoji: true });
            console.log(`[OUTFIT] ✅ Opinión enviada (rating: ${opinion.rating || '?'}/10)`);
            return;

          } else if (outfitCmd.type === 'suggest') {
            await safeSendMessage(phone, `🤔 Pensando en opciones...`, { isSelfChat: true, skipEmoji: true });
            const wardrobeSnap = await wardrobeRef.get();
            const wardrobe = wardrobeSnap.docs.map(d => d.data());
            if (wardrobe.length === 0) {
              await safeSendMessage(phone, `👗 Tu guardarropa está vacío. Enviame fotos de tu ropa con "guardar" para que las registre.`, { isSelfChat: true, skipEmoji: true });
              return;
            }
            const prefsSnap = await prefsRef.get();
            const prefs = prefsSnap.exists ? prefsSnap.data() : {};
            const suggestionPrompt = miiaOutfit.buildOutfitSuggestionPrompt(outfitCmd.occasion, wardrobe, prefs, null);
            const suggestion = await generateAIContent(suggestionPrompt);
            await safeSendMessage(phone, suggestion, { isSelfChat: true, skipEmoji: true });
            console.log(`[OUTFIT] ✅ Sugerencia enviada (ocasión: ${outfitCmd.occasion || 'general'})`);
            return;

          } else if (outfitCmd.type === 'view_wardrobe') {
            const wardrobeSnap = await wardrobeRef.get();
            const wardrobe = wardrobeSnap.docs.map(d => d.data());
            const summary = miiaOutfit.formatWardrobeSummary(wardrobe);
            await safeSendMessage(phone, summary, { isSelfChat: true, skipEmoji: true });
            console.log(`[OUTFIT] 📋 Guardarropa mostrado (${wardrobe.length} prendas)`);
            return;
          }
        } catch (outfitErr) {
          console.error(`[OUTFIT] ❌ Error:`, outfitErr.message);
          await safeSendMessage(phone, `❌ Error con el modo outfit: ${outfitErr.message}`, { isSelfChat: true, skipEmoji: true });
          return;
        }
      }

      // ═══ GMAIL INTEGRATION — Lectura y gestión de emails ═══
      const gmailCmd = gmailIntegration.detectGmailCommand(effectiveMsg);
      if (gmailCmd.isGmail) {
        console.log(`[GMAIL] 📬 Comando detectado en self-chat: ${gmailCmd.type}`);
        try {
          if (gmailCmd.type === 'check' || gmailCmd.type === 'delete_spam') {
            await safeSendMessage(phone, `📬 Revisando tu correo...`, { isSelfChat: true, skipEmoji: true });
            const generateAIForGmail = async (prompt) => {
              const result = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, prompt, ownerAIConfig);
              return result.text;
            };
            const result = await gmailIntegration.runFullEmailCheck(OWNER_UID, getOAuth2Client, {
              generateAI: generateAIForGmail,
              ownerContext: { name: userProfile.name || 'owner' },
              autoDeleteSpam: true,
            });
            await safeSendMessage(phone, result.message, { isSelfChat: true, skipEmoji: true });
            console.log(`[GMAIL] ✅ Check completo enviado al owner`);
          } else if (gmailCmd.type === 'track') {
            await safeSendMessage(phone, `📌 Para trackear una respuesta, decime el asunto o de quién esperás respuesta.`, { isSelfChat: true, skipEmoji: true });
          }
          return;
        } catch (gmailErr) {
          console.error(`[GMAIL] ❌ Error:`, gmailErr.message);
          const errMsg = /no conectado|googleTokens/i.test(gmailErr.message)
            ? `📬 No tengo acceso a tu correo. Necesitás reconectar Google desde el Dashboard (Conexiones → Google) para incluir permisos de Gmail.`
            : `❌ Error revisando emails: ${gmailErr.message}`;
          await safeSendMessage(phone, errMsg, { isSelfChat: true, skipEmoji: true });
          return;
        }
      }

      // ═══ GOOGLE TASKS HANDLER — Owner gestiona tareas vía self-chat ═══
      const tasksCmd = googleTasks.detectTasksCommand(effectiveMsg);
      if (tasksCmd) {
        console.log(`[TASKS] 📋 Comando detectado en self-chat: ${tasksCmd.action}`);
        try {
          if (tasksCmd.action === 'list') {
            await safeSendMessage(phone, `📋 Buscando tus tareas...`, { isSelfChat: true, skipEmoji: true });
            const tasks = await googleTasks.listTasks(OWNER_UID, getOAuth2Client, admin);
            const msg = googleTasks.formatTasksList(tasks);
            await safeSendMessage(phone, msg, { isSelfChat: true, skipEmoji: true });
          } else if (tasksCmd.action === 'create') {
            const result = await googleTasks.createTask(OWNER_UID, getOAuth2Client, admin, {
              title: tasksCmd.params.title,
              dueDate: tasksCmd.params.dateHint || null,
              notes: 'Creada desde WhatsApp vía MIIA'
            });
            await safeSendMessage(phone, `✅ Tarea creada: *${result.title}*${result.due ? ` 📅 ${new Date(result.due).toLocaleDateString('es-ES')}` : ''}`, { isSelfChat: true, skipEmoji: true });
          } else if (tasksCmd.action === 'complete') {
            const result = await googleTasks.completeTask(OWNER_UID, getOAuth2Client, admin, { titleMatch: tasksCmd.params.titleMatch });
            if (result) {
              await safeSendMessage(phone, `✅ Tarea completada: *${result.title}* 🎉`, { isSelfChat: true, skipEmoji: true });
            } else {
              await safeSendMessage(phone, `⚠️ No encontré esa tarea. Decime "mis tareas" para ver la lista.`, { isSelfChat: true, skipEmoji: true });
            }
          } else if (tasksCmd.action === 'delete') {
            const result = await googleTasks.deleteTask(OWNER_UID, getOAuth2Client, admin, { titleMatch: tasksCmd.params.titleMatch });
            if (result) {
              await safeSendMessage(phone, `🗑️ Tarea eliminada.`, { isSelfChat: true, skipEmoji: true });
            } else {
              await safeSendMessage(phone, `⚠️ No encontré esa tarea.`, { isSelfChat: true, skipEmoji: true });
            }
          }
          console.log(`[TASKS] ✅ Comando ${tasksCmd.action} ejecutado`);
          return;
        } catch (tasksErr) {
          console.error(`[TASKS] ❌ Error:`, tasksErr.message);
          const errMsg = /no conectado|googleTokens/i.test(tasksErr.message)
            ? `📋 No tengo acceso a Google Tasks. Necesitás reconectar Google desde el Dashboard (Conexiones → Google).`
            : `❌ Error con tareas: ${tasksErr.message}`;
          await safeSendMessage(phone, errMsg, { isSelfChat: true, skipEmoji: true });
          return;
        }
      }

      // ═══ IMAGE ANALYSIS HANDLER — Owner envía imagen con texto ═══
      // MIIA analiza CUALQUIER imagen (CRM, Excel, lista, chat, etc.)
      // SIEMPRE pregunta al owner qué hacer antes de actuar
      const imageCommand = outreachEngine.isImageCommand(effectiveMsg, hasImage);
      if (imageCommand.isCommand) {
        console.log(`[IMAGE-ANALYSIS] 🔍 Imagen + comando detectado en self-chat (type: ${imageCommand.type})`);
        await safeSendMessage(phone, `🔍 Dame un momento mientras analizo la imagen...`, { isSelfChat: true, skipEmoji: true });

        try {
          const imageMsg = rawBaileys?.message?.imageMessage || rawBaileys?.message?.viewOnceMessage?.message?.imageMessage || rawBaileys?.message?.viewOnceMessageV2?.message?.imageMessage;
          if (imageMsg && rawBaileys) {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const imageBuffer = await downloadMediaMessage(rawBaileys, 'buffer', {});

            // 🛡️ Self-chat del owner → skip safety check (es su propia foto)
            console.log(`[IMAGE-ANALYSIS:SAFETY] ℹ️ Self-chat del owner — safety check skipped`);

            // Enviar a Gemini Vision para análisis GENÉRICO
            const visionPrompt = outreachEngine.buildScreenshotAnalysisPrompt();
            const { callGeminiVision } = require('./ai/gemini_client');
            let visionResponse;
            if (typeof callGeminiVision === 'function') {
              visionResponse = await callGeminiVision(imageBuffer, visionPrompt);
            } else {
              const base64Image = imageBuffer.toString('base64');
              visionResponse = await generateAIContent(visionPrompt, {
                images: [{ mimeType: 'image/png', data: base64Image }],
              });
            }

            if (!visionResponse) {
              await safeSendMessage(phone, `❌ No pude analizar la imagen. ¿Podés enviarla de nuevo?`, { isSelfChat: true, skipEmoji: true });
              return;
            }

            // Parsear análisis
            const analysis = outreachEngine.parseScreenshotResponse(visionResponse);

            // Si es outreach explícito Y hay contactos → preguntar con opciones de outreach
            if (imageCommand.type === 'outreach' && analysis.leads.length > 0) {
              const confirmMsg = outreachEngine.buildAnalysisConfirmation(analysis);
              await safeSendMessage(phone, confirmMsg, { isSelfChat: true, skipEmoji: true });

              // Guardar la cola PENDIENTE (no procesarla aún — esperar confirmación del owner)
              const queue = outreachEngine.createOutreachQueue(OWNER_UID, analysis.leads);
              queue.status = 'awaiting_confirmation';
              // La confirmación se maneja cuando el owner responde "contactalos", "dale", etc.
              // (procesado en el flujo normal de self-chat como instrucción)
              console.log(`[IMAGE-ANALYSIS] 📋 Cola creada en espera de confirmación: ${queue.id} — ${analysis.leads.length} leads`);
            } else {
              // Para cualquier otro tipo → mostrar análisis y preguntar
              const confirmMsg = outreachEngine.buildAnalysisConfirmation(analysis);
              await safeSendMessage(phone, confirmMsg, { isSelfChat: true, skipEmoji: true });
            }
          } else {
            await safeSendMessage(phone, `⚠️ No pude detectar la imagen. Enviá como imagen (no como documento).`, { isSelfChat: true, skipEmoji: true });
          }
        } catch (imgErr) {
          console.error(`[IMAGE-ANALYSIS] ❌ Error analizando imagen:`, imgErr.message);
          await safeSendMessage(phone, `❌ Error analizando la imagen: ${imgErr.message}`, { isSelfChat: true, skipEmoji: true });
        }
        return;
      }

      // ═══ OUTREACH CONFIRMATION — Owner confirma contactar leads ═══
      // Cuando el owner responde "contactalos", "dale", "arranca" después del análisis
      const outreachQueue = outreachEngine.getActiveQueue(OWNER_UID);
      if (outreachQueue && outreachQueue.status === 'awaiting_confirmation') {
        const confirmPatterns = /\b(contactalos|contactalas|dale|arranca|si|s[ií]|hazlo|mandales|escr[ií]beles|go|vamos|procede)\b/i;
        const cancelPatterns = /\b(no|nada|cancel[áa]|para|dejalo|dejalos|olvidate|olvid[áa])\b/i;

        if (confirmPatterns.test(effectiveMsg)) {
          console.log(`[OUTREACH] ✅ Owner confirmó outreach — procesando ${outreachQueue.leads.length} leads`);
          outreachQueue.status = 'pending'; // Listo para procesar
          const reportFn = async (text) => {
            await safeSendMessage(phone, text, { isSelfChat: true, skipEmoji: true });
          };
          processOutreachInBackground(outreachQueue, reportFn).catch(err => {
            console.error(`[OUTREACH] ❌ Error en procesamiento:`, err.message);
          });
          return;
        }

        if (cancelPatterns.test(effectiveMsg)) {
          outreachQueue.status = 'cancelled';
          console.log(`[OUTREACH] ❌ Owner canceló`);
          await safeSendMessage(phone, `OK, no hago nada con esas personas.`, { isSelfChat: true, skipEmoji: true });
          return;
        }

        // Si responde "mañana" / "después" / "mañana trabajá con ellos" → guardar para próximo día hábil
        if (/\b(ma[ñn]ana|despu[eé]s|luego|m[aá]s\s+tarde)\s*(trabaj[aá]|contact[aá]|escrib[ií]|mand[aá]|habl[aá])?/i.test(effectiveMsg)) {
          console.log(`[OUTREACH] ⏰ Owner pidió programar para después — ${outreachQueue.leads.length} personas guardadas`);
          outreachQueue.status = 'scheduled';
          outreachQueue.scheduledFor = 'next_business_day';
          outreachQueue.scheduledAt = new Date().toISOString();
          // Persistir en Firestore
          try {
            await db.collection('users').doc(OWNER_UID)
              .collection('outreach_queue').doc('scheduled')
              .set({
                leads: outreachQueue.leads.map(l => ({ name: l.name, phone: l.phone, status: l.status, strategy: l.strategy?.name })),
                scheduledFor: 'next_business_day',
                savedAt: new Date().toISOString(),
                leadCount: outreachQueue.leads.length,
              });
          } catch (schedErr) {
            console.error(`[OUTREACH] ❌ Error guardando schedule en Firestore: ${schedErr.message}`);
          }
          await safeSendMessage(phone, `📋 Guardé ${outreachQueue.leads.length} personas. Mañana a las 9am te recuerdo para que me digas "dale" y los contacto.`, { isSelfChat: true, skipEmoji: true });
          return;
        }

        // Si responde "guardalos" → guardar sin contactar ni programar
        if (/\b(guard[áa]los|guardalos|guard[áa]las|guardalas|solo\s+guard)/i.test(effectiveMsg)) {
          console.log(`[OUTREACH] 💾 Owner pidió guardar sin contactar`);
          await safeSendMessage(phone, `✅ Guardé ${outreachQueue.leads.length} personas sin contactarlos. Están registrados para cuando quieras.`, { isSelfChat: true, skipEmoji: true });
          outreachQueue.status = 'saved';
          return;
        }
      }

      // ═══ "RESPONDELE" HANDLER — Owner pide enviar mensaje a contacto notificado ═══
      // Detecta TODAS las variantes de "responde" en español (tú, vos, usted, con/sin acento):
      //   responde, respondé, respóndele, respondele, respondale, contestale, contéstale,
      //   escribile, escríbele, mandále, mándale, atiéndelo, dale responde, dale contestá
      // ⚠️ EXCLUIR "presentate a [nombres]" — es un comando distinto (presentarIndividual)
      // ⚠️ EXCLUIR comandos que NO son respondele pero contienen verbos similares
      const isPresentarANombres = effectiveMsg && /(?:presenta(?:te)?|preséntate|presentá(?:te)?)\s+(?:miia\s+)?(?:a|con)\s+\w/i.test(effectiveMsg);
      const isAgendaCommand = effectiveMsg && /^\s*(?:miia\s+)?(?:recordar|recuerdame|recuérdame|agendar|agenda|recordatorio|programar|pon\s+en\s+agenda)/i.test(effectiveMsg);
      // Excluir: "envíale/mándale la cotización/el documento/un email/la info" → NO es respondele, es una orden a MIIA
      const isEnviarContenido = effectiveMsg && /(?:env[ií]a|mand[aá]|m[aá]nda)(?:le|les|selo)?\s+(?:la|el|un|una|los|las|mi|su|ese|esa|esto|eso)\s+/i.test(effectiveMsg);
      const respondeleMatch = !isPresentarANombres && !isAgendaCommand && !isEnviarContenido && effectiveMsg.match(/(?:respond[eéí](?:le|les|me)?|responde$|respond[eé]$|env[ií]a(?:selo|le|les)?|pres[eé]ntate|cont[eé]sta(?:le|les)?|contest[aá](?:le|les)?|escr[ií]b[ie](?:le|les)?|mand[aá](?:le|les)?|m[aá]nda(?:le|les)?|atiend[eé](?:lo|la|le|los)?|dale\s+(?:respond|contest|escrib|mand))/i);
      if (respondeleMatch) {
        // PRIORIDAD 1: Buscar alerta "Alguien te escribió" en historial reciente
        const twoHoursAgo = Date.now() - 7200000;
        const recentMsgs = (conversations[phone] || []).slice(-20).filter(m => !m.timestamp || m.timestamp > twoHoursAgo);
        // Busca tanto el formato nuevo ("Nuevo mensaje") como el viejo ("Alguien te escribió")
        const alertMsg = recentMsgs.find(m => m.role === 'assistant' && (/Nuevo mensaje/.test(m.content) || /Alguien te escribi[oó]/.test(m.content)));

        let contactJid = null;
        let leadPhone = '';
        let leadOriginalMsg = '';

        if (alertMsg) {
          // Caso 1: Hay _contactJid guardado (siempre la fuente más confiable)
          contactJid = alertMsg._contactJid || null;
          if (contactJid) {
            leadPhone = contactJid.split('@')[0];
            console.log(`[RESPONDELE] 🎯 Usando _contactJid guardado: ${contactJid}`);
          } else {
            // Buscar número en formato nuevo "Contacto: *nombre* (+NUMERO)" o viejo "Número: +NUMERO"
            const phoneMatch = alertMsg.content.match(/(?:Número:\s*\+?|Contacto:.*?\(\+?)(\d{10,18})/);
            if (phoneMatch) {
              leadPhone = phoneMatch[1];
              contactJid = `${leadPhone}@s.whatsapp.net`;
              console.log(`[RESPONDELE] 📋 Extraído de alerta: ${contactJid}`);
            }
          }
          // Buscar mensaje original: formato nuevo "Dice:" o viejo "Mensaje:"
          const leadMsgMatch = alertMsg.content.match(/(?:Dice|Mensaje):\s*"([^"]+)"/);
          leadOriginalMsg = leadMsgMatch?.[1] || '';
        }

        // PRIORIDAD 2: Extraer número directamente del mensaje del owner
        // Soporta: "respondele a +573163937365", "respondele a 573163937365", "respondele al 3163937365"
        // FIX Sesión 35: Requiere mínimo 10 dígitos para evitar matchear secuencias cortas (hora, fecha, etc.)
        if (!contactJid) {
          const directPhoneMatch = effectiveMsg.match(/\+?(\d{10,18})/);
          if (directPhoneMatch) {
            leadPhone = directPhoneMatch[1];
            contactJid = `${leadPhone}@s.whatsapp.net`;
            console.log(`[RESPONDELE] 📱 Número extraído directo del mensaje: ${contactJid}`);
          }

          // PRIORIDAD 3: Buscar por nombre en mensajes recientes del owner (quoted reply o contexto)
          if (!contactJid) {
            // Buscar en mensajes recientes de otros contactos (no self-chat)
            const ownerJid = phone;
            const nameInMsg = effectiveMsg.replace(respondeleMatch[0], '').replace(/^[\s,a]+/i, '').trim();
            if (nameInMsg) {
              // Buscar en conversations un contacto cuyo nombre matchee
              for (const [convJid, msgs] of Object.entries(conversations)) {
                if (convJid === ownerJid || !convJid.includes('@')) continue;
                const lastMsg = msgs.slice(-5).find(m => m.role === 'user');
                if (lastMsg && lastMsg._pushName && lastMsg._pushName.toLowerCase().includes(nameInMsg.toLowerCase())) {
                  contactJid = convJid;
                  leadPhone = convJid.split('@')[0];
                  leadOriginalMsg = lastMsg.content || '';
                  console.log(`[RESPONDELE] 👤 Encontrado por nombre "${nameInMsg}" → ${contactJid}`);
                  break;
                }
              }
            }
          }
        }

        if (contactJid && leadPhone) {
          // Generar respuesta como MIIA representando al owner
          // FIX: fallback robusto para nombre — NUNCA dejar vacío
          const ownerName = userProfile.name || userProfile.shortName || userProfile.displayName || OWNER_PHONE || 'el equipo';
          const businessName = userProfile.businessName || '';
          // Extraer instrucción específica del owner (lo que viene después del número/nombre)
          const instruccion = effectiveMsg.replace(respondeleMatch[0], '').replace(/\+?\d{7,18}/, '').replace(/^[\s,a]+/i, '').trim();
          // Inyectar training_data si existe (para que MIIA use lo que aprendió del owner)
          const trainingContext = cerebroAbsoluto.getTrainingData();
          const trainingHint = trainingContext ? `\nCONTEXTO APRENDIDO DEL NEGOCIO (úsalo para dar contexto, NO lo cites textualmente):\n${trainingContext.substring(0, 500)}` : '';
          const respondPrompt = `Sos MIIA, asistente virtual de ${ownerName}${businessName ? ` en ${businessName}` : ''}.
${leadOriginalMsg ? `Un contacto escribió: "${leadOriginalMsg}"` : 'Un contacto te escribió anteriormente.'}
${effectiveMsg.includes('preséntate') || effectiveMsg.includes('presentate') ? `Tu jefe te pide que te presentes y preguntes en qué podés ayudar.` : instruccion ? `Tu jefe te pide: "${instruccion}"` : `Tu jefe te pide que le respondas de forma profesional y preguntes en qué podés ayudar.`}
${trainingHint}
REGLAS:
- Máx 3 líneas, cálido y profesional
- Preséntate como "Soy MIIA${businessName ? `, de ${businessName}` : ''}" — corto y claro
- JAMÁS decir "del equipo", "asistente personal de", ni frases genéricas cortadas
- JAMÁS decir que sos IA, inteligencia artificial, bot, ni programa
- JAMÁS mencionar "me pidieron", "mi jefe", "el owner", "me encargaron"
- Si no tenés nombre de negocio, solo decí "Soy MIIA" y preguntá en qué podés ayudar
${(() => { const lc = leadPhone.substring(0, 2); if (lc === '57') return '- DIALECTO: TÚ colombiano. "cuéntame", "dime". NUNCA "contame/decime".'; if (lc === '52') return '- DIALECTO: TÚ mexicano. "cuéntame", "platícame". NUNCA "contame/decime".'; if (lc === '54') return '- DIALECTO: VOS rioplatense. "contame", "decime", "mirá".'; if (lc === '34') return '- DIALECTO: TÚ español. "cuéntame", "dime". NUNCA "vos". Expresiones: "vale", "genial".'; return '- DIALECTO: TÚ español neutro. "cuéntame", "dime". NUNCA "contame/decime".'; })()}`;

          try {
            const responseMsg = await generateAIContent(respondPrompt);
            if (responseMsg) {
              // Construir lista de JIDs a intentar (contactJid + alternativas)
              const jidsToTry = [contactJid];
              if (contactJid.includes('@lid')) {
                const resolved = resolveLid(contactJid);
                if (resolved !== contactJid) jidsToTry.unshift(resolved);
                jidsToTry.push(`${leadPhone}@s.whatsapp.net`);
              } else {
                jidsToTry.push(`${leadPhone}@lid`);
              }

              // Enviar al lead
              let sent = false;
              for (const targetJid of jidsToTry) {
                try {
                  await safeSendMessage(targetJid, responseMsg.trim());
                  console.log(`[RESPONDELE] ✅ Mensaje enviado a ${targetJid}: "${responseMsg.substring(0, 60)}..."`);
                  if (!conversations[targetJid]) conversations[targetJid] = [];
                  conversations[targetJid].push({ role: 'assistant', content: responseMsg.trim(), timestamp: Date.now() });
                  if (!allowedLeads.includes(targetJid)) allowedLeads.push(targetJid);
                  sent = true;
                  saveDB();
                  break;
                } catch (sendErr) {
                  console.warn(`[RESPONDELE] ⚠️ Fallo enviando a ${targetJid}: ${sendErr.message}`);
                }
              }

              if (sent) {
                await safeSendMessage(phone, `✅ Listo, le escribí al contacto.`, { isSelfChat: true, skipEmoji: true });
              } else {
                await safeSendMessage(phone, `⚠️ No pude enviar el mensaje. El número puede tener un formato distinto. Intentá con "dile a +${leadPhone} [tu mensaje]".`, { isSelfChat: true, skipEmoji: true });
              }
              return;
            }
          } catch (genErr) {
            console.error(`[RESPONDELE] ❌ Error generando respuesta: ${genErr.message}`);
          }
        }
      }
    }

    // ═══ RESPONDELE IMPLÍCITO — ELIMINADO ═══
    // Se eliminó porque causaba envíos no deseados cuando el owner pegaba números
    // en el self-chat para su referencia personal. El owner debe usar verbos explícitos
    // ("dile a", "escríbele a", "respondele a") para que MIIA envíe mensajes.

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
            await safeSendMessage(phone, `✅ Anotado! Voy a seguir a ${sportPref.team || sportPref.driver} (${sportPref.type}) y te aviso cuando jueguen 🔥`, { isSelfChat: true });
          } catch (err) {
            console.error(`[SPORT-CMD] Error agregando preferencia: ${err.message}`);
            await safeSendMessage(phone, `❌ No pude guardar la preferencia: ${err.message}`, { isSelfChat: true });
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
            await safeSendMessage(phone, `✅ Anotado! ${contactName} es fan de ${sportPref.team || sportPref.driver} (${sportPref.type}). Le voy a avisar cuando jueguen 🔥`, { isSelfChat: true });
          } catch (err) {
            console.error(`[SPORT-CMD] Error: ${err.message}`);
            await safeSendMessage(phone, `❌ Error: ${err.message}`, { isSelfChat: true });
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
          await safeSendMessage(phone, `✅ Eliminada preferencia de ${sportType} para ${contactName}`, { isSelfChat: true });
        } catch (err) {
          await safeSendMessage(phone, `❌ Error: ${err.message}`, { isSelfChat: true });
        }
        return;
      }

      // "mis deportes" → listar preferencias actuales
      if (sportLower.match(/^(?:miia\s+)?mis\s+deportes$/i)) {
        const stats = sportEngine.getStats();
        if (stats.contactsWithPrefs === 0) {
          await safeSendMessage(phone, '📊 No tenés deportes configurados aún. Decime "soy hincha de [equipo]" para empezar!', { isSelfChat: true });
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
          await safeSendMessage(phone, msg, { isSelfChat: true });
        }
        return;
      }
    }

    // ═══ OWNER MEMORY + BRIEFING CONFIG — Self-chat commands ═══
    // Confirmación, gustos, familia, trabajo, rutinas, alertas, briefings, ciudad
    if (isAdmin && effectiveMsg) {
      const briefLower = effectiveMsg.toLowerCase().trim();

      // ─── CONFIRMACIÓN DE CAMBIO PENDIENTE ───
      // Si MIIA preguntó "¿Confirmo que...?" y el owner responde sí/no
      if (_pendingOwnerConfirm && _pendingOwnerConfirm.ownerUid === OWNER_UID) {
        if (briefLower === 'sí' || briefLower === 'si' || briefLower === 'yes' || briefLower === 'dale' || briefLower === 'ok' || briefLower === 'confirmo') {
          const pending = _pendingOwnerConfirm;
          _pendingOwnerConfirm = null;

          if (pending.type === 'briefing_hour') {
            const ok = await morningBriefing.updateBriefingHour(pending.briefingType, pending.hour);
            await safeSendMessage(phone, ok
              ? `✅ Listo. Briefing de ${pending.briefingType} a las ${pending.hour}:00. Guardado para siempre 🔒`
              : `❌ Error guardando. Intentá de nuevo.`, { isSelfChat: true });
          } else if (pending.type === 'city') {
            await morningBriefing.updateOwnerCity(pending.city);
            await safeSendMessage(phone, `✅ Ciudad guardada: ${pending.city}. Te mando el clima todos los días 🌤️🔒`, { isSelfChat: true });
          } else if (pending.type === 'owner_memory') {
            await ownerMemory.save(pending.category, pending.key, pending.value, pending.rawText);
            await safeSendMessage(phone, `✅ Guardado para siempre 🔒`, { isSelfChat: true });
          }
          return;
        } else if (briefLower === 'no' || briefLower === 'nah' || briefLower === 'cancelar') {
          _pendingOwnerConfirm = null;
          await safeSendMessage(phone, `👌 Cancelado.`, { isSelfChat: true });
          return;
        }
        // Si no es ni sí ni no, limpiar el pending y seguir procesando normalmente
        _pendingOwnerConfirm = null;
      }

      // ─── BRIEFING HORARIOS ───
      const briefingMatch = briefLower.match(/^(?:miia\s+)?briefing\s+(clima|noticias|deportes|vuelos)\s+a\s+las?\s+(\d{1,2})/i);
      if (briefingMatch) {
        const type = briefingMatch[1];
        const hour = parseInt(briefingMatch[2], 10);
        if (hour < 0 || hour > 23) {
          await safeSendMessage(phone, `❌ Hora inválida. Usá un número entre 0 y 23.`, { isSelfChat: true });
        } else {
          _pendingOwnerConfirm = { ownerUid: OWNER_UID, type: 'briefing_hour', briefingType: type, hour };
          await safeSendMessage(phone, `¿Confirmo cambiar el briefing de *${type}* a las *${hour}:00*? Esto queda guardado para siempre 🔒 (sí/no)`, { isSelfChat: true });
        }
        return;
      }

      // ─── CIUDAD ───
      const cityMatch = briefLower.match(/^(?:miia\s+)?(?:mi ciudad es|vivo en|estoy en)\s+(.+)/i);
      if (cityMatch) {
        const city = cityMatch[1].trim();
        _pendingOwnerConfirm = { ownerUid: OWNER_UID, type: 'city', city };
        await safeSendMessage(phone, `¿Confirmo que tu ciudad es *${city}*? Esto queda guardado para siempre 🔒 (sí/no)`, { isSelfChat: true });
        return;
      }

      // ─── MIS COSAS / QUÉ SABÉS DE MÍ ───
      if (briefLower.match(/^(?:miia\s+)?(?:mis\s+cosas|que\s+sab[eé]s\s+de\s+m[ií]|mi\s+perfil|mis\s+datos|mis\s+gustos|mis\s+briefings?|mis\s+recordatorios|mis\s+alertas|qué\s+recordás)$/i)) {
        const memoryMsg = await ownerMemory.formatForWhatsApp();
        const schedule = await morningBriefing.getBriefingSchedule();
        let briefMsg = `\n📋 *Briefings:*\n`;
        briefMsg += `  🌤️ Clima: ${schedule.climaHour}:00\n`;
        briefMsg += `  📰 Noticias: ${schedule.noticiasHour}:00\n`;
        briefMsg += `  ⚽ Deportes+Precios: ${schedule.deportesHour}:00\n`;
        briefMsg += `  ✈️ Vuelos: ${schedule.vuelosHour}:00\n`;
        briefMsg += `  📍 Ciudad: ${schedule.city || '(no configurada)'}\n`;
        await safeSendMessage(phone, memoryMsg + briefMsg, { isSelfChat: true });
        return;
      }

      // ─── DETECCIÓN AUTOMÁTICA DE PREFERENCIAS ───
      // "me gusta X", "soy vegetariano", "mi hijo se llama X", etc.
      // Pasa ownerName para ignorar "soy Mariano" (el owner se identifica, no es una preferencia)
      const detected = ownerMemory.detectPreference(effectiveMsg, userProfile?.name || 'el owner');
      if (detected) {
        _pendingOwnerConfirm = {
          ownerUid: OWNER_UID,
          type: 'owner_memory',
          category: detected.category,
          key: detected.key,
          value: detected.value,
          rawText: effectiveMsg
        };
        await safeSendMessage(phone, detected.confirmMsg, { isSelfChat: true });
        return;
      }
    }

    // ═══ PRICE TRACKER — "¿averiguaste algo?" / "estado de mis productos" ═══
    if (isAdmin && effectiveMsg) {
      const priceLower = effectiveMsg.toLowerCase().trim();
      if (priceLower.match(/^(?:miia\s+)?(?:averiguaste\s+algo|que\s+pas[oó]\s+con\s+mi\s+producto|estado\s+(?:de\s+)?mis\s+productos|mis\s+productos|que\s+averiguaste)/i)) {
        const statusMsg = await priceTracker.getStoreInquiryStatus(OWNER_UID);
        await safeSendMessage(phone, statusMsg, { isSelfChat: true });
        return;
      }
    }

    // ═══ PRICE TRACKER — Self-chat commands ═══
    // "seguí este producto: URL" / "trackear: URL" / "precio: URL"
    const priceTrackMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:segui|seguí|trackear?|precio|rastrear?)\s+(?:este\s+producto\s*:?\s*)?(.+)/i);
    if (isAdmin && priceTrackMatch) {
      const urlOrProduct = priceTrackMatch[1].trim();
      if (urlOrProduct.includes('http')) {
        await safeSendMessage(phone, `🔍 Analizando producto... Dame unos segundos.`, { isSelfChat: true });
        const result = await priceTracker.trackProduct(urlOrProduct, OWNER_UID);
        if (result.success) {
          let response = `✅ *Producto registrado para seguimiento*\n📦 ${result.productName}\n💰 ${result.currency} ${result.price?.toLocaleString() || 'N/A'}\n📊 Stock: ${result.stock || 'desconocido'}`;
          if (result.storeWhatsApp) response += `\n📱 Le escribí al WhatsApp de la tienda consultando precio y stock`;
          if (result.storeEmail) response += `\n📧 También envié un email a la tienda`;
          response += `\n\nTe avisaré cuando cambie el precio 💰`;
          await safeSendMessage(phone, response, { isSelfChat: true });
        } else {
          await safeSendMessage(phone, `❌ No pude analizar ese producto: ${result.error}`, { isSelfChat: true });
        }
        return;
      }
    }

    // "mis productos" / "productos trackeados" / "mis precios"
    const priceListMatch = effectiveMsg && /^(?:miia\s+)?(?:mis\s+productos|productos\s+trackeados|mis\s+precios)/i.test(effectiveMsg);
    if (isAdmin && priceListMatch) {
      try {
        const tracksSnap = await admin.firestore()
          .collection('users').doc(OWNER_UID)
          .collection('price_tracks')
          .where('status', '==', 'active')
          .limit(20).get();
        if (tracksSnap.empty) {
          await safeSendMessage(phone, '📦 No tenés productos en seguimiento. Decime "seguí este producto: [URL]" para empezar!', { isSelfChat: true });
        } else {
          let msg = `📦 *Productos en seguimiento (${tracksSnap.size}):*\n`;
          for (const doc of tracksSnap.docs) {
            const t = doc.data();
            const diff = t.baselinePrice > 0 ? ((t.currentPrice - t.baselinePrice) / t.baselinePrice * 100).toFixed(1) : 0;
            const arrow = diff > 0 ? '📈' : diff < 0 ? '📉' : '➡️';
            msg += `\n${arrow} *${t.productName}*\n   ${t.currency} ${t.currentPrice?.toLocaleString()} (${diff > 0 ? '+' : ''}${diff}%) — Stock: ${t.stock}`;
          }
          await safeSendMessage(phone, msg, { isSelfChat: true });
        }
      } catch (e) {
        await safeSendMessage(phone, `❌ Error consultando productos: ${e.message}`, { isSelfChat: true });
      }
      return;
    }

    // ═══ TRAVEL TRACKER — Self-chat commands ═══
    // "busca vuelos BOG EZE mayo" / "vuelos de bogota a buenos aires"
    const flightSearchMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:busca?\s+)?vuelos?\s+(?:de\s+)?(\S+)\s+(?:a\s+)?(\S+)\s*(.*)?/i);
    if (isAdmin && flightSearchMatch) {
      const origin = flightSearchMatch[1].trim();
      const dest = flightSearchMatch[2].trim();
      const dateRange = flightSearchMatch[3]?.trim() || 'próximas semanas';
      await safeSendMessage(phone, `✈️ Buscando vuelos ${origin} → ${dest} para ${dateRange}...`, { isSelfChat: true });
      const results = await travelTracker.searchFlights(origin, dest, dateRange);
      await safeSendMessage(phone, results, { isSelfChat: true });
      return;
    }

    // "avisame si hay vuelos BOG EZE por menos de 200" / "alerta vuelo BOG EZE 200"
    const flightAlertMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:avisame|alerta)\s+(?:si\s+hay\s+)?vuelos?\s+(\S+)\s+(?:a\s+)?(\S+)\s+(?:por\s+)?(?:menos\s+de\s+)?\$?(\d+)\s*(usd|cop|eur|mxn|clp|ars)?/i);
    if (isAdmin && flightAlertMatch) {
      const origin = flightAlertMatch[1].trim();
      const dest = flightAlertMatch[2].trim();
      const maxPrice = parseInt(flightAlertMatch[3]);
      const currency = (flightAlertMatch[4] || 'USD').toUpperCase();
      const result = await travelTracker.createFlightAlert(OWNER_UID, origin, dest, maxPrice, currency);
      if (result.success) {
        await safeSendMessage(phone, `✅ *Alerta de vuelo creada*\n✈️ ${origin} → ${dest}\n💰 Menos de ${currency} ${maxPrice}\n\nTe aviso cuando encuentre algo 🔔`, { isSelfChat: true });
      } else {
        await safeSendMessage(phone, `❌ Error creando alerta: ${result.error}`, { isSelfChat: true });
      }
      return;
    }

    // "qué necesito para viajar a Chile?" / "info Chile" / "viajar a Chile"
    const destInfoMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:que\s+necesito\s+para\s+)?(?:viajar\s+a|info\s+(?:de\s+)?|informacion\s+(?:de\s+)?)(\S+.*)/i);
    if (isAdmin && destInfoMatch && /viaj|info|necesito/i.test(effectiveMsg)) {
      const dest = destInfoMatch[1].replace(/\?/g, '').trim();
      await safeSendMessage(phone, `🌍 Buscando info sobre ${dest}...`, { isSelfChat: true });
      const info = await travelTracker.getDestinationInfo(dest);
      await safeSendMessage(phone, info, { isSelfChat: true });
      return;
    }

    // "checklist para Madrid 7 días" / "checklist viaje Madrid"
    const checklistMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?checklist\s+(?:para\s+|viaje\s+)?(\S+)\s*(.*)?/i);
    if (isAdmin && checklistMatch) {
      const dest = checklistMatch[1].trim();
      const details = checklistMatch[2]?.trim() || '';
      await safeSendMessage(phone, `📋 Generando checklist para ${dest}...`, { isSelfChat: true });
      const checklist = await travelTracker.generateChecklist(dest, details);
      await safeSendMessage(phone, checklist, { isSelfChat: true });
      return;
    }

    // "mi pasaporte vence en diciembre 2027" / "pasaporte 12/2027"
    const passportMatch = effectiveMsg && effectiveMsg.match(/^(?:miia\s+)?(?:mi\s+)?pasaporte\s+(?:vence\s+(?:en\s+)?)?(.+)/i);
    if (isAdmin && passportMatch) {
      const expiryText = passportMatch[1].trim();
      // Pedir a Gemini que parsee la fecha
      const parsePrompt = `Convierte esto a fecha ISO: "${expiryText}". Responde SOLO con el formato YYYY-MM-DD. Si no se puede, responde "INVALID".`;
      const parsed = await generateAIContent(parsePrompt);
      if (parsed && parsed.trim() !== 'INVALID' && parsed.match(/\d{4}-\d{2}-\d{2}/)) {
        const expiryDate = parsed.match(/\d{4}-\d{2}-\d{2}/)[0];
        await travelTracker.savePassport(OWNER_UID, { expiry: expiryDate });
        await safeSendMessage(phone, `🛂 Pasaporte registrado — vence el *${expiryDate}*. Te avisaré 3 meses antes 📅`, { isSelfChat: true });
      } else {
        await safeSendMessage(phone, `🤔 No entendí la fecha. Probá con formato: "pasaporte vence en diciembre 2027"`, { isSelfChat: true });
      }
      return;
    }

    // ═══ PRESENTACIÓN MIIA AL EQUIPO — One-shot con video langosta ═══
    // Trigger: "presenta miia al equipo" / "preséntate al equipo" / "presentate al equipo medilink"
    const presentarEquipoMatch = effectiveMsg && /(?:presenta(?:te)?|preséntate|presentá(?:te)?)\s+(?:miia\s+)?(?:al?\s+)?equipo(?:\s+medilink)?/i.test(effectiveMsg);
    if (isAdmin && presentarEquipoMatch) {
      console.log(`[EQUIPO:PRESENTACIÓN] 🎬 Mariano activó presentación de MIIA al equipo`);
      const phones = Object.keys(equipoMedilink);
      if (phones.length === 0) {
        const _ownerCountryEQ = getCountryFromPhone(OWNER_PHONE || '57');
        const _eqVerb = _ownerCountryEQ === 'AR' ? 'agregá' : 'agrega';
        await safeSendMessage(phone, `No tengo miembros del equipo registrados. Primero ${_eqVerb} contactos al equipo desde el dashboard o decime sus números.`, { isSelfChat: true, skipEmoji: true });
        return;
      }

      let enviados = 0;
      for (const num of phones) {
        const target = `${num}@s.whatsapp.net`;
        try {
          const nombreMiembro = equipoMedilink[num].name || leadNames[target] || 'compañero';

          // Mensaje de presentación + frase motivacional de la langosta
          const eqOwner = userProfile?.name || 'el equipo';
          const eqBiz = userProfile?.businessName || '';
          const presentMsg = `¡Hola ${nombreMiembro}! 👋\n\nSoy *MIIA*, la asistente inteligente${eqBiz ? ` de ${eqBiz}` : ''}. ${eqOwner} me pidió que me presente con el equipo.\n\nÉl dice que *todos nosotros somos como langostas*: para crecer, primero hay que soltar el caparazón viejo — lo cómodo, lo que ya no sirve — y quedarse vulnerable un momento. Pero es justamente en esa incomodidad donde se da el verdadero crecimiento. 🦞\n\nMirá este video, vale la pena:\nhttps://www.youtube.com/watch?v=aGcB3fYEiyY\n\nVamos a hacer grandes cosas juntos. Estoy acá para ayudarlos en lo que necesiten.`;

          await safeSendMessage(target, presentMsg);
          enviados++;
          // Delay entre mensajes para no parecer bot
          await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 3000)));
        } catch (e) {
          console.error(`[EQUIPO:PRESENTACIÓN] ❌ Error enviando a ${num}:`, e.message);
        }
      }
      await safeSendMessage(phone, `✅ Listo — me presenté con ${enviados} de ${phones.length} miembros del equipo. Cada uno recibió mi presentación con el video de la langosta 🦞`, { isSelfChat: true, skipEmoji: true });
      // Marcar que la presentación ya se hizo (para no recordar más)
      try {
        await db.collection('users').doc(OWNER_UID).collection('miia_flags').doc('team_presentation').set({ done: true, doneAt: new Date().toISOString(), sentTo: enviados });
      } catch (_) {}
      console.log(`[EQUIPO:PRESENTACIÓN] ✅ Presentación completa (${enviados}/${phones.length})`);
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // COMANDO: "presentate a [nombre/s]" — MIIA se presenta individualmente a contactos
    // Trigger: "presentate a Kamila", "preséntate a Kamila y Liliana", "presentate con Kamila, Liliana"
    // MIIA inicia conversación proactiva: se presenta, explica qué es, conoce a la persona
    // ═══════════════════════════════════════════════════════════════════════════
    const presentarIndividualMatch = effectiveMsg && effectiveMsg.match(/(?:presenta(?:te)?|preséntate|presentá(?:te)?)\s+(?:miia\s+)?(?:a|con)\s+(.+)/i);
    const isNotEquipoPresent = effectiveMsg && !effectiveMsg.match(/(?:presenta(?:te)?|preséntate)\s+(?:miia\s+)?(?:al?\s+)?equipo/i);
    if (isAdmin && presentarIndividualMatch && isNotEquipoPresent) {
      const namesRaw = presentarIndividualMatch[1].trim();
      // Parsear nombres: "Kamila y Liliana", "Kamila, Liliana", "Kamila"
      const names = namesRaw.split(/\s*(?:,|y)\s*/i).map(n => n.trim()).filter(n => n.length > 0);
      console.log(`[PRESENTAR] 🎬 Owner pidió presentación individual a: ${names.join(', ')}`);

      // Buscar cada nombre en familyContacts
      const targets = [];
      const notFound = [];
      for (const name of names) {
        const nameLower = name.toLowerCase();
        const match = Object.entries(familyContacts).find(([, info]) => {
          const n = (info.name || '').toLowerCase();
          const fn = (info.fullName || '').toLowerCase();
          return n === nameLower || fn === nameLower || n.includes(nameLower) || fn.includes(nameLower);
        });
        if (match) {
          targets.push({ phone: match[0], info: match[1] });
        } else {
          notFound.push(name);
        }
      }

      if (targets.length === 0) {
        await safeSendMessage(phone, `❌ No encontré a nadie con ${names.length > 1 ? 'esos nombres' : 'ese nombre'} en tus contactos. Verificá que estén registrados.`, { isSelfChat: true });
        return;
      }

      if (notFound.length > 0) {
        await safeSendMessage(phone, `⚠️ No encontré a: ${notFound.join(', ')}. Pero me presento con ${targets.map(t => t.info.name).join(' y ')}.`, { isSelfChat: true });
      }

      // Resolver nombre del owner — NUNCA usar 'el owner' como fallback (split produce 'el' → IA dice 'Él me creó')
      let ownerName = userProfile?.name || '';
      if (!ownerName && OWNER_UID) {
        try {
          const owDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
          if (owDoc.exists && owDoc.data().name) ownerName = owDoc.data().name;
        } catch (_) {}
      }
      if (!ownerName) ownerName = 'tu dueño'; // Fallback genérico — Firestore DEBERÍA tener el nombre
      const ownerFirstName = ownerName.split(' ')[0];
      console.log(`[PRESENTAR] 👤 Owner name para presentación: "${ownerFirstName}" (full: "${ownerName}")`);
      let presentados = 0;

      for (const target of targets) {
        const targetJid = `${target.phone}@s.whatsapp.net`;
        try {
          // Prompt IA para generar presentación natural y personalizada
          const introPrompt = `Sos MIIA, una asistente personal por WhatsApp. ${ownerFirstName} quiere que te presentes con ${target.info.name}.

CONTEXTO:
- ${target.info.name} es ${target.info.relation || 'cercana/o a ' + ownerFirstName}
- Personalidad: ${target.info.personality || 'Persona cercana'}
- ${ownerFirstName} le quiere dar acceso GRATIS de por vida a MIIA
- MIIA todavía está en desarrollo, no fue "liberada" oficialmente aún
- Página web: www.miia-app.com

TU MISIÓN en este primer mensaje:
1. Presentarte de forma cálida y natural (como una amiga nueva, NO formal, NO robótica)
2. Mencionar que sos la asistente de ${ownerFirstName} (decí su nombre EXPLÍCITAMENTE)
3. Explicar brevemente qué hacés (agenda, recordatorios, clima, noticias, deportes, y más)
4. Decirle que tiene acceso gratis para siempre porque ${ownerFirstName} la incluyó en un grupo especial
5. Mencionarle www.miia-app.com para que conozca más
6. Preguntarle algo sobre ella para empezar a conocerla

REGLAS ABSOLUTAS:
- Máximo 8-10 renglones. Natural, como una amiga nueva.
- Emojis con moderación (3-4 max). Emoji de cierre: ${target.info.emoji || '💕'}
- NO digas "inteligencia artificial" ni "IA" ni "bot". Sos MIIA, punto.
- NO digas "${ownerFirstName} me pidió que te escriba" ni nada parecido. Presentate con INICIATIVA PROPIA.
- OBLIGATORIO: Mencioná a ${ownerFirstName} por nombre (NO "él", NO "ella", NO pronombres).
- PROHIBIDO decir que alguien "te creó". NADIE te creó en esta conversación. Sos la asistente de ${ownerFirstName}, punto.
- Ejemplo correcto: "Soy MIIA, la asistente de ${ownerFirstName}" / "${ownerFirstName} quiso que te conozca"
- Ejemplo PROHIBIDO: "${ownerFirstName} me creó" / "Él me hizo" / "Mi creador"
- Sé genuinamente curiosa por conocerla
${(() => { const tc = target.phone.substring(0, 2); const tc3 = target.phone.substring(0, 3); if (tc === '57') return '- DIALECTO: Usá TÚ (tuteo colombiano). "cuéntame", "dime". NUNCA "contame", "decime" (argentino). Expresiones: "listo", "dale", "con mucho gusto".'; if (tc === '52') return '- DIALECTO: Usá TÚ (tuteo mexicano). "cuéntame", "platícame". NUNCA "contame", "decime" (argentino). Expresiones: "órale", "sale", "con gusto".'; if (tc === '56') return '- DIALECTO: Usá TÚ (tuteo chileno). "cuéntame", "dime". NUNCA "contame", "decime" (argentino). Expresiones: "dale", "ya", "perfecto".'; if (tc === '54') return '- DIALECTO: Usá VOS (voseo rioplatense). "contame", "decime", "mirá". Expresiones: "dale", "genial", "bárbaro".'; if (tc3 === '180' || tc3 === '182' || tc3 === '184') return '- DIALECTO: Usá TÚ (tuteo caribeño). "cuéntame", "dime". NUNCA "contame" (argentino). Expresiones: "claro", "perfecto".'; if (tc === '34') return '- DIALECTO: Usá TÚ (tuteo español). "cuéntame", "dime". NUNCA "vos". Expresiones: "vale", "genial", "estupendo".'; return '- DIALECTO: Usá TÚ (español neutro). "cuéntame", "dime". NUNCA "contame" (argentino).'; })()}`;

          const introMsg = await generateAIContent(introPrompt);
          if (introMsg) {
            await safeSendMessage(targetJid, introMsg.trim(), { isFamily: true });
            target.info.isHandshakeDone = true;
            if (!allowedLeads.includes(targetJid)) allowedLeads.push(targetJid);
            conversations[targetJid] = conversations[targetJid] || [];
            conversations[targetJid].push({ role: 'assistant', content: introMsg.trim(), timestamp: Date.now() });
            presentados++;

            // Metadata: MIIA INICIÓ la conversación → lista para chatear de inmediato
            // dileAHandshakePending = false porque MIIA ya se presentó, no necesita HOLA MIIA
            if (!conversationMetadata[targetJid]) conversationMetadata[targetJid] = {};
            conversationMetadata[targetJid].dileAMode = true; // Habilita handler HOLA/CHAU MIIA
            conversationMetadata[targetJid].dileAActive = true; // Conversación activa ya
            conversationMetadata[targetJid].dileAContact = target.info.name;
            conversationMetadata[targetJid].dileAHandshakePending = false; // NO requiere HOLA MIIA — MIIA inició

            console.log(`[PRESENTAR] ✅ Presentación enviada a ${target.info.name} (${target.phone})`);

            // Delay entre mensajes para no parecer bot
            if (targets.indexOf(target) < targets.length - 1) {
              const delay = 5000 + Math.floor(Math.random() * 5000);
              await new Promise(r => setTimeout(r, delay));
            }
          } else {
            console.error(`[PRESENTAR] ❌ IA no generó mensaje para ${target.info.name}`);
          }
        } catch (e) {
          console.error(`[PRESENTAR] ❌ Error presentándose a ${target.info.name}:`, e.message);
        }
      }

      saveDB();
      if (presentados > 0) {
        const nombresOk = targets.filter((_, i) => i < presentados).map(t => t.info.name).join(' y ');
        await safeSendMessage(phone, `✅ Listo — me presenté con ${nombresOk}. Cuando respondan con *HOLA MIIA* arrancamos a conversar 💜`, { isSelfChat: true });
      } else {
        await safeSendMessage(phone, `❌ No pude enviar ninguna presentación. Verificá que WhatsApp esté conectado.`, { isSelfChat: true });
      }
      return;
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
          const ownerN = userProfile?.name || 'el owner';
          const bizN = userProfile?.businessName || 'la empresa';
          const promptEquipo = `Sos MIIA, asistente IA de ${bizN}. ${ownerN} te pide que le transmitas este mensaje a un integrante del equipo${nombreMiembro ? ` (${nombreMiembro})` : ''}: "${tema}". Redactá un mensaje breve, cálido y profesional. Si no sabés su nombre, no lo inventes.`;
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

      // Recordar la presentación con video langosta si aún no se hizo
      try {
        const presentDoc = await db.collection('users').doc(OWNER_UID).collection('miia_flags').doc('team_presentation').get();
        if (!presentDoc.exists || !presentDoc.data()?.done) {
          const _bcastVerb = getCountryFromPhone(OWNER_PHONE || '57') === 'AR' ? 'decime' : 'dime';
          await safeSendMessage(phone, `✅ Mensaje enviado a ${enviados} miembros del equipo.\n\n💡 ¿Ya me presentaste al equipo? Si ${_bcastVerb === 'decime' ? 'querés' : 'quieres'} que les mande mi presentación con el video de la langosta 🦞, ${_bcastVerb} "presentate al equipo".`, { isSelfChat: true, skipEmoji: true });
        }
      } catch (_) {}
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
              const famOwnerN = userProfile?.name || 'el owner';
              const promptFamilia = `Sos MIIA. Escribile a ${fInfo.name} (${fInfo.relation} de ${famOwnerN}). Personalidad: ${fInfo.personality || 'Amistosa'}. Contexto: "${familyMsg}". Este mensaje es TUYO, con TU voz y TU iniciativa. PROHIBIDO TOTAL: "${famOwnerN} me pidió", "él quería saber", "me dijo que te diga", "soy asistente de", "soy una inteligencia artificial". Máx 3 renglones, natural y cálido. Emoji: ${fInfo.emoji || ''}.`;
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

        // ═══ Caso número directo: "dile a +573138501884: mensaje" o "dile a 573138501884 mensaje" ═══
        const phoneDirectMatch = rest.match(/^\+?(\d{10,15})\s*[:\-]?\s*(.*)/s);
        if (phoneDirectMatch) {
          const directNumber = phoneDirectMatch[1];
          const directMessage = (phoneDirectMatch[2] || '').trim();
          const directJid = `${directNumber}@s.whatsapp.net`;

          if (!directMessage) {
            await safeSendMessage(phone, `⚠️ Faltó el mensaje. Formato: "dile a +${directNumber}: tu mensaje aquí"`, { isSelfChat: true });
            return;
          }

          // Verificar si el número está en familyContacts para usar su info
          const familyEntry = Object.entries(familyContacts).find(([fp]) => fp.includes(directNumber) || directNumber.includes(fp.replace(/\D/g, '')));
          const contactName = familyEntry ? familyEntry[1].name : `+${directNumber}`;
          const contactRelation = familyEntry ? familyEntry[1].relation : 'contacto';

          try {
            const ownerN = userProfile?.name || 'el owner';
            const promptDirect = `Sos MIIA. Vas a escribirle a ${contactName} (${contactRelation} de ${ownerN}).
Contexto de lo que querés hablar: "${directMessage}".

REGLAS CRÍTICAS:
- Este mensaje es TUYO, de MIIA. Hablás con TU voz, como si se te ocurrió a vos.
- PROHIBIDO TOTAL: "${ownerN} me pidió", "él quería saber", "me dijo que te pregunte", "te paso el recado".
- Máximo 3 renglones, natural y humano.
- NO repitas las palabras del contexto literalmente, reinterpretalo con tu estilo.`;
            const directMsg = await generateAIContent(promptDirect);
            if (directMsg) {
              await safeSendMessage(directJid, directMsg.trim());
              conversations[directJid] = conversations[directJid] || [];
              conversations[directJid].push({ role: 'assistant', content: directMsg.trim(), timestamp: Date.now() });
              if (!allowedLeads.includes(directJid)) allowedLeads.push(directJid);
              saveDB();
              await safeSendMessage(phone, `✅ Enviado a ${contactName}`, { isSelfChat: true, noDelay: true });
              console.log(`[DILE A] ✅ Mensaje enviado por número directo a ${contactName} (${directJid})`);
            } else {
              await safeSendMessage(phone, `❌ No pude generar el mensaje para ${contactName}.`, { isSelfChat: true });
            }
          } catch (e) {
            console.error(`[DILE A] Error enviando a ${directJid}:`, e.message);
            await safeSendMessage(phone, `❌ Error enviando a ${contactName}: ${e.message}`, { isSelfChat: true });
          }
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

          // ═══ DETECCIÓN TEMPORAL: si el mensaje implica hora futura → agendar, NO enviar ahora ═══
          // Ejemplo: "dile a ale que me espere, a las 9am mañana" → agendar recordatorio
          const temporalMatch = realMessage.match(/(?:a\s+(?:las?\s+)?(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm|hs|hrs)?.*?(mañana|pasado\s*mañana|lunes|martes|miércoles|jueves|viernes|sábado|domingo))/i);
          if (temporalMatch) {
            let hour = parseInt(temporalMatch[1]);
            const ampm = (temporalMatch[3] || '').toLowerCase();
            if (ampm === 'pm' && hour < 12) hour += 12;
            if (ampm === 'am' && hour === 12) hour = 0;
            const dayWord = temporalMatch[4].toLowerCase().trim();

            // Calcular fecha target
            const { localNow: _tNow } = getOwnerLocalNow();
            let targetDate = new Date(_tNow);
            if (dayWord === 'mañana') {
              targetDate.setDate(targetDate.getDate() + 1);
            } else if (dayWord.startsWith('pasado')) {
              targetDate.setDate(targetDate.getDate() + 2);
            } else {
              // Día de la semana
              const days = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };
              const targetDay = days[dayWord] ?? -1;
              if (targetDay >= 0) {
                const currentDay = targetDate.getDay();
                let diff = targetDay - currentDay;
                if (diff <= 0) diff += 7;
                targetDate.setDate(targetDate.getDate() + diff);
              }
            }
            targetDate.setHours(hour, parseInt(temporalMatch[2] || '0'), 0, 0);

            // Agendar como recordatorio "dile a" en vez de enviar ahora
            const dateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
            const agendaItem = {
              reason: `Enviar mensaje a ${familyInfo.name}: "${realMessage}"`,
              scheduledFor: targetDate.toISOString(),
              scheduledForLocal: `${dateStr} ${String(hour).padStart(2, '0')}:${String(parseInt(temporalMatch[2] || '0')).padStart(2, '0')}`,
              createdAt: new Date().toISOString(),
              status: 'pending',
              type: 'dile_a_programado',
              contactPhone: targetSerialized,
              contactName: familyInfo.name,
              remindContact: true,
              originalMessage: realMessage
            };
            try {
              const agendaRef = admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda');
              await agendaRef.add(agendaItem);
              console.log(`[DILE A] 📅 Mensaje programado para ${familyInfo.name} el ${dateStr} a las ${hour}:00`);
              await safeSendMessage(phone, `📅 Anotado — le escribo a ${familyInfo.name} el ${dayWord} a las ${hour}:${String(parseInt(temporalMatch[2] || '0')).padStart(2, '0')}`, { isSelfChat: true });
            } catch (agErr) {
              console.error(`[DILE A] ❌ Error agendando:`, agErr.message);
              await safeSendMessage(phone, `❌ No pude agendar el mensaje para ${familyInfo.name}: ${agErr.message}`, { isSelfChat: true });
            }
            return;
          }
          // ═══ FIN DETECCIÓN TEMPORAL — si no hay hora futura, enviar inmediato como siempre ═══

          try {
            // Sistema de stages: obtener nivel de confianza con este contacto
            const trustInfo = getAffinityToneForPrompt(targetSerialized, userProfile.name || 'el owner');
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
              toneRule = '- Es tu PRIMER contacto con esta persona. Presentate como "Hola, soy MIIA 👋, asistente de ' + (userProfile.name || 'el owner') + '". NO digas "inteligencia artificial" ni "IA". Ve al tema naturalmente.';
            } else if (stage.stage === 0 && yaConoce) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA 😊" y ve directo al tema. Amable y cálida.`;
            } else if (stage.stage === 1) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA 😊" y ve directo al tema. Tono amigable y natural.`;
            } else if (stage.stage === 2) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA ✨" y ve al tema. Tono cercano, con confianza.`;
            } else if (stage.stage >= 3) {
              toneRule = `- Empezá con "${saludo}! Acá MIIA 💕" y ve al tema. Como mejor amiga, directa, con jerga y humor.`;
            }

            const promptFamiliar = `Sos MIIA. Vas a escribirle a ${familyInfo.name} (${familyInfo.relation} de ${userProfile.name || 'el owner'}).
Contexto de lo que querés hablar: "${realMessage || 'un saludo'}".

${trustInfo}

REGLAS CRÍTICAS:
- Este mensaje es TUYO, de MIIA. Hablás con TU voz, como si se te ocurrió a vos.
- PROHIBIDO TOTAL: "${userProfile?.name || 'el owner'} me pidió", "él quería saber", "me dijo que te pregunte", "${userProfile?.name || 'el owner'} quiere que", "te paso el recado". MIIA NO es mensajera. MIIA tiene iniciativa propia.
- Máximo 3 renglones, natural y humano
- PROHIBIDO: "Estimada", "usted", "su", "le". Es FAMILIA, tono cercano.
- NO repitas las palabras del contexto literalmente, reinterpretalo con tu estilo
- Emoji: ${familyInfo.emoji || ''}
${(() => { const fp = (familyInfo.phone || basePhone || '').replace(/\D/g,''); const fc = fp.substring(0,2); if (fc === '54') return '- DIALECTO: VOS rioplatense. "contame", "decime", "mirá". Tratala de VOS.'; if (fc === '57') return '- DIALECTO: TÚ colombiano. "cuéntame", "dime". Tratala de TÚ.'; if (fc === '52') return '- DIALECTO: TÚ mexicano. "cuéntame", "platícame". Tratala de TÚ.'; if (fc === '34') return '- DIALECTO: TÚ español. "cuéntame", "dime". Expresiones: "vale", "genial".'; return '- DIALECTO: TÚ español neutro. Tratala de TÚ.'; })()}
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
              await safeSendMessage(phone, `No pude generar el mensaje para ${familyInfo.name}. Intentá de nuevo.`, { isSelfChat: true });
            }
          } catch (e) {
            console.error(`[DILE A] Error enviando a ${familyInfo.name}:`, e.message);
            await safeSendMessage(phone, `❌ Error enviando a ${familyInfo.name}: ${e.message}`, { isSelfChat: true });
          }
          return;
        }

        // Familiar no encontrado
        const nombreBuscado = words.slice(0, 2).join(' ');
        await safeSendMessage(phone, `🤔 No encontré a *"${nombreBuscado}"* en mi círculo de contactos. Verificá el nombre o agregalo.`, { isSelfChat: true });
        return;
      }
    }

    // Comando STOP
    if ((isAdmin) && effectiveMsg && effectiveMsg.toUpperCase() === 'STOP') {
      miiaPausedUntil = Date.now() + 30 * 60 * 1000;
      await safeSendMessage(phone, '*[MIIA PROTOCOLO STOP]*\nSistema detenido por 30 minutos. Responde REACTIVAR para volver.', { isSelfChat: true });
      return;
    }
    // Guardia de silencio
    if (miiaPausedUntil > Date.now()) {
      if (isAdmin && effectiveMsg && effectiveMsg.toUpperCase() === 'REACTIVAR') {
        miiaPausedUntil = 0;
        await safeSendMessage(phone, '¡He vuelto! Sistema reactivado.', { isSelfChat: true });
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
          await safeSendMessage(phone, `🔄 Affinity de *${targetName}* reseteado a Stage ${newStage} (${newAffinity} pts).`, { isSelfChat: true });
        } else {
          await safeSendMessage(phone, `❌ No encontré a "${target}" en mis contactos.`, { isSelfChat: true });
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

        // Caso 0: email en CUALQUIER posición del texto — "para hacer TEST a las 10pm a frontier.loft@gmail.com"
        const anyEmailMatch = rest.match(/([\w.-]+@[\w.-]+\.\w+)/i);
        if (anyEmailMatch) {
          targetEmail = anyEmailMatch[1];
          // El body es todo el texto EXCEPTO el email y preposiciones que lo rodean
          emailBody = rest.replace(/\s*(?:a|para|de)\s+([\w.-]+@[\w.-]+\.\w+)/i, '').trim();
          // Si el body tiene "diciendo X" o "que X", extraer solo eso
          const bodyClean = emailBody.match(/(?:diciendo|que|mensaje:?)\s+(.*)/is);
          if (bodyClean) emailBody = bodyClean[1].trim();
        }

        // Caso 1: email directo al inicio — "juan@x.com diciendo ..."
        if (!targetEmail) {
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
        } // cierre if (!targetEmail) — Caso 1/2

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
          await safeSendMessage(phone, `✅ Guardé ${selectedIndexes.length} novedad(es): ${names}`, { isSelfChat: true });
        } else {
          await safeSendMessage(phone, `🗑️ Novedades descartadas. No se guardó nada.`, { isSelfChat: true });
        }
        return;
      }
    }

    if (!isAlreadySavedParam && userMessage !== null) {
      const pmrEntry = { role: 'user', content: userMessage, timestamp: Date.now() };
      if (pendingQuotedText[phone]) { pmrEntry.quotedText = pendingQuotedText[phone]; delete pendingQuotedText[phone]; }
      conversations[phone].push(pmrEntry);
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
      const ownerNameSum = userProfile?.name || 'el owner';
      const bizNameSum = userProfile?.businessName || '';
      const contactRole = isAdmin
        ? `el dueño del sistema. Su nombre real es ${ownerNameSum}. NO uses "MIIA Owner" en tus respuestas`
        : isFamilyContact
          ? `un familiar (${familyInfo?.name || `familiar de ${ownerNameSum}`})`
          : 'un lead o cliente potencial';
      const summaryPrompt = `Eres MIIA${bizNameSum ? `, asistente de ${bizNameSum}` : ''}. Estás hablando con ${contactRole}.
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

    const history = (conversations[phone] || []).map(m => {
      const speaker = m.role === 'user' ? 'Cliente' : 'Agente';
      if (m.quotedText) return `${speaker} [respondiendo a: "${m.quotedText.substring(0, 120)}"]: ${m.content}`;
      return `${speaker}: ${m.content}`;
    }).join('\n');

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
          `${alertType} de *${contactName}* (+${phone.split('@')[0]})\n📩 "${effectiveMsg.substring(0, 200)}"\nYa respondí con empatía. Quizás quieras escribirle vos también.`,
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

    // Contexto geográfico + dialecto — aplica a TODOS los perfiles (leads, self-chat, familia, etc.)
    const countryCode = basePhone.substring(0, 2);
    const countryCode3 = basePhone.substring(0, 3);
    let countryContext = '';
    if (countryCode === '57') countryContext = '🌍 Contacto de COLOMBIA (pais:"COLOMBIA", moneda:"COP"). SIIGO/BOLD: mencionar SOLO si el contacto los trae; si tiene SIIGO + Titanium → facturador electrónico $0. 🗣️ DIALECTO: Usá TÚ (tuteo colombiano). Decí "cuéntame", "dime", "mira". NUNCA "contame", "decime", "mirá" (eso es argentino). Expresiones: "listo", "dale", "claro que sí", "con mucho gusto".';
    else if (countryCode === '52') countryContext = '🌍 Contacto de MÉXICO (pais:"MEXICO", moneda:"MXN"). IVA 16% se calcula automáticamente. PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo mexicano). Decí "cuéntame", "platícame", "mira". NUNCA "contame", "decime", "mirá" (eso es argentino). Expresiones: "órale", "sale", "claro", "con gusto".';
    else if (countryCode === '56') countryContext = '🌍 Contacto de CHILE (pais:"CHILE", moneda:"CLP"). PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo chileno). Decí "cuéntame", "dime". NUNCA "contame", "decime", "mirá" (eso es argentino). Expresiones: "dale", "ya", "perfecto".';
    else if (countryCode === '54') countryContext = '🌍 Contacto de ARGENTINA (pais:"ARGENTINA", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. Si el contacto es médico, ofrecer Receta Digital AR ($3 USD, incluirRecetaAR:true). PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá VOS (voseo rioplatense). Decí "contame", "decime", "mirá", "fijate". Expresiones: "dale", "genial", "bárbaro".';
    else if (countryCode3 === '180' || countryCode3 === '182' || countryCode3 === '184') countryContext = '🌍 Contacto de REPÚBLICA DOMINICANA (pais:"REPUBLICA_DOMINICANA", moneda:"USD"). Tiene factura electrónica (incluirFactura:true). PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo caribeño). Decí "cuéntame", "dime". NUNCA "contame" ni "decime". Expresiones: "claro", "perfecto", "con gusto".';
    else if (countryCode === '34') countryContext = '🌍 Contacto de ESPAÑA (pais:"ESPAÑA", moneda:"EUR"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo español). Decí "cuéntame", "dime", "mira". NUNCA "contame", "decime", "mirá" (eso es argentino). NUNCA usar "vos". Expresiones: "vale", "genial", "perfecto", "estupendo".';
    else countryContext = '🌍 Contacto INTERNACIONAL (pais:"INTERNACIONAL", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (español neutro). Decí "cuéntame", "dime". NUNCA "contame" ni "decime" (eso es argentino). Tono profesional neutro.';

    // Construcción del system prompt
    const leadName = leadNames[phone] || '';
    let activeSystemPrompt = '';

    // isAdmin ya fue reasignado para self-chat al inicio de processMiiaResponse (línea ~995)

    // ═══ SISTEMA MODULAR DE PROMPTS v1.0 ═══
    // Clasificador detecta intención → ensamblador carga solo módulos relevantes
    let promptMeta = null;
    if (isAdmin) {
      // ═══ FIX MIIA CENTER: El owner de MIIA CENTER es el OWNER SUPREMO ═══
      // userProfile puede estar vacío/minimal → merge con MIIA_SALES_PROFILE
      // para que el prompt tenga name, businessName, businessDescription, etc.
      const isMiiaCenterSelf = OWNER_UID === 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
      const effectiveProfile = isMiiaCenterSelf
        ? { ...MIIA_SALES_PROFILE, ...userProfile, name: userProfile.name || MIIA_SALES_PROFILE.name || 'Mariano', shortName: userProfile.shortName || 'Mariano' }
        : userProfile;

      // 🛡️ Anti-greeting: calcular si el owner interactuó recientemente
      const lastSelfChatTs = lastInteractionTime[phone] || 0;
      const msSinceLastInteraction = Date.now() - lastSelfChatTs;
      const hoursInactive = msSinceLastInteraction / (1000 * 60 * 60);
      const shouldGreet = hoursInactive >= 6; // Solo saludar si pasaron 6+ horas

      const result = assemblePrompt({
        chatType: 'selfchat',
        messageBody: userMessage,
        ownerProfile: effectiveProfile,
        context: {
          contactName: effectiveProfile.name || '',
          countryContext, // Dialecto del owner en self-chat
          affinityStage: conversationMetadata[phone]?.affinityStage,
          affinityCount: conversationMetadata[phone]?.messageCount,
          antiGreeting: !shouldGreet, // true = NO saludar (interacción reciente)
        }
      });
      activeSystemPrompt = result.prompt;
      promptMeta = result.meta;

      // ═══ MIIA CENTER OWNER SUPREMO: Inyectar acceso total ═══
      // El owner de MIIA CENTER debe tener visibilidad COMPLETA de leads, métricas, todo.
      if (isMiiaCenterSelf) {
        const totalLeads = Object.keys(contactTypes).filter(k => contactTypes[k] === 'lead' || contactTypes[k] === 'miia_lead').length;
        const totalClients = Object.keys(contactTypes).filter(k => contactTypes[k] === 'miia_client').length;
        const totalConvos = Object.keys(conversations).length;
        activeSystemPrompt += `\n\n## ACCESO OWNER SUPREMO — MIIA CENTER
Sos la MIIA principal — este es tu propio número de WhatsApp (+573054169969).
El owner (Mariano) es tu CREADOR y tiene acceso TOTAL a todo:
- ${totalLeads} leads activos, ${totalClients} clientes, ${totalConvos} conversaciones en memoria
- Toda la actividad de contactos (quién escribió, cuándo, qué dijo)
- Métricas de ventas, conversiones, respuestas
- Configuración completa del sistema
Cuando te pregunte por leads, contactos, métricas o actividad → RESPONDÉ CON DATOS CONCRETOS.
NUNCA digas "no tengo esa info", "me lo tienen guardado", "no tengo visibilidad".
Si no hay datos, decí "no hay leads registrados aún" o "ningún contacto escribió hoy".
Mariano es el CEO — NADA se le oculta. CERO restricciones de información.`;
        console.log(`[MIIA-CENTER] 🏛️ Self-chat OWNER SUPREMO: ${totalLeads} leads, ${totalClients} clients, ${totalConvos} convos inyectados`);
      }
    } else if (contactTypes[phone] === 'miia_client') {
      // ═══ CLIENTE MIIA EXISTENTE → MODO SOPORTE ═══
      if (conversationMetadata[phone]) conversationMetadata[phone].contactType = 'miia_client';
      const clientName = leadNames[phone] || pushName || 'cliente';
      console.log(`[MIIA-SUPPORT] 🏥 ${basePhone} → Cliente MIIA existente (${clientName}) — modo soporte`);

      const supportProfile = {
        ...MIIA_SALES_PROFILE,
        role: 'Soporte MIIA',
        businessProduct: `MIIA es una asistente por WhatsApp. Este contacto YA es cliente/usuario de MIIA.

## TU ROL CON ESTE CONTACTO
Sos la asistente de soporte de MIIA. Este usuario YA tiene cuenta. NO le vendas — AYUDALO.

## QUÉ HACER:
- Si tiene un problema técnico → guiarlo paso a paso
- Si no sabe cómo usar algo → explicarle con paciencia
- Si necesita algo del dashboard → indicarle dónde está (www.miia-app.com → Mi Dashboard)
- Si hay un bug → decirle "Lo reporto al equipo" y [APRENDIZAJE_NEGOCIO:Bug reportado por cliente: {descripción}]
- Si quiere cambiar de plan → www.miia-app.com/pricing
- Si quiere cancelar → ser empática, preguntar por qué, y si insiste: www.miia-app.com → Mi Cuenta → Cancelar

## RECURSOS DE AYUDA
- Centro de ayuda: www.miia-app.com/help
- Manual de usuario: www.miia-app.com/docs
- Estado del sistema: api.miia-app.com/health
- Contacto humano: mariano@miia-app.com

## TONO
Profesional, empático, resolutivo. Este usuario PAGA — merece atención premium.
NUNCA le hagas pitch de venta. NUNCA cuentes demos. Es TU cliente, no tu prospecto.`,
      };

      const result = assemblePrompt({
        chatType: 'miia_client', // Tipo propio para soporte — NO 'lead'
        messageBody: userMessage,
        ownerProfile: supportProfile,
        context: {
          contactName: clientName,
          trainingData: cerebroAbsoluto.getTrainingData() || '', // 🛡️ Inyectar conocimiento MIIA para soporte resolutivo
          countryContext,
          affinityStage: conversationMetadata[phone]?.affinityStage,
          affinityCount: conversationMetadata[phone]?.messageCount,
        }
      });
      activeSystemPrompt = result.prompt;
      promptMeta = result.meta;

    } else {
      // ═══ NÚMERO DE MIIA: desconocido → lead de MIIA ═══
      const leadOwnerProfile = MIIA_SALES_PROFILE;
      if (conversationMetadata[phone]) conversationMetadata[phone].contactType = 'miia_lead';

      // Contador de respuestas de MIIA a este lead
      const miiaResponseCount = (conversations[phone] || []).filter(m => m.role === 'assistant').length;
      console.log(`[MIIA-SALES] 🤖 ${basePhone} → Lead de MIIA (respuesta #${miiaResponseCount + 1})`);

      const result = assemblePrompt({
        chatType: 'miia_lead', // MIIA CENTER: leads pueden pedir recordatorios directos con AGENDAR_EVENTO
        messageBody: userMessage,
        ownerProfile: leadOwnerProfile,
        context: {
          contactName: leadNames[phone] || '',
          trainingData: '', // Número de MIIA: NO cargar cerebro de otro negocio
          countryContext,
          affinityStage: conversationMetadata[phone]?.affinityStage,
          affinityCount: conversationMetadata[phone]?.messageCount,
          miiaResponseCount: miiaResponseCount,
        }
      });
      activeSystemPrompt = result.prompt;
      promptMeta = result.meta;

      // Inyectar contexto de demos gratis según contador
      if (miiaResponseCount >= 10) {
        activeSystemPrompt += `\n\n## 🚨 DEMO #${miiaResponseCount + 1} — YA SE ACABARON LAS 10 GRATIS
Este lead ya usó sus 10 demos gratis. Ahora:
- Si pregunta algo, respondé BREVEMENTE (1-2 líneas) y cerrá con gracia.
- Usá tu estilo propio, con sentido común. NO copies frases textuales.
- La idea: "Ya te mostré de qué soy capaz. Si querés tenerme todos los días: www.miia-app.com — 7 días gratis."
- Si insiste sin registrarse: "Me encantaría seguir ayudándote, pero necesito que seas mi dueño/a oficial 😉 www.miia-app.com"
- Tono: amigable, segura de sí misma. MIIA es valiosa. No suplica.`;
      } else if (miiaResponseCount >= 7) {
        activeSystemPrompt += `\n\n## 💡 DEMO #${miiaResponseCount + 1} de 10 — SE ACERCAN AL FINAL
Quedan ${10 - miiaResponseCount} demos. Seguí haciendo cosas reales, pero mencioná sutilmente:
- "Esto es una demo gratis de lo que puedo hacer... quedan pocas 😉"
- NO presiones. Seguí demostrando poder real.`;
      } else {
        activeSystemPrompt += `\n\n## DEMO #${miiaResponseCount + 1} de 10
Estás en modo demo. HACÉ cosas reales (buscar, recordar, agendar, recetas, clima, deporte, etc.).
NO menciones planes, registro ni precios todavía. Solo DEMOSTRÁ tu poder con hechos.`;
      }
    }

    // ═══ PROTECCIÓN ELDERLY: Inyectar tono respetuoso si detectado ═══
    if (conversationMetadata[phone]?.protectionMode === 'elderly' && !isAdmin) {
      activeSystemPrompt += `\n\n## MODO ADULTO MAYOR ACTIVO
- Habla con MÁXIMO respeto. Usa "usted" si el contacto lo usa.
- Mensajes CORTOS (máximo 2 líneas). Nada de jerga ni tecnicismos.
- Paciencia INFINITA. Si repite algo, respondé como si fuera la primera vez.
- Si menciona salud/malestar → preguntá con cuidado: "¿Está todo bien? ¿Necesita que avise a alguien?"
- Si detectás confusión o desorientación → emití [ALERTA_OWNER:Posible confusión/desorientación de ${leadNames[phone] || 'contacto'}]
- NUNCA seas condescendiente. Tratalo con la dignidad de un adulto.`;
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
    const isLeadContact = !isAdmin; // Número de MIIA: todo no-admin es lead
    const trustTone = '\n' + getAffinityToneForPrompt(phone, userProfile.name || 'el owner', isLeadContact);

    const syntheticMemoryStr = leadSummaries[phone] ? `\n\n🧠[MEMORIA ACUMULADA DE ESTA PERSONA]:\n${leadSummaries[phone]}` : '';
    // IDENTIDAD DEL MAESTRO: solo visible en self-chat (isAdmin).
    // NUNCA incluir en conversaciones con leads — Gemini confunde "tu usuario principal"
    // con "la persona que te habla" y firma como "MIIA Owner" o "Mariano".
    const masterIdentityStr = isAdmin
      ? `\n\n[IDENTIDAD DEL MAESTRO]: Estás en self-chat con tu creador ${userProfile.name || 'el owner'}. Bríndale trato preferencial absoluto.`
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
            return `  ${modeEmoji} ${dateStr} | ${e.reason || '⚠️ SIN TÍTULO — preguntale al owner qué es'}${contact ? ` (con ${contact})` : ''}${loc}`;
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

    // ═══ INTENSAMENTE: PRE-PROCESO — Enriquecer contexto sin costo IA ═══
    let enrichedContext = '';
    try {
      const isMiiaSalesLeadPre = conversationMetadata[phone]?.contactType === 'miia_lead';
      const isMiiaClient = conversationMetadata[phone]?.contactType === 'miia_client' || contactTypes[phone] === 'miia_client';
      const chatType = isSelfChat ? 'selfchat' : isFamilyContact ? 'family' : (contactTypes[phone] === 'equipo' ? 'equipo' : (isMiiaClient ? 'miia_client' : (isMiiaSalesLeadPre ? 'miia_lead' : 'lead')));
      enrichedContext = runPreprocess({
        messageBody: effectiveMsg,
        contactPhone: phone,
        contactName: leadNames[phone] || familyContacts[basePhone]?.name || basePhone,
        agendaEvents: conversationMetadata[phone]?.agendaEvents || [],
        affinityStage: conversationMetadata[phone]?.affinityStage,
        affinityCount: conversationMetadata[phone]?.affinityCount,
        lastContactDate: conversationMetadata[phone]?.lastMessageAt,
        conversationMetadata: conversationMetadata[phone],
        isLead: chatType === 'lead' || chatType === 'miia_lead',
        leadData: conversationMetadata[phone]?.leadProfile,
        countryContext,
        kidsProfiles: typeof kidsMode !== 'undefined' && kidsMode.getKidsProfiles ? kidsMode.getKidsProfiles() : null,
        elderlyContacts: typeof elderlyContacts !== 'undefined' ? elderlyContacts : null,
        protectionLevel: conversationMetadata[phone]?.protectionLevel,
      });
      if (enrichedContext) console.log(`[PREPROCESS] ✅ Contexto enriquecido (${enrichedContext.length} chars) para ${basePhone}`);
    } catch (preErr) {
      console.error(`[PREPROCESS] ⚠️ Error (no bloquea): ${preErr.message}`);
    }

    // ═══ ACTION FEEDBACK: Inyectar resultados de acciones anteriores + reacción negativa ═══
    let feedbackContext = '';
    try {
      feedbackContext = actionFeedback.consumeFeedback(phone);
      // Detectar si el contacto reacciona negativamente a lo que MIIA dijo antes
      const lastMiiaMsg = (conversations[phone] || []).slice().reverse().find(m => m.role === 'assistant');
      const negativeHint = actionFeedback.detectNegativeReaction(effectiveMsg, lastMiiaMsg?.content);
      feedbackContext += negativeHint;
    } catch (fbErr) {
      console.error(`[ACTION-FEEDBACK] ⚠️ Error (no bloquea): ${fbErr.message}`);
    }

    // ═══ FIX GAP 2+6: Per-contact memory — cargar lo que MIIA sabe de ESTE contacto ═══
    let contactMemoryStr = '';
    if (!isSelfChat) {
      try {
        const contactId = (leadNames[phone] || basePhone).replace(/[\/\.#$\[\]]/g, '_').substring(0, 100);
        const [prefDoc, affDoc] = await Promise.all([
          admin.firestore().collection('users').doc(OWNER_UID)
            .collection('contact_preferences').doc(contactId).get().catch(() => null),
          admin.firestore().collection('users').doc(OWNER_UID)
            .collection('contact_affinities').doc(contactId).get().catch(() => null),
        ]);
        const parts = [];
        if (prefDoc?.exists) {
          const pd = prefDoc.data();
          const prefs = Object.entries(pd)
            .filter(([k]) => !['contactName', 'updatedAt', 'source', 'consolidated'].includes(k))
            .map(([k, v]) => `${k}: ${v}`);
          if (prefs.length > 0) parts.push(`Preferencias: ${prefs.join(', ')}`);
        }
        if (affDoc?.exists) {
          const ad = affDoc.data();
          const affs = Object.entries(ad)
            .filter(([k]) => !['contactName', 'updatedAt', 'source', 'consolidated'].includes(k))
            .map(([k, v]) => `${k}: ${v}`);
          if (affs.length > 0) parts.push(`Afinidades: ${affs.join(', ')}`);
        }
        if (parts.length > 0) {
          contactMemoryStr = `\n\n[LO QUE SÉ DE ${(leadNames[phone] || basePhone).toUpperCase()}]:\n${parts.join('\n')}\nUsa esta info para personalizar tu respuesta de forma natural. NO menciones que "lo tenías guardado".`;
          console.log(`[CONTACT-MEMORY] 📝 ${contactId}: ${parts.length} datos inyectados al prompt`);
        }
      } catch (memErr) {
        // Fail silently — no bloquear por esto
        console.warn(`[CONTACT-MEMORY] ⚠️ Error cargando: ${memErr.message}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // 🛡️ INTEGRITY GUARD: LEADS SUMMARY EN SELF-CHAT
    // ══════════════════════════════════════════════════════════════════
    // Inyecta resumen de leads/contactos recientes para que MIIA pueda
    // responder "¿quién escribió?", "¿cómo van los leads?", etc.
    // Sin esto, MIIA dice "no tengo visibilidad de leads" en self-chat.
    //
    // ⚠️ PROHIBIDO ELIMINAR — Sin este bloque, el owner pregunta por
    // sus leads y MIIA no sabe nada. Verificado 10-Abr-2026.
    // ══════════════════════════════════════════════════════════════════
    let leadsSummaryStr = '';
    if (isSelfChat) {
      try {
        const leadEntries = Object.entries(conversations)
          .filter(([ph]) => {
            const ct = contactTypes[ph];
            return ct === 'lead' || ct === 'miia_lead' || (!ct && ph !== phone);
          })
          .map(([ph, msgs]) => {
            const lastMsg = msgs.filter(m => m.role === 'user').slice(-1)[0];
            const lastMiia = msgs.filter(m => m.role === 'assistant').slice(-1)[0];
            const name = leadNames[ph] || ph.replace(/@.*/, '');
            const meta = conversationMetadata[ph] || {};
            const stage = meta.affinityStage ?? meta.affinity ?? '?';
            const ago = lastMsg?.timestamp ? Math.round((Date.now() - lastMsg.timestamp) / 60000) : null;
            const agoStr = ago != null ? (ago < 60 ? `hace ${ago}min` : ago < 1440 ? `hace ${Math.round(ago/60)}h` : `hace ${Math.round(ago/1440)}d`) : '';
            const preview = lastMsg?.content?.substring(0, 80) || '';
            return { name, ph, agoStr, preview, stage, lastTs: lastMsg?.timestamp || 0, totalMsgs: msgs.length, lastMiia: lastMiia?.content?.substring(0, 60) || '' };
          })
          .filter(e => e.lastTs > 0)
          .sort((a, b) => b.lastTs - a.lastTs)
          .slice(0, 10);

        if (leadEntries.length > 0) {
          const lines = leadEntries.map(e =>
            `- ${e.name} (${e.agoStr}, ${e.totalMsgs} msgs, stage ${e.stage}): "${e.preview}"`
          );
          leadsSummaryStr = `\n\n[ACTIVIDAD RECIENTE DE LEADS — ${leadEntries.length} contactos]:\n${lines.join('\n')}\nUsa esta info si te preguntan por leads, contactos, o quién escribió. NO la muestres si no la piden.`;
          console.log(`[LEADS-SUMMARY] 📊 ${leadEntries.length} leads inyectados al self-chat prompt`);
        }
      } catch (lsErr) {
        console.warn(`[LEADS-SUMMARY] ⚠️ Error (no bloquea): ${lsErr.message}`);
      }
    }

    const fullPrompt = `${activeSystemPrompt}

${helpCenterData}${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${agendaStr}${adnStr ? '\n\n[ADN VENTAS — LO QUE HE APRENDIDO DE CONVERSACIONES REALES]:\n' + adnStr : ''}${contactMemoryStr}${enrichedContext}${feedbackContext}${leadsSummaryStr}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

    // Google Search: SIEMPRE activo en número de MIIA (ventas)
    // MIIA necesita Google Search para responder CUALQUIER pregunta del lead en tiempo real
    // (clima, deportes, salud, noticias, etc.) y luego pivotar a venta
    const searchTriggered = true;
    console.log(`[GEMINI-SEARCH] 🔍 Search activo — ${isSelfChat ? 'self-chat' : isAdmin ? 'admin' : 'lead MIIA'}`);

    // ═══ AI GATEWAY — Routing inteligente por contexto ═══
    // Self-chat/Admin → Claude Opus (premium) | Familia → Gemini Flash | Leads → Gemini Flash
    // Failover automático: Gemini → OpenAI → Claude (nunca sin respuesta)
    const aiContext = isSelfChat || isAdmin
      ? aiGateway.CONTEXTS.OWNER_CHAT
      : isFamilyContact || contactTypes[phone] === 'equipo'
        ? aiGateway.CONTEXTS.FAMILY_CHAT
        : aiGateway.CONTEXTS.LEAD_RESPONSE;

    // ownerConfig: aiTier/aiProvider/aiApiKey del owner (Firestore). Default = standard tier.
    const ownerAIConfig = {
      aiTier: userProfile.aiTier || 'standard',
      aiProvider: userProfile.aiProvider || null,
      aiApiKey: userProfile.aiApiKey || null,
    };

    console.log(`[MIIA] 🧠 AI Gateway: ctx=${aiContext}, tier=${ownerAIConfig.aiTier}, search=${searchTriggered} — ${basePhone}`);
    let aiMessage;
    const gwResult = await aiGateway.smartCall(aiContext, fullPrompt, ownerAIConfig, { enableSearch: searchTriggered });
    aiMessage = gwResult.text;
    if (gwResult.failedOver) console.warn(`[MIIA] 🔄 Failover activado: provider final = ${gwResult.provider} (${gwResult.latencyMs}ms)`);
    else console.log(`[MIIA] ✅ ${gwResult.provider} OK (${gwResult.latencyMs}ms), longitud: ${aiMessage?.length || 0}`);

    if (!aiMessage) {
      console.error(`[MIIA] ❌ AI Gateway: TODOS los proveedores fallaron para ${basePhone} — no se puede responder`);
      return;
    }

    // ═══ STRIP: Links de Google Search (Gemini a veces envía URLs de búsqueda literales) ═══
    // Solo para leads/familia — el owner en self-chat puede pedir links
    if (!isSelfChat && /https?:\/\/(www\.)?google\.com\/search/i.test(aiMessage)) {
      console.warn(`[MIIA] ⚠️ Strip Google Search URL de respuesta a ${basePhone}`);
      aiMessage = aiMessage.replace(/https?:\/\/(www\.)?google\.com\/search[^\s\])"]*/gi, '[búsqueda interna]');
    }

    // ═══ INTENSAMENTE v2.0: POST-PROCESO — Regex + IA Audit (100% coverage) ═══
    try {
      const isMiiaSalesLead = conversationMetadata[phone]?.contactType === 'miia_lead';
      const isMiiaClientPost = conversationMetadata[phone]?.contactType === 'miia_client' || contactTypes[phone] === 'miia_client';
      const postChatType = isSelfChat ? 'selfchat' : isFamilyContact ? 'family' : (contactTypes[phone] === 'equipo' ? 'equipo' : (isMiiaClientPost ? 'miia_client' : (isMiiaSalesLead ? 'miia_lead' : 'lead')));
      const postContactName = leadNames[phone] || familyContacts[basePhone]?.name || '';

      // PASO 1: Auditoría REGEX (instantánea, 2ms)
      const regexResult = runPostprocess(aiMessage, {
        chatType: postChatType,
        contactName: postContactName,
        contactPhone: basePhone,
        hasSearchData: searchTriggered,
        _fromMiiaCenter: true, // 🛡️ GUARDIA: server.js = MIIA CENTER, habilita miia_lead/miia_client
      });

      // Aplicar correcciones del regex (strips)
      aiMessage = regexResult.finalMessage;

      // Si regex ya vetó → manejar según tipo de veto
      if (!regexResult.approved && regexResult.action === 'veto') {
        console.error(`[POSTPROCESS:REGEX] 🚫 VETO directo: ${regexResult.vetoReason}`);
        healthMonitor.captureLog('error', `[VETO] ${phone} — ${regexResult.vetoReason}`);

        // ═══ PENALIZACIÓN AFFINITY: MIIA mintió/alucinó → -10 puntos ═══
        // PROMESA ROTA = confirmó acción sin ejecutarla. Eso es MENTIRA.
        if (regexResult.vetoReason && /PROMESA ROTA/.test(regexResult.vetoReason)) {
          penalizeAffinity(phone, 10, `PROMESA ROTA: ${regexResult.vetoReason.substring(0, 100)}`);
          console.log(`[AFFINITY] 🚨 MIIA mintió a ${basePhone} — penalización -10 pts aplicada`);
        }

        // ═══ FIX AGENDA: Si el veto es por AGENDAR_EVENTO o SOLICITAR_TURNO, extraer datos con IA y forzar el tag ═══
        const isAgendaVeto = regexResult.vetoReason && /AGENDAR_EVENTO|SOLICITAR_TURNO/.test(regexResult.vetoReason);
        if (isAgendaVeto) {
          console.log(`[AGENDA:RESCUE] 🆘 Veto por agenda detectado — intentando rescate con IA...`);
          try {
            const extractPrompt = `Extraé la información de agendamiento de este mensaje. El usuario pidió agendar algo y la IA confirmó pero no emitió el tag correcto.

MENSAJE DEL USUARIO: "${(effectiveMsg || '').substring(0, 500)}"
RESPUESTA DE LA IA: "${(aiMessage || '').substring(0, 500)}"
FECHA ACTUAL: ${new Date().toISOString()}
TIMEZONE: America/Argentina/Buenos_Aires

Respondé SOLO con JSON válido, sin markdown ni explicación:
{"fecha":"YYYY-MM-DDTHH:MM:SS","razon":"título del evento","contacto":"nombre o self"}

REGLAS:
- Si dice "mañana" calculá la fecha real desde la fecha actual
- Si dice "lunes/martes/etc" calculá la próxima ocurrencia
- Si dice "a las 5" o "5pm" → 17:00. Si dice "5am" → 05:00
- Si no hay hora específica, usá 10:00 como default
- "razon" es un título corto: "Reunión con X", "Turno médico", etc.
- "contacto" es "self" si es para el owner, o el nombre del contacto
- Si NO hay suficiente info para agendar, respondé: {"error":"no hay datos suficientes"}`;

            const extractResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, extractPrompt, ownerAIConfig);
            const extractText = extractResult.text || '';
            const jsonMatch = extractText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const extracted = JSON.parse(jsonMatch[0]);
              if (extracted.fecha && !extracted.error) {
                // Si es lead regular, usar SOLICITAR_TURNO (requiere aprobación). miia_lead y owner usan AGENDAR_EVENTO directo.
                const isLeadContext = postChatType === 'lead'; // lead regular (NO miia_lead)
                const tagName = isLeadContext ? 'SOLICITAR_TURNO' : 'AGENDAR_EVENTO';
                const rescueTag = `[${tagName}:${extracted.contacto || 'self'}|${extracted.fecha}|${extracted.razon || 'Evento'}||presencial|]`;
                console.log(`[AGENDA:RESCUE] ✅ Tag reconstruido con IA (${tagName}): ${rescueTag}`);
                // Inyectar tag al mensaje original de MIIA (que decía "ya te agendé")
                aiMessage = rescueTag + ' ' + aiMessage;
                // NO vetar — el tag ahora existe y será procesado abajo
              } else {
                console.warn(`[AGENDA:RESCUE] ⚠️ IA no pudo extraer datos: ${extracted.error || 'sin datos'}`);
                aiMessage = 'Necesito un poco más de info para agendarte. ¿Qué día y a qué hora querés?';
              }
            } else {
              console.warn(`[AGENDA:RESCUE] ⚠️ IA no devolvió JSON válido`);
              aiMessage = 'Necesito un poco más de info para agendarte. ¿Qué día y a qué hora querés?';
            }
          } catch (rescueErr) {
            console.error(`[AGENDA:RESCUE] ❌ Error en rescate: ${rescueErr.message}`);
            aiMessage = 'Necesito un poco más de info para agendarte. ¿Qué día y a qué hora querés?';
          }
        } else {
          // Veto NO de agenda → regenerar genéricamente
          try {
            const strictHint = `\n\n⚠️ CORRECCIÓN OBLIGATORIA: Tu respuesta anterior fue rechazada porque: ${regexResult.vetoReason}. Genera una nueva respuesta COMPLETAMENTE DIFERENTE que NO cometa este error. PROHIBIDO: empezar con "¡Hola, jefe!", decir "ya agendé" sin haber agendado, inventar fechas o eventos. Si no puedes confirmar una acción, di "dejame verificar". Si no tienes datos exactos, di "no encontré el dato preciso". Respuesta máximo 2 oraciones, directa, sin preámbulos.`;
            const regenResult = await aiGateway.smartCall(aiContext, fullPrompt + strictHint, ownerAIConfig, { enableSearch: searchTriggered });
            aiMessage = regenResult.text;
            const recheck = runPostprocess(aiMessage || '', { chatType: postChatType, contactName: postContactName, hasSearchData: searchTriggered, _fromMiiaCenter: true });
            aiMessage = recheck.approved ? recheck.finalMessage : getFallbackMessage(regexResult.vetoReason, postChatType);
          } catch (regenErr) {
            console.error(`[POSTPROCESS] ❌ Error regenerando: ${regenErr.message}`);
            aiMessage = getFallbackMessage(regexResult.vetoReason, postChatType);
          }
        }
      }

      // PASO 2: Auditoría IA con Gemini Flash (100% de los mensajes, ~1-2s)
      // Se ejecuta SIEMPRE, incluso si regex aprobó — atrapa lo que regex no puede
      const aiAuditResult = await runAIAudit(aiMessage, {
        chatType: postChatType,
        contactName: postContactName,
        hasSearchData: searchTriggered,
        userMessage: effectiveMsg,
        generateAI: (prompt) => aiGateway.smartCall(aiGateway.CONTEXTS.AUDITOR, prompt, ownerAIConfig).then(r => r.text),
      });

      if (!aiAuditResult.approved) {
        if (aiAuditResult.action === 'veto') {
          console.error(`[POSTPROCESS:AI] 🚫 VETO por auditor IA: ${aiAuditResult.issues.join('; ')}`);
          healthMonitor.captureLog('error', `[VETO] ${phone} — AI: ${aiAuditResult.issues.join('; ')}`);
          // Regenerar con hint del auditor IA
          try {
            const aiHint = `\n\n⚠️ CORRECCIÓN DEL AUDITOR DE CALIDAD: ${aiAuditResult.issues.join('. ')}. Corregí estos problemas en tu nueva respuesta.`;
            const auditRegenResult = await aiGateway.smartCall(aiContext, fullPrompt + aiHint, ownerAIConfig, { enableSearch: searchTriggered });
            aiMessage = auditRegenResult.text;
            // Re-verificar con regex — si TAMBIÉN falla, usar fallback seguro (NUNCA enviar mensaje vetado)
            const finalCheck = runPostprocess(aiMessage || '', { chatType: postChatType, contactName: postContactName, hasSearchData: searchTriggered, _fromMiiaCenter: true });
            if (!finalCheck.approved && finalCheck.action === 'veto') {
              console.error(`[POSTPROCESS:AI] 🚫 Regeneración del auditor TAMBIÉN vetada por regex: ${finalCheck.vetoReason} — usando fallback seguro`);
              aiMessage = getFallbackMessage(finalCheck.vetoReason, postChatType);
            } else {
              aiMessage = finalCheck.finalMessage;
              console.log(`[POSTPROCESS:AI] 🔄 Regeneración por auditor IA completada — regex: ${finalCheck.approved ? 'OK' : 'warnings'}`);
            }
          } catch (regenErr) {
            console.error(`[POSTPROCESS:AI] ❌ Error regenerando: ${regenErr.message}`);
            aiMessage = getFallbackMessage('AUDITOR_IA: ' + aiAuditResult.issues.join('; '), postChatType);
          }
        } else if (aiAuditResult.action === 'regenerate') {
          console.warn(`[POSTPROCESS:AI] 🔄 Auditor IA recomienda regenerar: ${aiAuditResult.issues.join('; ')}`);
          try {
            // Si el issue es "inventa datos fácticos" → FORZAR google_search con Gemini
            const isFactualIssue = aiAuditResult.issues.some(i => /invent|fáctic|dato|fact/i.test(i));
            const aiHint = `\n\n⚠️ MEJORA REQUERIDA: ${aiAuditResult.issues.join('. ')}. Mejorá tu respuesta corrigiendo estos puntos.${isFactualIssue ? ' OBLIGATORIO: Usá Google Search para verificar datos antes de responder. NO inventes datos que no hayas buscado.' : ''}`;
            // Forzar search=true cuando es issue factual, y preferir gemini (tiene google_search nativo)
            const regenOpts = { enableSearch: true };
            if (isFactualIssue) {
              regenOpts.forceProvider = 'gemini'; // Gemini tiene google_search gratis
              console.log(`[POSTPROCESS:AI] 🔍 Forzando regeneración con Gemini + google_search (issue factual)`);
            }
            const improveResult = await aiGateway.smartCall(aiContext, fullPrompt + aiHint, ownerAIConfig, regenOpts);
            aiMessage = improveResult.text;
            // Re-verificar con regex — si TAMBIÉN falla, usar fallback seguro (NUNCA enviar mensaje vetado)
            const finalCheck = runPostprocess(aiMessage || '', { chatType: postChatType, contactName: postContactName, hasSearchData: searchTriggered, _fromMiiaCenter: true });
            if (!finalCheck.approved && finalCheck.action === 'veto') {
              console.error(`[POSTPROCESS:AI] 🚫 Mejora del auditor TAMBIÉN vetada por regex: ${finalCheck.vetoReason} — usando fallback seguro`);
              aiMessage = getFallbackMessage(finalCheck.vetoReason, postChatType);
            } else {
              aiMessage = finalCheck.finalMessage;
              console.log(`[POSTPROCESS:AI] 🔄 Mejora por auditor IA completada — regex: ${finalCheck.approved ? 'OK' : 'warnings'}`);
            }
          } catch (regenErr) {
            // Si falla la regeneración, enviar el original (ya pasó regex)
            console.warn(`[POSTPROCESS:AI] ⚠️ Regeneración falló, enviando original: ${regenErr.message}`);
          }
        }
        // minor → solo logear, no bloquear (ya se logeó arriba)
      }

    } catch (postErr) {
      console.error(`[POSTPROCESS] ⚠️ Error en auditoría (no bloquea): ${postErr.message}`);
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
    // ── TAG [ENVIAR_PLAN:X] — Envía imagen de plan al lead (interno, NUNCA visible) ──
    {
      const { cleanText, plans } = outreachEngine.extractPlanTags(aiMessage);
      if (plans.length > 0) {
        aiMessage = cleanText;
        // Enviar imágenes de plan en background (no bloquear la respuesta de texto)
        for (const planKey of plans) {
          sendPlanImage(phone, planKey).catch(e => {
            console.error(`[PLAN-IMAGE] ⚠️ Error enviando plan "${planKey}" a ${phone}:`, e.message);
          });
        }
      }
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

    // ═══ RED DE SEGURIDAD: Instrucciones del owner que Gemini no capturó con tags ═══
    // Si es selfchat del admin, el mensaje original tiene patrón de instrucción,
    // y Gemini NO emitió ningún tag de aprendizaje → guardarlo automáticamente
    if (isAdmin && isSelfChat && effectiveMsg) {
      const hadLearningTag = /\[(APRENDIZAJE_NEGOCIO|APRENDIZAJE_PERSONAL|APRENDIZAJE_DUDOSO|GUARDAR_APRENDIZAJE):/.test(aiMessage || learnCleanMsg || '');
      if (!hadLearningTag) {
        const instructionPatterns = /\b(siempre deb[eé]s|nunca deb[eé]s|aprend[eé] que|record[aá] que|de ahora en m[aá]s|a partir de ahora|cuando un lead|cuando alguien|tu prioridad es|quiero que|necesito que|no vuelvas a|dej[aá] de|empez[aá] a|cambi[aá] tu|tu tono debe|habl[aá] m[aá]s|se[aá] m[aá]s|cada lead es|todos los leads)\b/i;
        if (instructionPatterns.test(effectiveMsg)) {
          const instruction = effectiveMsg.substring(0, 500).trim();
          try {
            if (adminCallbacks.saveBusinessLearning) {
              await adminCallbacks.saveBusinessLearning(OWNER_UID, instruction, 'SERVER_SAFETY_NET');
              console.log(`[LEARNING:SAFETY-NET] 🛡️ Instrucción del owner guardada automáticamente (Gemini no emitió tag): "${instruction.substring(0, 80)}..."`);
            }
          } catch (e) {
            console.error(`[LEARNING:SAFETY-NET] ❌ Error guardando:`, e.message);
          }
        }
      }
    }

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

    // ── TAG [ENVIAR_CORREO:email|asunto|cuerpo] — MIIA envía email al lead via Gmail API / SMTP ──
    const enviarCorreoMatch = aiMessage.match(/\[ENVIAR_CORREO:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (enviarCorreoMatch) {
      const emailTo = enviarCorreoMatch[1].trim();
      const emailSubject = enviarCorreoMatch[2].trim();
      const emailBody = enviarCorreoMatch[3].trim();
      aiMessage = aiMessage.replace(/\[ENVIAR_CORREO:[^\]]+\]/g, '').trim();
      console.log(`[EMAIL] 📧 Enviando correo a ${emailTo} — Asunto: "${emailSubject}" (solicitado por lead ${phone})`);
      try {
        const emailFromName = userProfile?.businessName ? `${userProfile.businessName} - MIIA` : 'MIIA';
        let emailResult = { success: false, error: 'No configurado' };

        // Intentar Gmail API primero (si el owner tiene Google conectado)
        if (OWNER_UID) {
          try {
            const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
            if (ownerDoc.exists && ownerDoc.data()?.googleTokens) {
              emailResult = await gmailIntegration.sendGmailEmail(OWNER_UID, getOAuth2Client, emailTo, emailSubject, emailBody, emailFromName);
            }
          } catch (gmailErr) {
            console.warn(`[EMAIL] ⚠️ Gmail API send falló, intentando SMTP: ${gmailErr.message}`);
          }
        }

        // Fallback: SMTP
        if (!emailResult.success) {
          emailResult = await mailService.sendGenericEmail(emailTo, emailSubject, emailBody, { fromName: emailFromName });
        }

        if (emailResult.success) {
          console.log(`[EMAIL] ✅ Correo enviado exitosamente a ${emailTo}`);
          actionFeedback.recordActionResult(phone, 'email', true, `Email enviado a ${emailTo} — "${emailSubject}"`);
          const ownerJidEmail = getOwnerSock()?.user?.id;
          if (ownerJidEmail) {
            const ownerSelfEmail = ownerJidEmail.includes(':') ? ownerJidEmail.split(':')[0] + '@s.whatsapp.net' : ownerJidEmail;
            await safeSendMessage(ownerSelfEmail, `📧 Email enviado a *${emailTo}* — Asunto: "${emailSubject}" (lead ${basePhone})`, { isSelfChat: true });
          }
        } else {
          console.error(`[EMAIL] ❌ Error enviando correo a ${emailTo}: ${emailResult.error}`);
          actionFeedback.recordActionResult(phone, 'email', false, `Falló envío a ${emailTo}: ${emailResult.error}`);
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

    // ── TAG [ENVIAR_EMAIL:to|subject|body] — Owner envía email desde self-chat ──
    // PRIORIDAD: Gmail API (OAuth) > SMTP/emailManager
    const enviarEmailMatch = aiMessage.match(/\[ENVIAR_EMAIL:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (enviarEmailMatch && isSelfChat) {
      const emailTo = enviarEmailMatch[1].trim();
      const emailSubject = enviarEmailMatch[2].trim();
      const emailBody = enviarEmailMatch[3].trim();
      aiMessage = aiMessage.replace(/\[ENVIAR_EMAIL:[^\]]+\]/g, '').trim();
      console.log(`[EMAIL-MGR] 📧 Owner envía email a ${emailTo}: "${emailSubject}"`);
      try {
        const fromName = userProfile?.name || 'MIIA';
        let emailResult = { success: false, error: 'No configurado' };

        // Intentar Gmail API primero
        if (OWNER_UID) {
          try {
            const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
            if (ownerDoc.exists && ownerDoc.data()?.googleTokens) {
              emailResult = await gmailIntegration.sendGmailEmail(OWNER_UID, getOAuth2Client, emailTo, emailSubject, emailBody, fromName);
              if (emailResult.success) {
                console.log(`[EMAIL-MGR] ✅ Gmail API: Email enviado a ${emailTo}`);
              }
            }
          } catch (gmailSendErr) {
            console.warn(`[EMAIL-MGR] ⚠️ Gmail API send falló, intentando SMTP: ${gmailSendErr.message}`);
          }
        }

        // Fallback: SMTP via emailManager
        if (!emailResult.success) {
          emailResult = await emailManager.sendEmail(emailTo, emailSubject, emailBody, fromName);
          if (emailResult.success) {
            console.log(`[EMAIL-MGR] ✅ SMTP: Email enviado a ${emailTo}`);
          }
        }

        if (emailResult.success) {
          if (!aiMessage) aiMessage = `📧 Listo, le envié el correo a ${emailTo} — Asunto: "${emailSubject}"`;
        } else {
          console.error(`[EMAIL-MGR] ❌ Error: ${emailResult.error}`);
          if (!aiMessage) aiMessage = `❌ No pude enviar el correo a ${emailTo}: ${emailResult.error}`;
        }
      } catch (emailErr) {
        console.error(`[EMAIL-MGR] ❌ Excepción: ${emailErr.message}`);
        if (!aiMessage) aiMessage = `❌ Error enviando correo: ${emailErr.message}`;
      }
    } else if (enviarEmailMatch) {
      // Lead intentando enviar email — limpiar tag
      aiMessage = aiMessage.replace(/\[ENVIAR_EMAIL:[^\]]+\]/g, '').trim();
    }

    // ── TAG [LEER_INBOX] — Owner lee su bandeja de entrada ──
    // PRIORIDAD: Gmail API (OAuth automático) > IMAP (manual)
    if (aiMessage.includes('[LEER_INBOX]') && isSelfChat && OWNER_UID) {
      aiMessage = aiMessage.replace(/\[LEER_INBOX\]/g, '').trim();
      console.log(`[EMAIL-MGR] 📬 Owner solicita leer inbox`);
      try {
        // 🔑 INTENTAR Gmail API primero (si el owner conectó Google Calendar, ya tiene OAuth)
        let usedGmail = false;
        try {
          const ownerDoc = await admin.firestore().collection('users').doc(OWNER_UID).get();
          if (ownerDoc.exists && ownerDoc.data()?.googleTokens) {
            const gmailResult = await gmailIntegration.getUnreadEmails(OWNER_UID, getOAuth2Client, { maxResults: 10 });
            if (!gmailResult.error && gmailResult.emails.length >= 0) {
              // Convertir formato Gmail a formato emailManager para cache
              const adaptedEmails = gmailResult.emails.map(e => ({
                uid: e.id,
                fromName: e.from.replace(/<[^>]+>/, '').trim() || e.from,
                from: e.from,
                subject: e.subject,
                date: e.date,
                snippet: e.snippet,
                hasAttachments: false,
                _gmailId: e.id,
                _threadId: e.threadId,
                _source: 'gmail_api',
              }));
              emailManager.cacheEmails(OWNER_UID, adaptedEmails, { _source: 'gmail_api' });
              aiMessage = emailManager.formatEmailList(adaptedEmails, gmailResult.summary.total || adaptedEmails.length);
              usedGmail = true;
              console.log(`[EMAIL-MGR] ✅ Gmail API: ${adaptedEmails.length} emails via OAuth`);
            }
          }
        } catch (gmailErr) {
          console.warn(`[EMAIL-MGR] ⚠️ Gmail API falló, intentando IMAP: ${gmailErr.message}`);
        }

        // Fallback: IMAP manual (si no tiene Google conectado o Gmail API falló)
        if (!usedGmail) {
          const imapConfig = await emailManager.getOwnerImapConfig(OWNER_UID);
          if (!imapConfig) {
            aiMessage = '📭 Para gestionar tu correo, conectá Google Calendar desde el dashboard (Conexiones → Google). Es un solo click y MIIA accede a tu Gmail automáticamente.';
          } else {
            const result = await emailManager.fetchUnreadEmails(imapConfig, 10);
            if (result.success) {
              emailManager.cacheEmails(OWNER_UID, result.emails, imapConfig);
              aiMessage = emailManager.formatEmailList(result.emails, result.count || result.emails.length);
            } else {
              aiMessage = `❌ Error leyendo tu inbox: ${result.error}`;
            }
          }
        }
      } catch (inboxErr) {
        console.error(`[EMAIL-MGR] ❌ Excepción leyendo inbox: ${inboxErr.message}`);
        aiMessage = `❌ Error accediendo a tu correo: ${inboxErr.message}`;
      }
    }

    // ── TAG [EMAIL_LEER:2,5] — Owner lee contenido de emails específicos ──
    // PRIORIDAD: Gmail API (OAuth) > IMAP cache
    const emailLeerMatch = aiMessage.match(/\[EMAIL_LEER:([^\]]+)\]/);
    if (emailLeerMatch && isSelfChat && OWNER_UID) {
      const indices = emailLeerMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
      aiMessage = aiMessage.replace(/\[EMAIL_LEER:[^\]]+\]/g, '').trim();
      console.log(`[EMAIL-MGR] 📖 Owner quiere leer emails: ${indices.join(', ')}`);
      const cached = emailManager.getCachedEmails(OWNER_UID);
      if (!cached || !cached.emails.length) {
        aiMessage = '⚠️ No tengo emails en caché. Primero decime "leé mi inbox" o "qué correos tengo".';
      } else if (cached.imapConfig?._source === 'gmail_api') {
        // Gmail API: obtener contenido completo de cada email
        const results = [];
        for (const idx of indices) {
          const email = cached.emails[idx - 1];
          if (!email) {
            results.push(`*${idx}.* ❌ No existe ese correo en la lista`);
            continue;
          }
          try {
            const fullEmail = await gmailIntegration.getFullEmail(OWNER_UID, getOAuth2Client, email._gmailId);
            if (fullEmail.success && fullEmail.body) {
              const body = fullEmail.body.substring(0, 800).replace(/\n{3,}/g, '\n\n');
              results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${body}`);
            } else {
              // Fallback: usar snippet del cache
              results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${email.snippet || '(Sin contenido)'}`);
            }
          } catch (gmailReadErr) {
            console.warn(`[EMAIL-MGR] ⚠️ Gmail getFullEmail falló para ${email._gmailId}: ${gmailReadErr.message}`);
            results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${email.snippet || '(Sin contenido)'}`);
          }
        }
        aiMessage = results.join('\n\n---\n\n');
      } else {
        // IMAP cache: usar formatEmailContent existente
        aiMessage = emailManager.formatEmailContent(cached.emails, indices);
      }
    }

    // ── TAG [EMAIL_ELIMINAR:1,3,4] — Owner elimina emails ──
    // PRIORIDAD: Gmail API (OAuth) > IMAP
    const emailEliminarMatch = aiMessage.match(/\[EMAIL_ELIMINAR:([^\]]+)\]/);
    if (emailEliminarMatch && isSelfChat && OWNER_UID) {
      const indices = emailEliminarMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
      aiMessage = aiMessage.replace(/\[EMAIL_ELIMINAR:[^\]]+\]/g, '').trim();
      console.log(`[EMAIL-MGR] 🗑️ Owner quiere eliminar emails: ${indices.join(', ')}`);
      const cached = emailManager.getCachedEmails(OWNER_UID);
      if (!cached || !cached.emails.length) {
        aiMessage = '⚠️ No tengo emails en caché. Primero decime "leé mi inbox" para ver tus correos.';
      } else {
        if (cached.imapConfig?._source === 'gmail_api') {
          // Gmail API: usar trashEmails
          const gmailIdsToDelete = indices
            .map(i => cached.emails[i - 1]?._gmailId)
            .filter(id => id != null);
          if (gmailIdsToDelete.length === 0) {
            aiMessage = '⚠️ Los números que indicaste no corresponden a emails de la lista.';
          } else {
            try {
              const delResult = await gmailIntegration.trashEmails(OWNER_UID, getOAuth2Client, gmailIdsToDelete);
              if (delResult.success) {
                console.log(`[EMAIL-MGR] ✅ Gmail: ${delResult.deleted} emails eliminados`);
                emailManager.clearCache(OWNER_UID);
                aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Tu bandeja está más limpia ahora.`;
              } else {
                aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
              }
            } catch (delErr) {
              console.error(`[EMAIL-MGR] ❌ Gmail excepción eliminando: ${delErr.message}`);
              aiMessage = `❌ Error: ${delErr.message}`;
            }
          }
        } else {
          // IMAP fallback
          const uidsToDelete = indices
            .map(i => cached.emails[i - 1]?.uid)
            .filter(uid => uid != null);
          if (uidsToDelete.length === 0) {
            aiMessage = '⚠️ Los números que indicaste no corresponden a emails de la lista.';
          } else {
            try {
              const delResult = await emailManager.deleteEmails(cached.imapConfig, uidsToDelete);
              if (delResult.success) {
                console.log(`[EMAIL-MGR] ✅ IMAP: ${delResult.deleted} emails eliminados`);
                emailManager.clearCache(OWNER_UID);
                aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Tu bandeja está más limpia ahora.`;
              } else {
                aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
              }
            } catch (delErr) {
              console.error(`[EMAIL-MGR] ❌ IMAP excepción eliminando: ${delErr.message}`);
              aiMessage = `❌ Error: ${delErr.message}`;
            }
          }
        }
      }
    }

    // ── TAG [EMAIL_ELIMINAR_EXCEPTO:2,5] — Owner elimina todos MENOS los indicados ──
    // PRIORIDAD: Gmail API (OAuth) > IMAP
    const emailExceptoMatch = aiMessage.match(/\[EMAIL_ELIMINAR_EXCEPTO:([^\]]+)\]/);
    if (emailExceptoMatch && isSelfChat && OWNER_UID) {
      const keepIndices = emailExceptoMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
      aiMessage = aiMessage.replace(/\[EMAIL_ELIMINAR_EXCEPTO:[^\]]+\]/g, '').trim();
      console.log(`[EMAIL-MGR] 🗑️ Owner quiere eliminar todos EXCEPTO: ${keepIndices.join(', ')}`);
      const cached = emailManager.getCachedEmails(OWNER_UID);
      if (!cached || !cached.emails.length) {
        aiMessage = '⚠️ No tengo emails en caché. Primero decime "leé mi inbox".';
      } else if (cached.imapConfig?._source === 'gmail_api') {
        // Gmail API: usar trashEmails
        const gmailIdsToDelete = cached.emails
          .map((e, i) => ({ gmailId: e._gmailId, index: i + 1 }))
          .filter(e => !keepIndices.includes(e.index))
          .map(e => e.gmailId)
          .filter(id => id != null);
        if (gmailIdsToDelete.length === 0) {
          aiMessage = '✅ No hay emails para eliminar — todos están en la lista de conservar.';
        } else {
          try {
            const delResult = await gmailIntegration.trashEmails(OWNER_UID, getOAuth2Client, gmailIdsToDelete);
            if (delResult.success) {
              console.log(`[EMAIL-MGR] ✅ Gmail: ${delResult.deleted} emails eliminados (conservando ${keepIndices.join(', ')})`);
              emailManager.clearCache(OWNER_UID);
              aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Conservé los que pediste (${keepIndices.join(', ')}).`;
            } else {
              aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
            }
          } catch (delErr) {
            console.error(`[EMAIL-MGR] ❌ Gmail excepción eliminando: ${delErr.message}`);
            aiMessage = `❌ Error: ${delErr.message}`;
          }
        }
      } else {
        // IMAP fallback
        const uidsToDelete = cached.emails
          .map((e, i) => ({ uid: e.uid, index: i + 1 }))
          .filter(e => !keepIndices.includes(e.index))
          .map(e => e.uid)
          .filter(uid => uid != null);
        if (uidsToDelete.length === 0) {
          aiMessage = '✅ No hay emails para eliminar — todos están en la lista de conservar.';
        } else {
          try {
            const delResult = await emailManager.deleteEmails(cached.imapConfig, uidsToDelete);
            if (delResult.success) {
              console.log(`[EMAIL-MGR] ✅ IMAP: ${delResult.deleted} emails eliminados (conservando ${keepIndices.join(', ')})`);
              emailManager.clearCache(OWNER_UID);
              aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Conservé los que pediste (${keepIndices.join(', ')}).`;
            } else {
              aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
            }
          } catch (delErr) {
            console.error(`[EMAIL-MGR] ❌ IMAP excepción eliminando: ${delErr.message}`);
            aiMessage = `❌ Error: ${delErr.message}`;
          }
        }
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

    // ── TAG [MENSAJE_PARA_OWNER:mensaje] — Contacto dice "dile a Mariano que..." ──
    const msgOwnerMatch = aiMessage.match(/\[MENSAJE_PARA_OWNER:([^\]]+)\]/);
    if (msgOwnerMatch) {
      const msgForOwner = msgOwnerMatch[1].trim();
      aiMessage = aiMessage.replace(/\[MENSAJE_PARA_OWNER:[^\]]+\]/g, '').trim();
      const contactName = leadNames[phone] || basePhone;
      console.log(`[DILE-A] 📩 ${contactName} (${basePhone}) → Owner: "${msgForOwner}"`);
      const ownerJidMsg = getOwnerSock()?.user?.id;
      if (ownerJidMsg) {
        const ownerSelfMsg = ownerJidMsg.includes(':') ? ownerJidMsg.split(':')[0] + '@s.whatsapp.net' : ownerJidMsg;
        await safeSendMessage(ownerSelfMsg, `📩 *${contactName}* te dice:\n"${msgForOwner}"`, { isSelfChat: true });
      }
    }

    // ── TAG [RECORDAR_OWNER:fecha|mensaje] — Contacto dice "recuérdale a Mariano que..." ──
    const recordOwnerMatch = aiMessage.match(/\[RECORDAR_OWNER:([^|]+)\|([^\]]+)\]/);
    if (recordOwnerMatch) {
      const recordFecha = recordOwnerMatch[1].trim();
      const recordMsg = recordOwnerMatch[2].trim();
      aiMessage = aiMessage.replace(/\[RECORDAR_OWNER:[^\]]+\]/g, '').trim();
      const contactName = leadNames[phone] || basePhone;
      console.log(`[RECORDAR] ⏰ ${contactName} quiere recordar al owner: "${recordMsg}" → ${recordFecha}`);
      // Agendar usando el sistema de agenda existente (miia_agenda en Firestore)
      if (OWNER_UID) {
        try {
          const agendaRef = admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda');
          // FIX: Incluir notifyPhone del owner para que el recordatorio sepa A QUIÉN enviar
          const ownerNotifyPhone = ownerConnectedPhone ? `${ownerConnectedPhone}@s.whatsapp.net` :
            (OWNER_PHONE ? `${OWNER_PHONE}@s.whatsapp.net` : null);
          await agendaRef.add({
            type: 'recordatorio_contacto',
            from: basePhone,
            fromName: contactName,
            message: recordMsg,
            scheduledFor: recordFecha,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            notifyTarget: 'owner',
            notifyPhone: ownerNotifyPhone,
            contactPhone: 'self'
          });
          console.log(`[RECORDAR] ✅ Recordatorio agendado para owner: "${recordMsg}" → ${recordFecha} → notifyPhone=${ownerNotifyPhone}`);
        } catch (e) {
          console.error(`[RECORDAR] ❌ Error agendando recordatorio:`, e.message);
        }
      }
    }

    // ── TAG [RECORDAR_CONTACTO:fecha|mensaje] — Contacto dice "recuérdame que..." ──
    const recordContactoMatch = aiMessage.match(/\[RECORDAR_CONTACTO:([^|]+)\|([^\]]+)\]/);
    if (recordContactoMatch) {
      const recordFecha = recordContactoMatch[1].trim();
      const recordMsg = recordContactoMatch[2].trim();
      aiMessage = aiMessage.replace(/\[RECORDAR_CONTACTO:[^\]]+\]/g, '').trim();
      const contactName = leadNames[phone] || basePhone;
      console.log(`[RECORDAR] ⏰ ${contactName} quiere que le recuerden: "${recordMsg}" → ${recordFecha}`);
      if (OWNER_UID) {
        try {
          const agendaRef = admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda');
          await agendaRef.add({
            type: 'recordatorio_contacto',
            from: basePhone,
            fromName: contactName,
            message: recordMsg,
            scheduledFor: recordFecha,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            notifyTarget: 'contact',
            notifyPhone: phone
          });
          console.log(`[RECORDAR] ✅ Recordatorio agendado para contacto ${contactName}: "${recordMsg}" → ${recordFecha}`);
        } catch (e) {
          console.error(`[RECORDAR] ❌ Error agendando recordatorio:`, e.message);
        }
      }
    }

    // ── TAG [CREAR_TAREA:título|fecha|notas] — MIIA crea tarea en Google Tasks ──
    const taskTag = googleTasks.parseTaskTag(aiMessage);
    if (taskTag) {
      aiMessage = aiMessage.replace(taskTag.rawTag, '').trim();
      console.log(`[TASKS-TAG] 📋 Creando tarea: "${taskTag.title}" fecha=${taskTag.dueDate}`);
      if (OWNER_UID) {
        try {
          const result = await googleTasks.createTask(OWNER_UID, getOAuth2Client, admin, {
            title: taskTag.title,
            dueDate: taskTag.dueDate,
            notes: taskTag.notes || 'Creada por MIIA'
          });
          console.log(`[TASKS-TAG] ✅ Tarea creada: id=${result.id}`);
        } catch (e) {
          console.error(`[TASKS-TAG] ❌ Error creando tarea:`, e.message);
        }
      }
    }

    // ── TAG [LISTAR_TAREAS] — MIIA lista tareas pendientes ──
    if (googleTasks.parseListTasksTag(aiMessage)) {
      aiMessage = aiMessage.replace(/\[LISTAR_TAREAS\]/g, '').trim();
      console.log(`[TASKS-TAG] 📋 Listando tareas`);
      if (OWNER_UID) {
        try {
          const tasks = await googleTasks.listTasks(OWNER_UID, getOAuth2Client, admin);
          const formattedTasks = googleTasks.formatTasksList(tasks);
          // Enviar la lista al self-chat del owner
          const ownerPhone = userProfile?.whatsapp_number || RESET_ALLOWED_PHONES[1];
          await safeSendMessage(`${ownerPhone}@s.whatsapp.net`, formattedTasks, { isSelfChat: true, skipEmoji: true });
        } catch (e) {
          console.error(`[TASKS-TAG] ❌ Error listando tareas:`, e.message);
        }
      }
    }

    // ── TAG [COMPLETAR_TAREA:título] — MIIA completa una tarea ──
    const completeTag = googleTasks.parseCompleteTaskTag(aiMessage);
    if (completeTag) {
      aiMessage = aiMessage.replace(completeTag.rawTag, '').trim();
      console.log(`[TASKS-TAG] ✅ Completando tarea: "${completeTag.titleMatch}"`);
      if (OWNER_UID) {
        try {
          await googleTasks.completeTask(OWNER_UID, getOAuth2Client, admin, { titleMatch: completeTag.titleMatch });
        } catch (e) {
          console.error(`[TASKS-TAG] ❌ Error completando tarea:`, e.message);
        }
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
          // VALIDACIÓN SERVER-SIDE: Forzar moneda correcta según país del lead
          // La IA a veces ignora el mapping y pone USD para todos
          const PAIS_MONEDA_MAP = {
            'COLOMBIA': 'COP', 'CHILE': 'CLP', 'MEXICO': 'MXN',
            'ESPAÑA': 'EUR', 'ESPANA': 'EUR',
            'REPUBLICA_DOMINICANA': 'USD', 'ARGENTINA': 'USD', 'INTERNACIONAL': 'USD',
          };
          // Auto-detectar país por prefijo telefónico del lead si la IA no lo puso bien
          if (!cotizData.pais || cotizData.pais === 'INTERNACIONAL') {
            const leadPrefix = basePhone.substring(0, 4);
            if (leadPrefix.startsWith('57')) cotizData.pais = 'COLOMBIA';
            else if (leadPrefix.startsWith('56')) cotizData.pais = 'CHILE';
            else if (leadPrefix.startsWith('52')) cotizData.pais = 'MEXICO';
            else if (leadPrefix.startsWith('54')) cotizData.pais = 'ARGENTINA';
            else if (leadPrefix.startsWith('34')) cotizData.pais = 'ESPAÑA';
            else if (/^1(809|829|849)/.test(basePhone)) cotizData.pais = 'REPUBLICA_DOMINICANA';
          }
          const expectedMoneda = PAIS_MONEDA_MAP[cotizData.pais];
          if (expectedMoneda && cotizData.moneda !== expectedMoneda) {
            console.warn(`[COTIZ-FIX] ⚠️ Moneda incorrecta: IA dijo ${cotizData.moneda} para ${cotizData.pais}. Forzando ${expectedMoneda}.`);
            cotizData.moneda = expectedMoneda;
          }
          // España/EUR → SOLO modalidad anual (server-side enforcement)
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
                cotizData.ownerName  = od.name  || od.displayName || 'Asesor';
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
          actionFeedback.recordActionResult(phone, 'cotizacion', true, `Cotización PDF generada y enviada`);
        } catch (e) {
          console.error('[COTIZ] Error PDF:', e.message);
          actionFeedback.recordActionResult(phone, 'cotizacion', false, `Error generando PDF: ${e.message}`);
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

    // ═══ NEGOCIACIÓN: "Consultar con gerencia" — delay dramático ═══
    // Tag: [NEGOCIAR_DELAY:minutos|mensaje_al_volver]
    const negociarMatch = aiMessage.match(/\[NEGOCIAR_DELAY:(\d+)\|([^\]]+)\]/);
    if (negociarMatch) {
      const delayMinutos = Math.min(parseInt(negociarMatch[1]) || 4, 6); // Máx 6 minutos
      const mensajeAlVolver = negociarMatch[2];
      console.log(`[NEGOCIACION] ⏳ Delay de ${delayMinutos}min para ${basePhone} — volverá con: "${mensajeAlVolver.substring(0, 80)}..."`);
      // Limpiar el tag del mensaje que se envía ahora
      aiMessage = aiMessage.replace(/\[NEGOCIAR_DELAY:[^\]]+\]/, '').trim();
      // Programar el mensaje de "vuelta de gerencia" con delay
      const delayMs = delayMinutos * 60 * 1000 + Math.floor(Math.random() * 30000); // +0-30s aleatorio
      setTimeout(async () => {
        try {
          console.log(`[NEGOCIACION] 🔔 Enviando respuesta post-delay a ${basePhone}: "${mensajeAlVolver.substring(0, 80)}..."`);
          await safeSendMessage(phone, mensajeAlVolver, { isSelfChat });
          // Si el mensaje contiene un tag de cotización, procesarlo
          if (mensajeAlVolver.includes('[GENERAR_COTIZACION_PDF:')) {
            // Re-procesar como si fuera una nueva respuesta de MIIA
            await processMiiaResponse(phone, null, true);
          }
        } catch (e) {
          console.error(`[NEGOCIACION] ❌ Error en delay para ${basePhone}:`, e.message);
        }
      }, delayMs);
    }

    // ═══ BONUS USUARIOS: Consulta al owner ═══
    // Tag: [CONSULTAR_OWNER_BONUS:lead_name|usuarios|bonus_sugerido]
    const bonusMatch = aiMessage.match(/\[CONSULTAR_OWNER_BONUS:([^|]+)\|(\d+)\|(\d+)\]/);
    if (bonusMatch && OWNER_UID) {
      const [, leadName, leadUsuarios, bonusSugerido] = bonusMatch;
      const ownerSelf = `${OWNER_PHONE}@s.whatsapp.net`;
      console.log(`[NEGOCIACION] 🎁 Consultando al owner sobre ${bonusSugerido} usuarios bonus para ${leadName} (${leadUsuarios} usuarios)`);
      safeSendMessage(ownerSelf,
        `🎁 *Consulta de MIIA — Usuarios Bonus*\n\n` +
        `El lead *${leadName}* (${basePhone}) pidió ${leadUsuarios} usuarios.\n` +
        `MIIA sugiere regalarle *${bonusSugerido} usuarios médicos extra* para cerrar la venta.\n\n` +
        `¿Aprobás?\n` +
        `• *sí* o *dale* → MIIA le ofrece los ${bonusSugerido} extras\n` +
        `• *no* → MIIA sigue sin bonus`,
        { isSelfChat: true, skipEmoji: true }
      ).catch(() => {});
      aiMessage = aiMessage.replace(/\[CONSULTAR_OWNER_BONUS:[^\]]+\]/, '').trim();
    }

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
          // TODOS los recordatorios van a Calendar — MIIA CENTER usa su propio calendar (hola@miia-app.com)
          const isMiiaCenterCalendar = postChatType === 'miia_lead';
          if (isMiiaCenterCalendar) {
            console.log(`[AGENDA:MIIA-CENTER] 📅 Recordatorio para lead ${basePhone} → Google Calendar + Firestore`);
          }
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
              actionFeedback.recordActionResult(phone, 'agendar', true, `"${razon}" agendado el ${fecha} para ${contactName} — Calendar OK`);

              // CAPA 4: Verificar asíncronamente que el evento realmente existe en Calendar
              verifyCalendarEvent(
                async (uid, dateStr) => {
                  try {
                    const calClient = await getCalendarClient(uid);
                    if (!calClient) return [];
                    const res = await calClient.events.list({
                      calendarId: userProfile.googleCalendarId || 'primary',
                      timeMin: new Date(dateStr + 'T00:00:00').toISOString(),
                      timeMax: new Date(dateStr + 'T23:59:59').toISOString(),
                      maxResults: 20, singleEvents: true, orderBy: 'startTime',
                    });
                    return (res.data.items || []).map(e => ({ summary: e.summary }));
                  } catch { return []; }
                },
                OWNER_UID, fecha.split('T')[0], razon
              ).then(verified => {
                if (!verified) console.error(`[INTEGRITY:VERIFY] ❌ Evento "${razon}" NO confirmado en Calendar post-creación`);
              }).catch(() => {});
            }
          } catch (calErr) {
            console.warn(`[AGENDA] ⚠️ Google Calendar no disponible: ${calErr.message}. Guardando en Firestore.`);
            actionFeedback.recordActionResult(phone, 'agendar', true, `"${razon}" guardado en Firestore (Calendar no conectado)`);

            // ═══ FIX: Informar al owner CÓMO resolver (sentido común) ═══
            if (/no conectado|no tokens|googleTokens/i.test(calErr.message)) {
              try {
                await safeSendMessage(ownerJid,
                  `⚠️ *Google Calendar no está conectado*\n\n` +
                  `Agendé "${razon}" el ${fecha} en mi base de datos, pero NO pude sincronizarlo con tu Google Calendar.\n\n` +
                  `👉 Para conectarlo, andá a tu *Dashboard → Conexiones → Google Calendar* y aprobá los permisos.\n` +
                  `Una vez conectado, todos tus eventos se sincronizan automáticamente. 📅`,
                  {}
                );
              } catch (_) {}
            }
          }

          // ═══ MIIA CENTER LEAD REMINDER: usar timezone del LEAD, no del owner ═══
          const isMiiaCenterLeadReminder = postChatType === 'miia_lead';
          const tzSourcePhone = isMiiaCenterLeadReminder ? basePhone : OWNER_PHONE;
          const tzCountry = getCountryFromPhone(tzSourcePhone);
          const effectiveTimezone = getTimezoneForCountry(tzCountry);
          if (isMiiaCenterLeadReminder) {
            console.log(`[AGENDA:MIIA-CENTER] 🌍 Lead ${basePhone} → país=${tzCountry}, timezone=${effectiveTimezone}`);
          }

          // 2. Guardar en Firestore
          try {

            let scheduledForUTC = fecha;
            try {
              const parsedLocal = new Date(fecha);
              if (!isNaN(parsedLocal)) {
                const localStr = new Date().toLocaleString('en-US', { timeZone: effectiveTimezone });
                const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
                const offsetMs = new Date(localStr) - new Date(utcStr);
                const utcDate = new Date(parsedLocal.getTime() - offsetMs);
                scheduledForUTC = utcDate.toISOString();
                console.log(`[AGENDA] 🕐 Fecha local: ${fecha} (${effectiveTimezone}) → UTC: ${scheduledForUTC}`);
              }
            } catch (tzErr) {
              console.warn(`[AGENDA] ⚠️ Error convirtiendo timezone, usando fecha original: ${tzErr.message}`);
            }
            // FIX P-CALENDAR-QUALITY: Si el contacto es un teléfono externo (no "self"),
            // Y la razón incluye palabras de recordatorio/aviso al contacto → remindContact = true
            // Esto permite que "recuérdale a +5491164431700 comprar medicación" FUNCIONE
            const isExternalContact = contacto && contacto !== 'self' && /^\d{8,15}$/.test(contacto.replace(/\D/g, ''));
            const isReminderForContact = /recor|avisa|escri|manda|notific|dile|decile|avisale|recordale|escribile/i.test(razon || '');
            // MIIA CENTER leads: SIEMPRE remindContact=true (el recordatorio es PARA el lead)
            const shouldRemindContact = isMiiaCenterLeadReminder || isExternalContact || (!isSelfChat && isReminderForContact);
            if (shouldRemindContact) {
              console.log(`[AGENDA] 📲 remindContact=true para ${contacto}${isMiiaCenterLeadReminder ? ' (MIIA CENTER lead)' : ''} — razón: "${(razon || '').substring(0, 50)}"`);
            }

            // FIX: Si contacto no es un teléfono válido (ej: "Mariano", "Cliente"), usar el phone real del chat
            const resolvedContactPhone = isExternalContact ? contacto :
              (isSelfChat ? 'self' : (basePhone || phone || contacto));
            const resolvedContactName = isSelfChat && !isExternalContact ? (userProfile.name || 'el owner') :
              (contactName || leadNames[`${basePhone}@s.whatsapp.net`] || contacto);

            await admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda').add({
              contactPhone: resolvedContactPhone,
              contactName: resolvedContactName,
              mentionedContact: contacto,
              scheduledFor: scheduledForUTC,
              scheduledForLocal: fecha,
              ownerTimezone: effectiveTimezone,
              leadTimezone: isMiiaCenterLeadReminder ? effectiveTimezone : undefined,
              leadCountry: isMiiaCenterLeadReminder ? tzCountry : undefined,
              reason: razon,
              promptHint: hint || '',
              eventMode: eventMode,
              eventLocation: ubicacion || '',
              meetLink: meetLink || '',
              status: 'pending',
              calendarSynced: calendarOk,
              remindContact: shouldRemindContact,
              reminderMinutes: 10,
              requestedBy: phone,
              searchBefore: (razon || '').toLowerCase().includes('deporte') || (razon || '').toLowerCase().includes('partido'),
              createdAt: new Date().toISOString(),
              source: isMiiaCenterLeadReminder ? 'miia_center_lead' : (isSelfChat ? 'owner_selfchat' : 'contact_request')
            });
          } catch (e) {
            console.error(`[AGENDA] ❌ Error guardando en Firestore:`, e.message);
            actionFeedback.recordActionResult(phone, 'agendar', false, `Error guardando "${razon}" en Firestore: ${e.message}`);
          }

          // 3. Notificar al owner (generado por IA cuando sea posible, fallback contextual)
          if (!isSelfChat) {
            const leadNameNotif = leadNames[phone] || contactName || basePhone;
            const calStatus = calendarOk ? '📅 Calendar ✅' : '⚠️ Calendar no conectado';
            // Notificación contextual al owner — NO hardcodeada, construida con datos reales
            const notifParts = [];
            if (isMiiaCenterLeadReminder) {
              notifParts.push(`📲 *${leadNameNotif}* pidió un recordatorio:`);
              notifParts.push(`"${razon}"`);
              notifParts.push(`📅 ${fecha} | 🌍 ${tzCountry} (${effectiveTimezone})`);
              notifParts.push(calStatus);
            } else {
              notifParts.push(`📅 *${contactName}* pidió agendar:`);
              notifParts.push(`"${razon}" — ${fecha}`);
              const modeLabel = eventMode === 'virtual' ? '📹 Virtual' : (eventMode === 'telefono' || eventMode === 'telefónico') ? '📞 Telefónico' : '📍 Presencial';
              notifParts.push(`Modo: ${modeLabel}${ubicacion ? ` — ${ubicacion}` : ''}`);
              notifParts.push(calStatus);
            }
            if (!calendarOk) {
              notifParts.push(`\n💡 Conectá tu Calendar desde Dashboard → Conexiones.`);
            }
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, notifParts.join('\n'), { isSelfChat: true }).catch(() => {});
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
            actionFeedback.recordActionResult(phone, 'turno', true, `Solicitud de turno enviada al owner: "${razon}" el ${fecha}`);
          } catch (e) {
            console.error(`[SOLICITAR_TURNO] ❌ Error guardando solicitud:`, e.message);
            actionFeedback.recordActionResult(phone, 'turno', false, `Error creando solicitud de turno: ${e.message}`);
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
            return `  ${modeEmoji} ${dateLocal} | ${e.reason || '⚠️ SIN TÍTULO — preguntale al owner qué es'} | ${modeLabel}${contact && contact !== 'self' ? ` con ${contact}` : ''}${loc}${meetInfo}`;
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
                return `  📅 ${startFormatted} | ${ev.summary || '⚠️ SIN TÍTULO — preguntale al owner qué es'}${meetLink ? ` (Meet: ${meetLink})` : ''}`;
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

    // ═══ TAG [CANCELAR_EVENTO] / [ELIMINAR_EVENTO] (alias) — Cancelar evento del owner ═══
    // [ELIMINAR_EVENTO] es un tag inventado por la IA a veces — tratarlo como CANCELAR
    // modo: avisar (default) | reagendar | silencioso
    //   avisar    → cancela + notifica al contacto que fue cancelado
    //   reagendar → cancela + MIIA pregunta al contacto cuándo puede reagendar
    //   silencioso → cancela sin notificar al contacto
    aiMessage = aiMessage.replace(/\[ELIMINAR_EVENTO:/g, '[CANCELAR_EVENTO:');
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
          actionFeedback.recordActionResult(phone, 'cancelar', true, `"${found.data.reason}" del ${found.data.scheduledForLocal} cancelado (modo=${mode})`);

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
          actionFeedback.recordActionResult(phone, 'cancelar', false, `No se encontró evento "${searchReason}" para cancelar`);
        }
      } catch (e) {
        console.error(`[CANCELAR_EVENTO] ❌ Error:`, e.message);
        actionFeedback.recordActionResult(phone, 'cancelar', false, `Error cancelando: ${e.message}`);
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
          actionFeedback.recordActionResult(phone, 'mover', true, `"${found.data.reason}" movido de ${found.data.scheduledForLocal} a ${newDate}`);

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
          actionFeedback.recordActionResult(phone, 'mover', false, `No se encontró evento "${searchReason}" para mover`);
        }
      } catch (e) {
        console.error(`[MOVER_EVENTO] ❌ Error:`, e.message);
        actionFeedback.recordActionResult(phone, 'mover', false, `Error moviendo evento: ${e.message}`);
      }
      aiMessage = aiMessage.replace(/\[MOVER_EVENTO:[^\]]+\]/g, '').trim();
    }

    // ═══ TAG [RESPONDELE:destinatario|instrucción] — MIIA envía mensaje a contacto por orden del owner ═══
    const respondeleTagMatch = aiMessage.match(/\[RESPONDELE:([^\]]+)\]/);
    if (respondeleTagMatch && isSelfChat) {
      const tagParts = respondeleTagMatch[1].split('|').map(p => p.trim());
      const destinatario = tagParts[0] || '';
      const instruccion = tagParts[1] || 'responder profesionalmente';
      console.log(`[RESPONDELE-TAG] 📨 Tag detectado: destino="${destinatario}", instrucción="${instruccion}"`);

      try {
        let contactJid = null;
        let leadPhone = '';

        // 1. Si es un número directo
        const phoneDigits = destinatario.replace(/[^0-9]/g, '');
        if (phoneDigits.length >= 10) {
          leadPhone = phoneDigits;
          contactJid = `${leadPhone}@s.whatsapp.net`;
          console.log(`[RESPONDELE-TAG] 📱 Número directo: ${contactJid}`);
        }

        // 2. Si es "último_contacto" → buscar última alerta
        if (!contactJid && /^[uú]ltimo|^last|^reciente/i.test(destinatario)) {
          const twoHoursAgo = Date.now() - 7200000;
          const recentMsgs = (conversations[phone] || []).slice(-20).filter(m => !m.timestamp || m.timestamp > twoHoursAgo);
          const alertMsg = recentMsgs.find(m => m.role === 'assistant' && (/Nuevo mensaje/.test(m.content) || /Alguien te escribi[oó]/.test(m.content)));
          if (alertMsg) {
            contactJid = alertMsg._contactJid || null;
            if (contactJid) leadPhone = contactJid.split('@')[0];
            if (!contactJid) {
              const pm = alertMsg.content.match(/(?:Número:\s*\+?|Contacto:.*?\(\+?)(\d{10,18})/);
              if (pm) { leadPhone = pm[1]; contactJid = `${leadPhone}@s.whatsapp.net`; }
            }
          }
          if (contactJid) console.log(`[RESPONDELE-TAG] 🎯 Último contacto: ${contactJid}`);
        }

        // 3. Si es un nombre → buscar en contactos registrados (familia, equipo, grupos) + conversaciones
        if (!contactJid && destinatario.length >= 2) {
          const destLower = destinatario.toLowerCase();
          // 3a. Buscar en Firestore contact_groups (equipo, familia, etc.)
          try {
            const groupsSnap = await db.collection('users').doc(uid).collection('contact_groups').get();
            for (const gDoc of groupsSnap.docs) {
              const contactsSnap = await db.collection('users').doc(uid)
                .collection('contact_groups').doc(gDoc.id).collection('contacts').get();
              for (const cDoc of contactsSnap.docs) {
                const cData = cDoc.data();
                if (cData.name && cData.name.toLowerCase().includes(destLower)) {
                  leadPhone = cDoc.id;
                  contactJid = `${leadPhone}@s.whatsapp.net`;
                  console.log(`[RESPONDELE-TAG] 👤 Encontrado en grupo "${gDoc.id}" por nombre "${destinatario}" → ${contactJid}`);
                  break;
                }
              }
              if (contactJid) break;
            }
          } catch (groupErr) {
            console.error(`[RESPONDELE-TAG] ⚠️ Error buscando en contact_groups:`, groupErr.message);
          }

          // 3b. Buscar en conversaciones recientes (pushName)
          if (!contactJid) {
            for (const [convJid, msgs] of Object.entries(conversations)) {
              if (convJid === phone || !convJid.includes('@')) continue;
              const lastMsg = msgs.slice(-5).find(m => m.role === 'user');
              if (lastMsg?._pushName && lastMsg._pushName.toLowerCase().includes(destLower)) {
                contactJid = convJid;
                leadPhone = convJid.split('@')[0];
                console.log(`[RESPONDELE-TAG] 👤 Encontrado por pushName "${destinatario}" → ${contactJid}`);
                break;
              }
            }
          }

          // 3c. Buscar en contact_index por nombre
          if (!contactJid) {
            try {
              const indexSnap = await db.collection('users').doc(uid).collection('contact_index')
                .where('name', '>=', destinatario).where('name', '<=', destinatario + '\uf8ff').limit(1).get();
              if (!indexSnap.empty) {
                leadPhone = indexSnap.docs[0].id;
                contactJid = `${leadPhone}@s.whatsapp.net`;
                console.log(`[RESPONDELE-TAG] 👤 Encontrado en contact_index "${destinatario}" → ${contactJid}`);
              }
            } catch (e) { /* no pasa nada */ }
          }
        }

        // 4. BROADCAST: FAMILIA o EQUIPO
        if (/^FAMILIA$/i.test(destinatario) || /^EQUIPO$/i.test(destinatario)) {
          console.log(`[RESPONDELE-TAG] 📢 Broadcast a ${destinatario} — delegando al handler existente`);
          // No resolver aquí — el DILE A handler existente ya lo maneja
        }

        if (contactJid && leadPhone) {
          // Generar respuesta personalizada
          const ownerName = userProfile?.name || 'el equipo';
          const businessName = userProfile?.businessName || '';
          const leadOriginalMsg = (conversations[contactJid] || []).slice(-3).find(m => m.role === 'user')?.content || '';
          const respondPrompt = `Sos MIIA, la asistente de ${ownerName}${businessName ? ` de ${businessName}` : ''}.
${leadOriginalMsg ? `El contacto escribió antes: "${leadOriginalMsg.substring(0, 200)}"` : ''}
Tu jefe te pide: "${instruccion}"

REGLAS:
- Máx 3 líneas, cálido y profesional
- JAMÁS decir que sos IA
- JAMÁS mencionar "me pidieron", "mi jefe", "el owner"`;

          const responseMsg = await generateAIContent(respondPrompt);
          if (responseMsg) {
            await safeSendMessage(sock, contactJid, { text: responseMsg });
            console.log(`[RESPONDELE-TAG] ✅ Mensaje enviado a ${contactJid}: "${responseMsg.substring(0, 60)}..."`);
          }
        } else if (!/^FAMILIA$|^EQUIPO$/i.test(destinatario)) {
          console.warn(`[RESPONDELE-TAG] ⚠️ No se encontró contacto para "${destinatario}"`);
        }
      } catch (e) {
        console.error(`[RESPONDELE-TAG] ❌ Error:`, e.message);
      }
      aiMessage = aiMessage.replace(/\[RESPONDELE:[^\]]+\]/g, '').trim();
    }

    // ═══ TAG [PROPONER_HORARIO:duración] — MIIA propone slots libres del Calendar ═══
    const proponerMatch = aiMessage.match(/\[PROPONER_HORARIO(?::(\d+))?\]/);
    if (proponerMatch) {
      const duration = parseInt(proponerMatch[1]) || 60;
      aiMessage = aiMessage.replace(/\[PROPONER_HORARIO(?::\d+)?\]/g, '').trim();
      try {
        const proposals = await proposeCalendarSlot(OWNER_UID, duration, 5);
        if (proposals.length > 0) {
          const slotsText = proposals.map((p, i) => `${i + 1}. ${p.display}`).join('\n');
          aiMessage += `\n\n📅 *Horarios disponibles (${duration} min):*\n${slotsText}\n\n¿Cuál te queda mejor?`;
          console.log(`[PROPONER_HORARIO] ✅ ${proposals.length} slots propuestos`);
        } else {
          aiMessage += '\n\n📅 No encontré horarios libres en los próximos días. ¿Querés que busque más adelante?';
          console.log(`[PROPONER_HORARIO] ⚠️ Sin slots disponibles`);
        }
      } catch (propErr) {
        console.error(`[PROPONER_HORARIO] ❌ Error:`, propErr.message);
      }
    }

    // ═══ TAGS [SHEET_*] / [DOC_*] — Google Sheets & Docs desde WhatsApp ═══
    // SOLO en self-chat: el owner pide a MIIA leer/escribir/crear hojas y docs
    const sheetDocTags = sheetsIntegration.detectSheetTags(aiMessage);
    if (sheetDocTags.length > 0 && isSelfChat && OWNER_UID) {
      console.log(`[SHEETS-TAG] 📊 ${sheetDocTags.length} tag(s) detectado(s): ${sheetDocTags.map(t => t.tag).join(', ')}`);
      for (const { tag, params } of sheetDocTags) {
        try {
          switch (tag) {
            case 'SHEET_LEER': {
              const [spreadsheetId, range] = params;
              const data = await sheetsIntegration.readSheet(OWNER_UID, spreadsheetId, range || 'Sheet1');
              const preview = (data.values || []).slice(0, 15).map(r => r.join(' | ')).join('\n');
              const totalRows = data.totalRows || 0;
              const summary = `📊 *Datos de la hoja* (${totalRows} filas):\n\n${preview}${totalRows > 15 ? `\n\n... y ${totalRows - 15} filas más` : ''}`;
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, summary, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ SHEET_LEER: ${totalRows} filas leídas de ${spreadsheetId}`);
              break;
            }
            case 'SHEET_ESCRIBIR': {
              const [spreadsheetId, range, rawData] = params;
              const rows = rawData.split(';').map(r => r.split(',').map(c => c.trim()));
              await sheetsIntegration.writeSheet(OWNER_UID, spreadsheetId, range, rows);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ Datos escritos en la hoja (rango: ${range})`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ SHEET_ESCRIBIR: ${rows.length} filas escritas en ${range}`);
              break;
            }
            case 'SHEET_APPEND': {
              const [spreadsheetId, range, rawData] = params;
              const rows = rawData.split(';').map(r => r.split(',').map(c => c.trim()));
              const result = await sheetsIntegration.appendSheet(OWNER_UID, spreadsheetId, range, rows);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ ${result.updatedRows} fila(s) agregada(s) a la hoja`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ SHEET_APPEND: ${result.updatedRows} filas agregadas`);
              break;
            }
            case 'SHEET_CREAR': {
              const [title] = params;
              const result = await sheetsIntegration.createSpreadsheet(OWNER_UID, title);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ Hoja creada: *${title}*\n📎 ${result.url}`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ SHEET_CREAR: "${title}" → ${result.spreadsheetId}`);
              break;
            }
            case 'SHEET_ANALIZAR': {
              const [spreadsheetId, question] = params;
              const data = await sheetsIntegration.readSheet(OWNER_UID, spreadsheetId, 'Sheet1');
              const analysis = await sheetsIntegration.analyzeSheetData(data.values, question || '', aiGateway);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📊 *Análisis IA:*\n\n${analysis}`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ SHEET_ANALIZAR: análisis completado`);
              break;
            }
            case 'DOC_CREAR': {
              const [title, content] = params;
              const result = await sheetsIntegration.createDocument(OWNER_UID, title, content || '');
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ Documento creado: *${title}*\n📎 ${result.url}`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ DOC_CREAR: "${title}" → ${result.documentId}`);
              break;
            }
            case 'DOC_LEER': {
              const [documentId] = params;
              const data = await sheetsIntegration.readDocument(OWNER_UID, documentId);
              const preview = (data.content || '').substring(0, 2000);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📄 *Contenido del documento:*\n\n${preview}${data.content.length > 2000 ? '\n\n... (contenido truncado)' : ''}`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ DOC_LEER: ${data.content.length} chars leídos`);
              break;
            }
            case 'DOC_APPEND': {
              const [documentId, text] = params;
              await sheetsIntegration.appendDocument(OWNER_UID, documentId, text);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ Texto agregado al documento`, { isSelfChat: true, skipEmoji: true });
              console.log(`[SHEETS-TAG] ✅ DOC_APPEND: texto agregado`);
              break;
            }
          }
        } catch (tagErr) {
          console.error(`[SHEETS-TAG] ❌ Error procesando ${tag}:`, tagErr.message);
          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `❌ Error con ${tag}: ${tagErr.message}`, { isSelfChat: true, skipEmoji: true }).catch(() => {});
        }
      }
      // Strip all sheet/doc tags from the message
      aiMessage = aiMessage
        .replace(/\[SHEET_LEER:[^\]]+\]/g, '')
        .replace(/\[SHEET_ESCRIBIR:[^\]]+\]/g, '')
        .replace(/\[SHEET_APPEND:[^\]]+\]/g, '')
        .replace(/\[SHEET_CREAR:[^\]]+\]/g, '')
        .replace(/\[SHEET_ANALIZAR:[^\]]+\]/g, '')
        .replace(/\[DOC_CREAR:[^\]]+\]/g, '')
        .replace(/\[DOC_LEER:[^\]]+\]/g, '')
        .replace(/\[DOC_APPEND:[^\]]+\]/g, '')
        .trim();
    }

    // ═══ TAGS [BUSCAR_RESERVA] / [RESERVAR] / [CANCELAR_RESERVA] / [RATING_RESERVA] ═══
    const reservationTags = reservationsIntegration.detectReservationTags(aiMessage);
    if (reservationTags.length > 0 && isSelfChat && OWNER_UID) {
      console.log(`[RESERVATIONS-TAG] 🍽️ ${reservationTags.length} tag(s): ${reservationTags.map(t => t.tag).join(', ')}`);
      for (const { tag, params } of reservationTags) {
        try {
          switch (tag) {
            case 'BUSCAR_RESERVA': {
              const [type, zone, date, time, partySize] = params;
              // Obtener ciudad/país del owner
              const ownerCountry = getCountryFromPhone(OWNER_PHONE);
              // R2: Búsqueda combinada — primero red MIIA, luego Google
              const results = await reservationsIntegration.searchBusinessesCombined(
                { type, zone, date, time, partySize: parseInt(partySize) || 0, city: zone, ownerCity: zone, ownerCountry, country: ownerCountry },
                aiGateway
              );
              const formatted = reservationsIntegration.formatSearchResults(results);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, formatted, { isSelfChat: true, skipEmoji: true });
              // Guardar resultados temporalmente para que el owner pueda elegir
              if (!global._lastReservationSearch) global._lastReservationSearch = {};
              global._lastReservationSearch[OWNER_PHONE] = { results, timestamp: Date.now() };
              console.log(`[RESERVATIONS-TAG] ✅ BUSCAR_RESERVA: ${results.length} resultados (${results.filter(r => r.isMiia).length} MIIA)`);
              break;
            }
            case 'RESERVAR': {
              const [businessPhone, date, time, partySize, notes] = params;
              // Buscar nombre del negocio en resultados previos o usar businessPhone
              let businessName = businessPhone;
              let businessAddress = '';
              const lastSearch = global._lastReservationSearch?.[OWNER_PHONE];
              if (lastSearch && Date.now() - lastSearch.timestamp < 3600000) {
                const match = lastSearch.results.find(b => b.phone === businessPhone || b.name?.toLowerCase().includes(businessPhone.toLowerCase()));
                if (match) {
                  businessName = match.name;
                  businessAddress = match.address || '';
                }
              }
              const reservation = await reservationsIntegration.createReservation(OWNER_UID, {
                type: 'other',
                businessName,
                businessPhone,
                businessAddress,
                date,
                time,
                partySize: parseInt(partySize) || 1,
                notes: notes || '',
                source: 'manual',
              });
              // Guardar como favorito
              if (businessPhone) {
                await reservationsIntegration.saveFavorite(OWNER_UID, businessPhone, {
                  name: businessName, address: businessAddress, type: 'other'
                }).catch(e => console.warn(`[RESERVATIONS-TAG] ⚠️ Error guardando favorito:`, e.message));
              }
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `✅ *Reserva creada*\n\n📍 ${businessName}\n📅 ${date} a las ${time}\n👥 ${partySize || 1} persona(s)${notes ? `\n📝 ${notes}` : ''}\n\n⚠️ Recordá confirmar directamente con el negocio.`,
                { isSelfChat: true, skipEmoji: true }
              );
              console.log(`[RESERVATIONS-TAG] ✅ RESERVAR: ${businessName} ${date} ${time}`);
              break;
            }
            case 'CANCELAR_RESERVA': {
              const [reservationId] = params;
              await reservationsIntegration.cancelReservation(OWNER_UID, reservationId);
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ Reserva cancelada`, { isSelfChat: true, skipEmoji: true });
              console.log(`[RESERVATIONS-TAG] ✅ CANCELAR_RESERVA: ${reservationId}`);
              break;
            }
            case 'RATING_RESERVA': {
              const [reservationId, rating] = params;
              const result = await reservationsIntegration.rateReservation(OWNER_UID, reservationId, parseInt(rating));
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                `⭐ *${result.businessName}* calificado con ${rating}/5. ¡Anotado!`,
                { isSelfChat: true, skipEmoji: true }
              );
              console.log(`[RESERVATIONS-TAG] ✅ RATING: ${result.businessName} → ${rating}/5`);
              break;
            }
            case 'RESERVAR_MIIA': {
              // R2: Reserva inter-MIIA — enviar directo al WhatsApp del negocio MIIA
              const [bizPhone, date, time, partySize, notes] = params;
              const ownerName = OWNER_PHONE; // TODO: obtener nombre real del owner
              const lastSearch = global._lastReservationSearch?.[OWNER_PHONE];
              let businessName = bizPhone;
              if (lastSearch && Date.now() - lastSearch.timestamp < 3600000) {
                const match = lastSearch.results.find(b => b.phone === bizPhone || b.name?.toLowerCase().includes(bizPhone.toLowerCase()));
                if (match) businessName = match.name;
              }

              const interResult = await reservationsIntegration.sendInterMiiaReservation({
                fromOwnerName: ownerName,
                bizPhone,
                date,
                time,
                partySize: parseInt(partySize) || 1,
                notes: notes || '',
                fromPhone: OWNER_PHONE,
              }, safeSendMessage);

              if (interResult.sent) {
                // También crear la reserva local
                await reservationsIntegration.createReservation(OWNER_UID, {
                  type: 'other',
                  businessName: interResult.businessName || businessName,
                  businessPhone: bizPhone,
                  date,
                  time,
                  partySize: parseInt(partySize) || 1,
                  notes: notes || '',
                  source: 'miia_network',
                  status: interResult.autoConfirm ? 'confirmed' : 'pending',
                });
                const confirmMsg = interResult.autoConfirm
                  ? `✅ *Reserva MIIA confirmada automáticamente*\n\n📍 ${interResult.businessName}\n📅 ${date} a las ${time}\n👥 ${partySize || 1} persona(s)\n\n🤖 El negocio usa MIIA — tu reserva ya está registrada.`
                  : `⏳ *Reserva MIIA enviada*\n\n📍 ${interResult.businessName}\n📅 ${date} a las ${time}\n👥 ${partySize || 1} persona(s)\n\n🤖 Solicitud enviada al negocio. Te aviso cuando confirmen.`;
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, confirmMsg, { isSelfChat: true, skipEmoji: true });
              } else {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                  `❌ No pude enviar la reserva MIIA: ${interResult.error}. ¿Querés que intente por otro medio?`,
                  { isSelfChat: true, skipEmoji: true }
                );
              }
              console.log(`[RESERVATIONS-TAG] ${interResult.sent ? '✅' : '❌'} RESERVAR_MIIA: ${businessName} ${date} ${time}`);
              break;
            }
          }
        } catch (tagErr) {
          console.error(`[RESERVATIONS-TAG] ❌ ${tag}: ${tagErr.message}`);
          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `❌ Error con reserva: ${tagErr.message}`, { isSelfChat: true, skipEmoji: true }).catch(() => {});
        }
      }
      // Strip reservation tags
      aiMessage = aiMessage
        .replace(/\[BUSCAR_RESERVA:[^\]]+\]/g, '')
        .replace(/\[RESERVAR:[^\]]+\]/g, '')
        .replace(/\[RESERVAR_MIIA:[^\]]+\]/g, '')
        .replace(/\[CANCELAR_RESERVA:[^\]]+\]/g, '')
        .replace(/\[RATING_RESERVA:[^\]]+\]/g, '')
        .trim();
    }

    // ═══ TAGS Google Services: [BUSCAR_CONTACTO], [BUSCAR_DRIVE], [BUSCAR_LUGAR], [BUSCAR_YOUTUBE], etc. ═══
    const serviceTags = googleServices.detectServiceTags(aiMessage);
    if (serviceTags.length > 0 && isSelfChat && OWNER_UID) {
      console.log(`[GSERVICES-TAG] 🔗 ${serviceTags.length} tag(s): ${serviceTags.map(t => t.tag).join(', ')}`);
      for (const { tag, params } of serviceTags) {
        try {
          switch (tag) {
            case 'BUSCAR_CONTACTO': {
              const contacts = await googleServices.listContacts(OWNER_UID, params[0], 10);
              if (contacts.length > 0) {
                const list = contacts.map((c, i) => `${i + 1}. *${c.name}*${c.phone ? ` 📞 ${c.phone}` : ''}${c.email ? ` 📧 ${c.email}` : ''}${c.company ? ` 🏢 ${c.company}` : ''}`).join('\n');
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📇 *Contactos encontrados:*\n\n${list}`, { isSelfChat: true, skipEmoji: true });
              } else {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📇 No encontré contactos para "${params[0]}"`, { isSelfChat: true, skipEmoji: true });
              }
              break;
            }
            case 'CREAR_CONTACTO': {
              const [name, phone, email, company] = params;
              const nameParts = (name || '').split(' ');
              const contact = await googleServices.createContact(OWNER_UID, {
                firstName: nameParts[0] || '', lastName: nameParts.slice(1).join(' ') || '',
                phone: phone || '', email: email || '', company: company || ''
              });
              await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ Contacto creado: *${contact.name}*`, { isSelfChat: true, skipEmoji: true });
              break;
            }
            case 'BUSCAR_DRIVE': {
              const files = await googleServices.listDriveFiles(OWNER_UID, params[0], 10);
              if (files.length > 0) {
                const list = files.map((f, i) => `${i + 1}. 📄 *${f.name}* (${f.size || f.type})\n   🔗 ${f.url || 'Sin link'}`).join('\n');
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📁 *Archivos encontrados:*\n\n${list}`, { isSelfChat: true, skipEmoji: true });
              } else {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `�� No encontré archivos para "${params[0]}"`, { isSelfChat: true, skipEmoji: true });
              }
              break;
            }
            case 'BUSCAR_LUGAR': {
              const [query, location] = params;
              const places = await googleServices.searchPlaces(query, location, aiGateway);
              if (places.length > 0) {
                const list = places.map((p, i) => `${i + 1}. *${p.name}* ${p.rating ? `⭐${p.rating}` : ''}\n   📍 ${p.address || '?'}${p.phone ? `\n   📞 ${p.phone}` : ''}`).join('\n\n');
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📍 *Lugares encontrados:*\n\n${list}`, { isSelfChat: true, skipEmoji: true });
              } else {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `📍 No encontré lugares para "${query}"`, { isSelfChat: true, skipEmoji: true });
              }
              break;
            }
            case 'BUSCAR_YOUTUBE': {
              const videos = await googleServices.searchYouTube(params[0], 5);
              if (videos.length > 0) {
                const list = videos.map((v, i) => `${i + 1}. 🎬 *${v.title}*\n   📺 ${v.channel}\n   🔗 ${v.url}`).join('\n\n');
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `🎬 *Videos encontrados:*\n\n${list}`, { isSelfChat: true, skipEmoji: true });
              } else {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `🎬 No encontré videos para "${params[0]}"`, { isSelfChat: true, skipEmoji: true });
              }
              break;
            }
            case 'BUSCAR_NEGOCIO': {
              const [bizName, location] = params;
              const profile = await googleServices.getBusinessProfile(bizName, location, aiGateway);
              if (profile) {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
                  `🏢 *${profile.name}*\n⭐ ${profile.rating || '?'}/5 (${profile.reviewCount || 0} reseñas)\n📍 ${profile.address || '?'}\n📞 ${profile.phone || '?'}\n🕐 ${profile.hours || '?'}\n���� ${profile.website || '?'}`,
                  { isSelfChat: true, skipEmoji: true }
                );
              } else {
                await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `🏢 No encontré perfil de negocio para "${bizName}"`, { isSelfChat: true, skipEmoji: true });
              }
              break;
            }
          }
        } catch (tagErr) {
          console.error(`[GSERVICES-TAG] ❌ ${tag}: ${tagErr.message}`);
          await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `❌ Error con ${tag}: ${tagErr.message}`, { isSelfChat: true, skipEmoji: true }).catch(() => {});
        }
      }
      aiMessage = aiMessage
        .replace(/\[BUSCAR_CONTACTO:[^\]]+\]/g, '').replace(/\[CREAR_CONTACTO:[^\]]+\]/g, '')
        .replace(/\[BUSCAR_DRIVE:[^\]]+\]/g, '').replace(/\[SUBIR_DRIVE:[^\]]+\]/g, '')
        .replace(/\[BUSCAR_LUGAR:[^\]]+\]/g, '').replace(/\[BUSCAR_YOUTUBE:[^\]]+\]/g, '')
        .replace(/\[BUSCAR_NEGOCIO:[^\]]+\]/g, '')
        .trim();
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

    // Cierre MIIA: desactivado en número de ventas (no hay familia/equipo aquí)
    // Se reactivará cuando se conecte el número personal del owner

    conversations[phone].push({ role: 'assistant', content: aiMessage, timestamp: Date.now() });
    if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
    saveDB();

    // Anti-ráfaga (Vacuna) — usa contador SEPARADO para no interferir con loop detector
    if (!vacunaCounter[phone]) vacunaCounter[phone] = { count: 0, lastTime: 0 };
    const nowLoop = Date.now();
    if (nowLoop - vacunaCounter[phone].lastTime < 5000) {
      vacunaCounter[phone].count++;
    } else {
      vacunaCounter[phone].count = 1;
    }
    vacunaCounter[phone].lastTime = nowLoop;
    if (vacunaCounter[phone].count > 5) {
      console.log(`🚨 [VACUNA] BLOQUEO POR RÁFAGA en ${phone} — pausa 15s`);
      isSystemPaused = true;
      setTimeout(() => { isSystemPaused = false; vacunaCounter[phone].count = 0; console.log(`[VACUNA] ✅ Pausa expirada`); }, 15000);
      return;
    }

    // ═══ ANTI-DETECCIÓN IA/BOT: Si el lead pregunta si MIIA es IA/bot, delay extra para no delatar ═══
    const msgLower = (userMessage || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isAIBotQuestion = !isSelfChat && !isAdmin && /\b(sos|eres|es)\s+(una?\s+)?(ia|bot|robot|inteligencia\s*artificial|maquina|programa|chatbot|gpt|ai)\b|\b(ia|bot|robot|chatbot|gpt|ai)\s+(sos|eres|es)\b|\b(hablar?\s+con\s+(una?\s+)?(persona|humano|ser\s+humano))\b|\b(sos\s+real|eres\s+real|no\s+sos\s+humano|no\s+eres\s+humano)\b/i.test(msgLower);
    if (isAIBotQuestion) {
      // Delay largo (15-35s) — como un humano que se ofende/sorprende por la pregunta
      const botQuestionDelay = 15000 + Math.floor(Math.random() * 20000);
      console.log(`[ANTI-DETECT] 🕵️ Lead ${phone} preguntó si MIIA es IA/bot. Delay extra: ${Math.round(botQuestionDelay / 1000)}s`);

      // 🚨 AVISAR AL OWNER INMEDIATAMENTE — el lead sospecha
      const leadNameForAlert = leadNames[phone] || phone.split('@')[0];
      const alertMsg = `🕵️ *ALERTA ANTI-DETECCIÓN*\n\n${leadNameForAlert} preguntó si sos IA/bot.\n\nMensaje: _"${(userMessage || '').substring(0, 100)}"_\n\nMIIA va a responder con delay largo (${Math.round(botQuestionDelay / 1000)}s) para parecer natural.`;
      try {
        if (OWNER_PHONE) safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, alertMsg, { isSelfChat: true });
      } catch (_) {}

      try {
        if (getOwnerSock()) await getOwnerSock().sendPresenceUpdate('paused', phone); // "dejó de escribir" — como si estuviera pensando
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000)); // pausa de "lectura"
        if (getOwnerSock()) await getOwnerSock().sendPresenceUpdate('composing', phone); // empieza a escribir
        await new Promise(r => setTimeout(r, botQuestionDelay));
      } catch (e) { /* ignore presence errors */ }
    }

    // 🛡️ HUMAN-DELAY: SOLO para leads/clientes — NUNCA en self-chat ni grupos
    // Sin esto, MIIA tarda 20-45s extra en responder al owner en self-chat.
    // FIX: Familia/equipo NO reciben delay largo ni chance de "busy" 20-45s
    const isFamilyOrEquipo = contactTypes[phone] === 'familia' || contactTypes[phone] === 'equipo';
    if (!isSelfChat) {
      // Simular typing y enviar
      try {
        if (getOwnerSock()) await getOwnerSock().sendPresenceUpdate('composing', phone);
        // Familia/equipo: typing más corto (1.5-3s). Leads: proporcional al largo
        const typingDuration = isFamilyOrEquipo
          ? Math.min(Math.max(aiMessage.length * 30, 1500), 4000)
          : Math.min(Math.max(aiMessage.length * 65, 2500), 15000);
        await new Promise(r => setTimeout(r, typingDuration));
      } catch (e) { /* ignore typing errors */ }

      // Micro-humanizer: typo 2% + delay variable — respeta preferencia del usuario
      // Familia/equipo: NUNCA reciben delay largo de 20-45s ("busy")
      const humanizerOn = await isHumanizerEnabled();
      if (humanizerOn && !isFamilyOrEquipo) aiMessage = maybeAddTypo(aiMessage);
      const humanDelayMs = isFamilyOrEquipo
        ? (800 + Math.random() * 700) // Familia/equipo: 0.8-1.5s siempre
        : humanizerOn
          ? (Math.random() < 0.125 ? (20000 + Math.random() * 25000) : (1500 + Math.random() * 1500))
          : (800 + Math.random() * 400);
      await new Promise(r => setTimeout(r, humanDelayMs));
    }

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
      chatType: postChatType, // Para emojis diferenciados (👩‍🔧 soporte, 👩‍💻 ventas MIIA)
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
          const isMiiaSalesLeadTTS = conversationMetadata[phone]?.contactType === 'miia_lead';
          await safeSendMessage(phone, aiMessage + pregunta, { isSelfChat, emojiCtx, isMiiaSalesLead: isMiiaSalesLeadTTS });
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
      const isMiiaSalesLead = conversationMetadata[phone]?.contactType === 'miia_lead';
      const isMiiaSupportClient = conversationMetadata[phone]?.contactType === 'miia_client' || contactTypes[phone] === 'miia_client';

      // ═══ MIIA SALES: Enviar imagen/banner ilustrativo (30% de las probaditas) ═══
      if (isMiiaSalesLead && !isSelfChat) {
        const currentProbadita = (conversations[phone] || []).filter(m => m.role === 'assistant').length;
        if (currentProbadita <= 10 && salesAssets.shouldSendImage(currentProbadita)) {
          const topic = salesAssets.detectSalesTopic(aiMessage);
          if (topic) {
            try {
              const asset = await salesAssets.getSalesAsset(topic);
              if (asset) {
                // Enviar imagen primero (ilustrativa), luego el texto con datos reales
                await safeSendMessage(phone, { mimetype: 'image/png', data: asset.buffer.toString('base64') }, { caption: asset.caption, isMiiaSalesLead: true });
                console.log(`[SALES-IMAGE] 🖼️ Imagen "${topic}" enviada a ${basePhone} (probadita #${currentProbadita})`);
                await new Promise(r => setTimeout(r, 1500)); // Pausa entre imagen y texto
              }
            } catch (imgErr) {
              console.warn(`[SALES-IMAGE] ⚠️ Error enviando imagen: ${imgErr.message}`);
            }
          }
        }
      }

      await safeSendMessage(phone, aiMessage, { isSelfChat, emojiCtx, isMiiaSalesLead: isMiiaSalesLead || isMiiaSupportClient });

      // 🎬 P-GIFS: Enviar GIF demostrativo si MIIA está presentando un feature al lead
      if (isMiiaSalesLead && !isSelfChat && getOwnerSock()) {
        try {
          const gifs = await miiaGifs.detectAndPrepareGifs(aiMessage, phone);
          for (const gif of gifs) {
            await new Promise(r => setTimeout(r, 1200)); // Pausa natural antes del GIF
            await miiaGifs.sendGif(getOwnerSock(), phone, gif.buffer, gif.caption);
          }
        } catch (gifErr) {
          console.warn(`[MIIA-GIFS] ⚠️ Error en pipeline GIF:`, gifErr.message);
        }
      }
    }

    io.emit('ai_response', {
      to: phone,
      toName: leadNames[phone] || basePhone,
      body: aiMessage,
      timestamp: Date.now(),
      type: contactTypes[phone] || 'lead'
    });

    // 📊 HISTORY MINING CAPA 3: Enriquecer contact_index con cada interacción
    if (OWNER_UID && !isSelfChat) {
      enrichContactIndex(OWNER_UID, phone, {
        messageBody: userMessage,
        contactType: contactTypes[phone] || 'lead',
        contactName: leadNames[phone] || '',
        isFromContact: true
      });
    }

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

    // ═══ MÉTRICA: Mensaje procesado exitosamente ═══
    const _pmrType = isSelfChat ? 'owner' : (isFamilyContact ? 'family' : 'lead');
    tenantLogger.tmetric(OWNER_UID, 'message_processed', { type: _pmrType, responseMs: Date.now() - _pmrStartMs });

  } catch (err) {
    console.error(`[MIIA] ❌ Error en processMiiaResponse para ${phone}:`, err.message);
    console.error(`[MIIA] ❌ Stack:`, err.stack);
    tenantLogger.terror(OWNER_UID, 'MIIA', `Error en processMiiaResponse para ${phone.split('@')[0]}`, err);
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

  // 🛡️ CONTENT SAFETY CHECK — Para imágenes y videos, verificar contenido antes de procesar
  if (mediaType === 'image' || mediaType === 'video') {
    try {
      const imageBuffer = Buffer.from(media.data, 'base64');
      const senderPhone = message.from || '';
      const safetyResult = await contentSafety.checkContentSafety(imageBuffer, {
        source: 'media_processing',
        phone: senderPhone,
        uid: OWNER_UID || '',
      });
      if (!safetyResult.allowed) {
        console.warn(`[MEDIA:SAFETY] 🚫 ${mediaType} bloqueado de ${senderPhone.split('@')[0]} (level=${safetyResult.level})`);
        // Retornar un texto descriptivo para que el handler pueda informar
        return {
          text: null,
          mediaType,
          _safetyBlocked: true,
          _safetyLevel: safetyResult.level,
          _safetyMessage: safetyResult.message,
        };
      }
    } catch (safetyErr) {
      // FAIL-SAFE: Si el check falla, bloquear por precaución
      console.error(`[MEDIA:SAFETY] ❌ Error en safety check — FAIL-SAFE → bloqueando: ${safetyErr.message}`);
      return {
        text: null,
        mediaType,
        _safetyBlocked: true,
        _safetyLevel: 'error',
        _safetyMessage: contentSafety.SAFETY_MESSAGES?.error_fallback || 'Error verificando imagen.',
      };
    }
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
  privacyCounters.recordIncoming('admin');

  // ═══ REACCIONES: responder inteligentemente a emojis ═══
  if (message.type === 'reaction' && message._reaction) {
    const { emoji, targetMsgId } = message._reaction;
    const fromNum = message.from.split('@')[0].split(':')[0];
    const ownerNum = (getOwnerSock() && getOwnerSock().user) ? getOwnerSock().user.id.split('@')[0].split(':')[0] : ownerConnectedPhone || OWNER_PHONE;
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
    const shouldRespond = Math.random() < 0.30;
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

    // 🛡️ SAFETY: Si la imagen/video fue bloqueada por Content Safety Shield
    if (mediaContext && mediaContext._safetyBlocked) {
      console.warn(`[MEDIA:SAFETY] 🚫 Media de ${message.from} bloqueada (level=${mediaContext._safetyLevel})`);
      tenantLogger.tmetric(OWNER_UID, mediaContext._safetyLevel === 'critical' ? 'safety_critical' : 'safety_blocked');
      const targetPhone = message.fromMe ? (message.to || message.from) : message.from;
      if (mediaContext._safetyMessage) {
        try { await safeSendMessage(targetPhone, mediaContext._safetyMessage); } catch (_) {}
      }
      return; // No procesar nada más de este mensaje
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

      const ownerNumMedia = (getOwnerSock() && getOwnerSock().user) ? getOwnerSock().user.id.split('@')[0].split(':')[0] : ownerConnectedPhone || OWNER_PHONE;
      const isSelfChatMedia = message.fromMe && (leadPhone.includes(ownerNumMedia) || leadPhone.includes(OWNER_PHONE));

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
          `⚠️ No pude procesar un ${tipoLabel} de *${leadName}* (${leadPhone.split('@')[0]})\nLe respondí: "${naturalMsg}"\nSi es importante, atendelo vos.`,
          { isSelfChat: true }
        );
        console.log(`[MEDIA] Fallback natural enviado a ${leadPhone}, alerta al owner`);
      }
      return;
    }
  }
  if (!body) return;


  // ═══ ANTI-LOOP NIVEL 1: Zero-Width marker = mensaje GENERADO por otra instancia MIIA ═══
  // Cuando MIIA envía a leads, agrega \u200B al inicio. Si otra MIIA recibe eso → ignorar.
  // IMPORTANTE: Solo bloquea mensajes con marker (generados por IA), NO al humano del mismo teléfono.
  if (body && body.startsWith(ZERO_WIDTH_MARKER)) {
    const senderBase = (message.from || '').split('@')[0].replace(/:\d+$/, '');
    console.log(`[ANTI-LOOP] 🛡️ Zero-Width marker detectado de ${senderBase} — mensaje generado por otra MIIA, ignorando.`);
    return;
  }

  // ═══ MIIA_PHONE_REGISTRY: SOLO LOGGING (NO bloquear) ═══
  // Un phone que corre MIIA también lo usa un humano. No podemos bloquear al humano.
  // El Zero-Width marker (Nivel 1) ya detecta los mensajes de IA. El registry solo loguea para awareness.
  if (!fromMe && body) {
    const senderBase = (message.from || '').split('@')[0].replace(/:\d+$/, '');
    if (MIIA_PHONE_REGISTRY.has(senderBase) && senderBase !== OWNER_PHONE) {
      console.log(`[MIIA-REGISTRY] ℹ️ Mensaje de phone con MIIA activa: ${senderBase} (sin marker → es el humano, NO su MIIA → procesar normal)`);
      // NO return — el humano detrás de esa MIIA está escribiendo, procesar normalmente
    }
  }

  // ═══ ANTI-LOOP NIVEL 3: Si fromMe y el body empieza con emoji oficial de MIIA → es eco de MIIA ═══
  // Esto cubre TODOS los casos: SPLIT-SMART, MULTI-MSG, mensajes normales, etc.
  // MIIA siempre prefija sus mensajes con emoji en self-chat, así que si vuelve con emoji → ignorar
  if (fromMe && body) {
    const emojiLoopMatch = body.match(/^([\p{Emoji_Presentation}\p{Extended_Pictographic}][\u{FE0F}\u{200D}\u{2640}\u{2642}♀♂]*)\s*:\s*/u);
    if (emojiLoopMatch && MIIA_OFFICIAL_EMOJIS.has(emojiLoopMatch[1])) {
      console.log(`[ANTI-LOOP] 🛡️ Eco de MIIA detectado (emoji ${emojiLoopMatch[1]}) — ignorando. body="${body.substring(0,60)}"`);
      return;
    }
  }

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
  const targetPhoneBase = targetPhoneId.split('@')[0]?.split(':')[0];
  const isSelfChat = targetPhoneId === myNumber || targetPhoneBase === myNumber.split('@')[0].split(':')[0];
  const now = Date.now();

  if (isSelfChat) {
    // Comando STOP en self-chat
    if (body.toUpperCase() === 'STOP') {
      if (!conversationMetadata[targetPhoneId]) conversationMetadata[targetPhoneId] = {};
      conversationMetadata[targetPhoneId].miiaFamilyPaused = true;
      selfChatLoopCounter[targetPhoneId] = { count: 0, lastTime: 0 };
      return;
    }
    // FIX: No contar mensajes replayed (timestamp anterior a conexión) como loop
    // Baileys re-envía mensajes viejos al reconectar, no es un loop real
    const msgTs = message.timestamp || 0;
    const isReplayedMsg = ownerConnectedAt > 0 && msgTs > 0 && msgTs < ownerConnectedAt;
    if (isReplayedMsg) {
      console.log(`[HIM] ⏭️ Msg replay ignorado por loop detector (ts=${msgTs} < connected=${ownerConnectedAt})`);
      // NO contar hacia loop, pero SÍ dejar pasar el mensaje
    } else {
      // Velocidad de auto-bucle — solo para mensajes NUEVOS (post-conexión)
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
      if (selfChatLoopCounter[targetPhoneId].count >= 5) {
        console.warn(`[HIM] ⚠️ Self-chat loop detected (${selfChatLoopCounter[targetPhoneId].count} msgs in <20s) for ${targetPhoneId} — pausing 30s`);
        selfChatLoopCounter[targetPhoneId].count = 0;
        // Pausa temporal (30s) en vez de permanente
        isSystemPaused = true;
        setTimeout(() => { isSystemPaused = false; console.log(`[HIM] ✅ Pausa de loop expirada — MIIA reactivada`); }, 30000);
        return;
      }
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
        const existingMode = conversationMetadata[effectiveTarget]?.protectionMode || null;
        if (!existingMode) {
          // Guardar en metadata local (funciona para cualquier contacto, no solo usuarios registrados)
          if (!conversationMetadata[effectiveTarget]) conversationMetadata[effectiveTarget] = {};
          conversationMetadata[effectiveTarget].protectionMode = detected;
          conversationMetadata[effectiveTarget].protectionDetectedAt = new Date().toISOString();

          // También intentar guardar en Firestore si es usuario registrado
          const userSnap = await admin.firestore().collection('users')
            .where('phone', '==', senderPhone).limit(1).get();
          if (!userSnap.empty) {
            const senderUid = userSnap.docs[0].id;
            await protectionManager.activateProtectionMode(senderUid, detected, {
              detectedAutomatically: true,
              phone: senderPhone
            });
          }

          console.log(`[PROTECTION] 🛡️ Modo ${detected} DETECTADO automáticamente para ${senderPhone}`);

          // Notificar al owner (en silencio, no al contacto)
          const contactName = leadNames[effectiveTarget] || familyContacts[senderPhone]?.name || senderPhone;
          const ownerJidProt = getOwnerSock()?.user?.id;
          if (ownerJidProt) {
            const ownerSelfProt = ownerJidProt.includes(':') ? ownerJidProt.split(':')[0] + '@s.whatsapp.net' : ownerJidProt;
            const modeEmoji = detected === 'kids' ? '👶' : '👴';
            await safeSendMessage(ownerSelfProt,
              `${modeEmoji} Detecté que *${contactName}* podría ser ${detected === 'kids' ? 'un menor' : 'adulto mayor'}. Activé tono ${detected === 'kids' ? 'infantil protegido' : 'respetuoso y paciente'} automáticamente 🤍`,
              { isSelfChat: true }
            );
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
  // El mensaje de bienvenida indica que el lead firmó y se convirtió en cliente
  if (body.includes('Bienvenid') && body.includes('mejorar tu bienestar') && body.includes('pacientes')) {
    if (contactTypes[targetPhone] !== 'cliente') {
      contactTypes[targetPhone] = 'cliente';
      const clientName = leadNames[targetPhone] || targetPhone.split('@')[0];
      cerebroAbsoluto.appendLearning(
        `NUEVO CLIENTE: ${clientName} (${targetPhone.split('@')[0]}) se convirtió en cliente de ${userProfile?.businessName || 'la empresa'} el ${new Date().toLocaleDateString('es-ES')}.`,
        'CONVERSION_LEAD_CLIENTE'
      );
      saveDB();
      estadisticas.registrarCliente(targetPhone, clientName, null, null, null);
      if (subscriptionState[targetPhone]) delete subscriptionState[targetPhone];
      console.log(`[MIIA] 🎉 CONVERSIÓN: ${clientName} ahora es cliente (${targetPhone})`);
      // Notificar a Mariano
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
        `🎉 *${clientName}* pasó a ser cliente de ${userProfile?.businessName || 'tu negocio'}. ¡Uno más!`,
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

  // Opt-out (word boundary: evitar falsos positivos como "trabajar" → "baja")
  const optOutKeywords = ['quitar', 'dar de baja', 'darse de baja', 'darme de baja', 'no molestar', 'no me interesa', 'spam', 'parar de escribir', 'unsubscribe', 'no quiero mas mensajes', 'dejen de escribir'];
  if (!fromMe && optOutKeywords.some(kw => {
    // Match palabra completa para keywords cortas, substring para frases largas
    if (kw.includes(' ')) return lowerBody.includes(kw);
    return new RegExp(`\\b${kw}\\b`).test(lowerBody);
  })) {
    console.log(`[OPT-OUT] ⚠️ Keyword detectado en: "${(body||'').substring(0,80)}"`);
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

          // LID FALLBACK POR PUSHNAME — SOLO MATCH EXACTO (fix sesión 34)
          // NUNCA usar includes() — "." matchearía "Sr. Rafael", "Ana" matchearía "Anabella"
          // Solo pushNames de 3+ caracteres (punto, guion, espacio no son nombres reales)
          if (pushLower.length >= 3) {
            // 1A: Buscar en leadNames (match EXACTO)
            for (const [knownPhone, knownName] of Object.entries(leadNames || {})) {
              if (knownName && knownName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === pushLower && knownPhone.includes('@s.whatsapp.net')) {
                console.log(`[LID-MAP] 🔗 Matched LID via leadNames (EXACTO): ${phone} → ${knownPhone} (${message.pushName})`);
                registerLidMapping(phone, knownPhone);
                phone = knownPhone;
                lidResolved = true;
                break;
              }
            }

            // 1B: Buscar en familyContacts (match EXACTO por name o fullName)
            if (!lidResolved) {
              for (const [baseNum, fData] of Object.entries(familyContacts || {})) {
                const fName = (fData.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const fFull = (fData.fullName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                if (fName && fName.length >= 3 && (fName === pushLower || fFull === pushLower)) {
                  const resolvedJid = `${baseNum}@s.whatsapp.net`;
                  console.log(`[LID-MAP] 🔗 Matched LID via familyContacts (EXACTO): ${phone} → ${resolvedJid} (pushName="${message.pushName}" matched family="${fData.name}")`);
                  registerLidMapping(phone, resolvedJid);
                  phone = resolvedJid;
                  lidResolved = true;
                  break;
                }
              }
            }

            // 1C: Buscar en equipoMedilink (match EXACTO por name)
            if (!lidResolved) {
              for (const [baseNum, eData] of Object.entries(equipoMedilink || {})) {
                if (eData.name) {
                  const eName = eData.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                  if (eName.length >= 3 && eName === pushLower) {
                    const resolvedJid = `${baseNum}@s.whatsapp.net`;
                    console.log(`[LID-MAP] 🔗 Matched LID via equipoMedilink (EXACTO): ${phone} → ${resolvedJid} (pushName="${message.pushName}" matched equipo="${eData.name}")`);
                    registerLidMapping(phone, resolvedJid);
                    phone = resolvedJid;
                    lidResolved = true;
                    break;
                  }
                }
              }
            }
          } else {
            console.log(`[LID-MAP] ⚠️ pushName "${message.pushName}" demasiado corto (${pushLower.length} chars) — NO se intenta match por nombre`);
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
    // SAFETY NET ELIMINADO (2026-04-09, Sesión 34)
    // RAZÓN: El matching por pushName con includes() causó que Mamá (pushName ".") fuera
    // mapeada a Papá ("Sr. Rafael" contiene "."). Fuga de privacidad CRÍTICA.
    // Los LID no resueltos se procesan como contacto desconocido — cada MIIA decide según sus reglas.
    // La resolución confiable SOLO ocurre por: resolveLid() (mapa confirmado) o contactos de WhatsApp.
    const existsInCRM = !!conversations[effectiveTarget];

    // NUEVO: Si no está en allowedLeads, verificar si está registrado en Firestore como usuario/cliente MIIA
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
          // Marcar como CLIENTE existente (NO lead) — cambia el prompt a modo soporte
          contactTypes[effectiveTarget] = 'miia_client';
          console.log(`[WA] ✅ ${baseTarget} es CLIENTE MIIA registrado (${userName}) — modo soporte activado`);
        }
      } catch (e) {
        console.error(`[WA] Error buscando usuario en Firestore:`, e.message);
      }
    }

    // También verificar por client_keywords: "soporte", "no puedo entrar", "mi cuenta", etc.
    if (isAllowed && !contactTypes[effectiveTarget]?.includes('client') && !fromMe) {
      const MIIA_CLIENT_KEYWORDS = [
        'soporte', 'ayuda con mi cuenta', 'no puedo entrar', 'error', 'bug',
        'mi suscripcion', 'mi suscripción', 'renovar', 'cancelar', 'mi plan',
        'no me funciona', 'problema con', 'se cayó', 'no anda', 'no funciona',
        'actualización', 'actualizacion', 'nueva función', 'nueva funcion',
        'manual', 'tutorial', 'como se usa', 'como hago', 'no entiendo',
        'mi cuenta', 'mi perfil', 'cambiar contraseña', 'cambiar plan',
        'factura', 'recibo', 'cobro', 'pago'
      ];
      const clientMatch = matchesBusinessKeywords(body, MIIA_CLIENT_KEYWORDS);
      if (clientMatch.matched) {
        contactTypes[effectiveTarget] = 'miia_client';
        console.log(`[WA] 🏥 Contacto ${baseTarget} detectado como cliente existente por keyword "${clientMatch.keyword}" — modo soporte`);
      }
    }

    // Auto-takeover via CONTACT GATE — keywords para MIIA (el producto)
    if (!isAllowed && !existsInCRM && !fromMe) {
      // ═══ FIX CRÍTICO: En el número de MIIA (admin), TODOS los desconocidos son leads ═══
      // Este ES el número de venta de MIIA. Cualquiera que escriba aquí quiere conocer MIIA.
      // La FORBIDDEN_KEYWORDS blacklist bloqueaba "hola", "que hacen", etc. que son exactamente
      // lo que dicen los leads cuando escriben por primera vez.
      const isAdminNumber = true; // Este server.js SOLO maneja el número del admin (MIIA)

      if (isAdminNumber && body && body.trim().length > 0) {
        // En el número de MIIA: TODO mensaje de desconocido = lead potencial
        allowedLeads.push(effectiveTarget);
        isAllowed = true;
        try {
          const ct = await message.getContact();
          detectContactType(ct.name || ct.pushname || 'Lead', effectiveTarget);
        } catch (_) {}
        saveDB();
        console.log(`[WA] ✅ Auto-takeover (MIIA Sales): ${effectiveTarget} — TODO desconocido es lead en número de MIIA. body="${(body||'').substring(0,50)}"`);
      } else {
        // Para owners regulares (futuro multi-tenant): usar keywords
        const MIIA_SALES_KEYWORDS = [
          'miia', 'asistente', 'whatsapp', 'automatizar', 'ia', 'inteligencia artificial',
          'bot', 'chatbot', 'ventas', 'leads', 'crm',
          'info', 'informacion', 'infomacion', 'informasion',
          'interesado', 'interesada', 'me interesa',
          'quiero saber', 'quiero info', 'necesito',
          'demo', 'demostracion', 'probar', 'prueba',
          'contratar', 'adquirir', 'comprar', 'suscripcion',
          'presupuesto', 'costo', 'valor', 'tarifa', 'mensualidad',
          'conocer', 'cotizar', 'averiguar',
          'precio', 'precios', 'cuanto vale', 'cuanto cuesta', 'cuanto sale',
          'como funciona', 'que ofrece', 'que ofrecen', 'planes',
          'quisiera', 'me gustaria', 'contratacion', 'servicio', 'servicios'
        ];
        const allKeywords = [...keywordsSet, ...MIIA_SALES_KEYWORDS];
        const kwMatch = matchesBusinessKeywords(body, allKeywords);
        if (kwMatch.matched) {
          allowedLeads.push(effectiveTarget);
          isAllowed = true;
          try {
            const ct = await message.getContact();
            detectContactType(ct.name || ct.pushname || 'Lead', effectiveTarget);
          } catch (_) {}
          saveDB();
          console.log(`[WA] ✅ Auto-takeover: ${effectiveTarget} keyword "${kwMatch.keyword}"`);
        }
      }
    }

    // ═══ PRICE TRACKER: Detectar respuestas de tiendas trackeadas ═══
    if (!fromMe) {
      const storeInfo = priceTracker.identifyStoreReply(effectiveTarget, body);
      if (storeInfo) {
        await priceTracker.processStoreReply(effectiveTarget, body, storeInfo);
        // Seguir procesando normalmente (el mensaje también aparece en el chat del owner)
      }
    }

    if (!isAllowed && !existsInCRM && !fromMe) {
      // Silent digest: registrar el contacto como pendiente y salir
      if (message._baileysMsg?._silentDigest) {
        console.log(`[SILENT-DIGEST] 📋 Contacto no-allowed registrado: ${effectiveTarget} body="${(body||'').substring(0,40)}"`);
        return;
      }

      // ═══ FIX: Resolver LID a número real ANTES de notificar al owner ═══
      let displayPhone = effectiveTarget.split('@')[0];
      const pushName = message._baileysMsg?.pushName || message.pushName || '';
      let isLidUnresolved = false;

      // Detectar LID: explícitamente @lid O número con 14+ dígitos (imposible para teléfono real)
      const phoneDigits = displayPhone.replace(/[^0-9]/g, '');
      const looksLikeLid = effectiveTarget.includes('@lid') || phoneDigits.length > 13;

      if (looksLikeLid) {
        if (effectiveTarget.includes('@lid')) {
          const resolved = resolveLid(effectiveTarget);
          if (resolved !== effectiveTarget) {
            displayPhone = resolved.split('@')[0];
            console.log(`[LID-RESOLVE] ✅ LID resuelto para alerta: ${effectiveTarget} → ${displayPhone}`);
          } else {
            isLidUnresolved = true;
          }
        } else {
          // Número con 14+ dígitos pero no @lid → tratarlo como LID no resuelto
          isLidUnresolved = true;
        }

        if (isLidUnresolved) {
          // REGLA ABSOLUTA: NUNCA mostrar número LID al owner
          console.log(`[LID-RESOLVE] ⚠️ LID/número largo ${phoneDigits.substring(0,8)}... sin resolver. pushName="${pushName || 'ninguno'}"`);
        }
      }

      // REGLA: Auto-clasificar como lead en vez de bloquear (MIIA CENTER = 1 solo negocio)
      // Si alguien escribe a MIIA CENTER, ES un lead potencial de MIIA
      console.log(`[CONTACT-GATE] 🏷️ Auto-clasificando desconocido ${isLidUnresolved ? (pushName || 'desconocido') : displayPhone} como lead (sin keywords, auto-clasificación). body="${(body||'').substring(0,60)}"`);
      contactTypes[effectiveTarget] = 'lead';
      isAllowed = true;
      // Notificar al owner de forma informativa (no bloqueante)
      const alertMsg = `📱 *Nuevo lead detectado*\n\n` +
        `${pushName ? `Contacto: *${pushName}*` : `Número: +${displayPhone}`}\n` +
        `Dice: "${(body || '').substring(0, 200)}"\n\n` +
        `Lo clasifiqué como *lead* y le estoy respondiendo 💬`;
      const ownerSelfJid = `${OWNER_PHONE}@s.whatsapp.net`;
      if (!conversations[ownerSelfJid]) conversations[ownerSelfJid] = [];
      conversations[ownerSelfJid].push({
        role: 'assistant',
        content: alertMsg,
        timestamp: Date.now(),
        _contactJid: effectiveTarget,
      });
      safeSendMessage(ownerSelfJid, alertMsg, { isSelfChat: true }).catch(() => {});
      // NO return — continuar con el flujo normal para responder al lead
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

    // ═══ READ RECEIPT SELECTIVO: Solo marcar como leído si MIIA va a responder ═══
    // Contactos ignorados (sin keyword) ya retornaron arriba → nunca llegan acá → ticks grises
    // Los que llegan acá SÍ van a recibir respuesta → marcar como leído con delay
    if (!fromMe && message._baileysMsg?.key) {
      const readDelayMs = 1500 + Math.random() * 3000; // 1.5-4.5s para leer
      setTimeout(async () => {
        try {
          const ownerSockRR = getOwnerSock();
          if (ownerSockRR) {
            await ownerSockRR.readMessages([message._baileysMsg.key]);
            console.log(`[READ-RECEIPT] ✅ Marcado como leído: ${effectiveTarget} (delay ${Math.round(readDelayMs)}ms)`);
          }
        } catch (e) {
          // Best effort — no falla si no funciona
          console.log(`[READ-RECEIPT] ⚠️ No se pudo marcar como leído: ${e.message}`);
        }
      }, readDelayMs);
    }

    // Self-chat: solo responder si MIIA es mencionada
    // Fallback a OWNER_PHONE si whatsappClient.info aún no está disponible
    const myNumberFull = (getOwnerSock() && getOwnerSock().user)
      ? getOwnerSock().user.id : `${OWNER_PHONE}@s.whatsapp.net`;
    // senderNumber: quién envió este mensaje (cuando fromMe=true, es el dueño)
    const senderNumber = (message.from || '').split('@')[0];
    // ═══ FIX: Incluir ADMIN_PHONES como self-chat ═══
    // Cuando el owner escribe desde su número personal (573163937365) al número de MIIA,
    // fromMe=false pero ES el owner. Detectar via ADMIN_PHONES.
    const effectiveBase = effectiveTarget.split('@')[0]?.split(':')[0];
    const isAdminRemote = !fromMe && ADMIN_PHONES.includes(effectiveBase) && effectiveBase !== (myNumberFull.split('@')[0]?.split(':')[0]);
    const isSelfChatMsg = isAdminRemote || (fromMe && (
      effectiveTarget === myNumberFull ||
      effectiveTarget.split('@')[0] === myNumberFull.split('@')[0] ||
      effectiveTarget.split('@')[0] === OWNER_PHONE ||
      effectiveTarget.split('@')[0] === senderNumber   // remitente == destinatario → self-chat
    ));
    if (isAdminRemote) {
      console.log(`[HIM] 🔧 Admin remoto detectado: ${effectiveBase} → tratando como self-chat`);
    }
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

    // NÚMERO DE MIIA: cualquier mensaje activa MIIA (es su número de ventas)
    const isMIIAMentioned = true;

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

    // NÚMERO DE MIIA: No hay familia ni equipo. Todo contacto externo = lead de MIIA.
    const isFamily = false;
    const isEquipo = false;
    const isSelfChatMIIA = isSelfChatMsg && isMIIAActive;

    // B1 DIAGNOSTIC: Log de estado de clasificación
    if (isSelfChatMsg || fromMe) {
      console.log(`[HIM-TRACE] 📍 Classification: effectiveTarget=${effectiveTarget} isSelfChatMsg=${isSelfChatMsg} isMIIAActive=${isMIIAActive} isSelfChatMIIA=${isSelfChatMIIA} isFamily=${isFamily} isProcessing=${!!isProcessing[effectiveTarget]}`);
    }

    // Siempre guardar mensajes entrantes de familia
    if (isFamily && !fromMe) {
      if (!conversations[effectiveTarget]) conversations[effectiveTarget] = [];
      const exists = conversations[effectiveTarget].some(m => m.content === body && Math.abs(m.timestamp - Date.now()) < 5000);
      if (!exists) {
        const entry = { role: 'user', content: body, timestamp: Date.now() };
        if (message._quotedText) entry.quotedText = message._quotedText;
        conversations[effectiveTarget].push(entry);
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
      const noteEntry = { role: 'user', content: body, timestamp: Date.now() };
      if (message._quotedText) noteEntry.quotedText = message._quotedText;
      conversations[effectiveTarget].push(noteEntry);
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
      const histEntry = { role: 'user', content: userContent, timestamp: Date.now() };
      if (message._quotedText) {
        histEntry.quotedText = message._quotedText;
        pendingQuotedText[effectiveTarget] = message._quotedText;
      } else {
        delete pendingQuotedText[effectiveTarget];
      }
      history.push(histEntry);
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
      const _ohTz = getTimezoneForCountry(getCountryFromPhone(OWNER_PHONE || ''));
      const _ohLocal = new Date(new Date().toLocaleString('en-US', { timeZone: _ohTz }));
      const _ohTime = `${_ohLocal.getHours()}:${String(_ohLocal.getMinutes()).padStart(2, '0')}`;
      const _ohSchedule = automationSettings?.schedule || {};
      // GUARDAR en nightPendingLeads para responder cuando entre en horario
      nightPendingLeads.add(effectiveTarget);
      console.log(`[WA] Fuera de horario para ${effectiveTarget} (${_ohTime} ${_ohTz}, schedule: ${_ohSchedule.start || '?'}-${_ohSchedule.end || '?'}, days: ${JSON.stringify(_ohSchedule.days || [])}). Pendiente registrado (${nightPendingLeads.size} total).`);
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
        `🔔 *${leadName}* quiere comprar. Datos:\n${body.substring(0, 300)}\nCreale el link de pago cuando puedas.`,
        { isSelfChat: true });
      await safeSendMessage(effectiveTarget,
        `¡Listo! Recibí tus datos. Estoy preparando tu acceso y te lo mando apenas esté. ¡Gracias por elegirnos! 🙌`);
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

  // Unirse al room del tenant para recibir eventos en tiempo real (mining, etc.)
  socket.on('join_tenant_room', (uid) => {
    if (uid && typeof uid === 'string') {
      socket.join(`tenant:${uid}`);
      console.log(`[Socket.IO] Cliente unido al room tenant:${uid}`);
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
    },
    engines: {
      nightlyBrain: nightlyBrain.getStatus(),
      integrations: integrationEngine.getStats()
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
      let role = doc.exists ? (doc.data().role || 'owner') : 'owner'; // default owner for legacy users

      // Normalizar: 'client' es equivalente a 'owner' (legacy role name)
      if (role === 'client') role = 'owner';
      req.userRole = role;

      // Admin siempre tiene acceso a todo
      if (role === 'admin') return next();
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

app.get('/api/status', async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ connected: false, hasQR: false });

  const status = tenantManager.getTenantStatus(uid);
  const result = { connected: status.isReady, hasQR: status.hasQR, tenant: uid };

  // verify=true → prueba REAL con sendPresenceUpdate (no solo isReady)
  // Detecta desconexiones fantasma donde Baileys cree estar conectado pero WhatsApp cortó
  if (req.query.verify === 'true' && status.isReady) {
    const probe = await tenantManager.verifyConnection(uid);
    result.verified = probe.alive;
    result.latencyMs = probe.latencyMs;
    if (!probe.alive) {
      result.connected = false; // Corregir: el dashboard NO debe mostrar "Conectado"
      result.ghostDisconnect = true;
      result.probeError = probe.error;
      console.warn(`[STATUS] ⚠️ uid=${uid}: isReady=true pero verify FALLÓ → ghost disconnect`);
    }
  }

  res.json(result);
});

// ─── /api/conversations — contacts.html-compatible format ─────────────────────
app.get('/api/conversations', async (req, res) => {
  const uid = req.query.uid;

  if (uid) {
    // Si es el owner principal, usar conversations globales (no del tenant)
    // Las conversations del owner están en server.js global, no en tenant_manager
    if (uid === OWNER_UID) {
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
      return res.json(result);
    }

    // Multi-tenant: buscar en tenant_manager
    try {
      const convs = await tenantManager.getTenantConversations(uid);
      return res.json(convs);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Single-tenant fallback (original): format for contacts.html (sin uid)
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
  // Verificar rol del usuario para habilitar self-chat en owners no-admin
  let isOwnerRole = true; // Default: quien inicia desde dashboard es owner
  try {
    const roleDoc = await admin.firestore().collection('users').doc(uid).get();
    if (roleDoc.exists) {
      const role = roleDoc.data().role || 'owner';
      isOwnerRole = ['admin', 'owner', 'founder'].includes(role);
    }
  } catch (e) {}
  const tenantOptions = isOwner ? {
    isOwnerAccount: true,
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
      // Extraer quotedText del contextInfo para que el historial incluya contexto de replies
      const ctxInfo = baileysMsg.message?.extendedTextMessage?.contextInfo
        || baileysMsg.message?.imageMessage?.contextInfo
        || baileysMsg.message?.videoMessage?.contextInfo
        || baileysMsg.message?.documentMessage?.contextInfo
        || null;
      let adaptedQuotedText = null;
      if (ctxInfo?.quotedMessage) {
        const qm = ctxInfo.quotedMessage;
        adaptedQuotedText = qm.conversation
          || qm.extendedTextMessage?.text
          || qm.imageMessage?.caption
          || qm.videoMessage?.caption
          || qm.documentMessage?.caption
          || '[media]';
      }
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
        _baileysMsg: baileysMsg,  // Para que processMediaMessage pueda descargar media
        _quotedText: adaptedQuotedText  // Contexto de mensaje citado para historial
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
      // Guardar número conectado dinámicamente
      const connNum = sock.user?.id?.split('@')[0]?.split(':')[0];
      if (connNum) {
        ownerConnectedPhone = connNum;
        ADMIN_PHONES.push(connNum);
        console.log(`[WA] 📱 ownerConnectedPhone = ${connNum} (dinámico)`);
      }
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
  } : { isOwnerAccount: isOwnerRole };
  const tenant = tenantManager.initTenant(uid, apiKeyToUse, io, {}, tenantOptions);
  console.log(`[INIT] ✅ WhatsApp iniciado para ${uid}. Checking role...`);
  tenantLogger.tmetric(uid, 'whatsapp_connected');
  tenantLogger.registerTenantName(uid, uid);

  // Cargar cerebro compartido si es miembro de una empresa
  try {
    const userDoc = await admin.firestore().collection('users').doc(uid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      tenantLogger.registerTenantName(uid, userData.name || userData.email || uid);
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

// POST /api/broadcast-return — MIIA ha vuelto! Envía saludo a todos los owners y agentes conectados (solo admin)
app.post('/api/broadcast-return', express.json(), async (req, res) => {
  // Verificar que es admin
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No auth' });
  const token = authHeader.replace('Bearer ', '');
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  // Verificar role admin en Firestore
  const userDoc = await admin.firestore().collection('users').doc(decodedToken.uid).get();
  if (!userDoc.exists || userDoc.data().role !== 'admin') {
    return res.status(403).json({ error: 'Solo admin puede hacer broadcast' });
  }

  const customMessage = req.body?.message || null;
  const defaultMsg = '¡Volví! 🎉 Estuve haciendo unas mejoritas y ya estoy lista de nuevo para vos. Te extrañé mucho 💕 ¿En qué te ayudo?';
  const agentMsg = req.body?.agentMessage || '¡Hola! Ya estoy de vuelta y lista para trabajar juntos 💪';

  const connectedTenants = tenantManager.getConnectedTenants();
  const results = { sent: [], failed: [], total: connectedTenants.length };

  for (const t of connectedTenants) {
    try {
      const selfNum = t.sock.user?.id?.split(':')[0]?.split('@')[0];
      if (!selfNum) { results.failed.push({ uid: t.uid, error: 'No user ID' }); continue; }
      const selfJid = `${selfNum}@s.whatsapp.net`;
      const msg = t.role === 'agent' ? agentMsg : (customMessage || defaultMsg);
      await safeSendMessage(selfJid, msg, { isSelfChat: true, skipEmoji: true });
      results.sent.push({ uid: t.uid, role: t.role });
      console.log(`[BROADCAST] ✅ Enviado a ${t.uid} (${t.role})`);
    } catch (e) {
      results.failed.push({ uid: t.uid, error: e.message });
      console.error(`[BROADCAST] ❌ Error enviando a ${t.uid}:`, e.message);
    }
  }

  // También enviar al owner principal (self-chat de Mariano) si no está en tenants
  if (!results.sent.some(s => s.uid === OWNER_UID) && getOwnerSock()) {
    try {
      const ownerJid = getOwnerSock().user?.id;
      if (ownerJid) {
        const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
        await safeSendMessage(ownerSelf, customMessage || defaultMsg, { isSelfChat: true, skipEmoji: true });
        results.sent.push({ uid: OWNER_UID, role: 'admin' });
        console.log(`[BROADCAST] ✅ Enviado a owner principal`);
      }
    } catch (e) {
      results.failed.push({ uid: OWNER_UID, error: e.message });
    }
  }

  console.log(`[BROADCAST] 📢 MIIA ha vuelto! Enviado a ${results.sent.length}/${results.total + 1} usuarios`);
  res.json({ success: true, ...results });
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

    // Verificar si AHORA estamos en horario — si sí, procesar los pendientes
    const scheduleConfig = await getScheduleConfig(OWNER_UID);
    const nowInSchedule = isWithinSchedule(scheduleConfig);
    const nowInAutoResponse = isWithinAutoResponseSchedule();

    if (!nowInSchedule && !nowInAutoResponse) {
      // Seguimos fuera de horario — no procesar aún
      return;
    }

    const pendingCopy = [...nightPendingLeads];
    nightPendingLeads.clear();

    console.log(`[WAKE UP] ✅ En horario — procesando ${pendingCopy.length} leads pendientes...`);

    for (const pendingPhone of pendingCopy) {
      // Delay aleatorio entre leads: 30s–3min para parecer humano
      const delay = Math.floor(Math.random() * 150000) + 30000;
      await new Promise(r => setTimeout(r, delay));
      try {
        const lastMsg = (conversations[pendingPhone] || []).slice(-1)[0];
        if (lastMsg && lastMsg.role === 'user') {
          await processMiiaResponse(pendingPhone, lastMsg.content, true);
          console.log(`[WAKE UP] ✅ Respondido a ${pendingPhone}`);
        }
      } catch (e) {
        console.error(`[WAKE UP] ❌ Error procesando ${pendingPhone}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[WAKE UP] ❌ Error general:', e.message);
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

// ═══ HELPER: Dialecto por país del contacto (para inyectar en prompts) ═��═
// Si no se reconoce el país → español neutro. Formal pero con acento local.
function getDialectForPhone(contactPhone) {
  const country = getCountryFromPhone(contactPhone || '');
  switch (country) {
    case 'AR': return 'DIALECTO: Usá VOS (voseo rioplatense). "contame", "decime", "mirá", "fijate". Expresiones: "dale", "genial", "bárbaro".';
    case 'CO': return 'DIALECTO: Usá TÚ (tuteo colombiano). "cuéntame", "dime", "mira". Expresiones: "listo", "dale", "claro que sí", "con mucho gusto".';
    case 'MX': return 'DIALECTO: Usá TÚ (tuteo mexicano). "cuéntame", "platícame", "mira". Expresiones: "órale", "sale", "claro", "con gusto".';
    case 'CL': return 'DIALECTO: Usá TÚ (tuteo chileno). "cuéntame", "dime". Expresiones: "dale", "ya", "perfecto".';
    case 'PE': return 'DIALECTO: Usá TÚ (tuteo peruano). "cuéntame", "dime". Expresiones: "ya", "claro", "nomás".';
    case 'EC': return 'DIALECTO: Usá TÚ (tuteo ecuatoriano). "cuéntame", "dime". Expresiones: "claro", "dale", "ya mismo".';
    case 'ES': return 'DIALECTO: Usá TÚ (tuteo español). "cuéntame", "dime". NUNCA "vos". Expresiones: "vale", "genial", "estupendo".';
    case 'US': return 'DIALECTO: Usá TÚ (español neutro formal). "cuéntame", "dime". Tono profesional, sin regionalismos.';
    default:   return 'DIALECTO: Usá TÚ (español neutro). "cuéntame", "dime". NUNCA "contame" ni "decime" (argentino). Tono profesional neutro.';
  }
}

// ═══ HELPER: Fallback contextual para contactos familia/equipo/grupos ═══
// Genera textos fallback SIN IA, usando contexto del contacto y owner
function buildContextualFallback(type, { contactName, ownerName, contactPhone, emoji } = {}) {
  const country = getCountryFromPhone(contactPhone || OWNER_PHONE || '57');
  const isVos = country === 'AR';
  const name = contactName || '';
  const ow = ownerName || userProfile?.name?.split(' ')[0] || '';
  const em = emoji || '😊';

  switch (type) {
    case 'farewell_invocation':
      return isVos
        ? `¡Fue un gusto${name ? `, ${name}` : ''}! Si me necesitan: *MIIA ven* ${em}👋`
        : `¡Fue un gusto${name ? `, ${name}` : ''}! Si me necesitan: *MIIA ven* ${em}👋`;
    case 'auto_retire':
      return isVos
        ? `Los dejo que sigan charlando ${em} Si me necesitan: *MIIA ven*! 👋`
        : `Los dejo para que sigan platicando ${em} Si me necesitan: *MIIA ven*! 👋`;
    case 'hola_miia':
      return isVos
        ? `¡Hola${name ? ` ${name}` : ''}! Acá estoy, ${isVos ? 'contame' : 'cuéntame'} ${em}`
        : `¡Hola${name ? ` ${name}` : ''}! Aquí estoy, cuéntame ${em}`;
    case 'chau_miia':
      return isVos
        ? `¡Chau${name ? ` ${name}` : ''}! Cuando quieras volver a hablar: *HOLA MIIA* ${em}`
        : `¡Chao${name ? ` ${name}` : ''}! Cuando quieras volver a hablar: *HOLA MIIA* ${em}`;
    case 'handshake_explain':
      return isVos
        ? `¡Hola${name ? ` ${name}` : ''}! ${em} Soy MIIA${ow ? `, asistente de ${ow}` : ''}. Para charlar conmigo escribí *HOLA MIIA*. ¡Nos vemos! 🙌`
        : `¡Hola${name ? ` ${name}` : ''}! ${em} Soy MIIA${ow ? `, asistente de ${ow}` : ''}. Para hablar conmigo escribe *HOLA MIIA*. ¡Nos vemos! 🙌`;
    default:
      return `${em}`;
  }
}

// Verificar si una fecha es festivo en un país
function isHoliday(date, country) {
  const mm = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  const holidays = HOLIDAYS_BY_COUNTRY[country] || [];
  return holidays.includes(`${mm}-${dd}`);
}

// ═══ HISTORY MINING CAPA 3: Enriquecimiento incremental del contact_index ═══
// Cada mensaje procesado actualiza el perfil del contacto sin pedir historial a WhatsApp.
// Async, non-blocking — no afecta latencia de respuesta.
const _contactIndexUpdateQueue = new Map();
let _contactIndexFlushTimer = null;

function enrichContactIndex(uid, phone, { messageBody, contactType, contactName, isFromContact } = {}) {
  if (!uid || !phone) return;
  const basePhone = phone.split('@')[0].split(':')[0];
  if (!basePhone || basePhone.length < 8) return;

  const existing = _contactIndexUpdateQueue.get(basePhone) || {
    uid,
    lastMessageDate: new Date().toISOString(),
    messageCount: 0,
    ownerMessageCount: 0,
  };

  if (isFromContact) {
    existing.messageCount = (existing.messageCount || 0) + 1;
    existing.lastMessagePreview = (messageBody || '').substring(0, 100);
  } else {
    existing.ownerMessageCount = (existing.ownerMessageCount || 0) + 1;
  }
  if (contactType) existing.type = contactType;
  if (contactName) existing.name = contactName;
  existing.lastMessageDate = new Date().toISOString();
  existing.updatedAt = new Date().toISOString();

  _contactIndexUpdateQueue.set(basePhone, existing);

  // Debounce flush: write to Firestore every 30s (batch)
  if (!_contactIndexFlushTimer) {
    _contactIndexFlushTimer = setTimeout(_flushContactIndex, 30000);
  }
}

async function _flushContactIndex() {
  _contactIndexFlushTimer = null;
  if (_contactIndexUpdateQueue.size === 0) return;

  const batch = admin.firestore().batch();
  let count = 0;
  for (const [basePhone, data] of _contactIndexUpdateQueue) {
    const uid = data.uid;
    delete data.uid; // No guardar uid dentro del doc
    const ref = admin.firestore().collection('users').doc(uid)
      .collection('contact_index').doc(basePhone);
    batch.set(ref, {
      ...data,
      lastEnriched: new Date().toISOString()
    }, { merge: true });
    count++;
    if (count >= 450) break; // Firestore batch limit ~500
  }

  try {
    await batch.commit();
    // Clear processed entries
    let cleared = 0;
    for (const [basePhone] of _contactIndexUpdateQueue) {
      _contactIndexUpdateQueue.delete(basePhone);
      cleared++;
      if (cleared >= count) break;
    }
    console.log(`[CONTACT-INDEX] 📊 Enrichment flush: ${count} contactos actualizados`);
  } catch (e) {
    console.error(`[CONTACT-INDEX] ❌ Error flush: ${e.message}`);
  }

  // If there are more pending, schedule another flush
  if (_contactIndexUpdateQueue.size > 0) {
    _contactIndexFlushTimer = setTimeout(_flushContactIndex, 30000);
  }
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

    const followUpOwner = userProfile?.shortName || userProfile?.name || 'el asesor';
    const followUpBiz = userProfile?.businessName || '';
    const followUpPrompt = `Eres MIIA, asistente de ventas${followUpBiz ? ` de ${followUpBiz}` : ''}. El lead "${leadName}" recibió una cotización hace más de 3 días y no ha respondido.

Historial reciente de la conversación:
${historyText}

Escribí UN mensaje de seguimiento breve (máximo 3 líneas) para revivir el interés. Usá algún gancho relacionado a la conversación (su tipo de clínica, el problema que mencionó, la urgencia de la promo, etc). Soná como si ${followUpOwner} escribiera desde su celular — natural, directo, no robótico. NO menciones que sos una IA. NO uses "estimado" ni lenguaje formal. NO repitas la cotización. Solo buscá reabrir la conversación.`;

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

    // ── 4. Contactos pendientes de identificar (persisten hasta resolución/desvinculación) ──
    let pendingContactsSection = '';
    try {
      // Leer pendientes del owner principal
      const pendingDoc = await admin.firestore().collection('users').doc(OWNER_UID)
        .collection('miia_persistent').doc('pending_lids').get();
      if (pendingDoc.exists) {
        const pendingData = pendingDoc.data() || {};
        const waitingOwner = Object.entries(pendingData)
          .filter(([, p]) => p && p.phase === 'waiting_owner')
          .slice(0, 10);
        if (waitingOwner.length > 0) {
          pendingContactsSection = `\n\n*📇 CONTACTOS PENDIENTES DE IDENTIFICAR (${waitingOwner.length}):*\n`;
          for (const [, p] of waitingOwner) {
            const name = p.pushName || 'Sin nombre';
            const preview = (p.firstMsg || '').substring(0, 80);
            const daysAgo = Math.floor((Date.now() - (p.startedAt || Date.now())) / (24 * 60 * 60 * 1000));
            const timeHint = daysAgo > 0 ? ` (hace ${daysAgo} día${daysAgo > 1 ? 's' : ''})` : ' (hoy)';
            pendingContactsSection += `▸ *${name}*${timeHint}: _"${preview}${preview.length >= 80 ? '...' : ''}"_\n`;
          }
          pendingContactsSection += `\nDecime quién es cada uno para clasificarlos. Persisten hasta que los clasifiques o desvinculen.`;
        }
      }
      // También buscar en tenants conectados
      const tmModule = require('./whatsapp/tenant_manager');
      const allTenants = tmModule.getAllTenants();
      for (const [tUid, tData] of allTenants) {
        if (tUid === OWNER_UID) continue; // ya procesado arriba
        if (!tData._pendingLids) continue;
        const waiting = Object.entries(tData._pendingLids)
          .filter(([, p]) => p && p.phase === 'waiting_owner');
        if (waiting.length > 0 && !pendingContactsSection) {
          pendingContactsSection = `\n\n*📇 CONTACTOS PENDIENTES DE IDENTIFICAR:*\n`;
        }
        // No duplicar si ya se agregó
      }
      console.log(`[BRIEFING] Contactos pendientes: ${pendingContactsSection ? 'SÍ' : 'ninguno'}`);
    } catch (e) {
      console.error('[BRIEFING] Error cargando contactos pendientes:', e.message);
    }

    // ── 5. Siempre enviar algo — incluso si no hay novedades ──
    const briefingName = userProfile?.shortName || userProfile?.name?.split(' ')[0] || '';

    if (!scraperResults.length && !leadsSection && !approvalsSection && !pendingContactsSection) {
      // Sin novedades: generar saludo natural con IA (no hardcodeado)
      try {
        const dayOfWeek = bogotaNow.toLocaleDateString('es-ES', { weekday: 'long' });
        const noNewsPrompt = `Eres MIIA, asistente personal de ${briefingName || 'tu owner'}. Es ${dayOfWeek} por la mañana. No hay novedades, ni leads pendientes, ni recordatorios urgentes. Genera un saludo matutino breve y cálido (máximo 2 líneas) mencionando que no hay pendientes y deseándole buen día. Sé natural, no robótica. NO uses asteriscos ni formato Markdown.`;
        const aiResponse = await aiGateway.generateContent(noNewsPrompt, null, { maxTokens: 100 });
        const greeting = (aiResponse?.text || `Buenos días${briefingName ? `, ${briefingName}` : ''}. Todo tranquilo por acá, no hay pendientes. ¡Que tengas un excelente día!`).trim();
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `🌅 ${greeting}`, { isSelfChat: true });
        console.log(`[BRIEFING] ✅ Saludo matutino sin novedades enviado`);
      } catch (e) {
        // Fallback simple si la IA falla
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `🌅 Buenos días${briefingName ? `, ${briefingName}` : ''}. Todo tranquilo por acá, no hay pendientes ni novedades. ¡Que tengas un excelente día! 😊`, { isSelfChat: true });
        console.log(`[BRIEFING] ✅ Saludo matutino fallback enviado (IA falló: ${e.message})`);
      }
      return;
    }

    let briefing = `🌅 *Buenos días${briefingName ? `, ${briefingName}` : ''}.* Aquí tu resumen matutino de MIIA:`;

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

    // Sección contactos pendientes de identificar
    if (pendingContactsSection) briefing += pendingContactsSection;

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
        const d = ownerDoc.exists ? ownerDoc.data() : {};
        adnConsentOk = d.consent_adn === true || d.dna_consent === true;
      } else {
        // Fallback: buscar primer usuario con role admin y consent_adn
        const snap = await admin.firestore().collection('users')
          .where('role', 'in', ['admin', 'owner', 'client'])
          .where('dna_consent', '==', true)
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

// Endpoint para aprender el centro de ayuda del negocio (ej: ayuda.softwaremedilink.com)
app.post('/api/cerebro/learn-helpcenter', async (_req, res) => {
  const hcBizName = userProfile?.businessName || 'el negocio';
  res.json({ success: true, message: `Iniciando aprendizaje del centro de ayuda de ${hcBizName}...` });
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
          const hcBiz2 = userProfile?.businessName || 'el negocio';
          const prompt = `Sos MIIA, asistente de ventas de ${hcBiz2}. Resumí el siguiente artículo del centro de ayuda en máximo 200 palabras, en un formato que te permita recordar y explicar esta funcionalidad a futuros leads. Incluí el link del artículo: ${url}\n\nContenido:\n${text}`;
          const summary = await generateAIContent(prompt);
          if (summary && summary.length > 50) {
            cerebroAbsoluto.appendLearning(`[CENTRO DE AYUDA - ${url}]\n${summary}`, 'HELPCENTER');
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
      const hcBiz3 = userProfile?.businessName || 'Centro de Ayuda';
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ *${hcBiz3}* — Aprendí ${learned} artículos del Centro de Ayuda. Ya puedo responder preguntas basándome en ellos.`, { isSelfChat: true }).catch(() => {});
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
    const trainOwner = userProfile?.shortName || userProfile?.name?.split(' ')[0] || 'Owner';
    const historyStr = history.slice(-10).map(m => `${m.role === 'user' ? trainOwner : 'MIIA'}: ${m.content}`).join('\n');

    const hasProducts = adnStr && (adnStr.includes('precio') || adnStr.includes('servicio') || adnStr.includes('producto') || adnStr.includes('costo') || adnStr.includes('tarifa') || adnStr.length > 200);
    const cotizacionKeywords = /cotizaci[oó]n|presupuesto|precio|cuanto.*cobr|cuanto.*cost|lista.*precio|tarifas/i;
    const isCotizacionRequest = cotizacionKeywords.test(message);

    let cotizacionWarning = '';
    if (isCotizacionRequest && !hasProducts) {
      cotizacionWarning = `\n\nIMPORTANTE: ${trainOwner} te pide algo relacionado a cotizaciones/precios, pero NO tenés productos, precios ni servicios cargados todavía. Decile amablemente que primero necesitás que te enseñe: qué servicios/productos ofrece, los precios, y las reglas de cotización. Sugerile usar "APRENDE:" o simplemente contarte en el chat. Sé proactiva ofreciendo ayuda paso a paso.`;
    }

    const prompt = `# PROMPT MAESTRO — MIIA Admin Chat
Sos MIIA, asistente de ${trainOwner}. Estás en el panel de entrenamiento donde ${trainOwner} puede conversar con vos, hacerte preguntas, testear respuestas, y enseñarte cosas nuevas.

ANTI-BOT: NUNCA empieces con "Entendido", "Perfecto", "Claro", "Por supuesto". Variá la estructura. Sé natural, directa, humana.

AUTO-APRENDIZAJE: Si en la conversación ${trainOwner} te cuenta información NUEVA sobre su negocio (productos, precios, clientes, reglas de venta, procedimientos, información importante), incluí al FINAL de tu respuesta el tag [GUARDAR_APRENDIZAJE:texto breve a guardar]. Solo si la info es genuinamente nueva y útil para recordar en futuros chats de WhatsApp. No guardes preguntas, tests, ni información obvia. Para información que ${trainOwner} quiere guardar explícitamente, usa el prefijo APRENDE: que dispara el guardado directo.

ARCHIVOS ADJUNTOS: Si el mensaje incluye "[Archivo adjunto:" o contenido de archivo, analizalo en detalle. Si es una lista de precios, estructura de cotización, o catálogo, aprendé la información relevante y guardala con [GUARDAR_APRENDIZAJE:].
${cotizacionWarning}

## Tu conocimiento actual:
${adnStr || '(sin aprendizajes cargados aún — decile a ' + trainOwner + ' que te enseñe sobre su negocio)'}

## Historial de esta sesión:
${historyStr || '(inicio de sesión)'}

## ${trainOwner} dice ahora:
${message}

Respondé natural, concisa y útil. Si pregunta qué sabés, mostrá ejemplos concretos de lo que tenés cargado. Si no sabés algo, decilo honestamente y pedile que te enseñe.`;

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
      const trainOwner2 = userProfile?.shortName || userProfile?.name?.split(' ')[0] || 'El owner';
      const confirmPrompt = `Eres MIIA. ${trainOwner2} acaba de enseñarte: "${knowledgeToSave}". Confirma en 1 oración que lo entendiste y guardaste.`;
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
// P3 — SLOTS, PRIVACY, WEEKEND, MIGRATION, REPORTS
// ============================================

// ── Slots CRUD (P3.2) ──
app.get('/api/tenant/:uid/slots', async (req, res) => {
  try {
    const slots = await slotPrivacy.getSlots(req.params.uid);
    res.json(slots);
  } catch (e) {
    console.error(`[SLOTS] Error listing:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tenant/:uid/slots', express.json(), async (req, res) => {
  try {
    const slot = await slotPrivacy.createSlot(req.params.uid, req.body);
    res.json(slot);
  } catch (e) {
    console.error(`[SLOTS] Error creating:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/tenant/:uid/slots/:slotId', express.json(), async (req, res) => {
  try {
    await slotPrivacy.updateSlotPrivacy(req.params.uid, req.params.slotId, req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[SLOTS] Error updating:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tenant/:uid/slots/:slotId', async (req, res) => {
  try {
    await slotPrivacy.deleteSlot(req.params.uid, req.params.slotId);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[SLOTS] Error deleting:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Weekend mode estado (P3.4) ──
app.get('/api/tenant/:uid/weekend-mode', (req, res) => {
  res.json(weekendMode.getWeekendState(req.params.uid));
});

app.post('/api/tenant/:uid/weekend-mode', express.json(), (req, res) => {
  const tz = req.body.timezone || 'America/Bogota';
  const result = weekendMode.processWeekendResponse(req.params.uid, req.body.action || 'finde off', tz);
  res.json(result);
});

// ── Probadita stats (P3.5) ──
app.get('/api/tenant/:uid/probadita/stats', async (req, res) => {
  try {
    const stats = await probadita.getStats(req.params.uid);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Number migration (P3.6) ──
app.post('/api/tenant/:uid/migrate-number', express.json(), async (req, res) => {
  try {
    const { oldPhone, newPhone } = req.body;
    if (!oldPhone || !newPhone) return res.status(400).json({ error: 'oldPhone y newPhone requeridos' });
    console.log(`[API] 🔄 Migración de número solicitada: ${oldPhone} → ${newPhone} (uid: ${req.params.uid})`);

    // Paso 1: Notificar contactos
    const sendFn = async (jid, msg) => {
      // Usar el tenant manager para enviar desde el número viejo
      const migSock = tenantManager.getTenantClient(req.params.uid);
      if (migSock) {
        await migSock.sendMessage(jid, { text: msg });
      }
    };
    const step1 = await numberMigration.startMigration(req.params.uid, oldPhone, newPhone, sendFn);

    // Paso 2: Migrar datos Firestore
    const step2 = await numberMigration.migrateFirestoreData(req.params.uid);

    // Paso 3: Log de auditoría
    await numberMigration.logMigration(req.params.uid);

    res.json({ success: true, step1, step2, message: 'Migración completada. Reconectá WhatsApp con el nuevo número.' });
  } catch (e) {
    console.error(`[API] ❌ Migración error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tenant/:uid/migrate-number/status', (req, res) => {
  const state = numberMigration.getMigrationState(req.params.uid);
  res.json(state || { status: 'none' });
});

// ── Privacy report (P3.7) ──
app.get('/api/tenant/:uid/privacy-report', async (req, res) => {
  try {
    const report = await privacyReport.generateReport(req.params.uid);
    res.json(report);
  } catch (e) {
    console.error(`[PRIVACY-REPORT] ❌ API error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tenant/:uid/privacy-reports', async (req, res) => {
  try {
    const reports = await privacyReport.listReports(req.params.uid);
    res.json(reports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Audit logs (P4.1 + P4.2) ──
app.get('/api/tenant/:uid/audit-logs', async (req, res) => {
  try {
    const { type, limit } = req.query;
    const logs = await auditLogger.getAccessLogs(req.params.uid, {
      type: type || undefined,
      limit: parseInt(limit) || 50
    });
    auditLogger.logAccess(req.params.uid, {
      type: auditLogger.ACCESS_TYPES.VIEW_PRIVACY_REPORT,
      actor: req.params.uid,
      actorRole: 'owner',
      resource: '/audit-logs'
    });
    res.json(logs);
  } catch (e) {
    console.error(`[AUDIT] ❌ API error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tenant/:uid/audit-summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const summary = await auditLogger.getAccessSummary(req.params.uid, days);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const { validateKeyword } = require('./core/contact_gate');

    // Validar keywords contra blacklist (server-side, no confiar solo en frontend)
    const allKws = [...(lead_keywords || []), ...(client_keywords || [])];
    const invalid = allKws.map(kw => ({ kw, ...validateKeyword(kw) })).filter(r => !r.valid);
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'Keywords inválidas', details: invalid.map(i => ({ keyword: i.kw, reason: i.reason })) });
    }

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

// ═══════════════════════════════════════════════════════════════════════════════
// BUSINESSES CRUD — Multi-negocio por owner (FASE 1)
// Estructura: users/{uid}/businesses/{bizId}
// ═══════════════════════════════════════════════════════════════════════════════

const db = admin.firestore();

// GET /api/tenant/:uid/businesses — Listar todos los negocios del owner
// Si no hay negocios pero sí hay training data (owner legacy), auto-crear el negocio por defecto
app.get('/api/tenant/:uid/businesses', async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await db.collection('users').doc(uid).collection('businesses').get();
    let businesses = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ═══ AUTO-MIGRACIÓN: si no hay negocios, intentar crear uno desde datos legacy ═══
    if (businesses.length === 0) {
      console.log(`[BIZ] ⚠️ ${uid} sin negocios — intentando auto-migración desde datos legacy`);
      try {
        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        // Buscar training data legacy
        const brainDoc = await db.collection('users').doc(uid)
          .collection('miia_persistent').doc('training_data').get();
        const hasBrain = brainDoc.exists && brainDoc.data()?.content;
        // Buscar nombre del negocio en el cerebro o en el perfil
        let bizName = userData.businessName || userData.name || 'Mi Negocio';
        // Si hay algún dato que sugiera un negocio existente → crear automáticamente
        if (userData.name || hasBrain || userData.role) {
          const newBiz = {
            name: bizName,
            description: userData.businessDescription || userData.role || '',
            ownerRole: userData.role || '',
            email: userData.email || '',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            autoMigrated: true
          };
          const docRef = await db.collection('users').doc(uid).collection('businesses').add(newBiz);
          // Copiar cerebro al negocio si existe
          if (hasBrain) {
            await db.collection('users').doc(uid).collection('businesses').doc(docRef.id)
              .collection('brain').doc('business_cerebro')
              .set({ content: brainDoc.data().content, updatedAt: new Date().toISOString() });
          }
          // Setear como default
          await db.collection('users').doc(uid).update({ defaultBusinessId: docRef.id });
          console.log(`[BIZ] ✅ Auto-migración: creado "${bizName}" (${docRef.id}) para ${uid}`);
          businesses = [{ id: docRef.id, ...newBiz }];
        }
      } catch (migErr) {
        console.error(`[BIZ] ⚠️ Error en auto-migración:`, migErr.message);
      }
    }

    businesses.sort((a, b) => {
      const ta = a.createdAt?._seconds || a.createdAt?.seconds || 0;
      const tb = b.createdAt?._seconds || b.createdAt?.seconds || 0;
      return tb - ta;
    });
    console.log(`[BIZ] 📋 Listados ${businesses.length} negocios para ${uid}`);
    res.json(businesses);
  } catch (e) {
    console.error(`[BIZ] ❌ Error listando negocios:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/businesses — Crear nuevo negocio
app.post('/api/tenant/:uid/businesses', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, email, address, website, demoLink, description, whatsapp_number, ownerRole } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name es requerido' });

    const bizData = {
      name: name.trim(),
      email: (email || '').trim(),
      address: (address || '').trim(),
      website: (website || '').trim(),
      demoLink: (demoLink || '').trim(),
      description: (description || '').trim(),
      whatsapp_number: (whatsapp_number || '').trim(),
      ownerRole: (ownerRole || '').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const docRef = await db.collection('users').doc(uid).collection('businesses').add(bizData);
    console.log(`[BIZ] ✅ Negocio creado: ${bizData.name} (${docRef.id}) para ${uid}`);

    // Si es el primer negocio, setearlo como default
    const allBiz = await db.collection('users').doc(uid).collection('businesses').get();
    if (allBiz.size === 1) {
      await db.collection('users').doc(uid).update({ defaultBusinessId: docRef.id });
      console.log(`[BIZ] 📌 Seteado como negocio default para ${uid}`);
    }

    res.json({ success: true, id: docRef.id, business: { id: docRef.id, ...bizData } });
  } catch (e) {
    console.error(`[BIZ] ❌ Error creando negocio:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tenant/:uid/businesses/:bizId — Obtener un negocio
app.get('/api/tenant/:uid/businesses/:bizId', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await db.collection('users').doc(uid).collection('businesses').doc(bizId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/businesses/:bizId — Actualizar negocio
app.put('/api/tenant/:uid/businesses/:bizId', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const allowed = ['name', 'email', 'address', 'website', 'demoLink', 'description', 'whatsapp_number', 'ownerRole'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = typeof req.body[key] === 'string' ? req.body[key].trim() : req.body[key];
    }
    updates.updatedAt = new Date().toISOString();

    await db.collection('users').doc(uid).collection('businesses').doc(bizId).update(updates);
    console.log(`[BIZ] ✏️ Negocio ${bizId} actualizado para ${uid}`);
    res.json({ success: true });
  } catch (e) {
    console.error(`[BIZ] ❌ Error actualizando negocio:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tenant/:uid/businesses/:bizId — Eliminar negocio
app.delete('/api/tenant/:uid/businesses/:bizId', async (req, res) => {
  try {
    const { uid, bizId } = req.params;

    // No permitir borrar el default si es el único
    const allBiz = await db.collection('users').doc(uid).collection('businesses').get();
    if (allBiz.size <= 1) return res.status(400).json({ error: 'No puedes eliminar tu único negocio' });

    // Borrar subcolecciones del negocio
    const subcollections = ['products', 'sessions'];
    for (const sub of subcollections) {
      const subSnap = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection(sub).get();
      const batch = db.batch();
      subSnap.docs.forEach(d => batch.delete(d.ref));
      if (!subSnap.empty) await batch.commit();
    }
    // Borrar docs individuales
    for (const docName of ['brain/business_cerebro', 'contact_rules', 'payment_methods']) {
      try { await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('brain').doc('business_cerebro').delete(); } catch(e) {}
    }

    await db.collection('users').doc(uid).collection('businesses').doc(bizId).delete();

    // Si era el default, asignar otro
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.data()?.defaultBusinessId === bizId) {
      const remaining = await db.collection('users').doc(uid).collection('businesses').limit(1).get();
      if (!remaining.empty) {
        await db.collection('users').doc(uid).update({ defaultBusinessId: remaining.docs[0].id });
      }
    }

    console.log(`[BIZ] 🗑️ Negocio ${bizId} eliminado para ${uid}`);
    res.json({ success: true });
  } catch (e) {
    console.error(`[BIZ] ❌ Error eliminando negocio:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Business-scoped training endpoints ──────────────────────────────────────

// Products scoped to business
app.get('/api/tenant/:uid/businesses/:bizId/products', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const snap = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('products').orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenant/:uid/businesses/:bizId/products', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
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

    const docRef = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('products').add(productData);

    // Inject into tenant brain
    const learningText = `[${bizId}] Producto: ${productData.name} — ${productData.description}. Precio: ${productData.price}${productData.pricePromo ? ` (Promo: ${productData.pricePromo})` : ''}`;
    tenantManager.appendTenantTraining(uid, learningText);

    console.log(`[BIZ] ✅ Producto "${name}" creado en negocio ${bizId}`);
    res.json({ success: true, id: docRef.id, product: productData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tenant/:uid/businesses/:bizId/products/:productId', async (req, res) => {
  try {
    const { uid, bizId, productId } = req.params;
    await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('products').doc(productId).delete();
    await rebuildTenantBrainFromFirestore(uid);
    console.log(`[BIZ] 🗑️ Producto ${productId} eliminado de negocio ${bizId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Brain (cerebro) scoped to business
app.get('/api/tenant/:uid/businesses/:bizId/brain', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('brain').doc('business_cerebro').get();
    res.json(doc.exists ? doc.data() : { content: '', updatedAt: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tenant/:uid/businesses/:bizId/brain', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { content } = req.body;
    await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('brain').doc('business_cerebro').set({
      content: content || '',
      updatedAt: new Date().toISOString()
    });
    console.log(`[BIZ] 🧠 Cerebro actualizado para negocio ${bizId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Contact rules scoped to business
app.get('/api/tenant/:uid/businesses/:bizId/contact-rules', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('config').doc('contact_rules').get();
    res.json(doc.exists ? doc.data() : { lead_keywords: [], client_keywords: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenant/:uid/businesses/:bizId/contact-rules', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { lead_keywords, client_keywords } = req.body;
    await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('config').doc('contact_rules').set({
      lead_keywords: lead_keywords || [],
      client_keywords: client_keywords || [],
      updatedAt: new Date().toISOString()
    });
    console.log(`[BIZ] 📋 Contact rules actualizadas para negocio ${bizId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Payment methods scoped to business
app.get('/api/tenant/:uid/businesses/:bizId/payment-methods', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const doc = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('config').doc('payment_methods').get();
    res.json(doc.exists ? (doc.data().methods || []) : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenant/:uid/businesses/:bizId/payment-methods', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { methods } = req.body;
    if (!Array.isArray(methods)) return res.status(400).json({ error: 'methods array required' });

    await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('config').doc('payment_methods').set({
      methods,
      updatedAt: new Date().toISOString()
    });
    console.log(`[BIZ] 💰 Payment methods actualizados para negocio ${bizId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Training sessions scoped to business
app.get('/api/tenant/:uid/businesses/:bizId/sessions', async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const snap = await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('sessions').orderBy('date', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenant/:uid/businesses/:bizId/sessions', express.json(), async (req, res) => {
  try {
    const { uid, bizId } = req.params;
    const { date, messages, trainingBlock, summary } = req.body;
    if (!date) return res.status(400).json({ error: 'date requerido' });

    await db.collection('users').doc(uid).collection('businesses').doc(bizId).collection('sessions').doc(date).set({
      date, messages: messages || [], trainingBlock: trainingBlock || '', summary: summary || '',
      createdAt: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTACT GROUPS CRUD — Grupos dinámicos de contactos (FASE 1)
// Estructura: users/{uid}/contact_groups/{groupId}
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/tenant/:uid/contact-groups — Listar todos los grupos
app.get('/api/tenant/:uid/contact-groups', async (req, res) => {
  try {
    const { uid } = req.params;
    const groupsRef = db.collection('users').doc(uid).collection('contact_groups');
    let snap = await groupsRef.get();

    // Auto-create default groups if none exist
    if (snap.empty) {
      console.log(`[GROUPS] 🔧 Auto-creando grupos predeterminados para ${uid}`);
      const defaults = [
        { id: 'familia', name: 'Familia', icon: '👨‍👩‍👧‍👦', tone: 'Habla con cariño y confianza, como un amigo cercano de la familia.', autoRespond: false, proactiveEnabled: false },
        { id: 'equipo', name: 'Equipo', icon: '👥', tone: 'Habla profesional pero amigable, como un compañero de trabajo.', autoRespond: false, proactiveEnabled: false }
      ];
      for (const g of defaults) {
        await groupsRef.doc(g.id).set({ name: g.name, icon: g.icon, tone: g.tone, autoRespond: g.autoRespond, proactiveEnabled: g.proactiveEnabled, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      // Also migrate legacy familyContacts if they exist
      try {
        const legacyFam = await db.collection('users').doc(uid).collection('miia_persistent').doc('contacts').get();
        if (legacyFam.exists) {
          const famData = legacyFam.data();
          if (famData && famData.familyContacts && Array.isArray(famData.familyContacts)) {
            for (const fc of famData.familyContacts) {
              if (fc.phone) {
                await groupsRef.doc('familia').collection('contacts').doc(fc.phone).set({
                  name: fc.name || '', phone: fc.phone, notes: fc.notes || '', proactiveEnabled: !!fc.proactiveEnabled, addedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }
            }
            console.log(`[GROUPS] ✅ Migrados ${famData.familyContacts.length} contactos familiares`);
          }
        }
      } catch (migErr) { console.error('[GROUPS] ⚠️ Error migrando familia:', migErr.message); }
      snap = await groupsRef.get();
    }

    const groups = [];
    for (const doc of snap.docs) {
      const contactsSnap = await groupsRef.doc(doc.id).collection('contacts').get();
      groups.push({ id: doc.id, ...doc.data(), contactCount: contactsSnap.size });
    }
    console.log(`[GROUPS] 📋 Listados ${groups.length} grupos para ${uid}`);
    res.json(groups);
  } catch (e) {
    console.error(`[GROUPS] ❌ Error listando grupos:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tenant/:uid/contact-groups — Crear grupo
app.post('/api/tenant/:uid/contact-groups', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, icon, tone, autoRespond, proactiveEnabled } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name es requerido' });

    const groupData = {
      name: name.trim(),
      icon: icon || '👥',
      tone: (tone || '').trim(),
      autoRespond: autoRespond === true ? true : false,
      proactiveEnabled: proactiveEnabled === true ? true : false,
      createdAt: new Date().toISOString()
    };

    const docRef = await db.collection('users').doc(uid).collection('contact_groups').add(groupData);
    console.log(`[GROUPS] ✅ Grupo "${name}" creado (${docRef.id}) para ${uid}`);
    res.json({ success: true, id: docRef.id, group: { id: docRef.id, ...groupData } });
  } catch (e) {
    console.error(`[GROUPS] ❌ Error creando grupo:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/tenant/:uid/contact-groups/:groupId — Actualizar grupo
app.put('/api/tenant/:uid/contact-groups/:groupId', express.json(), async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    const allowed = ['name', 'icon', 'tone', 'autoRespond', 'proactiveEnabled'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = new Date().toISOString();

    await db.collection('users').doc(uid).collection('contact_groups').doc(groupId).update(updates);
    console.log(`[GROUPS] ✏️ Grupo ${groupId} actualizado`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tenant/:uid/contact-groups/:groupId — Eliminar grupo
app.delete('/api/tenant/:uid/contact-groups/:groupId', async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    // Borrar contactos dentro del grupo
    const contactsSnap = await db.collection('users').doc(uid).collection('contact_groups').doc(groupId).collection('contacts').get();
    if (!contactsSnap.empty) {
      const batch = db.batch();
      contactsSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await db.collection('users').doc(uid).collection('contact_groups').doc(groupId).delete();

    // Limpiar contact_index entries que apuntan a este grupo
    const indexSnap = await db.collection('users').doc(uid).collection('contact_index').where('groupId', '==', groupId).get();
    if (!indexSnap.empty) {
      const batch2 = db.batch();
      indexSnap.docs.forEach(d => batch2.delete(d.ref));
      await batch2.commit();
    }

    console.log(`[GROUPS] 🗑️ Grupo ${groupId} eliminado para ${uid}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tenant/:uid/contact-groups/:groupId/contacts — Listar contactos del grupo
app.get('/api/tenant/:uid/contact-groups/:groupId/contacts', async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    const snap = await db.collection('users').doc(uid).collection('contact_groups').doc(groupId).collection('contacts').orderBy('addedAt', 'desc').get();
    res.json(snap.docs.map(d => ({ phone: d.id, ...d.data() })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tenant/:uid/contact-groups/:groupId/contacts — Agregar contacto al grupo
app.post('/api/tenant/:uid/contact-groups/:groupId/contacts', express.json(), async (req, res) => {
  try {
    const { uid, groupId } = req.params;
    const { phone, name, notes, proactiveEnabled } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone es requerido' });

    const contactData = {
      name: (name || '').trim(),
      notes: (notes || '').trim(),
      proactiveEnabled: proactiveEnabled === true ? true : false,
      addedAt: new Date().toISOString()
    };

    await db.collection('users').doc(uid).collection('contact_groups').doc(groupId).collection('contacts').doc(phone).set(contactData);

    // Actualizar contact_index
    await db.collection('users').doc(uid).collection('contact_index').doc(phone).set({
      type: 'group',
      groupId,
      name: contactData.name,
      updatedAt: new Date().toISOString()
    });

    console.log(`[GROUPS] ✅ Contacto ${phone} (${name}) agregado al grupo ${groupId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tenant/:uid/contact-groups/:groupId/contacts/:phone — Quitar contacto del grupo
app.delete('/api/tenant/:uid/contact-groups/:groupId/contacts/:phone', async (req, res) => {
  try {
    const { uid, groupId, phone } = req.params;
    await db.collection('users').doc(uid).collection('contact_groups').doc(groupId).collection('contacts').doc(phone).delete();
    await db.collection('users').doc(uid).collection('contact_index').doc(phone).delete();
    console.log(`[GROUPS] 🗑️ Contacto ${phone} eliminado del grupo ${groupId}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTACT INDEX — Clasificación rápida de contactos
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/tenant/:uid/contact-index/:phone — Obtener clasificación de un contacto
app.get('/api/tenant/:uid/contact-index/:phone', async (req, res) => {
  try {
    const { uid, phone } = req.params;
    const doc = await db.collection('users').doc(uid).collection('contact_index').doc(phone).get();
    if (!doc.exists) return res.json({ classified: false });
    res.json({ classified: true, ...doc.data() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tenant/:uid/contact-index/:phone — Clasificar un contacto
app.post('/api/tenant/:uid/contact-index/:phone', express.json(), async (req, res) => {
  try {
    const { uid, phone } = req.params;
    const { type, groupId, businessId, name } = req.body;
    if (!type) return res.status(400).json({ error: 'type es requerido (group|lead|pending)' });

    await db.collection('users').doc(uid).collection('contact_index').doc(phone).set({
      type, groupId: groupId || null, businessId: businessId || null,
      name: (name || '').trim(),
      updatedAt: new Date().toISOString()
    });
    console.log(`[INDEX] ✅ Contacto ${phone} clasificado como ${type}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Security Contacts — Contactos de Seguridad Bidireccionales ─────────────

// GET /api/tenant/:uid/security-contacts — Listar contactos de seguridad
app.get('/api/tenant/:uid/security-contacts', async (req, res) => {
  try {
    const contacts = await securityContacts.getSecurityContacts(req.params.uid);
    res.json(contacts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tenant/:uid/security-contacts — Solicitar vinculación
app.post('/api/tenant/:uid/security-contacts', express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { protectedUid, level, protectorName, protectorPhone, protectedName, protectedPhone, protectedAge } = req.body;
    if (!protectedUid) return res.status(400).json({ error: 'protectedUid es requerido' });
    if (!level) return res.status(400).json({ error: 'level es requerido (emergencies_only|agenda_visible|full_supervision)' });

    const result = await securityContacts.requestProtection(uid, protectedUid, level, {
      protectorName, protectorPhone, protectedName, protectedPhone, protectedAge
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /api/tenant/:uid/security-contacts/:relationId/respond — Aceptar/rechazar
app.put('/api/tenant/:uid/security-contacts/:relationId/respond', express.json(), async (req, res) => {
  try {
    const { uid, relationId } = req.params;
    const { accept } = req.body;
    if (accept === undefined) return res.status(400).json({ error: 'accept (true/false) es requerido' });
    const result = await securityContacts.respondToRequest(uid, relationId, accept);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /api/tenant/:uid/security-contacts/:relationId/level — Cambiar nivel
app.put('/api/tenant/:uid/security-contacts/:relationId/level', express.json(), async (req, res) => {
  try {
    const { uid, relationId } = req.params;
    const { level } = req.body;
    if (!level) return res.status(400).json({ error: 'level es requerido' });
    const result = await securityContacts.updateLevel(uid, relationId, level);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/tenant/:uid/security-contacts/:relationId — Desvincular
app.delete('/api/tenant/:uid/security-contacts/:relationId', async (req, res) => {
  try {
    const { uid, relationId } = req.params;
    const result = await securityContacts.unlinkSecurityContact(uid, relationId, 'manual');
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/tenant/:uid/security-contacts/:relationId/data — Consultar datos del protegido
app.get('/api/tenant/:uid/security-contacts/:relationId/data', async (req, res) => {
  try {
    const { uid, relationId } = req.params;
    const relation = await securityContacts.getSecurityContact(uid, relationId);
    if (!relation) return res.status(404).json({ error: 'Relación no encontrada' });
    const result = await securityContacts.getProtectedData(uid, relation.partnerUid, relationId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// ═══ CONFIG VALIDATOR — Endpoint para dashboard ═══
app.get('/api/tenant/:uid/config-check', async (req, res) => {
  try {
    const { uid } = req.params;
    const alerts = await configValidator.validateConfig(uid);
    res.json({ success: true, alerts, count: alerts.length });
  } catch (err) {
    console.error(`[CONFIG-VALIDATOR] ❌ Endpoint error: ${err.message}`);
    res.status(500).json({ error: 'Error validando configuración' });
  }
});

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
    const testResult = await aiGateway.smartCall(
      aiGateway.CONTEXTS.GENERAL,
      testPrompt,
      { aiProvider: provider, aiApiKey: apiKey.trim() },
      { maxTokens: 64 }
    );

    if (!testResult.text) {
      return res.status(400).json({ error: 'No se recibió respuesta del proveedor. Verifica tu API key.' });
    }

    res.json({
      success: true,
      provider: testResult.provider,
      providerLabel: PROVIDER_LABELS[provider],
      response: testResult.text.substring(0, 100),
      latencyMs: testResult.latencyMs,
      failedOver: testResult.failedOver
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

// ═══ DELETE /api/tenant/:uid/account — Owner elimina su propia cuenta ═══
// Requiere confirmación: body.confirm === 'ELIMINAR MI CUENTA'
app.delete('/api/tenant/:uid/account', verifyTenantAuth, auditLogger.auditMiddleware(auditLogger.ACCESS_TYPES.DELETE_ACCOUNT), express.json(), async (req, res) => {
  try {
    const { uid } = req.params;
    const { confirm: confirmation } = req.body || {};

    // Solo el propio usuario puede eliminar su cuenta (no admin vía este endpoint)
    if (req.user.uid !== uid) {
      console.log(`[ACCOUNT-DELETE] ❌ Intento de eliminar cuenta ajena: ${req.user.uid} → ${uid}`);
      return res.status(403).json({ error: 'Solo puedes eliminar tu propia cuenta' });
    }

    if (confirmation !== 'ELIMINAR MI CUENTA') {
      return res.status(400).json({ error: 'Debes confirmar con el texto exacto: ELIMINAR MI CUENTA' });
    }

    console.log(`[ACCOUNT-DELETE] 🗑️ Iniciando eliminación de cuenta uid=${uid} (${req.user.email})`);

    // 1. Destruir sesión WhatsApp del tenant
    try {
      await tenantManager.destroyTenant(uid);
      console.log(`[ACCOUNT-DELETE] ✅ Sesión WhatsApp destruida`);
    } catch (e) {
      console.log(`[ACCOUNT-DELETE] ⚠️ No se pudo destruir sesión WA: ${e.message}`);
    }

    const userRef = admin.firestore().collection('users').doc(uid);

    // 2. Eliminar subcollections del usuario (estructura multi-negocio)
    const subcollections = [
      'businesses', 'contact_groups', 'contact_index',
      'personal', 'settings', 'miia_sports', 'miia_interests'
    ];

    for (const subName of subcollections) {
      try {
        const subSnap = await userRef.collection(subName).get();
        if (!subSnap.empty) {
          // Para businesses, también borrar sub-subcollections
          if (subName === 'businesses') {
            for (const bizDoc of subSnap.docs) {
              const bizSubcols = ['brain', 'products', 'sessions'];
              for (const bsc of bizSubcols) {
                const bscSnap = await bizDoc.ref.collection(bsc).get();
                for (const d of bscSnap.docs) await d.ref.delete();
              }
              // contact_rules y payment_methods son docs directos
              try { await bizDoc.ref.collection('contact_rules').doc('rules').delete(); } catch (_) {}
              try { await bizDoc.ref.collection('payment_methods').doc('methods').delete(); } catch (_) {}
            }
          }
          // Para contact_groups, borrar contacts sub-subcollection
          if (subName === 'contact_groups') {
            for (const groupDoc of subSnap.docs) {
              const contactsSnap = await groupDoc.ref.collection('contacts').get();
              for (const d of contactsSnap.docs) await d.ref.delete();
            }
          }
          // Borrar docs de la subcollection
          for (const doc of subSnap.docs) await doc.ref.delete();
        }
      } catch (e) {
        console.log(`[ACCOUNT-DELETE] ⚠️ Error borrando ${subName}: ${e.message}`);
      }
    }

    // 3. Eliminar colecciones legacy top-level
    const legacyCollections = ['training_products', 'training_sessions', 'contact_rules', 'payment_methods'];
    for (const col of legacyCollections) {
      try {
        const docRef = admin.firestore().collection(col).doc(uid);
        const subSnap = await docRef.collection('items').get();
        for (const d of subSnap.docs) await d.ref.delete();
        const sessSnap = await docRef.collection('sessions').get();
        for (const d of sessSnap.docs) await d.ref.delete();
        await docRef.delete();
      } catch (_) {}
    }

    // 4. Eliminar audit_logs
    try {
      const logsSnap = await admin.firestore().collection('audit_logs').doc(uid).collection('logs').get();
      for (const d of logsSnap.docs) await d.ref.delete();
      await admin.firestore().collection('audit_logs').doc(uid).delete();
    } catch (_) {}

    // 5. Eliminar doc principal del usuario
    await userRef.delete();
    console.log(`[ACCOUNT-DELETE] ✅ Datos Firestore eliminados`);

    // 6. Eliminar usuario de Firebase Auth
    try {
      await admin.auth().deleteUser(uid);
      console.log(`[ACCOUNT-DELETE] ✅ Firebase Auth usuario eliminado`);
    } catch (e) {
      console.log(`[ACCOUNT-DELETE] ⚠️ No se pudo eliminar de Auth: ${e.message}`);
    }

    console.log(`[ACCOUNT-DELETE] ✅ Cuenta ${uid} (${req.user.email}) eliminada completamente`);
    res.json({ success: true, message: 'Cuenta eliminada permanentemente. Todos tus datos han sido borrados.' });
  } catch (e) {
    console.error(`[ACCOUNT-DELETE] ❌ Error: ${e.message}`);
    res.status(500).json({ error: 'Error al eliminar cuenta: ' + e.message });
  }
});

// POST /api/tenant/:uid/export — Generate encrypted .miia backup
app.post('/api/tenant/:uid/export', auditLogger.auditMiddleware(auditLogger.ACCESS_TYPES.EXPORT_DATA), async (req, res) => {
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

    // Gather all user data (estructura multi-negocio + legacy)
    const userRef = admin.firestore().collection('users').doc(uid);

    // Businesses con sus subcollections
    const businesses = [];
    const bizSnap = await userRef.collection('businesses').get();
    for (const bizDoc of bizSnap.docs) {
      const biz = { id: bizDoc.id, ...bizDoc.data() };
      // Products
      const prodSnap = await bizDoc.ref.collection('products').get();
      biz.products = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Brain
      try {
        const brainDoc = await bizDoc.ref.collection('brain').doc('business_cerebro').get();
        biz.brain = brainDoc.exists ? brainDoc.data() : null;
      } catch (_) { biz.brain = null; }
      // Sessions
      const sessSnap = await bizDoc.ref.collection('sessions').get();
      biz.sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Contact rules
      try {
        const crDoc = await bizDoc.ref.collection('contact_rules').doc('rules').get();
        biz.contactRules = crDoc.exists ? crDoc.data() : {};
      } catch (_) { biz.contactRules = {}; }
      // Payment methods
      try {
        const pmDoc = await bizDoc.ref.collection('payment_methods').doc('methods').get();
        biz.paymentMethods = pmDoc.exists ? (pmDoc.data().methods || []) : [];
      } catch (_) { biz.paymentMethods = []; }
      businesses.push(biz);
    }

    // Contact groups con contacts
    const contactGroups = [];
    const groupsSnap = await userRef.collection('contact_groups').get();
    for (const gDoc of groupsSnap.docs) {
      const group = { id: gDoc.id, ...gDoc.data() };
      const contactsSnap = await gDoc.ref.collection('contacts').get();
      group.contacts = contactsSnap.docs.map(d => ({ phone: d.id, ...d.data() }));
      contactGroups.push(group);
    }

    // Contact index
    const indexSnap = await userRef.collection('contact_index').get();
    const contactIndex = indexSnap.docs.map(d => ({ phone: d.id, ...d.data() }));

    // Sports preferences
    const sportsSnap = await userRef.collection('miia_sports').get();
    const sports = sportsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Interests
    const interestsSnap = await userRef.collection('miia_interests').get();
    const interests = interestsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Settings
    const settingsSnap = await userRef.collection('settings').get();
    const settings = settingsSnap.docs.reduce((acc, d) => { acc[d.id] = d.data(); return acc; }, {});

    // Legacy (backward compat — si no migró aún)
    let legacyProducts = [], legacySessions = [], legacyContactRules = {}, legacyPaymentMethods = [];
    try {
      const lpSnap = await admin.firestore().collection('training_products').doc(uid).collection('items').get();
      legacyProducts = lpSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}
    try {
      const lsSnap = await admin.firestore().collection('training_sessions').doc(uid).collection('sessions').get();
      legacySessions = lsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}
    try {
      const lrDoc = await admin.firestore().collection('contact_rules').doc(uid).get();
      if (lrDoc.exists) legacyContactRules = lrDoc.data();
    } catch (_) {}
    try {
      const lpmDoc = await admin.firestore().collection('payment_methods').doc(uid).get();
      if (lpmDoc.exists) legacyPaymentMethods = lpmDoc.data().methods || [];
    } catch (_) {}

    const exportId = crypto.randomBytes(16).toString('hex');
    const now = new Date();

    const backupData = {
      _miia_backup: true,
      _version: '2.0',
      _export_id: exportId,
      _source_uid: uid,
      _source_email: userData.email || '',
      _exported_at: now.toISOString(),
      profile: { name: userData.name, email: userData.email, role: userData.role, defaultBusinessId: userData.defaultBusinessId },
      businesses,
      contactGroups,
      contactIndex,
      sports,
      interests,
      settings,
      // Legacy (para compatibilidad)
      products: legacyProducts,
      sessions: legacySessions,
      contactRules: legacyContactRules,
      paymentMethods: legacyPaymentMethods
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
    const { message, bizId } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Cargar cerebro del negocio específico (si hay bizId) o el defaultBusinessId
    let businessCerebro = '';
    let bizName = '';
    try {
      let targetBizId = bizId;
      if (!targetBizId) {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        targetBizId = userDoc.exists ? userDoc.data().defaultBusinessId : null;
      }
      if (targetBizId) {
        const bizDoc = await admin.firestore().collection('users').doc(uid)
          .collection('businesses').doc(targetBizId).get();
        if (bizDoc.exists) bizName = bizDoc.data().name || '';
        const brainDoc = await admin.firestore().collection('users').doc(uid)
          .collection('businesses').doc(targetBizId)
          .collection('brain').doc('business_cerebro').get();
        if (brainDoc.exists) businessCerebro = brainDoc.data().content || '';
      }
    } catch (_) {}

    // Cargar perfil del owner
    let ownerName = '';
    try {
      const userDoc = await admin.firestore().collection('users').doc(uid).get();
      if (userDoc.exists) ownerName = userDoc.data().name || '';
    } catch (_) {}

    // Cargar productos del negocio
    let productsText = '';
    try {
      const targetBizId2 = bizId || (await admin.firestore().collection('users').doc(uid).get()).data()?.defaultBusinessId;
      if (targetBizId2) {
        const prodsSnap = await admin.firestore().collection('users').doc(uid)
          .collection('businesses').doc(targetBizId2)
          .collection('products').get();
        if (!prodsSnap.empty) {
          productsText = '\n\n## PRODUCTOS/SERVICIOS\n' + prodsSnap.docs.map(d => {
            const p = d.data();
            return `- ${p.name}: ${p.description || ''} (${p.price || 'consultar'})`;
          }).join('\n');
        }
      }
    } catch (_) {}

    const systemPrompt = `Sos ${ownerName || 'el dueño del negocio'}${bizName ? ` de ${bizName}` : ''}. Un cliente potencial te escribe por WhatsApp. Respondé de forma profesional, breve y amigable.

## INFORMACIÓN DE TU NEGOCIO
${businessCerebro || 'Sin información cargada. Pedile al owner que entrene a MIIA con datos del negocio.'}
${productsText}

## REGLAS
- Máximo 2-3 líneas por mensaje
- Sé directo y resolutivo
- Si no sabés algo, decí "No tengo esa info, lo consulto y te confirmo"
- NUNCA reveles que sos IA
- Usá emojis moderadamente (1-2)`;

    const result = await aiGateway.smartCall(
      aiGateway.CONTEXTS?.GENERAL || 'general',
      systemPrompt + `\n\nCliente: ${message}\nVos:`,
      {},
      { maxTokens: 300, timeout: 15000 }
    );

    res.json({ response: result?.text || 'No pude generar una respuesta. Entrena a MIIA primero.' });
  } catch (e) {
    console.error(`[TEST-MIIA] Error:`, e.message);
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

// ── Admin Privacy Stats (contadores agregados, sin leer mensajes) ────────
app.get('/api/admin/privacy-stats/:uid', verifyAdminToken, async (req, res) => {
  try {
    const counters = await privacyCounters.getCounters(req.params.uid);
    res.json(counters);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/privacy-stats', verifyAdminToken, async (req, res) => {
  try {
    const usersSnap = await admin.firestore().collection('users').get();
    const results = [];
    for (const userDoc of usersSnap.docs) {
      const ud = userDoc.data();
      const counters = await privacyCounters.getCounters(userDoc.id);
      results.push({
        uid: userDoc.id,
        name: ud.name || ud.email || '?',
        email: ud.email || '',
        role: ud.role || 'owner',
        ...counters
      });
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tenant Health — Semáforo por cliente ─────────────────────────────────
app.get('/api/admin/tenant-health', verifyAdminToken, async (req, res) => {
  try {
    const health = tenantLogger.getAllTenantsHealth();
    res.json({ tenants: health, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/tenant-health/:uid', verifyAdminToken, async (req, res) => {
  try {
    const health = tenantLogger.getTenantHealth(req.params.uid);
    if (!health) return res.status(404).json({ error: 'Tenant no encontrado o sin métricas' });
    const history = await tenantLogger.getTenantHistory(req.params.uid, parseInt(req.query.days) || 7);
    res.json({ current: health, history, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Railway Logs Proxy (admin only) ──────────────────────────────────────
// Usa Railway GraphQL API para obtener logs de deploy/build/http sin exponer el token
app.get('/api/admin/railway-logs', verifyAdminToken, async (req, res) => {
  const railwayToken = process.env.RAILWAY_API_TOKEN;
  if (!railwayToken) {
    return res.status(503).json({ error: 'RAILWAY_API_TOKEN no configurado en variables de entorno' });
  }

  const { type = 'deploy', limit = 200, deploymentId } = req.query;

  try {
    // Si no se da deploymentId, obtener el último deployment activo
    let targetDeploymentId = deploymentId;
    if (!targetDeploymentId) {
      const projectId = process.env.RAILWAY_PROJECT_ID || '9ee59327-edf5-4e33-b6ac-96670bc9a2fe';
      const serviceId = process.env.RAILWAY_SERVICE_ID || '';
      const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || '';

      const deploymentsQuery = {
        query: `query { deployments(input: { projectId: "${projectId}"${serviceId ? `, serviceId: "${serviceId}"` : ''}${environmentId ? `, environmentId: "${environmentId}"` : ''} }, first: 1) { edges { node { id status createdAt } } } }`
      };

      const depResp = await fetch('https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${railwayToken}` },
        body: JSON.stringify(deploymentsQuery)
      });
      const depData = await depResp.json();
      const edges = depData?.data?.deployments?.edges;
      if (!edges || edges.length === 0) {
        return res.json({ logs: [], message: 'No hay deployments activos' });
      }
      targetDeploymentId = edges[0].node.id;
    }

    // Query logs según tipo
    const logLimit = Math.min(parseInt(limit) || 200, 2000);
    let logsQuery;
    if (type === 'build') {
      logsQuery = { query: `query { buildLogs(deploymentId: "${targetDeploymentId}", limit: ${logLimit}) { timestamp message severity } }` };
    } else if (type === 'http') {
      logsQuery = { query: `query { httpLogs(deploymentId: "${targetDeploymentId}", limit: ${logLimit}) { timestamp requestId method path httpStatus totalDuration srcIp } }` };
    } else {
      logsQuery = { query: `query { deploymentLogs(deploymentId: "${targetDeploymentId}", limit: ${logLimit}) { timestamp message severity } }` };
    }

    const logsResp = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${railwayToken}` },
      body: JSON.stringify(logsQuery)
    });
    const logsData = await logsResp.json();

    if (logsData.errors) {
      console.error(`[RAILWAY-LOGS] GraphQL error:`, logsData.errors[0]?.message);
      return res.status(400).json({ error: logsData.errors[0]?.message || 'Error de Railway GraphQL' });
    }

    const logs = logsData?.data?.buildLogs || logsData?.data?.deploymentLogs || logsData?.data?.httpLogs || [];
    res.json({ logs, deploymentId: targetDeploymentId, type, count: logs.length });
  } catch (e) {
    console.error(`[RAILWAY-LOGS] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Listar deployments recientes (para selector en el dashboard)
app.get('/api/admin/railway-deployments', verifyAdminToken, async (req, res) => {
  const railwayToken = process.env.RAILWAY_API_TOKEN;
  if (!railwayToken) {
    return res.status(503).json({ error: 'RAILWAY_API_TOKEN no configurado' });
  }
  try {
    const projectId = process.env.RAILWAY_PROJECT_ID || '9ee59327-edf5-4e33-b6ac-96670bc9a2fe';
    const serviceId = process.env.RAILWAY_SERVICE_ID || '';
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || '';
    const limit = Math.min(parseInt(req.query.limit) || 10, 25);

    const query = {
      query: `query { deployments(input: { projectId: "${projectId}"${serviceId ? `, serviceId: "${serviceId}"` : ''}${environmentId ? `, environmentId: "${environmentId}"` : ''} }, first: ${limit}) { edges { node { id status createdAt url staticUrl } } } }`
    };

    const resp = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${railwayToken}` },
      body: JSON.stringify(query)
    });
    const data = await resp.json();
    const deployments = (data?.data?.deployments?.edges || []).map(e => e.node);
    res.json({ deployments });
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

    const systemPrompt = `Eres el asistente técnico de MIIA, un sistema SaaS de ventas por WhatsApp.
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
 * verifyFirebaseToken — Verifica Firebase token (sin verificar :uid param)
 * Usado por Mini App donde el uid viene del token, no de la URL.
 */
async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Falta header Authorization: Bearer <token>' });
    }
    const idToken = authHeader.substring(7);
    const decodedToken = await admin.auth().verifyIdToken(idToken);
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
      annual:    process.env.PADDLE_PRICE_ANNUAL,
      familiar:  process.env.PADDLE_PRICE_FAMILIAR,
      familiar_annual: process.env.PADDLE_PRICE_FAMILIAR_ANNUAL
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
    const prices = { monthly: '15.00', quarterly: '39.00', semestral: '69.00', annual: '99.00', familiar: '19.99', familiar_annual: '149.99' };
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
// MERCADOPAGO CHECKOUT
// ============================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

app.post('/api/mercadopago/subscribe', express.json(), async (req, res) => {
  try {
    const { uid, plan } = req.body;
    if (!uid || !plan) return res.status(400).json({ error: 'uid y plan requeridos' });
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

    const prices = { monthly: 15, quarterly: 39, semestral: 69, annual: 99, familiar: 19.99, familiar_annual: 149.99 };
    const price = prices[plan];
    if (!price) return res.status(400).json({ error: 'plan inválido' });

    const planNames = { monthly: 'Mensual', quarterly: 'Trimestral', semestral: 'Semestral', annual: 'Anual', familiar: 'Familiar Mensual', familiar_annual: 'Familiar Anual' };

    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          title: `MIIA Plan ${planNames[plan] || plan}`,
          quantity: 1,
          unit_price: price,
          currency_id: 'USD'
        }],
        back_urls: {
          success: `${FRONTEND_URL}/owner-dashboard.html?mp_success=1&plan=${plan}&uid=${uid}`,
          failure: `${FRONTEND_URL}/owner-dashboard.html?mp_failure=1`,
          pending: `${FRONTEND_URL}/owner-dashboard.html?mp_pending=1`
        },
        auto_return: 'approved',
        external_reference: JSON.stringify({ uid, plan, type: 'subscription' }),
        notification_url: `https://api.miia-app.com/api/mercadopago/webhook`
      })
    });
    const pref = await r.json();
    if (!pref.init_point) {
      console.error('[MP] Error creando preferencia:', pref);
      return res.status(500).json({ error: 'No se pudo crear la preferencia', detail: pref });
    }
    console.log(`[MP] Preferencia creada para ${uid}, plan ${plan}`);
    res.json({ url: pref.init_point });
  } catch (e) {
    console.error('[MP] subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mercadopago/agent-checkout', express.json(), async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid requerido' });
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          title: 'MIIA Slot Extra',
          quantity: 1,
          unit_price: 3,
          currency_id: 'USD'
        }],
        back_urls: {
          success: `${FRONTEND_URL}/owner-dashboard.html?mp_agent_success=1&uid=${uid}`,
          failure: `${FRONTEND_URL}/owner-dashboard.html?mp_failure=1`,
          pending: `${FRONTEND_URL}/owner-dashboard.html?mp_pending=1`
        },
        auto_return: 'approved',
        external_reference: JSON.stringify({ uid, type: 'agent' }),
        notification_url: `https://api.miia-app.com/api/mercadopago/webhook`
      })
    });
    const pref = await r.json();
    if (!pref.init_point) return res.status(500).json({ error: 'No se pudo crear la preferencia' });
    res.json({ url: pref.init_point });
  } catch (e) {
    console.error('[MP] agent-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mercadopago/webhook', express.json(), async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.json({ received: true });

    // Consultar el pago en MercadoPago
    const paymentId = data?.id;
    if (!paymentId) return res.json({ received: true });

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const payment = await r.json();

    if (payment.status === 'approved') {
      let ref = {};
      try { ref = JSON.parse(payment.external_reference || '{}'); } catch (_) {}
      const { uid, plan, type: payType } = ref;

      if (payType === 'subscription' && plan && uid) {
        const durations = { monthly: 1, quarterly: 3, semestral: 6, annual: 12, familiar: 1, familiar_annual: 12 };
        const months = durations[plan] || 1;
        const now = new Date();
        const endDate = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);
        await admin.firestore().collection('users').doc(uid).update({
          plan, plan_start_date: now, plan_end_date: endDate, payment_status: 'active', payment_method: 'mercadopago'
        });
        console.log(`[MP] Plan ${plan} activado para ${uid} (payment ${paymentId})`);
      } else if (payType === 'agent' && uid) {
        await admin.firestore().collection('users').doc(uid).update({
          agents_limit: admin.firestore.FieldValue.increment(1)
        });
        console.log(`[MP] Agente extra comprado por ${uid} (payment ${paymentId})`);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[MP] webhook error:', e.message);
    res.status(400).send('Webhook error: ' + e.message);
  }
});

// Endpoint para confirmar pago MP desde el frontend (auto_return)
app.post('/api/mercadopago/confirm', express.json(), async (req, res) => {
  try {
    const { payment_id, plan, uid } = req.body;
    if (!payment_id || !plan || !uid) return res.status(400).json({ error: 'payment_id, plan y uid requeridos' });
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: 'MercadoPago no configurado' });

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const payment = await r.json();

    if (payment.status === 'approved') {
      const durations = { monthly: 1, quarterly: 3, semestral: 6, annual: 12, familiar: 1, familiar_annual: 12 };
      const months = durations[plan] || 1;
      const now = new Date();
      const endDate = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);
      await admin.firestore().collection('users').doc(uid).update({
        plan, plan_start_date: now, plan_end_date: endDate, payment_status: 'active', payment_method: 'mercadopago'
      });
      console.log(`[MP] Plan ${plan} confirmado para ${uid} via frontend`);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Pago no aprobado', status: payment.status });
    }
  } catch (e) {
    console.error('[MP] confirm error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SERVIDOR
// ============================================

// ═══ RESILIENCE SHIELD: Iniciar monitoreo + endpoint ═══
shield.startHealthMonitor(300_000); // Health log cada 5 minutos
// Conectar Shield con safeSendMessage para notificaciones al owner
const _shieldNotify = async (uid, message) => {
  try {
    const tm = require('./whatsapp/tenant_manager');
    const tenant = tm.getTenant ? tm.getTenant(uid) : null;
    if (tenant?.sock && tenant.isReady && tenant.whatsappNumber) {
      await safeSendMessage(`${tenant.whatsappNumber}@s.whatsapp.net`, message, { isSelfChat: true });
    }
  } catch (e) {
    console.error(`[SHIELD-NOTIFY] Error: ${e.message}`);
  }
};
shield.setNotifyFunction(_shieldNotify);

// ═══ AUTO-DIAG: Conectar shield con auto_diagnostics para buffer de errores ═══
const _origRecordFail = shield.recordFail.bind(shield);
shield.recordFail = function(system, reason, meta) {
  autoDiag.recordError(`shield:${system}`, reason, meta);
  return _origRecordFail(system, reason, meta);
};

// ═══ SELF-TEST: Verificar salud al arrancar (delay 30s para dar tiempo a conexiones) ═══
setTimeout(async () => {
  try {
    const selfTestResult = await runSelfTest({
      ownerUid: OWNER_UID,
      aiGateway,
      notifySelfChat: async (msg) => {
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, msg, { isSelfChat: true });
      }
    });
    console.log(`[SELF-TEST] ${selfTestResult.summary}`);
  } catch (e) {
    console.error(`[SELF-TEST] Error en self-test: ${e.message}`);
  }
}, 30_000);

// ═══ AUTO-DIAGNOSTICS: Diagnóstico IA cada hora ═══
setInterval(async () => {
  try {
    await autoDiag.runDiagnostics({
      aiGateway,
      shield,
      notifySelfChat: async (msg) => {
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, msg, { isSelfChat: true });
      }
    });
  } catch (e) {
    console.error(`[AUTO-DIAG] Error en diagnóstico periódico: ${e.message}`);
  }
}, 60 * 60 * 1000); // Cada hora
// ═══ LINK TRACKER — Redirect endpoint para detectar clicks ═══
app.get('/r/:uid/:trackId', async (req, res) => {
  try {
    const result = await linkTracker.registerClick(req.params.uid, req.params.trackId);
    if (result?.originalUrl) {
      console.log(`[LINK-TRACKER] 🔄 Redirect: ${req.params.trackId} → ${result.originalUrl}`);
      return res.redirect(302, result.originalUrl);
    }
    res.status(404).send('Link no encontrado');
  } catch (e) {
    console.error(`[LINK-TRACKER] ❌ Error en redirect: ${e.message}`);
    res.status(500).send('Error');
  }
});

app.get('/api/health', (req, res) => res.json(shield.getHealthDashboard()));

// ═══ MIIA_PHONE_REGISTRY API — Para multi-tenant: registrar/consultar instancias MIIA ═══
app.get('/api/miia-registry', (req, res) => {
  res.json({ phones: [...MIIA_PHONE_REGISTRY], count: MIIA_PHONE_REGISTRY.size });
});
app.post('/api/miia-registry', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone requerido' });
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  MIIA_PHONE_REGISTRY.add(cleanPhone);
  console.log(`[MIIA-REGISTRY] 📱 Nuevo phone registrado: ${cleanPhone} (total: ${MIIA_PHONE_REGISTRY.size})`);
  res.json({ ok: true, phone: cleanPhone, total: MIIA_PHONE_REGISTRY.size });
});
app.delete('/api/miia-registry/:phone', (req, res) => {
  const cleanPhone = req.params.phone.replace(/[^0-9]/g, '');
  if (cleanPhone === OWNER_PHONE) return res.status(400).json({ error: 'No se puede eliminar el phone propio' });
  MIIA_PHONE_REGISTRY.delete(cleanPhone);
  console.log(`[MIIA-REGISTRY] 🗑️ Phone eliminado: ${cleanPhone} (total: ${MIIA_PHONE_REGISTRY.size})`);
  res.json({ ok: true, phone: cleanPhone, total: MIIA_PHONE_REGISTRY.size });
});
app.get('/api/health/unknown-errors', (req, res) => res.json(shield.getUnknownErrors()));
app.get('/api/health/task-scheduler', (req, res) => res.json({
  metrics: taskScheduler.getTaskMetrics(),
  silentFailures: taskScheduler.getSilentFailures()
}));

// 🛡️ INTEGRITY GUARDS — Health endpoint
app.get('/api/health/integrity-guards', (req, res) => {
  const status = integrityGuards.getGuardStatus();
  res.status(status.allPassed ? 200 : 500).json(status);
});

app.get('/api/health/rate-limiter', (req, res) => res.json({
  metrics: rateLimiter.getMetrics(),
  adminLevel: rateLimiter.getLevel('admin'),
}));

app.get('/api/health/health-monitor', (req, res) => res.json(healthMonitor.getStats()));

// ═══ P5 HEALTH ENDPOINTS ═══
app.get('/api/health/key-pool', (req, res) => res.json(keyPool.getAllStats()));
app.get('/api/health/wa-gateway', (req, res) => res.json(waGateway.healthCheck()));
app.get('/api/health/ai-gateway', (req, res) => res.json(aiGateway.healthCheck()));
app.get('/api/health/prompt-cache', (req, res) => res.json(promptCache.healthCheck()));
app.get('/api/health/diagnostics', (req, res) => res.json({
  recentErrors: autoDiag.getRecentErrors(2).length,
  patterns: autoDiag.detectErrorPatterns(autoDiag.getRecentErrors(2)),
  history: autoDiag.getDiagnosticHistory(),
}));
// Trigger diagnóstico manual
app.post('/api/health/diagnostics/run', async (req, res) => {
  try {
    const result = await autoDiag.runDiagnostics({
      aiGateway, shield, force: true,
      notifySelfChat: async (msg) => {
        await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, msg, { isSelfChat: true });
      }
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══ MINI APP / PWA — Endpoints de Protección ═══

// POST /api/miniapp/location — GPS desde la Mini App (background tracking)
app.post('/api/miniapp/location', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { latitude, longitude, accuracy, battery, timestamp } = req.body;
    if (!latitude || !longitude) return res.status(400).json({ error: 'latitude/longitude requeridos' });

    await protectionManager.saveSharedLocation(uid, latitude, longitude, '');

    // Guardar datos extra de la app (batería, accuracy)
    await admin.firestore().collection('users').doc(uid)
      .collection('shared_locations').doc('latest').set({
        latitude, longitude, accuracy: accuracy || null,
        battery: battery || null,
        source: 'miniapp_gps',
        updatedAt: new Date().toISOString(),
        rawTimestamp: timestamp || null
      }, { merge: true });

    console.log(`[MINIAPP] 📍 GPS recibido de ${uid}: ${latitude}, ${longitude} (bat: ${battery || '?'}%)`);
    res.json({ success: true });
  } catch (e) {
    console.error(`[MINIAPP] ❌ Error guardando GPS:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/miniapp/sos — Botón SOS desde la Mini App
app.post('/api/miniapp/sos', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { latitude, longitude, message } = req.body;

    // Guardar ubicación de emergencia
    if (latitude && longitude) {
      await protectionManager.saveSharedLocation(uid, latitude, longitude, 'SOS');
    }

    // Log inmutable de SOS
    await protectionManager.logProtectionEvent(uid, 'sos_triggered', {
      latitude, longitude, message: message || 'SOS activado desde Mini App',
      triggeredAt: new Date().toISOString()
    });

    // Notificar al owner en self-chat
    const ownerJid = getOwnerSock()?.user?.id;
    if (ownerJid) {
      const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
      const locLink = latitude ? `\n📍 https://maps.google.com/?q=${latitude},${longitude}` : '';
      await safeSendMessage(ownerSelf,
        `🆘 *¡ALERTA SOS!*\nUn contacto protegido activó el botón de emergencia.${locLink}\n${message || ''}`,
        { isSelfChat: true }
      );
    }

    // Notificar adultos responsables por email
    await protectionManager.notifyAdultsByEmail(uid,
      '🆘 MIIA — ALERTA SOS',
      `Se activó el botón de emergencia desde la Mini App de MIIA.\n\n${latitude ? `📍 Ubicación: https://maps.google.com/?q=${latitude},${longitude}` : 'Sin ubicación disponible'}\n\nFecha: ${new Date().toLocaleString('es-ES')}\n\nEsto es una alerta urgente del sistema de protección de MIIA.`
    );

    // Notificar contactos de seguridad por WhatsApp
    const locLink = latitude ? `\n📍 https://maps.google.com/?q=${latitude},${longitude}` : '';
    await securityContacts.notifyProtectors(uid, 'sos', {
      message: `¡ALERTA SOS! Se activó el botón de emergencia.${locLink}`,
      protectedName: uid
    });

    console.log(`[MINIAPP] 🆘 SOS activado por ${uid}`);
    res.json({ success: true });
  } catch (e) {
    console.error(`[MINIAPP] ❌ Error en SOS:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/miniapp/heartbeat — Heartbeat desde la Mini App (la app sigue viva)
app.post('/api/miniapp/heartbeat', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { battery, isCharging, networkType } = req.body;

    await admin.firestore().collection('users').doc(uid)
      .collection('miniapp_state').doc('heartbeat').set({
        lastHeartbeat: new Date().toISOString(),
        battery: battery || null,
        isCharging: isCharging || false,
        networkType: networkType || 'unknown'
      }, { merge: true });

    // Alertar si batería crítica (<10%)
    if (battery && battery < 10) {
      const ownerJid = getOwnerSock()?.user?.id;
      if (ownerJid) {
        const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
        await safeSendMessage(ownerSelf,
          `🔋 *Batería crítica* — Un contacto protegido tiene ${battery}% de batería. La Mini App podría dejar de funcionar pronto.`,
          { isSelfChat: true }
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/miniapp/fall-detected — Detección de caída (acelerómetro)
app.post('/api/miniapp/fall-detected', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { latitude, longitude, accelerometerData, confirmed } = req.body;

    // Si confirmed=false, es pre-alerta (la app pregunta al usuario si está bien)
    // Si confirmed=true, el usuario NO respondió en 30s → emergencia real
    if (!confirmed) {
      await protectionManager.logProtectionEvent(uid, 'fall_pre_alert', {
        latitude, longitude, accelerometerData
      });
      return res.json({ success: true, action: 'waiting_user_confirmation' });
    }

    // Caída confirmada — emergencia
    if (latitude && longitude) {
      await protectionManager.saveSharedLocation(uid, latitude, longitude, 'FALL_DETECTED');
    }

    await protectionManager.logProtectionEvent(uid, 'fall_confirmed', {
      latitude, longitude, confirmedAt: new Date().toISOString()
    });

    // Notificar owner
    const ownerJid = getOwnerSock()?.user?.id;
    if (ownerJid) {
      const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
      const locLink = latitude ? `\n📍 https://maps.google.com/?q=${latitude},${longitude}` : '';
      await safeSendMessage(ownerSelf,
        `🚨 *¡Posible caída detectada!*\nLa Mini App detectó una caída y el usuario NO respondió en 30 segundos.${locLink}\n\n*Llamar de inmediato.*`,
        { isSelfChat: true }
      );
    }

    // Email a adultos
    await protectionManager.notifyAdultsByEmail(uid,
      '🚨 MIIA — Posible caída detectada',
      `La Mini App de MIIA detectó una posible caída y el usuario no respondió a la verificación.\n\n${latitude ? `📍 Ubicación: https://maps.google.com/?q=${latitude},${longitude}` : 'Sin ubicación'}\n\nFecha: ${new Date().toLocaleString('es-ES')}\n\nPor favor, contacte al usuario de inmediato.\n\nMIIA — Protección Inteligente`
    );

    // Notificar contactos de seguridad por WhatsApp
    const fallLocLink = latitude ? `\n📍 https://maps.google.com/?q=${latitude},${longitude}` : '';
    await securityContacts.notifyProtectors(uid, 'fall', {
      message: `¡Posible caída detectada! El usuario no respondió a la verificación.${fallLocLink}\nPor favor, contactar de inmediato.`,
      protectedName: uid
    });

    console.log(`[MINIAPP] 🚨 Caída confirmada para ${uid}`);
    res.json({ success: true });
  } catch (e) {
    console.error(`[MINIAPP] ❌ Error en fall-detected:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/miniapp/emergency-info — Info de emergencia para la app
app.get('/api/miniapp/emergency-info', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const level1 = await protectionManager.getEmergencyLevel1(uid, conversations, []);
    res.json({ success: true, data: level1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/miniapp/config — Config de la Mini App para este usuario
app.get('/api/miniapp/config', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const configDoc = await admin.firestore().collection('users').doc(uid)
      .collection('protection').doc('config').get();
    const config = configDoc.exists ? configDoc.data() : {};

    res.json({
      success: true,
      protectionMode: config.mode || null,
      active: config.active || false,
      features: {
        gpsTracking: config.locationSharing || false,
        fallDetection: config.mode === 'elderly',
        sosButton: true,
        heartbeat: true,
        geofencing: false // futuro
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
// Inyectar funciones de aprobación dinámica en tenant_message_handler
tenantMessageHandler.setApprovalFunctions({
  validateLearningKey,
  createLearningApproval,
  markApprovalApplied
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORGOT PASSWORD — Email institucional con diseño MIIA
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/forgot-password', express.json(), async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    console.log(`[AUTH] 🔑 Solicitud de reset password para: ${email}`);

    // Verificar que el usuario existe
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (e) {
      console.log(`[AUTH] ❌ Usuario no encontrado: ${email}`);
      // No revelar si el email existe o no (seguridad)
      return res.json({ ok: true, message: 'Si el email existe, recibirás un correo.' });
    }

    // Verificar si la cuenta fue creada solo con Google
    const providers = userRecord.providerData.map(p => p.providerId);
    if (providers.includes('google.com') && !providers.includes('password')) {
      console.log(`[AUTH] ⚠️ Cuenta solo Google: ${email}`);
      return res.status(400).json({ error: 'google_only', message: 'Tu cuenta fue creada con Google. Usa "Continuar con Google" para ingresar.' });
    }

    // Generar link de reset con Firebase Admin
    const resetLink = await admin.auth().generatePasswordResetLink(email, {
      url: 'https://www.miia-app.com/login.html'
    });
    console.log(`[AUTH] ✅ Link de reset generado para ${email}`);

    // Enviar email institucional con diseño MIIA
    const htmlEmail = `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',-apple-system,sans-serif;">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <!-- Header con gradient MIIA -->
            <div style="background:linear-gradient(135deg,#00E5FF 0%,#7C3AED 50%,#FF1744 100%);padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:28px;font-weight:900;letter-spacing:-1px;">MIIA</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Tu asistente IA en WhatsApp</p>
            </div>

            <!-- Contenido -->
            <div style="padding:36px 40px;">
              <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:20px;font-weight:700;">Restablecer contraseña</h2>
              <p style="color:#64748b;font-size:15px;line-height:1.7;margin:0 0 24px;">
                Hola! Recibimos una solicitud para restablecer la contraseña de tu cuenta <strong style="color:#1a1a2e;">${email}</strong>.
              </p>
              <p style="color:#64748b;font-size:15px;line-height:1.7;margin:0 0 28px;">
                Haz clic en el botón para crear una nueva contraseña:
              </p>

              <!-- Botón -->
              <div style="text-align:center;margin:0 0 28px;">
                <a href="${resetLink}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#00E5FF 0%,#7C3AED 50%,#FF1744 100%);color:#fff;text-decoration:none;border-radius:50px;font-weight:700;font-size:15px;">
                  Restablecer mi contraseña
                </a>
              </div>

              <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0 0 8px;">
                Si no solicitaste este cambio, puedes ignorar este correo. Tu contraseña actual seguirá funcionando.
              </p>
              <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0;">
                Este enlace expira en 1 hora por seguridad.
              </p>
            </div>

            <!-- Footer -->
            <div style="background:#f8f9fa;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#94a3b8;font-size:12px;">
                MIIA — Tu asistente IA que vende, organiza y conecta<br>
                <a href="https://www.miia-app.com" style="color:#7C3AED;text-decoration:none;">www.miia-app.com</a> ·
                <a href="https://wa.me/573054169969" style="color:#7C3AED;text-decoration:none;">WhatsApp</a>
              </p>
            </div>
          </div>
        </body>
      </html>
    `;

    await mailService.sendCustomEmail(email, 'Restablecer tu contraseña — MIIA', htmlEmail, {
      fromName: 'MIIA',
      replyTo: 'hola@miia-app.com'
    });

    console.log(`[AUTH] ✅ Email institucional de reset enviado a ${email}`);
    res.json({ ok: true, message: 'Email enviado correctamente.' });
  } catch (e) {
    console.error(`[AUTH] ❌ Error en forgot-password:`, e.message);
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// OTP AGENT LOGIN — Acceso de agentes por código temporal enviado por email
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/send-otp
 * Owner/Admin envía OTP al email del agente.
 * Body: { agentEmail }
 * Crea usuario Firebase Auth si no existe, genera OTP 6 dígitos, guarda en Firestore, envía por email.
 */
app.post('/api/auth/send-otp', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    const decoded = await admin.auth().verifyIdToken(authHeader.substring(7));

    // Verificar que quien invita es owner o admin
    const callerDoc = await admin.firestore().collection('users').doc(decoded.uid).get();
    const callerRole = callerDoc.exists ? (callerDoc.data().role || 'owner') : 'owner';
    if (callerRole === 'agent') return res.status(403).json({ error: 'Los agentes no pueden invitar otros agentes' });

    const { agentEmail } = req.body;
    if (!agentEmail || !agentEmail.includes('@')) return res.status(400).json({ error: 'Email del agente requerido' });

    const normalizedEmail = agentEmail.trim().toLowerCase();
    console.log(`[OTP] 📧 Owner ${decoded.email} solicita OTP para agente: ${normalizedEmail}`);

    // 1. Buscar o crear usuario Firebase Auth para el agente
    let agentUid;
    let isNewUser = false;
    try {
      const existingUser = await admin.auth().getUserByEmail(normalizedEmail);
      agentUid = existingUser.uid;
      console.log(`[OTP] ✅ Usuario existente encontrado: ${agentUid}`);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // Crear usuario con password temporal random
        const tempPw = crypto.randomBytes(16).toString('hex');
        const newUser = await admin.auth().createUser({
          email: normalizedEmail,
          password: tempPw,
          emailVerified: true, // OTP funciona como verificación
          displayName: normalizedEmail.split('@')[0]
        });
        agentUid = newUser.uid;
        isNewUser = true;
        console.log(`[OTP] ✅ Usuario creado: ${agentUid}`);
      } else {
        throw e;
      }
    }

    // 2. Crear/actualizar doc Firestore del agente
    const agentDocRef = admin.firestore().collection('users').doc(agentUid);
    const agentDoc = await agentDocRef.get();
    if (!agentDoc.exists || isNewUser) {
      await agentDocRef.set({
        email: normalizedEmail,
        name: normalizedEmail.split('@')[0],
        role: 'agent',
        createdBy: decoded.uid,
        ownerUid: decoded.uid,
        created_at: new Date().toISOString(),
        otp_pending: true
      }, { merge: true });
    } else {
      // Asegurar que tiene role agent y está vinculado al owner correcto
      await agentDocRef.update({
        role: 'agent',
        createdBy: decoded.uid,
        ownerUid: decoded.uid,
        otp_pending: true,
        updatedAt: new Date().toISOString()
      });
    }

    // 3. Generar OTP de 6 dígitos
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 horas

    await agentDocRef.collection('auth').doc('otp').set({
      code: otpCode,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      createdBy: decoded.uid,
      used: false,
      attempts: 0
    });

    console.log(`[OTP] 🔑 OTP generado para ${normalizedEmail} — expira ${expiresAt.toISOString()}`);

    // 4. Enviar email con OTP
    const mailService = require('./services/mail_service');
    if (!mailService.isConfigured()) {
      console.warn('[OTP] ⚠️ SMTP no configurado — OTP generado pero NO enviado por email');
      return res.json({ success: true, otpCode, message: 'OTP generado. SMTP no configurado — código incluido en respuesta.' });
    }

    const ownerName = callerDoc.data()?.name || decoded.email?.split('@')[0] || 'Tu jefe';

    const otpHtml = `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',-apple-system,sans-serif;">
          <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <!-- Header con gradient MIIA -->
            <div style="background:linear-gradient(135deg,#00E5FF 0%,#7C3AED 50%,#FF1744 100%);padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#fff;font-size:28px;font-weight:900;letter-spacing:-1px;">MIIA</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Tu asistente IA en WhatsApp</p>
            </div>

            <!-- Contenido -->
            <div style="padding:36px 40px;">
              <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:20px;font-weight:700;">Tu código de acceso</h2>
              <p style="color:#64748b;font-size:15px;line-height:1.7;margin:0 0 24px;">
                <strong style="color:#1a1a2e;">${ownerName}</strong> te invitó como agente en MIIA.
                Usa este código para acceder por primera vez:
              </p>

              <!-- Código OTP -->
              <div style="text-align:center;margin:0 0 28px;">
                <div style="display:inline-block;padding:18px 40px;background:#f8f9fa;border:2px dashed #7C3AED;border-radius:12px;">
                  <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#1a1a2e;font-family:monospace;">${otpCode}</span>
                </div>
              </div>

              <p style="color:#64748b;font-size:14px;line-height:1.7;margin:0 0 8px;">
                <strong>¿Cómo usar el código?</strong>
              </p>
              <ol style="color:#64748b;font-size:14px;line-height:2;margin:0 0 20px;padding-left:20px;">
                <li>Ve a <a href="https://www.miia-app.com/login.html" style="color:#7C3AED;text-decoration:none;font-weight:600;">miia-app.com/login</a></li>
                <li>Haz clic en <strong>"Acceso con código"</strong></li>
                <li>Ingresa tu email y el código de arriba</li>
                <li>Una vez adentro, puedes crear tu propia contraseña</li>
              </ol>

              <div style="padding:14px 18px;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;margin:0 0 20px;">
                <p style="margin:0;color:#92400e;font-size:13px;">
                  ⏰ Este código es válido por <strong>72 horas</strong>. Después de ese tiempo, tu jefe deberá generar uno nuevo.
                </p>
              </div>
            </div>

            <!-- Footer -->
            <div style="background:#f8f9fa;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#94a3b8;font-size:12px;">
                MIIA — Tu asistente IA que vende, organiza y conecta<br>
                <a href="https://www.miia-app.com" style="color:#7C3AED;text-decoration:none;">www.miia-app.com</a>
              </p>
            </div>
          </div>
        </body>
      </html>
    `;

    const mailResult = await mailService.sendCustomEmail(normalizedEmail, 'Tu código de acceso a MIIA', otpHtml, {
      fromName: 'MIIA',
      replyTo: 'hola@miia-app.com'
    });

    if (mailResult.success) {
      console.log(`[OTP] ✅ Email OTP enviado a ${normalizedEmail}`);
      res.json({ success: true, message: `Código enviado a ${normalizedEmail}` });
    } else {
      console.error(`[OTP] ❌ Error enviando email: ${mailResult.error}`);
      // Devolver OTP en respuesta como fallback
      res.json({ success: true, otpCode, message: `Error enviando email. Código: ${otpCode}` });
    }
  } catch (e) {
    console.error(`[OTP] ❌ Error en send-otp:`, e.message);
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
});

/**
 * POST /api/auth/verify-otp
 * Agente verifica OTP y recibe custom token de Firebase para login.
 * Body: { email, otpCode }
 */
app.post('/api/auth/verify-otp', express.json(), async (req, res) => {
  try {
    const { email, otpCode } = req.body;
    if (!email || !otpCode) return res.status(400).json({ error: 'Email y código son requeridos' });

    const normalizedEmail = email.trim().toLowerCase();
    console.log(`[OTP] 🔍 Verificando OTP para ${normalizedEmail}...`);

    // 1. Buscar usuario por email
    let agentUid;
    try {
      const userRecord = await admin.auth().getUserByEmail(normalizedEmail);
      agentUid = userRecord.uid;
    } catch (e) {
      console.log(`[OTP] ❌ Usuario no encontrado: ${normalizedEmail}`);
      return res.status(404).json({ error: 'No existe una cuenta con ese email. Contacta a tu jefe para que te invite.' });
    }

    // 2. Verificar OTP en Firestore
    const otpDoc = await admin.firestore().collection('users').doc(agentUid).collection('auth').doc('otp').get();
    if (!otpDoc.exists) {
      console.log(`[OTP] ❌ No hay OTP pendiente para ${normalizedEmail}`);
      return res.status(400).json({ error: 'No hay código pendiente. Pide a tu jefe que genere uno nuevo.' });
    }

    const otpData = otpDoc.data();

    // Verificar intentos (max 5)
    if (otpData.attempts >= 5) {
      console.log(`[OTP] 🚫 Demasiados intentos para ${normalizedEmail}`);
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Pide un código nuevo.' });
    }

    // Verificar expiración
    if (new Date(otpData.expiresAt) < new Date()) {
      console.log(`[OTP] ⏰ OTP expirado para ${normalizedEmail}`);
      return res.status(400).json({ error: 'El código expiró. Pide a tu jefe que genere uno nuevo.' });
    }

    // Verificar si ya fue usado
    if (otpData.used) {
      console.log(`[OTP] ⚠️ OTP ya usado para ${normalizedEmail}`);
      return res.status(400).json({ error: 'Este código ya fue usado. Pide uno nuevo.' });
    }

    // Verificar código
    if (otpData.code !== otpCode.trim()) {
      // Incrementar intentos
      await admin.firestore().collection('users').doc(agentUid).collection('auth').doc('otp').update({
        attempts: (otpData.attempts || 0) + 1
      });
      const remaining = 5 - (otpData.attempts || 0) - 1;
      console.log(`[OTP] ❌ Código incorrecto para ${normalizedEmail}. Intentos restantes: ${remaining}`);
      return res.status(400).json({ error: `Código incorrecto. Te quedan ${remaining} intentos.` });
    }

    // 3. OTP válido — marcar como usado
    await admin.firestore().collection('users').doc(agentUid).collection('auth').doc('otp').update({
      used: true,
      usedAt: new Date().toISOString()
    });

    // Actualizar estado del agente
    await admin.firestore().collection('users').doc(agentUid).update({
      otp_pending: false,
      otp_verified: true,
      last_login: new Date().toISOString()
    });

    // 4. Generar custom token de Firebase para login
    const customToken = await admin.auth().createCustomToken(agentUid);
    console.log(`[OTP] ✅ OTP verificado para ${normalizedEmail} — custom token generado`);

    res.json({
      success: true,
      customToken,
      uid: agentUid,
      email: normalizedEmail,
      message: 'Código verificado. Bienvenido!'
    });
  } catch (e) {
    console.error(`[OTP] ❌ Error en verify-otp:`, e.message);
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
});

/**
 * POST /api/auth/set-password
 * Agente establece su propia contraseña después de login OTP.
 * Headers: Authorization Bearer <token>
 * Body: { newPassword }
 */
app.post('/api/auth/set-password', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    const decoded = await admin.auth().verifyIdToken(authHeader.substring(7));

    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    await admin.auth().updateUser(decoded.uid, { password: newPassword });

    // Marcar que el agente ya tiene password propio
    await admin.firestore().collection('users').doc(decoded.uid).update({
      has_own_password: true,
      password_set_at: new Date().toISOString()
    });

    console.log(`[OTP] ✅ Contraseña establecida para ${decoded.email}`);
    res.json({ success: true, message: 'Contraseña creada. Ahora puedes usarla para iniciar sesión.' });
  } catch (e) {
    console.error(`[OTP] ❌ Error en set-password:`, e.message);
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW REGISTRATION — Welcome email + admin notification
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/new-registration', express.json(), async (req, res) => {
  const { uid, name, email, whatsapp, plan } = req.body;
  if (!uid || !email) return res.status(400).json({ error: 'uid y email son requeridos' });

  console.log(`[REG] 📝 Nuevo registro: ${name} (${email}) — Plan: ${plan}, WhatsApp: ${whatsapp}`);

  // 1. Welcome email al usuario
  try {
    const mailService = require('./services/mail_service');
    if (mailService.isConfigured()) {
      const welcomeHtml = `
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
          body { font-family: Inter, -apple-system, sans-serif; color: #333; line-height: 1.6; margin: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 0; }
          .header { background: linear-gradient(135deg, #00E5FF 0%, #7C3AED 50%, #FF1744 100%); color: white; padding: 32px 24px; text-align: center; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 1.6rem; font-weight: 800; }
          .header p { margin: 8px 0 0; opacity: .85; font-size: .95rem; }
          .content { padding: 28px 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; }
          .step { display: flex; gap: 12px; margin-bottom: 16px; }
          .step-num { width: 28px; height: 28px; border-radius: 50%; background: #7C3AED; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: .8rem; flex-shrink: 0; }
          .step-text { font-size: .9rem; }
          .cta { display: inline-block; margin: 20px 0; padding: 12px 28px; background: linear-gradient(135deg, #7C3AED, #00E5FF); color: white; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: .9rem; }
          .footer { padding: 16px 24px; text-align: center; color: #666; font-size: .78rem; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; background: #fff; }
          .footer a { color: #7C3AED; text-decoration: none; }
        </style></head><body>
        <div class="container">
          <div class="header">
            <h1>Bienvenido a MIIA</h1>
            <p>Tu asistente IA personal y de negocios</p>
          </div>
          <div class="content">
            <p>Hola <strong>${name || 'Usuario'}</strong>,</p>
            <p>Tu cuenta ha sido creada exitosamente. Estos son tus primeros pasos:</p>
            <div class="step"><div class="step-num">1</div><div class="step-text">Verifica tu email haciendo clic en el enlace que te enviamos</div></div>
            <div class="step"><div class="step-num">2</div><div class="step-text">Ingresa a tu <a href="https://www.miia-app.com/login.html" style="color:#7C3AED;">dashboard</a> y conecta tu WhatsApp</div></div>
            <div class="step"><div class="step-num">3</div><div class="step-text">Entrena a MIIA con la info de tu negocio</div></div>
            <div class="step"><div class="step-num">4</div><div class="step-text">MIIA empieza a responder por ti</div></div>
            <p style="text-align:center"><a href="https://www.miia-app.com/login.html" class="cta">Ir a mi Dashboard</a></p>
            <p style="color:#666;font-size:.82rem;">Tu plan: <strong>${plan === 'trial' ? 'Trial gratuito (15 días)' : plan}</strong></p>
          </div>
          <div class="footer">
            <p>MIIA Center &copy; 2026 | <a href="https://www.miia-app.com">miia-app.com</a></p>
            <p>Si tienes preguntas, escríbenos a <a href="https://wa.me/573054169969">WhatsApp</a></p>
          </div>
        </div></body></html>`;

      await mailService.sendCustomEmail(email, 'Bienvenido a MIIA — Tu asistente IA', welcomeHtml);
      console.log(`[REG] ✅ Welcome email enviado a ${email}`);
    }
  } catch (e) {
    console.error(`[REG] ⚠️ Error enviando welcome email:`, e.message);
  }

  // 2. Notify admin (Mariano) via Firestore — non-blocking
  try {
    await admin.firestore().collection('admin_notifications').add({
      type: 'new_registration',
      uid, name, email, whatsapp, plan,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`[REG] ✅ Admin notificado del nuevo registro`);
  } catch (e) {
    console.error(`[REG] ⚠️ Error notificando admin:`, e.message);
  }

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE LEAD ENDPOINT — Formulario público para captar leads enterprise
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/enterprise-lead', express.json(), async (req, res) => {
  const startTime = Date.now();
  console.log('[ENTERPRISE-LEAD] 📥 Nueva solicitud recibida');

  try {
    // ── 1. Validar datos del formulario ──
    const { name, email, phone, website, team_size, message } = req.body || {};
    if (!name || !email || !phone) {
      console.warn('[ENTERPRISE-LEAD] ❌ Datos incompletos:', { name: !!name, email: !!email, phone: !!phone });
      return res.status(400).json({ error: 'name, email y phone son requeridos' });
    }
    console.log(`[ENTERPRISE-LEAD] 👤 Lead: ${name} | ${email} | ${phone} | website: ${website || 'N/A'} | team: ${team_size || 'N/A'}`);

    // ── 2. Guardar lead en Firestore ──
    const leadData = {
      name,
      email,
      phone,
      website: website || '',
      team_size: team_size || '',
      message: message || '',
      status: 'new',
      createdAt: new Date().toISOString(),
      timestamp: Date.now()
    };

    const leadRef = await admin.firestore().collection('enterprise_leads').add(leadData);
    const leadId = leadRef.id;
    console.log(`[ENTERPRISE-LEAD] ✅ Lead guardado en Firestore: enterprise_leads/${leadId}`);

    // ── 3. Analizar website con Gemini + Google Search grounding ──
    let websiteAnalysis = '';
    if (website) {
      try {
        console.log(`[ENTERPRISE-LEAD] 🔍 Analizando website: ${website}`);
        const analysisPrompt = `Analiza la siguiente empresa y su sitio web: ${website}

Nombre del contacto: ${name}
Tamaño del equipo: ${team_size || 'No especificado'}
Mensaje: ${message || 'Sin mensaje'}

Genera un informe COMPLETO y DETALLADO en español sobre:
1. **Qué hace la empresa**: productos, servicios, propuesta de valor
2. **Mercado objetivo**: a quién le venden, segmentos, geografía
3. **Presencia web actual**: calidad del sitio, SEO aparente, redes sociales
4. **Oportunidades con MIIA**: cómo MIIA (asistente IA por WhatsApp) podría ayudarles — automatización de atención al cliente, seguimiento de leads, agendamiento, cotizaciones automáticas, etc.
5. **Talking points para reunión de ventas**: 3-5 puntos concretos para el equipo comercial

Sé específico y usa información real del sitio web.`;

        websiteAnalysis = await generateAIContent(analysisPrompt, { enableSearch: true });
        console.log(`[ENTERPRISE-LEAD] ✅ Análisis completado (${websiteAnalysis.length} chars)`);

        // Guardar análisis en el documento del lead
        await leadRef.update({ websiteAnalysis });
        console.log(`[ENTERPRISE-LEAD] ✅ Análisis guardado en Firestore`);
      } catch (analysisErr) {
        console.error(`[ENTERPRISE-LEAD] ⚠️ Error en análisis de website:`, analysisErr.message);
        websiteAnalysis = `[Error al analizar: ${analysisErr.message}]`;
        await leadRef.update({ websiteAnalysis }).catch(() => {});
      }
    } else {
      console.log('[ENTERPRISE-LEAD] ⏭️ Sin website — análisis omitido');
      websiteAnalysis = 'No se proporcionó website para analizar.';
    }

    // ── 4. Enviar email de confirmación al lead ──
    try {
      console.log(`[ENTERPRISE-LEAD] 📧 Enviando email de confirmación a ${email}`);
      const emailSubject = `¡Hola ${name}! Recibimos tu solicitud — MIIA Enterprise`;
      const emailBody = `Hola ${name},

¡Gracias por tu interés en MIIA Enterprise! 🚀

Hemos recibido tu solicitud y ya estamos analizando cómo podemos potenciar tu negocio${website ? ` (${website})` : ''}.

En breve te contactaremos por WhatsApp para conocer mejor tu empresa y preparar una propuesta personalizada.

Si tienes alguna pregunta, responde directamente a este email.

¡Saludos!
Equipo MIIA Enterprise
hola@miia-app.com`;

      await mailService.sendGenericEmail(email, emailSubject, emailBody, {
        fromName: 'MIIA Enterprise',
        replyTo: 'hola@miia-app.com'
      });
      console.log(`[ENTERPRISE-LEAD] ✅ Email de confirmación enviado a ${email}`);
    } catch (emailErr) {
      console.error(`[ENTERPRISE-LEAD] ⚠️ Error enviando email de confirmación:`, emailErr.message);
      // No falla — el lead ya está guardado
    }

    // ── 5. Enviar WhatsApp al lead — MIIA hace discovery completo ──
    try {
      const sock = getOwnerSock();
      if (sock?.user?.id) {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const leadJid = `${cleanPhone}@s.whatsapp.net`;
        console.log(`[ENTERPRISE-LEAD] 💬 Enviando WhatsApp a ${leadJid}`);

        // Marcar el contacto como enterprise_lead en Firestore para que el handler lo trate especial
        const ownerUid = Object.keys(tenantStates || {})[0]; // Owner principal (Mariano)
        if (ownerUid) {
          await admin.firestore().collection(`users/${ownerUid}/contact_index`).doc(cleanPhone).set({
            type: 'enterprise_lead',
            leadId,
            name,
            email,
            website: website || '',
            team_size: team_size || '',
            websiteAnalysis: websiteAnalysis ? websiteAnalysis.substring(0, 5000) : '',
            message: message || '',
            stage: 'initial_contact', // stages: initial_contact → discovery → farewell → handed_to_owner
            createdAt: new Date().toISOString()
          }, { merge: true });
          console.log(`[ENTERPRISE-LEAD] ✅ Contacto marcado como enterprise_lead en contact_index`);
        }

        // Generar mensaje inicial — MIIA se presenta como representante del área Enterprise
        const entOwner = userProfile?.shortName || userProfile?.name?.split(' ')[0] || 'el equipo';
        let waMessage = '';
        try {
          const msgPrompt = `Genera un mensaje de WhatsApp CORTO (máximo 4-5 oraciones) para ${name} que acaba de solicitar información sobre MIIA Enterprise.
${website ? `Ya analizamos su sitio web ${website}.` : `No proporcionó sitio web.`}
${websiteAnalysis ? `Resumen del análisis: ${websiteAnalysis.substring(0, 500)}` : ''}

El mensaje debe:
- Presentarse como "${entOwner}, del área Enterprise de MIIA" (NUNCA revelar que es IA)
- Agradecer por su interés
- ${website ? 'Mencionar algo específico que encontraste en su web para demostrar que la analizaste' : 'Preguntar por su sitio web o LinkedIn para conocer mejor su empresa'}
- Hacer 1-2 preguntas de discovery: ¿cuántos leads manejan al mes? ¿qué herramientas usan hoy?
- Tono amigable profesional, español neutro (NO argentinismos), máximo 2 emojis
- Si pregunta algo sobre MIIA, puede compartir el link https://miia-app.com

Devuelve SOLO el mensaje, sin comillas ni explicaciones.`;

          waMessage = await generateAIContent(msgPrompt);
          console.log(`[ENTERPRISE-LEAD] ✅ Mensaje WhatsApp generado por IA`);
        } catch (msgErr) {
          console.warn(`[ENTERPRISE-LEAD] ⚠️ Error generando mensaje IA, usando fallback:`, msgErr.message);
          waMessage = `¡Hola ${name}! Soy ${entOwner}, del área Enterprise de MIIA. ${website ? `Estuve revisando ${website} y me pareció muy interesante lo que hacen.` : 'Recibí tu solicitud y me interesa mucho conocer tu proyecto.'} Me encantaría hacerte algunas preguntas para preparar una propuesta personalizada. ¿Cuántos leads manejan al mes y qué herramientas usan hoy para atenderlos? 🚀\n\n— ${entOwner}, MIIA Enterprise`;
        }

        await safeSendMessage(leadJid, waMessage);
        console.log(`[ENTERPRISE-LEAD] ✅ WhatsApp enviado a ${leadJid}`);
      } else {
        console.warn(`[ENTERPRISE-LEAD] ⚠️ WhatsApp no disponible — sock no conectado`);

        // Sin WhatsApp: enviar segundo email pidiendo WhatsApp
        try {
          console.log(`[ENTERPRISE-LEAD] 📧 Enviando email solicitando WhatsApp a ${email}`);
          const waRequestSubject = `${name}, queremos preparar tu propuesta — MIIA Enterprise`;
          const waRequestBody = `Hola ${name},

Para poder preparar una propuesta personalizada para tu empresa, nos gustaría conversar contigo por WhatsApp.

¿Podrías confirmarnos un número de WhatsApp donde podamos contactarte? Así podemos hacerte algunas preguntas rápidas y mostrarte cómo MIIA puede transformar tu operación comercial.

Si ya lo proporcionaste en el formulario, ignora este mensaje — te contactaremos en breve.

Saludos,
Equipo MIIA Enterprise
hola@miia-app.com`;

          await mailService.sendGenericEmail(email, waRequestSubject, waRequestBody, {
            fromName: 'MIIA Enterprise',
            replyTo: 'hola@miia-app.com'
          });
          console.log(`[ENTERPRISE-LEAD] ✅ Email de solicitud de WhatsApp enviado`);
        } catch (waEmailErr) {
          console.error(`[ENTERPRISE-LEAD] ⚠️ Error enviando email de solicitud WA:`, waEmailErr.message);
        }
      }
    } catch (waErr) {
      console.error(`[ENTERPRISE-LEAD] ⚠️ Error enviando WhatsApp al lead:`, waErr.message);
    }

    // ── 6. Enviar reporte al self-chat de Mariano ──
    try {
      const sock = getOwnerSock();
      if (sock?.user?.id) {
        const ownerJid = sock.user.id;
        const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;

        const report = `🏢 *NUEVO LEAD ENTERPRISE*

👤 *Nombre*: ${name}
📧 *Email*: ${email}
📱 *Teléfono*: ${phone}
🌐 *Website*: ${website || 'N/A'}
👥 *Equipo*: ${team_size || 'N/A'}
💬 *Mensaje*: ${message || 'Sin mensaje'}

📊 *Análisis del sitio web*:
${websiteAnalysis ? websiteAnalysis.substring(0, 3000) : 'No disponible'}

⏱️ Procesado en ${Date.now() - startTime}ms
🆔 Firestore: enterprise_leads/${leadId}`;

        await safeSendMessage(ownerSelf, report, { isSelfChat: true });
        console.log(`[ENTERPRISE-LEAD] ✅ Reporte enviado al self-chat del owner`);
      } else {
        console.warn(`[ENTERPRISE-LEAD] ⚠️ No se pudo enviar reporte — sock no conectado`);
      }
    } catch (reportErr) {
      console.error(`[ENTERPRISE-LEAD] ⚠️ Error enviando reporte al owner:`, reportErr.message);
    }

    // ── 7. Respuesta exitosa ──
    const elapsed = Date.now() - startTime;
    console.log(`[ENTERPRISE-LEAD] ✅ Lead ${leadId} procesado completamente en ${elapsed}ms`);
    res.json({ ok: true, leadId, processedInMs: elapsed });

  } catch (err) {
    console.error(`[ENTERPRISE-LEAD] 🔴 ERROR FATAL:`, err.message, err.stack);
    res.status(500).json({ error: 'Error procesando lead enterprise' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// INSTAGRAM DMs — Webhook + OAuth + Status endpoints
// ═══════════════════════════════════════════════════════════════════

// Verificación del webhook (Meta envía GET con challenge al configurar)
app.get('/api/instagram/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'miia-instagram-verify-2026';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log(`[INSTAGRAM] ✅ Webhook verificado por Meta`);
    return res.status(200).send(challenge);
  }
  console.warn(`[INSTAGRAM] ❌ Webhook verification failed (mode=${mode}, token=${token})`);
  return res.sendStatus(403);
});

// Recibir mensajes entrantes de Instagram DMs
app.post('/api/instagram/webhook', express.json(), async (req, res) => {
  // Responder 200 inmediatamente (Meta requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const messages = instagramHandler.parseWebhookMessages(req.body);
    if (messages.length === 0) return;

    for (const msg of messages) {
      // Ignorar ecos (mensajes enviados por nosotros)
      if (msg.isEcho) continue;
      // Ignorar mensajes vacíos
      if (!msg.text && (!msg.attachments || msg.attachments.length === 0)) continue;

      console.log(`[INSTAGRAM] 📨 Mensaje de ${msg.senderId} → ${msg.recipientId}: "${(msg.text || '').substring(0, 80)}"`);

      // Encontrar tenant por recipientId (el IG business account que recibe el DM)
      const tenant = await instagramHandler.findTenantByIgUserId(msg.recipientId);
      if (!tenant) {
        console.warn(`[INSTAGRAM] ⚠️ No hay tenant para igUserId=${msg.recipientId}. Mensaje ignorado.`);
        continue;
      }

      const { uid, tokenData } = tenant;
      const pageToken = tokenData.pageAccessToken || tokenData.accessToken;

      // Guardar mensaje entrante en historial
      await instagramHandler.saveIgMessage(uid, msg.senderId, 'user', msg.text || '[attachment]');

      // Obtener historial de conversación
      const history = await instagramHandler.getIgConversationHistory(uid, msg.senderId, 15);

      // Obtener perfil del contacto (nombre, username)
      let contactName = 'Usuario Instagram';
      try {
        const profile = await instagramHandler.getInstagramProfile(msg.senderId, pageToken);
        if (profile?.name) contactName = profile.name;
      } catch (_) {}

      // Cargar datos del negocio del owner
      let businessContext = '';
      try {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          businessContext = `Negocio: ${userData.business_name || 'Sin nombre'}. ${userData.business_description || ''}`;
        }
      } catch (_) {}

      // Construir historial para el prompt
      const historyStr = history.map(m => `${m.role === 'user' ? contactName : 'MIIA'}: ${m.content}`).join('\n');

      // Generar respuesta con IA
      const igPrompt = `Sos MIIA, asistente IA del negocio. Un contacto te escribe por Instagram DM.
${businessContext}

REGLAS INSTAGRAM:
- Respondé como si fueras parte del equipo del negocio. NO reveles que sos IA.
- Mensajes CORTOS (máx 3 líneas). Instagram es informal y rápido.
- Si preguntan por productos/servicios, respondé con lo que sabés del negocio.
- Si preguntan algo que no sabés, decí que consultás con el equipo y le avisás.
- Si piden WhatsApp, podés dar el número del negocio.
- NUNCA uses hashtags ni emojis excesivos. Máximo 1-2 emojis.
- Tono: profesional pero cercano, como responde un community manager estrella.

HISTORIAL:
${historyStr || '(Primera interacción)'}

MENSAJE NUEVO de ${contactName}: ${msg.text}

Respondé de forma natural y útil:`;

      try {
        const aiResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, igPrompt, {}, { enableSearch: false });
        const response = aiResult?.text?.trim();

        if (response && response.length > 2) {
          // Enviar respuesta por Instagram DM
          const sent = await instagramHandler.sendInstagramMessage(msg.senderId, response, pageToken);
          if (sent) {
            // Guardar respuesta en historial
            await instagramHandler.saveIgMessage(uid, msg.senderId, 'assistant', response);
            console.log(`[INSTAGRAM] 📤 Respuesta enviada a ${contactName} (${msg.senderId}): "${response.substring(0, 60)}..."`);
          }
        }
      } catch (aiErr) {
        console.error(`[INSTAGRAM] ❌ Error generando respuesta IA:`, aiErr.message);
      }
    }
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error procesando webhook:`, err.message);
  }
});

// OAuth callback — redirigido desde Meta después de autorización
app.get('/api/instagram/oauth', async (req, res) => {
  const { code, state } = req.query;
  // state = uid del owner (enviado en el OAuth URL)
  if (!code || !state) {
    return res.status(400).send('Faltan parámetros (code/state). Cerrá esta ventana y reintentá desde el dashboard.');
  }

  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = `${process.env.BACKEND_URL || 'https://api.miia-app.com'}/api/instagram/oauth`;

  if (!appId || !appSecret) {
    return res.status(500).send('Instagram App no configurada. Contactá al administrador.');
  }

  try {
    const tokenData = await instagramHandler.exchangeCodeForToken(code, redirectUri, appId, appSecret);
    await instagramHandler.saveInstagramToken(state, tokenData);

    console.log(`[INSTAGRAM] ✅ Owner ${state.substring(0, 8)}... conectó Instagram (igUser=${tokenData.igUserId})`);

    // Redirigir al dashboard con éxito
    res.redirect(`${process.env.FRONTEND_URL || 'https://www.miia-app.com'}/owner-dashboard.html#connections?instagram=connected`);
  } catch (err) {
    console.error(`[INSTAGRAM] ❌ Error en OAuth:`, err.message);
    res.redirect(`${process.env.FRONTEND_URL || 'https://www.miia-app.com'}/owner-dashboard.html#connections?instagram=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// Estado de conexión Instagram de un tenant
app.get('/api/tenant/:uid/instagram/status', async (req, res) => {
  try {
    const tokenData = await instagramHandler.getInstagramToken(req.params.uid);
    if (!tokenData) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      igUserId: tokenData.igUserId,
      connectedAt: tokenData.connectedAt,
      expiresAt: tokenData.expiresAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener OAuth URL para conectar Instagram
app.get('/api/tenant/:uid/instagram/connect-url', (req, res) => {
  const appId = process.env.INSTAGRAM_APP_ID;
  if (!appId) {
    return res.status(500).json({ error: 'Instagram App no configurada' });
  }

  const redirectUri = encodeURIComponent(`${process.env.BACKEND_URL || 'https://api.miia-app.com'}/api/instagram/oauth`);
  const state = req.params.uid;
  // Permisos necesarios: mensajes, perfil básico, pages
  const scope = 'instagram_basic,instagram_manage_messages,pages_manage_metadata,pages_messaging';

  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&response_type=code`;

  res.json({ url });
});

// Desconectar Instagram
app.delete('/api/tenant/:uid/instagram', async (req, res) => {
  try {
    await admin.firestore()
      .collection('users').doc(req.params.uid)
      .collection('integrations').doc('instagram')
      .delete();

    console.log(`[INSTAGRAM] 🔌 Owner ${req.params.uid.substring(0, 8)}... desconectó Instagram`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inyectar dependencias en protection_manager
protectionManager.setProtectionDependencies({
  sendGenericEmail: mailService.sendGenericEmail,
  safeSendMessage,
  generateAIContent
});

// Inyectar dependencias en security_contacts
securityContacts.setSecurityContactDependencies({
  safeSendMessage,
  sendGenericEmail: mailService.sendGenericEmail
});

// Inyectar dependencias en email_manager
emailManager.setEmailManagerDependencies({
  sendGenericEmail: mailService.sendGenericEmail,
});

// Inyectar dependencias en config_validator
configValidator.setConfigValidatorDependencies({
  admin,
  safeSendMessage,
});

// Inyectar dependencias en biweekly_report
biweeklyReport.setReportDependencies({
  sendGenericEmail: mailService.sendGenericEmail,
  generateAIContent,
  getProtectionAlerts: protectionManager.getProtectionAlertsForReport
});

server.listen(PORT, () => {
  // 🎬 MIIA GIFS — Inicializar directorio de GIFs
  miiaGifs.initGifDirectory();

  // 🛡️ INTEGRITY GUARDS — Verificar que los fixes críticos siguen intactos
  integrityGuards.runIntegrityChecks();
  // Re-verificar cada 6 horas (protección contra hot-reloads parciales)
  setInterval(() => integrityGuards.runIntegrityChecks(), 6 * 60 * 60 * 1000);

  // 🏥 HEALTH MONITOR — Análisis de patrones cada 15 min
  setInterval(async () => {
    try {
      await healthMonitor.runAnalysis({
        safeSendMessage,
        ownerPhone: OWNER_PHONE,
        ownerUid: OWNER_UID
      });
      // Auto-restart de módulos si están muertos
      healthMonitor.attemptModuleRestart({ sportEngine });
    } catch (e) {
      console.error(`[HEALTH-MONITOR] ❌ Error en análisis: ${e.message}`);
    }
  }, 15 * 60 * 1000);
  console.log('[HEALTH-MONITOR] 🏥 Iniciado — análisis cada 15 min');

  privacyCounters.startAutoFlush();
  auditLogger.startAutoFlush();
  tenantLogger.startAutoFlush();
  // Inicializar Content Safety Shield
  try {
    const { callGeminiVision } = require('./ai/gemini_client');
    contentSafety.init({
      admin,
      callGeminiVision: typeof callGeminiVision === 'function' ? callGeminiVision : null,
      generateAIContent,
      ownerPhone: OWNER_PHONE,
    });
  } catch (safetyErr) {
    console.error(`[SAFETY-SHIELD] ❌ Error inicializando: ${safetyErr.message} — Shield funcionará en modo FAIL-SAFE`);
  }
  // ═══ GMAIL CRON — Check periódico de emails (cada 15 min) ═══
  setInterval(async () => {
    if (!OWNER_UID || !OWNER_PHONE) return;
    try {
      const gmailConfigDoc = await admin.firestore()
        .collection('users').doc(OWNER_UID)
        .collection('miia_gmail').doc('config').get();
      const gmailConfig = gmailConfigDoc.exists ? gmailConfigDoc.data() : {};
      if (!gmailConfig.enabled) return; // Gmail no activado

      // Solo check si pasaron >15 min desde el último
      const lastCheck = gmailConfig.lastCheck ? new Date(gmailConfig.lastCheck) : new Date(0);
      if (Date.now() - lastCheck.getTime() < gmailIntegration.GMAIL_CHECK_INTERVAL_MS) return;

      // Solo en horario activo (10am-22pm)
      const hour = new Date().getHours();
      if (hour < 10 || hour >= 22) return;

      console.log(`[GMAIL:CRON] 🔄 Check periódico de emails...`);
      const generateAIForGmail = async (prompt) => {
        const result = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, prompt, ownerAIConfig);
        return result.text;
      };
      const result = await gmailIntegration.runFullEmailCheck(OWNER_UID, getOAuth2Client, {
        generateAI: generateAIForGmail,
        autoDeleteSpam: true,
      });

      // Solo notificar si hay algo relevante (no spam puro o vacío)
      if (result.summary.important > 0 || result.summary.personal > 0 || result.summary.doubtful > 0) {
        await safeSendMessage(OWNER_PHONE, result.message, { isSelfChat: true, skipEmoji: true });
        console.log(`[GMAIL:CRON] ✅ Notificación enviada al owner`);
      } else if (result.summary.spam > 0) {
        console.log(`[GMAIL:CRON] 🗑️ Solo spam detectado (${result.summary.spam}) — eliminado silenciosamente`);
      }
    } catch (cronErr) {
      // No romper el servidor por error de Gmail
      if (!/googleTokens|no conectado/i.test(cronErr.message)) {
        console.error(`[GMAIL:CRON] ❌ Error: ${cronErr.message}`);
      }
    }
  }, gmailIntegration.GMAIL_CHECK_INTERVAL_MS);

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

        // 🛡️ FIX CRÍTICO: loadFromFirestore se ejecutaba ANTES de que OWNER_UID existiera
        // → conversations, contactTypes, leadNames NUNCA se cargaban de Firestore
        // → MIIA decía "no tengo esa info" cuando le preguntaban por leads
        if (OWNER_UID) {
          const loaded = await loadFromFirestore();
          if (loaded) {
            const convCount = Object.keys(conversations).length;
            const leadCount = Object.keys(contactTypes).filter(k => contactTypes[k] === 'lead' || contactTypes[k] === 'miia_lead').length;
            console.log(`[AUTO-INIT] 🔄 Datos de Firestore cargados: ${convCount} conversaciones, ${leadCount} leads`);
          }
        }

        // 1.5. MIIA CENTER 24/7: asegurar que el admin (MIIA CENTER) tenga schedule alwaysOn
        if (OWNER_UID) {
          try {
            const schedRef = admin.firestore().collection('users').doc(OWNER_UID).collection('settings').doc('schedule');
            const schedDoc = await schedRef.get();
            if (!schedDoc.exists || !schedDoc.data()?.alwaysOn) {
              await schedRef.set({ alwaysOn: true }, { merge: true });
              console.log(`[AUTO-INIT] ✅ MIIA CENTER schedule: alwaysOn=true (24/7 para leads)`);
            }
          } catch (e) {
            console.warn(`[AUTO-INIT] ⚠️ Error seteando alwaysOn: ${e.message}`);
          }
        }

        // 1.6. Cargar affinity desde Firestore (ANTES de conectar WhatsApp)
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
            // Cualquier usuario con rol owner/admin/founder necesita self-chat activo
            const userRole = userData.role || 'owner';
            const isOwnerRole = ['admin', 'owner', 'founder'].includes(userRole);

            console.log(`[AUTO-INIT] 🔄 Reconectando ${isOwner ? 'OWNER' : (isOwnerRole ? 'owner' : 'tenant')} ${uid.substring(0, 12)}... (WA: ${savedNumber || 'sin registro'}, role: ${userRole})`);

            // CRÍTICO: el admin necesita onMessage para rutear a handleIncomingMessage.
            // Otros owners necesitan isOwnerAccount=true para que self-chat funcione
            // via handleTenantMessage (el else branch en tenant_manager).
            const options = isOwner ? {
              isOwnerAccount: true,
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
                // Extraer quotedText del contextInfo
                const ctxInfo2 = baileysMsg.message?.extendedTextMessage?.contextInfo
                  || baileysMsg.message?.imageMessage?.contextInfo
                  || baileysMsg.message?.videoMessage?.contextInfo
                  || baileysMsg.message?.documentMessage?.contextInfo
                  || null;
                let quotedText2 = null;
                if (ctxInfo2?.quotedMessage) {
                  const qm2 = ctxInfo2.quotedMessage;
                  quotedText2 = qm2.conversation || qm2.extendedTextMessage?.text || qm2.imageMessage?.caption || qm2.videoMessage?.caption || '[media]';
                }
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
                  _baileysMsg: baileysMsg,
                  _quotedText: quotedText2
                };
                handleIncomingMessage(adapted);
              },
              onReady: (sock) => {
                // Actualizar número si cambió (el owner puede vincular otro teléfono)
                const connectedNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
                if (savedNumber && connectedNumber && connectedNumber !== savedNumber) {
                  console.log(`[AUTO-INIT] ⚠️ OWNER: número cambió! Guardado: ${savedNumber}, Conectado: ${connectedNumber}. Actualizando.`);
                  admin.firestore().collection('users').doc(uid).update({
                    whatsapp_number: connectedNumber
                  }).catch(() => {});
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

                // Feature Announcer — anunciar novedades 60s después de conectar
                featureAnnouncer.init(admin, { ttsEngine, safeSendMessage, generateAI: generateAIContent });
                setTimeout(async () => {
                  try {
                    const ownerSelf = `${connectedNumber}@s.whatsapp.net`;
                    await featureAnnouncer.checkAndAnnounce(OWNER_UID, async (msg) => {
                      await safeSendMessage(ownerSelf, msg, { isSelfChat: true, skipEmoji: true });
                    }, ownerSelf);
                  } catch (announceErr) {
                    console.error(`[FEATURE-ANNOUNCER] ❌ Error en anuncio post-conexión: ${announceErr.message}`);
                  }
                }, 60000); // Esperar 60s para no spamear al conectar

                // Config Validator — validar configuración 90s después de conectar
                setTimeout(async () => {
                  try {
                    const ownerSelf = `${connectedNumber}@s.whatsapp.net`;
                    await configValidator.validateAndNotify(OWNER_UID, ownerSelf);
                  } catch (valErr) {
                    console.error(`[CONFIG-VALIDATOR] ❌ Error en validación post-conexión: ${valErr.message}`);
                  }
                }, 90000); // 90s para no solaparse con el feature announcer
              }
            } : {
              // Non-admin tenant: owners necesitan isOwnerAccount para self-chat
              isOwnerAccount: isOwnerRole,
              onReady: (sock) => {
                const connectedNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
                if (savedNumber && connectedNumber && connectedNumber !== savedNumber) {
                  console.log(`[AUTO-INIT] ⚠️ Tenant ${uid.substring(0, 12)}...: número cambió! Guardado: ${savedNumber}, Conectado: ${connectedNumber}. Actualizando Firestore.`);
                }
                console.log(`[AUTO-INIT] ✅ Tenant ${uid.substring(0, 12)}... conectado (${connectedNumber})`);
                if (connectedNumber) {
                  admin.firestore().collection('users').doc(uid).update({
                    whatsapp_number: connectedNumber,
                    whatsapp_connected_at: new Date()
                  }).catch(() => {});

                  // 📢 Feature Announcer para tenants — 60s post-conexión
                  setTimeout(async () => {
                    try {
                      const tenantSelf = `${connectedNumber}@s.whatsapp.net`;
                      const tenantSock = tenantManager.getTenantStatus(uid)?.sock;
                      if (!tenantSock) return;
                      await featureAnnouncer.checkAndAnnounce(uid, async (msg) => {
                        try {
                          await tenantSock.sendMessage(tenantSelf, { text: msg });
                        } catch (e) { console.warn(`[FEATURE-ANNOUNCER:${uid}] ⚠️ Error enviando: ${e.message}`); }
                      }, tenantSelf);
                    } catch (e) {
                      console.warn(`[FEATURE-ANNOUNCER:${uid}] ⚠️ Error: ${e.message}`);
                    }
                  }, 60000);
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

// Test IMAP connection (sin guardar, solo probar)
app.post('/api/email/test-imap', express.json(), async (req, res) => {
  const { imapHost, imapUser, imapPass } = req.body || {};
  if (!imapHost || !imapUser || !imapPass) {
    return res.json({ ok: false, error: 'Faltan campos: host, usuario o contrasena' });
  }
  try {
    const Imap = require('imap');
    const imap = new Imap({ user: imapUser, password: imapPass, host: imapHost, port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 10000, authTimeout: 8000 });
    await new Promise((resolve, reject) => {
      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) { imap.end(); reject(err); return; }
          const count = box.messages?.total || 0;
          imap.end();
          resolve(count);
        });
      });
      imap.once('error', reject);
      imap.connect();
    }).then(count => {
      res.json({ ok: true, messageCount: count });
    });
  } catch (e) {
    console.warn(`[IMAP-TEST] Error: ${e.message}`);
    let userMsg = e.message;
    if (e.message.includes('Invalid credentials')) userMsg = 'Credenciales invalidas. Si usas Gmail, necesitas una App Password.';
    else if (e.message.includes('ENOTFOUND')) userMsg = 'Host no encontrado. Verifica que el host IMAP sea correcto.';
    else if (e.message.includes('ETIMEDOUT')) userMsg = 'Timeout. El servidor no respondio a tiempo.';
    res.json({ ok: false, error: userMsg });
  }
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

// getOAuth2Client — delegado al módulo compartido google_calendar.js
const getOAuth2Client = googleCalendar.getOAuth2Client;

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
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/contacts',
    ],
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
    console.log(`[GOOGLE] ✅ Google Calendar + Gmail conectado para uid=${uid}`);
    res.send('<html><body style="background:#0f0f0f;color:#fff;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center"><h2>✅ Google Calendar + Gmail conectados</h2><p>MIIA ahora puede gestionar tu agenda y tu correo.</p><p>Ya podés cerrar esta ventana.</p></div></body></html>');
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

// ═══════════════════════════════════════════════════════════════
// GOOGLE SHEETS + DOCS API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Listar spreadsheets del owner
app.get('/api/sheets/list', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const files = await sheetsIntegration.listSpreadsheets(uid, parseInt(req.query.limit) || 10);
    res.json({ ok: true, spreadsheets: files });
  } catch (e) {
    console.error('[SHEETS-API] ❌ list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Leer datos de un spreadsheet
app.get('/api/sheets/:spreadsheetId/read', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { spreadsheetId } = req.params;
    const range = req.query.range || 'Sheet1';
    const data = await sheetsIntegration.readSheet(uid, spreadsheetId, range);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[SHEETS-API] ❌ read error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Info de un spreadsheet (hojas, tamaño)
app.get('/api/sheets/:spreadsheetId/info', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const info = await sheetsIntegration.getSpreadsheetInfo(uid, req.params.spreadsheetId);
    res.json({ ok: true, ...info });
  } catch (e) {
    console.error('[SHEETS-API] ❌ info error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Escribir datos en un spreadsheet
app.post('/api/sheets/:spreadsheetId/write', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { range, values } = req.body;
    if (!range || !values) return res.status(400).json({ error: 'range y values requeridos' });
    const result = await sheetsIntegration.writeSheet(uid, req.params.spreadsheetId, range, values);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[SHEETS-API] ❌ write error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Append filas a un spreadsheet
app.post('/api/sheets/:spreadsheetId/append', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { range, values } = req.body;
    if (!values) return res.status(400).json({ error: 'values requerido' });
    const result = await sheetsIntegration.appendSheet(uid, req.params.spreadsheetId, range || 'Sheet1!A:Z', values);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[SHEETS-API] ❌ append error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Crear nuevo spreadsheet
app.post('/api/sheets/create', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { title, sheetNames } = req.body;
    if (!title) return res.status(400).json({ error: 'title requerido' });
    const result = await sheetsIntegration.createSpreadsheet(uid, title, sheetNames);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[SHEETS-API] ❌ create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analizar datos con IA
app.post('/api/sheets/:spreadsheetId/analyze', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const range = req.body.range || 'Sheet1';
    const question = req.body.question || '';
    const data = await sheetsIntegration.readSheet(uid, req.params.spreadsheetId, range);
    const analysis = await sheetsIntegration.analyzeSheetData(data.values, question, aiGateway);
    res.json({ ok: true, analysis, totalRows: data.totalRows });
  } catch (e) {
    console.error('[SHEETS-API] ❌ analyze error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Docs: crear
app.post('/api/docs/create', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { title, content } = req.body;
    if (!title) return res.status(400).json({ error: 'title requerido' });
    const result = await sheetsIntegration.createDocument(uid, title, content || '');
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[DOCS-API] ❌ create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Docs: leer
app.get('/api/docs/:documentId/read', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const data = await sheetsIntegration.readDocument(uid, req.params.documentId);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[DOCS-API] ❌ read error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Docs: append
app.post('/api/docs/:documentId/append', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text requerido' });
    await sheetsIntegration.appendDocument(uid, req.params.documentId, text);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DOCS-API] ❌ append error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE SERVICES API ENDPOINTS (Contacts, Drive, Places, YouTube)
// ═══════════════════════════════════════════════════════════════

// Google Contacts: buscar
app.get('/api/contacts/search', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const contacts = await googleServices.listContacts(req.user.uid, req.query.q, parseInt(req.query.limit) || 20);
    res.json({ ok: true, contacts });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ contacts search:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Contacts: crear
app.post('/api/contacts', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const contact = await googleServices.createContact(req.user.uid, req.body);
    res.json({ ok: true, contact });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ contacts create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Drive: listar/buscar archivos
app.get('/api/drive/files', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const files = await googleServices.listDriveFiles(req.user.uid, req.query.q, parseInt(req.query.limit) || 10);
    res.json({ ok: true, files });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ drive list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google Drive: compartir
app.post('/api/drive/:fileId/share', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: 'email requerido' });
    const result = await googleServices.shareDriveFile(req.user.uid, req.params.fileId, email, role || 'reader');
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ drive share:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Places: buscar
app.get('/api/places/search', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { q, location } = req.query;
    if (!q) return res.status(400).json({ error: 'q requerido' });
    const places = await googleServices.searchPlaces(q, location, aiGateway);
    res.json({ ok: true, places });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ places search:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// YouTube: buscar videos
app.get('/api/youtube/search', requireRole('owner', 'admin'), async (req, res) => {
  try {
    if (!req.query.q) return res.status(400).json({ error: 'q requerido' });
    const videos = await googleServices.searchYouTube(req.query.q, parseInt(req.query.limit) || 5);
    res.json({ ok: true, videos });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ youtube search:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// YouTube: info de canal
app.get('/api/youtube/channel/:channelId', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const info = await googleServices.getChannelInfo(req.params.channelId);
    res.json({ ok: true, channel: info });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ youtube channel:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Business Profile: buscar
app.get('/api/business-profile/search', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, location } = req.query;
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const profile = await googleServices.getBusinessProfile(name, location, aiGateway);
    res.json({ ok: true, profile });
  } catch (e) {
    console.error('[GSERVICES-API] ❌ business profile:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// RESERVATIONS API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Buscar negocios (via Gemini google_search)
app.post('/api/reservations/search', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const { type, zone, date, time, partySize } = req.body;
    if (!type) return res.status(400).json({ error: 'type requerido' });
    const ownerCountry = getCountryFromPhone(OWNER_PHONE);
    const results = await reservationsIntegration.searchBusinesses(
      { type, zone, date, time, partySize, ownerCity: zone, ownerCountry },
      aiGateway
    );
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Crear reserva
app.post('/api/reservations', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const reservation = await reservationsIntegration.createReservation(uid, req.body);
    res.json({ ok: true, reservation });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Listar reservas
app.get('/api/reservations', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { status, type, limit } = req.query;
    const reservations = await reservationsIntegration.getReservations(uid, {
      status, type, limit: parseInt(limit) || 20
    });
    res.json({ ok: true, reservations });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Actualizar reserva
app.put('/api/reservations/:id', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const result = await reservationsIntegration.updateReservation(uid, req.params.id, req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Cancelar reserva
app.delete('/api/reservations/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    await reservationsIntegration.cancelReservation(uid, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ cancel error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Calificar reserva
app.post('/api/reservations/:id/rate', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { rating } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 requerido' });
    const result = await reservationsIntegration.rateReservation(uid, req.params.id, rating);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ rate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Listar favoritos
app.get('/api/reservations/favorites', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const favorites = await reservationsIntegration.getFavorites(uid, req.query.type);
    res.json({ ok: true, favorites });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ favorites error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Guardar favorito
app.post('/api/reservations/favorites', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { businessPhone, ...data } = req.body;
    if (!businessPhone) return res.status(400).json({ error: 'businessPhone requerido' });
    const result = await reservationsIntegration.saveFavorite(uid, businessPhone, data);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[RESERVATIONS-API] ❌ save favorite error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// VOICE COMMAND — Procesar comando de voz desde el dashboard
// ═══════════════════════════════════════════════════════════════

app.post('/api/voice-command', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { text, source } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'Texto vacío' });

    console.log(`[VOICE-CMD] 🎙️ Comando de voz (${source || 'unknown'}): "${text.substring(0, 100)}..." — uid: ${uid}`);

    // Verificar que el usuario tiene WhatsApp conectado
    if (!sock || !OWNER_PHONE) {
      return res.json({ success: true, response: 'Comando recibido, pero WhatsApp no está conectado. Conectá WhatsApp primero para que MIIA pueda ejecutar acciones.' });
    }

    // Enviar como self-chat message (MIIA lo procesará como comando del owner)
    const selfJid = `${OWNER_PHONE}@s.whatsapp.net`;

    // Simular que el owner envió este mensaje en self-chat
    // Esto dispara todo el pipeline de procesamiento (tags, integraciones, etc.)
    const voicePrefix = source === 'voice_dashboard' ? '🎙️ ' : '';
    await safeSendMessage(selfJid, `${voicePrefix}${text}`, { isSelfChat: true, skipEmoji: true });

    console.log(`[VOICE-CMD] ✅ Comando enviado como self-chat: "${text.substring(0, 60)}..."`);
    res.json({ success: true, response: `Comando enviado a MIIA: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"` });
  } catch (err) {
    console.error(`[VOICE-CMD] ❌ Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// R3: FAVORITOS INTELIGENTES + RATING
// ═══════════════════════════════════════════════════════════════

// Smart lookup: "lo de siempre"
app.get('/api/reservations/smart-favorite', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { hint, type } = req.query;
    const result = await reservationsIntegration.smartFavoriteLookup(uid, hint, type);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[API] ❌ smart-favorite:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reservas pendientes de rating
app.get('/api/reservations/pending-rating', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const results = await reservationsIntegration.getReservationsPendingRating(uid);
    res.json({ success: true, data: results });
  } catch (err) {
    console.error(`[API] ❌ pending-rating:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Historial de visitas a un negocio
app.get('/api/reservations/history/:phone', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const history = await reservationsIntegration.getVisitHistory(uid, req.params.phone);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error(`[API] ❌ visit-history:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// R2: RED INTER-MIIA — Endpoints de red de negocios
// ═══════════════════════════════════════════════════════════════

// Registrar negocio en la red MIIA
app.post('/api/miia-network/register', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const result = await reservationsIntegration.registerInMiiaNetwork(uid, req.body);
    if (!result) return res.status(400).json({ success: false, error: 'Se requiere un teléfono' });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[API] ❌ miia-network register:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Desregistrar negocio de la red MIIA
app.post('/api/miia-network/unregister', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    await reservationsIntegration.unregisterFromMiiaNetwork(req.body.phone);
    res.json({ success: true });
  } catch (err) {
    console.error(`[API] ❌ miia-network unregister:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Buscar negocios en la red MIIA
app.get('/api/miia-network/search', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { type, city, country } = req.query;
    const results = await reservationsIntegration.searchMiiaNetwork({ type, city, country });
    res.json({ success: true, data: results });
  } catch (err) {
    console.error(`[API] ❌ miia-network search:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ver solicitudes de reserva recibidas por mi negocio
app.get('/api/miia-network/requests', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const phone = req.query.phone;
    const status = req.query.status;
    if (!phone) return res.status(400).json({ success: false, error: 'Se requiere phone' });
    const requests = await reservationsIntegration.getReceivedReservations(phone, status);
    res.json({ success: true, data: requests });
  } catch (err) {
    console.error(`[API] ❌ miia-network requests:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Confirmar/rechazar solicitud de reserva recibida
app.put('/api/miia-network/requests/:requestId', requireRole('owner', 'admin'), express.json(), async (req, res) => {
  try {
    const { phone, status } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Se requiere phone' });
    await reservationsIntegration.updateReceivedReservation(phone, req.params.requestId, status);
    res.json({ success: true });
  } catch (err) {
    console.error(`[API] ❌ miia-network request update:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GMAIL API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/gmail/status', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const doc = await admin.firestore().collection('users').doc(uid).get();
    const data = doc.exists ? doc.data() : {};
    const gmailConfigDoc = await admin.firestore()
      .collection('users').doc(uid)
      .collection('miia_gmail').doc('config').get();
    const gmailConfig = gmailConfigDoc.exists ? gmailConfigDoc.data() : {};
    res.json({
      connected: !!(data.googleTokens),
      enabled: !!gmailConfig.enabled,
      lastCheck: gmailConfig.lastCheck || null,
      lastSummary: gmailConfig.lastSummary || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gmail/check', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const uid = req.user.uid;
    const generateAIForGmail = async (prompt) => {
      const result = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, prompt, ownerAIConfig);
      return result.text;
    };
    const result = await gmailIntegration.runFullEmailCheck(uid, getOAuth2Client, {
      generateAI: generateAIForGmail,
      autoDeleteSpam: true,
    });
    res.json(result);
  } catch (e) {
    console.error(`[GMAIL:API] ❌ Error en /api/gmail/check: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gmail/enable', requireRole('owner', 'agent'), express.json(), async (req, res) => {
  try {
    const uid = req.user.uid;
    const { enabled } = req.body;
    await admin.firestore()
      .collection('users').doc(uid)
      .collection('miia_gmail').doc('config')
      .set({ enabled: !!enabled }, { merge: true });
    console.log(`[GMAIL] ${enabled ? '✅ Activado' : '🔴 Desactivado'} para uid=${uid.substring(0, 8)}`);
    res.json({ ok: true, enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// getCalendarClient, checkCalendarAvailability, createCalendarEvent — delegados a módulo compartido google_calendar.js
const getCalendarClient = googleCalendar.getCalendarClient;
const checkCalendarAvailability = googleCalendar.checkCalendarAvailability;
const createCalendarEvent = googleCalendar.createCalendarEvent;

/**
 * proposeCalendarSlot — Busca el próximo hueco libre en Calendar y propone horarios.
 * @param {string} uid - UID del owner
 * @param {number} durationMinutes - Duración deseada en minutos (default: 60)
 * @param {number} daysAhead - Cuántos días buscar (default: 3)
 * @returns {Promise<Array<{date: string, start: string, end: string}>>} Slots libres
 */
async function proposeCalendarSlot(uid, durationMinutes = 60, daysAhead = 3) {
  const proposals = [];
  const schedCfg = await getScheduleConfig(uid);
  const tz = schedCfg?.timezone || 'America/Bogota';
  const workStart = schedCfg?.workStartHour || 9;
  const workEnd = schedCfg?.workEndHour || 18;

  for (let d = 0; d < daysAhead; d++) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + d);
    // Skip weekends if owner has weekendMode
    const day = targetDate.getDay();
    if (day === 0 || day === 6) continue;

    const dateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
    try {
      const avail = await checkCalendarAvailability(dateStr, uid);
      // Filter free slots that fit the requested duration
      for (const slot of avail.freeSlots) {
        const [startStr] = slot.split(' - ');
        const startHour = parseInt(startStr);
        if (startHour < workStart || startHour + Math.ceil(durationMinutes / 60) > workEnd) continue;
        proposals.push({
          date: dateStr,
          start: `${String(startHour).padStart(2, '0')}:00`,
          end: `${String(startHour + Math.ceil(durationMinutes / 60)).padStart(2, '0')}:00`,
          display: `${dateStr} de ${startHour}:00 a ${startHour + Math.ceil(durationMinutes / 60)}:00`
        });
        if (proposals.length >= 5) break; // Max 5 proposals
      }
    } catch (e) {
      console.warn(`[GCAL] ⚠️ Error checking availability for ${dateStr}:`, e.message);
    }
    if (proposals.length >= 5) break;
  }
  console.log(`[GCAL] 📋 Propuestas de horario: ${proposals.length} slots en ${daysAhead} días`);
  return proposals;
}

/**
 * detectCalendarSystem — Auto-detecta el sistema de calendario del owner.
 * Basado en su email de registro.
 * @param {string} email - Email del usuario
 * @returns {string} 'google' | 'outlook' | 'unknown'
 */
function detectCalendarSystem(email) {
  if (!email) return 'unknown';
  const domain = email.split('@')[1]?.toLowerCase() || '';
  // Google domains
  if (domain === 'gmail.com' || domain === 'googlemail.com' || domain.endsWith('.google.com')) return 'google';
  // Microsoft domains
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  // Workspace/custom domains — check if they use Google Workspace (MX records would be ideal, but for now default to asking)
  // For enterprise domains, the owner should configure in Conexiones
  return 'unknown';
}

// Endpoints para que el dashboard/MIIA consulte/cree citas
app.get('/api/calendar/propose', requireRole('owner', 'agent'), async (req, res) => {
  try {
    const duration = parseInt(req.query.duration) || 60;
    const days = parseInt(req.query.days) || 3;
    const proposals = await proposeCalendarSlot(req.user.uid, duration, days);
    res.json({ proposals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/calendar/detect-system', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const calendarProvider = require('./core/calendar_provider');
    const userDoc = await admin.firestore().collection('users').doc(req.user.uid).get();
    const email = userDoc.data()?.email || req.user.email || '';
    const system = detectCalendarSystem(email);
    const providerInfo = await calendarProvider.detectCalendarProvider(req.user.uid);
    const supportedProviders = calendarProvider.getSupportedProviders();
    res.json({
      email,
      system,
      supported: system === 'google' || system === 'outlook',
      currentProvider: providerInfo,
      supportedProviders: Object.keys(supportedProviders).map(k => ({
        id: k,
        ...supportedProviders[k]
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ═══ DIAGNÓSTICO DE CALENDAR — Para resolver "eventos no aparecen" ═══
// Ruta autenticada (desde dashboard)
app.get('/api/calendar/diagnose', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const uid = req.query.uid || req.user.uid;
    console.log(`[GCAL-DIAG] 🔍 Ejecutando diagnóstico para uid=${uid}`);
    const result = await googleCalendar.diagnoseCalendar(uid);
    console.log(`[GCAL-DIAG] ${result.ok ? '✅' : '❌'} Diagnóstico completado: ${result.steps.length} pasos`);
    res.json(result);
  } catch (e) {
    console.error(`[GCAL-DIAG] ❌ Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Ruta pública con UID explícito (solo admin UIDs permitidos)
app.get('/api/tenant/:uid/calendar/diagnose', async (req, res) => {
  const { uid } = req.params;
  // Solo permitir diagnóstico para UIDs admin conocidos
  const ADMIN_UIDS = [OWNER_UID, 'bq2BbtCVF8cZo30tum584zrGATJ3', 'A5pMESWlfmPWCoCPRbwy85EzUzy2'];
  if (!ADMIN_UIDS.includes(uid)) {
    return res.status(403).json({ error: 'Solo disponible para cuentas admin' });
  }
  try {
    console.log(`[GCAL-DIAG] 🔍 Diagnóstico público para uid=${uid}`);
    const result = await googleCalendar.diagnoseCalendar(uid);
    console.log(`[GCAL-DIAG] ${result.ok ? '✅' : '❌'} Completado: ${result.steps.length} pasos`);
    res.json(result);
  } catch (e) {
    console.error(`[GCAL-DIAG] ❌ Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HOME STATS — Datos reales para las stat cards del dashboard home
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/tenant/:uid/home-stats', async (req, res) => {
  const { uid } = req.params;
  try {
    const db = admin.firestore();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Cargar contact_index + conversaciones en memoria del tenant en paralelo
    const [indexSnap, defaultBizSessionDoc] = await Promise.all([
      db.collection('users').doc(uid).collection('contact_index').get(),
      // Sesión de hoy del negocio default (para contar conversaciones)
      (async () => {
        const userDoc = await db.collection('users').doc(uid).get();
        const defaultBizId = userDoc.exists ? userDoc.data().defaultBusinessId : null;
        if (!defaultBizId) return null;
        const sessionDoc = await db.collection('users').doc(uid)
          .collection('businesses').doc(defaultBizId)
          .collection('sessions').doc(todayStr).get();
        return sessionDoc.exists ? sessionDoc : null;
      })()
    ]);

    // Contar leads activos, pre-ventas (cotización enviada), ventas cerradas
    let leadsActivos = 0;
    let preventas = 0;
    let ventasCerradas = 0;

    for (const doc of indexSnap.docs) {
      const data = doc.data();
      if (data.type === 'lead' || data.type === 'pending' || data.type === 'enterprise_lead') {
        const stage = data.stage || 'nuevo';
        if (stage === 'cerrado') {
          ventasCerradas++;
        } else if (stage === 'cotizacion_enviada') {
          preventas++;
        } else {
          leadsActivos++;
        }
      }
    }

    // Conversaciones hoy: contar phones únicos en la sesión de hoy
    let conversacionesHoy = 0;
    if (defaultBizSessionDoc) {
      const sessionData = defaultBizSessionDoc.data();
      if (sessionData.messages && Array.isArray(sessionData.messages)) {
        const uniquePhones = new Set();
        for (const msg of sessionData.messages) {
          if (msg.phone) uniquePhones.add(msg.phone);
          if (msg.from) uniquePhones.add(msg.from);
        }
        conversacionesHoy = uniquePhones.size;
      }
    }

    // Fallback: contar conversaciones desde memoria del tenant si hay
    if (conversacionesHoy === 0 && tenantManager) {
      try {
        const convs = await tenantManager.getTenantConversations(uid);
        // Contar solo las que tuvieron actividad hoy
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        conversacionesHoy = convs.filter(c => {
          const ts = c.timestamp;
          if (!ts) return false;
          const msgTime = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : new Date(ts).getTime();
          return msgTime >= todayStart;
        }).length;
      } catch (e) {
        console.warn('[HOME-STATS] Fallback conversaciones error:', e.message);
      }
    }

    console.log(`[HOME-STATS] uid:${uid.substring(0, 8)} → convs:${conversacionesHoy} leads:${leadsActivos} preventas:${preventas} ventas:${ventasCerradas}`);
    res.json({
      conversationsToday: conversacionesHoy,
      activeLeads: leadsActivos,
      presales: preventas,
      salesClosed: ventasCerradas
    });
  } catch (e) {
    console.error(`[HOME-STATS] ❌ Error uid:${uid.substring(0, 8)}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRM ANALYTICS ENDPOINTS — Pipeline, Nightly, Patterns, Metrics, Conversations
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Pipeline de ventas — leads agrupados por etapa
app.get('/api/tenant/:uid/analytics/pipeline', async (req, res) => {
  const { uid } = req.params;
  try {
    console.log(`[CRM-ANALYTICS] 📊 Pipeline solicitado para uid:${uid.substring(0, 8)}`);
    const db = admin.firestore();

    // Cargar contact_index completo
    const indexSnap = await db.collection('users').doc(uid).collection('contact_index').get();
    const stages = {
      nuevo: { name: 'Nuevo', count: 0, leads: [] },
      en_conversacion: { name: 'En conversación', count: 0, leads: [] },
      cotizacion_enviada: { name: 'Cotización enviada', count: 0, leads: [] },
      cerrado: { name: 'Cerrado', count: 0, leads: [] },
      perdido: { name: 'Perdido', count: 0, leads: [] }
    };

    let totalActive = 0;
    let totalCerrados = 0;
    const responseTimesAll = [];

    for (const doc of indexSnap.docs) {
      const data = doc.data();
      if (data.type !== 'lead' && data.type !== 'pending' && data.type !== 'enterprise_lead') continue;

      const stage = data.stage || 'nuevo';
      const stageKey = stages[stage] ? stage : 'nuevo';
      const lead = {
        phone: doc.id,
        name: data.name || doc.id.replace('@s.whatsapp.net', ''),
        lastActivity: data.lastActivity || data.updatedAt || null,
        businessId: data.businessId || null,
        stage: stageKey
      };

      stages[stageKey].leads.push(lead);
      stages[stageKey].count++;

      if (stageKey !== 'cerrado' && stageKey !== 'perdido') totalActive++;
      if (stageKey === 'cerrado') totalCerrados++;
      if (data.avgResponseMs) responseTimesAll.push(data.avgResponseMs);
    }

    const totalLeads = indexSnap.docs.filter(d => {
      const t = d.data().type;
      return t === 'lead' || t === 'pending' || t === 'enterprise_lead';
    }).length;
    const conversion = totalLeads > 0 ? Math.round((totalCerrados / totalLeads) * 100) : 0;
    const avgResponseMs = responseTimesAll.length > 0
      ? Math.round(responseTimesAll.reduce((a, b) => a + b, 0) / responseTimesAll.length)
      : 0;

    res.json({
      stages: Object.values(stages),
      totals: { active: totalActive, total: totalLeads, conversion, avgResponseMs }
    });
    console.log(`[CRM-ANALYTICS] ✅ Pipeline: ${totalLeads} leads, ${conversion}% conversión`);
  } catch (e) {
    console.error(`[CRM-ANALYTICS] ❌ Error pipeline uid:${uid.substring(0, 8)}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 2. Informes nocturnos IA
app.get('/api/tenant/:uid/analytics/nightly', async (req, res) => {
  const { uid } = req.params;
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  try {
    console.log(`[CRM-ANALYTICS] 🌙 Nightly reports (${days}d) para uid:${uid.substring(0, 8)}`);
    const db = admin.firestore();

    const snap = await db.collection('users').doc(uid)
      .collection('nightly_reports')
      .orderBy('date', 'desc')
      .limit(days)
      .get();

    const reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(reports);
    console.log(`[CRM-ANALYTICS] ✅ Nightly: ${reports.length} reportes devueltos`);
  } catch (e) {
    console.error(`[CRM-ANALYTICS] ❌ Error nightly uid:${uid.substring(0, 8)}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 3. ADN Vendedor / Análisis de patrones
app.get('/api/tenant/:uid/analytics/patterns', async (req, res) => {
  const { uid } = req.params;
  try {
    console.log(`[CRM-ANALYTICS] 🧬 Patterns para uid:${uid.substring(0, 8)}`);
    const db = admin.firestore();

    const snap = await db.collection('users').doc(uid)
      .collection('pattern_analysis')
      .orderBy('date', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      res.json({ date: null, patterns: null, adn_vendedor: null, message: 'Sin análisis aún. Se genera automáticamente cada noche.' });
      return;
    }

    const latest = { id: snap.docs[0].id, ...snap.docs[0].data() };

    // También traer ADN acumulado
    const adnDoc = await db.collection('users').doc(uid)
      .collection('pattern_analysis').doc('adn_vendedor').get();

    latest.adn_vendedor = adnDoc.exists ? adnDoc.data() : null;
    res.json(latest);
    console.log(`[CRM-ANALYTICS] ✅ Patterns: fecha ${latest.date}, ${latest.conversationsAnalyzed || 0} conversaciones`);
  } catch (e) {
    console.error(`[CRM-ANALYTICS] ❌ Error patterns uid:${uid.substring(0, 8)}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 4. Métricas diarias (mensajes, IA, errores, tiempos)
app.get('/api/tenant/:uid/analytics/metrics', async (req, res) => {
  const { uid } = req.params;
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  try {
    console.log(`[CRM-ANALYTICS] 📈 Metrics (${days}d) para uid:${uid.substring(0, 8)}`);
    const db = admin.firestore();

    // Generar fechas de los últimos N días
    const dates = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push('daily_' + d.toISOString().split('T')[0]);
    }

    // Fetch en paralelo
    const promises = dates.map(dateId =>
      db.collection('users').doc(uid).collection('miia_metrics').doc(dateId).get()
    );
    const docs = await Promise.all(promises);

    const metrics = docs
      .filter(d => d.exists)
      .map(d => {
        const data = d.data();
        const responseTimes = data.responseTimesMs || [];
        const avgResponse = responseTimes.length > 0
          ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
          : 0;
        return {
          date: d.id.replace('daily_', ''),
          messagesProcessed: data.messagesProcessed || 0,
          messagesFromLeads: data.messagesFromLeads || 0,
          messagesFromOwner: data.messagesFromOwner || 0,
          messagesFromFamily: data.messagesFromFamily || 0,
          aiCalls: data.aiCalls || 0,
          aiTokensEstimated: data.aiTokensEstimated || 0,
          errors: data.errors || 0,
          avgResponseMs: avgResponse,
          outreachSent: data.outreachSent || 0,
          agendaEvents: data.agendaEvents || 0
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json(metrics);
    console.log(`[CRM-ANALYTICS] ✅ Metrics: ${metrics.length} días con datos`);
  } catch (e) {
    console.error(`[CRM-ANALYTICS] ❌ Error metrics uid:${uid.substring(0, 8)}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 5. Conversaciones activas (vista en vivo)
app.get('/api/tenant/:uid/analytics/conversations', async (req, res) => {
  const { uid } = req.params;
  try {
    console.log(`[CRM-ANALYTICS] 💬 Conversations para uid:${uid.substring(0, 8)}`);
    const db = admin.firestore();

    const convSnap = await db.collection('users').doc(uid)
      .collection('conversations')
      .orderBy('lastActivity', 'desc')
      .limit(50)
      .get();

    if (convSnap.empty) {
      res.json([]);
      return;
    }

    // Enriquecer con contact_index
    const conversations = [];
    for (const doc of convSnap.docs) {
      const data = doc.data();
      const phone = doc.id;

      // Buscar info del contacto
      let contactInfo = {};
      try {
        const indexDoc = await db.collection('users').doc(uid)
          .collection('contact_index').doc(phone).get();
        if (indexDoc.exists) contactInfo = indexDoc.data();
      } catch {}

      const msgs = data.messages || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const lastActivity = data.lastActivity || (lastMsg ? lastMsg.timestamp : null);

      // Determinar status: active (<5min), waiting (<1h), idle (>1h)
      const now = Date.now();
      const lastTs = lastActivity ? new Date(lastActivity).getTime() : 0;
      const diffMin = (now - lastTs) / 60000;
      let status = 'idle';
      if (diffMin < 5) status = 'active';
      else if (diffMin < 60) status = 'waiting';

      conversations.push({
        phone,
        name: contactInfo.name || data.contactName || phone.replace('@s.whatsapp.net', ''),
        type: contactInfo.type || 'unknown',
        businessId: contactInfo.businessId || null,
        lastMessage: lastMsg ? (lastMsg.content || lastMsg.text || '').substring(0, 100) : '',
        lastMessageFrom: lastMsg ? lastMsg.role || 'unknown' : '',
        lastActivity,
        status,
        messageCount: msgs.length
      });
    }

    res.json(conversations);
    console.log(`[CRM-ANALYTICS] ✅ Conversations: ${conversations.length} activas`);
  } catch (e) {
    console.error(`[CRM-ANALYTICS] ❌ Error conversations uid:${uid.substring(0, 8)}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Export app for testing
module.exports = app;