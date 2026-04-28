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
 * C-474: detecta keys de LIDs huerfanos (NNN@lid) cuyo ultimo bloque
 * de 8-10 digitos podria corresponder al phone target. Usado en modo
 * agresivo para limpiar rastro completo del lead cuando WhatsApp guardo
 * un LID distinto del phone (ej: 264355287441550@lid pero phone es
 * 573163937365).
 *
 * Anchor: cleanup C-459 fue parcial porque LIDs como "264355287441550@lid"
 * y "2937808003122@lid" sobrevivieron en tenant_conversations Mariano
 * post-limpieza C-459 (Firma viva Mariano 2026-04-28 pegada en mensajes
 * literales).
 *
 * Estrategia: matchear LID por suffix de los ultimos 8 digitos del phone
 * target. Falsa positiva tolerable (admin one-shot, hay backup JSON).
 *
 * @param {object} mapData - map field (conversations, contactTypes, etc.)
 * @param {string[]} phones - phones target
 * @returns {string[]} keys que matchean LID por suffix
 */
function _findLidMatchesBySuffix(mapData, phones) {
  if (!mapData || typeof mapData !== 'object') return [];
  if (!Array.isArray(phones) || !phones.length) return [];
  const matches = new Set();
  // Suffix de los ultimos 8 digitos de cada phone target
  const suffixes = phones
    .map((p) => (p.includes('@') ? p.split('@')[0] : p))
    .filter((p) => /^\d+$/.test(p))
    .map((p) => p.slice(-8))
    .filter((s) => s.length === 8);
  if (!suffixes.length) return [];

  for (const key of Object.keys(mapData)) {
    if (!key.endsWith('@lid')) continue;
    const numericPart = key.split('@')[0];
    if (!/^\d+$/.test(numericPart)) continue;
    const lidSuffix = numericPart.slice(-8);
    if (suffixes.includes(lidSuffix)) {
      matches.add(key);
    }
  }
  return Array.from(matches);
}

/**
 * Lista todos los rastros de los phones target en el tenant.
 * NO borra nada. Solo retorna snapshot para auditoria.
 *
 * @param {string} ownerUid - UID del tenant (ej. MIIA CENTER).
 * @param {string[]} phones - Array de phones (con o sin @s.whatsapp.net).
 * @returns {Promise<{tenantConversations: object, miiaMemory: array}>}
 */
async function inspectLeadData(ownerUid, phones, opts) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new Error('phones array required');
  }
  // C-474: opcion agresiva para detectar LIDs huerfanos por suffix-match
  const aggressiveLidScan = !!(opts && opts.aggressiveLidScan);
  // Generar TODAS las variantes de key (raw + @s.whatsapp.net + @lid).
  // Anchor C-459 ejecucion: prod tiene mismas data en ambos formatos.
  const allVariants = phones.flatMap(_allKeyVariants);
  const dbFs = _getFirestore();
  const result = {
    tenantConversations: {},
    miiaMemory: [],
    lidMatches: [], // C-474: LIDs huerfanos detectados
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
    // C-474: extender variants con LIDs detectados por suffix-match
    let extendedVariants = allVariants;
    if (aggressiveLidScan) {
      const fields = ['conversations', 'contactTypes', 'leadNames',
                      'conversationMetadata', 'ownerActiveChats'];
      const lidSet = new Set();
      for (const field of fields) {
        const lids = _findLidMatchesBySuffix(data[field], phones);
        for (const lid of lids) lidSet.add(lid);
      }
      result.lidMatches = Array.from(lidSet);
      extendedVariants = Array.from(new Set([...allVariants, ...lidSet]));
    }
    for (const variant of extendedVariants) {
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
async function deleteLeadData(ownerUid, phones, opts) {
  if (typeof ownerUid !== 'string' || ownerUid.length < 20) {
    throw new Error('ownerUid invalid');
  }
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new Error('phones array required');
  }
  // C-474: opcion agresiva para borrar LIDs huerfanos por suffix-match
  const aggressiveLidScan = !!(opts && opts.aggressiveLidScan);
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
    // C-474: si aggressiveLidScan, agregar LIDs huerfanos a las variants
    let extendedVariants = allVariants;
    if (aggressiveLidScan) {
      const lidSet = new Set();
      for (const field of fields) {
        const lids = _findLidMatchesBySuffix(data[field], phones);
        for (const lid of lids) lidSet.add(lid);
      }
      if (lidSet.size > 0) {
        extendedVariants = Array.from(new Set([...allVariants, ...lidSet]));
      }
    }
    for (const field of fields) {
      const map = data[field];
      if (!map || typeof map !== 'object') continue;
      for (const variant of extendedVariants) {
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
    // C-474: si aggressiveLidScan, tambien borrar episodios con contactPhone
    // que sea un LID con suffix-match a phones target.
    const phoneSuffixes = phones
      .map((p) => (p.includes('@') ? p.split('@')[0] : p))
      .filter((p) => /^\d+$/.test(p))
      .map((p) => p.slice(-8));
    for (const ep of memSnap.docs) {
      const epData = ep.data() || {};
      const cp = epData.contactPhone;
      let shouldDelete = allVariants.includes(cp);
      if (!shouldDelete && aggressiveLidScan && typeof cp === 'string'
          && cp.endsWith('@lid')) {
        const cpNum = cp.split('@')[0];
        if (/^\d+$/.test(cpNum) && phoneSuffixes.includes(cpNum.slice(-8))) {
          shouldDelete = true;
        }
      }
      if (shouldDelete) {
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
  _findLidMatchesBySuffix,
};
