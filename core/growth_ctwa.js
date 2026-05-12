'use strict';

/**
 * R28 — core/growth_ctwa.js (Piso 5 P5.3)
 * Click-to-WhatsApp (CTWA) ads tracking + B2B Growth Loop.
 * - Genera URLs CTWA con UTM params per campaign + owner phone.
 * - Trackea conversiones (lead llega via CTWA) y attribution.
 * - B2B Growth Loop: cada nuevo owner B2B genera un trigger viral
 *   (introduce a otros owners de su categoria/zona).
 *
 * Schema:
 *   - owners/{uid}/campaigns/{campaignId}
 *   - owners/{uid}/ctwa_clicks/{clickId}
 *   - growth_loop_triggers/{triggerId}  (global)
 */

const WHATSAPP_BASE = 'https://wa.me/';
const MAX_UTM_LENGTH = 100;

const VALID_CHANNELS = Object.freeze(['facebook', 'instagram', 'google', 'tiktok', 'linkedin', 'direct']);

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _campaignsCol(uid) {
  return db().collection('owners').doc(uid).collection('campaigns');
}
function _clicksCol(uid) {
  return db().collection('owners').doc(uid).collection('ctwa_clicks');
}
function _growthTriggersCol() {
  return db().collection('growth_loop_triggers');
}

// ── URL helpers ───────────────────────────────────────────────────────────────
function _sanitizePhone(phone) {
  return String(phone).replace(/[^0-9]/g, '');
}

function _truncate(s, max) {
  /* istanbul ignore next */
  if (!s) return '';
  return String(s).slice(0, max);
}

/**
 * Genera URL Click-to-WhatsApp con UTM params.
 * @param {string} ownerPhone - WhatsApp del owner (numeric)
 * @param {{ campaignId, channel, message, source, medium }} opts
 * @returns {string}
 */
function buildCTWAUrl(ownerPhone, opts) {
  if (!ownerPhone) throw new Error('ownerPhone_requerido');
  const o = opts || {};
  if (!o.campaignId) throw new Error('campaignId_requerido');
  const channel = (o.channel && VALID_CHANNELS.includes(o.channel)) ? o.channel : 'direct';
  const phone = _sanitizePhone(ownerPhone);
  const message = o.message ? encodeURIComponent(_truncate(o.message, 200)) : '';
  const utm = [
    'utm_source=' + _truncate(o.source || channel, MAX_UTM_LENGTH),
    'utm_medium=' + _truncate(o.medium || 'ctwa', MAX_UTM_LENGTH),
    'utm_campaign=' + _truncate(o.campaignId, MAX_UTM_LENGTH),
  ].join('&');
  const params = (message ? 'text=' + message + '&' : '') + utm;
  return WHATSAPP_BASE + phone + '?' + params;
}

// ── Campaigns ─────────────────────────────────────────────────────────────────
/**
 * Crea una campaign CTWA del owner.
 * @param {string} uid
 * @param {{ name, channel, budget, message }} payload
 */
async function createCampaign(uid, payload) {
  if (!uid) throw new Error('uid_requerido');
  if (!payload || !payload.name) throw new Error('name_requerido');
  const campaignId = 'cmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const channel = (payload.channel && VALID_CHANNELS.includes(payload.channel)) ? payload.channel : 'direct';
  const record = {
    campaignId,
    name: _truncate(payload.name, 100),
    channel,
    budget: typeof payload.budget === 'number' ? payload.budget : 0,
    message: payload.message ? _truncate(payload.message, 200) : '',
    active: true,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    createdAt: new Date().toISOString(),
  };
  await _campaignsCol(uid).doc(campaignId).set(record);
  console.log('[CTWA] campaign uid=' + uid.slice(0, 8) + ' id=' + campaignId + ' channel=' + channel);
  return { ok: true, campaignId, ...record };
}

/**
 * Pausa o activa una campaign.
 */
