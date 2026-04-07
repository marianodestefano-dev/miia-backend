'use strict';

/**
 * FEATURE_ANNOUNCER.JS — MIIA anuncia funcionalidades nuevas al owner
 *
 * ESTÁNDAR: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FLUJO:
 *   1. Al arrancar, lee CAPABILITIES (todas las funciones) y CHANGELOG (lo nuevo)
 *   2. Compara con last_seen_version en Firestore
 *   3. Si hay features nuevas → espera 60s post-conexión → envía al self-chat
 *   4. Si el owner pregunta "qué podés hacer" → lista TODAS las capacidades
 *
 * REGLA: MIIA habla en primera persona, nunca dice "me agregaron", dice "ahora puedo"
 */

// ═══════════════════════════════════════════════════════════════
// VERSIÓN ACTUAL Y CHANGELOG
// ═══════════════════════════════════════════════════════════════

const CURRENT_VERSION = '2.8.0';
const CURRENT_DATE = '2026-04-07';

/**
 * Changelog: features nuevas de esta versión
 * Solo incluir lo que es NUEVO desde la última versión
 */
const CHANGELOG = [
  {
    id: 'content_safety_shield',
    title: '🛡️ Protección de contenido',
    description: 'Ahora verifico todas las imágenes antes de procesarlas. Si detecto contenido sensible, lo bloqueo automáticamente para proteger tu privacidad.',
  },
  {
    id: 'outfit_mode',
    title: '👗 Modo Outfit',
    description: 'Enviame fotos de tu ropa y te armo combinaciones. Decime "qué me pongo para una cita" y te sugiero.',
    commands: ['guardar (+ foto)', 'qué me pongo', 'mi guardarropa', 'qué tal (+ foto de outfit)'],
  },
  {
    id: 'image_analysis',
    title: '🔍 Análisis de imágenes',
    description: 'Enviame cualquier captura (CRM, planilla, lista de contactos) y te digo qué veo. Te pregunto antes de actuar.',
    commands: ['hacete cargo (+ captura)', 'analizá esto (+ imagen)'],
  },
  {
    id: 'invocation_3way',
    title: '🗣️ Invocación en chats',
    description: 'Decí "MIIA vení" en cualquier chat 1-a-1 y me sumo a la conversación para ayudarte.',
    commands: ['MIIA vení', 'MIIA estás?', 'Chau MIIA'],
  },
  {
    id: 'outreach_schedule',
    title: '📋 Contacto programado',
    description: 'Cuando me enviás contactos, ahora podés decirme "mañana" y los guardo para el día siguiente.',
    commands: ['contactalos', 'mañana', 'guardalos'],
  },
  {
    id: 'respondele_improved',
    title: '💬 "Respondele" mejorado',
    description: 'Cuando alguien te escribe y te aviso, ahora entiendo todas las formas de pedirme que responda: "respondele", "contestale", "escribile", "dale responde".',
  },
];

/**
 * Capabilities: TODAS las funciones de MIIA (para "qué podés hacer")
 */
const CAPABILITIES = [
  { category: '📅 Agenda', items: [
    'Agendar eventos: "agendá reunión mañana a las 3pm"',
    'Consultar agenda: "qué tengo hoy?"',
    'Mover eventos: "mové la reunión al jueves"',
    'Cancelar: "cancelá la reunión de mañana"',
    'Recordatorio 10min antes automático',
  ]},
  { category: '💼 Negocios', items: [
    'Responder leads automáticamente 24/7',
    'Aprender sobre tu negocio: productos, precios, servicios',
    'Generar cotizaciones PDF: "cotización para Juan, 3 licencias Pro"',
    'Seguimiento de leads: te aviso si no responden',
  ]},
  { category: '👗 Moda', items: [
    'Guardar prendas: enviá foto + "guardar"',
    'Sugerir outfits: "qué me pongo para una cita"',
    'Opinar outfits: enviá foto + "qué tal"',
    'Ver guardarropa: "mi guardarropa"',
  ]},
  { category: '🔍 Imágenes', items: [
    'Analizar capturas: CRM, planillas, listas, chats',
    'Contactar leads desde screenshots',
    'Programar contacto para mañana',
  ]},
  { category: '🗣️ Invocación', items: [
    '"MIIA vení" en cualquier chat 1-a-1',
    'Me presento y ayudo según el contexto',
    '"Chau MIIA" para que me retire',
  ]},
  { category: '⚽ Deportes', items: [
    '"Soy hincha de Boca" → te aviso cuando juegan',
    'Seguimiento en vivo con mensajes emotivos',
    '10 deportes: fútbol, F1, tenis, NBA, MLB, UFC, rugby, boxeo, golf, ciclismo',
  ]},
  { category: '👨‍👩‍👧‍👦 Familia y Amigos', items: [
    'Chatear con familia y amigos con tono personalizado',
    'Modo Niñera: detecta niños y adapta respuestas',
    'Gestión de contactos: familia, equipo, leads',
  ]},
  { category: '🛡️ Seguridad', items: [
    'Protección de contenido sensible en imágenes',
    'Nunca comparto tus fotos con terceros',
    'Horario configurable de respuesta (default 7am-7pm)',
    'Verificación de integridad cada 5 minutos',
  ]},
  { category: '🧠 Aprendizaje', items: [
    'Aprendo de cada conversación (con tu aprobación)',
    '"Olvidá: X" para borrar un aprendizaje',
    'Cerebro personalizado por negocio',
  ]},
];

