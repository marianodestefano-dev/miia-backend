// ════════════════════════════════════════════════════════════════════════════
// MIIA — Slot Privacy Isolation (P3.2)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Aislamiento total entre slots: cada familiar/agente solo ve lo suyo.
// Owner NUNCA ve self-chat de adultos. Agente NUNCA ve datos personales.
// Menores de 13: supervisado obligatorio. 13-17: configurable.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
let _db = null;
function db() { if (!_db) _db = admin.firestore(); return _db; }

// Slot types
const SLOT_TYPES = {
  FAMILIAR: 'familiar',
  AGENT: 'agent'
};

// Privacy levels
const PRIVACY_LEVELS = {
  FULL: 'full',           // Adulto: 100% privado, nadie lo ve
  SUPERVISED: 'supervised', // Menor de 13: owner ve todo
  CONFIGURABLE: 'configurable' // 13-17: owner decide
};

/**
 * Obtiene los slots de un owner con su configuración de privacidad.
 * Ruta: users/{uid}/slots/{slotId}
 */
async function getSlots(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid).collection('slots').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error(`[SLOT-PRIVACY] ❌ getSlots(${ownerUid}):`, e.message);
    return [];
  }
}

/**
 * Crea un nuevo slot para un owner.
 * @param {string} ownerUid
 * @param {{ type: 'familiar'|'agent', phone: string, name: string, age?: number, businessId?: string }} config
 */
async function createSlot(ownerUid, config) {
  const { type, phone, name, age, businessId } = config;

  // Determinar nivel de privacidad por edad
  let privacyLevel = PRIVACY_LEVELS.FULL;
  let supervisedBy = null;
  if (age !== undefined && age !== null) {
    if (age < 13) {
      privacyLevel = PRIVACY_LEVELS.SUPERVISED;
      supervisedBy = ownerUid;
    } else if (age < 18) {
      privacyLevel = PRIVACY_LEVELS.CONFIGURABLE;
      supervisedBy = ownerUid; // default: supervisado, owner puede cambiar
    }
  }

  const slotData = {
    type: type || SLOT_TYPES.FAMILIAR,
    phone: phone || '',
    name: name || '',
    age: age || null,
    privacyLevel,
    supervisedBy,
    businessId: type === SLOT_TYPES.AGENT ? (businessId || null) : null,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    const ref = await db().collection('users').doc(ownerUid).collection('slots').add(slotData);
    console.log(`[SLOT-PRIVACY] ✅ Slot creado: ${ref.id} (${type}, ${name}, privacy=${privacyLevel})`);
    return { id: ref.id, ...slotData };
  } catch (e) {
    console.error(`[SLOT-PRIVACY] ❌ createSlot error:`, e.message);
    throw e;
  }
}

/**
 * Actualiza configuración de privacidad de un slot.
 */
async function updateSlotPrivacy(ownerUid, slotId, updates) {
  try {
    const allowed = ['privacyLevel', 'supervisedBy', 'active', 'name', 'age', 'businessId'];
    const clean = {};
    for (const k of allowed) {
      if (updates[k] !== undefined) clean[k] = updates[k];
    }
    clean.updatedAt = new Date().toISOString();
    await db().collection('users').doc(ownerUid).collection('slots').doc(slotId).update(clean);
    console.log(`[SLOT-PRIVACY] 🔄 Slot ${slotId} actualizado: ${JSON.stringify(clean)}`);
  } catch (e) {
    console.error(`[SLOT-PRIVACY] ❌ updateSlotPrivacy(${slotId}):`, e.message);
    throw e;
  }
}

/**
 * Elimina un slot.
 */
async function deleteSlot(ownerUid, slotId) {
  try {
    await db().collection('users').doc(ownerUid).collection('slots').doc(slotId).delete();
    console.log(`[SLOT-PRIVACY] 🗑️ Slot ${slotId} eliminado`);
  } catch (e) {
    console.error(`[SLOT-PRIVACY] ❌ deleteSlot(${slotId}):`, e.message);
    throw e;
  }
}

