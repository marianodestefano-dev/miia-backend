'use strict';

/**
 * MIIA - Handoff Resumption (T199)
 * MIIA retoma la conversacion cuando el agente humano cierra el ticket.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const RESUMPTION_REASONS = Object.freeze(['ticket_resolved', 'timeout', 'agent_unavailable', 'lead_request', 'owner_request']);
const DEFAULT_RESUMPTION_MESSAGE_ES = 'Hola! Soy MIIA, retomo la atencion. En que mas te puedo ayudar?';
const DEFAULT_RESUMPTION_MESSAGE_EN = 'Hi! This is MIIA, I am taking over. How can I help you?';
const RESUMPTION_COOLDOWN_MS = 5 * 60 * 1000;

function buildResumptionMessage(language, agentName, customMessage) {
  if (customMessage && typeof customMessage === 'string' && customMessage.trim().length > 0) return customMessage.trim();
  var base = language === 'en' ? DEFAULT_RESUMPTION_MESSAGE_EN : DEFAULT_RESUMPTION_MESSAGE_ES;
  if (agentName) {
    if (language === 'en') return 'Hi! ' + agentName + ' has finished. MIIA is back. How can I help?';
    return 'Hola! ' + agentName + ' termino su atencion. MIIA retoma. En que te ayudo?';
  }
  return base;
}

async function scheduleResumption(uid, phone, ticketId, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!ticketId) throw new Error('ticketId requerido');
  opts = opts || {};
  var reason = opts.reason || 'ticket_resolved';
  if (!RESUMPTION_REASONS.includes(reason)) throw new Error('reason invalido: ' + reason);
  var delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 0;
  var resumeAt = new Date(Date.now() + delayMs).toISOString();
  var docId = ticketId + '_resumption';
  var data = {
    uid, phone, ticketId, reason, resumeAt,
    state: 'scheduled',
    scheduledAt: new Date().toISOString(),
    executedAt: null,
    language: opts.language || 'es',
    agentName: opts.agentName || null,
    customMessage: opts.customMessage || null,
  };
  try {
    await db().collection('handoff_resumptions').doc(uid).collection('pending').doc(docId).set(data);
    console.log('[HANDOFF_RESUMPTION] Programada uid=' + uid.substring(0, 8) + ' phone=' + phone + ' reason=' + reason);
    return { docId, resumeAt, reason };
  } catch (e) {
    console.error('[HANDOFF_RESUMPTION] Error guardando: ' + e.message);
    throw e;
  }
}

async function executeResumption(uid, docId) {
  if (!uid) throw new Error('uid requerido');
  if (!docId) throw new Error('docId requerido');
  try {
    var snap = await db().collection('handoff_resumptions').doc(uid).collection('pending').doc(docId).get();
    if (!snap.exists) return { executed: false, reason: 'not_found' };
    var data = snap.data();
    var message = buildResumptionMessage(data.language, data.agentName, data.customMessage);
    await db().collection('handoff_resumptions').doc(uid).collection('pending').doc(docId).set(
      { state: 'executed', executedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log('[HANDOFF_RESUMPTION] Ejecutada uid=' + uid.substring(0, 8) + ' docId=' + docId);
    return { executed: true, message, phone: data.phone, ticketId: data.ticketId };
  } catch (e) {
    console.error('[HANDOFF_RESUMPTION] Error ejecutando: ' + e.message);
    return { executed: false, reason: 'error' };
  }
}

async function getPendingResumptions(uid, nowMs) {
  if (!uid) throw new Error('uid requerido');
  var now = typeof nowMs === 'number' ? new Date(nowMs).toISOString() : new Date().toISOString();
  try {
    var snap = await db().collection('handoff_resumptions').doc(uid).collection('pending')
      .where('state', '==', 'scheduled').where('resumeAt', '<=', now).get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    return results;
  } catch (e) {
    console.error('[HANDOFF_RESUMPTION] Error leyendo pendientes: ' + e.message);
    return [];
  }
}

async function cancelResumption(uid, docId) {
  if (!uid) throw new Error('uid requerido');
  if (!docId) throw new Error('docId requerido');
  try {
    await db().collection('handoff_resumptions').doc(uid).collection('pending').doc(docId).set(
      { state: 'cancelled', cancelledAt: new Date().toISOString() },
      { merge: true }
    );
    return { cancelled: true };
  } catch (e) {
    console.error('[HANDOFF_RESUMPTION] Error cancelando: ' + e.message);
    throw e;
  }
}

async function shouldMiiaResume(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var now = new Date().toISOString();
    var snap = await db().collection('handoff_resumptions').doc(uid).collection('pending')
      .where('phone', '==', phone).where('state', '==', 'scheduled').get();
    var pending = [];
    snap.forEach(function(doc) { pending.push(doc.data()); });
    return pending.length === 0;
  } catch (e) {
    console.error('[HANDOFF_RESUMPTION] Error verificando: ' + e.message);
    return true;
  }
}

module.exports = {
  buildResumptionMessage,
  scheduleResumption,
  executeResumption,
  getPendingResumptions,
  cancelResumption,
  shouldMiiaResume,
  RESUMPTION_REASONS,
  DEFAULT_RESUMPTION_MESSAGE_ES,
  DEFAULT_RESUMPTION_MESSAGE_EN,
  RESUMPTION_COOLDOWN_MS,
  __setFirestoreForTests,
};