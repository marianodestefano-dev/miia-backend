// ════════════════════════════════════════════════════════════════════════════
// MIIA — WhatsApp Gateway (P5.1)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Wrapper sobre tenant_manager que abstrae toda interacción con WhatsApp.
// Encapsula: envío, recepción, healthcheck, reconexión, session store.
// El resto del sistema habla SOLO con este gateway, NUNCA con Baileys directo.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const tenantManager = require('./tenant_manager');

// Métricas de gateway
const metrics = {
  messagesSent: 0,
  messagesReceived: 0,
  sendErrors: 0,
  reconnections: 0,
  lastSendAt: null,
  lastReceiveAt: null,
  lastError: null,
  startedAt: new Date().toISOString()
};

/**
 * Envía un mensaje de texto a un JID.
 * Centraliza TODA la lógica de envío con retry, logging y métricas.
 *
 * @param {string} uid - Owner UID
 * @param {string} jid - JID destino (phone@s.whatsapp.net)
 * @param {string} text - Texto del mensaje
 * @param {Object} [opts] - Opciones adicionales
 * @param {boolean} [opts.quoted] - Mensaje a citar
 * @param {number} [opts.retries=2] - Intentos máximos
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendMessage(uid, jid, text, opts = {}) {
  const maxRetries = opts.retries ?? 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sock = tenantManager.getTenantClient(uid);
      if (!sock) {
        const errMsg = `No hay conexión WA activa para uid=${uid}`;
        console.error(`[WA-GW] ❌ ${errMsg}`);
        metrics.sendErrors++;
        metrics.lastError = errMsg;
        return { success: false, error: errMsg };
      }

      const msgPayload = { text };
      if (opts.quoted) msgPayload.quoted = opts.quoted;

      const result = await sock.sendMessage(jid, msgPayload);
      metrics.messagesSent++;
      metrics.lastSendAt = new Date().toISOString();

      if (attempt > 0) {
        console.log(`[WA-GW] ✅ Mensaje enviado a ${jid} (retry #${attempt})`);
      }

      return { success: true, messageId: result?.key?.id || null };
    } catch (err) {
      lastError = err;
      metrics.sendErrors++;
      metrics.lastError = err.message;
      console.error(`[WA-GW] ❌ Error enviando a ${jid} (intento ${attempt + 1}/${maxRetries + 1}): ${err.message}`);

      if (attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  return { success: false, error: lastError?.message || 'Unknown error' };
}

/**
 * Envía un mensaje con media (imagen, audio, documento, video).
 */
async function sendMedia(uid, jid, mediaType, buffer, opts = {}) {
  try {
    const sock = tenantManager.getTenantClient(uid);
    if (!sock) {
      console.error(`[WA-GW] ❌ No hay conexión WA para media (uid=${uid})`);
      return { success: false, error: 'No WA connection' };
    }

    const payload = {};
    if (mediaType === 'image') {
      payload.image = buffer;
      if (opts.caption) payload.caption = opts.caption;
    } else if (mediaType === 'audio') {
      payload.audio = buffer;
      payload.mimetype = opts.mimetype || 'audio/ogg; codecs=opus';
      payload.ptt = opts.ptt !== false;
    } else if (mediaType === 'document') {
      payload.document = buffer;
      payload.fileName = opts.fileName || 'document.pdf';
      payload.mimetype = opts.mimetype || 'application/pdf';
    } else if (mediaType === 'video') {
      payload.video = buffer;
      if (opts.caption) payload.caption = opts.caption;
    }

    const result = await sock.sendMessage(jid, payload);
    metrics.messagesSent++;
    metrics.lastSendAt = new Date().toISOString();
    console.log(`[WA-GW] ✅ Media (${mediaType}) enviado a ${jid}`);
    return { success: true, messageId: result?.key?.id || null };
  } catch (err) {
    metrics.sendErrors++;
    metrics.lastError = err.message;
    console.error(`[WA-GW] ❌ Error enviando media a ${jid}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Envía una reacción a un mensaje.
 */
async function sendReaction(uid, jid, msgKey, emoji) {
  try {
    const sock = tenantManager.getTenantClient(uid);
    if (!sock) return { success: false, error: 'No WA connection' };

    await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
    console.log(`[WA-GW] 😊 Reacción "${emoji}" enviada a ${jid}`);
    return { success: true };
  } catch (err) {
    console.error(`[WA-GW] ❌ Error enviando reacción: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Marca mensajes como leídos.
 */
async function markRead(uid, msgKeys) {
  try {
    const sock = tenantManager.getTenantClient(uid);
    if (!sock) return { success: false };
    await sock.readMessages(Array.isArray(msgKeys) ? msgKeys : [msgKeys]);
    return { success: true };
  } catch (err) {
    console.error(`[WA-GW] ⚠️ markRead error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Verifica el estado de la conexión WhatsApp de un tenant.
 */
function getConnectionStatus(uid) {
  const status = tenantManager.getTenantStatus(uid);
  const sock = tenantManager.getTenantClient(uid);
  return {
    connected: !!sock,
    status: status || 'unknown',
    user: sock?.user || null,
    metrics: { ...metrics }
  };
}

/**
 * Health check completo del gateway.
 */
function healthCheck() {
  return {
    status: 'ok',
    metrics: { ...metrics },
    uptime: Date.now() - new Date(metrics.startedAt).getTime(),
    timestamp: new Date().toISOString()
  };
}

/**
 * Registra un mensaje recibido (para métricas).
 */
function recordReceived() {
  metrics.messagesReceived++;
  metrics.lastReceiveAt = new Date().toISOString();
}

/**
 * Registra una reconexión.
 */
function recordReconnection() {
  metrics.reconnections++;
  console.log(`[WA-GW] 🔄 Reconexión registrada (#${metrics.reconnections})`);
}

/**
 * Obtiene métricas actuales.
 */
function getMetrics() {
  return { ...metrics };
}

module.exports = {
  sendMessage,
  sendMedia,
  sendReaction,
  markRead,
  getConnectionStatus,
  healthCheck,
  recordReceived,
  recordReconnection,
  getMetrics
};
