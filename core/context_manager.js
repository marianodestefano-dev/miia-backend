'use strict';

/**
 * MIIA - Context Manager (T222)
 * Owner controla los contextos activos de MIIA (modos, temas, restricciones).
 */

const CONTEXT_MODES = Object.freeze([
  'auto', 'sales', 'support', 'onboarding', 'follow_up', 
  'broadcast', 'ooo', 'maintenance',
]);

const CONTEXT_RESTRICTIONS = Object.freeze([
  'no_pricing', 'no_appointments', 'no_catalog', 'no_referrals',
  'human_only', 'read_only',
]);

const DEFAULT_CONTEXT = Object.freeze({
  mode: 'auto',
  restrictions: [],
  customSystemPrompt: null,
  maxResponseLength: null,
  allowedTopics: null,
  blockedTopics: null,
  expiresAt: null,
});

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidMode(mode) {
  return CONTEXT_MODES.includes(mode);
}

function isValidRestriction(restriction) {
  return CONTEXT_RESTRICTIONS.includes(restriction);
}

function validateContextConfig(config) {
  if (!config || typeof config !== 'object') return { valid: false, reason: 'config debe ser objeto' };
  if (config.mode !== undefined && !isValidMode(config.mode)) return { valid: false, reason: 'mode invalido: ' + config.mode };
  if (config.restrictions !== undefined) {
    if (!Array.isArray(config.restrictions)) return { valid: false, reason: 'restrictions debe ser array' };
    for (var i = 0; i < config.restrictions.length; i++) {
      if (!isValidRestriction(config.restrictions[i])) return { valid: false, reason: 'restriction invalida: ' + config.restrictions[i] };
    }
  }
  if (config.maxResponseLength !== undefined && config.maxResponseLength !== null) {
    if (typeof config.maxResponseLength !== 'number' || config.maxResponseLength <= 0) return { valid: false, reason: 'maxResponseLength invalido' };
  }
  return { valid: true };
}

async function setContext(uid, config) {
  if (!uid) throw new Error('uid requerido');
  if (!config) throw new Error('config requerido');
  var vr = validateContextConfig(config);
  if (!vr.valid) throw new Error('config invalida: ' + vr.reason);
  var merged = Object.assign({}, DEFAULT_CONTEXT, config, { updatedAt: new Date().toISOString() });
  try {
    await db().collection('tenants').doc(uid).collection('config').doc('context').set(merged, { merge: false });
    console.log('[CTX_MGR] Contexto actualizado para ' + uid + ': modo=' + merged.mode);
  } catch (e) {
    console.error('[CTX_MGR] Error guardando contexto: ' + e.message);
    throw e;
  }
}

async function getContext(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('config').doc('context').get();
    if (!snap.exists) return Object.assign({}, DEFAULT_CONTEXT);
    var data = Object.assign({}, DEFAULT_CONTEXT, snap.data());
    // Check if context has expired
    if (data.expiresAt && Date.now() > new Date(data.expiresAt).getTime()) {
      return Object.assign({}, DEFAULT_CONTEXT);
    }
    return data;
  } catch (e) {
    console.error('[CTX_MGR] Error leyendo contexto: ' + e.message);
    return Object.assign({}, DEFAULT_CONTEXT);
  }
}

function buildContextPrompt(contextConfig) {
  if (!contextConfig) return '';
  var parts = [];
  if (contextConfig.mode && contextConfig.mode !== 'auto') {
    parts.push('Modo activo: ' + contextConfig.mode + '.');
  }
  if (contextConfig.restrictions && contextConfig.restrictions.length > 0) {
    parts.push('Restricciones: ' + contextConfig.restrictions.join(', ') + '.');
  }
  if (contextConfig.customSystemPrompt) {
    parts.push(contextConfig.customSystemPrompt);
  }
  if (contextConfig.blockedTopics && contextConfig.blockedTopics.length > 0) {
    parts.push('Temas bloqueados: ' + contextConfig.blockedTopics.join(', ') + '. No los menciones.');
  }
  return parts.join(' ');
}

function isTopicAllowed(topic, contextConfig) {
  if (!contextConfig) return true;
  if (contextConfig.blockedTopics && contextConfig.blockedTopics.includes(topic)) return false;
  if (contextConfig.allowedTopics && !contextConfig.allowedTopics.includes(topic)) return false;
  return true;
}

module.exports = {
  isValidMode,
  isValidRestriction,
  validateContextConfig,
  setContext,
  getContext,
  buildContextPrompt,
  isTopicAllowed,
  CONTEXT_MODES,
  CONTEXT_RESTRICTIONS,
  DEFAULT_CONTEXT,
  __setFirestoreForTests,
};
