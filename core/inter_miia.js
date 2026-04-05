/**
 * INTER-MIIA — Coordinación entre MIIAs de distintos owners
 *
 * Flujo:
 * 1. Owner A dice en self-chat: "decile a la MIIA de Ale que me agende una reunión el viernes"
 * 2. MIIA de A envía mensaje a Ale con formato: [MIIA_INTER:{action}:{data}]
 * 3. MIIA de Ale detecta el tag, ejecuta la acción, y confirma a Ale y a A
 *
 * Acciones soportadas:
 * - AGENDAR: Crear evento en la agenda del destinatario
 * - MENSAJE: Entregar un mensaje del owner A al owner B via su MIIA
 * - RECORDAR: Pedirle a la MIIA del otro que le recuerde algo a su owner
 * - PREGUNTAR: Hacerle una pregunta al otro owner via su MIIA
 *
 * Seguridad:
 * - Solo funciona entre usuarios registrados con MIIA activa
 * - El destinatario SIEMPRE ve el mensaje (transparencia total)
 * - Rate limit: máx 5 inter-MIIA por hora por owner
 * - No se permite enviar archivos/media por inter-MIIA
 *
 * Standard: Google + Amazon + APPLE + NASA (fail loudly, exhaustive logging)
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════

const INTER_MIIA_TAG = '[MIIA_INTER]';
const INTER_MIIA_REGEX = /\[MIIA_INTER:(\w+):(.*?)\]/s;
const MAX_INTER_MSGS_PER_HOUR = 5;

// Estado de rate limiting por owner
const interMiiaRateLimit = {};

// ═══════════════════════════════════════════════════════════════════
// DETECCIÓN DE COMANDOS INTER-MIIA EN SELF-CHAT
// ═══════════════════════════════════════════════════════════════════

/**
 * Detectar si un mensaje del owner en self-chat es un comando inter-MIIA.
 * @param {string} text - Mensaje del owner
 * @returns {{ isInterMiia: boolean, targetName?: string, action?: string, detail?: string }}
 */
function detectInterMiiaCommand(text) {
  if (!text) return { isInterMiia: false };
  const lower = text.toLowerCase();

  // Patrones de detección:
  // "decile a la MIIA de Ale que ..."
  // "pedile a la MIIA de Juan que ..."
  // "avisale a la MIIA de María que ..."
  // "preguntale a la MIIA de Pedro si ..."
  const miiaMatch = lower.match(
    /(?:decile|pedile|avisale|preguntale|dile|pidele|avisale)\s+a\s+(?:la\s+)?miia\s+de\s+(\w+)\s+(?:que|si|lo siguiente:?)\s*(.*)/is
  );

  if (miiaMatch) {
    const targetName = miiaMatch[1].trim();
    const detail = miiaMatch[2].trim();
    const action = _classifyAction(detail);

    console.log(`[INTER-MIIA] 🔍 Detectado: target=${targetName}, action=${action}, detail="${detail.substring(0, 80)}..."`);
    return { isInterMiia: true, targetName, action, detail };
  }

  return { isInterMiia: false };
}

/**
 * Clasificar la acción basada en el contenido del mensaje.
 */
function _classifyAction(detail) {
  const lower = detail.toLowerCase();

  if (/agend|reuni[oó]n|cita|junta|meeting|evento/i.test(lower)) return 'AGENDAR';
  if (/record|acord|olvid|remind/i.test(lower)) return 'RECORDAR';
  if (/\?|pregunt|consult|sab[eé]s/i.test(lower)) return 'PREGUNTAR';
  return 'MENSAJE';
}

// ═══════════════════════════════════════════════════════════════════
// ENVÍO INTER-MIIA
// ═══════════════════════════════════════════════════════════════════

