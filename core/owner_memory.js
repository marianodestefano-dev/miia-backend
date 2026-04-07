// ════════════════════════════════════════════════════════════════════════════
// MIIA — Owner Memory (Memoria Permanente del Owner)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// TODO lo que MIIA aprende del owner se guarda en Firestore PARA SIEMPRE.
// Sobrevive deploys, restarts, migraciones, todo.
//
// Categorías:
//   gustos      → "me gusta el rock", "soy vegetariano", "prefiero café"
//   familia     → "mi hijo se llama Lucas", "mi esposa es María"
//   ubicacion   → "vivo en Bogotá", "mi ciudad es BA"
//   trabajo     → "soy médico", "trabajo en MedLink"
//   rutinas     → "siempre almuerzo a las 12", "los lunes entreno"
//   alertas     → "recordame siempre pagar la luz el 15"
//   intereses   → detectados por link clicks (automático, no manual)
//
// REGLA: SIEMPRE pedir confirmación antes de guardar.
// REGLA: Nunca borrar — solo agregar o actualizar.
// REGLA: Owner puede ver todo con "mis cosas" / "qué sabés de mí"
// ════════════════════════════════════════════════════════════════════════════

'use strict';

let _firestore = null;
let _ownerUid = null;

// Categorías válidas
const CATEGORIES = ['gustos', 'familia', 'ubicacion', 'trabajo', 'rutinas', 'alertas', 'intereses'];

/**
 * Inicializa el módulo.
 */
function init(ownerUid, firestore) {
  _ownerUid = ownerUid;
  _firestore = firestore;
  console.log('[OWNER-MEMORY] ✅ Inicializado — memoria permanente del owner');
}

/**
 * Guarda un dato del owner en Firestore (PARA SIEMPRE).
 * @param {string} category - 'gustos'|'familia'|'ubicacion'|'trabajo'|'rutinas'|'alertas'
 * @param {string} key - Identificador único dentro de la categoría
 * @param {*} value - Valor a guardar
 * @param {string} [rawText] - Texto original del owner (para auditoría)
 */
