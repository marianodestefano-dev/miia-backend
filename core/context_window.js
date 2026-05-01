'use strict';

/**
 * MIIA — Context Window (T142)
 * Gestiona la ventana de historial de conversacion enviada al LLM.
 * Limita por numero de mensajes y por tokens estimados.
 */

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_TOKENS = 8000;
const TOKENS_PER_CHAR = 0.25; // estimacion: 1 token ~ 4 chars

/**
 * Estima la cantidad de tokens en un texto.
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Estima tokens de un mensaje { role, content }.
 */
function estimateMessageTokens(msg) {
  if (!msg) return 0;
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
  return estimateTokens(content) + 4; // 4 tokens de overhead por mensaje
}

/**
 * Construye la ventana de contexto a partir del historial completo.
 * Mantiene los mensajes MAS RECIENTES dentro de los limites.
 * @param {Array<{ role: string, content: string, timestamp? }>} messages
 * @param {object} opts
 * @param {number} [opts.maxMessages]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.systemPrompt] - si se pasa, descuenta sus tokens del budget
 * @returns {{ window: Array, estimatedTokens: number, truncated: boolean, droppedCount: number }}
 */
function buildContextWindow(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { window: [], estimatedTokens: 0, truncated: false, droppedCount: 0 };
  }

  const maxMessages = opts.maxMessages || DEFAULT_MAX_MESSAGES;
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;

  let tokenBudget = maxTokens;
  if (opts.systemPrompt) {
    tokenBudget -= estimateTokens(opts.systemPrompt);
  }

  // Tomar los mensajes mas recientes primero
  const recent = messages.slice(-maxMessages);
  const result = [];
  let totalTokens = 0;

  // Recorrer de mas reciente a mas antiguo para respetar el budget
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    const msgTokens = estimateMessageTokens(msg);
    if (totalTokens + msgTokens > tokenBudget) break;
    result.unshift(msg);
    totalTokens += msgTokens;
  }

  const droppedCount = messages.length - result.length;

  return {
    window: result,
    estimatedTokens: totalTokens,
    truncated: droppedCount > 0,
    droppedCount,
  };
}

/**
 * Normaliza un mensaje al formato { role, content }.
 * @param {{ role?, text?, fromMe?, timestamp? }} rawMsg
 * @returns {{ role: string, content: string }}
 */
function normalizeMessage(rawMsg) {
  if (!rawMsg || typeof rawMsg !== 'object') return null;
  const role = rawMsg.role || (rawMsg.fromMe ? 'assistant' : 'user');
  const content = rawMsg.content || rawMsg.text || '';
  return { role, content };
}

module.exports = {
  buildContextWindow,
  normalizeMessage,
  estimateTokens,
  estimateMessageTokens,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_TOKENS,
  TOKENS_PER_CHAR,
};
