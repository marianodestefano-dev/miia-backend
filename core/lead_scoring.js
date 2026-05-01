'use strict';
/**
 * MIIA — Lead Scoring (T114)
 * Calcula un score de calidad del lead (0-100) basado en interacciones.
 */

const SCORE_WEIGHTS = Object.freeze({
  messageCount: 2,      // +2 por mensaje (max 30)
  hasEmail: 15,         // +15 si tiene email
  hasName: 10,          // +10 si tiene nombre
  recentActivity: 20,   // +20 si tiene actividad en 7 dias
  longMessages: 5,      // +5 si tiene mensajes de mas de 50 chars
  hasAppointment: 20,   // +20 si solicitó turno
});

const MAX_SCORE = 100;
const RECENT_DAYS = 7;

/**
 * Calcula el score de un lead.
 * @param {{ messages: Array, enrichment?: object, hasAppointment?: boolean }} leadData
 * @param {number} [nowMs]
 * @returns {{ score: number, breakdown: object }}
 */
function calculateLeadScore(leadData, nowMs = Date.now()) {
  if (!leadData || typeof leadData !== 'object') return { score: 0, breakdown: {} };
  const msgs = Array.isArray(leadData.messages) ? leadData.messages : [];
  const enrich = leadData.enrichment || {};
  const breakdown = {};

  // Message count (max 30 pts de 15 mensajes = 2pts cada uno)
  const msgPts = Math.min(msgs.length * SCORE_WEIGHTS.messageCount, 30);
  breakdown.messageCount = msgPts;

  // Has email
  const emailPts = enrich.email ? SCORE_WEIGHTS.hasEmail : 0;
  breakdown.hasEmail = emailPts;

  // Has name
  const namePts = enrich.name ? SCORE_WEIGHTS.hasName : 0;
  breakdown.hasName = namePts;

  // Recent activity (mensajes en ultimos 7 dias)
  const recentThreshold = nowMs - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recentMsgs = msgs.filter(m => typeof m.timestamp === 'number' && m.timestamp >= recentThreshold);
  const recentPts = recentMsgs.length > 0 ? SCORE_WEIGHTS.recentActivity : 0;
  breakdown.recentActivity = recentPts;

  // Long messages (>50 chars)
  const longMsgs = msgs.filter(m => typeof m.text === 'string' && m.text.length > 50);
  const longPts = longMsgs.length > 0 ? SCORE_WEIGHTS.longMessages : 0;
  breakdown.longMessages = longPts;

  // Has appointment
  const apptPts = leadData.hasAppointment ? SCORE_WEIGHTS.hasAppointment : 0;
  breakdown.hasAppointment = apptPts;

  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  const score = Math.min(total, MAX_SCORE);

  return { score, breakdown };
}

/**
 * Clasifica el score en categorias.
 */
function classifyLeadScore(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  if (score >= 10) return 'cold';
  return 'unqualified';
}

module.exports = { calculateLeadScore, classifyLeadScore, SCORE_WEIGHTS, MAX_SCORE };
