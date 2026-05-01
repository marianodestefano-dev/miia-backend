'use strict';

/**
 * MIIA — Number Context Router (T196)
 * MIIA diferencia contexto segun el numero de entrada del mensaje.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const CONTEXT_TYPES = Object.freeze(['sales', 'support', 'delivery', 'vip', 'general', 'bot_only']);
const DEFAULT_CONTEXT = 'general';

function buildContextPromptHint(role, phone) {
  const hints = {
    sales: 'El cliente contacta por el numero de ventas. Priorizar conversion y cotizaciones.',
    support: 'El cliente contacta por soporte. Priorizar solucion de problemas y satisfaccion.',
    delivery: 'El cliente contacta por el numero de delivery. Priorizar estado de envio y coordinar entrega.',
    vip: 'El cliente es VIP. Trato premium, respuesta prioritaria, sin esperas.',
    general: 'Canal general. Responder segun las instrucciones del negocio.',
    bot_only: 'Canal automatizado. Solo responder con flujos predefinidos.',
  };
  return hints[role] || hints.general;
}

async function resolveIncomingContext(uid, incomingPhone, leadPhone) {
  if (!uid) throw new Error('uid requerido');
  if (!incomingPhone) throw new Error('incomingPhone requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  try {
    const snap = await db().collection('tenants').doc(uid).collection('registered_numbers')
      .where('phone', '==', incomingPhone).where('active', '==', true).get();
    let numberConfig = null;
    snap.forEach(doc => { if (!numberConfig) numberConfig = doc.data(); });
    if (!numberConfig) {
      return { context: DEFAULT_CONTEXT, promptHint: buildContextPromptHint(DEFAULT_CONTEXT), numberConfig: null };
    }
    const role = numberConfig.role || DEFAULT_CONTEXT;
    const context = CONTEXT_TYPES.includes(role) ? role : DEFAULT_CONTEXT;
    return {
      context,
      promptHint: buildContextPromptHint(context, incomingPhone),
      numberConfig,
    };
  } catch (e) {
    console.error('[NUMBER_ROUTER] Error resolviendo contexto uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { context: DEFAULT_CONTEXT, promptHint: buildContextPromptHint(DEFAULT_CONTEXT), numberConfig: null };
  }
}

async function saveContextSession(uid, leadPhone, incomingPhone, context) {
  if (!uid) throw new Error('uid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  if (!incomingPhone) throw new Error('incomingPhone requerido');
  if (!context) throw new Error('context requerido');
  const docId = leadPhone.replace('+', '');
  const data = {
    uid, leadPhone, incomingPhone, context,
    updatedAt: new Date().toISOString(),
  };
  try {
    await db().collection('tenants').doc(uid).collection('context_sessions').doc(docId).set(data, { merge: true });
    console.log('[NUMBER_ROUTER] Contexto guardado uid=' + uid.substring(0, 8) + ' lead=' + leadPhone + ' context=' + context);
  } catch (e) {
    console.error('[NUMBER_ROUTER] Error guardando sesion: ' + e.message);
    throw e;
  }
}

async function getContextSession(uid, leadPhone) {
  if (!uid) throw new Error('uid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  try {
    const docId = leadPhone.replace('+', '');
    const snap = await db().collection('tenants').doc(uid).collection('context_sessions').doc(docId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[NUMBER_ROUTER] Error leyendo sesion: ' + e.message);
    return null;
  }
}

async function getContextForLead(uid, leadPhone, incomingPhone) {
  if (!uid) throw new Error('uid requerido');
  if (!leadPhone) throw new Error('leadPhone requerido');
  const existing = await getContextSession(uid, leadPhone);
  if (existing && existing.context) {
    return { context: existing.context, source: 'session' };
  }
  if (incomingPhone) {
    const resolved = await resolveIncomingContext(uid, incomingPhone, leadPhone);
    return { context: resolved.context, promptHint: resolved.promptHint, source: 'number' };
  }
  return { context: DEFAULT_CONTEXT, promptHint: buildContextPromptHint(DEFAULT_CONTEXT), source: 'default' };
}

module.exports = {
  resolveIncomingContext,
  saveContextSession,
  getContextSession,
  getContextForLead,
  buildContextPromptHint,
  CONTEXT_TYPES,
  DEFAULT_CONTEXT,
  __setFirestoreForTests,
};
