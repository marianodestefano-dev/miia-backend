'use strict';

/**
 * R26 — core/inter_miia_directory.js (Piso 5 P5.1)
 * Directorio de la red inter-MIIA: perfiles publicos, busqueda por servicio/zona,
 * derivacion de leads cross-tenant con consentimiento, y deteccion de fraude.
 * Complementa inter_miia_network.js (referrals + comisiones).
 * Schema:
 *   - owners/{uid}/profile_public/v1
 *   - owners/{uid}/derivations/{id}
 *   - owners/{uid}/fraud_signals/{phone}
 */

const MAX_RESULTS = 20;
const FRAUD_THRESHOLD_DERIV_DAY = 10;
const FRAUD_THRESHOLD_SAME_PHONE = 3;
const FRAUD_BLOCK_TTL_MS = 24 * 60 * 60 * 1000;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _profilePublicDoc(uid) {
  return db().collection('owners').doc(uid).collection('profile_public').doc('v1');
}
function _derivationsCol(uid) {
  return db().collection('owners').doc(uid).collection('derivations');
}
function _fraudSignalDoc(uid, phone) {
  return db().collection('owners').doc(uid).collection('fraud_signals').doc(phone);
}
function _ownersCol() {
  return db().collection('owners');
}

// ── Profile publico ───────────────────────────────────────────────────────────
async function setPublicProfile(uid, profile) {
  if (!uid) throw new Error('uid_requerido');
  if (!profile || typeof profile !== 'object') throw new Error('profile_invalido');
  const payload = {
    categoria: profile.categoria || null,
    zona: (profile.zona || '').toLowerCase(),
    servicios: Array.isArray(profile.servicios)
      ? profile.servicios.map(function (s) { return String(s).toLowerCase(); })
      : [],
    opt_in_red: !!profile.opt_in_red,
    updatedAt: new Date().toISOString(),
  };
  await _profilePublicDoc(uid).set(payload, { merge: true });
  console.log('[INTER-MIIA] perfil uid=' + uid.slice(0, 8) + ' opt_in=' + payload.opt_in_red);
  return { ok: true };
}

