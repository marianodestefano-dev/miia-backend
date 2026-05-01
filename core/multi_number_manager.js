'use strict';

/**
 * MIIA - Multi Number Manager (T186)
 * Permite al owner operar con multiples numeros de WhatsApp.
 * Cada numero puede tener un rol: ventas, soporte, delivery, etc.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const NUMBER_ROLES = Object.freeze(['sales', 'support', 'delivery', 'general', 'vip', 'bot_only']);
const DEFAULT_ROLE = 'general';
const MAX_NUMBERS_PER_OWNER = 5;

NUMBER_ROLES;


/**
 * Registra un numero de WhatsApp para el owner.
 * @param {string} uid
 * @param {string} phone - numero E.164
 * @param {object} [opts] - {role, label, active}
 */
async function registerNumber(uid, phone, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
  if (!/^\+\d{8,15}$/.test(phone)) throw new Error('phone formato invalido (E.164)');

  const options = opts || {};
  const role = options.role && NUMBER_ROLES.includes(options.role) ? options.role : DEFAULT_ROLE;
  const label = options.label || phone;

  const existing = await getOwnerNumbers(uid);
  if (existing.length >= MAX_NUMBERS_PER_OWNER) {
    throw new Error('maximo ' + MAX_NUMBERS_PER_OWNER + ' numeros por owner');
  }
  if (existing.some(n => n.phone === phone)) {
    throw new Error('numero ya registrado: ' + phone);
  }

  const doc = {
    uid, phone, role, label,
    active: options.active !== false,
    registeredAt: new Date().toISOString(),
  };

  try {
    const phoneKey = phone.replace('+', '');
    await db().collection('owner_numbers').doc(uid).collection('numbers').doc(phoneKey).set(doc);
    console.log('[MULTI] numero registrado uid=' + uid.substring(0, 8) + ' phone=' + phone + ' role=' + role);
  } catch (e) {
    console.error('[MULTI] Error registrando numero: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene los numeros registrados del owner.
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
async function getOwnerNumbers(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('owner_numbers').doc(uid)
      .collection('numbers').get();
    const numbers = [];
    snap.forEach(doc => numbers.push({ id: doc.id, ...doc.data() }));
    return numbers;
  } catch (e) {
    console.error('[MULTI] Error leyendo numeros uid=' + uid.substring(0, 8) + ': ' + e.message);
    return [];
  }
}

/**
 * Actualiza el rol o estado de un numero.
 * @param {string} uid
 * @param {string} phone
 * @param {object} updates - {role, label, active}
 */
async function updateNumber(uid, phone, updates) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates requerido');

  if (updates.role && !NUMBER_ROLES.includes(updates.role)) {
    throw new Error('rol invalido: ' + updates.role);
  }

  const phoneKey = phone.replace('+', '');
  const allowed = {};
  if (updates.role !== undefined) allowed.role = updates.role;
  if (updates.label !== undefined) allowed.label = updates.label;
  if (updates.active !== undefined) allowed.active = Boolean(updates.active);
  allowed.updatedAt = new Date().toISOString();

  try {
    await db()
      .collection('owner_numbers').doc(uid)
      .collection('numbers').doc(phoneKey)
      .set(allowed, { merge: true });
    console.log('[MULTI] numero actualizado uid=' + uid.substring(0, 8) + ' phone=' + phone);
  } catch (e) {
    console.error('[MULTI] Error actualizando numero: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene el numero activo con el rol especificado.
 * @param {string} uid
 * @param {string} role
 * @returns {Promise<string|null>} phone number or null
 */
async function getNumberByRole(uid, role) {
  if (!uid) throw new Error('uid requerido');
  if (!role) throw new Error('role requerido');
  if (!NUMBER_ROLES.includes(role)) throw new Error('rol invalido: ' + role);

  const numbers = await getOwnerNumbers(uid);
  const match = numbers.find(n => n.role === role && n.active !== false);
  return match ? match.phone : null;
}

/**
 * Determina a qué numero debe ir un mensaje según el contexto del lead.
 * @param {string} uid
 * @param {object} context - {leadScore, isVip, isExistingClient, topic}
 * @returns {Promise<string|null>} phone del numero a usar
 */
async function routeMessage(uid, context) {
  if (!uid) throw new Error('uid requerido');
  if (!context || typeof context !== 'object') throw new Error('context requerido');

  const numbers = await getOwnerNumbers(uid);
  if (numbers.length === 0) return null;

  const active = numbers.filter(n => n.active !== false);
  if (active.length === 0) return null;

  if (context.isVip) {
    const vip = active.find(n => n.role === 'vip');
    if (vip) return vip.phone;
  }

  if (context.topic === 'support' || context.isExistingClient) {
    const support = active.find(n => n.role === 'support');
    if (support) return support.phone;
  }

  if (context.topic === 'delivery') {
    const delivery = active.find(n => n.role === 'delivery');
    if (delivery) return delivery.phone;
  }

  if (context.leadScore !== undefined && context.leadScore >= 40) {
    const sales = active.find(n => n.role === 'sales');
    if (sales) return sales.phone;
  }

  const general = active.find(n => n.role === 'general') || active[0];
  return general ? general.phone : null;
}

module.exports = {
  registerNumber, getOwnerNumbers, updateNumber, getNumberByRole, routeMessage,
  NUMBER_ROLES, DEFAULT_ROLE, MAX_NUMBERS_PER_OWNER,
  __setFirestoreForTests,
};
