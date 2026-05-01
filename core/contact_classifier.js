'use strict';

/**
 * MIIA — Contact Classifier (T133)
 * Clasifica contactos en categorias (lead/client/bot/inactive/active)
 * basado en senales de comportamiento.
 */

const CONTACT_CATEGORIES = Object.freeze(['lead', 'client', 'bot', 'inactive', 'active', 'unknown']);

const CLASSIFICATION_WEIGHTS = Object.freeze({
  hasPurchase: 50,           // tiene compra registrada
  hasAppointment: 20,        // tiene cita/turno
  recentActivity7d: 15,      // activo en los ultimos 7 dias
  messageCount: 5,           // por cada mensaje (cap 20)
  hasEmail: 10,              // tiene email registrado
  longMessageRatio: 10,      // ratio de mensajes largos >50 chars
  botScore: -40,             // penaliza si parece bot (0-100 scale)
  inactiveDays: -2,          // penaliza por cada dia sin actividad (cap -30)
});

const CLIENT_THRESHOLD = 50;
const LEAD_THRESHOLD = 20;
const BOT_THRESHOLD = 60;     // botScore para clasificar directamente como bot
const INACTIVE_DAYS = 90;     // dias sin actividad = inactive

/**
 * Clasifica un contacto a partir de senales.
 * @param {object} signals
 * @param {boolean} [signals.hasPurchase]
 * @param {boolean} [signals.hasAppointment]
 * @param {number} [signals.lastActivityMs] - timestamp ultima actividad
 * @param {number} [signals.messageCount]
 * @param {boolean} [signals.hasEmail]
 * @param {number} [signals.longMessageRatio] 0-1
 * @param {number} [signals.botScore] 0-100
 * @param {number} [nowMs]
 * @returns {{ category: string, score: number, signals: object }}
 */
function classifyContact(signals = {}, nowMs = Date.now()) {
  if (!signals || typeof signals !== 'object') {
    return { category: 'unknown', score: 0, signals: {} };
  }

  const {
    hasPurchase = false,
    hasAppointment = false,
    lastActivityMs = null,
    messageCount = 0,
    hasEmail = false,
    longMessageRatio = 0,
    botScore = 0,
  } = signals;

  // Bot check inmediato
  if (botScore >= BOT_THRESHOLD) {
    return { category: 'bot', score: 0 - botScore, signals };
  }

  let score = 0;
  if (hasPurchase) score += CLASSIFICATION_WEIGHTS.hasPurchase;
  if (hasAppointment) score += CLASSIFICATION_WEIGHTS.hasAppointment;
  if (hasEmail) score += CLASSIFICATION_WEIGHTS.hasEmail;

  const msgBonus = Math.min(messageCount * CLASSIFICATION_WEIGHTS.messageCount, 20);
  score += msgBonus;

  const longRatio = Math.min(longMessageRatio, 1);
  score += longRatio * CLASSIFICATION_WEIGHTS.longMessageRatio;

  if (lastActivityMs) {
    const daysSince = (nowMs - lastActivityMs) / (24 * 60 * 60 * 1000);
    if (daysSince <= 7) score += CLASSIFICATION_WEIGHTS.recentActivity7d;
    const inactivePenalty = Math.min(Math.floor(daysSince) * Math.abs(CLASSIFICATION_WEIGHTS.inactiveDays), 30);
    score -= inactivePenalty;
  }

  score -= botScore * 0.3; // penalidad parcial por bot-like behavior

  let category;
  if (lastActivityMs && (nowMs - lastActivityMs) / (24 * 60 * 60 * 1000) > INACTIVE_DAYS) {
    category = 'inactive';
  } else if (score >= CLIENT_THRESHOLD) {
    category = 'client';
  } else if (score >= LEAD_THRESHOLD) {
    category = messageCount >= 3 ? 'active' : 'lead';
  } else {
    category = messageCount > 0 ? 'lead' : 'unknown';
  }

  return { category, score: parseFloat(score.toFixed(2)), signals };
}

module.exports = {
  classifyContact,
  CONTACT_CATEGORIES,
  CLASSIFICATION_WEIGHTS,
  CLIENT_THRESHOLD,
  LEAD_THRESHOLD,
  BOT_THRESHOLD,
  INACTIVE_DAYS,
};
