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

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

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

async function callGeminiForTenant(uid, prompt) {
  const t = tenants.get(uid);
  if (!t) throw new Error(`Tenant ${uid} not found`);

  const apiKey = t.geminiApiKey;
  if (!apiKey) throw new Error(`No Gemini API key for tenant ${uid}`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
      });

      if (response.status === 503 || response.status === 429) {
        const delays = [8000, 20000, 45000];
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }

      const data = await response.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return '';
}

// ─── Build a response prompt for a tenant ─────────────────────────────────────

function buildSystemPrompt(tenant, contactName) {
  const history = (tenant.conversations[contactName] || [])
    .slice(-20)
    .map(m => `${m.role === 'user' ? 'Cliente' : 'MIIA'}: ${m.content}`)
    .join('\n');

  const training = tenant.trainingData || '';

  return `Eres MIIA, una asistente de ventas inteligente por WhatsApp.
Respondes con el estilo y conocimiento del negocio de tu cliente.
Eres cálida, profesional y efectiva cerrando ventas.

${training ? `[LO QUE HE APRENDIDO DE ESTE NEGOCIO]:\n${training}\n` : ''}

[HISTORIAL DE CONVERSACIÓN]:
${history || 'Sin historial previo.'}

Responde al último mensaje del cliente de forma natural y útil (máximo 3 oraciones). No uses emojis en exceso.`;
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
    const aiReply = await callGeminiForTenant(uid, prompt + `\nCliente: ${messageBody}\nMIIA:`);

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
function initTenant(uid, geminiApiKey, ioInstance) {
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

  const authDir = path.join(dataDir, 'auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: uid, dataPath: dataDir }),
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

  tenant.client = client;

  client.on('qr', async (qr) => {
    console.log(`[TM:${uid}] 📱 QR generated`);
    tenant.qrCode = await qrcode.toDataURL(qr);
    if (ioInstance) {
      ioInstance.to(`tenant:${uid}`).emit('qr', tenant.qrCode);
      // Also broadcast to any connected socket watching this tenant
      ioInstance.emit(`tenant_qr_${uid}`, tenant.qrCode);
    }
  });

  client.on('authenticated', () => {
    console.log(`[TM:${uid}] ✅ Authenticated`);
    tenant.qrCode = null;
  });

  client.on('ready', () => {
    console.log(`[TM:${uid}] ✅ WhatsApp ready`);
    tenant.isReady = true;
    if (ioInstance) {
      ioInstance.to(`tenant:${uid}`).emit('whatsapp_ready', { uid, status: 'connected' });
      ioInstance.emit(`tenant_ready_${uid}`, { status: 'connected' });
    }
  });

  client.on('message_create', (msg) => {
    // Only process incoming messages (not own messages)
    if (msg.fromMe) return;
    if (!msg.body || msg.body.trim() === '') return;
    processTenantMessage(uid, msg.from, msg.body);
  });

  client.on('disconnected', (reason) => {
    console.log(`[TM:${uid}] ❌ Disconnected: ${reason}`);
    tenant.isReady = false;
    tenant.client = null;
    tenants.delete(uid);
    if (ioInstance) {
      ioInstance.emit(`tenant_disconnected_${uid}`, { reason });
    }
  });

  client.initialize();
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

module.exports = {
  initTenant,
  destroyTenant,
  getTenantStatus,
  getTenantConversations,
  appendTenantTraining,
  getAllTenants
};
