/**
 * TENANT MANAGER — MIIA Multi-tenant WhatsApp Engine
 *
 * Manages one WhatsApp Client instance per SaaS client (uid).
 * Each tenant gets:
 *   - Isolated LocalAuth session (./data/{uid}/auth/)
 *   - Isolated conversation history (./data/{uid}/db.json)
 *   - Their own Gemini API key (from Firestore, passed at init time)
 *   - Their own cerebro_absoluto training data
 *   - Their own Socket.IO room for QR and status events
 *
 * The original server_v2.js single-tenant setup for Mariano remains
 * untouched. This module handles ADDITIONAL client tenants.
 */

'use strict';

const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { callAI } = require('./ai_client');
const FirestoreSessionStore = require('./firestore_session_store');
const { buildTenantPrompt, buildOwnerLeadPrompt } = require('./prompt_builder');

// ─── Tenant state ─────────────────────────────────────────────────────────────
//
// tenants: Map<uid, TenantState>
// TenantState: {
//   uid, geminiApiKey, client, isReady, qrCode,
//   conversations, leadNames, contactTypes,
//   trainingData, dataDir
// }
//
const tenants = new Map();

const DATA_ROOT = path.join(__dirname, 'data', 'tenants');
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Build a response prompt for a tenant (delegates to prompt_builder.js) ──

function buildSystemPrompt(tenant, contactName) {
  // Equipo Medilink (@healthatom.com) → cerebro Medilink completo
  if (tenant.isOwnerMember) {
    return buildOwnerLeadPrompt(contactName, tenant.trainingData || '');
  }
  return buildTenantPrompt(
    contactName,
    tenant.trainingData || '',
    tenant.conversations[contactName] || []
  );
}

// ─── Core: process incoming message for a tenant ──────────────────────────────

