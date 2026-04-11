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
  { category: '📅 Productividad', items: [
    'Agendar eventos: "agendá reunión mañana a las 3pm"',
    'Consultar agenda: "qué tengo hoy?"',
    'Mover/cancelar eventos desde el chat',
    'Recordatorios automáticos 10min antes',
    'Leer inbox: "mis correos" → ver, leer, eliminar, responder emails',
    'Enviar email: "mandá correo a juan@mail.com con asunto X"',
    'Morning Briefing: informe diario a las 8:30 AM',
    'Nightly Brain: analizo tu día a las 23:00',
  ]},
  { category: '💼 Ventas y Negocios', items: [
    'Responder leads automáticamente 24/7',
    'Aprender sobre tu negocio: productos, precios, servicios',
    'Generar cotizaciones PDF: "cotización para Juan, 3 licencias Pro"',
    'Seguimiento de leads: te aviso si no responden',
    'Analizar capturas de CRM, planillas y chats',
    'Contactar leads desde screenshots',
  ]},
  { category: '👨‍👩‍👧‍👦 Familia y Contactos', items: [
    'Chatear con familia y amigos con tono personalizado',
    'Modo Niñera: detecta niños y adapta respuestas',
    'Gestión de contactos: familia, equipo, leads',
    '"MIIA vení" en cualquier chat 1-a-1 / "Chau MIIA" para retirarme',
  ]},
  { category: '⚽ Entretenimiento', items: [
    '"Soy hincha de Boca" → te aviso cuando juegan',
    'Seguimiento en vivo con mensajes emotivos',
    '10 deportes: fútbol, F1, tenis, NBA, MLB, UFC, rugby, boxeo, golf, ciclismo',
    'Guardarropa: guardar prendas, sugerir outfits, opinar looks',
  ]},
  { category: '🛡️ Seguridad y Privacidad', items: [
    'Contactos de Seguridad: protector/protegido con 3 niveles',
    'Alertas SOS y caída → WhatsApp + email a protectores',
    'Protección de contenido sensible en imágenes',
    'OTP para vincular contactos de seguridad',
    'Horario configurable de respuesta (default 7am-7pm)',
    'Verificación de integridad automática',
  ]},
  { category: '🧠 Inteligencia', items: [
    'Aprendo de cada conversación (con tu aprobación)',
    '"Olvidá: X" para borrar un aprendizaje',
    'Cerebro personalizado por negocio',
    'Búsqueda en Google en tiempo real',
    'Análisis de imágenes, audios y documentos',
  ]},
];

// ═══════════════════════════════════════════════════════════════
// VARIABLES INTERNAS
// ═══════════════════════════════════════════════════════════════

let _admin = null;
const _announcedUids = new Set(); // Track announcements per UID per deploy (no duplicados)
let _ttsEngine = null;
let _safeSendMessage = null;
let _generateAI = null; // Función para generar texto con IA (inyectada desde server.js)

// ═══════════════════════════════════════════════════════════════
// FUNCIONES PRINCIPALES
// ═══════════════════════════════════════════════════════════════

