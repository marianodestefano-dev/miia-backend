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

const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { useFirestoreAuthState, deleteFirestoreSession } = require('./baileys_session_store');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { callAI } = require('./ai_client');
const { buildTenantPrompt, buildOwnerLeadPrompt } = require('./prompt_builder');

// ─── Tenant state ─────────────────────────────────────────────────────────────
const tenants = new Map();

const DATA_ROOT = path.join(__dirname, 'data', 'tenants');
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

// Silent logger for Baileys (avoid noisy output)
const baileysLogger = pino({ level: 'silent' });

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
    onMessage: options.onMessage || null,  // Custom message handler (used by owner)
    onReady: options.onReady || null       // Callback when connection is ready
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
          // Logged out — clean up
          console.log(`[TM:${uid}] 🔌 Logged out — cleaning session`);
          tenant.isAuthenticated = false;
          tenant.sock = null;
          tenants.delete(uid);
          await deleteFirestoreSession(`tenant-${uid}`);
          if (ioInstance) {
            ioInstance.emit(`tenant_disconnected_${uid}`, { reason: 'logged_out' });
          }
        }
      }
    });

    // ─── Save credentials on update ───
    sock.ev.on('creds.update', saveCreds);

    // ─── Incoming messages ───
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return; // Only process new messages, not history

      for (const msg of messages) {
        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        const isStatus = from === 'status@broadcast';
        const isFromMe = msg.key.fromMe;

        // Skip group messages
        if (isGroup) continue;
        // Skip status broadcasts
        if (isStatus) continue;

        // For owner with onMessage: allow self-chat (fromMe + from === from)
        // For regular tenants: skip fromMe messages
        const isSelfChat = isFromMe && from === from; // Always true for self-chat
        const shouldProcess = !isFromMe || (tenant.onMessage && isFromMe);

        if (!shouldProcess) continue;

        // Extract text body
        const body = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || '';

        if (!body.trim()) continue;

        console.log(`[TM:${uid}] 📨 Message from ${from}${isFromMe ? ' (self-chat)' : ''}: "${body.substring(0, 40)}"`);

        // If custom onMessage handler is set (owner), delegate to it
        if (tenant.onMessage) {
          try { tenant.onMessage(msg, from, body); } catch (e) { console.error(`[TM:${uid}] onMessage error:`, e.message); }
        } else {
          processTenantMessage(uid, from, body);
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
    if (t.sock) {
      await t.sock.logout();
    }
    tenants.delete(uid);
    await deleteFirestoreSession(`tenant-${uid}`);
    console.log(`[TM:${uid}] 🔌 Tenant destroyed`);
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