async function setCampaignActive(uid, campaignId, active) {
  if (!uid || !campaignId) throw new Error('parametros_requeridos');
  await _campaignsCol(uid).doc(campaignId).set({
    active: !!active,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { ok: true, active: !!active };
}

// ── Click tracking ────────────────────────────────────────────────────────────
/**
 * Registra un click en una campaign CTWA (incrementa counters).
 * @param {string} uid
 * @param {{ campaignId, leadPhone, fbclid, gclid }} payload
 */
async function recordClick(uid, payload) {
  if (!uid) throw new Error('uid_requerido');
  if (!payload || !payload.campaignId) throw new Error('campaignId_requerido');
  const clickId = 'clk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    clickId,
    campaignId: payload.campaignId,
    leadPhone: payload.leadPhone || null,
    fbclid: payload.fbclid || null,
    gclid: payload.gclid || null,
    converted: false,
    timestamp: new Date().toISOString(),
  };
  await _clicksCol(uid).doc(clickId).set(record);

  // Increment campaign clicks counter
  const camRef = _campaignsCol(uid).doc(payload.campaignId);
  const camSnap = await camRef.get();
  if (camSnap.exists) {
    const camData = camSnap.data();
    await camRef.set({
      clicks: (camData.clicks || 0) + 1,
      lastClickAt: record.timestamp,
    }, { merge: true });
  }
  console.log('[CTWA] click uid=' + uid.slice(0, 8) + ' cmp=' + payload.campaignId);
  return { ok: true, clickId };
}

/**
 * Marca un click como convertido (lead efectivo).
 */
async function markClickConverted(uid, clickId) {
  if (!uid || !clickId) throw new Error('parametros_requeridos');
  const ref = _clicksCol(uid).doc(clickId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('click_no_encontrado');
  const data = snap.data();
  if (data.converted) throw new Error('click_ya_convertido');
  await ref.set({
    converted: true,
    convertedAt: new Date().toISOString(),
  }, { merge: true });

  // Increment campaign conversions counter
  if (data.campaignId) {
    const camRef = _campaignsCol(uid).doc(data.campaignId);
    const camSnap = await camRef.get();
    if (camSnap.exists) {
      const camData = camSnap.data();
      await camRef.set({
        conversions: (camData.conversions || 0) + 1,
      }, { merge: true });
    }
  }
  return { ok: true, campaignId: data.campaignId };
}

// ── B2B Growth Loop ───────────────────────────────────────────────────────────
/**
 * Dispara un growth loop trigger cuando un nuevo owner B2B se onboarda.
 * Otros owners de la misma categoria/zona pueden ser introducidos.
 * @param {string} newOwnerUid
 * @param {{ categoria, zona, contactReason }} info
 */
async function triggerGrowthLoop(newOwnerUid, info) {
  if (!newOwnerUid) throw new Error('newOwnerUid_requerido');
  const i = info || {};
  const triggerId = 'gtr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    triggerId,
    newOwnerUid,
    categoria: i.categoria || null,
    zona: i.zona ? String(i.zona).toLowerCase() : null,
    contactReason: i.contactReason ? _truncate(i.contactReason, 300) : null,
    status: 'pending',
    matchesFound: 0,
    introductionsMade: 0,
    createdAt: new Date().toISOString(),
  };
  await _growthTriggersCol().doc(triggerId).set(record);
  console.log('[GROWTH] trigger uid=' + newOwnerUid.slice(0, 8) + ' cat=' + (i.categoria || '-'));
  return { ok: true, triggerId };
}

/**
 * Actualiza el progreso de un growth trigger (matches/introductions/status).
 */
async function updateGrowthTrigger(triggerId, updates) {
  if (!triggerId) throw new Error('triggerId_requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates_invalido');
  const payload = { updatedAt: new Date().toISOString() };
  if (typeof updates.matchesFound === 'number') payload.matchesFound = updates.matchesFound;
  if (typeof updates.introductionsMade === 'number') payload.introductionsMade = updates.introductionsMade;
  if (updates.status) payload.status = updates.status;
  await _growthTriggersCol().doc(triggerId).set(payload, { merge: true });
  return { ok: true };
}

module.exports = {
  buildCTWAUrl,
  createCampaign,
  setCampaignActive,
  recordClick,
  markClickConverted,
  triggerGrowthLoop,
  updateGrowthTrigger,
  VALID_CHANNELS,
  WHATSAPP_BASE,
  MAX_UTM_LENGTH,
  __setFirestoreForTests,
};
