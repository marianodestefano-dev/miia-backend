'use strict';

/**
 * sports_detector.js -- T-MD-1
 * Schema y CRUD para users/{uid}/miia_sports/{contactPhone}
 * Permite registrar deportes/equipos favoritos por contacto del owner.
 *
 * Schema doc:
 *   contactPhone: string (o 'self')
 *   contactName: string
 *   sports: array<{type, team?, driver?, rivalry?}>
 *   updatedAt: ISO string
 */

const SPORT_TYPES = Object.freeze(['futbol', 'f1', 'tenis', 'basket']);
const COL_SPORTS = 'miia_sports';

/* istanbul ignore next */
let _db = null;
/* istanbul ignore next */
function __setFirestoreForTests(fs) { _db = fs; }
/* istanbul ignore next */
function db() { return _db || require('firebase-admin').firestore(); }

function _validateSportSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('sportSpec requerido');
  if (!SPORT_TYPES.includes(spec.type)) throw new Error('type invalido: ' + spec.type);
  if (spec.type === 'futbol' && !spec.team) throw new Error('team requerido para futbol');
  if (spec.type === 'f1' && !spec.driver) throw new Error('driver requerido para f1');
  return true;
}

function _normalizeContactKey(phone) {
  if (!phone) throw new Error('contactPhone requerido');
  return String(phone).replace(/[^0-9a-zA-Z_]/g, '_');
}

async function setSportForContact(uid, contactPhone, sportSpec, opts) {
  if (!uid) throw new Error('uid requerido');
  _validateSportSpec(sportSpec);
  const key = _normalizeContactKey(contactPhone);
  const meta = opts || {};
  const ref = db().collection('owners').doc(uid).collection(COL_SPORTS).doc(key);
  const existing = await ref.get();
  let sports = [];
  if (existing && existing.exists && existing.data) {
    const data = existing.data();
    sports = Array.isArray(data.sports) ? data.sports.filter(s => s.type !== sportSpec.type) : [];
  }
  sports.push(sportSpec);
  await ref.set({
    contactPhone: String(contactPhone),
    contactName: meta.contactName || null,
    sports,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { contactPhone, sports };
}

async function getSportsForContact(uid, contactPhone) {
  if (!uid) throw new Error('uid requerido');
  if (!contactPhone) throw new Error('contactPhone requerido');
  const key = _normalizeContactKey(contactPhone);
  const doc = await db().collection('owners').doc(uid).collection(COL_SPORTS).doc(key).get();
  if (!doc || !doc.exists) return [];
  const data = doc.data ? doc.data() : {};
  return Array.isArray(data.sports) ? data.sports : [];
}

async function removeSportForContact(uid, contactPhone, sportType) {
  if (!uid) throw new Error('uid requerido');
  if (!contactPhone) throw new Error('contactPhone requerido');
  if (!SPORT_TYPES.includes(sportType)) throw new Error('type invalido: ' + sportType);
  const key = _normalizeContactKey(contactPhone);
  const ref = db().collection('owners').doc(uid).collection(COL_SPORTS).doc(key);
  const doc = await ref.get();
  if (!doc || !doc.exists) return [];
  const data = doc.data ? doc.data() : {};
  const sports = (Array.isArray(data.sports) ? data.sports : []).filter(s => s.type !== sportType);
  await ref.set({ sports, updatedAt: new Date().toISOString() }, { merge: true });
  return sports;
}

async function getAllContactsBySport(uid, sportType) {
  if (!uid) throw new Error('uid requerido');
  if (!SPORT_TYPES.includes(sportType)) throw new Error('type invalido: ' + sportType);
  const snap = await db().collection('owners').doc(uid).collection(COL_SPORTS).get();
  const out = [];
  snap.forEach(d => {
    const data = d.data ? d.data() : {};
    const sports = Array.isArray(data.sports) ? data.sports : [];
    const match = sports.find(s => s.type === sportType);
    if (match) {
      out.push({
        contactPhone: data.contactPhone,
        contactName: data.contactName,
        sport: match,
      });
    }
  });
  return out;
}

module.exports = {
  setSportForContact,
  getSportsForContact,
  removeSportForContact,
  getAllContactsBySport,
  SPORT_TYPES,
  __setFirestoreForTests,
};
