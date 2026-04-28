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
 * Genera todas las variantes de key posibles para un phone en
 * Firestore: raw (573...), con sufijo @s.whatsapp.net, y posiblemente
 * @lid si hay LIDs almacenados (no comunes pero defensivo).
 *
 * Anchor C-459 ejecucion: hallazgo prod muestra que contactTypes
 * tiene tanto "573163937365" como "573163937365@s.whatsapp.net" para
 * el mismo contacto. Ambas variants deben borrarse.
 */
function _allKeyVariants(phone) {
  const out = new Set();
  if (typeof phone !== 'string' || !phone.length) return [];
  // Phone raw (sin sufijo)
  const raw = phone.includes('@') ? phone.split('@')[0] : phone;
  out.add(raw);
  // Con sufijo whatsapp
  out.add(`${raw}@s.whatsapp.net`);
  // Con sufijo lid (defensivo - menos comun)
  out.add(`${raw}@lid`);
  return Array.from(out);
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
  // Generar TODAS las variantes de key (raw + @s.whatsapp.net + @lid).
  // Anchor C-459 ejecucion: prod tiene mismas data en ambos formatos.
  const allVariants = phones.flatMap(_allKeyVariants);
  const dbFs = _getFirestore();
  const result = {
    tenantConversations: {},
    miiaMemory: [],
  };

  // 1. tenant_conversations — leer doc + extraer subkeys por phone variant
  // C-459 LOUD-FAIL: si UNAUTHENTICATED u otro error, propagar (no silent).
  let tcDoc;
  try {
    tcDoc = await dbFs.collection('users').doc(ownerUid)
      .collection('miia_persistent').doc('tenant_conversations').get();
  } catch (e) {
    throw new Error(`tenant_conversations.get failed: ${e.message}`);
  }
  if (tcDoc && tcDoc.exists) {
    const data = tcDoc.data() || {};
    for (const variant of allVariants) {
      const slot = {
        conversations: (data.conversations || {})[variant] || null,
        contactTypes: (data.contactTypes || {})[variant] || null,
        leadNames: (data.leadNames || {})[variant] || null,
        conversationMetadata: (data.conversationMetadata || {})[variant] || null,
        ownerActiveChats: (data.ownerActiveChats || {})[variant] || null,
      };
      // Solo agregar slot al resultado si tiene al menos 1 valor real
      const hasData = Object.values(slot).some((v) => v !== null);
      if (hasData) {
        result.tenantConversations[variant] = slot;
      }
    }
  }

  // 2. miia_memory — buscar episodios donde contactPhone === variant
  let memSnap;
  try {
    memSnap = await dbFs.collection('users').doc(ownerUid)
      .collection('miia_memory').get();
  } catch (e) {
    throw new Error(`miia_memory.get failed: ${e.message}`);
  }
  if (memSnap) {
    for (const ep of memSnap.docs) {
      const epData = ep.data() || {};
      if (allVariants.includes(epData.contactPhone)) {
        result.miiaMemory.push({
          episodeId: ep.id,
          contactPhone: epData.contactPhone,
          status: epData.status,
          summary: epData.summary,
          messageIds: epData.messageIds || [],
        });
      }
    }
  }

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
  // Generar TODAS las variantes de key (anchor C-459: prod tiene tanto
  // raw como @s.whatsapp.net en contactTypes).
  const allVariants = phones.flatMap(_allKeyVariants);
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

  // 1. tenant_conversations — borrar keys map per-variant.
  // C-459 LOUD-FAIL: errores propagan, no silent.
  // C-459 anchor: dotted paths con @ (ej "conversations.573@s.whatsapp.net")
  // NO se aplican en Firestore update. Refactor: read full doc + mutate in-
  // memory + set overwrite. Usa FieldPath explicito si esta soportado.
  const tcRef = dbFs.collection('users').doc(ownerUid)
    .collection('miia_persistent').doc('tenant_conversations');
  let tcDoc;
  try {
    tcDoc = await tcRef.get();
  } catch (e) {
    throw new Error(`tenant_conversations.get failed: ${e.message}`);
  }
  if (tcDoc && tcDoc.exists) {
    const data = tcDoc.data() || {};
    let mutated = false;
    const fields = ['conversations', 'contactTypes', 'leadNames',
                    'conversationMetadata', 'ownerActiveChats'];
    for (const field of fields) {
      const map = data[field];
      if (!map || typeof map !== 'object') continue;
      for (const variant of allVariants) {
        if (map[variant] !== undefined) {
          delete map[variant];
          deletedKeys[field].push(variant);
          mutated = true;
        }
      }
    }
    if (mutated) {
      try {
        // set overwrite - mutamos el doc completo en memoria.
        // Riesgo race: si otro proceso escribe entre get/set, perdemos cambio.
        // Para cleanup admin one-shot OK (no concurrencia).
        await tcRef.set(data);
      } catch (e) {
        throw new Error(`tenant_conversations.set failed: ${e.message}`);
      }
    }
  }

  // 2. miia_memory — borrar episodios donde contactPhone match
  let deletedEpisodes = 0;
  const memCol = dbFs.collection('users').doc(ownerUid).collection('miia_memory');
  let memSnap;
  try {
    memSnap = await memCol.get();
  } catch (e) {
    throw new Error(`miia_memory.get failed: ${e.message}`);
  }
  if (memSnap) {
    for (const ep of memSnap.docs) {
      const epData = ep.data() || {};
      if (allVariants.includes(epData.contactPhone)) {
        await memCol.doc(ep.id).delete();
        deletedEpisodes += 1;
      }
    }
  }

  return { deletedKeys, deletedEpisodes };
}

module.exports = {
  inspectLeadData,
  writeBackup,
  deleteLeadData,
  __setFirestoreForTests,
  _toJid,
};
