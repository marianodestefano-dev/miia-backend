'use strict';

/**
 * MIIA — Audit Trail (T127)
 * Registro append-only para acciones sensibles de tenants.
 * Cada entrada tiene: timestamp, uid, action, actor, meta, hash.
 */

const crypto = require('crypto');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const AUDIT_ACTIONS = Object.freeze([
  'training_data:updated',
  'training_data:deleted',
  'settings:updated',
  'consent:granted',
  'consent:revoked',
  'webhook:registered',
  'webhook:deleted',
  'broadcast:sent',
  'data:exported',
  'key:rotated',
  'owner:connected',
  'owner:disconnected',
]);

const MAX_META_KEYS = 10;

/**
 * Genera hash SHA-256 de la entrada de auditoria.
 */
function hashEntry(entry) {
  const str = JSON.stringify({ timestamp: entry.timestamp, uid: entry.uid, action: entry.action, actor: entry.actor });
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Registra una entrada de auditoria.
 * @param {string} uid
 * @param {string} action - debe estar en AUDIT_ACTIONS
 * @param {string} actor - quien realiza la accion ('owner', 'system', 'api')
 * @param {object} [meta] - datos adicionales (max MAX_META_KEYS keys)
 * @returns {Promise<{ entryId, timestamp, hash }>}
 */
async function logAuditEvent(uid, action, actor, meta = {}) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!action || !AUDIT_ACTIONS.includes(action)) throw new Error(`action invalida: ${action}`);
  if (!actor || typeof actor !== 'string') throw new Error('actor requerido');

  const metaKeys = Object.keys(meta || {});
  if (metaKeys.length > MAX_META_KEYS) throw new Error(`meta: max ${MAX_META_KEYS} keys`);

  const timestamp = new Date().toISOString();
  const entry = { uid, action, actor, meta: meta || {}, timestamp };
  const hash = hashEntry(entry);
  const entryId = `audit_${Date.now()}_${hash.slice(0, 6)}`;

  entry.entryId = entryId;
  entry.hash = hash;

  try {
    await db().collection('audit_trail').doc(uid).collection('events').doc(entryId).set(entry);
    console.log(`[AUDIT] ${action} uid=${uid.substring(0, 8)} actor=${actor} id=${entryId}`);
  } catch (e) {
    console.error(`[AUDIT] CRITICAL: no se pudo guardar entrada uid=${uid.substring(0, 8)}: ${e.message}`);
    throw e;
  }

  return { entryId, timestamp, hash };
}

/**
 * Obtiene el historial de auditoria para un uid.
 * @param {string} uid
 * @param {{ limit?, action? }} opts
 * @returns {Promise<Array>}
 */
async function getAuditLog(uid, { limit = 50, action = null } = {}) {
  if (!uid) throw new Error('uid requerido');
  try {
    const colRef = db().collection('audit_trail').doc(uid).collection('events');
    const snap = await colRef.get();
    let entries = snap.docs.map(d => d.data());
    if (action) entries = entries.filter(e => e.action === action);
    entries.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
    return entries.slice(0, limit);
  } catch (e) {
    console.error(`[AUDIT] Error leyendo log uid=${uid.substring(0, 8)}: ${e.message}`);
    return [];
  }
}

module.exports = {
  logAuditEvent,
  getAuditLog,
  hashEntry,
  AUDIT_ACTIONS,
  MAX_META_KEYS,
  __setFirestoreForTests,
};
