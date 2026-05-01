'use strict';

/**
 * ANTI-LOOP INPUT REPETIDO — T74 Vi 2026-04-30 (CLAUDE.md §6.21 PENDIENTE)
 *
 * Bug origen: incidente bot Coordinadora 2026-04-14 (C-013).
 *   - Bot externo repitió 2 mensajes IDÉNTICOS al MIIA tenant.
 *   - Gemini con historial creciente generó 4+ variantes distintas a cada vuelta.
 *   - Resultado: loop infinito ~50 msgs en 1 min antes de que rate_limiter
 *     per-contact lo cortara.
 *
 * Anti-loop por eco (lastSentByBot) NO sirve — MIIA genera respuestas
 * distintas aunque input sea igual.
 *
 * Fix §6.21: detectar INPUT del contacto repetido (no output de MIIA).
 *   - Si contacto envía msg idéntico o ≥95% similar en <5 min → NO regenerar.
 *   - Retornar respuesta corta canned o silenciar.
 *
 * IMPACTO USUARIO:
 *   - Owner deja de ver 50 notificaciones de loop con bots externos.
 *   - Rate limiter per-contact (5 msgs/30s) sigue como segunda línea defensa.
 *   - Esta es la PRIMERA línea: detección antes de Gemini call.
 *
 * Diseño:
 *   - State per-tenant per-phone: ring buffer último N inputs (default 5)
 *     con timestamp + hash + texto normalizado.
 *   - shouldRegenerate(ctx, phone, currentInput) → {regenerate, reason, similarity}
 *   - similarity ≥0.95 con cualquier entry <5min → regenerate=false.
 *
 * Wire-in en TMH antes de Gemini call queda para T-future con firma
 * (zona crítica §5 server.js / TMH). Modulo standalone hasta firma.
 *
 * Standard: Google + Amazon + NASA — pure functions, observable, zero PII.
 */

const WINDOW_MS = 5 * 60 * 1000;       // 5 min ventana
const SIMILARITY_THRESHOLD = 0.95;     // ≥95% considerado "mismo input"
const MAX_BUFFER_PER_PHONE = 5;        // último N inputs trackeados por phone

// State map: { "uid:phone": [{ ts, normHash, normText }, ...] }
const _inputState = {};

function _key(uid, phone) {
  return `${uid}:${phone}`;
}

/**
 * Normaliza texto para comparacion: lowercase, trim, remove accents,
 * collapse whitespace.
 */
