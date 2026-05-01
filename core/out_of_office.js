'use strict';

/**
 * MIIA - Out of Office (T179)
 * Modo fuera de oficina: MIIA maneja leads en ausencia del owner.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const OOO_MODES = Object.freeze(['auto_reply', 'collect_info', 'schedule_callback', 'full_handle']);
const DEFAULT_MODE = 'auto_reply';
const DEFAULT_MESSAGE_ES = 'Hola! En este momento no estoy disponible. Te respondo a la brevedad.';
const DEFAULT_MESSAGE_EN = 'Hello! I am currently unavailable. I will get back to you shortly.';
const DEFAULT_CALLBACK_DELAY_HOURS = 2;
const MAX_OOO_DAYS = 30;

OOO_MODES;


/**
 * Activa el modo fuera de oficina para el owner.
 * @param {string} uid
 * @param {object} opts - {mode, message, returnAt, collectFields, language}
 */
async function activateOOO(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  const options = opts || {};

  const mode = options.mode || DEFAULT_MODE;
  if (!OOO_MODES.includes(mode)) throw new Error('modo invalido: ' + mode);

  const returnAt = options.returnAt || null;
  if (returnAt) {
    const returnDate = new Date(returnAt);
    if (isNaN(returnDate.getTime())) throw new Error('returnAt formato invalido');
    const maxDays = MAX_OOO_DAYS * 24 * 60 * 60 * 1000;
    if (returnDate.getTime() - Date.now() > maxDays) {
      throw new Error('returnAt no puede ser mas de ' + MAX_OOO_DAYS + ' dias');
    }
  }

  const language = options.language || 'es';
  const defaultMsg = language === 'en' ? DEFAULT_MESSAGE_EN : DEFAULT_MESSAGE_ES;
  const message = options.message || defaultMsg;

  const doc = {
    uid,
    active: true,
    mode,
    message,
    returnAt,
    collectFields: Array.isArray(options.collectFields) ? options.collectFields : [],
    activatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await db().collection('out_of_office').doc(uid).set(doc);
    console.log('[OOO] activado uid=' + uid.substring(0, 8) + ' mode=' + mode);
  } catch (e) {
    console.error('[OOO] Error activando uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Desactiva el modo fuera de oficina.
 * @param {string} uid
 */
async function deactivateOOO(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    await db().collection('out_of_office').doc(uid).set(
      { active: false, deactivatedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log('[OOO] desactivado uid=' + uid.substring(0, 8));
  } catch (e) {
    console.error('[OOO] Error desactivando uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Lee el estado actual del modo OOO del owner.
 * @param {string} uid
 * @returns {Promise<{active, mode, message, returnAt, ...} | null>}
 */
async function getOOOState(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('out_of_office').doc(uid).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.returnAt && new Date(data.returnAt).getTime() <= Date.now() && data.active) {
      return { ...data, active: false, _autoExpired: true };
    }
    return data;
  } catch (e) {
    console.error('[OOO] Error leyendo estado uid=' + uid.substring(0, 8) + ': ' + e.message);
    return null;
  }
}

/**
 * Verifica si el owner esta en modo OOO activo.
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function isOOOActive(uid) {
  if (!uid) throw new Error('uid requerido');
  const state = await getOOOState(uid);
  return state !== null && state.active === true && !state._autoExpired;
}


/**
 * Genera la respuesta automatica para un lead en modo OOO.
 * @param {object} oooState - estado OOO del owner
 * @param {object} lead - {phone, name}
 * @returns {string} mensaje de respuesta
 */
function buildOOOResponse(oooState, lead) {
  if (!oooState) throw new Error('oooState requerido');
  if (!oooState.active) throw new Error('OOO no esta activo');

  let msg = oooState.message || DEFAULT_MESSAGE_ES;

  if (oooState.returnAt) {
    const returnDate = new Date(oooState.returnAt);
    const returnStr = returnDate.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    msg += ' Estaré disponible el ' + returnStr + '.';
  }

  return msg;
}

/**
 * Registra la informacion recopilada de un lead durante el OOO.
 * @param {string} uid
 * @param {string} phone
 * @param {object} collectedInfo - datos recopilados del lead
 */
async function recordLeadInfoDuringOOO(uid, phone, collectedInfo) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!collectedInfo || typeof collectedInfo !== 'object') throw new Error('collectedInfo requerido');

  const doc = {
    uid, phone,
    collectedAt: new Date().toISOString(),
    info: collectedInfo,
    processed: false,
  };

  try {
    const id = uid.substring(0, 8) + '_' + phone.slice(-10) + '_' + Date.now();
    await db()
      .collection('ooo_leads').doc(uid)
      .collection('pending').doc(id)
      .set(doc);
    console.log('[OOO] lead info registrada uid=' + uid.substring(0, 8) + ' phone=' + phone.slice(-6));
  } catch (e) {
    console.error('[OOO] Error registrando lead info: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene los leads pendientes de atender post-OOO.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getPendingOOOLeads(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('ooo_leads').doc(uid)
      .collection('pending')
      .where('processed', '==', false)
      .get();
    const leads = [];
    snap.forEach(doc => leads.push({ id: doc.id, ...doc.data() }));
    return leads;
  } catch (e) {
    console.error('[OOO] Error leyendo leads pendientes uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

/**
 * Marca un lead OOO como procesado.
 * @param {string} uid
 * @param {string} leadId
 */
async function markOOOLeadProcessed(uid, leadId) {
  if (!uid) throw new Error('uid requerido');
  if (!leadId) throw new Error('leadId requerido');
  try {
    await db()
      .collection('ooo_leads').doc(uid)
      .collection('pending').doc(leadId)
      .set({ processed: true, processedAt: new Date().toISOString() }, { merge: true });
  } catch (e) {
    console.error('[OOO] Error marcando lead procesado: ' + e.message);
    throw e;
  }
}

module.exports = {
  activateOOO, deactivateOOO, getOOOState, isOOOActive,
  buildOOOResponse, recordLeadInfoDuringOOO,
  getPendingOOOLeads, markOOOLeadProcessed,
  OOO_MODES, DEFAULT_MODE, DEFAULT_MESSAGE_ES, DEFAULT_MESSAGE_EN,
  DEFAULT_CALLBACK_DELAY_HOURS, MAX_OOO_DAYS,
  __setFirestoreForTests,
};