async function save(category, key, value, rawText = '') {
  if (!_firestore || !_ownerUid) {
    console.error('[OWNER-MEMORY] ❌ No inicializado');
    return false;
  }

  if (!CATEGORIES.includes(category)) {
    console.error(`[OWNER-MEMORY] ❌ Categoría inválida: ${category}`);
    return false;
  }

  try {
    const docRef = _firestore.collection('users').doc(_ownerUid)
      .collection('owner_memory').doc(category);

    await docRef.set({
      [key]: {
        value,
        rawText,
        savedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }, { merge: true });

    console.log(`[OWNER-MEMORY] ✅ Guardado: ${category}.${key} = ${JSON.stringify(value).substring(0, 80)}`);
    return true;
  } catch (e) {
    console.error(`[OWNER-MEMORY] ❌ Error guardando ${category}.${key}: ${e.message}`);
    return false;
  }
}

/**
 * Lee todos los datos de una categoría.
 * @param {string} category
 * @returns {Object|null}
 */
async function getCategory(category) {
  if (!_firestore || !_ownerUid) return null;

  try {
    const doc = await _firestore.collection('users').doc(_ownerUid)
      .collection('owner_memory').doc(category).get();

    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.error(`[OWNER-MEMORY] ❌ Error leyendo ${category}: ${e.message}`);
    return null;
  }
}

/**
 * Lee TODA la memoria del owner (todas las categorías).
 * @returns {Object} { gustos: {...}, familia: {...}, ... }
 */
async function getAll() {
  if (!_firestore || !_ownerUid) return {};

  const result = {};
  try {
    const snap = await _firestore.collection('users').doc(_ownerUid)
      .collection('owner_memory').get();

    snap.forEach(doc => {
      result[doc.id] = doc.data();
    });
  } catch (e) {
    console.error(`[OWNER-MEMORY] ❌ Error leyendo toda la memoria: ${e.message}`);
  }
  return result;
}

/**
 * Formatea la memoria del owner para mostrar en WhatsApp.
 * Comando: "mis cosas" / "qué sabés de mí" / "mi perfil"
 */
async function formatForWhatsApp() {
  const all = await getAll();

  if (Object.keys(all).length === 0) {
    return '📋 Todavía no tengo nada guardado sobre vos. Contame cosas y las voy a recordar para siempre 🧠';
  }

  const labels = {
    gustos: '🎵 Gustos',
    familia: '👨‍👩‍👧‍👦 Familia',
    ubicacion: '📍 Ubicación',
    trabajo: '💼 Trabajo',
    rutinas: '🔄 Rutinas',
    alertas: '⏰ Alertas recurrentes',
    intereses: '🔗 Intereses detectados'
  };

  let msg = '🧠 *Lo que sé de vos:*\n\n';

  for (const [cat, data] of Object.entries(all)) {
    if (!data || Object.keys(data).length === 0) continue;
    msg += `*${labels[cat] || cat}*\n`;
    for (const [key, entry] of Object.entries(data)) {
      const val = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      msg += `  • ${key}: ${val}\n`;
    }
    msg += '\n';
  }

  msg += '💡 Podés decirme cosas nuevas y las guardo para siempre.';
  return msg;
}

/**
 * Detecta si un mensaje del owner es una preferencia/dato personal
 * y retorna la categoría + key + value para guardar.
 * Retorna null si no es un dato personal.
 *
 * @param {string} msg - Mensaje del owner
 * @returns {{ category: string, key: string, value: string, confirmMsg: string }|null}
 */
function detectPreference(msg) {
  const lower = msg.toLowerCase().trim();

  // ─── GUSTOS ───
  const gustoMatch = lower.match(/^(?:miia\s+)?(?:me\s+(?:gusta|encanta|fascina|copa)\s+(?:el|la|los|las)?\s*(.+)|soy\s+(?:vegetariano|vegano|celíaco|celiaco|carnívoro|carnivoro))/i);
  if (gustoMatch) {
    const value = gustoMatch[1] || lower.match(/soy\s+(\S+)/i)?.[1] || msg;
    const key = value.replace(/\s+/g, '_').substring(0, 30);
    return {
      category: 'gustos',
      key,
      value: value.trim(),
      confirmMsg: `¿Confirmo que te gusta *${value.trim()}*? Esto queda guardado para siempre 🔒 (sí/no)`
    };
  }

  // ─── FAMILIA ───
  const familiaMatch = lower.match(/^(?:miia\s+)?(?:mi\s+(hijo|hija|esposa|esposo|mamá|mama|papá|papa|hermano|hermana|novia|novio|pareja|abuela|abuelo)\s+(?:se\s+llama|es)\s+(.+))/i);
  if (familiaMatch) {
    const relation = familiaMatch[1];
    const name = familiaMatch[2].trim();
    return {
      category: 'familia',
      key: relation,
      value: name,
      confirmMsg: `¿Confirmo que tu ${relation} es *${name}*? Esto queda guardado para siempre 🔒 (sí/no)`
    };
  }

  // ─── TRABAJO ───
  const trabajoMatch = lower.match(/^(?:miia\s+)?(?:soy\s+(?:un\s+|una\s+)?(.+?)\s*$|trabajo\s+(?:en|como|de)\s+(.+))/i);
  if (trabajoMatch && !lower.includes('hincha') && !lower.includes('fan')) {
    const value = (trabajoMatch[1] || trabajoMatch[2]).trim();
    if (value.length > 2 && value.length < 100) {
      return {
        category: 'trabajo',
        key: 'profesion',
        value,
        confirmMsg: `¿Confirmo que sos *${value}*? Esto queda guardado para siempre 🔒 (sí/no)`
      };
    }
  }

  // ─── RUTINAS ───
  const rutinaMatch = lower.match(/^(?:miia\s+)?(?:siempre|todos los|cada)\s+(.+)/i);
  if (rutinaMatch) {
    const value = rutinaMatch[1].trim();
    const key = value.replace(/\s+/g, '_').substring(0, 30);
    return {
      category: 'rutinas',
      key,
      value,
      confirmMsg: `¿Confirmo esta rutina: *${value}*? La voy a recordar para siempre 🔒 (sí/no)`
    };
  }

  // ─── ALERTAS RECURRENTES ───
  const alertaMatch = lower.match(/^(?:miia\s+)?(?:recordame\s+siempre|avisame\s+siempre|todos\s+los\s+\w+\s+recordame)\s+(.+)/i);
  if (alertaMatch) {
    const value = alertaMatch[1].trim();
    const key = value.replace(/\s+/g, '_').substring(0, 30);
    return {
      category: 'alertas',
      key,
      value,
      confirmMsg: `¿Confirmo esta alerta recurrente: *${value}*? La voy a recordar para siempre 🔒 (sí/no)`
    };
  }

  return null;
}

module.exports = {
  init,
  save,
  getCategory,
  getAll,
  formatForWhatsApp,
  detectPreference,
  CATEGORIES
};
