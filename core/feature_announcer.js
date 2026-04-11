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

const CURRENT_VERSION = '2.10.0';
const CURRENT_DATE = '2026-04-11';

/**
 * Changelog: features nuevas de esta versión
 * Solo incluir lo que es NUEVO desde la última versión
 */
const CHANGELOG = [
  {
    id: 'security_contacts',
    title: '🛡️ Contactos de Seguridad',
    description: 'Ahora podés designar protectores y protegidos con 3 niveles de acceso. Si te pasa algo (SOS, caída), aviso a tus protectores por WhatsApp y email.',
    commands: ['proteger a +54911...', 'mis protectores', 'mis protegidos', 'cambiar nivel'],
  },
  {
    id: 'agent_selfchat',
    title: '📋 Agentes: Self-chat de negocios',
    description: 'Los agentes ahora tienen su propio chat conmigo, enfocado 100% en su negocio: agenda, tareas, citas, productos.',
  },
  {
    id: 'calendar_safe_hours_fix',
    title: '📅 Recordatorios siempre puntuales',
    description: 'Los eventos que vos creás (Google Calendar, self-chat) ahora SIEMPRE te recuerdo, incluso antes de las 10am.',
  },
  {
    id: 'morning_briefing_always',
    title: '🌅 Informe matutino garantizado',
    description: 'Todos los días a las 8:30 AM te envío algo: si hay novedades te cuento, si no, te saludo y te deseo un buen día.',
  },
  {
    id: 'security_alerts_email',
    title: '📧 Alertas de seguridad por email',
    description: 'Si alguien cambia la configuración de tu contacto de seguridad, te aviso por WhatsApp Y por email.',
  },
  {
    id: 'email_management',
    title: '📬 Gestión completa de email por WhatsApp',
    description: 'Ahora puedo leer tu inbox, mostrarte los correos, abrir los que quieras, eliminar los que no sirvan y enviar emails nuevos — todo desde este chat.',
    commands: ['mis correos', 'leé el 2 y el 5', 'eliminá todos menos el 3', 'mandá un correo a X'],
  },
  {
    id: 'announcer_tts',
    title: '🎤 Anuncios en audio',
    description: 'Cuando tengo novedades importantes, te las cuento con una nota de voz además del texto.',
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
    'Contactos de Seguridad: protector/protegido con 3 niveles',
    'Alertas SOS y caída → WhatsApp + email a protectores',
    'OTP para vincular contactos de seguridad',
    'Horario configurable de respuesta (default 7am-7pm)',
    'Verificación de integridad cada 5 minutos',
  ]},
  { category: '📬 Email', items: [
    'Leer inbox: "mis correos", "qué emails tengo"',
    'Ver contenido: "leé el 2 y el 5"',
    'Eliminar: "eliminá el 1, 3 y 4"',
    'Eliminar excepto: "eliminá todos menos el 2 y 5"',
    'Enviar email: "mandá un correo a juan@mail.com con asunto X"',
  ]},
  { category: '🧠 Aprendizaje', items: [
    'Aprendo de cada conversación (con tu aprobación)',
    '"Olvidá: X" para borrar un aprendizaje',
    'Cerebro personalizado por negocio',
    'Nightly Brain: analizo TODO el día a las 23:00',
    'Morning Briefing: informe a las 8:30 AM (siempre)',
  ]},
];

// ═══════════════════════════════════════════════════════════════
// VARIABLES INTERNAS
// ═══════════════════════════════════════════════════════════════

let _admin = null;
let _announcementSent = false; // Solo anunciar una vez por deploy
let _ttsEngine = null;
let _safeSendMessage = null;

// ═══════════════════════════════════════════════════════════════
// FUNCIONES PRINCIPALES
// ═══════════════════════════════════════════════════════════════

function init(admin, { ttsEngine, safeSendMessage } = {}) {
  _admin = admin;
  _ttsEngine = ttsEngine || null;
  _safeSendMessage = safeSendMessage || null;
  console.log(`[FEATURE-ANNOUNCER] ✅ Inicializado (v${CURRENT_VERSION}, ${CHANGELOG.length} features nuevas, TTS=${!!_ttsEngine})`);
}

/**
 * Verificar si hay features nuevas para anunciar al owner.
 * Se llama ~60s después de que el owner conecte WhatsApp.
 *
 * @param {string} uid - UID del owner
 * @param {function} sendFn - async (message) => void — enviar al self-chat
 * @param {string} sendTarget - JID del self-chat (para TTS audio)
 */
async function checkAndAnnounce(uid, sendFn, sendTarget) {
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

    // ═══ TTS: Enviar primer anuncio como audio (nota de voz) ═══
    let sentAsAudio = false;
    if (_ttsEngine && _safeSendMessage && sendTarget) {
      try {
        // Generar texto más corto y natural para TTS
        const ttsText = _buildTTSSummary();
        const ttsConfig = {
          provider: 'google',
          apiKey: process.env.GOOGLE_TTS_API_KEY,
          mode: 'adult',
        };
        const ttsResult = await _ttsEngine.generateTTS(ttsText, ttsConfig);
        await _ttsEngine.sendAudioMessage(_safeSendMessage, sendTarget, ttsResult.buffer, ttsResult.mimetype, { isSelfChat: true });
        sentAsAudio = true;
        console.log(`[FEATURE-ANNOUNCER] 🎤 Anuncio enviado como audio TTS`);
      } catch (ttsErr) {
        console.warn(`[FEATURE-ANNOUNCER] ⚠️ TTS falló, enviando como texto: ${ttsErr.message}`);
      }
    }

    // Siempre enviar el texto también (como respaldo o complemento del audio)
    await sendFn(msg);
    _announcementSent = true;

    // ═══ OPCIÓN C: También actualizar personal_brain con funciones nuevas ═══
    // Para que MIIA SEPA qué puede hacer (no solo lo anuncie y lo olvide)
    try {
      const brainRef = _admin.firestore().collection('users').doc(uid).collection('personal').doc('personal_brain');
      const brainDoc = await brainRef.get();
      const currentBrain = brainDoc.exists ? (brainDoc.data().content || '') : '';

      const featureBlock = `\n\n[FUNCIONES NUEVAS v${CURRENT_VERSION} — ${CURRENT_DATE}]\n` +
        CHANGELOG.map(f => `- ${f.title}: ${f.description}`).join('\n') +
        '\n[FIN FUNCIONES NUEVAS]';

      // Limpiar bloques de versiones anteriores y agregar el nuevo
      const cleanedBrain = currentBrain.replace(/\n\n\[FUNCIONES NUEVAS v[\s\S]*?\[FIN FUNCIONES NUEVAS\]/g, '');
      await brainRef.set({ content: cleanedBrain + featureBlock, updatedAt: new Date().toISOString() }, { merge: true });
      console.log(`[FEATURE-ANNOUNCER] 🧠 personal_brain actualizado con ${CHANGELOG.length} funciones nuevas`);
    } catch (brainErr) {
      console.error(`[FEATURE-ANNOUNCER] ⚠️ Error actualizando personal_brain (no bloquea): ${brainErr.message}`);
    }

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
 * Construir resumen de novedades para TTS (más corto y natural)
 * @returns {string} Texto optimizado para audio
 */
function _buildTTSSummary() {
  const count = CHANGELOG.length;
  const highlights = CHANGELOG.slice(0, 3).map(f => {
    // Limpiar emojis para TTS
    return f.description.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').trim();
  });
  return `¡Tengo ${count} novedades para vos! ${highlights.join('. ')}. Preguntame "¿qué podés hacer?" para ver todo lo nuevo.`;
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