// ═══════════════════════════════════════════════════════════════
// VARIABLES INTERNAS
// ═══════════════════════════════════════════════════════════════

let _admin = null;
let _announcementSent = false; // Solo anunciar una vez por deploy

// ═══════════════════════════════════════════════════════════════
// FUNCIONES PRINCIPALES
// ═══════════════════════════════════════════════════════════════

function init(admin) {
  _admin = admin;
  console.log(`[FEATURE-ANNOUNCER] ✅ Inicializado (v${CURRENT_VERSION}, ${CHANGELOG.length} features nuevas)`);
}

/**
 * Verificar si hay features nuevas para anunciar al owner.
 * Se llama ~60s después de que el owner conecte WhatsApp.
 *
 * @param {string} uid - UID del owner
 * @param {function} sendFn - async (message) => void — enviar al self-chat
 */
async function checkAndAnnounce(uid, sendFn) {
  if (_announcementSent || !uid || !_admin) return;

  try {
    const metaRef = _admin.firestore().collection('users').doc(uid).collection('miia_meta').doc('feature_version');
    const metaDoc = await metaRef.get();
    const lastSeenVersion = metaDoc.exists ? metaDoc.data().version : null;

    if (lastSeenVersion === CURRENT_VERSION) {
      console.log(`[FEATURE-ANNOUNCER] Owner ya vio v${CURRENT_VERSION} — sin anuncio`);
      return;
    }

    console.log(`[FEATURE-ANNOUNCER] 📢 Anunciando v${CURRENT_VERSION} (last_seen: ${lastSeenVersion || 'nunca'})`);

    // Construir mensaje de novedades
    let msg = `🆕 *¡Tengo novedades!*\n\n`;
    for (const feature of CHANGELOG) {
      msg += `${feature.title}\n`;
      msg += `${feature.description}\n`;
      if (feature.commands && feature.commands.length > 0) {
        msg += `→ Comandos: ${feature.commands.join(' | ')}\n`;
      }
      msg += '\n';
    }
    msg += `Preguntame *"¿qué podés hacer?"* cuando quieras ver todas mis funciones 😊`;

    await sendFn(msg);
    _announcementSent = true;

    // Actualizar versión vista
    await metaRef.set({ version: CURRENT_VERSION, seenAt: new Date().toISOString() });
    console.log(`[FEATURE-ANNOUNCER] ✅ Anuncio enviado y versión actualizada a ${CURRENT_VERSION}`);

  } catch (err) {
    console.error(`[FEATURE-ANNOUNCER] ❌ Error anunciando features: ${err.message}`);
  }
}

/**
 * Detectar si el owner pregunta por capacidades de MIIA
 * @param {string} message
 * @returns {boolean}
 */
function isCapabilitiesQuery(message) {
  if (!message) return false;
  const m = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\b(que\s+pod[eé]s\s+hacer|que\s+sab[eé]s\s+hacer|que\s+funciones\s+ten[eé]s|tus\s+funciones|que\s+hac[eé]s|ayuda|help|que\s+podes|funcionalidades|capacidades)\b/i.test(m);
}

/**
 * Construir mensaje con TODAS las capacidades de MIIA
 * @returns {string}
 */
function buildCapabilitiesMessage() {
  let msg = `🤖 *Todo lo que puedo hacer por vos:*\n\n`;

  for (const cat of CAPABILITIES) {
    msg += `*${cat.category}*\n`;
    for (const item of cat.items) {
      msg += `  • ${item}\n`;
    }
    msg += '\n';
  }

  msg += `_v${CURRENT_VERSION} — ${CURRENT_DATE}_`;
  return msg;
}

/**
 * Obtener versión actual
 */
function getVersion() {
  return CURRENT_VERSION;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  init,
  checkAndAnnounce,
  isCapabilitiesQuery,
  buildCapabilitiesMessage,
  getVersion,
  CURRENT_VERSION,
  CHANGELOG,
  CAPABILITIES,
};
