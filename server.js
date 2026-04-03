require('dotenv').config();

// Fix: gRPC DNS resolver for Firebase Admin SDK on Railway/Docker (Node 18)
process.env.GRPC_DNS_RESOLVER = 'native';

// Silenciar logs de libsignal (SessionEntry dumps, "Closing session", "Decrypted message with closed session")
// Estos llenan Railway logs a 500/sec sin aportar info útil
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _signalFilter = /Closing session:|SessionEntry|_chains:|chainKey:|ephemeralKeyPair|lastRemoteEphemeralKey|previousCounter|rootKey|indexInfo|baseKey:|baseKeyType|registrationId|currentRatchet|pubKey:|privKey:|remoteIdentityKey|Decrypted message with closed|Closing open session/;
console.log = (...args) => { if (typeof args[0] === 'string' && _signalFilter.test(args[0])) return; _origLog(...args); };
console.error = (...args) => { if (typeof args[0] === 'string' && _signalFilter.test(args[0])) return; _origErr(...args); };

// Catch unhandled rejections
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
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

// CEREBRO ABSOLUTO — módulo de aprendizaje autónomo nocturno
const cerebroAbsoluto = require('./cerebro_absoluto');

// CONFIDENCE ENGINE — evaluación inteligente de contenido importante para aprendizaje autónomo
const confidenceEngine = require('./confidence_engine');

// GENERADOR DE COTIZACIONES PDF
const cotizacionGenerator = require('./cotizacion_generator');

// SCRAPER REGULATORIO — actualización normativa semanal
const webScraper = require('./web_scraper');

// ESTADÍSTICAS — seguimiento de conversiones y pipeline
const estadisticas = require('./estadisticas');

// TENANT MANAGER — multi-tenant WhatsApp isolation
const tenantManager = require('./tenant_manager');

// TENANT MESSAGE HANDLER — orquestador completo para owners/agents (Option D Fase 2)
const tenantMessageHandler = require('./tenant_message_handler');

// MESSAGE LOGIC — funciones puras compartidas (normalizeText, tags, geo, etc.)
const messageLogic = require('./message_logic');

// BUSINESSES & CONTACT GROUPS ROUTES
const businessesRouter = require('./routes/businesses');

// UNIFIED MODULES — extracted from duplicated code
const { callGemini, callGeminiChat } = require('./gemini_client');
const { callAI, callAIChat, PROVIDER_LABELS } = require('./ai_client');
const { buildPrompt, buildTenantBrainString, buildOwnerSelfChatPrompt, buildOwnerFamilyPrompt, buildOwnerLeadPrompt, buildEquipoPrompt } = require('./prompt_builder');

// NUEVAS FUNCIONALIDADES
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
  '573125027604': { name: null, presented: false },
  '573108447586': { name: null, presented: false },
  '573175058386': { name: null, presented: false },
  '573014259700': { name: null, presented: false }
};

