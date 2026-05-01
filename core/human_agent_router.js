'use strict';

/**
 * MIIA — Human Agent Router (T197)
 * Escalada a agente humano: contexto completo, notificacion y retoma.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

let _notifyFn = null;
function __setNotifyFnForTests(fn) { _notifyFn = fn; }

const ESCALATION_REASONS = Object.freeze([
  'high_value_lead', 'complaint', 'complex_query', 'owner_request',
  'lead_request', 'appointment_confirmed', 'payment_issue', 'emergency',
]);
const AGENT_STATES = Object.freeze(['available', 'busy', 'offline']);
const TICKET_STATES = Object.freeze(['open', 'in_progress', 'resolved', 'escalated']);
const DEFAULT_TIMEOUT_MINS = 30;
const MAX_CONCURRENT_TICKETS = 20;

function buildHandoffContext(lead, conversations, reason) {
  if (!lead || !lead.phone) throw new Error('lead con phone requerido');
  const recentMessages = (conversations || []).slice(-10);
  const summary = {
    leadPhone: lead.phone,
    leadName: lead.name || null,
    reason: reason || 'owner_request',
    recentMessages,
    messageCount: (conversations || []).length,
    generatedAt: new Date().toISOString(),
  };
  return summary;
}

async function initiateEscalation(uid, leadPhone, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  opts = opts || {};
  const reason = opts.reason || 'owner_request';
  if (!ESCALATION_REASONS.includes(reason)) throw new Error('reason invalido: ' + reason);
  const timeoutMins = opts.timeoutMins || DEFAULT_TIMEOUT_MINS;
  const ticketId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + timeoutMins * 60 * 1000).toISOString();
  const context = opts.context || null;
  const data = {
    uid, leadPhone, ticketId, reason,
    state: 'open',
    context: context,
    assignedTo: null,
    openedAt: now,
    updatedAt: now,
    resolvedAt: null,
    expiresAt,
    timeoutMins,
  };
  try {
    await db().collection('agent_tickets').doc(uid).collection('tickets').doc(ticketId).set(data);
    console.log('[HUMAN_AGENT] Escalacion iniciada uid=' + uid.substring(0, 8) + ' lead=' + leadPhone + ' reason=' + reason);
    if (_notifyFn) {
      try { await _notifyFn(uid, ticketId, data); } catch (e) {
        console.error('[HUMAN_AGENT] Error notificando: ' + e.message);
      }
    }
  } catch (e) {
    console.error('[HUMAN_AGENT] Error guardando ticket: ' + e.message);
    throw e;
  }
  return { ticketId, leadPhone, reason, state: 'open', openedAt: now };
}

async function assignTicket(uid, ticketId, agentId) {
  if (!uid) throw new Error('uid requerido');
  if (!ticketId) throw new Error('ticketId requerido');
  if (!agentId) throw new Error('agentId requerido');
  try {
    await db().collection('agent_tickets').doc(uid).collection('tickets').doc(ticketId).set(
      { state: 'in_progress', assignedTo: agentId, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log('[HUMAN_AGENT] Ticket asignado ticketId=' + ticketId + ' agentId=' + agentId);
  } catch (e) {
    console.error('[HUMAN_AGENT] Error asignando: ' + e.message);
    throw e;
  }
}

async function resolveTicket(uid, ticketId, resolution) {
  if (!uid) throw new Error('uid requerido');
  if (!ticketId) throw new Error('ticketId requerido');
  const now = new Date().toISOString();
  try {
    await db().collection('agent_tickets').doc(uid).collection('tickets').doc(ticketId).set(
      { state: 'resolved', resolvedAt: now, updatedAt: now, resolution: resolution || null },
      { merge: true }
    );
    console.log('[HUMAN_AGENT] Ticket resuelto ticketId=' + ticketId);
    return { ticketId, resolvedAt: now };
  } catch (e) {
    console.error('[HUMAN_AGENT] Error resolviendo: ' + e.message);
    throw e;
  }
}

async function getTicket(uid, ticketId) {
  if (!uid) throw new Error('uid requerido');
  if (!ticketId) throw new Error('ticketId requerido');
  try {
    const snap = await db().collection('agent_tickets').doc(uid).collection('tickets').doc(ticketId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[HUMAN_AGENT] Error leyendo ticket: ' + e.message);
    return null;
  }
}

async function getOpenTickets(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('agent_tickets').doc(uid).collection('tickets')
      .where('state', '==', 'open').get();
    const tickets = [];
    snap.forEach(doc => tickets.push(doc.data()));
    return tickets.sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
  } catch (e) {
    console.error('[HUMAN_AGENT] Error leyendo tickets abiertos: ' + e.message);
    return [];
  }
}

async function isLeadInEscalation(uid, leadPhone) {
  if (!uid) throw new Error('uid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  try {
    const snap = await db().collection('agent_tickets').doc(uid).collection('tickets')
      .where('leadPhone', '==', leadPhone).where('state', 'in', ['open', 'in_progress']).get();
    let active = false;
    snap.forEach(doc => {
      const data = doc.data();
      if (new Date(data.expiresAt).getTime() > Date.now()) active = true;
    });
    return active;
  } catch (e) {
    console.error('[HUMAN_AGENT] Error verificando escalacion: ' + e.message);
    return false;
  }
}

module.exports = {
  buildHandoffContext,
  initiateEscalation,
  assignTicket,
  resolveTicket,
  getTicket,
  getOpenTickets,
  isLeadInEscalation,
  ESCALATION_REASONS,
  AGENT_STATES,
  TICKET_STATES,
  DEFAULT_TIMEOUT_MINS,
  __setFirestoreForTests,
  __setNotifyFnForTests,
};
