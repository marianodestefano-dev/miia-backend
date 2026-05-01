'use strict';

/**
 * MIIA - Viral Referral Engine (T219)
 * Motor de referidos virales: codigos, tracking, recompensas.
 */

const CODE_LENGTH = 8;
const CODE_EXPIRY_DAYS = 30;
const MAX_USES_PER_CODE = 100;
const REWARD_TYPES = Object.freeze(['discount', 'credit', 'free_month', 'cashback', 'points']);
const CODE_STATUSES = Object.freeze(['active', 'expired', 'maxed', 'revoked']);

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function generateCode(uid) {
  if (!uid) throw new Error('uid requerido');
  var base = uid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4);
  var suffix = Date.now().toString(36).toUpperCase().slice(-4);
  return (base + suffix).slice(0, CODE_LENGTH).padEnd(CODE_LENGTH, '0');
}

function isCodeExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() > new Date(expiresAt).getTime();
}

function isCodeValid(code) {
  if (!code || typeof code !== 'string') return false;
  return /^[A-Z0-9]{6,12}$/.test(code);
}

async function createReferralCode(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  var rewardType = opts && opts.rewardType;
  if (rewardType && !REWARD_TYPES.includes(rewardType)) throw new Error('rewardType invalido: ' + rewardType);
  var code = (opts && opts.customCode) ? opts.customCode.toUpperCase() : generateCode(uid);
  if (!isCodeValid(code)) throw new Error('codigo invalido: ' + code);
  var expiresAt = new Date(Date.now() + CODE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  var data = {
    uid, code, status: 'active',
    rewardType: rewardType || null,
    rewardValue: (opts && opts.rewardValue) || null,
    usesCount: 0, maxUses: (opts && opts.maxUses) || MAX_USES_PER_CODE,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  try {
    await db().collection('referral_codes').doc(code).set(data);
    console.log('[VIRAL_REF] Codigo creado: ' + code + ' para ' + uid);
    return { code, expiresAt, maxUses: data.maxUses };
  } catch (e) {
    console.error('[VIRAL_REF] Error creando codigo: ' + e.message);
    throw e;
  }
}

async function validateAndUseCode(code, newUserPhone) {
  if (!code) throw new Error('code requerido');
  if (!newUserPhone) throw new Error('newUserPhone requerido');
  code = code.toUpperCase().trim();
  if (!isCodeValid(code)) throw new Error('codigo invalido: ' + code);
  try {
    var snap = await db().collection('referral_codes').doc(code).get();
    if (!snap.exists) return { valid: false, reason: 'codigo no encontrado' };
    var data = snap.data();
    if (data.status !== 'active') return { valid: false, reason: 'codigo ' + data.status };
    if (isCodeExpired(data.expiresAt)) return { valid: false, reason: 'codigo expirado' };
    if (data.usesCount >= data.maxUses) return { valid: false, reason: 'codigo agotado' };
    await db().collection('referral_codes').doc(code).set({ usesCount: data.usesCount + 1 }, { merge: true });
    return { valid: true, uid: data.uid, rewardType: data.rewardType, rewardValue: data.rewardValue };
  } catch (e) {
    console.error('[VIRAL_REF] Error validando codigo: ' + e.message);
    return { valid: false, reason: e.message };
  }
}

async function getReferralStats(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('referral_codes').where('uid', '==', uid).get();
    var codes = [];
    snap.forEach(function(doc) { codes.push(doc.data()); });
    var totalUses = codes.reduce(function(sum, c) { return sum + (c.usesCount || 0); }, 0);
    return { uid, codesCount: codes.length, totalUses, codes };
  } catch (e) {
    console.error('[VIRAL_REF] Error obteniendo stats: ' + e.message);
    return { uid, codesCount: 0, totalUses: 0, codes: [] };
  }
}

module.exports = {
  generateCode,
  isCodeExpired,
  isCodeValid,
  createReferralCode,
  validateAndUseCode,
  getReferralStats,
  REWARD_TYPES,
  CODE_STATUSES,
  CODE_LENGTH,
  CODE_EXPIRY_DAYS,
  MAX_USES_PER_CODE,
  __setFirestoreForTests,
};
