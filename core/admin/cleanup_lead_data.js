/**
 * C-459-CLEANUP-LEAD-DATA — Helper modular para borrado defensivo
 * de rastro de un lead (o varios) en MIIA CENTER (u otro tenant).
 *
 * Origen: CARTA C-459-CLEANUP-MARIANO-ESPOSA-CENTER
 *   [FIRMADA_VIVO_MARIANO_2026-04-28] — Mariano necesita probar MMC
 *   C-440 wire-in con phones que no quiere "marcar" todavia. Solucion:
 *   borrar TODO rastro de los phones objetivo en MIIA CENTER para
 *   que vuelvan a entrar como leads NUEVOS sin historial probadita.
 *
 * Categorias borradas:
 *   - users/{ownerUid}/miia_persistent/tenant_conversations
 *     .conversations[phone] (historial de mensajes).
 *   - users/{ownerUid}/miia_persistent/tenant_conversations
 *     .contactTypes[phone] (cache classification).
 *   - users/{ownerUid}/miia_persistent/tenant_conversations
 *     .leadNames[phone] (cache nombres).
 *   - users/{ownerUid}/miia_persistent/tenant_conversations
 *     .conversationMetadata[phone] (metadata por contacto).
 *   - users/{ownerUid}/miia_persistent/tenant_conversations
 *     .ownerActiveChats[phone] (estado activo).
 *   - users/{ownerUid}/miia_memory/<episodeIds> donde
 *     contactPhone === phone (MMC episodios C-437+).
 *
 * Patrón: backup defensivo JSON + delete idempotente + verificacion.
 * NO toca subcollections de otros owners. NO toca consent_records ni
 * audit_logs (preservan trazabilidad regulatoria).
 *
 * Reusable: aplicable a futuros cleanup-de-lead-individual on-demand.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let _firestore = null;
function __setFirestoreForTests(fsArg) {
  _firestore = fsArg;
}
function _getFirestore() {
  if (_firestore) return _firestore;
  return require('firebase-admin').firestore();
}

/**
 * Normaliza un phone a formato consistente para lookup en
 * conversations / contactTypes (basePhone con sufijo @s.whatsapp.net).
 */
function _toJid(phone) {
  if (typeof phone !== 'string' || !phone.length) return null;
  if (phone.includes('@')) return phone;
  return `${phone}@s.whatsapp.net`;
}

/**
 * Lista todos los rastros de los phones target en el tenant.
 * NO borra nada. Solo retorna snapshot para auditoria.
 *
 * @param {string} ownerUid - UID del tenant (ej. MIIA CENTER).
 * @param {string[]} phones - Array de phones (con o sin @s.whatsapp.net).
 * @returns {Promise<{tenantConversations: object, miiaMemory: array}>}
 */
async function inspectLeadData(ownerUid, phones) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new Error('phones array required');
  }
  const targetJids = phones.map(_toJid).filter(Boolean);
  const dbFs = _getFirestore();
  const result = {
    tenantConversations: {},
    miiaMemory: [],
  };

  // 1. tenant_conversations — leer doc + extraer subkeys por phone
  try {
    const tcDoc = await dbFs.collection('users').doc(ownerUid)
      .collection('miia_persistent').doc('tenant_conversations').get();
    if (tcDoc.exists) {
      const data = tcDoc.data() || {};
      for (const jid of targetJids) {
        const slot = {
          conversations: (data.conversations || {})[jid] || null,
          contactTypes: (data.contactTypes || {})[jid] || null,
          leadNames: (data.leadNames || {})[jid] || null,
          conversationMetadata: (data.conversationMetadata || {})[jid] || null,
          ownerActiveChats: (data.ownerActiveChats || {})[jid] || null,
        };
        result.tenantConversations[jid] = slot;
      }
    }
  } catch (_) { /* tenant_conversations puede no existir */ }

  // 2. miia_memory — buscar episodios donde contactPhone === jid
  try {
    const memSnap = await dbFs.collection('users').doc(ownerUid)
      .collection('miia_memory').get();
    for (const ep of memSnap.docs) {
      const epData = ep.data() || {};
      if (targetJids.includes(epData.contactPhone)) {
        result.miiaMemory.push({
          episodeId: ep.id,
          contactPhone: epData.contactPhone,
          status: epData.status,
          summary: epData.summary,
          messageIds: epData.messageIds || [],
        });
      }
    }
  } catch (_) { /* miia_memory puede no existir */ }

  return result;
}