function normalizeForCompare(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hash determinístico SHA-256 de texto normalizado (8 chars hex prefix).
 * Solo para dedup eficiente — no para tampering check.
 */
function _shortHash(text) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Levenshtein-like ratio simplificado: comparte tokens / total tokens único.
 * Más rápido que Levenshtein full y suficiente para detectar bot repetido.
 *
 * @param {string} normA - texto A normalizado
 * @param {string} normB - texto B normalizado
 * @returns {number} 0-1 (1 = idéntico)
 */
function tokenSimilarity(normA, normB) {
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  const tokensA = new Set(normA.split(/\s+/).filter(Boolean));
  const tokensB = new Set(normB.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersect = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersect++;
  }
  // Jaccard-like pero biased a similitud (denomina max para penalizar dif length)
  const denom = Math.max(tokensA.size, tokensB.size);
  return intersect / denom;
}

/**
 * Decide si MIIA debe regenerar respuesta para este input nuevo.
 * Si el input es muy similar (≥95%) a alguno previo en ventana 5min → NO regenerar.
 *
 * @param {string} uid - tenant uid
 * @param {string} phone - phone del contacto
 * @param {string} currentInput - texto del mensaje entrante
 * @returns {{regenerate: boolean, reason: string, similarity?: number, repeatedAt?: number}}
 */
function shouldRegenerate(uid, phone, currentInput) {
  if (!uid || !phone) {
    return { regenerate: true, reason: 'invalid_args' };
  }
  const norm = normalizeForCompare(currentInput);
  if (!norm) {
    return { regenerate: true, reason: 'empty_input' };
  }
  if (norm.length < 3) {
    // muy corto (ej: "ok", "si") — siempre regenerar
    return { regenerate: true, reason: 'short_input' };
  }

  const key = _key(uid, phone);
  const buf = _inputState[key] || [];
  const now = Date.now();

  // Limpiar entries fuera de ventana
  const fresh = buf.filter(e => (now - e.ts) <= WINDOW_MS);

  // Comparar contra cada entry fresca
  let bestSim = 0;
  let bestEntry = null;
  for (const entry of fresh) {
    if (entry.normHash === _shortHash(norm)) {
      // Match exacto por hash
      bestSim = 1;
      bestEntry = entry;
      break;
    }
    const sim = tokenSimilarity(norm, entry.normText);
    if (sim > bestSim) {
      bestSim = sim;
      bestEntry = entry;
    }
  }

  if (bestSim >= SIMILARITY_THRESHOLD && bestEntry) {
    console.log(`[ANTI-LOOP] 🔄 ${uid.slice(0,8)}... ***${phone.slice(-4)} repeat detectado — similarity: ${Math.round(bestSim*100)}% (${bestSim === 1 ? 'exact_repeat' : 'high_sim'}) | descartando regeneracion`); // T90: log critico para troubleshooting
    return {
      regenerate: false,
      reason: bestSim === 1 ? 'exact_repeat' : 'high_similarity',
      similarity: bestSim,
      repeatedAt: bestEntry.ts,
    };
  }

  return { regenerate: true, reason: 'novel_input', similarity: bestSim };
}

/**
 * Registrar un input que SÍ se procesó (post-Gemini call exitoso).
 * Ring buffer max N por phone.
 */
function recordInput(uid, phone, currentInput) {
  if (!uid || !phone) return;
  const norm = normalizeForCompare(currentInput);
  if (!norm) return;
  const key = _key(uid, phone);
  if (!_inputState[key]) _inputState[key] = [];
  _inputState[key].push({
    ts: Date.now(),
    normHash: _shortHash(norm),
    normText: norm,
  });
  // Trim a MAX_BUFFER_PER_PHONE
  if (_inputState[key].length > MAX_BUFFER_PER_PHONE) {
    _inputState[key] = _inputState[key].slice(-MAX_BUFFER_PER_PHONE);
  }
}

/**
 * Cleanup entries con todos los inputs fuera de ventana.
 * Best-effort llamable periódicamente o por tests.
 */
function cleanupStale() {
  const now = Date.now();
  for (const [key, buf] of Object.entries(_inputState)) {
    const fresh = buf.filter(e => (now - e.ts) <= WINDOW_MS);
    if (fresh.length === 0) {
      delete _inputState[key];
    } else if (fresh.length !== buf.length) {
      _inputState[key] = fresh;
    }
  }
}

/**
 * Stats para health endpoints (cuántos phones trackeados).
 */
function getStats() {
  const totalPhones = Object.keys(_inputState).length;
  let totalEntries = 0;
  for (const buf of Object.values(_inputState)) totalEntries += buf.length;
  return {
    tracked_phones: totalPhones,
    total_entries: totalEntries,
    window_ms: WINDOW_MS,
    similarity_threshold: SIMILARITY_THRESHOLD,
    max_buffer_per_phone: MAX_BUFFER_PER_PHONE,
  };
}

/**
 * Resetear todo (solo tests).
 */
function _resetForTests() {
  for (const k of Object.keys(_inputState)) delete _inputState[k];
}

module.exports = {
  shouldRegenerate,
  recordInput,
  cleanupStale,
  getStats,
  // Helpers exportados para tests
  normalizeForCompare,
  tokenSimilarity,
  WINDOW_MS,
  SIMILARITY_THRESHOLD,
  MAX_BUFFER_PER_PHONE,
  // Test-only
  _resetForTests,
};
