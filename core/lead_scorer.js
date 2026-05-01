'use strict';

/**
 * MIIA - Lead Scorer (T249)
 * P4.5 ROADMAP (Wi Bloque5 T232): scoring 0-100 de leads por comportamiento.
 * 0=spam/bot, 25=frio, 50=interesado, 75=caliente, 100=listo_para_cerrar.
 */

const SCORE_LABELS = Object.freeze({
  spam: { min: 0, max: 10, label: 'Spam/Bot', emoji: '🚫' },
  cold: { min: 11, max: 30, label: 'Frío', emoji: '🔵' },
  warm: { min: 31, max: 60, label: 'Interesado', emoji: '🟡' },
  hot: { min: 61, max: 85, label: 'Caliente', emoji: '🔴' },
  ready: { min: 86, max: 100, label: 'Listo para cerrar', emoji: '✅' },
});

const SCORING_SIGNALS = Object.freeze([
  'message_count', 'question_asked', 'price_inquired', 'name_provided',
  'contact_info_shared', 'appointment_requested', 'replied_quickly',
  'multiple_sessions', 'catalog_viewed', 'objection_raised',
]);

const MAX_SCORE = 100;
const MIN_SCORE = 0;
const SCORE_COLLECTION = 'lead_scores';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function getScoreLabel(score) {
  if (typeof score !== 'number') return null;
  var clamped = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));
  var keys = Object.keys(SCORE_LABELS);
  for (var i = 0; i < keys.length; i++) {
    var range = SCORE_LABELS[keys[i]];
    if (clamped >= range.min && clamped <= range.max) return { ...range, score: clamped };
  }
  return null;
}

function computeLeadScore(signals) {
  if (!signals || typeof signals !== 'object') return 0;
  var score = 10;

  var msgCount = signals.message_count || 0;
  if (msgCount >= 3) score += 10;
  if (msgCount >= 7) score += 10;
  if (msgCount >= 15) score += 5;

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

  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));
}

function buildScoreRecord(uid, phone, score, signals, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number') throw new Error('score debe ser numero');
  var clamped = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));
  var label = getScoreLabel(clamped);
  return {
    uid,
    phone,
    score: clamped,
    label: label ? label.label : 'Unknown',
    category: label ? Object.keys(SCORE_LABELS).find(function(k) { return SCORE_LABELS[k].label === label.label; }) : null,
    signals: signals || {},
    notes: (opts && opts.notes) ? String(opts.notes) : null,
    scoredAt: new Date().toISOString(),
    previousScore: (opts && typeof opts.previousScore === 'number') ? opts.previousScore : null,
    trend: null,
  };
}

function computeScoreTrend(currentScore, previousScore) {
  if (typeof previousScore !== 'number') return 'new';
  var diff = currentScore - previousScore;
  if (diff > 10) return 'rising';
  if (diff < -10) return 'falling';
  return 'stable';
}

async function saveLeadScore(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.phone) throw new Error('record invalido');
  var docId = record.phone.replace(/\D/g, '').slice(-10);
  await db().collection('tenants').doc(uid).collection(SCORE_COLLECTION).doc(docId).set(record, { merge: true });
  console.log('[SCORER] Guardado uid=' + uid + ' phone=' + record.phone + ' score=' + record.score + ' (' + record.label + ')');
  return docId;
}

async function getLeadScore(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var docId = phone.replace(/\D/g, '').slice(-10);
    var snap = await db().collection('tenants').doc(uid).collection(SCORE_COLLECTION).doc(docId).get();
    if (!snap || !snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[SCORER] Error leyendo score: ' + e.message);
    return null;
  }
}

async function scoreAndSaveLead(uid, phone, signals, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var previous = await getLeadScore(uid, phone);
  var previousScore = previous ? previous.score : null;
  var score = computeLeadScore(signals);
  var trend = computeScoreTrend(score, previousScore);
  var record = buildScoreRecord(uid, phone, score, signals, { ...opts, previousScore });
  record.trend = trend;
  await saveLeadScore(uid, record);
  return record;
}

async function getAllLeadScores(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(SCORE_COLLECTION).get();
    var scores = [];
    snap.forEach(function(doc) { scores.push(doc.data()); });
    if (opts && opts.minScore) scores = scores.filter(function(s) { return s.score >= opts.minScore; });
    if (opts && opts.category) scores = scores.filter(function(s) { return s.category === opts.category; });
    scores.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    return scores;
  } catch (e) {
    console.error('[SCORER] Error leyendo scores: ' + e.message);
    return [];
  }
}

function buildScoreText(record) {
  if (!record) return '';
  var label = getScoreLabel(record.score);
  var emoji = label ? label.emoji : '❓';
  var lines = [
    emoji + ' *Lead Score: ' + record.phone + '*',
    'Puntuación: ' + record.score + '/100 — ' + record.label,
    'Tendencia: ' + (record.trend || 'nueva'),
  ];
  if (record.signals) {
    var activeSignals = Object.entries(record.signals)
      .filter(function(e) { return e[1] === true || (typeof e[1] === 'number' && e[1] > 0); })
      .map(function(e) { return e[0]; });
    if (activeSignals.length > 0) lines.push('Señales: ' + activeSignals.join(', '));
  }
  return lines.join('\n');
}

module.exports = {
  computeLeadScore,
  buildScoreRecord,
  computeScoreTrend,
  saveLeadScore,
  getLeadScore,
  scoreAndSaveLead,
  getAllLeadScores,
  buildScoreText,
  getScoreLabel,
  SCORE_LABELS,
  SCORING_SIGNALS,
  MAX_SCORE,
  MIN_SCORE,
  __setFirestoreForTests,
};
