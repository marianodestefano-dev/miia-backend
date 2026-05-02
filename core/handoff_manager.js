'use strict';

/**
 * handoff_manager.js -- T187 + T197-T199 (handoff a humano + retomar).
 */

const { randomUUID } = require('crypto');

const HANDOFF_STATES = Object.freeze(['pending', 'active', 'resolved', 'expired', 'cancelled']);
const HANDOFF_MODES = Object.freeze(['auto', 'manual', 'escalation']);
const HANDOFF_REASONS = Object.freeze(['complaint', 'complex_query', 'pricing_negotiation', 'tech_issue', 'sensitive', 'requested', 'other']);
const DEFAULT_HANDOFF_TIMEOUT_MINS = 30;

const COL_HANDOFFS = 'handoffs';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

async function initiateHandoff(uid, phone, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  const o = opts || {};
  const reason = HANDOFF_REASONS.includes(o.reason) ? o.reason : 'other';
  const mode = HANDOFF_MODES.includes(o.mode) ? o.mode : 'auto';
  const timeoutMins = typeof o.timeoutMins === 'number' && o.timeoutMins > 0 ? o.timeoutMins : DEFAULT_HANDOFF_TIMEOUT_MINS;
  const handoffId = o.handoffId || randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + timeoutMins * 60 * 1000).toISOString();
  const data = {
    handoffId, uid, phone, reason, mode, state: 'pending',
    createdAt, expiresAt, agentId: o.agentId || null, contextSnapshot: o.contextSnapshot || null,
  };
  await db().collection('owners').doc(uid).collection(COL_HANDOFFS).doc(handoffId).set(data);
  return { handoffId, state: 'pending', reason, mode, createdAt, expiresAt };
}

async function updateHandoffState(uid, handoffId, newState, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!handoffId) throw new Error('handoffId requerido');
  if (!HANDOFF_STATES.includes(newState)) throw new Error('state invalido: ' + newState);
  const update = { state: newState, updatedAt: new Date().toISOString() };
  if (opts && opts.note) update.note = opts.note;
  if (opts && opts.agentId) update.agentId = opts.agentId;
  await db().collection('owners').doc(uid).collection(COL_HANDOFFS).doc(handoffId).set(update, { merge: true });
}

async function isHandoffActive(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db().collection('owners').doc(uid).collection(COL_HANDOFFS).where('phone', '==', phone).where('state', '==', 'active').get();
    let foundActive = false;
    const now = Date.now();
    snap.forEach(d => {
      const data = d.data ? d.data() : {};
      if (data.expiresAt) {
        const exp = new Date(data.expiresAt).getTime();
        if (exp > now) foundActive = true;
      } else {
        foundActive = true;
      }
    });
    return foundActive;
  } catch (e) {
    return false;
  }
}

async function getPendingHandoffs(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('owners').doc(uid).collection(COL_HANDOFFS).where('state', '==', 'pending').get();
    const out = [];
    snap.forEach(d => out.push(d.data ? d.data() : {}));
    return out;
  } catch (e) {
    return [];
  }
}

async function shouldMiiaRespond(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  const active = await isHandoffActive(uid, phone);
  return !active;
}

module.exports = {
  initiateHandoff,
  updateHandoffState,
  isHandoffActive,
  getPendingHandoffs,
  shouldMiiaRespond,
  HANDOFF_STATES,
  HANDOFF_MODES,
  HANDOFF_REASONS,
  DEFAULT_HANDOFF_TIMEOUT_MINS,
  __setFirestoreForTests,
};
