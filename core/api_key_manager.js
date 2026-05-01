'use strict';

/**
 * MIIA - API Key Manager (T245)
 * P4.2 ROADMAP: gestion de API keys para que owners integren sistemas externos.
 * Creacion, rotacion, revocacion, validacion de acceso.
 */

const crypto = require('crypto');

const KEY_STATUSES = Object.freeze(['active', 'revoked', 'expired', 'suspended']);
const KEY_SCOPES = Object.freeze([
  'read_conversations', 'write_messages', 'read_contacts', 'manage_catalog',
  'send_broadcast', 'read_analytics', 'webhook_manage', 'full_access',
]);

const KEY_PREFIX = 'miia_';
const KEY_BYTES = 32;
const MAX_KEYS_PER_TENANT = 5;
const DEFAULT_EXPIRY_DAYS = 365;
const MAX_EXPIRY_DAYS = 730;
const RATE_LIMIT_PER_MINUTE = 60;
const API_KEYS_COLLECTION = 'api_keys';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidStatus(status) {
  return KEY_STATUSES.includes(status);
}

function isValidScope(scope) {
  return KEY_SCOPES.includes(scope);
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes)) throw new Error('scopes debe ser array');
  var invalid = scopes.filter(function(s) { return !isValidScope(s); });
  if (invalid.length > 0) throw new Error('scopes invalidos: ' + invalid.join(', '));
}

function generateRawKey() {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('hex');
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function buildAPIKeyRecord(uid, rawKey, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!rawKey) throw new Error('rawKey requerido');
  var scopes = (opts && Array.isArray(opts.scopes)) ? opts.scopes : ['read_conversations'];
  validateScopes(scopes);
  var expiryDays = (opts && opts.expiryDays) ? Math.min(opts.expiryDays, MAX_EXPIRY_DAYS) : DEFAULT_EXPIRY_DAYS;
  var expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
  var keyId = 'key_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  return {
    keyId,
    uid,
    keyHash: hashKey(rawKey),
    keyPrefix: rawKey.slice(0, KEY_PREFIX.length + 8),
    name: (opts && opts.name) ? String(opts.name) : 'API Key',
    scopes,
    status: 'active',
    expiresAt,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    usageCount: 0,
  };
}

async function createAPIKey(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  var existing = await getAPIKeys(uid);
  var active = existing.filter(function(k) { return k.status === 'active'; });
  if (active.length >= MAX_KEYS_PER_TENANT) {
    throw new Error('maximo de API keys activas alcanzado: ' + MAX_KEYS_PER_TENANT);
  }
  var rawKey = generateRawKey();
  var record = buildAPIKeyRecord(uid, rawKey, opts);
  await db().collection('tenants').doc(uid).collection(API_KEYS_COLLECTION).doc(record.keyId).set(record);
  console.log('[API_KEYS] Creada uid=' + uid + ' keyId=' + record.keyId + ' scopes=' + record.scopes.join(','));
  return { rawKey, record };
}

async function revokeAPIKey(uid, keyId) {
  if (!uid) throw new Error('uid requerido');
  if (!keyId) throw new Error('keyId requerido');
  await db().collection('tenants').doc(uid).collection(API_KEYS_COLLECTION).doc(keyId).set({
    status: 'revoked',
    revokedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log('[API_KEYS] Revocada uid=' + uid + ' keyId=' + keyId);
}

async function rotateAPIKey(uid, keyId, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!keyId) throw new Error('keyId requerido');
  var existing = await getAPIKeys(uid);
  var oldKey = existing.find(function(k) { return k.keyId === keyId; });
  if (!oldKey) throw new Error('API key no encontrada: ' + keyId);
  if (oldKey.status !== 'active') throw new Error('solo se puede rotar una key activa');
  await revokeAPIKey(uid, keyId);
  var newOpts = opts || { scopes: oldKey.scopes, name: oldKey.name + ' (rotada)' };
  return await createAPIKey(uid, newOpts);
}

async function getAPIKeys(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(API_KEYS_COLLECTION).get();
    var keys = [];
    snap.forEach(function(doc) { keys.push(doc.data()); });
    if (opts && opts.status) keys = keys.filter(function(k) { return k.status === opts.status; });
    return keys;
  } catch (e) {
    console.error('[API_KEYS] Error leyendo keys: ' + e.message);
    return [];
  }
}

async function validateAPIKey(uid, rawKey) {
  if (!uid) throw new Error('uid requerido');
  if (!rawKey) return { valid: false, reason: 'key requerida' };
  if (!rawKey.startsWith(KEY_PREFIX)) return { valid: false, reason: 'formato invalido' };
  try {
    var keyHash = hashKey(rawKey);
    var keys = await getAPIKeys(uid);
    var found = keys.find(function(k) { return k.keyHash === keyHash; });
    if (!found) return { valid: false, reason: 'key no encontrada' };
    if (found.status !== 'active') return { valid: false, reason: 'key ' + found.status };
    if (new Date(found.expiresAt).getTime() < Date.now()) {
      return { valid: false, reason: 'key expirada' };
    }
    return { valid: true, keyId: found.keyId, scopes: found.scopes, uid: found.uid };
  } catch (e) {
    return { valid: false, reason: 'error de validacion: ' + e.message };
  }
}

async function recordKeyUsage(uid, keyId) {
  if (!uid || !keyId) return;
  try {
    await db().collection('tenants').doc(uid).collection(API_KEYS_COLLECTION).doc(keyId).set({
      lastUsedAt: new Date().toISOString(),
      usageCount: '__INCREMENT__',
    }, { merge: true });
  } catch (e) {
    console.error('[API_KEYS] Error registrando uso: ' + e.message);
  }
}

function hasScope(keyRecord, requiredScope) {
  if (!keyRecord || !keyRecord.scopes) return false;
  if (keyRecord.scopes.includes('full_access')) return true;
  return keyRecord.scopes.includes(requiredScope);
}

function buildKeyInfoText(record) {
  if (!record) return '';
  var lines = [
    '🔑 *API Key: ' + record.name + '*',
    'ID: ' + record.keyId,
    'Prefijo: ' + record.keyPrefix + '...',
    'Estado: ' + record.status,
    'Scopes: ' + (record.scopes || []).join(', '),
    'Vence: ' + (record.expiresAt ? new Date(record.expiresAt).toLocaleDateString('es') : 'nunca'),
    'Usos: ' + (record.usageCount || 0),
  ];
  return lines.join('\n');
}

module.exports = {
  createAPIKey,
  revokeAPIKey,
  rotateAPIKey,
  getAPIKeys,
  validateAPIKey,
  recordKeyUsage,
  buildAPIKeyRecord,
  generateRawKey,
  hashKey,
  hasScope,
  buildKeyInfoText,
  validateScopes,
  isValidStatus,
  isValidScope,
  KEY_STATUSES,
  KEY_SCOPES,
  KEY_PREFIX,
  MAX_KEYS_PER_TENANT,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  RATE_LIMIT_PER_MINUTE,
  __setFirestoreForTests,
};
