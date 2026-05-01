'use strict';

const SUMMARY_TYPES = Object.freeze(['quick', 'full', 'daily', 'handoff']);
const SENTIMENT_LABELS = Object.freeze(['very_positive', 'positive', 'neutral', 'negative', 'very_negative']);

const POSITIVE_WORDS = Object.freeze([
  'gracias', 'excelente', 'perfecto', 'genial', 'buenisimo', 'encantado',
  'feliz', 'contento', 'satisfecho', 'maravilloso', 'increible', 'super',
  'buenisimo', 'chevere', 'de lujo', 'de puta madre', 'espectacular',
]);

const NEGATIVE_WORDS = Object.freeze([
  'mal', 'terrible', 'pesimo', 'desastre', 'molesto', 'enojado', 'furioso',
  'decepcionado', 'frustrado', 'problema', 'falla', 'error', 'queja',
  'reclamo', 'horrible', 'imposible', 'nunca', 'inaceptable',
]);

const MAX_MESSAGES_FOR_SUMMARY = 20;
const SUMMARY_COLLECTION = 'conversation_summaries';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidSummaryType(t) { return SUMMARY_TYPES.includes(t); }
function isValidSentiment(s) { return SENTIMENT_LABELS.includes(s); }

function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function detectSentiment(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { label: 'neutral', score: 0, positiveHits: 0, negativeHits: 0 };
  }
  const recent = messages.slice(-MAX_MESSAGES_FOR_SUMMARY);
  let positiveHits = 0;
  let negativeHits = 0;
  for (const msg of recent) {
    const text = normalizeText(typeof msg === 'string' ? msg : (msg.text || msg.message || msg.body || ''));
    for (const w of POSITIVE_WORDS) { if (text.includes(w)) positiveHits++; }
    for (const w of NEGATIVE_WORDS) { if (text.includes(w)) negativeHits++; }
  }
  const total = positiveHits + negativeHits;
  let score = 0;
  if (total > 0) score = Math.round(((positiveHits - negativeHits) / total) * 100) / 100;
  let label = 'neutral';
  if (score >= 0.6) label = 'very_positive';
  else if (score >= 0.2) label = 'positive';
  else if (score <= -0.6) label = 'very_negative';
  else if (score <= -0.2) label = 'negative';
  return { label, score, positiveHits, negativeHits };
}

function getKeyMoments(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const moments = [];
  const priceKws = ['precio', 'costo', 'cuanto cuesta', 'valor', 'tarifa', 'presupuesto', 'cotizacion'];
  const appointKws = ['turno', 'cita', 'reservar', 'agendar', 'horario'];
  const objectionKws = ['no puedo', 'no me interesa', 'muy caro', 'pensarlo', 'no por ahora', 'despues'];
  const closeKws = ['confirmado', 'listo', 'compro', 'quiero proceder', 'hacemos', 'acordado', 'trato'];

  messages.forEach((msg, idx) => {
    const text = normalizeText(typeof msg === 'string' ? msg : (msg.text || msg.message || msg.body || ''));
    if (idx === 0) {
      moments.push({ type: 'first_contact', index: idx, snippet: text.slice(0, 60) });
    }
    if (priceKws.some(kw => text.includes(kw))) {
      moments.push({ type: 'price_inquiry', index: idx, snippet: text.slice(0, 60) });
    }
    if (appointKws.some(kw => text.includes(kw))) {
      moments.push({ type: 'appointment_request', index: idx, snippet: text.slice(0, 60) });
    }
    if (objectionKws.some(kw => text.includes(kw))) {
      moments.push({ type: 'objection', index: idx, snippet: text.slice(0, 60) });
    }
    if (closeKws.some(kw => text.includes(kw))) {
      moments.push({ type: 'close_attempt', index: idx, snippet: text.slice(0, 60) });
    }
  });

  const seen = new Set();
  return moments.filter(m => {
    const key = m.type + '_' + m.index;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildConversationSummary(uid, phone, messages, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!Array.isArray(messages)) throw new Error('messages debe ser array');
  const summaryType = SUMMARY_TYPES.includes(opts.summaryType) ? opts.summaryType : 'quick';
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const recordId = uid.slice(0, 8) + '_' + phone.replace(/\D/g, '').slice(-8) + '_' + date + '_' + summaryType;

  const recent = messages.slice(-MAX_MESSAGES_FOR_SUMMARY);
  const sentiment = detectSentiment(recent);
  const keyMoments = getKeyMoments(recent);
  const msgCount = messages.length;
  const lastMessage = recent.length > 0 ? recent[recent.length - 1] : null;
  const lastMessageText = lastMessage
    ? normalizeText(typeof lastMessage === 'string' ? lastMessage : (lastMessage.text || lastMessage.message || lastMessage.body || ''))
    : '';

  return {
    recordId,
    uid,
    phone,
    summaryType,
    date,
    msgCount,
    sentiment,
    keyMoments,
    lastMessageSnippet: lastMessageText.slice(0, 100),
    createdAt: opts.createdAt || Date.now(),
  };
}

async function saveConversationSummary(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.recordId) throw new Error('record invalido');
  await db()
    .collection('owners').doc(uid)
    .collection(SUMMARY_COLLECTION).doc(record.recordId)
    .set(record, { merge: true });
  console.log('[SUMMARY] Guardado uid=' + uid + ' phone=' + record.phone + ' type=' + record.summaryType);
  return record.recordId;
}

async function getConversationSummary(uid, phone, summaryType) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(SUMMARY_COLLECTION)
      .where('phone', '==', phone)
      .get();
    if (snap.empty) return null;
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    let filtered = docs;
    if (summaryType && isValidSummaryType(summaryType)) {
      filtered = docs.filter(d => d.summaryType === summaryType);
    }
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return filtered[0];
  } catch (e) {
    console.error('[SUMMARY] Error getConversationSummary: ' + e.message);
    return null;
  }
}

