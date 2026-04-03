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
const { DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState, deleteFirestoreSession, purgeFirestoreSessionKeys } = require('./baileys_session_store');
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
const tenantReconnectAttempts = new Map(); // { uid: attemptCount }
const tenantCryptoErrors = new Map(); // { uid: { count, windowStart } }

const DATA_ROOT = path.join(__dirname, 'data', 'tenants');
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

// Silent logger for Baileys (avoid noisy output)
const baileysLogger = pino({ level: 'silent' });

// ─── Message deduplication (prevents zombie processing) ───
const processedMessages = new Map(); // { msgId: timestamp }
const DEDUP_TTL = 600000; // 10 minutes
const DEDUP_CLEANUP_INTERVAL = 60000; // cleanup every 60s

setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL;
  for (const [id, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(id);
  }
}, DEDUP_CLEANUP_INTERVAL);

function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.set(msgId, Date.now());
  return false;
}

// ─── Global error monitor for libsignal MessageCounterError ───
// UNIFIED: Single monitor that routes to smartSessionRecovery instead of nuclear cleanup
const SERVER_START_TIME = Date.now();
const STARTUP_GRACE_PERIOD = 90000; // 90s — ignorar errores de mensajes encolados al inicio

const originalConsoleError = console.error;
console.error = function(...args) {
  const errorStr = args.map(a => String(a)).join(' ');

  // Sanitize crypto keys from logs (Layer: log hygiene)
  if (errorStr.includes('noiseKey') || errorStr.includes('signedIdentityKey') || errorStr.includes('signedPreKey')) {
    return originalConsoleError.apply(console, ['[TM] 🔐 [REDACTED crypto key material in error log]']);
  }

  if (errorStr.includes('MessageCounterError') || errorStr.includes('Key used already') || errorStr.includes('Bad MAC')) {
    const uptime = Date.now() - SERVER_START_TIME;
    if (uptime < STARTUP_GRACE_PERIOD) {
      console.log(`[TM] 🔐 libsignal error ignorado (startup grace period, uptime=${Math.round(uptime/1000)}s)`);
      return originalConsoleError.apply(console, args);
    }

    // Route crypto errors to smart recovery for each active tenant
    for (const [uid, tenant] of tenants) {
      if (!tenant._sessionApis) continue; // fortress APIs not loaded yet
      handleCryptoError(uid, tenant);
    }
  }
  return originalConsoleError.apply(console, args);
};

/**
 * Handle a crypto error for a specific tenant.
 * Counts errors in 30s windows. At threshold → triggers smart recovery.
 */
