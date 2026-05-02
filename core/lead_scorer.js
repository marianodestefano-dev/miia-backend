'use strict';

/**
 * lead_scorer.js -- T164 + T165 (lead scoring V2 con alertas).
 * API publica:
 *   calculateScore(interactions, now?) -> { score, level, interactions }
 *   recordInteraction(uid, phone, type, opts?) -> Promise<void>
 *   getLeadInteractions(uid, phone) -> Promise<array>
 *   checkAlertThreshold(uid, phone, score, threshold?) -> Promise<{shouldAlert, score}>
 *   getPendingAlerts(uid) -> Promise<array>
 * Constants: INTERACTION_WEIGHTS (frozen), DEFAULT_ALERT_THRESHOLD, MAX_SCORE, SCORE_DECAY_DAYS, LEVELS
 *
 * Legacy: computeLeadScore(signals) preservado para callers viejos.
 */

const INTERACTION_WEIGHTS = Object.freeze({
  message_sent: 2,
  message_received: 2,
  catalog_view: 4,
  price_inquiry: 8,
  appointment_request: 12,
  payment_initiated: 18,
  catalog_purchase: 25,
  payment_received: 30,
});

const VALID_TYPES = Object.freeze(Object.keys(INTERACTION_WEIGHTS));
const DEFAULT_ALERT_THRESHOLD = 20;
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const SCORE_DECAY_DAYS = 30;
const SCORING_SIGNALS = Object.freeze([
  'message_count', 'question_asked', 'price_inquired', 'name_provided',
  'contact_info_shared', 'appointment_requested', 'replied_quickly',
  'multiple_sessions', 'catalog_viewed', 'objection_raised',
]);
const LEVELS = Object.freeze({ cold: 'cold', interested: 'interested', warm: 'warm', hot: 'hot' });

const COL_INTERACTIONS = 'lead_interactions';
const COL_ALERTS = 'lead_score_alerts';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function _levelFromScore(score) {
  if (score >= 60) return 'hot';
  if (score >= 30) return 'warm';
  if (score >= 10) return 'interested';
  return 'cold';
}

function calculateScore(interactions, now) {
  if (!Array.isArray(interactions)) throw new Error('interactions debe ser array');
  const t = typeof now === 'number' ? now : Date.now();
  if (interactions.length === 0) return { score: 0, level: 'cold', interactions: 0 };

  const decayMs = SCORE_DECAY_DAYS * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const it of interactions) {
    if (!it || !it.type) continue;
    const ts = it.timestamp ? new Date(it.timestamp).getTime() : t;
    const ageMs = t - ts;
    if (ageMs > decayMs) continue;
    const baseW = typeof it.weight === 'number' ? it.weight : INTERACTION_WEIGHTS[it.type];
    if (!baseW) continue;
    const decay = 1 - (ageMs / decayMs);
    total += baseW * Math.max(0.1, decay);
  }
  const score = Math.min(MAX_SCORE, Math.round(total));
  return { score, level: _levelFromScore(score), interactions: interactions.length };
}

async function recordInteraction(uid, phone, type, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!VALID_TYPES.includes(type)) throw new Error('tipo invalido: ' + type);
  const meta = opts || {};
  const doc = {
    type,
    timestamp: new Date().toISOString(),
    weight: INTERACTION_WEIGHTS[type],
    note: meta.note || null,
  };
  await db().collection('owners').doc(uid).collection(COL_INTERACTIONS).doc(phone).collection('events').doc().set(doc);
}

async function getLeadInteractions(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  const snap = await db().collection('owners').doc(uid).collection(COL_INTERACTIONS).doc(phone).collection('events').get();
  const out = [];
  snap.forEach(d => out.push(d.data ? d.data() : {}));
  return out;
}

