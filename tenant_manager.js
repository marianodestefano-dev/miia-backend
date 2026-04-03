/**
 * TENANT MANAGER — MIIA Multi-tenant WhatsApp Engine (Baileys)
 *
 * Manages one WhatsApp connection per SaaS client (uid).
 * Uses Baileys (direct WA protocol, NO Chrome/Puppeteer).
 * Each connection uses ~20-30MB RAM vs ~200-300MB with whatsapp-web.js.
 *
 * Each tenant gets:
 *   - Isolated Baileys session (stored in Firestore)
 *   - Isolated conversation history (./data/{uid}/db.json)
 *   - Their own Gemini API key (from Firestore, passed at init time)
 *   - Their own cerebro_absoluto training data
 *   - Their own Socket.IO room for QR and status events
 */

'use strict';

const admin = require('firebase-admin');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState, deleteFirestoreSession } = require('./baileys_session_store');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { callAI } = require('./ai_client');
const { buildTenantPrompt, buildOwnerLeadPrompt } = require('./prompt_builder');
const { sendSessionRecoveryEmail } = require('./mail_service');
const { handleTenantMessage } = require('./tenant_message_handler');

// ─── Tenant state ─────────────────────────────────────────────────────────────
const tenants = new Map();
const tenantErrors = new Map(); // Rastrear errores: { uid: { count, windowStart } }

const DATA_ROOT = path.join(__dirname, 'data', 'tenants');
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

// Silent logger for Baileys (avoid noisy output)
const baileysLogger = pino({ level: 'silent' });

// ─── Global error monitor for libsignal MessageCounterError ───
const SERVER_START_TIME = Date.now();
const STARTUP_GRACE_PERIOD = 90000; // 90s — ignorar errores de mensajes encolados al inicio