// Leads pre-registrados (MIIA los trata como potenciales clientes de Medilink)
let allowedLeads = [];
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

    if (pendingSnap.empty) return;

    for (const doc of pendingSnap.docs) {
      const evt = doc.data();
      const phone = evt.contactPhone === 'self' || evt.contactPhone === OWNER_PHONE
        ? `${OWNER_PHONE}@s.whatsapp.net`
        : (evt.contactPhone.includes('@') ? evt.contactPhone : `${evt.contactPhone}@s.whatsapp.net`);

      // Generar mensaje con Gemini usando contexto
      const history = (conversations[phone] || []).slice(-10).map(m => `${m.role === 'user' ? 'Contacto' : 'MIIA'}: ${m.content}`).join('\n');
      const prompt = `Sos MIIA. Tenés que escribirle a ${evt.contactName || 'este contacto'}.
Razón del recordatorio: ${evt.reason}
Guía: ${evt.promptHint || 'Sé natural y breve.'}
Historial reciente:\n${history || '(sin historial)'}
Escribí UN mensaje corto, natural, cálido, con tu personalidad. Recordale el evento naturalmente, como si fuera espontáneo. Máximo 3 líneas.`;

      let enableSearch = evt.searchBefore || false;

      try {
        const response = await generateAIContent(prompt, { enableSearch });
        if (response && response.length > 5) {
          // Enviar recordatorio al contacto destinatario
          await safeSendMessage(phone, response);
          console.log(`[AGENDA] 📤 Recordatorio enviado a ${evt.contactName}: "${response.substring(0, 60)}..."`);

          // Si lo pidió alguien del círculo (no el owner en self-chat), informar al owner también
          if (evt.requestedBy && evt.requestedBy !== `${OWNER_PHONE}@s.whatsapp.net` && evt.source !== 'owner_selfchat') {
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `📅 MIIA acaba de recordarle a *${evt.contactName}*: "${evt.reason}"`
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

// Cada 30 min. Primera ejecución 3 min post-startup.
setInterval(runAgendaEngine, 1800000);
setTimeout(runAgendaEngine, 180000);

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
  name: 'MIIA Owner', phone: '573054169969', email: '', goal: 1500,
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
// Baileys uses @s.whatsapp.net, whatsapp-web.js used @s.whatsapp.net
// Normalize all JIDs to Baileys format
const toJid = (phone) => phone.includes('@') ? phone.replace('@s.whatsapp.net', '@s.whatsapp.net') : `${phone}@s.whatsapp.net`;
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
  const ownerTz = getTimezoneForCountry(getCountryFromPhone(OWNER_PHONE));
  const localDateString = new Date().toLocaleString('en-US', { timeZone: ownerTz });
  const bogotaDate = new Date(localDateString);
  const day = bogotaDate.getDay() === 0 ? 7 : bogotaDate.getDay();
  if (!automationSettings.schedule.days.includes(day)) return false;
  const time = `${bogotaDate.getHours().toString().padStart(2, '0')}:${bogotaDate.getMinutes().toString().padStart(2, '0')}`;
  return time >= automationSettings.schedule.start && time <= automationSettings.schedule.end;
}

// ============================================
// GEMINI AI
// ============================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
// Force gemini-2.5-flash — 2.5-pro gives 503 overloaded, 2.0-flash gives 404
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

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
async function generateAIContent(prompt, { enableSearch = false } = {}) {
  const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
  console.log(`[GEMINI] Llamando a la API (search=${enableSearch}) con url: ${url}`);
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

  // BLINDAJE: Limitar largo de respuesta (máx 1200 chars — EXCEPTO si contiene tags especiales)
  // Los tags [GENERAR_COTIZACION_PDF:...] y [GUARDAR_APRENDIZAJE:...] NUNCA se cortan
  const tieneTagEspecial = typeof content === 'string' && (content.includes('[GENERAR_COTIZACION_PDF:') || content.includes('[GUARDAR_APRENDIZAJE:'));

  if (typeof content === 'string' && content.length > 1200 && !tieneTagEspecial) {
    let cutPoint = content.lastIndexOf('\n\n', 1200);
    if (cutPoint < 400) cutPoint = content.lastIndexOf('\n', 1200);
    if (cutPoint < 400) cutPoint = 1200;
    content = content.substring(0, cutPoint).trim();
    console.log(`[BLINDAJE] Respuesta recortada a ${content.length} chars para ${target}`);
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
      // Para self-chat, convertir JID a @lid (no @s.whatsapp.net)
      // Baileys recibe self-chat como {number}@lid, así que enviar igual
      const targetNumber = target.split('@')[0]?.split(':')[0];
      sendTarget = `${targetNumber}@lid`;
      console.log(`[SELF-CHAT] 🔧 Convertido JID: ${target} → ${sendTarget}`);
      // Nota: No usar quoted message por ahora, enviar solo a @lid
      // Baileys debería entregar en self-chat con el JID @lid correcto
    }

    console.log(`[SEND-DEBUG] Intentando enviar a: ${sendTarget}`);
    console.log(`[SEND-DEBUG] isSelfChat (CORRECTO): ${isSelfChat}`);
    console.log(`[SEND-DEBUG] sendOptions: ${JSON.stringify(Object.keys(sendOptions))}`);
    console.log(`[SEND-DEBUG] baileysContent: ${JSON.stringify(baileysContent).substring(0, 100)}`);

    const result = await ownerSock.sendMessage(sendTarget, baileysContent, sendOptions);

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
  console.log(`[MIIA-RESPONSE-DEBUG] phone=${phone}, basePhone=${basePhone}`);
  try {
    if (!conversations[phone]) conversations[phone] = [];
    const familyInfo = familyContacts[basePhone];
    const isFamilyContact = !!familyInfo;
    let isAdmin = ADMIN_PHONES.includes(basePhone);  // ← CAMBIO: const → let (para poder reasignar en self-chat)

    // GARANTÍA CRÍTICA: Si es self-chat, SIEMPRE es admin (sin verificar número)
    // Baileys usa Device ID en self-chat (ej: 136417472712832) que NO coincide con ADMIN_PHONES
    // DEBE estar ANTES de los comandos (dile a, STOP, etc.) para que isAdmin=true los active
    const isSelfChat = isAlreadySavedParam;
    if (isSelfChat && !isAdmin) {
      isAdmin = true;
      console.log(`[ADMIN-FIX] 🔧 Self-chat: isAdmin=true (LID=${basePhone} no matchea ADMIN_PHONES)`);
    }

    // Recuperar mensaje real del historial cuando fue llamado con userMessage=null
    const effectiveMsg = userMessage ||
      (conversations[phone] || []).slice().reverse().find(m => m.role === 'user')?.content || null;

    // ═══════════════════════════════════════════════════════════════════════════
    // MANEJO DE COMANDOS "DILE A" — HOLA MIIA / CHAU MIIA
    // Detecta cuando contactos de "dile a" activan/desactivan conversación
    // ═══════════════════════════════════════════════════════════════════════════
    if (conversationMetadata[phone]?.dileAMode && !isSelfChat) {
      const msgUpper = effectiveMsg ? effectiveMsg.toUpperCase().trim() : '';

      // Detectar "HOLA MIIA" para activar conversación
      if (msgUpper === 'HOLA MIIA') {
        conversationMetadata[phone].dileAHandshakePending = false;
        conversationMetadata[phone].dileAActive = true;
        console.log(`[DILE A] ✅ Handshake completado con ${conversationMetadata[phone].dileAContact}`);

        // Generar respuesta creativa a "HOLA MIIA"
        const contactName = conversationMetadata[phone].dileAContact;
        const contactInfo = familyContacts[phone.split('@')[0]] || {};
        const promptHolaMiia = `Sos MIIA, asistente de Mariano. ${contactName} acaba de escribir "HOLA MIIA" para activar nuestra conversación después del handshake.
Tu personalidad con ${contactName}: ${contactInfo.personality || 'Amistosa y natural'}.
Generá una respuesta breve (máx 2 renglones), cálida y natural, que muestre que estás lista para conversar.
NO repitas "Hola" ni "estoy lista", sé creativa y acorde a su personalidad. Usá el emoji: ${contactInfo.emoji || '💕'}`;

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

      // Detectar "CHAU MIIA" para desactivar conversación
      if (msgUpper === 'CHAU MIIA') {
        conversationMetadata[phone].dileAActive = false;
        conversationMetadata[phone].dileAMode = false;
        console.log(`[DILE A] 👋 Conversación terminada con ${conversationMetadata[phone].dileAContact}`);

        // Generar despedida creativa
        const contactName = conversationMetadata[phone].dileAContact;
        const contactInfo = familyContacts[phone.split('@')[0]] || {};
        const promptChauMiia = `Sos MIIA, asistente de Mariano. ${contactName} acaba de escribir "CHAU MIIA" para terminar nuestra conversación.
Tu personalidad con ${contactName}: ${contactInfo.personality || 'Amistosa y natural'}.
Generá una despedida breve (máx 2 renglones), cálida y natural. IMPORTANTE: recordale que si quiere volver a hablar conmigo, debe escribir "HOLA MIIA" (con dos ii) en el chat.
Sé creativa, acorde a su personalidad. Usá el emoji: ${contactInfo.emoji || '💕'}`;

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

      // Si handshake pendiente: no responder a otros mensajes
      if (conversationMetadata[phone].dileAHandshakePending) {
        console.log(`[DILE A] ⏸️ Esperando handshake de ${conversationMetadata[phone].dileAContact} (recibió: "${effectiveMsg}")`);
        return; // Ignorar mensajes hasta que diga "HOLA MIIA"
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
      const isYes = /^(sí|si|yes|ok|dale|claro|perfecto|gracias|acepto|listo)$/i.test(msgLower) ||
                    msgLower.includes('sí') || msgLower.includes('si');
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
            const targetSerialized = fPhone.includes('@') ? fPhone : `${fPhone}@s.whatsapp.net`;
            try {
              const promptFamilia = `Sos MIIA. Escribile a ${fInfo.name} (${fInfo.relation} de Mariano). Personalidad: ${fInfo.personality || 'Amistosa'}. Tema: "${familyMsg}". PROHIBIDO decir "soy asistente de Mariano" o "Mariano me pidió". Hablás como MIIA con tu propia voz. Máx 3 renglones, natural y cálido. Emoji: ${fInfo.emoji || ''}.`;
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
            const promptFamiliar = `Sos MIIA. Vas a escribirle a ${familyInfo.name} (${familyInfo.relation} de Mariano).
Personalidad de ${familyInfo.name}: ${familyInfo.personality || 'Amistosa y natural'}.
Tema a transmitir: "${realMessage || 'un saludo'}".

REGLAS ABSOLUTAS:
- PROHIBIDO decir "soy la asistente de Mariano", "Mariano me pidió", "de parte de Mariano" o similar
- Hablás como MIIA con tu propia personalidad, como si el mensaje naciera de vos
- Máximo 3 renglones, natural, cálido, humano
- NO repitas las palabras del tema literalmente, reinterpretalo con tu estilo
- Emoji: ${familyInfo.emoji || ''}
${!familyInfo.isHandshakeDone ? '- Es el PRIMER contacto: presentate brevemente como MIIA (sin decir "asistente de nadie")' : ''}`;
            const miiaMsg = await generateAIContent(promptFamiliar);
            if (miiaMsg) {
              const cleanMsg = miiaMsg.trim();
              const isFirstContact = !familyInfo.isHandshakeDone;

              // En primer contacto: generar handshake CREATIVO de autoría de MIIA
              // En contactos posteriores: ocasionalmente recordar de forma creativa
              let finalMsg = cleanMsg;
              if (isFirstContact) {
                // Primer mensaje: generar handshake creativo
                const promptHandshake = `Generá UNA sola línea corta y natural diciéndole a ${familyInfo.name} que si quiere seguir charlando, escriba HOLA MIIA.
Tono: ${familyInfo.personality || 'Amistosa'}. Máximo 1 renglón. No seas robótica ni formal. ${familyInfo.emoji || '💕'}`;

                try {
                  const handshakeMsg = await generateAIContent(promptHandshake);
                  if (handshakeMsg) {
                    finalMsg = `${cleanMsg}\n\n${handshakeMsg.trim()}`;
                  }
                } catch (e) {
                  console.error(`[DILE A] Error generando handshake creativo:`, e.message);
                  finalMsg = `${cleanMsg}\n\nResponde *HOLA MIIA* cuando quieras seguir hablando conmigo. 💕`;
                }
              } else {
                // Mensajes posteriores: recordar ocasionalmente de forma creativa (20%)
                if (Math.random() < 0.2) {
                  const promptRecordatorio = `Una línea corta y natural recordándole a ${familyInfo.name} que si quiere cortar la charla escriba CHAU MIIA. Tono: ${familyInfo.personality || 'Amistosa'}. ${familyInfo.emoji || ''}`;

                  try {
                    const recordatorioMsg = await generateAIContent(promptRecordatorio);
                    if (recordatorioMsg) {
                      finalMsg = cleanMsg + '\n\n' + recordatorioMsg.trim();
                    }
                  } catch (e) {
                    // Si falla generación, usar MIIA_CIERRE como fallback
                    finalMsg = cleanMsg + MIIA_CIERRE;
                  }
                }
              }

              await safeSendMessage(targetSerialized, finalMsg);
              familyInfo.isHandshakeDone = true;
              familyInfo.affinity = (familyInfo.affinity || 0) + 1;
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
              // No enviar confirmación al self-chat — el owner ya sabe que mandó el comando
              console.log(`[DILE A] ✅ Mensaje enviado a ${familyInfo.name} (sin confirmación al self-chat)`);
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
      // Reset followup counter cuando el lead responde
      if (OWNER_UID && !isOwnerNumber && !isFamilyContact) {
        const leadNum = phone.split('@')[0];
        admin.firestore().collection('users').doc(OWNER_UID).collection('followups').doc(leadNum)
          .set({ count: 0, silenced: false, lastResponse: new Date().toISOString() }, { merge: true })
          .catch(() => {});
      }
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

        conversations[phone].push({ role: 'user', content: effectiveMsg, timestamp: Date.now() });
        conversations[phone].push({ role: 'assistant', content: response, timestamp: Date.now() });
        if (conversations[phone].length > 40) conversations[phone] = conversations[phone].slice(-40);
        saveDB();

        await safeSendMessage(phone, response);

        // Alertar al dueño
        const contactName = leadNames[phone] || phone.split('@')[0];
        const alertType = isInsult ? '⚠️ INSULTO' : '🔔 QUEJA';
        safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
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

    if (isAdmin) {
      activeSystemPrompt = buildOwnerSelfChatPrompt();
    } else if (isFamilyContact) {
      activeSystemPrompt = buildOwnerFamilyPrompt(familyInfo.name, familyInfo);
    } else if (equipoMedilink[basePhone]) {
      const miembroData = equipoMedilink[basePhone];
      const nombreConocido = miembroData.name || leadNames[phone] || null;
      activeSystemPrompt = buildEquipoPrompt(nombreConocido);
    } else {
      activeSystemPrompt = buildOwnerLeadPrompt(leadNames[phone] || '', cerebroAbsoluto.getTrainingData(), countryContext);
    }

    // ═══ PROMPTS INLINE ELIMINADOS — ahora se generan desde prompt_builder.js ═══

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
    // Fecha y hora local del owner (según código de país de su teléfono)
    const ownerCountryCode = getCountryFromPhone(OWNER_PHONE);
    const ownerTimezone = getTimezoneForCountry(ownerCountryCode);
    const localNowStr = new Date().toLocaleString('es-ES', { timeZone: ownerTimezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const systemDateStr = `[FECHA Y HORA LOCAL DEL USUARIO: ${localNowStr} (${ownerTimezone})]`;

    const adnStr = cerebroAbsoluto.getTrainingData();
    const fullPrompt = `${activeSystemPrompt}

${helpCenterData}${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${adnStr ? '\n\n[ADN VENTAS — LO QUE HE APRENDIDO DE CONVERSACIONES REALES]:\n' + adnStr : ''}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

    // Google Search: siempre activo para owner y círculo cercano (familia, equipo)
    const isCirculoCercano = isSelfChat || isAdmin || isFamilyContact || contactTypes[phone] === 'equipo';
    const searchTriggered = isCirculoCercano;
    if (searchTriggered) console.log(`[GEMINI-SEARCH] 🔍 Search activo — ${isSelfChat ? 'self-chat' : isFamilyContact ? 'familia' : isAdmin ? 'admin' : 'equipo'}`);

    console.log(`[MIIA] Llamando a Gemini para ${basePhone} (isAdmin=${isAdmin}, isSelfChat=${isSelfChat}, search=${searchTriggered}, apiKey=${GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE' ? 'OK' : 'NO CONFIGURADA'})...`);
    let aiMessage = await generateAIContent(fullPrompt, { enableSearch: searchTriggered });
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
    const adminCtx = { uid: OWNER_UID || 'admin', ownerUid: OWNER_UID || 'admin', role: 'admin', isOwner: true };
    const adminCallbacks = {
      saveBusinessLearning: async (ownerUid, text, source) => {
        if (isAdmin) {
          // Admin: usar confidence engine para evaluar antes de guardar
          try {
            const importance = await confidenceEngine.evaluateImportance(text, callGemini);
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
      }
    };
    const adminPendingQuestions = [];

    const { cleanMessage: learnCleanMsg, pendingQuestions } = await messageLogic.processLearningTags(aiMessage, adminCtx, adminCallbacks);
    aiMessage = learnCleanMsg;

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
    aiMessage = aiMessage.replace(/\[ENVIAR_CORREO_A_MAESTRO:[^\]]*\]/g, '').trim();

    // Detectar tag [AGENDAR_EVENTO:contacto|fecha|razón|hint]
    const agendarMatch = aiMessage.match(/\[AGENDAR_EVENTO:([^\]]+)\]/g);
    if (agendarMatch) {
      for (const tag of agendarMatch) {
        const inner = tag.replace('[AGENDAR_EVENTO:', '').replace(']', '');
        const parts = inner.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          const [contacto, fecha, razon, hint] = parts;
          const contactName = leadNames[`${contacto}@s.whatsapp.net`] || contacto;
          let calendarOk = false;

          // 1. Intentar crear evento en Google Calendar
          try {
            const parsedDate = new Date(fecha);
            // Timezone del owner según su teléfono
            const ownerCountry = getCountryFromPhone(OWNER_PHONE);
            const ownerTz = getTimezoneForCountry(ownerCountry);
            if (!isNaN(parsedDate)) {
              // Extraer hora en timezone local (si viene en el string fecha)
              const hourMatch = fecha.match(/(\d{1,2}):(\d{2})/);
              const startH = hourMatch ? parseInt(hourMatch[1]) : 10;
              await createCalendarEvent({
                summary: razon || 'Evento MIIA',
                dateStr: fecha.split('T')[0],
                startHour: startH,
                endHour: startH + 1,
                description: `Agendado por MIIA para ${contactName}. ${hint || ''}`.trim(),
                uid: OWNER_UID,
                timezone: ownerTz
              });
              calendarOk = true;
              console.log(`[AGENDA] 📅 Google Calendar: "${razon}" el ${fecha} para ${contactName}`);
            }
          } catch (calErr) {
            console.warn(`[AGENDA] ⚠️ Google Calendar no disponible: ${calErr.message}. Guardando en Firestore.`);
          }

          // 2. Siempre guardar en Firestore (como respaldo y para recordatorios)
          try {
            const isFromCircle = isSelfChat || isFamilyContact || contactTypes[phone] === 'equipo';
            await admin.firestore().collection('users').doc(OWNER_UID).collection('miia_agenda').add({
              contactPhone: contacto,
              contactName,
              scheduledFor: fecha,
              reason: razon,
              promptHint: hint || '',
              status: 'pending',
              calendarSynced: calendarOk,
              remindContact: isFromCircle, // MIIA recuerda al contacto el día del evento
              requestedBy: phone, // quién pidió agendar
              searchBefore: (razon || '').toLowerCase().includes('deporte') || (razon || '').toLowerCase().includes('partido'),
              createdAt: new Date().toISOString(),
              source: isSelfChat ? 'owner_selfchat' : 'contact_request'
            });
          } catch (e) {
            console.error(`[AGENDA] ❌ Error guardando en Firestore:`, e.message);
          }

          // 3. Si Calendar no está conectado, avisar al owner
          if (!calendarOk && !isSelfChat) {
            safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
              `📅 *Evento agendado internamente* (Calendar no conectado)\n${contactName} pidió: "${razon}" para el ${fecha}\nMIIA lo recordará, pero no está en tu Google Calendar.\n\n💡 Conectá Calendar desde tu dashboard → Conexiones.`
            ).catch(() => {});
          }
        }
      }
      aiMessage = aiMessage.replace(/\[AGENDAR_EVENTO:[^\]]+\]/g, '').trim();
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
    await safeSendMessage(phone, aiMessage, { isSelfChat });

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

  // Eco de linked device: from === to y NO es fromMe → rebote del propio mensaje, ignorar
  // fromMe+from===to es el self-chat legítimo del owner → dejar pasar
  if (message.from && message.to && message.from === message.to && !message.fromMe) return;

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
      await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
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
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
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
    try {
      const contact = await message.getContact();
      if (contact && contact.id) phone = contact.id._serialized;
    } catch (e) {}

    // Fix @lid para mensajes ENTRANTES: el chat real tiene el número @s.whatsapp.net correcto
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
    if (!isSelfChatMIIA && !isFamily && !isEquipo && !isWithinSchedule()) {
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
      await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`,
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

    // Debounce real de 3s: acumula todos los mensajes seguidos y responde de una vez
    if (messageTimers[effectiveTarget]) clearTimeout(messageTimers[effectiveTarget]);
    if (isProcessing[effectiveTarget]) {
      // Ya está procesando una respuesta — marcar para re-procesar al terminar
      pendingResponses[effectiveTarget] = true;
      return;
    }
    messageTimers[effectiveTarget] = setTimeout(async () => {
      delete messageTimers[effectiveTarget];
      isProcessing[effectiveTarget] = true;
      try {
        await processAndSendAIResponse(effectiveTarget, null, true);
      } finally {
        delete isProcessing[effectiveTarget];
        if (pendingResponses[effectiveTarget]) {
          delete pendingResponses[effectiveTarget];
          setTimeout(async () => {
            isProcessing[effectiveTarget] = true;
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

  // Enviar mensaje manual desde frontend (Baileys API)
  socket.on('send_message', async (data) => {
    const { to, message } = data;
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
      // Adapter: convert Baileys message to whatsapp-web.js-like format for handleIncomingMessage
      const adapted = {
        from,
        to: baileysMsg.key.remoteJid,
        fromMe: !!baileysMsg.key.fromMe,
        body,
        id: baileysMsg.key.id ? { _serialized: baileysMsg.key.id } : {},
        hasMedia: !!(baileysMsg.message?.imageMessage || baileysMsg.message?.audioMessage || baileysMsg.message?.videoMessage || baileysMsg.message?.documentMessage || baileysMsg.message?.stickerMessage),
        type: baileysMsg.message?.imageMessage ? 'image' : baileysMsg.message?.audioMessage ? 'audio' : baileysMsg.message?.videoMessage ? 'video' : baileysMsg.message?.documentMessage ? 'document' : baileysMsg.message?.stickerMessage ? 'sticker' : 'chat',
        isStatus: from === 'status@broadcast',
        timestamp: baileysMsg.messageTimestamp || Math.floor(Date.now() / 1000),
        _baileysMsg: baileysMsg  // Para que processMediaMessage pueda descargar media
      };
      handleIncomingMessage(adapted);
    },
    onReady: (sock) => {
      console.log(`[WA] ✅ Owner connected via Baileys`);
      isReady = true;
      ownerConnectedAt = Math.floor(Date.now() / 1000);
      io.emit('whatsapp_ready', { status: 'connected' });

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
app.post('/api/tenant/:uid/logout', async (req, res) => {
  const result = await tenantManager.destroyTenant(req.params.uid);
  res.json(result);
});

// POST /api/tenant/:uid/clean-session — Clean corrupted Baileys session (MessageCounterError recovery)
app.post('/api/tenant/:uid/clean-session', express.json(), async (req, res) => {
  const uid = req.params.uid;
  try {
    console.log(`[CLEAN-SESSION] 🔧 Limpiando sesión corrupta para ${uid}...`);

    // Eliminar sesión de Firestore (fuerza reconexión)
    const { deleteFirestoreSession } = require('./baileys_session_store');
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
    if (!getOwnerSock() || !getOwnerStatus().isReady) return;
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

    await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, briefing);
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
    // Solo logear si estamos en la hora del cron (3AM) para no llenar logs
    const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).getHours();
    if (h === 3) console.log('[CRON ADN] Sin consentimiento registrado. Minado cancelado.');
  }

  webScraper.processScraperCron();
  processMorningWakeup();
  processMorningBriefing();

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
      safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, `✅ *Centro de Ayuda Medilink aprendido*\n${learned} artículos procesados y guardados en mi memoria.`).catch(() => {});
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
            console.log(`[AUTO-INIT] ✅ Admin auto-detectado: ${OWNER_UID}`);
          } else {
            console.log('[AUTO-INIT] ⚠️ No se encontró usuario con role=admin en Firestore.');
          }
        } else {
          console.log(`[AUTO-INIT] OWNER_UID desde env: ${OWNER_UID}`);
        }

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
              onMessage: (baileysMsg, from, body) => {
                const adapted = {
                  from,
                  to: baileysMsg.key.remoteJid,
                  fromMe: !!baileysMsg.key.fromMe,
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
    process.env.GOOGLE_REDIRECT_URI || 'https://miia-backend-production.up.railway.app/api/auth/google/callback'
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

async function createCalendarEvent({ summary, dateStr, startHour, endHour, attendeeEmail, description, uid, timezone }) {
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

  const event = {
    summary: summary || 'Reunión con MIIA',
    description: description || 'Agendado automáticamente por MIIA',
    start: { dateTime: `${year}-${month}-${day}T${sH}:00:00`, timeZone: tz },
    end: { dateTime: `${year}-${month}-${day}T${eH}:00:00`, timeZone: tz },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : []
  };

  const response = await cal.events.insert({ calendarId: calId, resource: event, sendUpdates: 'all' });
  console.log(`[GCAL] Evento creado: "${summary}" el ${start.toLocaleString('es-ES')} para uid=${uid}`);
  return { ok: true, eventId: response.data.id, htmlLink: response.data.htmlLink };
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