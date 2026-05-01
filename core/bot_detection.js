'use strict';
/**
 * MIIA — Bot Detection (T118)
 * Heurísticas para detectar si un contacto es bot.
 * Señales: respuestas ultra-rápidas, mensajes idénticos repetidos, patrones de texto.
 */

const MIN_HUMAN_RESPONSE_MS = 2000; // < 2s = sospechoso
const BOT_REPEAT_THRESHOLD = 3;     // 3+ msgs idénticos = bot
const BOT_SCORE_THRESHOLD = 60;     // score >= 60 = probablemente bot

/**
 * Calcula un score de probabilidad de ser bot (0-100).
 * @param {Array<{text?: string, timestamp?: number, fromMe?: boolean}>} messages
 * @returns {{ score: number, signals: string[], verdict: 'bot'|'human'|'unknown' }}
 */
function calculateBotScore(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { score: 0, signals: [], verdict: 'unknown' };
  }
  const signals = [];
  let score = 0;

  const contactMsgs = messages.filter(m => !m.fromMe);
  if (contactMsgs.length === 0) return { score: 0, signals: [], verdict: 'unknown' };

  // Señal 1: respuestas ultra-rápidas (< 2s entre mensajes consecutivos del contacto)
  const contactTs = contactMsgs
    .filter(m => typeof m.timestamp === 'number')
    .map(m => m.timestamp)
    .sort((a, b) => a - b);

  let ultraFastCount = 0;
  for (let i = 1; i < contactTs.length; i++) {
    if (contactTs[i] - contactTs[i-1] < MIN_HUMAN_RESPONSE_MS) ultraFastCount++;
  }
  if (ultraFastCount > 0) {
    const factor = Math.min(ultraFastCount * 10, 30);
    score += factor;
    signals.push(`ultra_fast_responses:${ultraFastCount}`);
  }

  // Señal 2: mensajes idénticos repetidos
  const textCounts = {};
  for (const m of contactMsgs) {
    if (m.text) {
      textCounts[m.text] = (textCounts[m.text] || 0) + 1;
    }
  }
  const maxRepeat = Math.max(0, ...Object.values(textCounts));
  if (maxRepeat >= BOT_REPEAT_THRESHOLD) {
    score += Math.min(maxRepeat * 15, 40);
    signals.push(`repeated_messages:${maxRepeat}`);
  }

  // Señal 3: todos los mensajes son cortos y uniformes (< 10 chars, stddev baja)
  const texts = contactMsgs.filter(m => typeof m.text === 'string');
  if (texts.length >= 3) {
    const lengths = texts.map(m => m.text.length);
    const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;
    const allShort = avg < 10;
    if (allShort) {
      score += 15;
      signals.push('all_short_messages');
    }
  }

  score = Math.min(score, 100);
  const verdict = score >= BOT_SCORE_THRESHOLD ? 'bot' : score >= 20 ? 'unknown' : 'human';

  return { score, signals, verdict };
}

module.exports = { calculateBotScore, BOT_SCORE_THRESHOLD, MIN_HUMAN_RESPONSE_MS };
