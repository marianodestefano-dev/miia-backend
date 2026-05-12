'use strict';

/**
 * MMC.2 — Extractor de hechos clave via Gemini
 * extractKeyFacts(apiKey, conversation, opts) -> [{fact, confidence}] | []
 * Prompt separado, timeout 15s, falla silenciosa.
 */

const { callGemini, __setFetchForTests } = require('../ai/gemini_client');

const MAX_FACTS = 5;
const FACT_TIMEOUT_MS = 15000;
const HISTORY_MSGS = 10;

function _buildPrompt(history) {
  return 'Del siguiente historial de conversacion, extrae max 5 hechos importantes sobre el contacto (no sobre el asistente). Responde SOLO con un array JSON valido: [{"fact": "...", "confidence": "high" o "medium"}]. Si no hay hechos relevantes, responde [].\n\nHISTORIAL:\n' + history;
}

/**
 * Extrae hechos clave de una conversacion via Gemini.
 * @param {string} apiKey
 * @param {Array<{role: string, content: string}>} conversation
 * @param {object} [opts] - { model, uid }
 * @returns {Promise<Array<{fact: string, confidence: string}>>}
 */
async function extractKeyFacts(apiKey, conversation, opts) {
  if (!apiKey) return [];
  if (!Array.isArray(conversation) || conversation.length === 0) return [];

  const recentMsgs = conversation.slice(-HISTORY_MSGS);
  const history = recentMsgs.map(function(m) {
    var label = m.role === 'user' ? 'Contacto' : 'MIIA';
    return label + ': ' + (m.content || '').substring(0, 200);
  }).join('\n');

  var prompt = _buildPrompt(history);
  try {
    var text = await callGemini(apiKey, prompt, {
      retries: 0,
      timeout: FACT_TIMEOUT_MS,
      model: (opts && opts.model) || 'gemini-2.5-flash',
      uid: opts && opts.uid,
    });
    var match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    var parsed = JSON.parse(match[0]);
    /* istanbul ignore next */ if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(function(f) {
        return f && typeof f.fact === 'string' && f.fact.length > 0 &&
               (f.confidence === 'high' || f.confidence === 'medium');
      })
      .slice(0, MAX_FACTS);
  } catch (e) {
    console.warn('[FACT-EXTRACTOR] Error: ' + e.message);
    return [];
  }
}

module.exports = { extractKeyFacts, MAX_FACTS, FACT_TIMEOUT_MS, __setFetchForTests };
