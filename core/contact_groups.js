'use strict';

/**
 * R17-C — contact_groups.js (Piso 2 P2.4 - C-378 REQ-1+REQ-2)
 * Gestión de grupos de contactos: crear, agregar, mover, listar.
 * Self-chat commands: +grupo / +agregar / +mover / +grupos
 * Schema Firestore: owners/{uid}/contact_groups/{groupId}
 */

const crypto = require('crypto');

const VALID_GROUP_TYPES = Object.freeze(['lead', 'cliente', 'familia', 'equipo', 'custom']);
const MAX_GROUP_NAME_LENGTH = 50;
const MAX_GROUPS_PER_OWNER = 20;

const GROUP_COMMANDS = Object.freeze({
  CREAR: /^\+grupo\s+(.+)$/i,
  AGREGAR: /^\+agregar\s+(\S+)\s+al?\s+(.+)$/i,
  MOVER: /^\+mover\s+(\S+)\s+a\s+(.+)$/i,
  LISTAR: /^\+grupos$/i,
});

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _groupsCol(uid) {
  return db().collection('owners').doc(uid).collection('contact_groups');
}

function _phoneHash(phone) {
  return crypto.createHash('sha256').update(String(phone || /* istanbul ignore next */ '')).digest('hex').slice(0, 16);
}

function _sanitizeGroupName(name) {
  return (name || '').trim().slice(0, MAX_GROUP_NAME_LENGTH);
}

function _groupId(name) {
  return _sanitizeGroupName(name).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_áéíóúüñ]/gi, '');
}

/**
 * Crea un grupo nuevo.
 * @param {string} uid
 * @param {string} nombre
 * @param {string} tipo — lead|cliente|familia|equipo|custom
 * @returns {{ groupId: string, ok: boolean }}
 */
async function createGroup(uid, nombre, tipo) {
  if (!uid) throw new Error('uid_requerido');
  const name = _sanitizeGroupName(nombre);
  if (!name) throw new Error('nombre_requerido');
  const groupType = VALID_GROUP_TYPES.includes(tipo) ? tipo : 'custom';
  const groupId = _groupId(name);

  const snap = await _groupsCol(uid).get();
  if (snap.size >= MAX_GROUPS_PER_OWNER) throw new Error('limite_grupos_alcanzado');

  await _groupsCol(uid).doc(groupId).set({
    nombre: name,
    tipo: groupType,
    miembros: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  console.log('[CONTACT-GROUPS] createGroup uid=' + uid.slice(0, 8) + ' groupId=' + groupId);
  return { groupId, ok: true };
}

/**
 * Agrega un contacto (por phone) a un grupo.
 * @param {string} uid
 * @param {string} phone
 * @param {string} groupName
 * @returns {{ groupId: string, ok: boolean }}
 */
async function addToGroup(uid, phone, groupName) {
  if (!uid || !phone || !groupName) throw new Error('parametros_requeridos');
  const groupId = _groupId(groupName);
  const hash = _phoneHash(phone);
  const ref = _groupsCol(uid).doc(groupId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('grupo_no_encontrado');
  const miembros = snap.data().miembros || [];
  if (miembros.includes(hash)) return { groupId, ok: true, alreadyMember: true };
  await ref.set({ miembros: [...miembros, hash], updatedAt: new Date().toISOString() }, { merge: true });
  console.log('[CONTACT-GROUPS] addToGroup uid=' + uid.slice(0, 8) + ' groupId=' + groupId + ' hash=' + hash);
  return { groupId, ok: true, alreadyMember: false };
}

/**
 * Mueve un contacto de su grupo actual a otro.
 * @param {string} uid
 * @param {string} phone
 * @param {string} targetGroupName
 * @returns {{ ok: boolean, movedFrom: string|null }}
 */
async function moveToGroup(uid, phone, targetGroupName) {
  if (!uid || !phone || !targetGroupName) throw new Error('parametros_requeridos');
  const hash = _phoneHash(phone);
  const targetGroupId = _groupId(targetGroupName);

  const allSnap = await _groupsCol(uid).get();
  let movedFrom = null;
  const batch = [];

  allSnap.forEach(function (doc) {
    const d = doc.data();
    const miembros = d.miembros || [];
    if (miembros.includes(hash) && doc.id !== targetGroupId) {
      batch.push({ ref: doc.ref, miembros: miembros.filter(function (m) { return m !== hash; }) });
      movedFrom = doc.id;
    }
  });

  for (const item of batch) {
    await item.ref.set({ miembros: item.miembros, updatedAt: new Date().toISOString() }, { merge: true });
  }

  const targetRef = _groupsCol(uid).doc(targetGroupId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new Error('grupo_destino_no_encontrado');
  const targetMiembros = targetSnap.data().miembros || [];
  if (!targetMiembros.includes(hash)) {
    await targetRef.set({ miembros: [...targetMiembros, hash], updatedAt: new Date().toISOString() }, { merge: true });
  }
  console.log('[CONTACT-GROUPS] moveToGroup uid=' + uid.slice(0, 8) + ' hash=' + hash + ' -> ' + targetGroupId);
  return { ok: true, movedFrom };
}

/**
 * Lista todos los grupos con sus miembros.
 * @param {string} uid
 * @returns {Array} grupos[]
 */
async function listGroups(uid) {
  if (!uid) return [];
  try {
    const snap = await _groupsCol(uid).get();
    const groups = [];
    snap.forEach(function (doc) {
      const d = doc.data();
      groups.push({
        groupId: doc.id,
        nombre: d.nombre || doc.id,
        tipo: d.tipo || 'custom',
        miembros: d.miembros || [],
        createdAt: d.createdAt || null,
      });
    });
    return groups;
  } catch (e) {
    console.error('[CONTACT-GROUPS] listGroups error:', e.message);
    return [];
  }
}

/**
 * Detecta y parsea comandos de grupo del self-chat.
 * @param {string} text
 * @returns {{ command: string, args: object }|null}
 */
function parseGroupCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  let m;
  m = t.match(GROUP_COMMANDS.CREAR);
  if (m) return { command: 'CREAR', args: { nombre: m[1].trim() } };
  m = t.match(GROUP_COMMANDS.AGREGAR);
  if (m) return { command: 'AGREGAR', args: { phone: m[1].trim(), groupName: m[2].trim() } };
  m = t.match(GROUP_COMMANDS.MOVER);
  if (m) return { command: 'MOVER', args: { phone: m[1].trim(), targetGroupName: m[2].trim() } };
  if (GROUP_COMMANDS.LISTAR.test(t)) return { command: 'LISTAR', args: {} };
  return null;
}

module.exports = {
  createGroup,
  addToGroup,
  moveToGroup,
  listGroups,
  parseGroupCommand,
  VALID_GROUP_TYPES,
  MAX_GROUPS_PER_OWNER,
  GROUP_COMMANDS,
  __setFirestoreForTests,
};