/**
 * Enviar mensaje inter-MIIA al destinatario.
 * @param {Object} params
 * @param {Function} params.safeSendMessage - Función de envío seguro
 * @param {Function} params.generateAIContent - Función de IA
 * @param {Object} params.admin - Firebase admin
 * @param {string} params.ownerUid - UID del owner que origina
 * @param {string} params.ownerName - Nombre del owner que origina
 * @param {string} params.ownerPhone - JID del owner (para self-chat)
 * @param {string} params.targetPhone - Teléfono del destinatario (JID)
 * @param {string} params.targetName - Nombre del destinatario
 * @param {string} params.action - AGENDAR|MENSAJE|RECORDAR|PREGUNTAR
 * @param {string} params.detail - Detalle del mensaje
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function sendInterMiia(params) {
  const { safeSendMessage, generateAIContent, admin, ownerUid, ownerName, ownerPhone, targetPhone, targetName, action, detail } = params;

  // Rate limit check
  if (!_checkRateLimit(ownerUid)) {
    console.warn(`[INTER-MIIA] ⚠️ Rate limit alcanzado para ${ownerUid}`);
    return { success: false, message: `Ya enviaste muchos mensajes inter-MIIA esta hora. Esperá un rato.` };
  }

  // Generar mensaje natural con IA
  const msgPrompt = `Sos MIIA, la asistente IA de ${ownerName}. Necesitás enviarle un mensaje a ${targetName} de parte de ${ownerName}.

Acción: ${action}
Detalle original de ${ownerName}: "${detail}"

Generá un mensaje NATURAL y breve (máximo 3 líneas) para ${targetName} que:
1. Deje claro que es un mensaje de ${ownerName} (via MIIA)
2. Sea cordial y directo
3. Si es AGENDAR: menciona fecha/hora si se indicó
4. Si es PREGUNTAR: formule la pregunta claramente

Respondé SOLO con el mensaje, sin comillas ni explicación.`;

  let naturalMessage;
  try {
    naturalMessage = await generateAIContent(msgPrompt);
    naturalMessage = naturalMessage.trim();
  } catch (e) {
    console.error('[INTER-MIIA] ❌ Error generando mensaje:', e.message);
    naturalMessage = `Hola ${targetName}, te escribo de parte de ${ownerName}: ${detail}`;
  }

  // Agregar tag inter-MIIA (invisible para el usuario, pero la MIIA receptora lo detecta)
  const taggedMessage = `${naturalMessage}\n\n${INTER_MIIA_TAG}:${action}:${JSON.stringify({ from: ownerName, fromUid: ownerUid, detail })}`;

  try {
    // Enviar al destinatario
    await safeSendMessage(targetPhone, taggedMessage, { skipEmoji: true });
    console.log(`[INTER-MIIA] ✅ Enviado a ${targetName} (${targetPhone}) | action=${action}`);

    // Confirmar al owner en self-chat
    await safeSendMessage(ownerPhone, `✅ Le avisé a ${targetName}. Te cuento cuando me responda.`, { isSelfChat: true, skipEmoji: true });

    // Registrar en Firestore
    try {
      await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection('inter_miia_log').add({
          targetPhone,
          targetName,
          action,
          detail,
          sentAt: new Date().toISOString(),
          status: 'sent',
        });
    } catch (e) {
      console.warn('[INTER-MIIA] Warning: No se pudo loguear en Firestore:', e.message);
    }

    return { success: true };
  } catch (e) {
    console.error(`[INTER-MIIA] ❌ Error enviando a ${targetPhone}:`, e.message);
    return { success: false, message: `No pude enviar el mensaje a ${targetName}: ${e.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════
// RECEPCIÓN INTER-MIIA (la MIIA receptora detecta y ejecuta)
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar si un mensaje entrante contiene un tag inter-MIIA.
 * @param {string} text - Mensaje entrante
 * @returns {{ isInterMiia: boolean, action?: string, data?: Object, cleanMessage?: string }}
 */
function detectIncomingInterMiia(text) {
  if (!text || !text.includes(INTER_MIIA_TAG)) return { isInterMiia: false };

  try {
    // Extraer el tag
    const tagIndex = text.indexOf(INTER_MIIA_TAG);
    const cleanMessage = text.substring(0, tagIndex).trim();
    const tagPart = text.substring(tagIndex + INTER_MIIA_TAG.length + 1); // skip ":"

    const colonIndex = tagPart.indexOf(':');
    if (colonIndex === -1) return { isInterMiia: false };

    const action = tagPart.substring(0, colonIndex);
    const dataStr = tagPart.substring(colonIndex + 1);

    let data = {};
    try {
      data = JSON.parse(dataStr);
    } catch (e) {
      data = { detail: dataStr };
    }

    console.log(`[INTER-MIIA] 📨 Recibido: action=${action}, from=${data.from || 'unknown'}`);
    return { isInterMiia: true, action, data, cleanMessage };
  } catch (e) {
    console.error('[INTER-MIIA] ❌ Error parseando tag:', e.message);
    return { isInterMiia: false };
  }
}

