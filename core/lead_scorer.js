'use strict';

/**
 * MIIA - Lead Scorer V2 (T164/T165)
 * Modelo de scoring de leads basado en historial de interacciones.
 * Alerta al owner cuando un lead supera el umbral de interes.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const INTERACTION_WEIGHTS = Object.freeze({
  message_sent: 1,
  catalog_view: 2,
  price_inquiry: 4,
  appointment_request: 8,
  payment_initiated: 15,
  catalog_purchase: 20,
  repeated_visit: 3,
  referral: 5,
});

const DEFAULT_ALERT_THRESHOLD = 20;
const MAX_SCORE = 100;
const SCORE_DECAY_DAYS = 30;

/**
 * Calcula el score de un lead basado en su historial.
 * @param {Array<object>} interactions - lista de interacciones { type, timestamp, weight? }
 * @param {number} [nowMs]
 * @returns {{ score, level, interactions: number }}
 */
function calculateScore(interactions, nowMs) {
  if (!Array.isArray(interactions)) throw new Error('interactions debe ser array');

  const now = nowMs ? new Date(nowMs) : new Date();
  let rawScore = 0;

  for (const interaction of interactions) {
    const weight = interaction.weight !== undefined
      ? interaction.weight
      : (INTERACTION_WEIGHTS[interaction.type] || 1);

    const ts = interaction.timestamp ? new Date(interaction.timestamp) : now;
    const daysDiff = (now - ts) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.max(0, 1 - daysDiff / SCORE_DECAY_DAYS);

    rawScore += weight * decayFactor;
  }

  const score = Math.min(Math.round(rawScore), MAX_SCORE);
  const level = _scoreToLevel(score);

  return { score, level, interactions: interactions.length };
}

/**
 * Registra una interaccion de un lead.
 * @param {string} uid - tenant
 * @param {string} phone - lead phone
 * @param {string} type - tipo de interaccion
 * @param {object} [opts] - { nowMs, extra }
 */
async function recordInteraction(uid, phone, type, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!type || !INTERACTION_WEIGHTS.hasOwnProperty(type)) throw new Error('tipo invalido: ' + type);

  const nowMs = (opts && opts.nowMs) ? opts.nowMs : Date.now();
  const payload = {
    type,
    timestamp: new Date(nowMs).toISOString(),
    weight: INTERACTION_WEIGHTS[type],
    extra: (opts && opts.extra) ? opts.extra : null,
  };

  try {
    const coll = db().collection('lead_scores').doc(uid).collection('leads').doc(phone)
      .collection('interactions');
    await coll.doc(type + '_' + nowMs).set(payload);
    console.log('[LEAD_SCORE] interaccion uid=' + uid.substring(0, 8) + ' phone=***' + phone.slice(-4) + ' type=' + type);
  } catch (e) {
    console.error('[LEAD_SCORE] Error registrando interaccion: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene el historial de interacciones de un lead.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<Array<object>>}
 */
async function getLeadInteractions(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db().collection('lead_scores').doc(uid)
      .collection('leads').doc(phone).collection('interactions').get();
    const items = [];
    snap.forEach(doc => items.push(doc.data()));
    return items;
  } catch (e) {
    console.error('[LEAD_SCORE] Error leyendo interacciones: ' + e.message);
    return [];
  }
}

/**
 * Verifica si el score supera el umbral y crea alerta si aplica.
 * @param {string} uid
 * @param {string} phone
 * @param {number} score
 * @param {number} [threshold]
 * @returns {Promise<{shouldAlert, score, level}>}
 */
async function checkAlertThreshold(uid, phone, score, threshold) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number') throw new Error('score debe ser numero');

  const alertAt = threshold !== undefined ? threshold : DEFAULT_ALERT_THRESHOLD;
  const shouldAlert = score >= alertAt;
  const level = _scoreToLevel(score);

  if (shouldAlert) {
    try {
      await db().collection('lead_alerts').doc(uid).collection('alerts')
        .doc(phone + '_' + Date.now()).set({
          uid, phone, score, level,
          alertAt, triggeredAt: new Date().toISOString(), sent: false,
        });
      console.log('[LEAD_SCORE] ALERTA generada uid=' + uid.substring(0, 8) + ' score=' + score + ' level=' + level);
    } catch (e) {
      console.error('[LEAD_SCORE] Error creando alerta: ' + e.message);
    }
  }

  return { shouldAlert, score, level };
}

/**
 * Obtiene alertas pendientes de envio para un owner.
 * @param {string} uid
 * @returns {Promise<Array<object>>}
 */
async function getPendingAlerts(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('lead_alerts').doc(uid)
      .collection('alerts').where('sent', '==', false).get();
    const items = [];
    snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    return items;
  } catch (e) {
    console.error('[LEAD_SCORE] Error leyendo alertas: ' + e.message);
    return [];
  }
}

function _scoreToLevel(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  if (score >= 15) return 'interested';
  return 'cold';
}

module.exports = {
  calculateScore, recordInteraction, getLeadInteractions,
  checkAlertThreshold, getPendingAlerts,
  INTERACTION_WEIGHTS, DEFAULT_ALERT_THRESHOLD, MAX_SCORE, SCORE_DECAY_DAYS,
  __setFirestoreForTests,
};
