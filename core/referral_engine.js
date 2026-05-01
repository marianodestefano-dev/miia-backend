'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const REFERRAL_STATUSES = Object.freeze(['pending', 'qualified', 'rewarded', 'expired', 'cancelled']);
const REWARD_TRIGGERS = Object.freeze(['first_purchase', 'first_appointment', 'subscription', 'signup', 'custom']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O, 0, I, 1 para evitar confusion

const CODE_LENGTH = 6;
const MAX_REFERRALS_PER_CODE = 100;
const CODE_EXPIRY_DAYS = 90;
const MIN_REWARD_AMOUNT = 0;
const MAX_REWARD_AMOUNT = 100000;

function isValidStatus(s) { return REFERRAL_STATUSES.includes(s); }
function isValidTrigger(t) { return REWARD_TRIGGERS.includes(t); }

function generateReferralCode(uid, seed) {
  // Determinístico si se da seed, random si no
  const chars = CODE_CHARS;
  const base = seed || (uid.slice(0, 4) + Date.now().toString(36).slice(-4));
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash + base.charCodeAt(i)) | 0;
    hash = Math.abs(hash);
  }
  let code = '';
  let h = hash;
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += chars[h % chars.length];
    h = Math.floor(h / chars.length) + (hash >> i);
    h = Math.abs(h);
  }
  return code;
}

function buildReferralProgramRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const code = data.code || generateReferralCode(uid, data.codeSeed);
  return {
    programId: uid.slice(0, 8) + '_referral_prog',
    uid,
    code,
    referredCount: 0,
    qualifiedCount: 0,
    rewardedCount: 0,
    referrerRewardAmount: typeof data.referrerRewardAmount === 'number' ? Math.min(MAX_REWARD_AMOUNT, Math.max(0, data.referrerRewardAmount)) : 0,
    referrerRewardType: data.referrerRewardType || 'fixed',
    referredRewardAmount: typeof data.referredRewardAmount === 'number' ? Math.min(MAX_REWARD_AMOUNT, Math.max(0, data.referredRewardAmount)) : 0,
    referredRewardType: data.referredRewardType || 'fixed',
    rewardTrigger: isValidTrigger(data.rewardTrigger) ? data.rewardTrigger : 'first_purchase',
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    active: data.active !== false,
    maxReferrals: typeof data.maxReferrals === 'number' ? data.maxReferrals : MAX_REFERRALS_PER_CODE,
    expiresAt: data.expiresAt || (now + CODE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function buildReferralRecord(uid, referrerPhone, referredPhone, data) {
  data = data || {};
  const now = Date.now();
  const referralId = uid.slice(0, 8) + '_ref_' + referredPhone.replace(/[^0-9]/g, '').slice(-8) + '_' + now.toString(36).slice(-4);
  return {
    referralId,
    uid,
    code: data.code || '',
    referrerPhone: referrerPhone.trim(),
    referredPhone: referredPhone.trim(),
    status: 'pending',
    rewardTrigger: isValidTrigger(data.rewardTrigger) ? data.rewardTrigger : 'first_purchase',
    referrerRewarded: false,
    referredRewarded: false,
    referrerRewardAmount: typeof data.referrerRewardAmount === 'number' ? data.referrerRewardAmount : 0,
    referredRewardAmount: typeof data.referredRewardAmount === 'number' ? data.referredRewardAmount : 0,
    qualifiedAt: null,
    rewardedAt: null,
    expiresAt: data.expiresAt || (now + CODE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function qualifyReferral(referral) {
  if (referral.status !== 'pending') throw new Error('Solo referidos pending pueden calificarse. Estado actual: ' + referral.status);
  const now = Date.now();
  if (referral.expiresAt && referral.expiresAt < now) throw new Error('El referido ha expirado');
  return { ...referral, status: 'qualified', qualifiedAt: now, updatedAt: now };
}

function rewardReferral(referral) {
  if (referral.status !== 'qualified') throw new Error('Solo referidos qualified pueden recompensarse. Estado: ' + referral.status);
  const now = Date.now();
  return {
    ...referral,
    status: 'rewarded',
    referrerRewarded: true,
    referredRewarded: true,
    rewardedAt: now,
    updatedAt: now,
  };
}

function expireReferral(referral) {
  if (referral.status === 'rewarded' || referral.status === 'expired') {
    throw new Error('No se puede expirar un referido en estado: ' + referral.status);
  }
  return { ...referral, status: 'expired', updatedAt: Date.now() };
}

function applyProgramStats(program, action) {
  const now = Date.now();
  const updated = { ...program, updatedAt: now };
  if (action === 'referred') updated.referredCount += 1;
  if (action === 'qualified') updated.qualifiedCount += 1;
  if (action === 'rewarded') updated.rewardedCount += 1;
  return updated;
}

function isProgramActive(program) {
  if (!program.active) return false;
  if (program.expiresAt && program.expiresAt < Date.now()) return false;
  if (program.referredCount >= program.maxReferrals) return false;
  return true;
}

function computeConversionRate(program) {
  if (program.referredCount === 0) return 0;
  return Math.round((program.qualifiedCount / program.referredCount) * 100);
}

function buildReferralProgramText(program) {
  if (!program) return 'Programa de referidos no encontrado.';
  const parts = [];
  const active = isProgramActive(program);
  parts.push((active ? '\u{1F7E2}' : '\u{1F534}') + ' *Programa de Referidos*');
  parts.push('Codigo: ' + program.code + ' | Estado: ' + (active ? 'activo' : 'inactivo'));
  parts.push('Referidos: ' + program.referredCount + ' | Calificados: ' + program.qualifiedCount + ' | Recompensados: ' + program.rewardedCount);
  parts.push('Conversion: ' + computeConversionRate(program) + '%');
  if (program.referrerRewardAmount > 0) {
    parts.push('Premio referidor: ' + program.referrerRewardAmount + ' ' + program.currency);
  }
  if (program.referredRewardAmount > 0) {
    parts.push('Premio referido: ' + program.referredRewardAmount + ' ' + program.currency);
  }
  parts.push('Trigger: ' + program.rewardTrigger);
  return parts.join('\n');
}

async function saveReferralProgram(uid, program) {
  console.log('[REFERRAL] Guardando programa uid=' + uid + ' code=' + program.code);
  try {
    await db().collection('owners').doc(uid)
      .collection('referral_programs').doc(program.programId)
      .set(program, { merge: false });
    return program.programId;
  } catch (err) {
    console.error('[REFERRAL] Error guardando programa:', err.message);
    throw err;
  }
}

async function getReferralProgram(uid, programId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('referral_programs').doc(programId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[REFERRAL] Error obteniendo programa:', err.message);
    return null;
  }
}

async function saveReferral(uid, referral) {
  console.log('[REFERRAL] Guardando referido id=' + referral.referralId + ' status=' + referral.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('referrals').doc(referral.referralId)
      .set(referral, { merge: false });
    return referral.referralId;
  } catch (err) {
    console.error('[REFERRAL] Error guardando referido:', err.message);
    throw err;
  }
}

async function getReferral(uid, referralId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('referrals').doc(referralId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[REFERRAL] Error obteniendo referido:', err.message);
    return null;
  }
}

async function updateReferral(uid, referralId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('referrals').doc(referralId)
      .set(update, { merge: true });
    return referralId;
  } catch (err) {
    console.error('[REFERRAL] Error actualizando referido:', err.message);
    throw err;
  }
}

async function listReferralsByStatus(uid, status) {
  if (!isValidStatus(status)) return [];
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('referrals').where('status', '==', status).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[REFERRAL] Error listando referidos:', err.message);
    return [];
  }
}

module.exports = {
  buildReferralProgramRecord,
  buildReferralRecord,
  qualifyReferral,
  rewardReferral,
  expireReferral,
  applyProgramStats,
  isProgramActive,
  computeConversionRate,
  generateReferralCode,
  buildReferralProgramText,
  saveReferralProgram,
  getReferralProgram,
  saveReferral,
  getReferral,
  updateReferral,
  listReferralsByStatus,
  REFERRAL_STATUSES,
  REWARD_TRIGGERS,
  CODE_LENGTH,
  MAX_REFERRALS_PER_CODE,
  CODE_EXPIRY_DAYS,
  __setFirestoreForTests,
};