/**
 * Procesar mensaje inter-MIIA recibido.
 * La MIIA receptora ejecuta la acción y notifica a su owner.
 * @param {Object} params
 * @param {Function} params.safeSendMessage - Función de envío seguro
 * @param {string} params.ownerPhone - JID del owner receptor (para self-chat)
 * @param {string} params.action - AGENDAR|MENSAJE|RECORDAR|PREGUNTAR
 * @param {Object} params.data - Datos del mensaje ({ from, fromUid, detail })
 * @param {string} params.cleanMessage - Mensaje limpio (sin tag)
 * @param {string} params.senderPhone - JID del que envió (la MIIA del otro)
 * @returns {Promise<void>}
 */
async function processIncomingInterMiia(params) {
  const { safeSendMessage, ownerPhone, action, data, cleanMessage, senderPhone } = params;
  const fromName = data.from || 'alguien';

  console.log(`[INTER-MIIA] ⚡ Procesando: action=${action}, from=${fromName}`);

  // Notificar al owner en self-chat sobre el mensaje inter-MIIA
  let ownerNotification;

  switch (action) {
    case 'AGENDAR':
      ownerNotification = `📅 *Mensaje de ${fromName}* (via su MIIA):\n${cleanMessage}\n\n_¿Querés que lo agende? Respondé "sí" o "no"._`;
      break;

    case 'RECORDAR':
      ownerNotification = `🔔 *Recordatorio de ${fromName}* (via su MIIA):\n${cleanMessage}`;
      break;

    case 'PREGUNTAR':
      ownerNotification = `❓ *Pregunta de ${fromName}* (via su MIIA):\n${cleanMessage}\n\n_Respondé y se lo paso._`;
      break;

    case 'MENSAJE':
    default:
      ownerNotification = `💬 *Mensaje de ${fromName}* (via su MIIA):\n${cleanMessage}`;
      break;
  }

  // Enviar notificación al owner
  await safeSendMessage(ownerPhone, ownerNotification, { isSelfChat: true, skipEmoji: true });

  // Confirmar recepción al remitente
  await safeSendMessage(senderPhone, `✅ Recibido. Se lo pasé a mi owner.`, { skipEmoji: true });
}

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

function _checkRateLimit(ownerUid) {
  const now = Date.now();
  const state = interMiiaRateLimit[ownerUid];

  if (!state || now - state.windowStart > 3600000) {
    interMiiaRateLimit[ownerUid] = { count: 1, windowStart: now };
    return true;
  }

  if (state.count >= MAX_INTER_MSGS_PER_HOUR) return false;
  state.count++;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// UTILIDAD: Buscar teléfono de contacto por nombre
// ═══════════════════════════════════════════════════════════════════

/**
 * Buscar el teléfono de un contacto por nombre.
 * Busca en: familyContacts, teamContacts, contact_index de Firestore.
 * @param {Object} admin - Firebase admin
 * @param {string} ownerUid
 * @param {string} targetName - Nombre a buscar
 * @param {Object} familyContacts - Mapa de contactos familia
 * @param {Object} teamContacts - Mapa de contactos equipo
 * @returns {Promise<{phone: string, name: string}|null>}
 */
async function findContactByName(admin, ownerUid, targetName, familyContacts = {}, teamContacts = {}) {
  const lowerTarget = targetName.toLowerCase();

  // 1. Buscar en familia
  for (const [phone, info] of Object.entries(familyContacts)) {
    if (info.name && info.name.toLowerCase() === lowerTarget) {
      return { phone: `${phone}@s.whatsapp.net`, name: info.name };
    }
  }

  // 2. Buscar en equipo
  for (const [phone, info] of Object.entries(teamContacts)) {
    if (info.name && info.name.toLowerCase() === lowerTarget) {
      return { phone: `${phone}@s.whatsapp.net`, name: info.name };
    }
  }

  // 3. Buscar en contact_index de Firestore
  try {
    const snap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('contact_index').get();

    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.name && data.name.toLowerCase() === lowerTarget) {
        return { phone: `${doc.id}@s.whatsapp.net`, name: data.name };
      }
    }
  } catch (e) {
    console.error('[INTER-MIIA] Error buscando contacto en Firestore:', e.message);
  }

  return null;
}

module.exports = {
  detectInterMiiaCommand,
  sendInterMiia,
  detectIncomingInterMiia,
  processIncomingInterMiia,
  findContactByName,
  INTER_MIIA_TAG,
};
