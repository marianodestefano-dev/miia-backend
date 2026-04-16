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
const { callAI } = require('../ai/ai_client');
const { buildTenantPrompt, buildOwnerLeadPrompt } = require('../core/prompt_builder');
const { sendSessionRecoveryEmail } = require('../services/mail_service');
const { handleTenantMessage } = require('./tenant_message_handler');

// ─── Tenant state ─────────────────────────────────────────────────────────────
const tenants = new Map();
const tenantReconnectAttempts = new Map(); // { uid: attemptCount }
const tenantCryptoErrors = new Map(); // { uid: { count, windowStart } }

// ═══════════════════════════════════════════════════════════════════
// DUAL-ENGINE F1 — Motor Combustión + Motor Eléctrico
// ═══════════════════════════════════════════════════════════════════
// Dos perfiles de conexión independientes. Cuando uno entra en loop
// de fallos, el otro toma el control con configuración diferente.
// Cada engine hereda el diagnóstico del que falló.
// ═══════════════════════════════════════════════════════════════════

const ENGINE_PROFILES = {
  A: {
    name: 'Combustión',
    emoji: '🔥',
    browser: ['MIIA', 'Chrome', '120.0.0'],
    keepAliveIntervalMs: 45_000,
    connectTimeoutMs: 60_000,
    retryRequestDelayMs: 250,
    markOnlineOnConnect: false,
  },
  B: {
    name: 'Eléctrico',
    emoji: '⚡',
    browser: ['MIIA', 'Firefox', '115.0'],
    keepAliveIntervalMs: 15_000,
    connectTimeoutMs: 45_000,
    retryRequestDelayMs: 400,
    markOnlineOnConnect: true, // Diferente estrategia
  }
};

// Health scoring por engine por tenant
// healthScore: 100 = perfecto, 0 = muerto
// consecutiveFails: fallos seguidos sin conexión estable
// lastFailReason: diagnóstico para el otro engine
const ENGINE_SWITCH_THRESHOLD = 3; // Switch después de 3 fallos consecutivos
const ENGINE_HEALTH_RECOVERY_INTERVAL = 300_000; // Recuperar 10pts cada 5min estable

function getEngineState(tenant) {
  if (!tenant._engineState) {
    tenant._engineState = {
      current: 'A',
      A: { healthScore: 100, consecutiveFails: 0, lastFailReason: null, totalConnections: 0, lastStableAt: null },
      B: { healthScore: 100, consecutiveFails: 0, lastFailReason: null, totalConnections: 0, lastStableAt: null },
      switchCount: 0,
      lastSwitchAt: null,
    };
  }
  return tenant._engineState;
}

function getCurrentEngineProfile(tenant) {
  const es = getEngineState(tenant);
  return ENGINE_PROFILES[es.current];
}

function recordEngineSuccess(tenant, uid) {
  const es = getEngineState(tenant);
  const engine = es[es.current];
  engine.consecutiveFails = 0;
  engine.healthScore = Math.min(100, engine.healthScore + 5);
  engine.totalConnections++;
  engine.lastStableAt = Date.now();
}

function recordEngineFail(tenant, uid, reason) {
  const es = getEngineState(tenant);
  const engine = es[es.current];
  engine.consecutiveFails++;
  engine.healthScore = Math.max(0, engine.healthScore - 15);
  engine.lastFailReason = reason;

  // ¿Necesita switchear?
  if (engine.consecutiveFails >= ENGINE_SWITCH_THRESHOLD) {
    const other = es.current === 'A' ? 'B' : 'A';
    const otherEngine = es[other];

    // Solo switchear si el otro tiene mejor salud O si pasó suficiente tiempo
    const cooldownOk = !es.lastSwitchAt || (Date.now() - es.lastSwitchAt > 60_000);
    if (cooldownOk && otherEngine.healthScore > 20) {
      const prev = es.current;
      es.current = other;
      es.switchCount++;
      es.lastSwitchAt = Date.now();
      // Reset consecutiveFails del nuevo engine
      otherEngine.consecutiveFails = 0;
      console.log(`[TM:${uid}] 🏎️ ENGINE SWITCH: ${ENGINE_PROFILES[prev].emoji} ${ENGINE_PROFILES[prev].name} → ${ENGINE_PROFILES[other].emoji} ${ENGINE_PROFILES[other].name} | Razón: ${reason} | Switch #${es.switchCount}`);
      console.log(`[TM:${uid}] 📊 Health: A=${es.A.healthScore}/100, B=${es.B.healthScore}/100 | Herencia: "${engine.lastFailReason}"`);
      return true; // Switched
    }
  }
  return false; // No switch
}

// Health recovery: si un engine lleva 5+ min estable, recuperar puntos del otro
function startEngineHealthRecovery(tenant, uid) {
  if (tenant._engineHealthTimer) clearInterval(tenant._engineHealthTimer);
  tenant._engineHealthTimer = setInterval(() => {
    const es = getEngineState(tenant);
    if (!tenant.isReady) return;
    const current = es[es.current];
    const other = es[es.current === 'A' ? 'B' : 'A'];
    // Engine activo estable → recuperar salud
    current.healthScore = Math.min(100, current.healthScore + 2);
    // Engine inactivo → recuperar lentamente (para que esté listo si se necesita)
    if (other.healthScore < 80) {
      other.healthScore = Math.min(80, other.healthScore + 5);
    }
  }, ENGINE_HEALTH_RECOVERY_INTERVAL);
}

const DATA_ROOT = path.join(__dirname, 'data', 'tenants');
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

// Silent logger for Baileys (avoid noisy output)
const baileysLogger = pino({ level: 'silent' });

// ─── Message deduplication (prevents zombie processing) ───
const processedMessages = new Map(); // { msgId: timestamp }
// ─── Noise reduction: count skipped messages instead of logging each one ───
const _skipCounters = { duplicate: 0, offlineOld: 0, offlineProcessed: 0, _lastFlush: Date.now() };
function _flushSkipCounters(uid) {
  const now = Date.now();
  if (now - _skipCounters._lastFlush < 10000) return; // Flush every 10s max
  const { duplicate, offlineOld, offlineProcessed } = _skipCounters;
  if (duplicate + offlineOld + offlineProcessed > 0) {
    console.log(`[TM:${uid}] 📊 Mensajes omitidos (últimos 10s): ${duplicate} duplicados, ${offlineOld} offline viejos, ${offlineProcessed} offline ya procesados`);
    _skipCounters.duplicate = 0;
    _skipCounters.offlineOld = 0;
    _skipCounters.offlineProcessed = 0;
  }
  _skipCounters._lastFlush = now;
}
const DEDUP_TTL = 1800000; // 30 minutes — sobrevivir ciclos de reconexión Bad MAC
const DEDUP_CLEANUP_INTERVAL = 60000; // cleanup every 60s

setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL;
  for (const [id, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(id);
  }
}, DEDUP_CLEANUP_INTERVAL);

function isDuplicate(msgId, uid = '') {
  if (!msgId) return false;
  // FIX: Dedup per-tenant — el mismo msgId puede llegar a 2 tenants distintos
  // (ej: Mariano escribe desde MIIA CENTER a personal → ambos reciben mismo msgId)
  const key = uid ? `${uid}:${msgId}` : msgId;
  if (processedMessages.has(key)) return true;
  processedMessages.set(key, Date.now());
  return false;
}

// ─── Global error monitor for libsignal MessageCounterError ───
// UNIFIED: Single monitor that routes to smartSessionRecovery instead of nuclear cleanup
const SERVER_START_TIME = Date.now();
const STARTUP_GRACE_PERIOD = 90000; // 90s — ignorar errores de mensajes encolados al inicio

// Acumulador de errores crypto durante startup — log limpio
const _startupCryptoErrors = { badMAC: 0, counterError: 0, failedDecrypt: 0, total: 0 };
let _startupCryptoSummaryLogged = false;

function _logStartupCryptoSummary() {
  if (_startupCryptoSummaryLogged || _startupCryptoErrors.total === 0) return;
  _startupCryptoSummaryLogged = true;
  const e = _startupCryptoErrors;
  console.log(`[TM] 🔐 STARTUP CRYPTO: ${e.total} errores de descifrado (${e.badMAC}× Bad MAC, ${e.counterError}× MessageCounter, ${e.failedDecrypt}× Failed decrypt) — normal post-reconexión, claves re-negociadas OK`);
}

// Programar resumen al final del grace period
setTimeout(_logStartupCryptoSummary, STARTUP_GRACE_PERIOD + 1000);

const originalConsoleError = console.error;
console.error = function(...args) {
  const errorStr = args.map(a => String(a)).join(' ');

  // Sanitize crypto keys from logs (Layer: log hygiene)
  if (errorStr.includes('noiseKey') || errorStr.includes('signedIdentityKey') || errorStr.includes('signedPreKey')) {
    return originalConsoleError.apply(console, ['[TM] 🔐 [REDACTED crypto key material in error log]']);
  }

  // Errores de cifrado Signal (libsignal)
  if (errorStr.includes('MessageCounterError') || errorStr.includes('Key used already') || errorStr.includes('Bad MAC') || errorStr.includes('Failed to decrypt')) {
    const uptime = Date.now() - SERVER_START_TIME;
    if (uptime < STARTUP_GRACE_PERIOD) {
      // Acumular silenciosamente — resumen al final del grace period
      _startupCryptoErrors.total++;
      if (errorStr.includes('Bad MAC')) _startupCryptoErrors.badMAC++;
      else if (errorStr.includes('MessageCounterError') || errorStr.includes('Key used already')) _startupCryptoErrors.counterError++;
      else if (errorStr.includes('Failed to decrypt')) _startupCryptoErrors.failedDecrypt++;
      return; // NO imprimir — silencio total durante startup
    }

    // Post-startup: route crypto error to the SPECIFIC tenant (not all)
    // Try to identify the tenant from the error string (phone number or JID)
    let matched = false;
    for (const [uid, tenant] of tenants) {
      if (!tenant._sessionApis) continue;
      const tenantPhone = tenant.phone || '';
      // Check if the error contains this tenant's phone number
      if (tenantPhone && errorStr.includes(tenantPhone)) {
        handleCryptoError(uid, tenant, errorStr);
        matched = true;
        break;
      }
    }
    // If only 1 tenant active, attribute to that one
    if (!matched) {
      const activeTenants = [...tenants.entries()].filter(([, t]) => t._sessionApis);
      if (activeTenants.length === 1) {
        handleCryptoError(activeTenants[0][0], activeTenants[0][1], errorStr);
      } else if (activeTenants.length > 1) {
        // No podemos determinar cuál tenant — intentar recovery en TODOS
        // handleCryptoError usa per-contact purge (quirúrgico) así que es seguro
        originalConsoleError.apply(console, [`[TM] 🔄 Crypto error con ${activeTenants.length} tenants activos — intentando recovery en TODOS (per-contact purge es seguro)`]);
        for (const [tUid, tTenant] of activeTenants) {
          handleCryptoError(tUid, tTenant, errorStr);
        }
      }
    }
  }
  return originalConsoleError.apply(console, args);
};

/**
 * Handle a crypto error for a specific tenant.
 * STRATEGY: Per-contact purge FIRST (surgical), global purge only after escalation.
 * Counts errors in 30s windows. At threshold → triggers smart recovery.
 * @param {string} errorStr - Optional: the error string to extract JID from
 */