/**
 * Genera un backup JSON local con TODO lo encontrado por inspectLeadData.
 *
 * @param {object} snapshot - resultado de inspectLeadData().
 * @param {string} backupPath - path absoluto donde escribir backup.
 * @returns {string} backupPath.
 */
function writeBackup(snapshot, backupPath) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('snapshot required');
  }
  if (typeof backupPath !== 'string' || !backupPath.length) {
    throw new Error('backupPath required');
  }
  const dir = path.dirname(backupPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload = {
    backupAt: new Date().toISOString(),
    schema: 'C-459-CLEANUP-LEAD-DATA-v1',
    ...snapshot,
  };
  fs.writeFileSync(backupPath, JSON.stringify(payload, null, 2), 'utf8');
  return backupPath;
}

/**
 * Borra los rastros listados de los phones target en el tenant.
 * Idempotente — si ya estaban borrados, no falla.
 *
 * Usa FieldValue.delete() para borrar keys nested en map fields del
 * documento tenant_conversations. miia_memory se borra doc por doc.
 *
 * @param {string} ownerUid
 * @param {string[]} phones
 * @returns {Promise<{deletedKeys: object, deletedEpisodes: number}>}
 */
async function deleteLeadData(ownerUid, phones) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new Error('phones array required');
  }
  const targetJids = phones.map(_toJid).filter(Boolean);
  const dbFs = _getFirestore();
  // Priorizar mock test (dbFs._FieldValue) si esta presente; sino usar real.
  let FieldValue = dbFs._FieldValue || null;
  if (!FieldValue) {
    try {
      const adminLib = require('firebase-admin');
      FieldValue = (adminLib && adminLib.firestore && adminLib.firestore.FieldValue) || null;
    } catch (_) { /* sin firebase-admin disponible */ }
  }

  const deletedKeys = {
    conversations: [],
    contactTypes: [],
    leadNames: [],
    conversationMetadata: [],
    ownerActiveChats: [],
  };

  // 1. tenant_conversations — borrar keys map per-phone via FieldValue.delete
  try {
    const tcRef = dbFs.collection('users').doc(ownerUid)
      .collection('miia_persistent').doc('tenant_conversations');
    const tcDoc = await tcRef.get();
    if (tcDoc.exists) {
      const update = {};
      for (const jid of targetJids) {
        const data = tcDoc.data() || {};
        if ((data.conversations || {})[jid] !== undefined) {
          update[`conversations.${jid}`] = FieldValue ? FieldValue.delete() : null;
          deletedKeys.conversations.push(jid);
        }
        if ((data.contactTypes || {})[jid] !== undefined) {
          update[`contactTypes.${jid}`] = FieldValue ? FieldValue.delete() : null;
          deletedKeys.contactTypes.push(jid);
        }
        if ((data.leadNames || {})[jid] !== undefined) {
          update[`leadNames.${jid}`] = FieldValue ? FieldValue.delete() : null;
          deletedKeys.leadNames.push(jid);
        }
        if ((data.conversationMetadata || {})[jid] !== undefined) {
          update[`conversationMetadata.${jid}`] = FieldValue ? FieldValue.delete() : null;
          deletedKeys.conversationMetadata.push(jid);
        }
        if ((data.ownerActiveChats || {})[jid] !== undefined) {
          update[`ownerActiveChats.${jid}`] = FieldValue ? FieldValue.delete() : null;
          deletedKeys.ownerActiveChats.push(jid);
        }
      }
      if (Object.keys(update).length > 0) {
        await tcRef.update(update);
      }
    }
  } catch (_) { /* idempotente */ }

  // 2. miia_memory — borrar episodios donde contactPhone match
  let deletedEpisodes = 0;
  try {
    const memCol = dbFs.collection('users').doc(ownerUid).collection('miia_memory');
    const memSnap = await memCol.get();
    for (const ep of memSnap.docs) {
      const epData = ep.data() || {};
      if (targetJids.includes(epData.contactPhone)) {
        await memCol.doc(ep.id).delete();
        deletedEpisodes += 1;
      }
    }
  } catch (_) { /* miia_memory puede no existir */ }

  return { deletedKeys, deletedEpisodes };
}

module.exports = {
  inspectLeadData,
  writeBackup,
  deleteLeadData,
  __setFirestoreForTests,
  _toJid,
};
