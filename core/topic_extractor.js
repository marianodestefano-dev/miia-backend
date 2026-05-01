'use strict';

const TOPICS = Object.freeze([
  'sales_inquiry', 'support_request', 'appointment_request', 'complaint',
  'general_info', 'pricing', 'catalog_browse', 'payment', 'personal_message',
  'spam', 'unknown',
]);

const TOPIC_KEYWORDS = Object.freeze({
  sales_inquiry:       ['comprar', 'adquirir', 'quiero', 'interesa', 'disponible', 'venden', 'ofrecen', 'necesito', 'busco'],
  support_request:     ['ayuda', 'problema', 'error', 'falla', 'no funciona', 'solucionar', 'soporte', 'asistencia', 'no puedo'],
  appointment_request: ['turno', 'cita', 'reservar', 'agendar', 'horario', 'disponibilidad', 'cuando', 'appointment'],
  complaint:           ['queja', 'reclamo', 'mal', 'terrible', 'pesimo', 'decepcionado', 'enojado', 'molesto', 'no cumplieron'],
  general_info:        ['informacion', 'info', 'consulta', 'pregunta', 'como', 'que es', 'cuanto', 'donde'],
  pricing:             ['precio', 'costo', 'cuanto cuesta', 'valor', 'tarifa', 'presupuesto', 'cotizacion', 'oferta', 'descuento'],
  catalog_browse:      ['catalogo', 'productos', 'servicios', 'lista', 'que tienen', 'ver opciones', 'menu', 'portafolio'],
  payment:             ['pago', 'pagar', 'transferencia', 'efectivo', 'tarjeta', 'factura', 'recibo', 'mercadopago', 'paypal'],
  personal_message:    ['hola', 'buenas', 'buen dia', 'como estas', 'gracias', 'ok', 'listo', 'entendido', 'perfecto', 'adios'],
  spam:                ['click aqui', 'ganaste', 'premio', 'gratis gratis', 'urgente', 'oferta limitada', 'enlace', 'bit.ly'],
});

const MAX_MESSAGES_TO_ANALYZE = 5;
const MIN_CONFIDENCE = 0.1;
const TOPIC_COLLECTION = 'topic_records';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidTopic(t) { return TOPICS.includes(t); }

function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function scoreMessageAgainstTopics(text) {
  const normalized = normalizeText(text);
  const scores = {};
  for (const topic of TOPICS) {
    if (topic === 'unknown') continue;
    const keywords = TOPIC_KEYWORDS[topic] || [];
    let hits = 0;
    for (const kw of keywords) {
      if (normalized.includes(kw)) hits++;
    }
    if (hits > 0) scores[topic] = hits;
  }
  return scores;
}

function extractTopics(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ topic: 'unknown', confidence: 1.0, keywords: [] }];
  }
  const recent = messages.slice(-MAX_MESSAGES_TO_ANALYZE);
  const totalScores = {};
  const matchedKeywords = {};
  let totalHits = 0;

  for (const msg of recent) {
    const text = typeof msg === 'string' ? msg : (msg.text || msg.message || msg.body || '');
    const msgScores = scoreMessageAgainstTopics(text);
    for (const [topic, hits] of Object.entries(msgScores)) {
      totalScores[topic] = (totalScores[topic] || 0) + hits;
      totalHits += hits;
      if (!matchedKeywords[topic]) matchedKeywords[topic] = new Set();
      const norm = normalizeText(text);
      for (const kw of (TOPIC_KEYWORDS[topic] || [])) {
        if (norm.includes(kw)) matchedKeywords[topic].add(kw);
      }
    }
  }

  if (totalHits === 0) {
    return [{ topic: 'unknown', confidence: 1.0, keywords: [] }];
  }

  const results = Object.entries(totalScores)
    .map(([topic, hits]) => ({
      topic,
      confidence: Math.round((hits / totalHits) * 100) / 100,
      keywords: matchedKeywords[topic] ? Array.from(matchedKeywords[topic]) : [],
    }))
    .filter(r => r.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);

  return results.length > 0 ? results : [{ topic: 'unknown', confidence: 1.0, keywords: [] }];
}

function getMainTopic(messages) {
  const topics = extractTopics(messages);
  return topics[0] || { topic: 'unknown', confidence: 1.0, keywords: [] };
}

function buildTopicRecord(uid, phone, topic, confidence, keywords, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!isValidTopic(topic)) throw new Error('topic invalido');
  if (typeof confidence !== 'number') throw new Error('confidence debe ser numero');
  const date = (opts.date || new Date().toISOString().slice(0, 10));
  const recordId = uid.slice(0, 8) + '_' + phone.replace(/\D/g, '').slice(-8) + '_' + date;
  return {
    recordId,
    uid,
    phone,
    topic,
    confidence: Math.min(1, Math.max(0, confidence)),
    keywords: Array.isArray(keywords) ? keywords : [],
    date,
    createdAt: opts.createdAt || Date.now(),
  };
}

async function saveTopicRecord(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.recordId) throw new Error('record invalido');
  await db()
    .collection('owners').doc(uid)
    .collection(TOPIC_COLLECTION).doc(record.recordId)
    .set(record, { merge: true });
  console.log('[TOPIC] Guardado uid=' + uid + ' phone=' + record.phone + ' topic=' + record.topic);
  return record.recordId;
}

async function getLatestTopic(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(TOPIC_COLLECTION)
      .where('phone', '==', phone)
      .get();
    if (snap.empty) return null;
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    docs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return docs[0] || null;
  } catch (e) {
    console.error('[TOPIC] Error getLatestTopic: ' + e.message);
    return null;
  }
}

async function getTopicHistory(uid, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  const { topic, limit = 50 } = opts;
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(TOPIC_COLLECTION)
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    let filtered = docs;
    if (topic && isValidTopic(topic)) {
      filtered = filtered.filter(r => r.topic === topic);
    }
    filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return filtered.slice(0, limit);
  } catch (e) {
    console.error('[TOPIC] Error getTopicHistory: ' + e.message);
    return [];
  }
}

function buildTopicSummaryText(record) {
  if (!record) return '';
  const emojis = {
    sales_inquiry: '\u{1F6D2}',
    support_request: '\u{1F6E0}\uFE0F',
    appointment_request: '\u{1F4C5}',
    complaint: '\u{1F624}',
    general_info: '\u2139\uFE0F',
    pricing: '\u{1F4B0}',
    catalog_browse: '\u{1F4CB}',
    payment: '\u{1F4B3}',
    personal_message: '\u{1F4AC}',
    spam: '\u{1F6AB}',
    unknown: '\u2753',
  };
  const emoji = emojis[record.topic] || '\u2753';
  const pct = Math.round((record.confidence || 0) * 100);
  const kwText = record.keywords && record.keywords.length > 0
    ? '\nPalabras clave: ' + record.keywords.join(', ')
    : '';
  return emoji + ' *Tema detectado:* ' + record.topic + '\nConfianza: ' + pct + '%' + kwText;
}

module.exports = {
  extractTopics, getMainTopic,
  buildTopicRecord, saveTopicRecord,
  getLatestTopic, getTopicHistory,
  buildTopicSummaryText,
  isValidTopic, normalizeText,
  TOPICS, TOPIC_KEYWORDS,
  MAX_MESSAGES_TO_ANALYZE, MIN_CONFIDENCE,
  __setFirestoreForTests,
};