async function getPublicProfile(uid) {
  if (!uid) throw new Error('uid_requerido');
  const snap = await _profilePublicDoc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

// ── Busqueda ──────────────────────────────────────────────────────────────────
async function searchOwners(criteria) {
  const c = criteria || {};
  const limit = Math.min(parseInt(c.limit) || 10, MAX_RESULTS);
  const snap = await _ownersCol().get();
  const docs = snap.docs || [];
  const results = [];
  for (const ownerDoc of docs) {
    const uid = ownerDoc.id;
    const profileSnap = await _profilePublicDoc(uid).get();
    if (!profileSnap.exists) continue;
    const profile = profileSnap.data();
    if (!profile.opt_in_red) continue;
    if (c.zona && profile.zona !== c.zona.toLowerCase()) continue;
    if (c.categoria && profile.categoria !== c.categoria) continue;
    if (c.servicio) {
      const serv = c.servicio.toLowerCase();
      const matches = (profile.servicios || []).some(function (s) {
        return s === serv || s.indexOf(serv) >= 0;
      });
      if (!matches) continue;
    }
    results.push({
      uid,
      categoria: profile.categoria,
      zona: profile.zona,
      servicios: profile.servicios || [],
    });
    if (results.length >= limit) break;
  }
  return results;
}

// ── Fraude ────────────────────────────────────────────────────────────────────
async function recordDerivationSignal(uid, phone) {
  if (!uid || !phone) throw new Error('parametros_requeridos');
  const ref = _fraudSignalDoc(uid, phone);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const now = Date.now();
  const lastDay = data.last_day_start ? new Date(data.last_day_start).getTime() : 0;
  const inSameDay = (now - lastDay) < 24 * 60 * 60 * 1000;
  const countDay = inSameDay ? ((data.count_day || 0) + 1) : 1;
  const countTotal = (data.count_total || 0) + 1;
  let blocked = !!data.blocked;
  let blockedUntil = data.blocked_until || null;
  if (countTotal >= FRAUD_THRESHOLD_SAME_PHONE || countDay >= FRAUD_THRESHOLD_DERIV_DAY) {
    blocked = true;
    blockedUntil = new Date(now + FRAUD_BLOCK_TTL_MS).toISOString();
    console.log('[INTER-MIIA] FRAUD BLOCK uid=' + uid.slice(0, 8) + ' phone=' + phone.slice(-4));
  }
  await ref.set({
    phone,
    count_day: countDay,
    count_total: countTotal,
    last_day_start: inSameDay
      ? /* istanbul ignore next */ (data.last_day_start || new Date(now).toISOString())
      : new Date(now).toISOString(),
    blocked,
    blocked_until: blockedUntil,
    updatedAt: new Date(now).toISOString(),
  }, { merge: true });
  return { blocked, count_day: countDay, count_total: countTotal };
}

async function isFraudBlocked(uid, phone) {
  if (!uid || !phone) return false;
  const snap = await _fraudSignalDoc(uid, phone).get();
  if (!snap.exists) return false;
  const data = snap.data();
  if (!data.blocked) return false;
  if (data.blocked_until && new Date(data.blocked_until).getTime() < Date.now()) return false;
  return true;
}

async function unblockPhone(uid, phone) {
  if (!uid || !phone) throw new Error('parametros_requeridos');
  await _fraudSignalDoc(uid, phone).set({
    blocked: false,
    blocked_until: null,
    unblockedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true };
}

// ── Derivacion ────────────────────────────────────────────────────────────────
async function deriveLead(fromUid, toUid, leadInfo) {
  if (!fromUid || !toUid) throw new Error('uids_requeridos');
  if (fromUid === toUid) throw new Error('mismo_uid_invalido');
  if (!leadInfo || !leadInfo.phone || !leadInfo.motivo) throw new Error('lead_info_incompleto');

  const targetSnap = await _profilePublicDoc(toUid).get();
  if (!targetSnap.exists) throw new Error('destino_sin_perfil');
  const targetProfile = targetSnap.data();
  if (!targetProfile.opt_in_red) throw new Error('destino_no_acepta_red');

  const blocked = await isFraudBlocked(fromUid, leadInfo.phone);
  if (blocked) throw new Error('bloqueado_por_fraude');

  const derivationId = 'der_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    derivationId,
    fromUid,
    toUid,
    phone: leadInfo.phone,
    motivo: leadInfo.motivo,
    contacto_nombre: leadInfo.contacto_nombre || null,
    status: 'enviado',
    createdAt: new Date().toISOString(),
  };
  await _derivationsCol(fromUid).doc(derivationId).set(record);
  await _derivationsCol(toUid).doc(derivationId).set({ ...record, status: 'recibido' });

  await recordDerivationSignal(fromUid, leadInfo.phone);

  console.log('[INTER-MIIA] deriv ' + fromUid.slice(0, 8) + ' -> ' + toUid.slice(0, 8) + ' phone=' + leadInfo.phone.slice(-4));
  return { ok: true, derivationId };
}

async function updateDerivationStatus(uid, derivationId, status) {
  if (!uid || !derivationId) throw new Error('parametros_requeridos');
  const validStatuses = ['recibido', 'aceptado', 'rechazado', 'cerrado'];
  if (!validStatuses.includes(status)) throw new Error('status_invalido: ' + status);
  await _derivationsCol(uid).doc(derivationId).set({
    status,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true, status };
}

module.exports = {
  setPublicProfile,
  getPublicProfile,
  searchOwners,
  deriveLead,
  updateDerivationStatus,
  recordDerivationSignal,
  isFraudBlocked,
  unblockPhone,
  MAX_RESULTS,
  FRAUD_THRESHOLD_DERIV_DAY,
  FRAUD_THRESHOLD_SAME_PHONE,
  FRAUD_BLOCK_TTL_MS,
  __setFirestoreForTests,
};
