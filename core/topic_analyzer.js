'use strict';

/**
 * MIIA — Topic Analyzer (T192)
 * Analiza los temas mas frecuentes en conversaciones de un owner.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const TOPIC_KEYWORDS = Object.freeze({
  pricing: ['precio','costo','cuanto','cuanto vale','cuanto cuesta','tarifa','presupuesto','cotizacion','price','cost','how much'],
  catalog: ['catalogo','producto','productos','articulo','item','disponible','stock','variedad'],
  appointment: ['turno','cita','agendar','reservar','reserva','disponibilidad','horario','appointment','schedule'],
  delivery: ['envio','entrega','delivery','domicilio','despacho','cuando llega','cuando entrega'],
  payment: ['pago','pagar','transferencia','efectivo','tarjeta','mercadopago','stripe','factura','recibo'],
  support: ['problema','falla','error','queja','reclamo','no funciona','devolucion','cambio','garantia'],
  greeting: ['hola','buenas','buenos dias','buenas tardes','buenas noches','hello','hi','hey'],
  hours: ['horario','hora','cuando abren','hasta que hora','que dias','abierto','cerrado'],
  location: ['donde','ubicacion','direccion','como llego','donde estan','where','address'],
  info: ['informacion','info','quiero saber','necesito saber','me pueden decir','dudas','consulta'],
});

const TOPIC_LABELS = Object.freeze({
  pricing: 'Precios / Cotizaciones',
  catalog: 'Catalogo / Productos',
  appointment: 'Turnos / Citas',
  delivery: 'Envios / Delivery',
  payment: 'Pagos',
  support: 'Soporte / Reclamos',
  greeting: 'Saludos',
  hours: 'Horarios',
  location: 'Ubicacion',
  info: 'Informacion general',
});

const MIN_CONFIDENCE = 0.2;
const MAX_TOPICS_PER_MESSAGE = 3;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_TOP_TOPICS = 10;

function detectTopicsInMessage(text) {
  if (!text || typeof text !== 'string') throw new Error('text requerido');
  const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const scores = {};
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += 1;
    }
    if (score > 0) scores[topic] = score;
  }
  if (Object.keys(scores).length === 0) return [];
  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, MAX_TOPICS_PER_MESSAGE).map(([topic, score]) => ({
    topic,
    label: TOPIC_LABELS[topic] || topic,
    confidence: Math.round((score / total) * 100) / 100,
  })).filter(t => t.confidence >= MIN_CONFIDENCE);
}

async function recordTopics(uid, phone, message) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!message) throw new Error('message requerido');
  const topics = detectTopicsInMessage(message);
  if (topics.length === 0) return [];
  const docId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const data = {
    uid, phone, message: message.substring(0, 500),
    topics: topics.map(t => t.topic),
    topicDetails: topics,
    recordedAt: new Date().toISOString(),
  };
  try {
    await db().collection('tenants').doc(uid).collection('topic_events').doc(docId).set(data);
    console.log('[TOPIC_ANALYZER] uid=' + uid.substring(0, 8) + ' topics=' + topics.map(t => t.topic).join(','));
  } catch (e) {
    console.error('[TOPIC_ANALYZER] Error guardando topics uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
  return topics;
}

async function getTopTopics(uid, periodDays, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const days = (typeof periodDays === 'number' && periodDays > 0) ? periodDays : DEFAULT_PERIOD_DAYS;
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const fromDate = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const snap = await db().collection('tenants').doc(uid).collection('topic_events')
      .where('recordedAt', '>=', fromDate).get();
    const counts = {};
    snap.forEach(doc => {
      const data = doc.data();
      (data.topics || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, MAX_TOP_TOPICS).map(([topic, count]) => ({
      topic, label: TOPIC_LABELS[topic] || topic, count,
    }));
  } catch (e) {
    console.error('[TOPIC_ANALYZER] Error leyendo topics uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

async function getTopicsByPhone(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db().collection('tenants').doc(uid).collection('topic_events')
      .where('phone', '==', phone).get();
    const counts = {};
    snap.forEach(doc => {
      (doc.data().topics || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({
      topic, label: TOPIC_LABELS[topic] || topic, count,
    }));
  } catch (e) {
    console.error('[TOPIC_ANALYZER] Error leyendo topics por phone: ' + e.message);
    return [];
  }
}

module.exports = {
  detectTopicsInMessage,
  recordTopics,
  getTopTopics,
  getTopicsByPhone,
  TOPIC_KEYWORDS,
  TOPIC_LABELS,
  MIN_CONFIDENCE,
  MAX_TOPICS_PER_MESSAGE,
  DEFAULT_PERIOD_DAYS,
  MAX_TOP_TOPICS,
  __setFirestoreForTests,
};