/**
 * Filtra datos según permisos del slot.
 * Un agente solo ve: cerebro del negocio asignado, productos, contact_rules.
 * Un familiar adulto: solo ve su self-chat, agenda compartida.
 * Owner ve todo lo suyo, pero NUNCA self-chat de adultos.
 *
 * @param {string} requestRole - 'owner'|'agent'|'familiar'
 * @param {Object} slot - El slot del solicitante (si aplica)
 * @param {Object} data - Los datos a filtrar
 * @returns {Object} Datos filtrados
 */
function filterDataBySlot(requestRole, slot, data) {
  if (requestRole === 'owner') {
    // Owner ve todo excepto self-chat de adultos
    const filtered = { ...data };
    if (filtered.selfChat && slot) {
      // Si consultando datos de un slot con privacidad full → censurar
      if (slot.privacyLevel === PRIVACY_LEVELS.FULL) {
        filtered.selfChat = '[PRIVADO — No visible para el owner]';
      }
    }
    return filtered;
  }

  if (requestRole === 'agent') {
    // Agente SOLO ve cerebro y productos del negocio asignado
    if (!slot?.businessId) return {};
    return {
      businessId: slot.businessId,
      cerebro: data.cerebro || null,
      products: data.products || [],
      contactRules: data.contactRules || null,
      // NUNCA: datos personales, otros negocios, agenda, familia
    };
  }

  if (requestRole === 'familiar') {
    // Familiar: self-chat propio + agenda compartida
    return {
      selfChat: data.selfChat || null,
      sharedAgenda: data.sharedAgenda || [],
      // NUNCA: negocios, leads, otros familiares
    };
  }

  return {};
}

/**
 * Verifica si un uid tiene permiso para ver datos de otro slot.
 */
async function canAccessSlot(ownerUid, requestorUid, targetSlotId) {
  // Owner siempre puede ver (excepto self-chat de adultos, que se filtra en filterDataBySlot)
  if (requestorUid === ownerUid) return true;

  // Verificar si el requestor es admin
  try {
    const userDoc = await db().collection('users').doc(requestorUid).get();
    if (userDoc.exists && userDoc.data().role === 'admin') return true;
  } catch (_) {}

  // Agente solo accede a su propio slot
  try {
    const slot = await db().collection('users').doc(ownerUid).collection('slots').doc(targetSlotId).get();
    if (slot.exists && slot.data().phone) {
      // Verificar que el requestor es el dueño del slot
      const agentDoc = await db().collection('users').doc(requestorUid).get();
      if (agentDoc.exists && agentDoc.data().phone === slot.data().phone) return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Obtiene el contexto de prompt filtrado por privacidad del slot.
 * Usado internamente por el message handler para construir el prompt correcto.
 */
function getPromptContextForSlot(slot, ownerData) {
  if (!slot) return ownerData; // Owner directo → todo

  if (slot.type === SLOT_TYPES.AGENT) {
    // Agente: solo cerebro del negocio asignado
    return {
      businessCerebro: ownerData.businessCerebros?.[slot.businessId] || ownerData.businessCerebro || '',
      products: ownerData.businessProducts?.[slot.businessId] || [],
      ownerName: ownerData.ownerProfile?.shortName || '',
      // NO: personal brain, agenda, familia, otros negocios
    };
  }

  if (slot.type === SLOT_TYPES.FAMILIAR) {
    return {
      personalBrain: '', // Familiar NO ve brain del owner
      businessCerebro: '', // Familiar NO ve negocios
      sharedAgenda: ownerData.sharedAgenda || [],
      ownerName: ownerData.ownerProfile?.shortName || '',
    };
  }

  return ownerData;
}

module.exports = {
  SLOT_TYPES,
  PRIVACY_LEVELS,
  getSlots,
  createSlot,
  updateSlotPrivacy,
  deleteSlot,
  filterDataBySlot,
  canAccessSlot,
  getPromptContextForSlot
};
