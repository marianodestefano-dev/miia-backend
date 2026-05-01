'use strict';
/**
 * MIIA — Conversation Summarizer (T116)
 * Genera resúmenes estadísticos de conversaciones para compresión de contexto.
 * No usa IA — puramente algorítmico basado en metadata.
 */

const MAX_SUMMARY_MESSAGES = 5;

/**
 * Genera un resumen estadístico de una conversación.
 * @param {Array<{text?: string, timestamp?: number, fromMe?: boolean}>} messages
 * @param {{ maxPreview?: number }} opts
 */
function summarizeConversation(messages, { maxPreview = MAX_SUMMARY_MESSAGES } = {}) {
  if (!Array.isArray(messages)) return { messageCount: 0, preview: [], stats: {} };

  const total = messages.length;
  const fromMe = messages.filter(m => m.fromMe === true).length;
  const fromContact = total - fromMe;

  // Timestamps
  const timestamps = messages.filter(m => typeof m.timestamp === 'number').map(m => m.timestamp);
  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : null;

  // Longitud media de mensajes
  const texts = messages.filter(m => typeof m.text === 'string' && m.text.length > 0);
  const avgLength = texts.length > 0
    ? Math.round(texts.reduce((s, m) => s + m.text.length, 0) / texts.length)
    : 0;

  // Preview: últimos N mensajes
  const preview = messages.slice(-maxPreview).map(m => ({
    text: typeof m.text === 'string' ? m.text.substring(0, 100) : '',
    fromMe: !!m.fromMe,
    timestamp: m.timestamp || null,
  }));

  return {
    messageCount: total,
    fromMe, fromContact,
    oldestTimestamp: oldest,
    newestTimestamp: newest,
    avgMessageLength: avgLength,
    preview,
  };
}

/**
 * Comprime múltiples conversaciones en un objeto sumario para el prompt.
 */
function buildContextSummary(conversations) {
  if (!conversations || typeof conversations !== 'object') return { total: 0, summaries: {} };
  const phones = Object.keys(conversations);
  const summaries = {};
  for (const phone of phones) {
    summaries[phone] = summarizeConversation(conversations[phone]);
  }
  return { total: phones.length, summaries };
}

module.exports = { summarizeConversation, buildContextSummary };