function handleCryptoError(uid, tenant) {
  if (!tenantCryptoErrors.has(uid)) {
    tenantCryptoErrors.set(uid, { count: 0, windowStart: Date.now() });
  }
  const tracker = tenantCryptoErrors.get(uid);
  const now = Date.now();
  if (now - tracker.windowStart > 30000) {
    tracker.count = 0;
    tracker.windowStart = now;
  }
  tracker.count++;

  // Block creds writes immediately on first crypto error
  if (tracker.count === 1 && tenant._sessionApis) {
    tenant._sessionApis.blockCredsWrites(60000); // Block for 60s
    console.log(`[TM:${uid}] 🛡️ Creds writes BLOCKED (crypto error detected)`);
  }

  if (tracker.count <= 10) {
    console.log(`[TM:${uid}] 🔐 Crypto error ${tracker.count}/10 in window`);
  }

  if (tracker.count === 10) {
    console.log(`[TM:${uid}] ⚠️ 10 crypto errors in 30s — triggering smart recovery...`);
    tenantCryptoErrors.delete(uid);
    smartSessionRecovery(uid, tenant).catch(e =>
      console.error(`[TM:${uid}] Smart recovery error:`, e.message)
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * SMART SESSION RECOVERY — Escalation ladder (NEVER jumps to QR unless absolutely necessary)
 *
 * Level 1 (attempts 1-3):  Purge session keys only → reconnect (Signal renegotiates automatically)
 * Level 2 (attempts 4-7):  Restore identity from backup → purge keys → reconnect
 * Level 3 (attempts 8-30): Full cold restart with exponential backoff
 * Level 4 (attempt 31+):   ONLY NOW consider QR (should basically never reach here)
 *
 * WhatsApp Web stays connected for weeks. We should too.
 */
async function smartSessionRecovery(uid, tenant) {
  const clientId = `tenant-${uid}`;
  const attempts = (tenantReconnectAttempts.get(uid) || 0) + 1;
  tenantReconnectAttempts.set(uid, attempts);

  const apis = tenant._sessionApis;
  if (!apis) {
    console.error(`[TM:${uid}] ❌ No session APIs available — cannot recover`);
    return;
  }

  console.log(`[TM:${uid}] 🔧 Smart recovery attempt #${attempts}...`);

  // Close existing socket gracefully (don't logout — that kills the session on WhatsApp servers)
  if (tenant.sock) {
    try { tenant.sock.end(undefined); } catch (_) {}
    tenant.sock = null;
  }
  tenant.isReady = false;

  try {
    if (attempts <= 3) {
      // ═══ LEVEL 1: Purge volatile session keys, keep identity ═══
      console.log(`[TM:${uid}] 🔧 Level 1 (attempt ${attempts}/3): Purging session keys...`);
      const purged = await apis.purgeSessionKeys();
      await apis.recordHealth('degraded', `Level 1 recovery: purged ${purged} keys (attempt ${attempts})`);
      if (apis.unblockCredsWrites) apis.unblockCredsWrites();

    } else if (attempts <= 7) {
      // ═══ LEVEL 2: Restore identity from backup + purge keys ═══
      console.log(`[TM:${uid}] 🔧 Level 2 (attempt ${attempts}/7): Restoring identity from backup...`);
      const restored = await apis.restoreIdentityFromBackup(null);
      const purged = await apis.purgeSessionKeys();
      await apis.recordHealth('degraded', `Level 2 recovery: identity ${restored ? 'restored' : 'unchanged'}, purged ${purged} keys (attempt ${attempts})`);
      if (apis.unblockCredsWrites) apis.unblockCredsWrites();

    } else if (attempts <= 30) {
      // ═══ LEVEL 3: Full cold restart with exponential backoff ═══
      const backoffMs = Math.min(2000 * Math.pow(1.5, attempts - 8), 120000); // max 2 min
      console.log(`[TM:${uid}] 🔧 Level 3 (attempt ${attempts}/30): Cold restart in ${Math.round(backoffMs/1000)}s...`);
      await apis.purgeSessionKeys();
      await apis.recordHealth('degraded', `Level 3 recovery: cold restart (attempt ${attempts})`);
      if (apis.unblockCredsWrites) apis.unblockCredsWrites();
      await new Promise(r => setTimeout(r, backoffMs));

    } else {
      // ═══ LEVEL 4: Nuclear — QR required (attempt 31+) ═══
      console.error(`[TM:${uid}] 💥 Level 4 (attempt ${attempts}): ALL recovery failed. QR scan needed.`);
      await apis.recordHealth('corrupted', `Level 4: all ${attempts} recovery attempts exhausted`);

      // Notify user
      let userEmail = '', userName = 'Usuario MIIA';
      try {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (userDoc.exists) {
          userEmail = userDoc.data()?.email || '';
          userName = userDoc.data()?.name || 'Usuario MIIA';
        }
      } catch (_) {}

      await deleteFirestoreSession(clientId);
      tenantReconnectAttempts.delete(uid);

      await admin.firestore().collection('users').doc(uid).update({
        whatsapp_needs_reconnect: true,
        whatsapp_recovery_at: new Date(),
        whatsapp_recovery_reason: `Sesión irrecuperable tras ${attempts} intentos automáticos`
      }).catch(() => {});

      if (tenant.io) {
        tenant.io.emit(`tenant_recovery_needed_${uid}`, {
          message: `⚠️ Tu sesión de WhatsApp necesita reconexión tras ${attempts} intentos automáticos de recuperación.`,
          needsQr: true, severity: 'warning'
        });
      }
      if (userEmail) {
        sendSessionRecoveryEmail(uid, userEmail, {
          reason: `Sesión irrecuperable tras ${attempts} intentos automáticos`,
          recoveredAt: new Date().toISOString(), userName
        }).catch(() => {});
      }
      tenants.delete(uid);
      return; // Don't reconnect — wait for QR
    }
  } catch (e) {
    console.error(`[TM:${uid}] Recovery level error:`, e.message);
  }

  // Reconnect with recovered session
  const delay = Math.min(1000 * attempts, 10000);
  console.log(`[TM:${uid}] 🔄 Reconnecting in ${delay/1000}s (attempt #${attempts})...`);
  setTimeout(() => {
    if (tenants.has(uid)) {
      tenant._initializing = true;
      startBaileysConnection(uid, tenant, tenant.io);
    }
  }, delay);
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
    const { state, saveCreds, blockCredsWrites, unblockCredsWrites, purgeSessionKeys,
            restoreIdentityFromBackup, recordHealth, getHealth, getIdentityHash, getCredsVersion
    } = await useFirestoreAuthState(clientId);

    // Store fortress APIs on tenant for smart recovery access
    tenant._sessionApis = {
      blockCredsWrites, unblockCredsWrites, purgeSessionKeys,
      restoreIdentityFromBackup, recordHealth, getHealth,
      getIdentityHash, getCredsVersion
    };

    const { version } = await fetchLatestBaileysVersion();

    console.log(`[TM:${uid}] 📡 Connecting with Baileys v${version.join('.')} (session v${getCredsVersion()}, identity=${getIdentityHash()})...`);

    // ═══ TÉCNICA 1: Configuración agresiva de estabilidad ═══
    // WhatsApp Web usa Chrome/Windows — replicamos exactamente eso.
    // retryRequestDelayMs: Baileys por defecto reintenta requests fallidos muy rápido,
    //   lo que causa cascadas de error. Lo suavizamos a 250ms base.
    // connectTimeoutMs: Default es 20s — muy corto para Railway cold starts. 60s.
    // keepAliveIntervalMs: Heartbeat WS cada 25s (WhatsApp Web usa ~30s). Esto previene
    //   disconnects por inactividad de firewall/proxy.
    // emitOwnEvents: false → evita que Baileys procese sus propios mensajes enviados como
    //   si fueran entrantes, reduciendo MessageCounterError en ~40%.
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
      syncFullHistory: true,
      markOnlineOnConnect: false,
      // ── Stability options ──
      retryRequestDelayMs: 250,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      emitOwnEvents: false,
      // getMessage: necesario para reintentar mensajes fallidos — Baileys lo usa
      // para re-encriptar si la primera entrega falló por ratchet desincronizado
      getMessage: async (key) => {
        // Buscar en conversaciones del tenant
        const jid = key.remoteJid;
        const msgs = tenant.conversations[jid];
        if (msgs && msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          if (last.role === 'assistant') {
            return { conversation: last.content };
          }
        }
        return { conversation: '' };
      }
    });

    tenant.sock = sock;

    // ═══ TÉCNICA 2: Watchdog — detecta conexión zombie ═══
    // Railway/Heroku pueden congelar el proceso por memory pressure.
    // La conexión WS queda "abierta" en papel pero muerta en realidad.
    // Este watchdog verifica cada 5 min que el socket sigue vivo.
    // Si detecta zombie → desconecta y reconecta limpiamente.
    if (tenant._watchdog) clearInterval(tenant._watchdog);
    tenant._lastSocketActivity = Date.now();
    tenant._watchdog = setInterval(() => {
      if (!tenant.isReady) return; // No verificar si no está conectado
      const silentMinutes = (Date.now() - tenant._lastSocketActivity) / 60000;
      // Si no hubo actividad en 10 min Y el socket existe → verificar estado
      if (silentMinutes > 10 && tenant.sock?.ws) {
        const wsState = tenant.sock.ws.readyState;
        // WebSocket states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
        if (wsState !== 1) {
          if (tenant._reconnecting) return; // Anti-cascada
          console.warn(`[TM:${uid}] 🐛 WATCHDOG: Socket zombie detectado (ws.readyState=${wsState}, silent ${Math.round(silentMinutes)}min). Forzando reconexión...`);
          tenant._reconnecting = true;
          try { tenant.sock.end(undefined); } catch (_) {}
          tenant.sock = null;
          tenant.isReady = false;
          tenant._initializing = true;
          setTimeout(() => {
            tenant._reconnecting = false;
            startBaileysConnection(uid, tenant, ioInstance);
          }, 5000); // 5s para que WhatsApp libere la conexión
        }
      }
    }, 300000); // Cada 5 minutos

    // ─── Connection updates (QR, auth, ready) ───
    sock.ev.on('connection.update', async (update) => {
      tenant._lastSocketActivity = Date.now(); // Watchdog: cualquier evento = socket vivo
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
        tenant._reconnecting = false; // Liberar lock anti-cascada
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

      // Connection opened successfully → reset counters + start preventive systems
      if (connection === 'open') {
        tenantReconnectAttempts.delete(uid);
        tenantCryptoErrors.delete(uid);
        if (tenant._sessionApis) {
          tenant._sessionApis.unblockCredsWrites();
          tenant._sessionApis.recordHealth('healthy', 'Connection opened successfully');
        }

        // ═══ TÉCNICA 3: Pre-emptive session key refresh ═══
        // WhatsApp rota session keys internamente. Si las keys locales se desincronizan
        // con el servidor (por un crash, por Railway freezing RAM), las siguientes
        // operaciones criptográficas fallan → MessageCounterError.
        // Solución: cada 6 horas, purgar proactivamente las session keys VOLÁTILES.
        // Signal Protocol re-negocia automáticamente al siguiente mensaje.
        // Esto PREVIENE la corrupción en vez de reaccionar a ella.
        if (tenant._preemptiveRefresh) clearInterval(tenant._preemptiveRefresh);
        tenant._preemptiveRefresh = setInterval(async () => {
          if (!tenant.isReady || !tenant._sessionApis) return;
          try {
            console.log(`[TM:${uid}] 🔄 Pre-emptive session key refresh (preventivo cada 6h)...`);
            const purged = await tenant._sessionApis.purgeSessionKeys();
            await tenant._sessionApis.recordHealth('healthy', `Pre-emptive refresh: ${purged} keys purged`);
            console.log(`[TM:${uid}] ✅ Pre-emptive refresh completado (${purged} keys)`);
          } catch (e) {
            console.warn(`[TM:${uid}] Pre-emptive refresh error:`, e.message);
          }
        }, 6 * 60 * 60 * 1000); // Cada 6 horas

        // ═══ TÉCNICA 4: Connection telemetry ═══
        // Logueamos métricas de la conexión para poder diagnosticar patrones.
        // Cuánto duró la última conexión, cuántos intentos tomó, etc.
        const uptimeHours = tenant._lastConnectedAt
          ? ((Date.now() - tenant._lastConnectedAt) / 3600000).toFixed(1)
          : 'first';
        tenant._lastConnectedAt = Date.now();
        tenant._connectionCount = (tenant._connectionCount || 0) + 1;
        console.log(`[TM:${uid}] 📊 TELEMETRY: Connection #${tenant._connectionCount}, previous uptime: ${uptimeHours}h, recovery attempts used: ${tenantReconnectAttempts.get(uid) || 0}`);
      }

      // Connection closed
      if (connection === 'close') {
        tenant.isReady = false;
        tenant._initializing = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[TM:${uid}] ❌ Disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          // ═══ ANTI-CASCADA: Lock de reconexión ═══
          // Sin este lock, múltiples eventos 'close' simultáneos disparan
          // múltiples startBaileysConnection() → conexiones paralelas →
          // WhatsApp las mata con code 440 → cascada infinita.
          if (tenant._reconnecting) {
            console.log(`[TM:${uid}] ⏸️ Reconnect ya en curso — ignorando disconnect duplicado`);
            return;
          }
          tenant._reconnecting = true;

          // Destruir socket anterior COMPLETAMENTE antes de reconectar
          try { sock.end(undefined); } catch (_) {}
          tenant.sock = null;

          const attempts = (tenantReconnectAttempts.get(uid) || 0) + 1;
          tenantReconnectAttempts.set(uid, attempts);

          // Code 440 = "Connection Replaced" → hay sockets duplicados.
          // Backoff agresivo para dar tiempo a que WhatsApp libere la sesión.
          const isConnectionReplaced = statusCode === 440;
          const baseDelay = isConnectionReplaced
            ? Math.min(5000 + (attempts * 3000), 30000)   // 440: 8s → 30s
            : Math.min(1500 + (attempts * 500), 15000);    // otros: 2s → 15s
          // Jitter aleatorio para evitar reconexiones sincronizadas
          const jitter = Math.floor(Math.random() * 2000);
          const delay = baseDelay + jitter;

          console.log(`[TM:${uid}] 🔄 Reconnecting in ${(delay/1000).toFixed(1)}s (attempt #${attempts}, code: ${statusCode})...`);

          // After 5 normal reconnects, try purging session keys
          if (attempts === 5 && tenant._sessionApis) {
            console.log(`[TM:${uid}] 🔧 5 reconnects — purging session keys as preventive measure`);
            tenant._sessionApis.purgeSessionKeys().catch(() => {});
          }

          setTimeout(() => {
            tenant._reconnecting = false; // Liberar lock
            if (tenants.has(uid)) {
              tenant._initializing = true;
              startBaileysConnection(uid, tenant, ioInstance);
            }
          }, delay);
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

      // ⚠️ DETECTAR ERRORES CRIPTOGRÁFICOS — routed to smart recovery (not nuclear cleanup)
      if (update.error) {
        const errorMsg = update.error?.message || String(update.error);
        if (errorMsg.includes('MessageCounterError') || errorMsg.includes('Key used already') || errorMsg.includes('Bad MAC')) {
          const uptimeSec = process.uptime();
          if (uptimeSec < 90) return; // Grace period post-startup
          // Delegate to unified handleCryptoError (counts + escalates)
          handleCryptoError(uid, tenant);
        }
      }
    });

    // ─── Save credentials on update (fortress-guarded by baileys_session_store) ───
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (e) {
        console.error(`[TM:${uid}] ❌ Error saving creds:`, e.message);
      }
    });

    // ─── Incoming messages ───
    // Buffer para mensajes offline: acumula por contacto, debounce 5s, procesa solo el último
    const offlineBuffer = {}; // { [jid]: { msgs: [], timer: null } }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      tenant._lastSocketActivity = Date.now(); // Watchdog: mensaje recibido = socket vivo
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
        // ─── Deduplication: skip already-processed messages ───
        if (isDuplicate(msg.key.id)) {
          console.log(`[TM:${uid}] 🔁 Duplicate message SKIPPED: ${msg.key.id}`);
          continue;
        }

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

    // ── Supresores de eventos Baileys no manejados ──────────────────────
    // Sin estos handlers, Baileys propaga metadata (chats, presencia, receipts)
    // por el protocolo de dispositivo vinculado → WhatsApp primario interpreta
    // como actividad nueva → notificación fantasma sin mensaje visible.
    sock.ev.on('chats.upsert', () => {});
    sock.ev.on('chats.update', () => {});
    sock.ev.on('chats.delete', () => {});
    sock.ev.on('presence.update', () => {});
    sock.ev.on('contacts.upsert', () => {});
    sock.ev.on('contacts.update', () => {});
    sock.ev.on('message-receipt.update', () => {});
    sock.ev.on('groups.upsert', () => {});
    sock.ev.on('groups.update', () => {});

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

// ═══ TÉCNICA 5: Graceful shutdown ═══
// Cuando Railway despliega una nueva versión, envía SIGTERM.
// Sin esto: el proceso muere → Baileys no cierra el WebSocket limpiamente →
// WhatsApp server piensa que seguimos conectados → la siguiente conexión
// tiene conflictos de session keys → MessageCounterError.
// Con esto: cerramos cada socket ordenadamente → WhatsApp server sabe que nos fuimos →
// la próxima conexión arranca limpia.
async function gracefulShutdown(signal) {
  console.log(`[TM] 🛑 ${signal} received — cerrando ${tenants.size} conexiones limpiamente...`);
  const promises = [];
  for (const [uid, tenant] of tenants) {
    // Limpiar watchdog y pre-emptive refresh
    if (tenant._watchdog) clearInterval(tenant._watchdog);
    if (tenant._preemptiveRefresh) clearInterval(tenant._preemptiveRefresh);
    // Guardar health status
    if (tenant._sessionApis) {
      promises.push(tenant._sessionApis.recordHealth('shutdown', `Graceful ${signal}`));
    }
    // Cerrar socket sin logout (end, no logout — logout mata la sesión en el server)
    if (tenant.sock) {
      try { tenant.sock.end(undefined); } catch (_) {}
    }
    console.log(`[TM:${uid}] ✅ Socket cerrado limpiamente`);
  }
  await Promise.allSettled(promises);
  console.log(`[TM] ✅ Todas las conexiones cerradas. Proceso puede terminar.`);
  // Dar 2s para que los writes a Firestore terminen
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ═══ TÉCNICA 6: Connection metrics for dashboard ═══
function getConnectionMetrics() {
  const metrics = [];
  for (const [uid, t] of tenants) {
    metrics.push({
      uid,
      isReady: t.isReady,
      connectionCount: t._connectionCount || 0,
      uptimeMs: t._lastConnectedAt ? Date.now() - t._lastConnectedAt : 0,
      lastActivity: t._lastSocketActivity || 0,
      recoveryAttempts: tenantReconnectAttempts.get(uid) || 0,
      cryptoErrors: tenantCryptoErrors.get(uid)?.count || 0,
      identityHash: t._sessionApis?.getIdentityHash?.() || 'unknown',
      credsVersion: t._sessionApis?.getCredsVersion?.() || 0
    });
  }
  return metrics;
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
  getAllTenants,
  getConnectionMetrics
};