function handleCryptoError(uid, tenant, errorStr = '') {
  if (!tenantCryptoErrors.has(uid)) {
    tenantCryptoErrors.set(uid, { count: 0, windowStart: Date.now(), contactPurges: new Set() });
  }
  const tracker = tenantCryptoErrors.get(uid);
  const now = Date.now();
  if (now - tracker.windowStart > 30000) {
    tracker.count = 0;
    tracker.windowStart = now;
    tracker.contactPurges = new Set();
  }
  tracker.count++;

  // Block creds writes immediately on first crypto error
  if (tracker.count === 1 && tenant._sessionApis) {
    tenant._sessionApis.blockCredsWrites(60000); // Block for 60s
    console.log(`[TM:${uid}] 🛡️ Creds writes BLOCKED (crypto error detected)`);
  }

  // ═══ PER-CONTACT PURGE: Extract JID from error and purge ONLY that contact's keys ═══
  // This preserves crypto state with all OTHER contacts (surgical vs nuclear)
  if (tracker.count <= 5 && tenant._sessionApis?.purgeSessionKeysForContact && errorStr) {
    // Extract JID from error — multiple patterns:
    // 1. Standard: "1234567890:123@s.whatsapp.net" or "1234567890@s.whatsapp.net"
    // 2. LID: "136417472712832.90 [as awaitable]" — 15-18 digit LIDs in stack trace
    // 3. Session cipher: "at async 136417472712832.90" — LID in function name
    let contactJid = null;

    // Pattern 1: Standard JID with @
    const jidMatch = errorStr.match(/(\d{10,18})(?:[:.]\d+)?@/);
    if (jidMatch) {
      contactJid = jidMatch[1];
    }

    // Pattern 2: LID in stack trace (e.g., "136417472712832.90 [as awaitable]")
    if (!contactJid) {
      const lidMatch = errorStr.match(/(?:async|at)\s+(\d{12,18})\.\d+/);
      if (lidMatch) {
        contactJid = lidMatch[1];
        console.log(`[TM:${uid}] 🔍 LID detectado en error: ${contactJid}`);
      }
    }

    if (contactJid && !tracker.contactPurges.has(contactJid)) {
      tracker.contactPurges.add(contactJid);
      // Purge con @s.whatsapp.net Y @lid (LIDs usan ambos sufijos)
      const purgeJid = contactJid.length > 15 ? contactJid + '@lid' : contactJid + '@s.whatsapp.net';
      tenant._sessionApis.purgeSessionKeysForContact(purgeJid)
        .then(purged => {
          if (purged > 0) console.log(`[TM:${uid}] 🎯 Per-contact purge: ${purged} keys for ${contactJid}`);
          else console.log(`[TM:${uid}] 🔍 Per-contact purge: 0 keys found for ${contactJid} (may use different key format)`);
        })
        .catch(e => console.error(`[TM:${uid}] Per-contact purge error:`, e.message));
    }
  }

  if (tracker.count === 1 || tracker.count === 5 || tracker.count === 10) {
    console.log(`[TM:${uid}] 🔐 Crypto error ${tracker.count}/10 in window (per-contact purges: ${tracker.contactPurges.size})`);
  }

  if (tracker.count === 10) {
    console.log(`[TM:${uid}] ⚠️ 10 crypto errors in 30s — per-contact purges (${tracker.contactPurges.size}) insufficient, triggering GLOBAL recovery...`);
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

  // Actualizar último timestamp procesado (anti-repetición post-reconexión)
  const lastTs = typeof last.msg.messageTimestamp === 'number' ? last.msg.messageTimestamp
    : (last.msg.messageTimestamp?.low || parseInt(last.msg.messageTimestamp) || 0);
  if (lastTs > (tenant._lastProcessedTs || 0)) {
    tenant._lastProcessedTs = lastTs;
  }

  // Si es owner con onMessage (admin/Mariano) → procesar TODOS silenciosamente, responder solo al último
  if (isOwner && tenant.onMessage) {
    // Primero: digest silencioso de todos los mensajes EXCEPTO el último
    // Esto extrae datos (contactos, LIDs, leads) sin generar respuestas
    for (let i = 0; i < bufferedMsgs.length - 1; i++) {
      const m = bufferedMsgs[i];
      m.msg._silentDigest = true; // Flag: extraer datos sin responder
      m.msg._offlineContext = { totalMessages: totalMsgs, oldestAgeSec: oldestAge, ageLabel, allBodies: [] };
      try { tenant.onMessage(m.msg, m.from, m.body); } catch (e) {
        console.error(`[TM:${uid}] onMessage silent digest error:`, e.message);
      }
    }
    // Último mensaje: responder normalmente con contexto completo
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
      const alertMsg = `👱‍♀️: ⚠️ *MIIA - Error de IA*\n\nTu proveedor de IA (${provider}) no tiene créditos o saldo disponible.\n\nCargá saldo en la cuenta del proveedor o cambiá a otra IA desde tu dashboard → Conexiones → Inteligencia Artificial.`;
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
    onContacts: options.onContacts || null, // Callback for contacts sync (LID mapping)
    ownerUid: options.ownerUid || uid,     // UID del owner (agents apuntan al owner)
    role: options.role || 'owner',         // 'owner' | 'agent'
    isOwnerAccount: options.isOwnerAccount || false,  // true = procesar self-chat (fromMe)
    // ═══ PENDING MESSAGE RECOVERY: Cola de mensajes sin responder ═══
    // Rastrea mensajes que MIIA recibió pero aún no respondió.
    // Si el proceso muere mid-response, estos se recuperan al reconectar.
    _unrespondedMessages: new Map() // key: msgId, value: { phone, body, timestamp, from }
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
            purgeSessionKeysForContact, restoreIdentityFromBackup, recordHealth, getHealth, getIdentityHash, getCredsVersion
    } = await useFirestoreAuthState(clientId);

    // Store fortress APIs on tenant for smart recovery access
    tenant._sessionApis = {
      blockCredsWrites, unblockCredsWrites, purgeSessionKeys, purgeSessionKeysForContact,
      restoreIdentityFromBackup, recordHealth, getHealth,
      getIdentityHash, getCredsVersion
    };

    // BUG2-FIX: Exponer saveCreds para SIGTERM handler
    tenant._saveCreds = saveCreds;

    const { version } = await fetchLatestBaileysVersion();

    // ═══ FIX 3: syncFullHistory solo en primera conexión ═══
    const syncStateRef = admin.firestore().collection('baileys_sessions').doc(`tenant-${uid}`).collection('data').doc('sync_state');
    let initialSyncDone = false;
    try {
      const syncDoc = await syncStateRef.get();
      if (syncDoc.exists && syncDoc.data()?.initialSyncDone) {
        initialSyncDone = true;
      }
    } catch (e) {
      console.warn(`[TM:${uid}] ⚠️ Error leyendo sync_state, asumiendo primera conexión:`, e.message);
    }
    console.log(`[TM:${uid}] 📚 History sync: ${initialSyncDone ? 'SKIP (ya minado)' : 'FULL (primera conexión)'}`);

    console.log(`[TM:${uid}] 📡 Connecting with Baileys v${version.join('.')} (session v${getCredsVersion()}, identity=${getIdentityHash()})...`);

    // ═══ DUAL-ENGINE F1: Seleccionar perfil de conexión ═══
    const engineProfile = getCurrentEngineProfile(tenant);
    const engineState = getEngineState(tenant);
    console.log(`[TM:${uid}] 🏎️ Engine ${engineProfile.emoji} ${engineProfile.name} (${engineState.current}) | Health: A=${engineState.A.healthScore}, B=${engineState.B.healthScore}`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
      },
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: engineProfile.browser,
      generateHighQualityLinkPreview: false,
      syncFullHistory: !initialSyncDone,
      markOnlineOnConnect: engineProfile.markOnlineOnConnect,
      // ── Stability options (engine-specific) ──
      retryRequestDelayMs: engineProfile.retryRequestDelayMs,
      connectTimeoutMs: engineProfile.connectTimeoutMs,
      keepAliveIntervalMs: engineProfile.keepAliveIntervalMs,
      emitOwnEvents: false,
      // getMessage: necesario para reintentar mensajes fallidos
      getMessage: async (key) => {
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

    // ═══ TÉCNICA 2: Heartbeat + Watchdog V2 ═══
    // PROBLEMA RESUELTO: el watchdog viejo usaba _lastSocketActivity que se actualizaba
    // con ws.ping() exitosos. Pero ws.ping() puede ser exitoso sin que WhatsApp
    // realmente esté vivo (desconexión fantasma). MIIA dice "Conectado" pero no responde.
    //
    // SOLUCIÓN: separar 2 métricas:
    //   _lastPingOk    — ws.ping() exitoso (solo dice que el WebSocket está abierto)
    //   _lastRealEvent — mensaje real recibido o connection.update (WhatsApp REALMENTE vivo)
    //
    // Heartbeat: ws.ping() cada 3 min (mantiene Railway proxy feliz)
    // Watchdog V2: cada 5 min, si no hubo _lastRealEvent en 10 min → prueba activa
    //   con sendPresenceUpdate(). Si falla → reconecta.
    if (tenant._watchdog) clearInterval(tenant._watchdog);
    if (tenant._heartbeat) clearInterval(tenant._heartbeat);
    if (tenant._activeProbe) clearInterval(tenant._activeProbe);
    const now = Date.now();
    tenant._lastSocketActivity = now; // backward compat
    tenant._lastPingOk = now;
    tenant._lastRealEvent = now;
    tenant._probeFailCount = 0;

    // Heartbeat: ws.ping() cada 3 min — solo mantiene WS vivo para Railway
    tenant._heartbeat = setInterval(async () => {
      if (!tenant.isReady || !tenant.sock) return;
      try {
        const ws = tenant.sock.ws;
        if (ws && typeof ws.ping === 'function') {
          const wsState = ws.readyState;
          if (wsState === 1 || wsState === undefined) {
            ws.ping();
            tenant._lastPingOk = Date.now();
            tenant._lastSocketActivity = Date.now(); // backward compat
          }
        }
      } catch (e) {
        console.warn(`[TM:${uid}] ⚠️ Heartbeat ping failed: ${e.message}`);
      }
    }, 180000); // Cada 3 minutos

    // Watchdog V2 (Active Probe): detecta desconexión fantasma
    // Cada 5 min revisa si hubo actividad REAL. Si no → sendPresenceUpdate como probe.
    // Si el probe falla → socket fantasma → reconectar.
    setTimeout(() => {
    tenant._watchdog = setInterval(async () => {
      if (!tenant.isReady || !tenant.sock || tenant._reconnecting) return;

      const silentMinutes = (Date.now() - (tenant._lastRealEvent || 0)) / 60000;
      const ws = tenant.sock.ws;
      const wsState = ws?.readyState;

      // Caso 1: ws explícitamente muerto (CLOSING/CLOSED/null)
      if (!ws || wsState === 2 || wsState === 3) {
        console.warn(`[TM:${uid}] 🐛 WATCHDOG-V2: Socket MUERTO (ws=${ws ? 'exists' : 'null'}, readyState=${wsState}). Reconectando...`);
        forceReconnect(uid, tenant, ioInstance, 'watchdog_dead_socket');
        return;
      }

      // Caso 2: 10+ min sin actividad real → probe activo
      if (silentMinutes > 10) {
        console.log(`[TM:${uid}] 🔍 WATCHDOG-V2: ${Math.round(silentMinutes)}min sin actividad real. Ejecutando probe activo...`);
        try {
          // sendPresenceUpdate es la operación más liviana que hace un roundtrip real a WhatsApp
          // Si falla, la conexión es fantasma
          await Promise.race([
            tenant.sock.sendPresenceUpdate('available'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 15000))
          ]);
          // Probe exitoso → WhatsApp está vivo, resetear contador
          tenant._probeFailCount = 0;
          tenant._lastRealEvent = Date.now(); // probe confirmó que está vivo
          console.log(`[TM:${uid}] ✅ WATCHDOG-V2: Probe exitoso — WhatsApp confirmado vivo`);
        } catch (probeErr) {
          tenant._probeFailCount = (tenant._probeFailCount || 0) + 1;
          console.warn(`[TM:${uid}] ⚠️ WATCHDOG-V2: Probe FALLÓ (#${tenant._probeFailCount}): ${probeErr.message}`);
          // 2 fallos consecutivos → reconectar (evitar falso positivo por timeout puntual)
          if (tenant._probeFailCount >= 2) {
            console.error(`[TM:${uid}] 🐛 WATCHDOG-V2: ${tenant._probeFailCount} probes fallidos consecutivos. DESCONEXIÓN FANTASMA detectada. Reconectando...`);
            forceReconnect(uid, tenant, ioInstance, 'watchdog_ghost_disconnect');
          }
        }
      }
    }, 300000); // Cada 5 minutos
    }, 90000); // Offset 90s para dar tiempo a la conexión inicial

    // ─── Connection updates (QR, auth, ready) ───
    sock.ev.on('connection.update', async (update) => {
      tenant._lastSocketActivity = Date.now(); // backward compat
      tenant._lastRealEvent = Date.now(); // Watchdog V2: connection.update = WhatsApp REALMENTE vivo
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
        // Cancelar timer de reconexión pendiente (previene socket duplicado → 440 loop)
        if (tenant._reconnectTimer) {
          clearTimeout(tenant._reconnectTimer);
          tenant._reconnectTimer = null;
          console.log(`[TM:${uid}] 🛑 Reconnect timer cancelado — conexión ya abierta`);
        }
        // 🏎️ DUAL-ENGINE: Registrar éxito del engine actual
        recordEngineSuccess(tenant, uid);
        startEngineHealthRecovery(tenant, uid);
        tenant.connectedAt = Math.floor(Date.now() / 1000); // Unix timestamp en segundos
        // Anti-repetición post-deploy: ignorar mensajes anteriores al boot
        if (!tenant._lastProcessedTs) {
          tenant._lastProcessedTs = tenant.connectedAt;
        }

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

        // ═══ PENDING RECOVERY: Reprocesar mensajes que quedaron sin responder ═══
        // Esperar 10s para que todo esté inicializado antes de reprocesar
        setTimeout(async () => {
          try {
            const recovered = await recoverUnrespondedMessages(uid, tenant);
            if (recovered > 0) {
              // Notificar al owner que se recuperaron mensajes
              const selfJid = sock.user?.id;
              if (selfJid && tenant.sock) {
                const noticeMsg = `👱‍♀️: 🔄 *MIIA se reconectó* y recuperó ${recovered} mensaje(s) que quedaron sin responder durante la desconexión. Ya los procesé.`;
                tenant.sock.sendMessage(selfJid, { text: noticeMsg }).then((sent) => {
                  // Registrar msgId para evitar auto-respuesta (bug 6.13)
                  if (sent?.key?.id && tenant._sentMsgIds) {
                    tenant._sentMsgIds.add(sent.key.id);
                  }
                }).catch(() => {});
              }
            }
          } catch (e) {
            console.error(`[TM:${uid}] ❌ RECOVERY post-connect error:`, e.message);
          }
        }, 10000);
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
            console.log(`[TM:${uid}] 🔄 Pre-emptive session key refresh (preventivo cada 24h)...`);
            const purged = await tenant._sessionApis.purgeSessionKeys();
            await tenant._sessionApis.recordHealth('healthy', `Pre-emptive refresh: ${purged} keys purged`);
            console.log(`[TM:${uid}] ✅ Pre-emptive refresh completado (${purged} keys)`);
          } catch (e) {
            console.warn(`[TM:${uid}] Pre-emptive refresh error:`, e.message);
          }
        }, 24 * 60 * 60 * 1000); // Cada 24 horas

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
        // ═══ FIX RACE CONDITION: Solo marcar offline si es el socket actual ═══
        // Si ya hay un socket nuevo conectado, el close del viejo NO debe romper el estado.
        const isCurrentSocket = (tenant.sock === sock || tenant.sock === null);
        if (isCurrentSocket) {
          tenant.isReady = false;
          tenant._initializing = false;
        } else {
          console.log(`[TM:${uid}] 🛡️ Close de socket viejo — isReady=${tenant.isReady} preservado (socket nuevo ya activo)`);
        }
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[TM:${uid}] ❌ Disconnected (code: ${statusCode}). Reconnect: ${shouldReconnect}. isCurrentSocket: ${isCurrentSocket}`);

        if (shouldReconnect) {
          // ═══ FIX RACE CONDITION: No reconectar si ya hay socket nuevo activo ═══
          if (!isCurrentSocket && tenant.isReady) {
            console.log(`[TM:${uid}] 🛡️ Socket viejo cerrado pero nuevo ya CONNECTED — NO reconectar`);
            return;
          }
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
          // ═══ FIX RACE CONDITION: Solo nullificar si es el MISMO socket ═══
          // Si otro startBaileysConnection() ya creó un socket nuevo, no destruirlo.
          // Sin este guard, el close handler del socket viejo mata tenant.sock del nuevo.
          try { sock.end(undefined); } catch (_) {}
          if (tenant.sock === sock || tenant.sock === null) {
            tenant.sock = null;
          } else {
            console.log(`[TM:${uid}] 🛡️ Close handler de socket viejo — NO nullificar tenant.sock (ya hay socket nuevo)`);
          }

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

          // ═══ DUAL-ENGINE F1: Registrar fallo y posible switch ═══
          const reasonCode = `code_${statusCode || 'unknown'}`;
          const engineSwitched = recordEngineFail(tenant, uid, reasonCode);
          if (engineSwitched) {
            // Engine cambió — purgar session keys del engine anterior para empezar limpio
            if (tenant._sessionApis) {
              console.log(`[TM:${uid}] 🏎️ Post-switch: purging session keys del engine anterior`);
              tenant._sessionApis.purgeSessionKeys().catch(() => {});
            }
            // Reset intentos de reconexión al switchear — el nuevo engine empieza fresco
            tenantReconnectAttempts.set(uid, 0);
          }

          // After 5 normal reconnects, try purging session keys
          if (attempts === 5 && tenant._sessionApis) {
            console.log(`[TM:${uid}] 🔧 5 reconnects — purging session keys as preventive measure`);
            tenant._sessionApis.purgeSessionKeys().catch(() => {});
          }

          // Guardar timer para poder cancelarlo si connection='open' llega antes
          tenant._reconnectTimer = setTimeout(() => {
            tenant._reconnectTimer = null;
            tenant._reconnecting = false; // Liberar lock
            // Si ya está conectado (open llegó antes del timer), no reconectar
            if (tenants.has(uid) && !tenant.isReady) {
              tenant._initializing = true;
              startBaileysConnection(uid, tenant, ioInstance);
            } else if (tenant.isReady) {
              console.log(`[TM:${uid}] ⏸️ Reconnect timer expiró pero ya estamos connected — ignorando`);
            }
          }, delay);
        } else {
          // Logged out desde el teléfono — sock muerto, limpiar TODO
          console.log(`[TM:${uid}] 🔌 Logged out desde teléfono — cleaning session`);
          tenant.isAuthenticated = false;
          tenant.sock = null;
          // Limpiar pending LIDs — teléfono desvinculado = reset
          if (tenant._pendingLids && Object.keys(tenant._pendingLids).length > 0) {
            console.log(`[TM:${uid}] 🧹 Limpiando ${Object.keys(tenant._pendingLids).length} LIDs pendientes por desvinculación`);
            tenant._pendingLids = {};
            admin.firestore().collection('users').doc(uid)
              .collection('miia_persistent').doc('pending_lids')
              .delete().catch(() => {});
          }
          if (tenant._lidReminderInterval) {
            clearInterval(tenant._lidReminderInterval);
            tenant._lidReminderInterval = null;
          }
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
      tenant._lastSocketActivity = Date.now(); // backward compat
      tenant._lastRealEvent = Date.now(); // Watchdog V2: mensaje REAL recibido = WhatsApp vivo
      for (const msg of messages) {
        const _m = msg.message || {};
        const b = _m.conversation || _m.extendedTextMessage?.text || _m.imageMessage?.caption || _m.videoMessage?.caption
          || _m.viewOnceMessage?.message?.imageMessage?.caption || _m.viewOnceMessage?.message?.videoMessage?.caption
          || _m.viewOnceMessageV2?.message?.imageMessage?.caption || _m.listResponseMessage?.title
          || _m.buttonsResponseMessage?.selectedDisplayText || _m.documentMessage?.caption
          || _m.documentWithCaptionMessage?.message?.documentMessage?.caption
          || _m.ephemeralMessage?.message?.conversation || _m.ephemeralMessage?.message?.extendedTextMessage?.text
          || '';
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
            return (now - ts) < 30; // B6 FIX: 90→30s para evitar re-procesamiento post-reconexión
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
        // Owners (con onMessage O isOwnerAccount) pueden procesar fromMe (self-chat).
        // Agents NO procesan fromMe — solo mensajes entrantes de terceros.
        const isOwner = !!tenant.onMessage || tenant.isOwnerAccount;
        if (!isOwner && isFromMe) continue;

        // ═══ BUG3b-FIX: Prevenir auto-respuesta — ignorar mensajes que MIIA envió ═══
        // Cuando MIIA envía al self-chat (briefing, recordatorio, etc.), Baileys lo ve
        // como fromMe=true y lo re-procesa → MIIA se responde a sí misma.
        // _sentMsgIds se puebla en sendTenantMessage() del TMH.
        if (isFromMe && msg.key.id && tenant._sentMsgIds?.has(msg.key.id)) {
          console.log(`[TM:${uid}] 🔄 BUCLE PREVENIDO: msg ${msg.key.id.substring(0, 12)}... es propio (enviado por MIIA) — ignorado`);
          continue;
        }

        // ═══ REACCIONES: detectar y pasar al handler ═══
        const reactionMsg = msg.message?.reactionMessage;
        if (reactionMsg) {
          const reactEmoji = reactionMsg.text; // '👍', '❤️', '😂', '' (empty = removed reaction)
          const reactToMsgId = reactionMsg.key?.id;
          if (reactEmoji && tenant.onMessage) {
            console.log(`[TM:${uid}] 🎭 Reaction: ${reactEmoji} from ${from} (fromMe=${isFromMe}) on msg ${reactToMsgId}`);
            tenant.onMessage({
              from: from,
              to: from,
              body: `[REACCIÓN: ${reactEmoji}]`,
              fromMe: isFromMe,
              type: 'reaction',
              id: msg.key,
              _baileysMsg: msg,
              _reaction: { emoji: reactEmoji, targetMsgId: reactToMsgId },
              hasMedia: false,
              timestamp: msg.messageTimestamp
            });
          }
          continue; // Las reacciones no se procesan como mensajes normales
        }

        // ═══ EXTRACCIÓN EXHAUSTIVA DE BODY ═══
        // WhatsApp tiene 15+ tipos de mensaje con texto en distintos campos.
        // Si no los cubrimos TODOS, MIIA ve body="" y descarta mensajes reales.
        const msgContent = msg.message || {};
        const body = msgContent.conversation
          || msgContent.extendedTextMessage?.text
          || msgContent.imageMessage?.caption
          || msgContent.videoMessage?.caption
          // Mensajes reenviados (viewOnce wraps el mensaje real)
          || msgContent.viewOnceMessage?.message?.imageMessage?.caption
          || msgContent.viewOnceMessage?.message?.videoMessage?.caption
          || msgContent.viewOnceMessageV2?.message?.imageMessage?.caption
          || msgContent.viewOnceMessageV2?.message?.videoMessage?.caption
          // Listas, botones, templates
          || msgContent.listResponseMessage?.title
          || msgContent.listResponseMessage?.singleSelectReply?.selectedRowId
          || msgContent.buttonsResponseMessage?.selectedDisplayText
          || msgContent.templateButtonReplyMessage?.selectedDisplayText
          // Document con caption
          || msgContent.documentMessage?.caption
          || msgContent.documentWithCaptionMessage?.message?.documentMessage?.caption
          // Contactos compartidos
          || (msgContent.contactMessage?.displayName ? `[Contacto compartido: ${msgContent.contactMessage.displayName}]` : '')
          // Location compartida
          || (msgContent.locationMessage ? `[Ubicación: ${msgContent.locationMessage.degreesLatitude},${msgContent.locationMessage.degreesLongitude}${msgContent.locationMessage.name ? ' — ' + msgContent.locationMessage.name : ''}]` : '')
          // Newsletter/Channel forwarded
          || msgContent.newsletterAdminInviteMessage?.caption
          // Ephemeral (mensajes temporales)
          || msgContent.ephemeralMessage?.message?.conversation
          || msgContent.ephemeralMessage?.message?.extendedTextMessage?.text
          || '';
        const hasMedia = !!(msg.message?.audioMessage || msg.message?.imageMessage
          || msg.message?.videoMessage || msg.message?.documentMessage
          || msg.message?.stickerMessage);

        // ═══ CONTEXT INFO: quoted replies + forwarded messages ═══
        const ctxInfo = msgContent.extendedTextMessage?.contextInfo
          || msgContent.imageMessage?.contextInfo
          || msgContent.videoMessage?.contextInfo
          || msgContent.audioMessage?.contextInfo
          || msgContent.documentMessage?.contextInfo
          || msgContent.viewOnceMessage?.message?.imageMessage?.contextInfo
          || msgContent.viewOnceMessage?.message?.videoMessage?.contextInfo
          || msgContent.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
          || null;
        const messageContext = { msgKey: msg.key };
        if (ctxInfo) {
          if (ctxInfo.quotedMessage) {
            const qm = ctxInfo.quotedMessage;
            const quotedText = qm.conversation
              || qm.extendedTextMessage?.text
              || qm.imageMessage?.caption
              || qm.videoMessage?.caption
              || qm.documentMessage?.caption
              || qm.documentWithCaptionMessage?.message?.documentMessage?.caption
              || qm.viewOnceMessage?.message?.imageMessage?.caption
              || qm.viewOnceMessage?.message?.videoMessage?.caption
              || qm.listResponseMessage?.title
              || qm.buttonsResponseMessage?.selectedDisplayText
              || (qm.contactMessage?.displayName ? `[Contacto: ${qm.contactMessage.displayName}]` : '')
              || (qm.locationMessage?.name || (qm.locationMessage ? '[Ubicación compartida]' : ''))
              || '[media]';
            messageContext.quotedText = quotedText;
            messageContext.quotedParticipant = ctxInfo.participant || null;
            console.log(`[TM:${uid}] 💬 Quoted reply detected: "${quotedText.substring(0, 60)}..."`);
          }
          if (ctxInfo.isForwarded) {
            messageContext.isForwarded = true;
            messageContext.forwardingScore = ctxInfo.forwardingScore || 1;
            console.log(`[TM:${uid}] ↪️ Forwarded message detected (score: ${messageContext.forwardingScore})`);
          }
        }
        // ═══ CRÍTICO: Verificar contenido ANTES de dedup ═══
        // WhatsApp envía el mismo msgId primero con body="" (notification/receipt)
        // y luego con el body real. Si registramos el vacío como "visto",
        // el mensaje real se descarta como duplicado y MIIA nunca lo procesa.
        if (!body.trim() && !hasMedia) {
          // Log para diagnóstico: qué hay en msg.message cuando body está vacío
          const msgKeys = msg.message ? Object.keys(msg.message) : ['(null)'];
          if (!msg.key.fromMe && msgKeys.length > 0 && msgKeys[0] !== '(null)') {
            console.log(`[TM:${uid}] ⚠️ Body vacío pero msg.message tiene keys: [${msgKeys.join(', ')}] from=${msg.key.remoteJid} msgId=${msg.key.id}`);
            // Si tiene senderKeyDistributionMessage es solo handshake, ignorar silenciosamente
            if (msgKeys.length === 1 && msgKeys[0] === 'senderKeyDistributionMessage') {
              continue;
            }
            // Si tiene protocolMessage o messageContextInfo es metadata, no mensaje real
            if (msgKeys.every(k => ['protocolMessage', 'messageContextInfo', 'senderKeyDistributionMessage'].includes(k))) {
              continue;
            }
            // Tiene keys reales pero body vacío = probable error de descifrado
            console.log(`[TM:${uid}] 🔴 Mensaje NO descifrado de ${msg.key.remoteJid} — keys: [${msgKeys.join(', ')}]. El contacto escribió algo pero no pudimos leerlo.`);

            // ═══ NOTIFICAR AL OWNER: 3+ mensajes vacíos del mismo contacto en 2 min ═══
            if (!tenant._emptyBodyTracker) tenant._emptyBodyTracker = {};
            const ebFrom = msg.key.remoteJid;
            if (!tenant._emptyBodyTracker[ebFrom]) tenant._emptyBodyTracker[ebFrom] = { count: 0, firstAt: Date.now(), notified: false };
            const ebTrack = tenant._emptyBodyTracker[ebFrom];
            ebTrack.count++;
            const ebElapsed = Date.now() - ebTrack.firstAt;
            if (ebTrack.count >= 3 && ebElapsed < 120000 && !ebTrack.notified) {
              ebTrack.notified = true;
              const selfJid = tenant.sock?.user?.id;
              if (tenant.sock && selfJid) {
                const contactId = ebFrom.split('@')[0];
                const pushName = msg.pushName || contactId;
                const alertText = `👱‍♀️: 📱 *${pushName}* intentó escribirte pero no pudimos leer su mensaje (${ebTrack.count} intentos).\n\nEsto pasa cuando WhatsApp está actualizando la seguridad del contacto. Escribile vos primero y después va a funcionar normal.`;
                tenant.sock.sendMessage(selfJid, { text: alertText }).catch(e =>
                  console.error(`[TM:${uid}] ❌ Error notificando body vacío al owner:`, e.message)
                );
                console.log(`[TM:${uid}] 📢 Owner notificado: ${pushName} no descifrado (${ebTrack.count}x en ${Math.round(ebElapsed / 1000)}s)`);
              }
            }
            // Limpiar tracker cada 5 min para no acumular memoria
            if (ebElapsed > 300000) {
              delete tenant._emptyBodyTracker[ebFrom];
            }
          }
          continue;
        }

        // ─── Deduplication: skip already-processed messages ───
        // DESPUÉS de verificar que tiene contenido real
        if (isDuplicate(msg.key.id, uid)) {
          _skipCounters.duplicate++;
          _flushSkipCounters(uid);
          continue;
        }

        // Detectar si es mensaje offline (anterior a la conexión)
        const msgTs = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp
          : (msg.messageTimestamp?.low || parseInt(msg.messageTimestamp) || 0);
        const isOffline = tenant.connectedAt && msgTs > 0 && msgTs < tenant.connectedAt - 5;

        // ═══ BUG2-FIX: Usar ownerPhone (persistente) como fuente primaria ═══
        // sock.user.id puede ser LID, null durante reconexión, o no estar poblado aún.
        // tenant.ownerPhone se guarda UNA VEZ al conectar y siempre es el número real.
        const myNumber = tenant.ownerPhone || tenant.sock?.user?.id?.split('@')[0]?.split(':')[0];
        const fromNumber = from?.split('@')[0]?.split(':')[0];

        // ═══ P6 FIX: Resolver LID→JID para detección correcta de self-chat ═══
        // Después de Bad MAC recovery, el remoteJid del self-chat puede llegar como
        // LID (ej: 136417472712832@lid) en vez de phone@s.whatsapp.net.
        // Sin resolución, isSelfChat=false y MIIA ignora al owner → se queda MUDA.
        let resolvedFrom = from;
        if (from?.includes('@lid')) {
          const lidBase = from.split('@')[0].split(':')[0];
          // Fuente 1: _lidMap (contactos de WhatsApp — más confiable)
          if (tenant._lidMap && tenant._lidMap[lidBase]) {
            resolvedFrom = tenant._lidMap[lidBase];
            console.log(`[TM:${uid}] 🔗 P6-LID: ${from} → ${resolvedFrom} (via _lidMap)`);
          }
          // Fuente 2: Comparar con ownerPhone guardado al conectar
          // Si el LID no se resolvió pero isFromMe=true, verificar si msg.key.remoteJid
          // podría ser el owner comparando con sock.user.lid (Baileys a veces lo expone)
          if (resolvedFrom === from && tenant.ownerPhone) {
            const userLid = tenant.sock?.user?.lid;
            if (userLid) {
              const userLidBase = userLid.split('@')[0].split(':')[0];
              if (userLidBase === lidBase) {
                resolvedFrom = `${tenant.ownerPhone}@s.whatsapp.net`;
                if (!tenant._lidMap) tenant._lidMap = {};
                tenant._lidMap[lidBase] = resolvedFrom;
                console.log(`[TM:${uid}] 🔗 P6-LID: Owner LID matched via sock.user.lid: ${lidBase} → ${resolvedFrom}`);
                // Persistir inmediatamente (owner LID es crítico)
                admin.firestore().collection('users').doc(uid)
                  .collection('miia_persistent').doc('lid_map')
                  .set({ mappings: tenant._lidMap, updatedAt: new Date().toISOString() }, { merge: true })
                  .catch(e => console.error(`[TM:${uid}] ⚠️ Error persistiendo owner LID:`, e.message));
              }
            }
          }
        }

          // ═══ @LID DESCONOCIDO: Flujo de identificación progresiva ═══
          // Si el LID no se resolvió Y no es fromMe → contacto desconocido con LID
          if (resolvedFrom === from && !isFromMe) {
            if (!tenant._pendingLids) tenant._pendingLids = {};
            const lidBase = from.split('@')[0].split(':')[0];
            const pushName = msg.pushName || '';
            const pending = tenant._pendingLids[lidBase];

            // ══════════════════════════════════════════════════════════════════
            // 🛡️ INTEGRITY GUARD: SINGLE-BUSINESS FAST-PATH
            // ══════════════════════════════════════════════════════════════════
            // Si el tenant tiene 0 o 1 negocio, NO necesita clasificación.
            // TODO desconocido es lead de ese único negocio → procesar DIRECTO.
            // Esto es CRÍTICO para MIIA CENTER (auto-venta) donde TODOS los
            // desconocidos son leads potenciales. Sin este guard, el LID-ID
            // intercepta y MATA el flujo de ventas.
            //
            // ⚠️ PROHIBIDO ELIMINAR ESTE BLOQUE — Si se remueve, MIIA CENTER
            // deja de responder a leads. Verificado en logs del 10-Abr-2026:
            // Lead 46510318301398 (Aleja) fue tragado por LID-ID sin respuesta.
            // ══════════════════════════════════════════════════════════════════
            if (!tenant._businesses) {
              try {
                const { loadBusinesses } = require('./tenant_message_handler');
                tenant._businesses = await loadBusinesses(tenant.ownerUid || uid);
              } catch (_) { tenant._businesses = []; }
            }
            const businessCount = (tenant._businesses || []).length;
            if (businessCount <= 1) {
              // ═══ FIX C-047 #1b: Verificar familia/equipo ANTES del fastpath ═══
              // Bug: LID-FASTPATH clasificó al papá de Mariano (5491131313325) como lead
              // porque nunca consultó familyContacts/teamContacts. Si el phone resuelto
              // del LID matchea un contacto conocido del owner, NO fastpath como lead.
              try {
                const { tenantContexts } = require('./tenant_message_handler');
                const ctxCheck = tenantContexts.get(uid);
                if (ctxCheck) {
                  // Check familyContacts
                  const _fuzzyCheck = (contacts, phone) => {
                    if (!contacts || !phone) return null;
                    if (contacts[phone]) return { key: phone, data: contacts[phone] };
                    const digits = phone.replace(/[^0-9]/g, '');
                    if (digits.length < 8) return null;
                    const suffix = digits.slice(-10);
                    for (const [key, data] of Object.entries(contacts)) {
                      const kd = key.replace(/[^0-9]/g, '');
                      if (kd.length >= 10 && kd.slice(-10) === suffix) return { key, data };
                    }
                    if (digits.startsWith('549') && digits.length >= 12) {
                      const w9 = '54' + digits.substring(3);
                      if (contacts[w9]) return { key: w9, data: contacts[w9] };
                    } else if (digits.startsWith('54') && !digits.startsWith('549') && digits.length >= 11) {
                      const wo9 = '549' + digits.substring(2);
                      if (contacts[wo9]) return { key: wo9, data: contacts[wo9] };
                    }
                    return null;
                  };
                  const resolvedPhone = resolvedFrom?.split('@')[0]?.split(':')[0] || lidBase;
                  const famMatch = _fuzzyCheck(ctxCheck.familyContacts, resolvedPhone) || _fuzzyCheck(ctxCheck.familyContacts, lidBase);
                  if (famMatch) {
                    console.log(`[TM:${uid}] 🛡️ FASTPATH-BLOCKED: ${lidBase} es FAMILIA (${famMatch.data.name || famMatch.key}). NO fastpath como lead.`);
                    // No fastpath — continuar al flujo normal de TMH donde classifyContact lo maneja
                  } else {
                    const teamMatch = _fuzzyCheck(ctxCheck.teamContacts, resolvedPhone) || _fuzzyCheck(ctxCheck.teamContacts, lidBase);
                    if (teamMatch) {
                      console.log(`[TM:${uid}] 🛡️ FASTPATH-BLOCKED: ${lidBase} es EQUIPO (${teamMatch.data.name || teamMatch.key}). NO fastpath como lead.`);
                      // No fastpath
                    } else {
                      // No es familia ni equipo — verificar contactGroups dinámicos
                      let isKnownGroup = false;
                      for (const [gid, group] of Object.entries(ctxCheck.contactGroups || {})) {
                        if (group.contacts) {
                          const gMatch = _fuzzyCheck(group.contacts, resolvedPhone) || _fuzzyCheck(group.contacts, lidBase);
                          if (gMatch) {
                            console.log(`[TM:${uid}] 🛡️ FASTPATH-BLOCKED: ${lidBase} está en grupo "${group.name}". NO fastpath como lead.`);
                            isKnownGroup = true;
                            break;
                          }
                        }
                      }
                      if (!isKnownGroup) {
              // ═══ FIX C-013 #1: Gates de seguridad ANTES del fastpath ═══
              // Post-incidente bot Coordinadora (2026-04-14): el fastpath
              // clasificaba TODO como lead sin validar. Ahora verificamos:
              //   Gate A: isPotentialBot → si true, NO fastpath
              //   Gate B: matchesBusinessKeywords → si NO matchea, NO fastpath
              // Si algún gate falla, el contacto cae al flujo normal de TMH
              // donde C-004 (bloqueo precautorio) sí puede actuar.
              // ⚠️ El fastpath en sí NO se modifica — solo agregamos gates.

              // Gate A: ¿Es un bot conocido?
              const { isPotentialBot } = require('../core/message_logic');
              if (isPotentialBot(body)) {
                console.warn(`[TM:${uid}] [FASTPATH-BYPASS] ${lidBase} — isPotentialBot=true. Mensaje: "${body.substring(0, 80)}". Enviando a flujo normal.`);
                // NO fastpath — continuar al flujo normal (pending_silent, TMH, etc.)
              } else {
                // Gate B: ¿El mensaje matchea keywords del negocio?
                let keywordsMatch = false;
                try {
                  const { matchesBusinessKeywords, getOwnerBusinessKeywords } = require('../core/contact_gate');
                  const { getOrCreateContext } = require('./tenant_message_handler');
                  const ownerUidGate = tenant.ownerUid || uid;
                  // Intentar obtener keywords del contexto TMH si existe
                  let keywords = [];
                  try {
                    const ctx = await getOrCreateContext(ownerUidGate);
                    keywords = getOwnerBusinessKeywords(ctx);
                  } catch (_) {
                    // Si no hay contexto TMH, intentar cargar keywords de businesses directamente
                    const biz = tenant._businesses?.[0];
                    if (biz && biz.contact_rules && biz.contact_rules.lead_keywords) {
                      keywords = biz.contact_rules.lead_keywords;
                    }
                  }
                  if (keywords.length === 0) {
                    // Sin keywords configuradas = no podemos validar → permitir fastpath
                    // (para no bloquear MIIA CENTER si no tiene keywords)
                    keywordsMatch = true;
                    console.log(`[TM:${uid}] [FASTPATH-GATE] Sin keywords configuradas — fastpath permitido por default`);
                  } else {
                    const result = matchesBusinessKeywords(body, keywords);
                    keywordsMatch = result.matched;
                    if (!keywordsMatch) {
                      console.warn(`[TM:${uid}] [FASTPATH-BYPASS] ${lidBase} — mensaje NO matchea ninguna keyword de negocio. Enviando a flujo normal. Mensaje: "${body.substring(0, 80)}"`);
                    } else {
                      console.log(`[TM:${uid}] [FASTPATH-GATE] ✅ Keyword match: "${result.keyword}"`);
                    }
                  }
                } catch (gateErr) {
                  // Error cargando keywords — permitir fastpath para no romper flujo
                  keywordsMatch = true;
                  console.warn(`[TM:${uid}] [FASTPATH-GATE] ⚠️ Error en gate B: ${gateErr.message} — fastpath permitido por safety`);
                }

                if (!keywordsMatch) {
                  // Gate B falló — NO fastpath, continuar al flujo normal
                  // (se manejará abajo como pending_silent o flujo normal de TMH)
                } else {
              // FAST-PATH: Un solo negocio → todo desconocido es lead, procesar YA
              const contactName = pushName || `Lead ${lidBase.substring(0, 6)}`;
              console.log(`[TM:${uid}] 🚀 LID-FASTPATH: ${lidBase} (${contactName}) → lead directo (${businessCount} negocio${businessCount === 1 ? '' : 's'}). Sin clasificación.`);

              // Registrar en contact_index como lead
              const ownerUidFast = tenant.ownerUid || uid;
              const bizId = tenant._businesses?.[0]?.id || null;
              const bizName = tenant._businesses?.[0]?.name || null;
              try {
                await admin.firestore().collection('users').doc(ownerUidFast)
                  .collection('contact_index').doc(lidBase)
                  .set({
                    name: contactName,
                    type: 'lead',
                    ...(bizId && { businessId: bizId }),
                    ...(bizName && { businessName: bizName }),
                    source: 'miia_fastpath',
                    updatedAt: new Date().toISOString()
                  }, { merge: true });
              } catch (e) {
                console.error(`[TM:${uid}] ⚠️ Error guardando lead fastpath:`, e.message);
              }

              // Setear tipo en TMH
              try {
                const { setContactType, setLeadName } = require('./tenant_message_handler');
                if (setContactType) setContactType(uid, lidBase, 'lead');
                if (setLeadName) setLeadName(uid, lidBase, contactName);
              } catch (_) {}

              // Mapear LID
              if (!tenant._lidMap) tenant._lidMap = {};
              tenant._lidMap[lidBase] = from;

              // Procesar el mensaje INMEDIATAMENTE como lead
              const { handleTenantMessage: handleMsgFast } = require('./tenant_message_handler');
              try {
                await handleMsgFast(uid, ownerUidFast, tenant.role || 'owner', from, body, false, false, tenant, messageContext || {});
              } catch (e) {
                console.error(`[TM:${uid}] ⚠️ Error procesando lead fastpath:`, e.message);
              }

              _addToDailySummary(uid, tenant, `Nuevo lead: *${contactName}* escribió: "${body.substring(0, 80)}${body.length > 80 ? '...' : ''}" — respondido automáticamente`);
              continue; // Procesado — siguiente mensaje
                } // cierre else keywordsMatch (Gate B pass)
              } // cierre else isPotentialBot (Gate A pass)
                      } // cierre if !isKnownGroup
                    } // cierre else teamMatch
                  } // cierre else famMatch
                }
              } catch (familyCheckErr) {
                console.warn(`[TM:${uid}] [FASTPATH-GATE] ⚠️ Error verificando familia/equipo: ${familyCheckErr.message} — fastpath permitido por safety`);
              }
            }

            // ═══ PENDING_SILENT: Contacto ya en Pendientes — bufferear + re-intentar clasificación ═══
            if (pending && (pending.phase === 'pending_silent' || pending.phase === 'waiting_owner' || pending.phase === 'waiting_contact' || pending.phase === 'waiting_owner_confirm')) {
              if (!pending.bufferedMsgs) pending.bufferedMsgs = [];
              pending.bufferedMsgs.push({ body, timestamp: Date.now() });
              console.log(`[TM:${uid}] 🔕 LID-ID: ${lidBase} — mensaje buffereado (pendiente silencioso). Total: ${pending.bufferedMsgs.length}`);

              // Re-intentar clasificación autónoma con el mensaje nuevo (más contexto = mejor clasificación)
              const allMessages = pending.bufferedMsgs.map(b => b.body).join('\n');
              const reClassification = await _tryAutonomousClassification(uid, tenant, lidBase, pending.pushName || pushName, allMessages);

              if (reClassification.classified) {
                console.log(`[TM:${uid}] 🧠 LID-ID: Auto-reclasificación exitosa con ${pending.bufferedMsgs.length} msgs: "${reClassification.name}" → ${reClassification.contactType}`);
                // Guardar en contact_index
                try {
                  await admin.firestore().collection('users').doc(tenant.ownerUid || uid)
                    .collection('contact_index').doc(lidBase)
                    .set({
                      name: reClassification.name || pending.pushName || pushName || 'Contacto',
                      type: reClassification.contactType || 'lead',
                      ...(reClassification.businessId && { businessId: reClassification.businessId }),
                      ...(reClassification.businessName && { businessName: reClassification.businessName }),
                      source: 'miia_reclass_auto',
                      updatedAt: new Date().toISOString()
                    }, { merge: true });
                } catch (e) {
                  console.error(`[TM:${uid}] ⚠️ Error guardando reclasificación:`, e.message);
                }

                // Resolver: procesar todos los mensajes buffereados
                _resolvePendingLid(uid, tenant, lidBase, from, reClassification.name || pending.pushName || pushName, null, {
                  contactType: reClassification.contactType,
                  businessId: reClassification.businessId,
                  businessName: reClassification.businessName
                }, { suppressNotification: true });

                // Eliminar de grupo Pendientes en Firestore
                _removeFromPendientesGroup(tenant.ownerUid || uid, lidBase).catch(() => {});

                _addToDailySummary(uid, tenant, `*${reClassification.name || pushName}* reclasificado automáticamente como ${reClassification.contactType}${reClassification.businessName ? ' de ' + reClassification.businessName : ''} tras ${pending.bufferedMsgs.length} mensajes`);
                continue;
              }

              // No pudo reclasificar — actualizar último mensaje en grupo Pendientes
              _updatePendientesLastMsg(tenant.ownerUid || uid, lidBase, body).catch(() => {});
              continue;
            }

            // PRIMERA VEZ que vemos este LID → CLASIFICACIÓN AUTÓNOMA
            console.log(`[TM:${uid}] 🔍 LID-ID: NUEVO contacto desconocido ${lidBase}${pushName ? ` (pushName: ${pushName})` : ''} — iniciando clasificación autónoma`);

            // ═══ AUTO-MATCH: ¿El pushName coincide con alguien en contact_index? ═══
            if (pushName) {
              try {
                const ownerUid = tenant.ownerUid || uid;
                const indexSnap = await admin.firestore().collection('users').doc(ownerUid)
                  .collection('contact_index').where('name', '==', pushName).limit(1).get();
                if (!indexSnap.empty) {
                  const existingDoc = indexSnap.docs[0];
                  const existingPhone = existingDoc.id;
                  const existingData = existingDoc.data();
                  console.log(`[TM:${uid}] 🔗 LID-ID: AUTO-MATCH por pushName "${pushName}" → ${existingPhone} (${existingData.type})`);
                  const knownJid = `${existingPhone}@s.whatsapp.net`;
                  if (!tenant._lidMap) tenant._lidMap = {};
                  tenant._lidMap[lidBase] = knownJid;
                  admin.firestore().collection('users').doc(uid)
                    .collection('miia_persistent').doc('lid_map')
                    .set({ mappings: tenant._lidMap, updatedAt: new Date().toISOString() }, { merge: true })
                    .catch(e => console.error(`[TM:${uid}] ⚠️ Error persistiendo auto-match LID:`, e.message));
                  // Procesar el mensaje normalmente con el JID resuelto — sin notificar al owner
                  resolvedFrom = knownJid;
                  const { handleTenantMessage } = require('./tenant_message_handler');
                  const ownerRole = tenant.role || 'owner';
                  try {
                    await handleTenantMessage(uid, ownerUid, ownerRole, knownJid, body, false, false, tenant, messageContext || {});
                  } catch (e) {
                    console.error(`[TM:${uid}] ⚠️ Error re-procesando auto-match:`, e.message);
                  }
                  // Agregar al resumen diario (silencioso)
                  _addToDailySummary(uid, tenant, `${pushName} escribió desde otro dispositivo — ya identificado como ${existingData.type === 'client' ? 'cliente' : existingData.type}${existingData.businessName ? ' de ' + existingData.businessName : ''}`);
                  continue;
                }
              } catch (e) {
                console.error(`[TM:${uid}] ⚠️ Error buscando auto-match en contact_index:`, e.message);
              }
            }

            // ═══ CLASIFICACIÓN AUTÓNOMA CON IA ═══
            // MIIA lee los mensajes, el pushName, e INTENTA clasificar sola.
            // Solo si NO puede → le pregunta al owner de forma NATURAL.
            if (!tenant._businesses) {
              try {
                const { loadBusinesses } = require('./tenant_message_handler');
                tenant._businesses = await loadBusinesses(tenant.ownerUid || uid);
              } catch (_) { tenant._businesses = []; }
            }

            // Intentar clasificar autónomamente
            const autoClassification = await _tryAutonomousClassification(uid, tenant, lidBase, pushName, body);

            if (autoClassification.classified) {
              // ═══ MIIA CLASIFICÓ SOLA — NO molestar al owner ═══
              console.log(`[TM:${uid}] 🧠 LID-ID: Clasificación autónoma exitosa: "${autoClassification.name}" → ${autoClassification.contactType}${autoClassification.businessName ? ' de ' + autoClassification.businessName : ''}`);

              // Guardar en contact_index
              const resolvedPhone = lidBase;
              try {
                await admin.firestore().collection('users').doc(tenant.ownerUid || uid)
                  .collection('contact_index').doc(resolvedPhone)
                  .set({
                    name: autoClassification.name || pushName || `Contacto desconocido`,
                    type: autoClassification.contactType || 'lead',
                    ...(autoClassification.businessId && { businessId: autoClassification.businessId }),
                    ...(autoClassification.businessName && { businessName: autoClassification.businessName }),
                    source: 'miia_autonomous',
                    updatedAt: new Date().toISOString()
                  }, { merge: true });
              } catch (e) {
                console.error(`[TM:${uid}] ⚠️ Error guardando clasificación autónoma:`, e.message);
              }

              // Setear tipo en TMH para que el mensaje se procese con prompt correcto
              try {
                const { setContactType, setLeadName } = require('./tenant_message_handler');
                if (setContactType) setContactType(uid, resolvedPhone, autoClassification.contactType || 'lead');
                if (setLeadName && autoClassification.name) setLeadName(uid, resolvedPhone, autoClassification.name);
              } catch (_) {}

              // Mapear LID para futuros mensajes
              if (!tenant._lidMap) tenant._lidMap = {};
              // No tenemos JID real, pero guardamos referencia para no volver a preguntar
              tenant._lidMap[lidBase] = from; // mapea al LID mismo — lo importante es que quede registrado

              // Procesar el mensaje con el prompt correcto INMEDIATAMENTE
              const { handleTenantMessage: handleMsg } = require('./tenant_message_handler');
              const ownerRole = tenant.role || 'owner';
              try {
                await handleMsg(uid, tenant.ownerUid || uid, ownerRole, from, body, false, false, tenant, messageContext || {});
              } catch (e) {
                console.error(`[TM:${uid}] ⚠️ Error procesando mensaje post-clasificación autónoma:`, e.message);
              }

              // Agregar al resumen diario (silencioso, no notificar)
              _addToDailySummary(uid, tenant, `Nuevo contacto: *${autoClassification.name || pushName || 'desconocido'}* — lo clasifiqué como ${autoClassification.contactType}${autoClassification.businessName ? ' de ' + autoClassification.businessName : ''}. Dijo: "${body.substring(0, 80)}${body.length > 80 ? '...' : ''}"`);

              continue; // Procesado — siguiente mensaje
            }

            // ═══ MIIA NO PUDO CLASIFICAR SOLA → SILENCIO + PENDIENTES ═══
            // NO preguntar al owner en self-chat. Guardar en grupo "Pendientes" del dashboard.
            tenant._pendingLids[lidBase] = {
              phase: 'pending_silent',
              firstMsg: body,
              pushName,
              originalFrom: from,
              startedAt: Date.now(),
              bufferedMsgs: [{ body, timestamp: Date.now() }]
            };
            _savePendingLids(uid, tenant);

            // Guardar en Firestore grupo "Pendientes" para que el dashboard lo muestre
            const ownerUidPend = tenant.ownerUid || uid;
            _saveToPendientesGroup(ownerUidPend, lidBase, pushName, body).catch(e =>
              console.error(`[TM:${uid}] ⚠️ Error guardando en grupo Pendientes:`, e.message)
            );

            // Agregar al resumen diario (silencioso — owner lo ve cuando quiera)
            const preview = body.length > 80 ? body.substring(0, 80) + '...' : body;
            _addToDailySummary(uid, tenant, `Contacto desconocido${pushName ? ` (${pushName})` : ''} escribió: "${preview}" — queda en Pendientes del dashboard`);
            console.log(`[TM:${uid}] 🔕 LID-ID: ${lidBase} → Pendientes (silencioso, sin notificar al owner en self-chat)`);

            continue; // No procesar hasta que se clasifique desde dashboard o auto-reclasifique
          }

        const resolvedFromNumber = resolvedFrom?.split('@')[0]?.split(':')[0];
        const isSelfChat = isFromMe && myNumber && (myNumber === fromNumber || myNumber === resolvedFromNumber);

        // ═══ BUG2-DIAG: Log cuando isFromMe pero isSelfChat=false (para debugging) ═══
        if (isFromMe && !isSelfChat) {
          console.log(`[TM:${uid}] 🔍 BUG2-DIAG: isFromMe=true pero isSelfChat=false → myNumber=${myNumber}, fromNumber=${fromNumber}, resolvedFromNumber=${resolvedFromNumber}, ownerPhone=${tenant.ownerPhone}, sock.user.id=${tenant.sock?.user?.id}`);
        }

        // Mensaje offline → acumular en buffer (self-chat, leads, todos)
        // Solo ignorar si es MUY viejo (>10 min) y es self-chat
        if (isOffline) {
          const ageSec = tenant.connectedAt - msgTs;
          if (isSelfChat && ageSec > 600) {
            _skipCounters.offlineOld++;
            _flushSkipCounters(uid);
            continue;
          }
        }

        if (isOffline) {
          const ageSec = tenant.connectedAt - msgTs;
          // ═══ ANTI-REPETICIÓN: Ignorar mensajes offline ya procesados ═══
          // Tras reconexión, WhatsApp re-entrega mensajes viejos. Si el msgTs
          // es anterior al último mensaje que ya procesamos, es una repetición.
          // Esto complementa el dedup en memoria (TTL 10min) para casos donde
          // la reconexión ocurre después de que el TTL expiró.
          if (tenant._lastProcessedTs && msgTs <= tenant._lastProcessedTs) {
            // NO descartar mensajes de terceros si son recientes (menos de 2 min antes de lastProcessed)
            // Esto previene perder mensajes reales que llegan desordenados post-reconexión
            const tsDiff = tenant._lastProcessedTs - msgTs;
            if (isFromMe || tsDiff > 120) {
              _skipCounters.offlineProcessed++;
              _flushSkipCounters(uid);
              continue;
            }
            console.log(`[TM:${uid}] ⚠️ Mensaje offline reciente de tercero (diff=${tsDiff}s <= 120s) — procesando igualmente: "${body.substring(0,30)}"`);
          }
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

        // Actualizar último timestamp procesado (anti-repetición post-reconexión)
        // SOLO actualizar con mensajes de terceros (no fromMe) para evitar que
        // mensajes propios de MIIA re-entregados post-reconexión eleven el timestamp
        // y causen que mensajes reales de contactos se descarten como "ya procesados"
        if (!isFromMe && msgTs > (tenant._lastProcessedTs || 0)) {
          tenant._lastProcessedTs = msgTs;
        }

        // Mensaje en tiempo real → procesar normalmente
        const lidTag = (resolvedFrom !== from) ? ` [LID→${resolvedFrom.split('@')[0]}]` : '';
        console.log(`[TM:${uid}] 📨 Message from ${from}${lidTag}${isSelfChat ? ' (self-chat)' : ''}: "${body.substring(0, 40)}"`);
        if (tenant.onMessage) {
          // Owner path: trackear mensajes de leads (no fromMe, no self-chat)
          const ownerMsgTrackId = msg.key.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          if (!isFromMe && !isSelfChat && body.trim()) {
            const ownerPendingData = {
              phone: from, body, timestamp: Date.now(), from, ownerUid: uid, role: 'owner', isOwnerPath: true
            };
            tenant._unrespondedMessages.set(ownerMsgTrackId, ownerPendingData);
            // Fire-and-forget write a Firestore — infalible
            admin.firestore().collection('users').doc(uid)
              .collection('pending_responses').doc(ownerMsgTrackId)
              .set(ownerPendingData)
              .catch(e => console.warn(`[TM:${uid}] ⚠️ Owner pending write error:`, e.message));
            // Owner messages: clear after 60s (handleIncomingMessage es fire-and-forget)
            setTimeout(() => {
              tenant._unrespondedMessages.delete(ownerMsgTrackId);
              admin.firestore().collection('users').doc(uid)
                .collection('pending_responses').doc(ownerMsgTrackId)
                .delete().catch(() => {});
            }, 60000);
          }
          try { tenant.onMessage(msg, from, body); } catch (e) { console.error(`[TM:${uid}] onMessage error:`, e.message); }
        } else {
          // ═══ P6 FIX + BUG2-FIX: Self-chat detection robusto ═══
          // Usar myNumber (ya incluye ownerPhone como fuente primaria)
          const realSelfChat = isFromMe && (
            from === `${myNumber}@s.whatsapp.net` ||
            from === tenant.sock?.user?.id ||
            resolvedFrom === `${myNumber}@s.whatsapp.net` ||
            (tenant.ownerPhone && fromNumber === tenant.ownerPhone)
          );
          const ownerUid = tenant.ownerUid || uid;
          const role = tenant.role || 'owner';
          // Pasar resolvedFrom (no from) para que conversations se keyen por phone, no LID
          const phoneForHandler = resolvedFrom || from;
          if (resolvedFrom !== from) {
            console.log(`[TM:${uid}] 🔗 P6: Passing resolved JID to handler: ${from} → ${phoneForHandler} (realSelfChat=${realSelfChat})`);
          }
          // ═══ P8.3: Transcripción de audio/media para tenants ═══
          let effectiveBody = body;
          if (!body.trim() && hasMedia) {
            try {
              const transcribed = await transcribeMediaForTenant(uid, msg, tenant);
              if (transcribed) {
                effectiveBody = transcribed;
                messageContext.isTranscribedAudio = true;
                console.log(`[TM:${uid}] 🎤 Media transcribed: "${transcribed.substring(0, 60)}..."`);
              } else {
                console.log(`[TM:${uid}] 🎤 Media could not be transcribed — skipping`);
                continue; // No text, no transcription → nothing to process
              }
            } catch (e) {
              console.error(`[TM:${uid}] 🎤 Transcription error: ${e.message}`);
              continue;
            }
          }

          // ═══ PENDING RECOVERY INFALIBLE: Trackear en memoria + Firestore ═══
          // Escribimos a Firestore INMEDIATAMENTE (fire-and-forget, no bloquea).
          // Si el proceso muere por CUALQUIER razón (SIGTERM, OOM, crash, kill -9),
          // al reconectar se reprocesa automáticamente. CERO mensajes perdidos.
          const msgTrackId = msg.key.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          if (!isFromMe && !realSelfChat && effectiveBody.trim()) {
            const pendingData = {
              phone: phoneForHandler,
              body: effectiveBody,
              timestamp: Date.now(),
              from: from,
              ownerUid,
              role
            };
            tenant._unrespondedMessages.set(msgTrackId, pendingData);
            // Fire-and-forget write a Firestore — NO await para no agregar latencia
            admin.firestore().collection('users').doc(uid)
              .collection('pending_responses').doc(msgTrackId)
              .set(pendingData)
              .catch(e => console.warn(`[TM:${uid}] ⚠️ Pending write error (non-blocking):`, e.message));
          }
          handleTenantMessage(uid, ownerUid, role, phoneForHandler, effectiveBody, realSelfChat, isFromMe, tenant, messageContext)
            .then(() => {
              // Respuesta exitosa → eliminar de memoria Y de Firestore
              tenant._unrespondedMessages.delete(msgTrackId);
              if (!isFromMe && !realSelfChat && effectiveBody.trim()) {
                admin.firestore().collection('users').doc(uid)
                  .collection('pending_responses').doc(msgTrackId)
                  .delete()
                  .catch(() => {}); // Best-effort delete
              }
            })
            .catch(e => {
              console.error(`[TM:${uid}] handleTenantMessage error:`, e.message);
              // NO eliminar — si falló, queremos reintentarlo al reconectar
            });
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
    // Store original onReady only ONCE to prevent nesting on reconnect
    if (!tenant._origOnReady && tenant.onReady) {
      tenant._origOnReady = tenant.onReady;
    }
    const _origOnReady = tenant._origOnReady;
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
          // ═══ FIX 3: Reset sync flag para re-minar con número nuevo ═══
          syncStateRef.set({ initialSyncDone: false, resetReason: 'number_change', resetAt: new Date().toISOString() }, { merge: true })
            .catch(e => console.warn(`[TM:${uid}] ⚠️ Error reseteando sync_state:`, e.message));
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

          // ═══ INDEXACIÓN PER-CONTACTO: guardar en contact_index ═══
          // Nombre: primer mensaje del contacto que sea corto, o pushName de allMsgs
          let contactName = '';
          for (const m of allMsgs) {
            if (m.pushName) { contactName = m.pushName; break; }
          }

          // Resumen: primeros 3 mensajes del contacto + último mensaje (para contexto)
          const contactMsgs = allMsgs.filter(m => !m.key?.fromMe).map(m =>
            m.message?.conversation || m.message?.extendedTextMessage?.text || ''
          ).filter(Boolean);
          const summaryParts = contactMsgs.slice(0, 3);
          if (contactMsgs.length > 3) summaryParts.push(contactMsgs[contactMsgs.length - 1]);
          const conversationSummary = summaryParts.join(' | ').substring(0, 300);

          // Guardar en contact_index con perfil enriquecido (async, no bloquea el loop)
          const ownerUid = tenant.ownerUid || uid;
          const lastContactMsg = contactMsgs[contactMsgs.length - 1] || '';
          const firstContactMsg = contactMsgs[0] || '';
          const lastMsgDate = allMsgs[allMsgs.length - 1]?.messageTimestamp
            ? new Date(allMsgs[allMsgs.length - 1].messageTimestamp * 1000).toISOString()
            : '';
          const firstMsgDate = allMsgs[0]?.messageTimestamp
            ? new Date(allMsgs[0].messageTimestamp * 1000).toISOString()
            : '';

          admin.firestore().collection('users').doc(ownerUid)
            .collection('contact_index').doc(phone)
            .set({
              name: contactName || '',
              type: classification === 'cliente' ? 'client' : 'lead',
              source: 'history_mining',
              conversationSummary,
              messageCount: allMsgs.length,
              contactMessageCount: contactMsgs.length,
              ownerMessageCount: allMsgs.filter(m => m.key?.fromMe).length,
              firstMessage: firstContactMsg.substring(0, 200),
              lastMessage: lastContactMsg.substring(0, 200),
              firstMessageDate: firstMsgDate,
              lastMessageDate: lastMsgDate,
              minedAt: new Date().toISOString()
            }, { merge: true })
            .catch(e => console.error(`[TM:${uid}] ⚠️ Error indexando contacto ${phone}:`, e.message));

          if (classification === 'lead') {
            adnAccumulatorLeads += `\n[LEAD ${phone}${contactName ? ' — ' + contactName : ''}]\n${chatLog}\n`;
            historyStats.leads++;
          } else {
            adnAccumulatorClients += `\n[CLIENTE ${phone}${contactName ? ' — ' + contactName : ''}]\n${chatLog}\n`;
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
              totalChars: adnBatch.length,
              phase: 'processing'
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

        // ═══ FIX 3: Marcar sync como completado para futuras reconexiones ═══
        syncStateRef.set({ initialSyncDone: true, completedAt: new Date().toISOString() }, { merge: true })
          .catch(e => console.warn(`[TM:${uid}] ⚠️ Error guardando sync_state:`, e.message));

        // Notificar al owner en self-chat
        const selfJid = tenant.sock?.user?.id;
        if (tenant.sock && selfJid) {
          tenant.sock.sendMessage(selfJid, {
            text: `👱‍♀️: 🧬 *Análisis de historial completo*\n\n✅ Conocí ${historyStats.leads} leads y ${historyStats.clients} clientes de tu historial.\n${historyStats.skipped} conversaciones sin relevancia fueron omitidas.\n\nYa sé quiénes son tus contactos y cómo te comunicas con ellos. Cuando escriban, sabré cómo tratarlos.`
          }).catch(() => {});
        }

        if (ioInstance) {
          ioInstance.to(`tenant:${uid}`).emit('adn_mining_complete', {
            ...historyStats,
            phase: 'complete'
          });
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
    // ═══ LID MAP: Capturar TODOS los mapeos LID→JID de contactos ═══
    // WhatsApp envía mensajes con LID en vez de JID real. Sin este mapa,
    // familia y contactos conocidos se pierden (bug Alejandra sesión 14).
    // FIX Sesión 35: Persistir en Firestore para sobrevivir restarts.
    if (!tenant._lidMap) tenant._lidMap = {};

    // Cargar _lidMap guardado previamente en Firestore
    try {
      const lidDoc = await admin.firestore().collection('users').doc(uid)
        .collection('miia_persistent').doc('lid_map').get();
      if (lidDoc.exists) {
        const saved = lidDoc.data()?.mappings || {};
        Object.assign(tenant._lidMap, saved);
        console.log(`[TM:${uid}] 📇 LID-MAP cargado de Firestore: ${Object.keys(saved).length} mappings`);
      }
    } catch (e) {
      console.error(`[TM:${uid}] ⚠️ Error cargando lid_map de Firestore:`, e.message);
    }

    // ═══ PERSISTENCIA DE LIDs PENDIENTES ═══
    // Restaurar LIDs pendientes de Firestore (sobrevive caídas/restarts)
    try {
      const pendingDoc = await admin.firestore().collection('users').doc(uid)
        .collection('miia_persistent').doc('pending_lids').get();
      if (pendingDoc.exists) {
        const saved = pendingDoc.data()?.lids || {};
        let restored = 0;
        let expired = 0;
        if (!tenant._pendingLids) tenant._pendingLids = {};
        const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días máximo
        for (const [lidBase, data] of Object.entries(saved)) {
          // Auto-limpiar pendientes viejos (>7 días) — evita spam infinito
          const age = Date.now() - (data.startedAt || 0);
          if (age > MAX_PENDING_AGE_MS) {
            expired++;
            console.log(`[TM:${uid}] 🧹 LID pendiente expirado (${Math.floor(age / (24*60*60*1000))}d): ${data.pushName || lidBase}`);
            continue; // No restaurar
          }
          tenant._pendingLids[lidBase] = data;
          restored++;
        }
        if (restored > 0) console.log(`[TM:${uid}] 📇 LIDs pendientes restaurados: ${restored} (persisten hasta resolución, max 7d)`);
        if (expired > 0) {
          console.log(`[TM:${uid}] 🧹 ${expired} LIDs pendientes expirados (>7 días) — limpiados`);
          _savePendingLids(uid, tenant); // Persistir la limpieza
        }
      }
    } catch (e) {
      console.error(`[TM:${uid}] ⚠️ Error restaurando pending_lids:`, e.message);
    }

    // CONTACTOS PENDIENTES: NO enviar recordatorios por self-chat (causa spam/caos)
    // Los pendientes se reportan en el RESUMEN DIARIO del owner (ticket system)
    // Limpiar interval anterior si existe de versión vieja
    if (tenant._lidReminderInterval) {
      clearInterval(tenant._lidReminderInterval);
      tenant._lidReminderInterval = null;
      console.log(`[TM:${uid}] 🧹 Limpiado interval de recordatorios pendientes (migrado a ticket system en resúmenes)`);
    }

    // Debounce para guardar _lidMap en Firestore (no en cada contacto, sino max 1 vez cada 60s)
    let _lidMapDirty = false;
    const _saveLidMapDebounced = () => {
      if (_lidMapDirty) return; // ya hay un save pendiente
      _lidMapDirty = true;
      setTimeout(async () => {
        _lidMapDirty = false;
        try {
          await admin.firestore().collection('users').doc(uid)
            .collection('miia_persistent').doc('lid_map')
            .set({ mappings: tenant._lidMap, updatedAt: new Date().toISOString() }, { merge: true });
          console.log(`[TM:${uid}] 💾 LID-MAP persistido en Firestore: ${Object.keys(tenant._lidMap).length} mappings`);
        } catch (e) {
          console.error(`[TM:${uid}] ⚠️ Error guardando lid_map:`, e.message);
        }
      }, 60000); // 60 segundos debounce
    };

    // ═══ FIX 2: Throttle contacts sync log — resumen cada 30s en vez de cada evento ═══
    let _contactSyncAccum = 0;
    let _contactSyncTimer = null;

    sock.ev.on('contacts.upsert', (contacts) => {
      if (tenant.onContacts) {
        try { tenant.onContacts(contacts); } catch (e) {
          console.error(`[TM:${uid}] onContacts error:`, e.message);
        }
      }
      let lidCount = 0;
      for (const c of contacts) {
        if (c.id && c.lid) {
          const lidBase = c.lid.split(':')[0].split('@')[0];
          tenant._lidMap[lidBase] = c.id;
          lidCount++;
        }
      }
      if (lidCount > 0) {
        _contactSyncAccum += lidCount;
        if (!_contactSyncTimer) {
          _contactSyncTimer = setTimeout(() => {
            console.log(`[TM:${uid}] 📇 Contacts sync: ${_contactSyncAccum} LID→JID mappings (total: ${Object.keys(tenant._lidMap).length})`);
            _contactSyncAccum = 0;
            _contactSyncTimer = null;
          }, 30000);
        }
        _saveLidMapDebounced();
      }
    });
    sock.ev.on('contacts.update', (contacts) => {
      if (tenant.onContacts) {
        try { tenant.onContacts(contacts); } catch (e) {
          console.error(`[TM:${uid}] onContacts update error:`, e.message);
        }
      }
      let newMappings = false;
      for (const c of contacts) {
        if (c.id && c.lid) {
          const lidBase = c.lid.split(':')[0].split('@')[0];
          tenant._lidMap[lidBase] = c.id;
          newMappings = true;
        }
      }
      if (newMappings) _saveLidMapDebounced();
    });
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
          const farewellMsg = `👱‍♀️: ${userName}, me voy a dormir! 😴🔌\nTu WhatsApp se desvinculó, necesitás reconectar.`;
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

// ─── Force Reconnect (usado por Watchdog V2) ───────────────────────────────

function forceReconnect(uid, tenant, ioInstance, reason) {
  if (tenant._reconnecting) {
    console.log(`[TM:${uid}] ⏸️ forceReconnect(${reason}): ya hay reconexión en curso — ignorando`);
    return;
  }
  console.warn(`[TM:${uid}] 🔄 FORCE-RECONNECT (reason: ${reason}). Matando socket y reconectando...`);
  tenant._reconnecting = true;
  tenant._probeFailCount = 0;
  try { if (tenant.sock) tenant.sock.end(undefined); } catch (_) {}
  tenant.sock = null;
  tenant.isReady = false;
  tenant._initializing = true;
  // Notificar al dashboard que se perdió conexión temporalmente
  if (ioInstance) {
    ioInstance.to(`tenant:${uid}`).emit('whatsapp_reconnecting', { uid, reason });
  }
  setTimeout(() => {
    tenant._reconnecting = false;
    startBaileysConnection(uid, tenant, ioInstance);
  }, 5000);
}

// ─── Force Reconnect by UID (wrapper público) ──────────────────────────────
// Usado por safeSendMessage cuando detecta ghost disconnect
function forceReconnectByUid(uid, reason) {
  const tenant = tenants.get(uid);
  if (!tenant) {
    console.warn(`[TM:${uid}] forceReconnectByUid: tenant no encontrado`);
    return;
  }
  forceReconnect(uid, tenant, tenant.io || null, reason || 'external_recovery');
}

// ─── Verify Connection (Health Check Real) ──────────────────────────────────
// Intenta un roundtrip real a WhatsApp. Devuelve { alive, latencyMs, error }.
// Usado por GET /api/status?verify=true para que el dashboard NO mienta.

async function verifyConnection(uid) {
  const t = tenants.get(uid);
  if (!t || !t.isReady || !t.sock) {
    return { alive: false, error: 'not_connected', latencyMs: null };
  }
  const start = Date.now();
  try {
    await Promise.race([
      t.sock.sendPresenceUpdate('available'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('verify timeout 10s')), 10000))
    ]);
    const latencyMs = Date.now() - start;
    t._lastRealEvent = Date.now(); // Probe exitoso = actividad real confirmada
    t._probeFailCount = 0;
    console.log(`[TM:${uid}] ✅ VERIFY: WhatsApp alive (${latencyMs}ms)`);
    return { alive: true, latencyMs, error: null };
  } catch (e) {
    const latencyMs = Date.now() - start;
    console.warn(`[TM:${uid}] ❌ VERIFY: WhatsApp NOT alive (${latencyMs}ms): ${e.message}`);
    return { alive: false, latencyMs, error: e.message };
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
    conversationCount: Object.keys(t.conversations).length,
    lastRealEvent: t._lastRealEvent || 0,
    probeFailCount: t._probeFailCount || 0
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
  // PRIORIDAD 1: TMH context (tiene conversations restauradas de Firestore — sobrevive deploys)
  try {
    const tmh = require('./tenant_message_handler');
    const ctx = tmh.tenantContexts.get(uid);
    if (ctx && ctx.conversations && Object.keys(ctx.conversations).length > 0) {
      return Object.entries(ctx.conversations).map(([phone, msgs]) => {
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        return {
          phoneNumber: phone.split('@')[0],
          name: (ctx.leadNames && ctx.leadNames[phone]) || phone.split('@')[0],
          lastMessage: lastMsg?.content || '',
          timestamp: lastMsg?.timestamp || null,
          unreadCount: 0
        };
      });
    }
  } catch (_) { /* TMH no disponible — fallback a TM */ }

  // PRIORIDAD 2: Tenant manager (conversations en memoria de Baileys)
  const t = tenants.get(uid);
  if (!t) return [];

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
    // Limpiar todos los intervals
    if (tenant._watchdog) clearInterval(tenant._watchdog);
    if (tenant._heartbeat) clearInterval(tenant._heartbeat);
    if (tenant._preemptiveRefresh) clearInterval(tenant._preemptiveRefresh);
    if (tenant._engineHealthTimer) clearInterval(tenant._engineHealthTimer);
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

/**
 * Resolver LID a JID real usando el mapa de contactos de WhatsApp.
 * @param {string} uid - Tenant UID
 * @param {string} lid - LID completo (ej: 46510318301398@lid) o solo base numérica
 * @returns {string|null} JID real (ej: 573137501884@s.whatsapp.net) o null si no hay mapeo
 */
function resolveLidFromContacts(uid, lid) {
  const tenant = tenants.get(uid);
  if (!tenant || !tenant._lidMap) return null;
  const lidBase = lid.split(':')[0].split('@')[0];
  return tenant._lidMap[lidBase] || null;
}

/**
 * Obtener todos los tenants conectados (para broadcast)
 * @returns {Array<{uid, sock, ownerUid, role}>}
 */
function getConnectedTenants() {
  const result = [];
  for (const [uid, tenant] of tenants) {
    if (tenant.isReady && tenant.sock) {
      result.push({ uid, sock: tenant.sock, ownerUid: tenant.ownerUid || uid, role: tenant.role || 'owner' });
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// P8.3: TRANSCRIPCIÓN DE MEDIA PARA TENANTS
// Descarga audio/imagen/video via Baileys y transcribe con Gemini Flash (GRATIS).
// ═══════════════════════════════════════════════════════════════════════════
const MEDIA_TIMEOUT_MS = 30_000;
const MEDIA_MAX_SIZE_B64 = 20_000_000; // ~15MB decoded

/**
 * Transcribe media (audio, image, video) for a tenant message.
 * @param {string} uid - Tenant UID
 * @param {Object} baileysMsg - Raw Baileys message
 * @param {Object} tenant - Tenant object (for ownerConfig)
 * @returns {Promise<string|null>} Transcribed text or null
 */
async function transcribeMediaForTenant(uid, baileysMsg, tenant) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  const aiGateway = require('../ai/ai_gateway');

  const msgContent = baileysMsg.message || {};
  const mimetype = msgContent.audioMessage?.mimetype
    || msgContent.imageMessage?.mimetype
    || msgContent.videoMessage?.mimetype
    || msgContent.documentMessage?.mimetype
    || msgContent.stickerMessage?.mimetype
    || null;

  if (!mimetype) return null;

  // Stickers → skip
  if (mimetype.includes('webp') || msgContent.stickerMessage) return null;

  // Download with timeout
  const buffer = await Promise.race([
    downloadMediaMessage(baileysMsg, 'buffer', {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timeout')), MEDIA_TIMEOUT_MS))
  ]);

  if (!buffer || buffer.length < 100) return null;

  const b64 = buffer.toString('base64');
  if (b64.length > MEDIA_MAX_SIZE_B64) {
    console.log(`[TM:${uid}] 🎤 Media too large: ${(b64.length / 1_000_000).toFixed(1)}MB — skipping`);
    return null;
  }

  // Build transcription prompt based on media type
  let transcriptionPrompt;
  if (mimetype.startsWith('audio/') || mimetype === 'audio/ogg; codecs=opus') {
    transcriptionPrompt = 'Transcribí textualmente este audio al español. Solo devolvé la transcripción exacta, sin agregar nada más.';
  } else if (mimetype.startsWith('image/')) {
    transcriptionPrompt = 'Describí esta imagen de forma concisa en español. ¿Qué se ve? Si hay texto, transcribilo.';
  } else if (mimetype.startsWith('video/')) {
    transcriptionPrompt = 'Describí este video brevemente en español. ¿Qué se ve y qué se escucha?';
  } else {
    return null; // Unsupported media type
  }

  // Get owner AI config for key routing
  const ownerConfig = {};
  if (tenant.ownerUid) {
    try {
      const userDoc = await admin.firestore().collection('users').doc(tenant.ownerUid).get();
      if (userDoc.exists) {
        const d = userDoc.data();
        if (d.aiProvider) ownerConfig.aiProvider = d.aiProvider;
        if (d.aiApiKey) ownerConfig.aiApiKey = d.aiApiKey;
        if (d.aiTier) ownerConfig.aiTier = d.aiTier;
      }
    } catch (_) { /* use defaults */ }
  }

  // Call Gemini Flash directly with multimodal content (inlineData)
  const { keyPool } = require('../ai/ai_client');
  const aiGW = require('../ai/ai_gateway');
  let apiKey = aiGW.getApiKey('gemini', ownerConfig);
  if (!apiKey && keyPool.hasKeys('gemini')) {
    apiKey = keyPool.getKey('gemini');
  }
  if (!apiKey) {
    console.error(`[TM:${uid}] 🎤 No Gemini API key available for transcription`);
    return null;
  }

  const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const url = `${GEMINI_FLASH_URL}?key=${apiKey}`;
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: transcriptionPrompt },
        { inlineData: { mimeType: mimetype, data: b64 } }
      ]
    }]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`[TM:${uid}] 🎤 Gemini transcription error ${response.status}: ${errText.substring(0, 200)}`);
    return null;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || text.length < 3) return null;
  return text.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// @LID DESCONOCIDO: Funciones de identificación progresiva
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolver un LID pendiente: mapear permanentemente y procesar mensajes buffereados.
 * Si el owner proporcionó clasificación (tipo + negocio), se guarda en contact_index
 * para que los mensajes buffereados se procesen con el prompt correcto.
 *
 * @param {string} uid - UID del tenant
 * @param {Object} tenant - Referencia al tenant
 * @param {string} lidBase - Base numérica del LID
 * @param {string} originalFrom - JID original del LID (xxx@lid)
 * @param {string} contactName - Nombre identificado
 * @param {string|null} phoneNumber - Número de teléfono (si se proporcionó)
 * @param {Object} [classification] - { contactType, businessId, businessName, hasAdditionalContext, additionalContext } del owner
 * @param {Object} [opts] - { suppressAutoReply: bool } si true, NO procesar buffereados (owner dijo "no respondas")
 */
// ═══════════════════════════════════════════════════════════════════════════
// CLASIFICACIÓN AUTÓNOMA — MIIA intenta entender quién es ANTES de preguntar
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MIIA lee el mensaje, el pushName, y el contexto del owner para intentar
 * clasificar al contacto desconocido SIN molestar al owner.
 * Usa IA (Gemini) para interpretar con sentido común.
 *
 * @returns {{ classified: boolean, name?, contactType?, businessId?, businessName?, reason? }}
 */
async function _tryAutonomousClassification(uid, tenant, lidBase, pushName, messageBody) {
  const businesses = tenant._businesses || [];
  const result = { classified: false, reason: '' };

  // ── CASO 1: pushName + 1 solo negocio → asumir lead con sentido común ──
  if (pushName && businesses.length === 1) {
    // Si el mensaje parece de un cliente/lead (pregunta por servicio, precio, horarios, etc.)
    const businessKeywords = /\b(?:precio|costo|cuanto|cotiz|servicio|turno|cita|horario|agenda|reserv|consult|atien|disponib|trabaj|abierto|cerrado|ubica|direcc|info|inform)\b/i;
    if (businessKeywords.test(messageBody)) {
      result.classified = true;
      result.name = pushName;
      result.contactType = 'lead';
      result.businessId = businesses[0].id;
      result.businessName = businesses[0].name;
      result.reason = `Mensaje parece consulta de negocio + pushName disponible + 1 solo negocio`;
      return result;
    }
  }

  // ── CASO 2: pushName + 0 negocios → contacto personal ──
  if (pushName && businesses.length === 0) {
    result.classified = true;
    result.name = pushName;
    result.contactType = 'group';
    result.reason = 'pushName disponible + owner sin negocios → contacto personal';
    return result;
  }

  // ── CASO 3: Usar IA para interpretar el mensaje ──
  // Solo si tenemos suficiente contexto (mensaje > 10 chars o pushName)
  if ((messageBody.length > 10 || pushName) && businesses.length > 0) {
    try {
      const bizList = businesses.map(b => `- ${b.name}: ${b.description || b.ownerRole || 'sin descripción'}`).join('\n');
      const prompt = `Eres MIIA, asistente inteligente de WhatsApp. Un contacto desconocido escribió:

Nombre WhatsApp: "${pushName || 'sin nombre'}"
Mensaje: "${messageBody.substring(0, 300)}"

El owner tiene estos negocios:
${bizList}

Basándote en el mensaje y el nombre, ¿podés deducir quién es este contacto?
Respondé SOLO con un JSON (sin markdown, sin explicación):
{
  "canClassify": true/false,
  "name": "nombre del contacto" o null,
  "type": "lead" | "client" | "personal",
  "businessMatch": "nombre exacto del negocio" o null,
  "confidence": "high" | "medium" | "low",
  "reason": "explicación breve"
}

Reglas:
- Si el mensaje es un saludo genérico ("hola", "buenos días") SIN contexto de negocio → canClassify: false
- Si el mensaje menciona servicios/productos/precios → probablemente lead
- Si menciona seguimiento, factura, contrato → probablemente client
- Si es conversación casual/personal → type: "personal"
- Si hay solo 1 negocio y parece consulta → asumí lead de ese negocio
- confidence "high" solo si estás muy seguro. "low" = mejor preguntar al owner
- Solo canClassify: true si confidence es "high" o "medium"`;

      const aiResponse = await callAIForTenant(uid, prompt);
      if (aiResponse) {
        // Parsear JSON de la respuesta
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.canClassify && (parsed.confidence === 'high' || parsed.confidence === 'medium')) {
            result.classified = true;
            result.name = parsed.name || pushName || null;
            result.contactType = parsed.type === 'client' ? 'client' : parsed.type === 'personal' ? 'group' : 'lead';
            result.reason = parsed.reason || 'IA clasificó autónomamente';

            // Match business por nombre
            if (parsed.businessMatch) {
              const biz = businesses.find(b => b.name && b.name.toLowerCase().includes(parsed.businessMatch.toLowerCase()));
              if (biz) {
                result.businessId = biz.id;
                result.businessName = biz.name;
              }
            }
            // Si es lead/client y no matcheó negocio pero hay 1 solo → asignar
            if ((result.contactType === 'lead' || result.contactType === 'client') && !result.businessId && businesses.length === 1) {
              result.businessId = businesses[0].id;
              result.businessName = businesses[0].name;
            }

            console.log(`[TM:${uid}] 🧠 LID-ID: IA clasificó "${result.name}" como ${result.contactType} (confianza: ${parsed.confidence}) — ${result.reason}`);
            return result;
          } else {
            result.reason = parsed.reason || 'IA no pudo clasificar con suficiente confianza';
          }
        }
      }
    } catch (e) {
      console.error(`[TM:${uid}] ⚠️ Error en clasificación autónoma con IA:`, e.message);
      result.reason = 'Error en IA, no pudo clasificar';
    }
  }

  // ── CASO 4: pushName solo + múltiples negocios → no es suficiente para clasificar ──
  if (pushName && !result.classified) {
    result.reason = result.reason || 'Información insuficiente para clasificar autónomamente';
  }

  return result;
}

/**
 * Construye un mensaje NATURAL para preguntarle al owner quién es un contacto.
 * MIIA habla con su personalidad — NUNCA como formulario ni comando.
 * NUNCA muestra LID.
 */
function _buildNaturalLidQuestion(pushName, preview, nameHint, aiReason, businesses) {
  // MIIA habla natural, curiosa pero organizada
  let msg = '';

  if (pushName) {
    msg = `Che, me escribió alguien que no tengo registrado${nameHint}. `;
    msg += `Me dijo: _"${preview}"_\n\n`;
    msg += `¿Lo conocés? ¿Quién es?`;
  } else {
    msg = `Me escribió alguien que no tengo registrado y no tiene nombre en WhatsApp. `;
    msg += `Me dijo: _"${preview}"_\n\n`;
    msg += `¿Sabés quién puede ser?`;
  }

  // Si hay negocios, dar hint sutil
  if (businesses.length > 0) {
    const bizNames = businesses.map(b => b.name).join(', ');
    msg += `\n\n_Decime el nombre y si es de ${businesses.length === 1 ? bizNames : 'algún negocio'} o contacto personal, así lo atiendo bien_ 😊`;
  }

  return msg;
}

/**
 * Agrega una entrada al resumen diario del tenant.
 * El resumen se envía al owner al final del día o cuando lo pida.
 * NO notifica inmediatamente — es silencioso.
 */
function _addToDailySummary(uid, tenant, entry) {
  if (!tenant._dailySummary) tenant._dailySummary = [];
  tenant._dailySummary.push({
    text: entry,
    timestamp: new Date().toISOString()
  });
  // Persistir en Firestore (async, no bloquea)
  const todayStr = new Date().toISOString().split('T')[0];
  admin.firestore().collection('users').doc(uid)
    .collection('miia_persistent').doc('daily_summary')
    .set({
      date: todayStr,
      entries: tenant._dailySummary,
      updatedAt: new Date().toISOString()
    }, { merge: true })
    .catch(e => console.error(`[TM:${uid}] ⚠️ Error persistiendo resumen diario:`, e.message));
  console.log(`[TM:${uid}] 📋 Resumen diario: +1 entrada (total: ${tenant._dailySummary.length})`);
}

// ═══ GRUPO PENDIENTES — Helpers para Firestore ═══

/** Blacklist de nombres fantasma — NUNCA crear contacto con estos nombres */
const PHANTOM_NAME_BLACKLIST = new Set([
  'quien', 'quién', 'que', 'qué', 'como', 'cómo', 'donde', 'dónde', 'cuando', 'cuándo',
  'miia', 'listo', 'ok', 'si', 'sí', 'no', 'hola', 'chau', 'buenas', 'gracias',
  'contacto', 'desconocido', 'unknown', 'undefined', 'null', 'test', 'prueba'
]);

function _isPhantomName(name) {
  if (!name) return true;
  const clean = name.trim().toLowerCase();
  if (clean.length < 2) return true;
  if (PHANTOM_NAME_BLACKLIST.has(clean)) return true;
  if (/^[0-9@:]+$/.test(clean)) return true; // Solo números/símbolos
  return false;
}

/**
 * Guardar contacto desconocido en grupo "Pendientes" del dashboard.
 * Auto-crea el grupo si no existe.
 */
async function _saveToPendientesGroup(ownerUid, lidBase, pushName, firstMsg) {
  const groupRef = admin.firestore().collection('users').doc(ownerUid)
    .collection('contact_groups').doc('pendientes');

  // Auto-crear grupo si no existe
  const groupDoc = await groupRef.get();
  if (!groupDoc.exists) {
    await groupRef.set({
      name: 'Pendientes',
      icon: '📋',
      tone: '',
      autoRespond: false,
      proactiveEnabled: false,
      systemGroup: true,
      createdAt: new Date().toISOString()
    });
    console.log(`[TM:${ownerUid}] 📋 Grupo "Pendientes" creado automáticamente`);
  }

  // Guardar contacto dentro del grupo
  const displayName = (!_isPhantomName(pushName)) ? pushName : `Contacto ${lidBase.substring(0, 6)}`;
  await groupRef.collection('contacts').doc(lidBase).set({
    name: displayName,
    pushName: pushName || null,
    lidBase,
    firstMsg: (firstMsg || '').substring(0, 200),
    lastMsg: (firstMsg || '').substring(0, 200),
    messageCount: 1,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'pending'
  }, { merge: true });

  console.log(`[TM:${ownerUid}] 📋 Contacto ${lidBase} (${displayName}) agregado a grupo Pendientes`);
}

/** Actualizar último mensaje de un contacto en Pendientes */
async function _updatePendientesLastMsg(ownerUid, lidBase, lastMsg) {
  await admin.firestore().collection('users').doc(ownerUid)
    .collection('contact_groups').doc('pendientes')
    .collection('contacts').doc(lidBase)
    .update({
      lastMsg: (lastMsg || '').substring(0, 200),
      messageCount: admin.firestore.FieldValue.increment(1),
      updatedAt: new Date().toISOString()
    });
}

/** Eliminar contacto de Pendientes (cuando se reclasifica) */
async function _removeFromPendientesGroup(ownerUid, lidBase) {
  await admin.firestore().collection('users').doc(ownerUid)
    .collection('contact_groups').doc('pendientes')
    .collection('contacts').doc(lidBase)
    .delete();
  console.log(`[TM:${ownerUid}] 📋 Contacto ${lidBase} removido de Pendientes (reclasificado)`);
}

/**
 * Persistir LIDs pendientes en Firestore (sobrevive caídas/restarts del servidor).
 * Persiste TODOS los LIDs pendientes (sin filtro de día). Se llama cada vez que _pendingLids cambia.
 */
function _savePendingLids(uid, tenant) {
  if (!tenant._pendingLids) return;
  // Persistir TODOS los LIDs pendientes — persisten entre días hasta que el owner resuelva o el teléfono se desvincule
  const allLids = {};
  for (const [lid, data] of Object.entries(tenant._pendingLids)) {
    allLids[lid] = {
      phase: data.phase,
      firstMsg: data.firstMsg,
      pushName: data.pushName,
      originalFrom: data.originalFrom,
      startedAt: data.startedAt,
      contactSaidName: data.contactSaidName || null,
      bufferedCount: data.bufferedMsgs?.length || 0
    };
  }
  admin.firestore().collection('users').doc(uid)
    .collection('miia_persistent').doc('pending_lids')
    .set({ lids: allLids, updatedAt: new Date().toISOString() }, { merge: false })
    .catch(e => console.error(`[TM:${uid}] ⚠️ Error persistiendo pending_lids:`, e.message));
}

async function _resolvePendingLid(uid, tenant, lidBase, originalFrom, contactName, phoneNumber, classification = {}, opts = {}) {
  const pending = tenant._pendingLids?.[lidBase];
  if (!pending) return;

  const hasClassification = classification.contactType || classification.businessId;
  const suppressAutoReply = opts.suppressAutoReply || false;
  console.log(`[TM:${uid}] 🔍 LID-ID: ✅ Resolviendo ${lidBase} → "${contactName}"${phoneNumber ? ` (${phoneNumber})` : ''}${hasClassification ? ` [tipo=${classification.contactType || '?'}, biz=${classification.businessName || '?'}]` : ''}${suppressAutoReply ? ' [⛔ NO auto-responder]' : ''}`);

  // Si tenemos número, mapear en _lidMap
  if (phoneNumber) {
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    if (!tenant._lidMap) tenant._lidMap = {};
    tenant._lidMap[lidBase] = jid;
    try {
      await admin.firestore().collection('users').doc(uid)
        .collection('miia_persistent').doc('lid_map')
        .set({ mappings: tenant._lidMap, updatedAt: new Date().toISOString() }, { merge: true });
      console.log(`[TM:${uid}] 💾 LID-MAP: ${lidBase} → ${jid} persistido (nombre: ${contactName})`);
    } catch (e) {
      console.error(`[TM:${uid}] ⚠️ Error persistiendo LID mapping:`, e.message);
    }
  }

  // Guardar nombre en lid_contacts (referencia interna)
  try {
    await admin.firestore().collection('users').doc(uid)
      .collection('miia_persistent').doc('lid_contacts')
      .set({ [lidBase]: { name: contactName, phone: phoneNumber || null, resolvedAt: new Date().toISOString(), originalFrom } }, { merge: true });
  } catch (e) {
    console.error(`[TM:${uid}] ⚠️ Error guardando lid_contacts:`, e.message);
  }

  // ═══ CLASIFICACIÓN INTELIGENTE: guardar tipo + negocio en contact_index ═══
  const resolvedPhone = phoneNumber ? phoneNumber.replace(/[^0-9]/g, '') : lidBase;
  if (hasClassification) {
    try {
      const indexData = {
        name: contactName,
        type: classification.contactType || 'lead',
        ...(classification.businessId && { businessId: classification.businessId }),
        ...(classification.businessName && { businessName: classification.businessName }),
        source: 'owner_lid_response'
      };
      await admin.firestore().collection('users').doc(uid)
        .collection('contact_index').doc(resolvedPhone)
        .set({ ...indexData, updatedAt: new Date().toISOString() }, { merge: true });
      console.log(`[TM:${uid}] 📇 LID-ID: Clasificación guardada en contact_index: ${resolvedPhone} → type=${indexData.type}, biz=${indexData.businessId || '-'}`);
    } catch (e) {
      console.error(`[TM:${uid}] ⚠️ Error guardando clasificación en contact_index:`, e.message);
    }

    // Setear en contexto de TMH para que los buffereados (si se procesan) usen el prompt correcto
    try {
      const { setContactType, setLeadName } = require('./tenant_message_handler');
      if (setContactType) setContactType(uid, resolvedPhone, classification.contactType || 'lead');
      if (setLeadName) setLeadName(uid, resolvedPhone, contactName);
    } catch (_) {}
  }

  // Notificar al owner — SOLO si no es resolución silenciosa
  const suppressNotification = opts.suppressNotification || false;
  if (!suppressNotification) {
    const selfJid = tenant.sock?.user?.id;
    if (tenant.sock && selfJid) {
      const typeLabels = { client: 'cliente', lead: 'lead', familia: 'familia', equipo: 'equipo', group: 'amigo/conocido' };
      const typeLabel = classification.contactType ? typeLabels[classification.contactType] || classification.contactType : '';
      const bizSuffix = classification.businessName ? ` de ${classification.businessName}` : '';
      const bufferCount = pending.bufferedMsgs?.length || 0;
      let confirmMsg = `👱‍♀️: Listo, *${contactName}*`;
      if (typeLabel) confirmMsg += ` es ${typeLabel}${bizSuffix}`;
      confirmMsg += `. Lo tengo registrado.`;
      if (bufferCount > 0) {
        confirmMsg += suppressAutoReply
          ? `\n\nTiene ${bufferCount} mensaje${bufferCount > 1 ? 's' : ''} pendiente${bufferCount > 1 ? 's' : ''} — esperando tu indicación.`
          : `\n\nYa estoy atendiendo sus ${bufferCount} mensaje${bufferCount > 1 ? 's' : ''} pendiente${bufferCount > 1 ? 's' : ''} 💬`;
      }
      tenant.sock.sendMessage(selfJid, { text: confirmMsg })
        .catch(e => console.error(`[TM:${uid}] ⚠️ Error notificando resolución:`, e.message));
    }
  } else {
    console.log(`[TM:${uid}] 🔕 LID-ID: Resolución silenciosa de ${lidBase} → "${contactName}" — sin notificar al owner`);
  }

  // ═══ PROCESAR MENSAJES BUFFEREADOS ═══
  // Si el owner dijo "no respondas" → NO procesar (la instrucción va a la IA por self-chat)
  if (suppressAutoReply) {
    console.log(`[TM:${uid}] 🔍 LID-ID: ⛔ Owner dijo "no respondas" — ${pending.bufferedMsgs?.length || 0} mensajes buffereados guardados pero NO procesados`);
    // Guardar resumen de mensajes buffereados para que la IA del self-chat pueda informar al owner
    if (pending.bufferedMsgs?.length) {
      tenant._suppressedBuffers = tenant._suppressedBuffers || {};
      tenant._suppressedBuffers[resolvedPhone] = {
        contactName,
        messages: pending.bufferedMsgs.map(b => b.body),
        classification,
        suppressedAt: new Date().toISOString()
      };
    }
  } else if (pending.bufferedMsgs?.length && tenant.sock) {
    const resolvedJid = phoneNumber ? `${phoneNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net` : originalFrom;
    console.log(`[TM:${uid}] 🔍 LID-ID: Procesando ${pending.bufferedMsgs.length} mensajes buffereados de ${contactName}${hasClassification ? ` (${classification.contactType})` : ''}`);
    for (const buffered of pending.bufferedMsgs) {
      const { handleTenantMessage } = require('./tenant_message_handler');
      const ownerUid = tenant.ownerUid || uid;
      const role = tenant.role || 'owner';
      try {
        await handleTenantMessage(uid, ownerUid, role, resolvedJid, buffered.body, false, false, tenant, {});
      } catch (e) {
        console.error(`[TM:${uid}] ⚠️ Error procesando mensaje buffereado:`, e.message);
      }
    }
  }

  // Limpiar y persistir
  delete tenant._pendingLids[lidBase];
  _savePendingLids(uid, tenant);
}

/**
 * Extrae nombre, tipo de contacto y negocio del texto del owner.
 * Ejemplos:
 *   "Se llama Yaneth" → { name: 'Yaneth' }
 *   "Es Juan, cliente de Medilink" → { name: 'Juan', contactType: 'client', businessName: 'Medilink' }
 *   "Yaneth. Es cliente de Medilink. No respondas." → { name: 'Yaneth', contactType: 'client', businessName: 'Medilink', hasAdditionalContext: true }
 *   "Es mi mamá" → { name: 'mi mamá', contactType: 'familia' }
 *   "Es del equipo" → { contactType: 'equipo' }
 * @param {string} text - Texto del owner
 * @param {Object} tenant - Referencia al tenant (para buscar negocios)
 * @returns {{ name?: string, phone?: string, contactType?: string, businessId?: string, businessName?: string, hasAdditionalContext: boolean }}
 */
function _extractLidClassification(text, tenant) {
  const result = { hasAdditionalContext: false };

  // ═══ EXTRACCIÓN INDEPENDIENTE DEL ORDEN ═══
  // El owner puede decir en CUALQUIER orden:
  //   "Se llama Yaneth. Es cliente de Medilink. No respondas."
  //   "Es cliente de Medilink. Se llama Yaneth."
  //   "Yaneth, cliente medilink"
  //   "Es mi mamá, se llama Rosa"
  // Cada pieza se extrae por separado del texto completo.

  // ── 1. Extraer nombre (buscar en TODO el texto, no solo al inicio) ──
  // Prioridad: "Se llama X" > "Es X" (inicio) > nombre suelto corto
  const seLlamaMatch = text.match(/se\s+llama\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s]{2,40})/i);
  if (seLlamaMatch) {
    result.name = seLlamaMatch[1].replace(/[.,;:!?]+\s*$/, '').trim();
  }
  if (!result.name) {
    // "Es Juan" solo al inicio
    const esMatch = text.match(/^es\s+([A-Za-záéíóúñÁÉÍÓÚÑ]{2,30})/i);
    if (esMatch) {
      // Verificar que no sea "Es cliente" / "Es del equipo" (tipo, no nombre)
      const candidate = esMatch[1].trim().toLowerCase();
      const typeWords = ['cliente', 'lead', 'prospecto', 'familia', 'familiar', 'equipo', 'empleado', 'amigo', 'amiga', 'conocido', 'vecino', 'del'];
      if (!typeWords.includes(candidate)) {
        result.name = esMatch[1].trim();
      }
    }
  }
  if (!result.name) {
    // Nombre suelto al inicio (solo si mensaje corto ≤60 chars, solo letras)
    const shortMatch = text.match(/^([A-Za-záéíóúñÁÉÍÓÚÑ]{2,25})(?:\s|,|\.)/);
    if (shortMatch && text.length <= 60) {
      const candidate = shortMatch[1].trim().toLowerCase();
      const typeWords = ['cliente', 'lead', 'prospecto', 'familia', 'familiar', 'equipo', 'empleado', 'amigo', 'amiga', 'conocido', 'vecino', 'del', 'es', 'no', 'si'];
      if (!typeWords.includes(candidate)) {
        result.name = shortMatch[1].trim();
      }
    }
  }

  // Extraer teléfono si aparece en cualquier parte
  const phoneMatch = text.match(/\+?(\d{10,18})/);
  if (phoneMatch) result.phone = phoneMatch[1];

  // ── 2. Extraer tipo de contacto (buscar en TODO el texto) ──
  const tipoPatterns = [
    { pattern: /\b(?:cliente?|customer)\b/i, type: 'client' },
    { pattern: /\b(?:lead|prospecto|interesado)\b/i, type: 'lead' },
    { pattern: /\b(?:familia|familiar|mi\s+(?:mam[aá]|pap[aá]|hermano|hermana|t[ií]o|t[ií]a|primo|prima|esposa|esposo|novia|novio|pareja|abuela|abuelo|hijo|hija|sobrino|sobrina|cu[ñn]ado|cu[ñn]ada|suegro|suegra))\b/i, type: 'familia' },
    { pattern: /\b(?:equipo|empleado|trabajador|colega|compa[ñn]ero|del\s+equipo)\b/i, type: 'equipo' },
    { pattern: /\b(?:amigo|amiga|conocido|vecino)\b/i, type: 'group' }
  ];
  for (const { pattern, type } of tipoPatterns) {
    if (pattern.test(text)) {
      result.contactType = type;
      // Si es familia y no hay nombre, extraer relación como nombre
      if (type === 'familia' && !result.name) {
        const relMatch = text.match(/mi\s+(mam[aá]|pap[aá]|hermano|hermana|t[ií]o|t[ií]a|primo|prima|esposa|esposo|novia|novio|pareja|abuela|abuelo|hijo|hija|sobrino|sobrina|cu[ñn]ado|cu[ñn]ada|suegro|suegra)/i);
        if (relMatch) result.name = `mi ${relMatch[1]}`;
      }
      break;
    }
  }

  // ── 3. Extraer negocio (buscar en TODO el texto) ──
  // Primero intentar "cliente de X" / "lead de X"
  const bizMatch = text.match(/(?:cliente?|lead|prospecto)\s+(?:de|del)\s+([A-Za-záéíóúñÁÉÍÓÚÑ\s\-]{2,30})/i);
  if (bizMatch) {
    const bizNameRaw = bizMatch[1].replace(/[.,;:!?]+\s*$/, '').trim();
    const businesses = tenant._businesses || [];
    const matchedBiz = businesses.find(b =>
      b.name && b.name.toLowerCase().includes(bizNameRaw.toLowerCase())
    );
    if (matchedBiz) {
      result.businessId = matchedBiz.id;
      result.businessName = matchedBiz.name;
    } else {
      result.businessName = bizNameRaw;
    }
  }

  // SHORTCUT: Owner solo dice nombre del negocio ("Medilink") → detectar el negocio
  // pero NO asumir tipo — PREGUNTAR si es lead, cliente o acompañante
  if (result.name && !result.businessId) {
    const businesses = tenant._businesses || [];
    const bizByName = businesses.find(b =>
      b.name && b.name.toLowerCase() === result.name.toLowerCase()
    );
    if (bizByName) {
      // "Medilink" no es el nombre del contacto — es el negocio
      result.businessId = bizByName.id;
      result.businessName = bizByName.name;
      result.name = null; // Limpiar — el nombre del contacto no fue dado
      // NO asignar tipo — que el flujo pregunte si es lead, cliente, etc.
      // result.contactType se queda sin definir → el caller preguntará
      result._needsTypeConfirmation = true;
    }
  }

  // Si hay 1 solo negocio y es cliente/lead → asignar automáticamente
  if ((result.contactType === 'client' || result.contactType === 'lead') && !result.businessId) {
    const businesses = tenant._businesses || [];
    if (businesses.length === 1) {
      result.businessId = businesses[0].id;
      result.businessName = businesses[0].name;
    }
  }

  // Si no hay nombre NI tipo NI negocio, no es una clasificación válida
  if (!result.name && !result.contactType && !result.businessId) return result;

  // ── 4. Detectar contexto adicional (instrucciones para la IA) ──
  // Quitar las partes de clasificación y ver si queda algo sustancial
  let remaining = text;
  // Quitar "se llama X"
  remaining = remaining.replace(/se\s+llama\s+[A-Za-záéíóúñÁÉÍÓÚÑ\s]{2,40}/i, '');
  // Quitar "es X" (nombre)
  remaining = remaining.replace(/^es\s+[A-Za-záéíóúñÁÉÍÓÚÑ]{2,30}/i, '');
  // Quitar "cliente/lead de Y"
  remaining = remaining.replace(/(?:es\s+)?(?:cliente?|lead|prospecto)(?:\s+(?:de|del)\s+[A-Za-záéíóúñÁÉÍÓÚÑ\s\-]{2,30})?/i, '');
  // Quitar "es familia/equipo/amigo"
  remaining = remaining.replace(/(?:es\s+)?(?:familia|familiar|equipo|empleado|amigo|amiga|conocido|vecino|mi\s+\w+)/i, '');
  // Quitar puntuación y espacios sueltos
  remaining = remaining.replace(/^[\s.,;:!?]+/, '').replace(/[\s.,;:!?]+$/, '');

  if (remaining.length > 10) {
    result.hasAdditionalContext = true;
    result.additionalContext = remaining; // Guardar para pasar a la IA
  }

  return result;
}

/**
 * Verificar si un mensaje del owner en self-chat es una respuesta a una consulta de LID pendiente.
 * @param {string} uid - UID del tenant
 * @param {string} messageBody - Texto del mensaje del owner
 * @returns {boolean} true si el mensaje fue consumido (no pasar a IA), false si debe seguir a IA
 */
function checkOwnerLidResponse(uid, messageBody) {
  // ═══ GUTTED: LID Silent Mode ═══
  // Los contactos desconocidos ya NO se clasifican desde self-chat.
  // Se clasifican desde el dashboard (grupo "Pendientes") o auto-reclasifican con IA.
  // Esta función existe solo por backward compat — siempre retorna false.
  return false;
}

// ═══ PENDING MESSAGE RECOVERY — INFALIBLE ═══════════════════════════════════
// Cada mensaje entrante se escribe a Firestore INMEDIATAMENTE (fire-and-forget).
// Al responder exitosamente → se borra de Firestore.
// Al reconectar → se cargan todos los pendientes y se reprocesan.
// Sobrevive a: SIGTERM, OOM kill, crash, kill -9, Railway freeze, TODO.

async function flushUnrespondedMessages() {
  // Con el sistema infalible, los mensajes ya están en Firestore individualmente.
  // Esta función ahora solo sirve como safety net para limpiar mensajes muy viejos.
  let totalCleaned = 0;
  for (const [uid] of tenants) {
    try {
      const snap = await admin.firestore().collection('users').doc(uid)
        .collection('pending_responses')
        .where('timestamp', '<', Date.now() - 3600000) // > 1 hora = ya no tiene sentido
        .limit(50)
        .get();
      if (!snap.empty) {
        const batch = admin.firestore().batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        totalCleaned += snap.size;
        console.log(`[TM:${uid}] 🧹 Cleaned ${snap.size} stale pending_responses (>1h old)`);
      }
    } catch (e) {
      console.error(`[TM:${uid}] ❌ Error cleaning stale pending_responses:`, e.message);
    }
  }
  return totalCleaned;
}

async function recoverUnrespondedMessages(uid, tenant) {
  try {
    // Leer TODOS los pending_responses de este tenant
    const snap = await admin.firestore().collection('users').doc(uid)
      .collection('pending_responses')
      .orderBy('timestamp', 'asc')
      .limit(20) // Max 20 para no saturar al reconectar
      .get();

    if (snap.empty) return 0;

    const messages = snap.docs.map(d => ({ msgId: d.id, ...d.data() }));

    // Filtrar: solo mensajes de los últimos 30 min
    const recent = messages.filter(m => Date.now() - m.timestamp < 1800000);
    const stale = messages.filter(m => Date.now() - m.timestamp >= 1800000);

    // Borrar los stale (>30 min) — ya no tiene sentido reprocesar
    if (stale.length > 0) {
      const batch = admin.firestore().batch();
      stale.forEach(m => {
        batch.delete(admin.firestore().collection('users').doc(uid)
          .collection('pending_responses').doc(m.msgId));
      });
      await batch.commit();
      console.log(`[TM:${uid}] 🧹 Deleted ${stale.length} stale pending message(s) (>30min)`);
    }

    if (recent.length === 0) {
      console.log(`[TM:${uid}] 📭 ${messages.length} pending found but all too old. Cleaned.`);
      return 0;
    }

    console.log(`[TM:${uid}] 🔄 RECOVERY: ${recent.length} mensaje(s) sin responder. Reprocesando...`);

    let recovered = 0;
    for (const msg of recent) {
      try {
        if (msg.isOwnerPath && tenant.onMessage) {
          const fakeMsg = {
            key: { remoteJid: msg.from, fromMe: false, id: `recovery_${Date.now()}` },
            message: { conversation: msg.body },
            pushName: 'Recovery'
          };
          tenant.onMessage(fakeMsg, msg.from, msg.body);
        } else {
          await handleTenantMessage(
            uid, msg.ownerUid || uid, msg.role || 'owner',
            msg.phone, msg.body, false, false, tenant, { isRecovery: true }
          );
        }
        // Borrar de Firestore después de reprocesar exitosamente
        await admin.firestore().collection('users').doc(uid)
          .collection('pending_responses').doc(msg.msgId).delete();
        recovered++;
        console.log(`[TM:${uid}] ✅ RECOVERY: "${msg.body.substring(0, 40)}" de ${msg.phone} — respondido`);
        await new Promise(r => setTimeout(r, 2000)); // 2s entre mensajes
      } catch (e) {
        console.error(`[TM:${uid}] ❌ RECOVERY error (${msg.phone}):`, e.message);
      }
    }
    console.log(`[TM:${uid}] 🔄 RECOVERY COMPLETE: ${recovered}/${recent.length} mensajes recuperados`);
    return recovered;
  } catch (e) {
    console.error(`[TM:${uid}] ❌ Error in recoverUnrespondedMessages:`, e.message);
    return 0;
  }
}

/**
 * BUG2-FIX: Guardar creds de TODOS los tenants activos (llamado desde SIGTERM handler).
 * Asegura que después de un redeploy, AUTO-INIT encuentre creds en Firestore.
 */
async function saveAllTenantCreds() {
  let saved = 0;
  for (const [uid, tenant] of tenants) {
    if (tenant._saveCreds && tenant.isReady) {
      try {
        await tenant._saveCreds();
        saved++;
        console.log(`[TM:${uid}] ✅ Creds guardadas en shutdown`);
      } catch (e) {
        console.error(`[TM:${uid}] ❌ Error guardando creds en shutdown:`, e.message);
      }
    }
  }
  return saved;
}

/**
 * BUG3b-FIX: Registrar un msgId como enviado por MIIA para prevenir auto-respuesta.
 * Llamado desde server.js safeSendMessage cuando envía via ownerSock directamente.
 */
function registerSentMsgId(uid, msgId) {
  const t = tenants.get(uid);
  if (!t || !msgId) return;
  if (!t._sentMsgIds) t._sentMsgIds = new Set();
  t._sentMsgIds.add(msgId);
  if (t._sentMsgIds.size > 200) {
    const arr = [...t._sentMsgIds];
    t._sentMsgIds = new Set(arr.slice(-100));
  }
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
  getConnectionMetrics,
  resolveLidFromContacts,
  getConnectedTenants,
  checkOwnerLidResponse,
  verifyConnection,
  forceReconnect,
  forceReconnectByUid,
  flushUnrespondedMessages,
  recoverUnrespondedMessages,
  registerSentMsgId,
  saveAllTenantCreds
};
