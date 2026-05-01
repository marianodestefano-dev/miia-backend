'use strict';

/**
 * MIIA - Trusted Contacts Registry (T234)
 * PB.4 ROADMAP: registro de contactos de confianza para recovery del owner.
 * Familia/equipo que puede recuperar acceso si el owner pierde su cuenta.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const TRUST_LEVELS = Object.freeze(['primary', 'secondary', 'emergency']);
const CONTACT_ROLES = Object.freeze(['family', 'partner', 'employee', 'accountant', 'it_admin']);
const MAX_TRUSTED_CONTACTS = 5;
const VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
const RECOVERY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function isValidTrustLevel(level) {
  return TRUST_LEVELS.includes(level);
}

function isValidContactRole(role) {
  return CONTACT_ROLES.includes(role);
}

function buildTrustedContactRecord(phone, opts) {
  return {
    phone,
    name: (opts && opts.name) ? String(opts.name) : null,
    role: (opts && opts.role && isValidContactRole(opts.role)) ? opts.role : 'family',
    trustLevel: (opts && opts.trustLevel && isValidTrustLevel(opts.trustLevel)) ? opts.trustLevel : 'secondary',
    verified: false,
    verifiedAt: null,
    addedAt: new Date().toISOString(),
    canInitiateRecovery: (opts && opts.canInitiateRecovery === true),
    lastContactAt: null,
  };
}

async function getTrustedContacts(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection('trusted_contacts').get();
    var results = [];
    snap.forEach(function(doc) { results.push({ id: doc.id, ...doc.data() }); });
    return results;
  } catch (e) {
    console.error('[TRUSTED_CONTACTS] Error leyendo contactos: ' + e.message);
    return [];
  }
}

async function addTrustedContact(uid, phone, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var existing = await getTrustedContacts(uid);
  if (existing.length >= MAX_TRUSTED_CONTACTS) {
    throw new Error('maximo de contactos de confianza alcanzado: ' + MAX_TRUSTED_CONTACTS);
  }
  var alreadyExists = existing.some(function(c) { return c.phone === phone || c.id === phone.replace(/\D/g, '').slice(-10); });
  if (alreadyExists) throw new Error('contacto ya existe: ' + phone);
  var record = buildTrustedContactRecord(phone, opts);
  var docId = phone.replace(/\D/g, '').slice(-10);
  await db().collection('tenants').doc(uid).collection('trusted_contacts').doc(docId).set(record);
  console.log('[TRUSTED_CONTACTS] Agregado uid=' + uid + ' phone=' + phone);
  return { docId, record };
}

async function removeTrustedContact(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var docId = phone.replace(/\D/g, '').slice(-10);
  await db().collection('tenants').doc(uid).collection('trusted_contacts').doc(docId).delete();
  console.log('[TRUSTED_CONTACTS] Eliminado uid=' + uid + ' phone=' + phone);
}

async function verifyTrustedContact(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var docId = phone.replace(/\D/g, '').slice(-10);
  await db().collection('tenants').doc(uid).collection('trusted_contacts').doc(docId).set({
    verified: true,
    verifiedAt: new Date().toISOString(),
  }, { merge: true });
  console.log('[TRUSTED_CONTACTS] Verificado uid=' + uid + ' phone=' + phone);
}

async function initiateRecovery(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var contacts = await getTrustedContacts(uid);
  var docId = phone.replace(/\D/g, '').slice(-10);
  var contact = contacts.find(function(c) { return c.id === docId; });
  if (!contact) throw new Error('contacto no registrado como confianza');
  if (!contact.verified) throw new Error('contacto no verificado aun');
  if (!contact.canInitiateRecovery) throw new Error('contacto no tiene permiso de recovery');
  var recoveryId = 'rec_' + uid.slice(0, 4) + '_' + Date.now().toString(36);
  var record = {
    uid,
    initiatedBy: phone,
    initiatedAt: new Date().toISOString(),
    status: 'pending',
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS).toISOString(),
  };
  await db().collection('tenants').doc(uid).collection('recovery_requests').doc(recoveryId).set(record);
  console.log('[TRUSTED_CONTACTS] Recovery iniciado uid=' + uid + ' by=' + phone + ' id=' + recoveryId);
  return { recoveryId, record };
}

function buildVerificationMessage(phone, uid) {
  return 'MIIA: Hola ' + (phone || 'contacto') + ', el owner de MIIA te agrego como contacto de confianza. Para verificarte, responde SI a este mensaje.';
}

function buildRecoveryNotificationText(contact) {
  return 'MIIA RECOVERY: ' + (contact.name || contact.phone) + ' ha iniciado una solicitud de recuperacion de tu cuenta. Responde CONFIRMAR para autorizar o CANCELAR para rechazar.';
}

module.exports = {
  addTrustedContact,
  removeTrustedContact,
  getTrustedContacts,
  verifyTrustedContact,
  initiateRecovery,
  buildVerificationMessage,
  buildRecoveryNotificationText,
  isValidTrustLevel,
  isValidContactRole,
  TRUST_LEVELS,
  CONTACT_ROLES,
  MAX_TRUSTED_CONTACTS,
  VERIFICATION_TTL_MS,
  RECOVERY_COOLDOWN_MS,
  __setFirestoreForTests,
};