async function processTenantMessage(uid, phone, messageBody) {
  const t = tenants.get(uid);
  if (!t) return;

  // Avoid processing own messages
  if (!phone.includes('@c.us') && !phone.includes('@g.us')) return;

  // Save incoming message
  if (!t.conversations[phone]) t.conversations[phone] = [];
  t.conversations[phone].push({
    role: 'user',
    content: messageBody,
    timestamp: Date.now()
  });

  // Trim history to last 40
  if (t.conversations[phone].length > 40) {
    t.conversations[phone] = t.conversations[phone].slice(-40);
  }

  try {
    const prompt = buildSystemPrompt(t, phone);
    const aiReply = await callAIForTenant(uid, prompt + `\nCliente: ${messageBody}\nMIIA:`);

    if (!aiReply || !aiReply.trim()) return;

    // Save AI reply
    t.conversations[phone].push({
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

    // Send via WhatsApp
    if (t.client && t.isReady) {
      await t.client.sendMessage(phone, aiReply);
    }

    // Emit to frontend via Socket.IO room
    if (t.io) {
      t.io.to(`tenant:${uid}`).emit('ai_response', {
        phone,
        message: aiReply,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error(`[TM:${uid}] Error processing message from ${phone}:`, error.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize a WhatsApp client for a tenant.
 * @param {string} uid - Firebase user UID
 * @param {string} geminiApiKey - Tenant's Gemini API key
 * @param {object} ioInstance - Socket.IO server instance (to emit QR/status events)
 * @returns {object} tenant state
 */
function initTenant(uid, geminiApiKey, ioInstance, aiConfig = {}) {
  if (tenants.has(uid)) {
    const existing = tenants.get(uid);
    if (existing.isReady) {
      console.log(`[TM:${uid}] ✅ Already connected`);
      return existing;
    }
    // Client exists but not ready yet — return existing
    return existing;
  }

  console.log(`[TM:${uid}] 🚀 Initializing WhatsApp client...`);

  const dataDir = getTenantDataDir(uid);
  const savedDB = loadTenantDB(uid);

  const tenant = {
    uid,
    geminiApiKey,
    aiProvider: aiConfig.provider || 'gemini',
    aiApiKey: aiConfig.apiKey || geminiApiKey,
    client: null,
    isReady: false,
    qrCode: null,
    conversations: savedDB.conversations || {},
    leadNames: savedDB.leadNames || {},
    contactTypes: {},
    trainingData: savedDB.trainingData || '',
    dataDir,
    io: ioInstance
  };

  tenants.set(uid, tenant);

  const tenantStore = new FirestoreSessionStore();

  const client = new Client({
    authStrategy: new RemoteAuth({
      store: tenantStore,
      clientId: `tenant-${uid}`,
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

  tenant.client = client;

  client.on('qr', async (qr) => {
    try {
      console.log(`[TM:${uid}] 📱 QR received from WhatsApp client`);
      const qrDataUrl = await qrcode.toDataURL(qr);
      console.log(`[TM:${uid}] 📝 QR DataURL length: ${qrDataUrl.length}, starts with: ${qrDataUrl.substring(0, 50)}`);
      tenant.qrCode = qrDataUrl;
      console.log(`[TM:${uid}] ✅ QR stored in tenant object`);
      if (ioInstance) {
        ioInstance.to(`tenant:${uid}`).emit('qr', tenant.qrCode);
        ioInstance.emit(`tenant_qr_${uid}`, tenant.qrCode);
      }
    } catch (err) {
      console.error(`[TM:${uid}] ❌ Error generating QR DataURL:`, err.message);
    }
  });

  client.on('authenticated', () => {
    console.log(`[TM:${uid}] ✅ Authenticated — waiting for ready event...`);
    tenant.qrCode = null;
    tenant.isAuthenticated = true;

    // If ready doesn't fire in 3 minutes, destroy and let user retry
    tenant._readyTimeout = setTimeout(async () => {
      if (!tenant.isReady) {
        console.error(`[TM:${uid}] ⏱️ Timeout: authenticated but ready never fired. Destroying client.`);
        try { await client.destroy(); } catch (e) { /* ignore */ }
        tenant.isAuthenticated = false;
        tenants.delete(uid);
      }
    }, 3 * 60 * 1000);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[TM:${uid}] ❌ Auth failure: ${msg}`);
    tenant.isReady = false;
    tenant.isAuthenticated = false;
    tenants.delete(uid);
  });

  client.on('change_state', (state) => {
    console.log(`[TM:${uid}] 🔄 State changed: ${state}`);
  });

  client.on('ready', () => {
    console.log(`[TM:${uid}] ✅ WhatsApp READY — messages will be processed`);
    if (tenant._readyTimeout) { clearTimeout(tenant._readyTimeout); tenant._readyTimeout = null; }
    tenant.isReady = true;
    tenant.isAuthenticated = true;
    if (ioInstance) {
      ioInstance.to(`tenant:${uid}`).emit('whatsapp_ready', { uid, status: 'connected' });
      ioInstance.emit(`tenant_ready_${uid}`, { status: 'connected' });
    }

    // Polling fallback: whatsapp-web.js `message` events can be unreliable.
    // Every 5s: fetch chats, detect new messages by timestamp comparison.
    tenant._lastSeenMsgIds = new Set();
    tenant._lastSeenTimestamps = {}; // chatId → last processed msg timestamp (seconds)
    tenant._pollCount = 0;

    tenant._pollInterval = setInterval(async () => {
      if (!tenant.isReady || !tenant.client) return;
      tenant._pollCount++;
      try {
        const chats = await client.getChats();
        const nowSec = Math.floor(Date.now() / 1000);

        if (tenant._pollCount <= 3 || tenant._pollCount % 12 === 0) {
          console.log(`[TM:${uid}] 🔄 POLL #${tenant._pollCount} — chats: ${chats.length}`);
        }

        for (const chat of chats) {
          if (chat.isGroup) continue;
          const chatId = chat.id._serialized;

          // First time we see this chat: record current state, don't replay history
          if (!(chatId in tenant._lastSeenTimestamps)) {
            const ts = (chat.lastMessage && chat.lastMessage.timestamp) ? chat.lastMessage.timestamp : nowSec;
            tenant._lastSeenTimestamps[chatId] = ts;
            if (chat.lastMessage && chat.lastMessage.id && chat.lastMessage.id._serialized) {
              tenant._lastSeenMsgIds.add(chat.lastMessage.id._serialized);
            }
            continue; // snapshot only, don't process
          }

          const lastSeenTs = tenant._lastSeenTimestamps[chatId];
          const lastMsgTs = (chat.lastMessage && chat.lastMessage.timestamp) ? chat.lastMessage.timestamp : 0;

          // No new message in this chat
          if (lastMsgTs === 0 || lastMsgTs <= lastSeenTs) continue;

          // New message detected — fetch and process
          const messages = await chat.fetchMessages({ limit: 5 });
          for (const msg of messages) {
            if (msg.fromMe) continue;
            if (!msg.body || !msg.body.trim()) continue;
            if (tenant._lastSeenMsgIds.has(msg.id._serialized)) continue;
            if (msg.timestamp <= lastSeenTs) continue;
            tenant._lastSeenMsgIds.add(msg.id._serialized);
            console.log(`[TM:${uid}] 📨 POLL message from ${msg.from}: "${(msg.body||'').substring(0,40)}"`);
            processTenantMessage(uid, msg.from, msg.body);
          }
          tenant._lastSeenTimestamps[chatId] = lastMsgTs;
        }

        if (tenant._lastSeenMsgIds.size > 2000) {
          tenant._lastSeenMsgIds = new Set([...tenant._lastSeenMsgIds].slice(-1000));
        }
      } catch (err) {
        console.error(`[TM:${uid}] ❌ Poll error:`, err.message);
      }
    }, 5000);
  });

  client.on('message', (msg) => {
    console.log(`[TM:${uid}] 📨 RAW message: fromMe=${msg.fromMe}, from=${msg.from}, body="${(msg.body||'').substring(0,40)}"`);
    if (msg.fromMe) return;
    if (!msg.body || msg.body.trim() === '') return;
    processTenantMessage(uid, msg.from, msg.body);
  });

  client.on('message_create', (msg) => {
    console.log(`[TM:${uid}] 📨 RAW message_create: fromMe=${msg.fromMe}, from=${msg.from}, body="${(msg.body||'').substring(0,40)}"`);
    if (msg.fromMe) return;
    if (!msg.body || msg.body.trim() === '') return;
    processTenantMessage(uid, msg.from, msg.body);
  });

  client.on('disconnected', (reason) => {
    console.log(`[TM:${uid}] ❌ Disconnected: ${reason}`);
    if (tenant._pollInterval) { clearInterval(tenant._pollInterval); tenant._pollInterval = null; }
    tenant.isReady = false;
    tenant.isAuthenticated = false;
    tenant.client = null;
    tenants.delete(uid);
    if (ioInstance) {
      ioInstance.emit(`tenant_disconnected_${uid}`, { reason });
    }
  });

  // Initialize WhatsApp client with error handling
  client.initialize().catch(err => {
    console.error(`[TM:${uid}] ❌ Error initializing WhatsApp client:`, err.message);
  });
  return tenant;
}

/**
 * Destroy a tenant's WhatsApp session.
 * @param {string} uid
 */
async function destroyTenant(uid) {
  const t = tenants.get(uid);
  if (!t) return { success: true, message: 'Tenant not found (already destroyed)' };

  try {
    if (t._pollInterval) { clearInterval(t._pollInterval); t._pollInterval = null; }
    if (t.client) {
      await t.client.logout();
      await t.client.destroy();
    }
    tenants.delete(uid);
    console.log(`[TM:${uid}] 🔌 Tenant destroyed`);
    return { success: true };
  } catch (err) {
    console.error(`[TM:${uid}] Error destroying:`, err.message);
    tenants.delete(uid);
    return { success: false, error: err.message };
  }
}

/**
 * Get the status of a tenant.
 * @param {string} uid
 * @returns {{ exists, isReady, hasQR, conversationCount }}
 */
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
 * Get conversations for a tenant in contacts.html-compatible format.
 * If WhatsApp is ready, fetches from client.getChats().
 * Falls back to stored conversations.
 * @param {string} uid
 * @returns {Promise<Array>}
 */
async function getTenantConversations(uid) {
  const t = tenants.get(uid);
  if (!t) return [];

  // Try to get live chats from WhatsApp
  if (t.isReady && t.client) {
    try {
      const chats = await t.client.getChats();
      return chats
        .filter(c => !c.isGroup) // only 1-on-1 conversations
        .slice(0, 50) // limit to 50
        .map(c => {
          const phone = c.id.user;
          const storedConv = t.conversations[c.id._serialized] || [];
          return {
            phoneNumber: phone,
            name: c.name || c.pushname || phone,
            lastMessage: c.lastMessage?.body || (storedConv.length > 0 ? storedConv[storedConv.length - 1]?.content : ''),
            timestamp: c.timestamp || null,
            unreadCount: c.unreadCount || 0
          };
        });
    } catch (err) {
      console.error(`[TM:${uid}] Error fetching chats:`, err.message);
    }
  }

  // Fallback: return stored conversations
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

/**
 * Update training data for a tenant.
 * @param {string} uid
 * @param {string} newData - text to append to training data
 */
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

/**
 * Get all active tenants (for admin/monitoring).
 */
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

/**
 * Classify a contact as lead, cliente, or otro based on keyword rules.
 * Evaluates the last 10 messages of the conversation.
 * @param {string} uid
 * @param {string} phone
 * @param {object} contactRules - { lead_keywords: string[], client_keywords: string[] }
 * @returns {'lead'|'cliente'|'otro'}
 */
function classifyContact(uid, phone, contactRules) {
  const t = tenants.get(uid);
  if (!t) return 'otro';

  const msgs = (t.conversations[phone] || []).slice(-10);
  const allText = msgs.map(m => (m.content || '').toLowerCase()).join(' ');

  if (!contactRules) return 'otro';

  // Check client keywords first (more specific)
  if (contactRules.client_keywords && contactRules.client_keywords.length > 0) {
    const isClient = contactRules.client_keywords.some(kw =>
      allText.includes(kw.toLowerCase())
    );
    if (isClient) return 'cliente';
  }

  // Check lead keywords
  if (contactRules.lead_keywords && contactRules.lead_keywords.length > 0) {
    const isLead = contactRules.lead_keywords.some(kw =>
      allText.includes(kw.toLowerCase())
    );
    if (isLead) return 'lead';
  }

  return 'otro';
}

/**
 * Set the full training data string for a tenant (used by rebuildTenantBrain).
 * @param {string} uid
 * @param {string} trainingData
 */
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

/**
 * Update AI provider config for a running tenant.
 * @param {string} uid
 * @param {string} provider - 'gemini' | 'openai' | 'claude'
 * @param {string} apiKey
 */
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
  getTenantConversations,
  appendTenantTraining,
  setTenantTrainingData,
  setTenantAIConfig,
  classifyContact,
  getAllTenants
};