const originalConsoleError = console.error;
console.error = function(...args) {
  const errorStr = args.map(a => String(a)).join(' ');
  if (errorStr.includes('MessageCounterError') || errorStr.includes('Key used already')) {
    // CRÍTICO: los primeros 90s después del startup son errores de mensajes viejos encolados
    // — NO contar hacia el cleanup o se borra la sesión en cada redeploy
    const uptime = Date.now() - SERVER_START_TIME;
    if (uptime < STARTUP_GRACE_PERIOD) {
      console.log(`[TM] 🔐 libsignal error ignorado (startup grace period, uptime=${Math.round(uptime/1000)}s)`);
      return originalConsoleError.apply(console, args);
    }

    for (const [uid, tenant] of tenants) {
      if (!tenantErrors.has(uid)) {
        tenantErrors.set(uid, { count: 0, windowStart: Date.now() });
      }
      const errTracker = tenantErrors.get(uid);
      const now = Date.now();
      if (now - errTracker.windowStart > 30000) {
        errTracker.count = 0;
        errTracker.windowStart = now;
      }
      errTracker.count++;
      if (errTracker.count <= 5) {
        console.log(`[TM:${uid}] 🔐 libsignal error detected ${errTracker.count}/5 - will cleanup if reaches 5`);
      }
      if (errTracker.count === 5) {
        console.log(`[TM:${uid}] 💥 5 errors detected - triggering cleanup...`);
        cleanupCorruptedSession(uid, tenant.io).catch(e => console.log(`[TM:${uid}] cleanup error:`, e.message));
        tenantErrors.delete(uid);
      }
    }
  }
  return originalConsoleError.apply(console, args);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function cleanupCorruptedSession(uid, ioInstance) {
  try {
    console.log(`[TM:${uid}] 🧹 Iniciando cleanup de sesión corrupta...`);

    // Obtener datos del usuario para notificaciones
    let userEmail = '';
    let userName = 'Usuario MIIA';
    try {
      const userDoc = await admin.firestore().collection('users').doc(uid).get();
      if (userDoc.exists) {
        userEmail = userDoc.data()?.email || '';
        userName = userDoc.data()?.name || 'Usuario MIIA';
      }
    } catch (e) {
      console.warn(`[TM:${uid}] ⚠️ No se pudo obtener datos del usuario:`, e.message);
    }

    // Eliminar sesión de Firestore
    await deleteFirestoreSession(`tenant-${uid}`);

    // Marcar en Firestore que necesita reconectar
    const recoveryTimestamp = new Date();
    await admin.firestore().collection('users').doc(uid).update({
      whatsapp_needs_reconnect: true,
      whatsapp_recovery_at: recoveryTimestamp,
      whatsapp_recovery_reason: 'Sesión corrupta detectada por MessageCounterError (auto-cleanup)'
    }).catch(() => {});

    // 1️⃣ Notificar vía Socket.IO (en tiempo real)
    if (ioInstance) {
      ioInstance.emit(`tenant_recovery_needed_${uid}`, {
        message: '⚠️ Tu sesión de WhatsApp fue reiniciada por desincronización. Por favor, escanea el QR nuevamente.',
        needsQr: true,
        recoveredAt: recoveryTimestamp.toISOString(),
        severity: 'warning'
      });
      console.log(`[TM:${uid}] ✅ Notificación Socket.IO enviada`);
    }

    // 2️⃣ Notificar por EMAIL (si está configurado SMTP)
    if (userEmail) {
      try {
        const emailSent = await sendSessionRecoveryEmail(uid, userEmail, {
          reason: 'Sesión desincronizada (error criptográfico de Baileys)',
          recoveredAt: recoveryTimestamp.toISOString(),
          userName: userName
        });
        if (emailSent) {
          console.log(`[TM:${uid}] ✅ Email de recuperación enviado a ${userEmail}`);
        } else {
          console.warn(`[TM:${uid}] ⚠️ SMTP no configurado. Email NO enviado (pero Socket.IO sí)`);
        }
      } catch (emailError) {
        console.error(`[TM:${uid}] ❌ Error enviando email:`, emailError.message);
      }
    }

    // Destruir tenant en memoria
    if (tenants.has(uid)) {
      const t = tenants.get(uid);
      if (t.sock) {
        try { await t.sock.logout().catch(() => {}); } catch (e) {}
      }
      tenants.delete(uid);
    }

    console.log(`[TM:${uid}] ✅ Sesión limpiada. Notificaciones enviadas (Socket.IO + Email).`);
  } catch (e) {
    console.error(`[TM:${uid}] ❌ Error en cleanup:`, e.message);
  }
}

function getTenantDataDir(uid) {
  const dir = path.join(DATA_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadTenantDB(uid) {
  const dbPath = path.join(getTenantDataDir(uid), 'db.json');
  try {
    if (!fs.existsSync(dbPath)) return {};
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    console.error(`[TM:${uid}] Error loading DB:`, e.message);
    return {};
  }
}

function saveTenantDB(uid, data) {
  const dbPath = path.join(getTenantDataDir(uid), 'db.json');
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[TM:${uid}] Error saving DB:`, e.message);
  }
}

async function callAIForTenant(uid, prompt) {
  const t = tenants.get(uid);
  if (!t) throw new Error(`Tenant ${uid} not found`);
  const provider = t.aiProvider || 'gemini';
  const apiKey = t.aiApiKey || t.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error(`No API key configured for tenant ${uid}`);
  return callAI(provider, apiKey, prompt);
}

// Backward-compatible alias
const callGeminiForTenant = callAIForTenant;

// ─── Build a response prompt for a tenant ──
function buildSystemPrompt(tenant, contactName) {
  if (tenant.isOwnerMember) {
    return buildOwnerLeadPrompt(contactName, tenant.trainingData || '');
  }
  return buildTenantPrompt(
    contactName,
    tenant.trainingData || '',
    tenant.conversations[contactName] || []
  );
}

// ─── Procesar buffer de mensajes offline (post-reconnect) ────────────────────
// Toma todos los mensajes acumulados de un contacto, selecciona solo el último,
// y genera una respuesta contextual que reconoce el delay naturalmente.
async function processOfflineBuffer(uid, jid, bufferedMsgs, tenant, isOwner) {
  if (!bufferedMsgs || bufferedMsgs.length === 0) return;

  const last = bufferedMsgs[bufferedMsgs.length - 1];
  const totalMsgs = bufferedMsgs.length;
  const oldestAge = bufferedMsgs[0].ageSec;

  // Formatear tiempo legible
  const ageMin = Math.round(oldestAge / 60);
  const ageLabel = ageMin < 60 ? `${ageMin} min` : `${Math.round(ageMin / 60)}h`;

  console.log(`[TM:${uid}] 🔄 Procesando ${totalMsgs} msg(s) offline de ${jid} (último hace ${ageLabel}): "${last.body.substring(0, 50)}"`);

  // Si es owner con onMessage (admin/Mariano) → delegar al handler con flag offline
  if (isOwner && tenant.onMessage) {
    // Solo enviar el último mensaje, con metadata de offline
    last.msg._offlineContext = {
      totalMessages: totalMsgs,
      oldestAgeSec: oldestAge,
      ageLabel,
      allBodies: bufferedMsgs.map(m => m.body).filter(b => b.trim())
    };
    try { tenant.onMessage(last.msg, last.from, last.body); } catch (e) {
      console.error(`[TM:${uid}] onMessage offline error:`, e.message);
    }
    return;
  }

  // Para tenants: procesar solo el último mensaje con contexto de delay
  const ownerUid = tenant.ownerUid || uid;
  const role = tenant.role || 'owner';
  const realSelfChat = false; // offline de lead, no self-chat

  // Inyectar contexto offline en el body para que el prompt lo considere
  const contextPrefix = totalMsgs > 1
    ? `[CONTEXTO INTERNO - NO MENCIONAR TEXTUALMENTE: El contacto envió ${totalMsgs} mensajes mientras estabas offline (hace ${ageLabel}). Mensajes anteriores: ${bufferedMsgs.slice(0, -1).map(m => `"${m.body.substring(0, 60)}"`).join(', ')}. Responde SOLO al último mensaje pero teniendo en cuenta TODO el contexto. Sé conciso, natural, y termina con una pregunta relevante al tema.]\n`
    : `[CONTEXTO INTERNO - NO MENCIONAR TEXTUALMENTE: Este mensaje llegó hace ${ageLabel} mientras estabas offline. Responde naturalmente sin disculparte excesivamente. Sé conciso y termina con una pregunta relevante.]\n`;

  handleTenantMessage(uid, ownerUid, role, jid, contextPrefix + last.body, realSelfChat, false, tenant)
    .catch(e => console.error(`[TM:${uid}] handleTenantMessage offline error:`, e.message));
}

// ─── Core: process incoming message for a tenant ──────────────────────────────
async function processTenantMessage(uid, phone, messageBody) {
  const t = tenants.get(uid);
  if (!t) return;

  // Normalize phone to JID format if needed
  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

  // Save incoming message
  if (!t.conversations[jid]) t.conversations[jid] = [];
  t.conversations[jid].push({
    role: 'user',
    content: messageBody,
    timestamp: Date.now()
  });

  // Trim history to last 40
  if (t.conversations[jid].length > 40) {
    t.conversations[jid] = t.conversations[jid].slice(-40);
  }

  try {
    const prompt = buildSystemPrompt(t, jid);
    const aiReply = await callAIForTenant(uid, prompt + `\nCliente: ${messageBody}\nMIIA:`);

    if (!aiReply || !aiReply.trim()) return;

    // Save AI reply
    t.conversations[jid].push({
      role: 'assistant',
      content: aiReply,
      timestamp: Date.now()
    });

    // Persist
    saveTenantDB(uid, {
      conversations: t.conversations,
      leadNames: t.leadNames,
      trainingData: t.trainingData
    });

    // Send via WhatsApp (Baileys)
    if (t.sock && t.isReady) {
      await t.sock.sendMessage(jid, { text: aiReply });
    }

    // Emit to frontend via Socket.IO room
    if (t.io) {
      t.io.to(`tenant:${uid}`).emit('ai_response', {
        phone: jid,
        message: aiReply,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error(`[TM:${uid}] Error processing message from ${jid}:`, error.message);
    // Notificar al usuario si es un error de créditos/billing
    const em = error.message.toLowerCase();
    if (em.includes('credit') || em.includes('balance') || em.includes('billing') || em.includes('quota')) {
      const provider = t.aiProvider || 'gemini';
      const alertMsg = `⚠️ *MIIA - Error de IA*\n\nTu proveedor de IA (${provider}) no tiene créditos o saldo disponible.\n\nCargá saldo en la cuenta del proveedor o cambiá a otra IA desde tu dashboard → Conexiones → Inteligencia Artificial.`;
      try {
        const selfJid = t.sock?.user?.id?.replace(/:.*@/, '@');
        if (t.sock && selfJid) await t.sock.sendMessage(selfJid, { text: alertMsg });
      } catch (_) {}
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize a WhatsApp connection for a tenant using Baileys.
 * @param {string} uid - Firebase user UID
 * @param {string} geminiApiKey - Tenant's Gemini API key
 * @param {object} ioInstance - Socket.IO server instance
 * @returns {object} tenant state
 */
function initTenant(uid, geminiApiKey, ioInstance, aiConfig = {}, options = {}) {
  if (tenants.has(uid)) {
    const existing = tenants.get(uid);
    if (existing.isReady) {
      console.log(`[TM:${uid}] ✅ Already connected`);
      return existing;
    }
    // Already initializing
    if (existing._initializing) {
      console.log(`[TM:${uid}] ⏳ Already initializing...`);
      return existing;
    }
    return existing;
  }

  console.log(`[TM:${uid}] 🚀 Initializing WhatsApp (Baileys)...`);

  const dataDir = getTenantDataDir(uid);
  const savedDB = loadTenantDB(uid);

  const tenant = {
    uid,
    geminiApiKey,
    aiProvider: aiConfig.provider || 'gemini',
    aiApiKey: aiConfig.apiKey || geminiApiKey,
    sock: null,
    isReady: false,
    isAuthenticated: false,
    qrCode: null,
    conversations: savedDB.conversations || {},
    leadNames: savedDB.leadNames || {},
    contactTypes: {},
    trainingData: savedDB.trainingData || '',
    dataDir,
    io: ioInstance,
    _initializing: true,
    onMessage: options.onMessage || null,  // Custom message handler (used by admin/Mariano)
    onReady: options.onReady || null,      // Callback when connection is ready
    ownerUid: options.ownerUid || uid,     // UID del owner (agents apuntan al owner)
    role: options.role || 'owner'          // 'owner' | 'agent'
  };

  tenants.set(uid, tenant);

  // Start Baileys connection asynchronously
  startBaileysConnection(uid, tenant, ioInstance);

  return tenant;
}

/**
 * Start Baileys WebSocket connection for a tenant.
 */
async function startBaileysConnection(uid, tenant, ioInstance) {
  try {
    const clientId = `tenant-${uid}`;
    const { state, saveCreds } = await useFirestoreAuthState(clientId);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[TM:${uid}] 📡 Connecting with Baileys v${version.join('.')}...`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
      },
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ['MIIA', 'Chrome', '120.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: true,   // Descargar historial completo para ADN Mining
      markOnlineOnConnect: false
    });

    tenant.sock = sock;

    // ─── Connection updates (QR, auth, ready) ───
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code received
      if (qr) {
        try {
          console.log(`[TM:${uid}] 📱 QR received`);
          const qrDataUrl = await qrcode.toDataURL(qr);
          tenant.qrCode = qrDataUrl;
          if (ioInstance) {
            ioInstance.to(`tenant:${uid}`).emit('qr', tenant.qrCode);
            ioInstance.emit(`tenant_qr_${uid}`, tenant.qrCode);
          }
        } catch (err) {
          console.error(`[TM:${uid}] ❌ Error generating QR:`, err.message);
        }
      }

      // Connection opened
      if (connection === 'open') {
        console.log(`[TM:${uid}] ✅ WhatsApp CONNECTED (Baileys) — ready for messages`);
        tenant.isReady = true;
        tenant.isAuthenticated = true;
        tenant.qrCode = null;
        tenant._initializing = false;
        tenant.connectedAt = Math.floor(Date.now() / 1000); // Unix timestamp en segundos

        // 🔑 Extraer y guardar número real del usuario en Firestore
        try {
          const ownerPhone = sock.user?.id?.split('@')[0]?.split(':')[0];
          if (ownerPhone) {
            tenant.ownerPhone = ownerPhone;
            console.log(`[TM:${uid}] 📱 Número extraído de sock.user.id: ${ownerPhone}`);
            // Guardar en Firestore para uso posterior en server.js
            admin.firestore().collection('users').doc(uid).update({
              whatsapp_owner_number: ownerPhone,
              whatsapp_owner_jid: `${ownerPhone}@s.whatsapp.net`,
              owner_phone_updated_at: new Date()
            }).then(() => {
              console.log(`[TM:${uid}] ✅ Número guardado en Firestore: ${ownerPhone}`);
            }).catch(err => {
              console.error(`[TM:${uid}] ❌ Error guardando número en Firestore:`, err.message);
            });
          } else {
            console.warn(`[TM:${uid}] ⚠️ No se pudo extraer número de sock.user.id:`, sock.user?.id);
          }
        } catch (e) {
          console.error(`[TM:${uid}] ❌ Error extrayendo número:`, e.message);
        }

        if (ioInstance) {
          ioInstance.to(`tenant:${uid}`).emit('whatsapp_ready', { uid, status: 'connected' });
          ioInstance.emit(`tenant_ready_${uid}`, { status: 'connected' });
        }
        // Custom onReady callback (e.g. owner init cerebro_absoluto)
        if (tenant.onReady) {
          try { tenant.onReady(sock); } catch (e) { console.error(`[TM:${uid}] onReady error:`, e.message); }
        }
      }

      // Connection closed
      if (connection === 'close') {
        tenant.isReady = false;
        tenant._initializing = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[TM:${uid}] ❌ Disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          // Auto-reconnect after brief delay
          setTimeout(() => {
            console.log(`[TM:${uid}] 🔄 Reconnecting...`);
            if (tenants.has(uid)) {
              tenant._initializing = true;
              startBaileysConnection(uid, tenant, ioInstance);
            }
          }, 3000);
        } else {
          // Logged out desde el teléfono — sock muerto, solo notificar
          console.log(`[TM:${uid}] 🔌 Logged out desde teléfono — cleaning session`);
          tenant.isAuthenticated = false;
          tenant.sock = null;
          tenants.delete(uid);
          await deleteFirestoreSession(`tenant-${uid}`);

          // Obtener datos del usuario para notificaciones
          let userEmail = '';
          let userName = 'Usuario MIIA';
          try {
            const userDoc = await admin.firestore().collection('users').doc(uid).get();
            if (userDoc.exists) {
              userEmail = userDoc.data()?.email || '';
              userName = userDoc.data()?.name || 'Usuario MIIA';
            }
          } catch (e) {}

          // Marcar en Firestore
          await admin.firestore().collection('users').doc(uid).update({
            whatsapp_needs_reconnect: true,
            whatsapp_recovery_at: new Date(),
            whatsapp_recovery_reason: 'Desvinculado desde el teléfono'
          }).catch(() => {});

          // Email de aviso
          if (userEmail) {
            sendSessionRecoveryEmail(uid, userEmail, {
              reason: 'Tu WhatsApp fue desvinculado desde el teléfono',
              recoveredAt: new Date().toISOString(),
              userName
            }).catch(e => console.warn(`[TM:${uid}] ⚠️ Email no enviado:`, e.message));
          }

          // Notificar dashboard
          if (ioInstance) {
            ioInstance.emit(`tenant_disconnected_${uid}`, {
              reason: 'logged_out_from_phone',
              message: `${userName} desvinculó WhatsApp desde su teléfono`,
              needsQr: true
            });
          }

          console.log(`[TM:${uid}] ✅ Cleanup + notificaciones enviadas (logged out from phone)`);
        }
      }

      // ⚠️ DETECTAR ERRORES CRIPTOGRÁFICOS (MessageCounterError)
      // GRACE PERIOD 60s: Después de cada deploy/restart, Baileys recibe mensajes pendientes
      // que generan ráfagas de MessageCounterError normales — NO son sesión corrupta.
      if (update.error) {
        const errorMsg = update.error?.message || String(update.error);
        if (errorMsg.includes('MessageCounterError') || errorMsg.includes('Key used already')) {
          const uptimeSec = process.uptime();
          if (uptimeSec < 60) {
            // Ignorar durante grace period post-startup
            return;
          }
          if (!tenantErrors.has(uid)) {
            tenantErrors.set(uid, { count: 0, windowStart: Date.now() });
          }
          const errTracker = tenantErrors.get(uid);
          const now = Date.now();
          if (now - errTracker.windowStart > 30000) {
            errTracker.count = 0;
            errTracker.windowStart = now;
          }
          errTracker.count++;
          console.warn(`[TM:${uid}] 🔐 MessageCounterError ${errTracker.count}/10 (uptime=${Math.round(uptimeSec)}s): ${errorMsg.substring(0,60)}...`);
          if (errTracker.count >= 10) {
            console.error(`[TM:${uid}] 💥 SESIÓN CORRUPTA DETECTADA (post-grace). Limpiando...`);
            tenantErrors.delete(uid);
            await cleanupCorruptedSession(uid, ioInstance);
          }
        }
      }
    });

    // ─── Save credentials on update ───
    sock.ev.on('creds.update', async (creds) => {
      console.log(`[TM:${uid}] 💾 creds.update fired, saving to Firestore...`);
      try {
        await saveCreds(creds);
        console.log(`[TM:${uid}] ✅ Creds saved successfully`);
      } catch (e) {
        console.error(`[TM:${uid}] ❌ Error saving creds:`, e.message);
      }
    });

    // ─── Incoming messages ───
    // Buffer para mensajes offline: acumula por contacto, debounce 5s, procesa solo el último
    const offlineBuffer = {}; // { [jid]: { msgs: [], timer: null } }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        const b = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const f = msg.key.remoteJid;
        const fm = msg.key.fromMe;
        const msgTs = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp
          : (msg.messageTimestamp?.low || parseInt(msg.messageTimestamp) || 0);
        console.log(`[TM:${uid}] 📥 messages.upsert type=${type} fromMe=${fm} from=${f} body="${b.substring(0,50)}" msgId=${msg.key.id} ts=${msgTs}`);
      }
      // type=notify son mensajes nuevos en tiempo real
      // type=append puede incluir self-chat reciente que Baileys clasifica mal
      // Permitir append SOLO si hay al menos 1 mensaje reciente (< 90s)
      if (type !== 'notify') {
        if (type === 'append') {
          const now = Math.floor(Date.now() / 1000);
          const hasRecentMsg = messages.some(msg => {
            const ts = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp
              : (msg.messageTimestamp?.low || parseInt(msg.messageTimestamp) || 0);
            return (now - ts) < 90;
          });
          if (hasRecentMsg) {
            console.log(`[TM:${uid}] ⚡ type=append con ${messages.length} msg(s) reciente(s) — procesando como notify`);
          } else {
            return;
          }
        } else {
          return;
        }
      }

      for (const msg of messages) {
        const from = msg.key.remoteJid;
        if (from?.endsWith('@g.us') || from === 'status@broadcast') continue;

        const isFromMe = msg.key.fromMe;
        const isOwner = !!tenant.onMessage;
        if (!isOwner && isFromMe) continue;

        const body = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || '';
        const hasMedia = !!(msg.message?.audioMessage || msg.message?.imageMessage
          || msg.message?.videoMessage || msg.message?.documentMessage
          || msg.message?.stickerMessage);
        if (!body.trim() && !hasMedia) continue;

        // Detectar si es mensaje offline (anterior a la conexión)
        const msgTs = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp
          : (msg.messageTimestamp?.low || parseInt(msg.messageTimestamp) || 0);
        const isOffline = tenant.connectedAt && msgTs > 0 && msgTs < tenant.connectedAt - 5;

        const myNumber = tenant.sock?.user?.id?.split(':')[0];
        const fromNumber = from?.split('@')[0]?.split(':')[0];
        const isSelfChat = isFromMe && myNumber && fromNumber && myNumber === fromNumber;

        // Mensaje offline → acumular en buffer (self-chat, leads, todos)
        // Solo ignorar si es MUY viejo (>10 min) y es self-chat
        if (isOffline) {
          const ageSec = tenant.connectedAt - msgTs;
          if (isSelfChat && ageSec > 600) {
            console.log(`[TM:${uid}] ⏭️ Self-chat offline MUY viejo ignorado (${Math.round(ageSec/60)}min) body="${body.substring(0,30)}"`);
            continue;
          }
        }

        if (isOffline) {
          const ageSec = tenant.connectedAt - msgTs;
          console.log(`[TM:${uid}] 📦 Mensaje offline de ${from} (hace ${ageSec}s): "${body.substring(0,40)}" → buffer`);
          if (!offlineBuffer[from]) offlineBuffer[from] = { msgs: [], timer: null };
          offlineBuffer[from].msgs.push({ msg, from, body, hasMedia, ageSec });
          // Debounce: esperar 5s sin nuevos mensajes del mismo contacto
          if (offlineBuffer[from].timer) clearTimeout(offlineBuffer[from].timer);
          offlineBuffer[from].timer = setTimeout(() => {
            processOfflineBuffer(uid, from, offlineBuffer[from].msgs, tenant, isOwner);
            delete offlineBuffer[from];
          }, 5000);
          continue;
        }

        // Mensaje en tiempo real → procesar normalmente
        console.log(`[TM:${uid}] 📨 Message from ${from}${isFromMe ? ' (self-chat)' : ''}: "${body.substring(0, 40)}"`);
        if (tenant.onMessage) {
          try { tenant.onMessage(msg, from, body); } catch (e) { console.error(`[TM:${uid}] onMessage error:`, e.message); }
        } else {
          const realSelfChat = isFromMe && (from === `${myNumber}@s.whatsapp.net` || from === tenant.sock?.user?.id);
          const ownerUid = tenant.ownerUid || uid;
          const role = tenant.role || 'owner';
          handleTenantMessage(uid, ownerUid, role, from, body, realSelfChat, isFromMe, tenant)
            .catch(e => console.error(`[TM:${uid}] handleTenantMessage error:`, e.message));
        }
      }
    });

    // ─── ADN Mining: historial completo al conectar por primera vez ───
    // Baileys envía el historial en chunks via messaging-history.set
    // Clasificación inteligente: lee 7 mensajes para clasificar, luego lee TODO si es lead/cliente
    // Si conecta número nuevo → REEMPLAZA el ADN anterior (nuevo negocio = cerebro limpio)
    let historyStats = { leads: 0, clients: 0, skipped: 0, total: 0 };
    let adnAccumulatorLeads = '';
    let adnAccumulatorClients = '';

    // Keywords para clasificación rápida (primeros 7 mensajes del contacto)
    const LEAD_SIGNALS = ['precio', 'costo', 'cotización', 'cotizacion', 'información', 'informacion',
      'info', 'interesado', 'interesada', 'necesito', 'quiero', 'disponible', 'presupuesto',
      'cuánto', 'cuanto', 'plan', 'servicio', 'demo', 'agendar', 'cita', 'reunión', 'reunion',
      'propuesta', 'oferta', 'descuento', 'promoción', 'promocion', 'consulta', 'catálogo',
      'catalogo', 'comprar', 'adquirir', 'contratar', 'probar', 'prueba', 'muestra'];
    const CLIENT_SIGNALS = ['factura', 'pago', 'transferencia', 'soporte', 'problema', 'no funciona',
      'error', 'reclamo', 'garantía', 'garantia', 'pedido', 'entrega', 'envío', 'envio',
      'contrato', 'renovar', 'renovación', 'renovacion', 'suscripción', 'suscripcion',
      'mi cuenta', 'usuario', 'contraseña', 'acceso', 'instalación', 'instalacion',
      'actualización', 'actualizacion', 'licencia', 'activar', 'configurar'];

    function classifyFromPreview(messages) {
      // Leer primeros 7 mensajes del contacto (no fromMe) para clasificar
      const contactMsgs = messages
        .filter(m => !m.key?.fromMe)
        .slice(0, 7)
        .map(m => (m.message?.conversation || m.message?.extendedTextMessage?.text || '').toLowerCase())
        .join(' ');

      if (!contactMsgs.trim()) return 'skip';

      const isClient = CLIENT_SIGNALS.some(kw => contactMsgs.includes(kw));
      const isLead = LEAD_SIGNALS.some(kw => contactMsgs.includes(kw));

      if (isClient) return 'cliente';
      if (isLead) return 'lead';

      // Si el vendedor respondió 3+ veces, probablemente es relevante
      const ownerReplies = messages.filter(m => m.key?.fromMe).length;
      if (ownerReplies >= 3) return 'lead';

      return 'otro';
    }

    // Detectar si es número nuevo comparando con el número guardado anteriormente
    let _connectedNumber = null;
    const _origOnReady = tenant.onReady;
    tenant.onReady = (sock) => {
      // Detectar número nuevo → limpiar ADN anterior
      const newNumber = sock.user?.id?.split('@')[0]?.split(':')[0];
      if (newNumber) {
        _connectedNumber = newNumber;
        // Verificar si cambió de número
        const savedDB = loadTenantDB(uid);
        if (savedDB._lastConnectedNumber && savedDB._lastConnectedNumber !== newNumber) {
          console.log(`[TM:${uid}] 🔄 NÚMERO NUEVO detectado: ${savedDB._lastConnectedNumber} → ${newNumber}. ADN será REEMPLAZADO.`);
          tenant.trainingData = ''; // Limpiar ADN anterior — cerebro fresco
          tenant._historyMined = false; // Forzar re-minado
        }
        // Guardar número actual
        saveTenantDB(uid, {
          conversations: tenant.conversations,
          leadNames: tenant.leadNames,
          trainingData: tenant.trainingData,
          _lastConnectedNumber: newNumber
        });
      }
      // Llamar al onReady original (si existe, ej: owner)
      if (_origOnReady) _origOnReady(sock);
    };

    sock.ev.on('messaging-history.set', async ({ chats, messages: histMsgs, isLatest }) => {
      if (tenant._historyMined) return;

      console.log(`[TM:${uid}] 📚 History sync: ${chats?.length || 0} chats, ${histMsgs?.length || 0} messages, isLatest: ${isLatest}`);

      if (histMsgs && histMsgs.length > 0) {
        // Agrupar mensajes por chat
        const chatMessages = {};
        for (const msg of histMsgs) {
          const jid = msg.key?.remoteJid;
          if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
          if (!chatMessages[jid]) chatMessages[jid] = [];
          chatMessages[jid].push(msg);
        }

        for (const jid of Object.keys(chatMessages)) {
          const allMsgs = chatMessages[jid];
          if (allMsgs.length < 3) { historyStats.skipped++; continue; }

          const hasOwnerMsgs = allMsgs.some(m => m.key?.fromMe);
          if (!hasOwnerMsgs) { historyStats.skipped++; continue; }

          // PASO 1: Clasificar con los primeros 7 mensajes del contacto
          const classification = classifyFromPreview(allMsgs);

          if (classification === 'otro' || classification === 'skip') {
            historyStats.skipped++;
            continue;
          }

          // PASO 2: Es lead o cliente → leer TODOS los mensajes, sin límite
          const chatLog = allMsgs.map(m => {
            const body = m.message?.conversation
              || m.message?.extendedTextMessage?.text
              || m.message?.imageMessage?.caption
              || '';
            if (!body.trim()) return null;
            return `${m.key?.fromMe ? 'VENDEDOR' : 'CONTACTO'}: ${body.replace(/\n/g, ' ')}`;
          }).filter(Boolean).join('\n');

          if (chatLog.length < 50) continue;

          const phone = jid.split('@')[0];
          if (classification === 'lead') {
            adnAccumulatorLeads += `\n[LEAD ${phone}]\n${chatLog}\n`;
            historyStats.leads++;
          } else {
            adnAccumulatorClients += `\n[CLIENTE ${phone}]\n${chatLog}\n`;
            historyStats.clients++;
          }
          historyStats.total++;
        }

        // Guardar progreso parcial cada chunk (el historial llega en múltiples eventos)
        const adnBatch = adnAccumulatorLeads + adnAccumulatorClients;
        if (adnBatch.length > 100) {
          const adnHeader = `[ADN HISTÓRICO — ${historyStats.leads} leads, ${historyStats.clients} clientes, ${historyStats.skipped} omitidos — ${new Date().toISOString()}]`;
          // REEMPLAZAR (no acumular) — cada sync es el ADN completo actual
          tenant.trainingData = adnHeader + '\n' + adnBatch;
          saveTenantDB(uid, {
            conversations: tenant.conversations,
            leadNames: tenant.leadNames,
            trainingData: tenant.trainingData,
            _lastConnectedNumber: _connectedNumber
          });
          console.log(`[TM:${uid}] 🧬 ADN Mining progreso: ${historyStats.leads} leads + ${historyStats.clients} clientes (${historyStats.skipped} omitidos). ${adnBatch.length} chars`);

          if (ioInstance) {
            ioInstance.to(`tenant:${uid}`).emit('adn_mining_progress', {
              leads: historyStats.leads,
              clients: historyStats.clients,
              skipped: historyStats.skipped,
              totalChars: adnBatch.length
            });
          }
        }

        // Liberar memoria
        Object.keys(chatMessages).forEach(k => delete chatMessages[k]);
      }

      // Cuando isLatest = true, ya se sincronizó todo el historial
      if (isLatest) {
        tenant._historyMined = true;
        console.log(`[TM:${uid}] 🧬 ADN Mining COMPLETO: ${historyStats.leads} leads, ${historyStats.clients} clientes, ${historyStats.skipped} omitidos`);
        if (ioInstance) {
          ioInstance.to(`tenant:${uid}`).emit('adn_mining_complete', historyStats);
        }
        // Liberar acumuladores
        adnAccumulatorLeads = '';
        adnAccumulatorClients = '';
      }
    });

  } catch (err) {
    console.error(`[TM:${uid}] ❌ Error starting Baileys:`, err.message);
    tenant._initializing = false;
  }
}