function init(admin, { ttsEngine, safeSendMessage, generateAI } = {}) {
  _admin = admin;
  _ttsEngine = ttsEngine || null;
  _safeSendMessage = safeSendMessage || null;
  _generateAI = generateAI || null;
  console.log(`[FEATURE-ANNOUNCER] ✅ Inicializado (v${CURRENT_VERSION}, ${CHANGELOG.length} features nuevas, TTS=${!!_ttsEngine}, AI=${!!_generateAI})`);
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
  if (_announcedUids.has(uid) || !uid || !_admin) return;

  try {
    const metaRef = _admin.firestore().collection('users').doc(uid).collection('miia_meta').doc('feature_version');
    const metaDoc = await metaRef.get();
    const lastSeenVersion = metaDoc.exists ? metaDoc.data().version : null;

    if (lastSeenVersion === CURRENT_VERSION) {
      console.log(`[FEATURE-ANNOUNCER] Owner ya vio v${CURRENT_VERSION} — sin anuncio`);
      return;
    }

    console.log(`[FEATURE-ANNOUNCER] 📢 Anunciando v${CURRENT_VERSION} (last_seen: ${lastSeenVersion || 'nunca'})`);

    // Construir mensaje de novedades — con IA si disponible, fallback a template
    let msg = '';
    if (_generateAI) {
      try {
        const featureList = CHANGELOG.map(f => `- ${f.title}: ${f.description}${f.commands ? ' (Comandos: ' + f.commands.join(', ') + ')' : ''}`).join('\n');
        const aiPrompt = `Sos MIIA, asistente personal por WhatsApp. Acabás de recibir ${CHANGELOG.length} funciones nuevas y querés contárselo a tu owner (tu jefe, la persona a la que ayudás).

FUNCIONES NUEVAS:
${featureList}

REGLAS:
- Hablá en primera persona, informal, argentino ("podés", "tenés", "mandame")
- Soná emocionada pero natural, como contándole a un amigo
- NO uses formato de lista con bullets/viñetas
- Usá *negritas* solo para lo más importante
- Mencioná las funciones más útiles primero, integralas en párrafos fluidos
- Cerrá invitando a preguntar "¿qué podés hacer?" para ver todo
- Máximo 15 líneas, emojis moderados (2-4 total)
- NUNCA digas "me agregaron" o "se implementó" — decí "ahora puedo", "aprendí a"
- NO expongas mecánica interna (Firestore, APIs, backend)`;

        const aiMsg = await _generateAI(aiPrompt);
        if (aiMsg && aiMsg.trim().length > 30) {
          msg = aiMsg.trim();
          console.log(`[FEATURE-ANNOUNCER] 🤖 Anuncio generado por IA (${msg.length} chars)`);
        }
      } catch (aiErr) {
        console.warn(`[FEATURE-ANNOUNCER] ⚠️ IA falló para anuncio, usando template: ${aiErr.message}`);
      }
    }

    // Fallback: template hardcodeado si IA no disponible o falló
    if (!msg) {
      msg = `🆕 *¡Tengo novedades!*\n\n`;
      for (const feature of CHANGELOG) {
        msg += `${feature.title}\n`;
        msg += `${feature.description}\n`;
        if (feature.commands && feature.commands.length > 0) {
          msg += `→ Comandos: ${feature.commands.join(' | ')}\n`;
        }
        msg += '\n';
      }
      msg += `Preguntame *"¿qué podés hacer?"* cuando quieras ver todas mis funciones 😊`;
    }

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
    _announcedUids.add(uid);

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
 * Construir mensaje con TODAS las capacidades de MIIA (formato completo)
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
 * Construir mensaje RESUMIDO — solo categorías, sin detallar ítems.
 * El owner dice "contame de Agenda" y MIIA expande solo esa categoría.
 * @returns {string}
 */
function buildCapabilitiesSummary() {
  let msg = `🤖 *Estas son mis áreas de trabajo:*\n\n`;
  CAPABILITIES.forEach((cat, i) => {
    msg += `*${i + 1}.* ${cat.category} _(${cat.items.length} funciones)_\n`;
  });
  msg += `\n_Decime el número o nombre de la categoría y te detallo qué puedo hacer ahí._`;
  return msg;
}

/**
 * Construir detalle de UNA categoría específica
 * @param {string} query - nombre o número de categoría
 * @returns {string|null} null si no matchea
 */
function buildCategoryDetail(query) {
  if (!query) return null;
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // Match por número
  const numMatch = q.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    if (idx >= 0 && idx < CAPABILITIES.length) {
      return _formatCategory(CAPABILITIES[idx]);
    }
    return null;
  }

  // Match por nombre (fuzzy)
  const cat = CAPABILITIES.find(c => {
    const catName = c.category.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, '').trim();
    return catName.includes(q) || q.includes(catName.split(' ').pop());
  });

  return cat ? _formatCategory(cat) : null;
}

function _formatCategory(cat) {
  let msg = `*${cat.category}*\n\n`;
  cat.items.forEach(item => {
    msg += `  • ${item}\n`;
  });
  msg += `\n_¿Querés saber de otra área? Decime cuál._`;
  return msg;
}

/**
 * Detectar si el owner pide detalle de una categoría específica
 * @param {string} message
 * @returns {boolean}
 */
function isCategoryDetailQuery(message) {
  if (!message) return false;
  const m = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // "contame de agenda", "qué podés hacer con email", "detalle de seguridad", "1", "2", etc.
  return /\b(contame|decime|detalle|detalla|explicame|que\s+pod[eé]s.*(?:con|en|de|sobre))\b/i.test(m) ||
    /^[1-9]\d?$/.test(m.trim());
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
  isCategoryDetailQuery,
  buildCapabilitiesMessage,
  buildCapabilitiesSummary,
  buildCategoryDetail,
  getVersion,
  CURRENT_VERSION,
  CHANGELOG,
  CAPABILITIES,
};
