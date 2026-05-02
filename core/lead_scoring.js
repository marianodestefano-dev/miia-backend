'use strict';

/**
 * lead_scoring.js -- T316 + T114 (lead scoring por leadData con breakdown).
 * API:
 *   calculateLeadScore(leadData, now?) -> { score, breakdown: {...} }
 *   classifyLeadScore(score) -> 'unqualified'|'cold'|'warm'|'hot'
 * Constants: SCORE_WEIGHTS (frozen), MAX_SCORE
 *
 * Legacy: computeLeadScore(messages) preservado.
 */

const SCORE_WEIGHTS = Object.freeze({
  messagePerCount: 2,
  messageCountCap: 30,
  hasEmail: 15,
  hasName: 10,
  recentActivityWindow: 7 * 24 * 60 * 60 * 1000,
  recentActivityScore: 20,
  longMessageThreshold: 50,
  longMessageScore: 5,
  hasAppointment: 20,
});
const MAX_SCORE = 100;

function calculateLeadScore(leadData, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const breakdown = {
    messageCount: 0,
    hasEmail: 0,
    hasName: 0,
    recentActivity: 0,
    longMessages: 0,
    hasAppointment: 0,
  };
  if (!leadData || typeof leadData !== 'object') {
    return { score: 0, breakdown };
  }

  const messages = Array.isArray(leadData.messages) ? leadData.messages : [];
  breakdown.messageCount = Math.min(SCORE_WEIGHTS.messageCountCap, messages.length * SCORE_WEIGHTS.messagePerCount);

  const enr = leadData.enrichment || {};
  if (enr.email) breakdown.hasEmail = SCORE_WEIGHTS.hasEmail;
  if (enr.name) breakdown.hasName = SCORE_WEIGHTS.hasName;

  // recentActivity: alguno de los messages dentro de la ventana
  let recent = false;
  for (const m of messages) {
    if (m && m.timestamp && (t - m.timestamp) <= SCORE_WEIGHTS.recentActivityWindow) {
      recent = true; break;
    }
  }
  if (recent) breakdown.recentActivity = SCORE_WEIGHTS.recentActivityScore;

  // longMessages: al menos un mensaje > threshold chars
  let longFound = false;
  for (const m of messages) {
    if (m && typeof m.text === 'string' && m.text.length > SCORE_WEIGHTS.longMessageThreshold) {
      longFound = true; break;
    }
  }
  if (longFound) breakdown.longMessages = SCORE_WEIGHTS.longMessageScore;

  if (leadData.hasAppointment === true) breakdown.hasAppointment = SCORE_WEIGHTS.hasAppointment;

  let total = breakdown.messageCount + breakdown.hasEmail + breakdown.hasName + breakdown.recentActivity + breakdown.longMessages + breakdown.hasAppointment;
  if (total > MAX_SCORE) total = MAX_SCORE;
  return { score: total, breakdown };
}

function classifyLeadScore(score) {
  if (typeof score !== 'number') return 'unqualified';
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  if (score >= 10) return 'cold';
  return 'unqualified';
}

// LEGACY -- computeLeadScore por messages array de role lead/miia
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const SCORE_FACTORS = Object.freeze({
  message_frequency: 0.30,
  response_rate: 0.25,
  intent_signals: 0.25,
  recency: 0.20,
});
const INTENT_KEYWORDS = Object.freeze(['precio', 'cuanto', 'comprar', 'reservar', 'contratar', 'cuando', 'disponible', 'costo']);

function computeLeadScore(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { score: 0, factors: {}, breakdown: {} };
  const leadMsgs = messages.filter(m => m.role === 'lead');
  const miaMsgs = messages.filter(m => m.role === 'miia');
  const freqScore = Math.min(100, leadMsgs.length * 10);
  const responseRate = miaMsgs.length > 0 ? Math.min(100, (miaMsgs.length / Math.max(leadMsgs.length, 1)) * 100) : 0;
  const allText = leadMsgs.map(m => (m.content || '').toLowerCase()).join(' ');
  const intentCount = INTENT_KEYWORDS.filter(k => allText.includes(k)).length;
  const intentScore = Math.min(100, intentCount * 20);
  const lastMsg = leadMsgs[leadMsgs.length - 1];
  const lastTs = lastMsg && lastMsg.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
  const ageH = lastTs > 0 ? (Date.now() - lastTs) / 3600000 : 999;
  const recencyScore = ageH < 1 ? 100 : ageH < 24 ? 80 : ageH < 72 ? 50 : ageH < 168 ? 20 : 0;
  const score = Math.round(
    freqScore * SCORE_FACTORS.message_frequency +
    responseRate * SCORE_FACTORS.response_rate +
    intentScore * SCORE_FACTORS.intent_signals +
    recencyScore * SCORE_FACTORS.recency
  );
  return {
    score,
    factors: { freqScore, responseRate, intentScore, recencyScore },
    breakdown: { lead_msgs: leadMsgs.length, miia_msgs: miaMsgs.length, intent_keywords_found: intentCount },
  };
}

async function scoreLeadFromDb(uid, phone) {
  if (!uid || !phone) throw new Error('uid+phone requeridos');
  const snap = await getDb().collection('owners').doc(uid).collection('conversations').doc(phone).collection('messages').get();
  const messages = [];
  snap.forEach(d => messages.push(d.data ? d.data() : {}));
  return computeLeadScore(messages);
}

module.exports = {
  // T316/T114 API
  calculateLeadScore,
  classifyLeadScore,
  SCORE_WEIGHTS,
  MAX_SCORE,
  // Legacy
  computeLeadScore,
  scoreLeadFromDb,
  SCORE_FACTORS,
  INTENT_KEYWORDS,
  __setFirestoreForTests,
};