// ─── Destroy ────────────────────────────────────────────────────────────────

async function destroyTenant(uid) {
  const t = tenants.get(uid);
  if (!t) return { success: true, message: 'Tenant not found (already destroyed)' };

  try {
    // 1️⃣ Obtener nombre del usuario
    let userName = 'Usuario';
    let userEmail = '';
    try {
      const userDoc = await admin.firestore().collection('users').doc(uid).get();
      if (userDoc.exists) {
        userName = userDoc.data()?.name || 'Usuario';
        userEmail = userDoc.data()?.email || '';
      }
    } catch (e) {
      console.warn(`[TM:${uid}] ⚠️ No se pudo obtener datos del usuario:`, e.message);
    }

    // 2️⃣ Enviar mensaje de despedida en self-chat antes de desconectar
    if (t.sock && t.isReady) {
      try {
        const selfJid = t.sock.user?.id?.replace(/:.*@/, '@') || null;
        if (selfJid) {
          const farewellMsg = `${userName}, me voy a dormir! 😴🔌\nTu WhatsApp se desvinculó, necesitás reconectar.`;
          const sent = await t.sock.sendMessage(selfJid, { text: farewellMsg });
          console.log(`[TM:${uid}] 💤 Mensaje de despedida enviado a self-chat`);
          // Esperar brevemente para confirmar entrega
          if (sent?.key?.id) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      } catch (farewellErr) {
        console.warn(`[TM:${uid}] ⚠️ No se pudo enviar despedida:`, farewellErr.message);
      }
    }

    // 3️⃣ Logout y limpiar
    if (t.sock) {
      await t.sock.logout();
    }
    tenants.delete(uid);
    await deleteFirestoreSession(`tenant-${uid}`);

    // 4️⃣ Marcar en Firestore que necesita reconectar
    await admin.firestore().collection('users').doc(uid).update({
      whatsapp_needs_reconnect: true,
      whatsapp_recovery_at: new Date(),
      whatsapp_recovery_reason: 'Desconexión manual (destroyTenant)'
    }).catch(() => {});

    // 5️⃣ Notificar por email
    if (userEmail) {
      try {
        await sendSessionRecoveryEmail(uid, userEmail, {
          reason: 'Tu WhatsApp fue desvinculado manualmente',
          recoveredAt: new Date().toISOString(),
          userName
        });
        console.log(`[TM:${uid}] ✅ Email de desconexión enviado a ${userEmail}`);
      } catch (e) {
        console.warn(`[TM:${uid}] ⚠️ Email no enviado:`, e.message);
      }
    }

    // 6️⃣ Notificar admin dashboard
    if (t.io) {
      t.io.emit(`tenant_disconnected_${uid}`, {
        reason: 'manual_disconnect',
        message: `${userName} fue desconectado manualmente`,
        needsQr: true
      });
    }

    console.log(`[TM:${uid}] 🔌 Tenant destroyed (graceful disconnect completo)`);
    return { success: true };
  } catch (err) {
    console.error(`[TM:${uid}] Error destroying:`, err.message);
    tenants.delete(uid);
    return { success: false, error: err.message };
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

function getTenantStatus(uid) {
  const t = tenants.get(uid);
  if (!t) return { exists: false, isReady: false, hasQR: false, conversationCount: 0 };
  return {
    exists: true,
    isReady: t.isReady,
    isAuthenticated: !!t.isAuthenticated,
    hasQR: !!t.qrCode,
    qrCode: t.qrCode,
    conversationCount: Object.keys(t.conversations).length
  };
}

/**
 * Get the raw Baileys socket for a tenant (used for pairing code).
 */
function getTenantClient(uid) {
  const t = tenants.get(uid);
  return t ? t.sock : null;
}

/**
 * Get conversations for a tenant.
 */
async function getTenantConversations(uid) {
  const t = tenants.get(uid);
  if (!t) return [];

  // Return stored conversations (Baileys doesn't have getChats like whatsapp-web.js)
  return Object.entries(t.conversations).map(([phone, msgs]) => {
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      phoneNumber: phone.split('@')[0],
      name: t.leadNames[phone] || phone.split('@')[0],
      lastMessage: lastMsg?.content || '',
      timestamp: lastMsg?.timestamp || null,
      unreadCount: 0
    };
  });
}

function appendTenantTraining(uid, newData) {
  const t = tenants.get(uid);
  if (!t) return false;
  t.trainingData = (t.trainingData ? t.trainingData + '\n' : '') + newData;
  saveTenantDB(uid, {
    conversations: t.conversations,
    leadNames: t.leadNames,
    trainingData: t.trainingData
  });
  return true;
}

function getAllTenants() {
  const result = [];
  for (const [uid, t] of tenants) {
    result.push({
      uid,
      isReady: t.isReady,
      hasQR: !!t.qrCode,
      conversationCount: Object.keys(t.conversations).length
    });
  }
  return result;
}

function classifyContact(uid, phone, contactRules) {
  const t = tenants.get(uid);
  if (!t) return 'otro';

  const msgs = (t.conversations[phone] || []).slice(-10);
  const allText = msgs.map(m => (m.content || '').toLowerCase()).join(' ');

  if (!contactRules) return 'otro';

  if (contactRules.client_keywords && contactRules.client_keywords.length > 0) {
    const isClient = contactRules.client_keywords.some(kw =>
      allText.includes(kw.toLowerCase())
    );
    if (isClient) return 'cliente';
  }

  if (contactRules.lead_keywords && contactRules.lead_keywords.length > 0) {
    const isLead = contactRules.lead_keywords.some(kw =>
      allText.includes(kw.toLowerCase())
    );
    if (isLead) return 'lead';
  }

  return 'otro';
}

function setTenantTrainingData(uid, trainingData) {
  const t = tenants.get(uid);
  if (!t) return false;
  t.trainingData = trainingData;
  saveTenantDB(uid, {
    conversations: t.conversations,
    leadNames: t.leadNames,
    trainingData: t.trainingData
  });
  return true;
}

function setTenantAIConfig(uid, provider, apiKey) {
  const t = tenants.get(uid);
  if (!t) return false;
  t.aiProvider = provider;
  t.aiApiKey = apiKey;
  return true;
}

module.exports = {
  initTenant,
  destroyTenant,
  getTenantStatus,
  getTenantClient,
  getTenantConversations,
  appendTenantTraining,
  setTenantTrainingData,
  setTenantAIConfig,
  classifyContact,
  getAllTenants
};