async function checkAlertThreshold(uid, phone, score, threshold) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number') throw new Error('score debe ser numero');
  const thr = typeof threshold === 'number' ? threshold : DEFAULT_ALERT_THRESHOLD;
  const shouldAlert = score >= thr;
  if (shouldAlert) {
    try {
      await db().collection('owners').doc(uid).collection(COL_ALERTS).doc('global').collection('events').doc().set({
        phone, score, threshold: thr, createdAt: new Date().toISOString(), status: 'pending',
      });
    } catch (e) {
      // fail-soft: alerta best-effort
    }
  }
  return { shouldAlert, score, threshold: thr };
}

async function getPendingAlerts(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('owners').doc(uid).collection(COL_ALERTS).doc('global').collection('events').where('status', '==', 'pending').get();
    const out = [];
    snap.forEach(d => out.push(d.data ? d.data() : {}));
    return out;
  } catch (e) {
    return []; // fail-open
  }
}

// LEGACY (computeLeadScore basado en signals object)
const SCORE_LABELS = Object.freeze({
  spam: { min: 0, max: 10, label: 'Spam/Bot', emoji: '🚫' },
  cold: { min: 11, max: 30, label: 'Frío', emoji: '🔵' },
  warm: { min: 31, max: 60, label: 'Interesado', emoji: '🟡' },
  hot: { min: 61, max: 85, label: 'Caliente', emoji: '🔴' },
  ready: { min: 86, max: 100, label: 'Listo para cerrar', emoji: '✅' },
});

function getScoreLabel(score) {
  if (typeof score !== 'number') return null;
  const c = Math.max(0, Math.min(MAX_SCORE, Math.round(score)));
  for (const k of Object.keys(SCORE_LABELS)) {
    const r = SCORE_LABELS[k];
    if (c >= r.min && c <= r.max) return { ...r, score: c };
  }
  return null;
}

function computeLeadScore(signals) {
  if (!signals || typeof signals !== 'object') return 0;
  let score = 10;
  const m = signals.message_count || 0;
  if (m >= 3) score += 10;
  if (m >= 7) score += 10;
  if (m >= 15) score += 5;
  if (signals.question_asked) score += 10;
  if (signals.price_inquired) score += 20;
  if (signals.name_provided) score += 5;
  if (signals.contact_info_shared) score += 10;
  if (signals.appointment_requested) score += 20;
  if (signals.replied_quickly) score += 5;
  if (signals.multiple_sessions) score += 5;
  if (signals.catalog_viewed) score += 5;
  if (signals.objection_raised) score -= 10;
  if (signals.is_spam || signals.is_bot) return 5;
  return Math.max(0, Math.min(MAX_SCORE, Math.round(score)));
}


// Legacy helpers (intent scorer / pricing)
function buildScoreRecord(uid, phone, score, signals, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number') throw new Error('score debe ser numero');
  const clamped = Math.max(0, Math.min(MAX_SCORE, Math.round(score)));
  const label = getScoreLabel(clamped);
  return {
    uid,
    phone,
    score: clamped,
    label: label ? label.label : 'Unknown',
    category: label ? Object.keys(SCORE_LABELS).find(k => SCORE_LABELS[k].label === label.label) : null,
    signals: signals || {},
    notes: (opts && opts.notes) ? String(opts.notes) : null,
    scoredAt: new Date().toISOString(),
  };
}

function computeScoreTrend(currentScore, previousScore) {
  if (typeof currentScore !== 'number') return 'new';
  if (typeof previousScore !== 'number') return 'new';
  const diff = currentScore - previousScore;
  if (diff > 5) return 'rising';
  if (diff < -5) return 'falling';
  return 'stable';
}

module.exports = {
  // T164/T180/T316 API
  calculateScore,
  recordInteraction,
  getLeadInteractions,
  checkAlertThreshold,
  getPendingAlerts,
  INTERACTION_WEIGHTS,
  DEFAULT_ALERT_THRESHOLD,
  MIN_SCORE,
  MAX_SCORE,
  SCORE_DECAY_DAYS,
  SCORING_SIGNALS,
  LEVELS,
  __setFirestoreForTests,
  // Legacy
  computeLeadScore,
  getScoreLabel,
  SCORE_LABELS,
  buildScoreRecord,
  computeScoreTrend,
};
