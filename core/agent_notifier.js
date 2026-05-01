"use strict";

/**
 * MIIA — Agent Notifier (T198)
 * Notificacion al agente humano con contexto completo del lead.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require("firebase-admin").firestore(); }

let _httpClient = null;
function __setHttpClientForTests(fn) { _httpClient = fn; }
function httpPost(url, opts) {
  if (_httpClient) return _httpClient(url, opts);
  return require("node-fetch")(url, opts);
}

const NOTIFICATION_CHANNELS = Object.freeze(["push", "email", "whatsapp", "webhook"]);
const MAX_CONTEXT_MESSAGES = 5;

function formatContextForAgent(context) {
  if (!context) return "";
  const lines = [
    "Lead: " + (context.leadPhone || "desconocido"),
    "Razon: " + (context.reason || "sin especificar"),
    "Mensajes: " + (context.messageCount || 0),
  ];
  if (context.recentMessages && context.recentMessages.length > 0) {
    lines.push("Ultimos mensajes:");
    context.recentMessages.slice(-MAX_CONTEXT_MESSAGES).forEach(function(m, i) {
      lines.push("  " + (i + 1) + ". " + (m.text || m.body || JSON.stringify(m)).substring(0, 100));
    });
  }
  return lines.join("\n");
}

async function getAgentConfig(uid, agentId) {
  if (!uid) throw new Error("uid requerido");
  if (!agentId) throw new Error("agentId requerido");
  try {
    const snap = await db().collection("tenants").doc(uid).collection("agents").doc(agentId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error("[AGENT_NOTIFIER] Error leyendo agente: " + e.message);
    return null;
  }
}

async function registerAgent(uid, agentId, config) {
  if (!uid) throw new Error("uid requerido");
  if (!agentId) throw new Error("agentId requerido");
  if (!config || typeof config !== "object") throw new Error("config requerido");
  if (config.channel && !NOTIFICATION_CHANNELS.includes(config.channel)) {
    throw new Error("channel invalido: " + config.channel);
  }
  const data = {
    uid, agentId,
    name: config.name || agentId,
    channel: config.channel || "push",
    endpoint: config.endpoint || null,
    fcmToken: config.fcmToken || null,
    active: config.active !== false,
    createdAt: new Date().toISOString(),
  };
  try {
    await db().collection("tenants").doc(uid).collection("agents").doc(agentId).set(data);
    console.log("[AGENT_NOTIFIER] Agente registrado uid=" + uid.substring(0, 8) + " agentId=" + agentId);
  } catch (e) {
    console.error("[AGENT_NOTIFIER] Error registrando agente: " + e.message);
    throw e;
  }
}

async function notifyAgent(uid, agentId, ticketId, context) {
  if (!uid) throw new Error("uid requerido");
  if (!agentId) throw new Error("agentId requerido");
  if (!ticketId) throw new Error("ticketId requerido");
  const agentConfig = await getAgentConfig(uid, agentId);
  if (!agentConfig) {
    console.warn("[AGENT_NOTIFIER] Agente no encontrado uid=" + uid.substring(0, 8) + " agentId=" + agentId);
    return { notified: false, reason: "agent_not_found" };
  }
  if (!agentConfig.active) {
    return { notified: false, reason: "agent_inactive" };
  }
  const formattedContext = formatContextForAgent(context);
  const payload = {
    ticketId,
    leadPhone: context ? context.leadPhone : null,
    reason: context ? context.reason : null,
    contextSummary: formattedContext,
    timestamp: new Date().toISOString(),
  };

  if (agentConfig.channel === "webhook" && agentConfig.endpoint) {
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(function() { abortCtrl.abort(); }, 10000);
      try {
        await httpPost(agentConfig.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: abortCtrl.signal,
        });
      } finally { clearTimeout(timer); }
    } catch (e) {
      console.error("[AGENT_NOTIFIER] Error enviando webhook: " + e.message);
      return { notified: false, reason: "webhook_error" };
    }
  }

  try {
    const notifId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    await db().collection("agent_notifications").doc(uid).collection("sent").doc(notifId).set({
      uid, agentId, ticketId, payload, sentAt: new Date().toISOString(), channel: agentConfig.channel,
    });
  } catch (e) {
    console.error("[AGENT_NOTIFIER] Error guardando notif: " + e.message);
  }
  console.log("[AGENT_NOTIFIER] Notificacion enviada agentId=" + agentId + " ticketId=" + ticketId);
  return { notified: true, channel: agentConfig.channel };
}

async function getAgentNotificationHistory(uid, agentId) {
  if (!uid) throw new Error("uid requerido");
  if (!agentId) throw new Error("agentId requerido");
  try {
    const snap = await db().collection("agent_notifications").doc(uid).collection("sent")
      .where("agentId", "==", agentId).get();
    const results = [];
    snap.forEach(function(doc) { results.push(doc.data()); });
    return results.sort(function(a, b) { return new Date(b.sentAt) - new Date(a.sentAt); });
  } catch (e) {
    console.error("[AGENT_NOTIFIER] Error leyendo historial: " + e.message);
    return [];
  }
}

module.exports = {
  formatContextForAgent,
  registerAgent,
  getAgentConfig,
  notifyAgent,
  getAgentNotificationHistory,
  NOTIFICATION_CHANNELS,
  MAX_CONTEXT_MESSAGES,
  __setFirestoreForTests,
  __setHttpClientForTests,
};