async function getSummaryHistory(uid, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  const { phone, summaryType, limit = 50 } = opts;
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(SUMMARY_COLLECTION)
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    let filtered = docs;
    if (phone) filtered = filtered.filter(d => d.phone === phone);
    if (summaryType && isValidSummaryType(summaryType)) {
      filtered = filtered.filter(d => d.summaryType === summaryType);
    }
    filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return filtered.slice(0, limit);
  } catch (e) {
    console.error('[SUMMARY] Error getSummaryHistory: ' + e.message);
    return [];
  }
}

function buildSummaryText(record) {
  if (!record) return '';
  const sentimentEmoji = {
    very_positive: '\u{1F604}',
    positive: '\u{1F642}',
    neutral: '\u{1F610}',
    negative: '\u{1F615}',
    very_negative: '\u{1F621}',
  };
  const typeEmoji = {
    quick: '\u26A1',
    full: '\u{1F4C4}',
    daily: '\u{1F4C5}',
    handoff: '\u{1F91D}',
  };
  const sEmoji = sentimentEmoji[record.sentiment && record.sentiment.label] || '\u{1F610}';
  const tEmoji = typeEmoji[record.summaryType] || '\u{1F4AC}';
  const lines = [
    tEmoji + ' *Resumen ' + record.summaryType + '* — ' + record.date,
    '\u{1F4DE} Contacto: ' + record.phone,
    '\u{1F4AC} Mensajes: ' + (record.msgCount || 0),
    sEmoji + ' Sentimiento: ' + (record.sentiment ? record.sentiment.label : 'neutral'),
  ];
  if (record.keyMoments && record.keyMoments.length > 0) {
    const types = [...new Set(record.keyMoments.map(m => m.type))];
    lines.push('\u{1F4CC} Momentos clave: ' + types.join(', '));
  }
  if (record.lastMessageSnippet) {
    lines.push('\u{1F4DD} Ultimo: ' + record.lastMessageSnippet);
  }
  return lines.join('\n');
}

module.exports = {
  buildConversationSummary, saveConversationSummary,
  getConversationSummary, getSummaryHistory,
  detectSentiment, getKeyMoments,
  buildSummaryText, isValidSummaryType, isValidSentiment,
  normalizeText,
  SUMMARY_TYPES, SENTIMENT_LABELS,
  POSITIVE_WORDS, NEGATIVE_WORDS,
  MAX_MESSAGES_FOR_SUMMARY,
  __setFirestoreForTests,
};
