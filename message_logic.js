/**
 * MESSAGE_LOGIC.JS — Funciones puras compartidas entre server.js y tenant_message_handler.js
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Este módulo contiene SOLO funciones puras o casi-puras (sin estado global, sin sockets).
 * server.js y tenant_message_handler.js importan estas funciones.
 *
 * REGLA: Ninguna función aquí debe depender de OWNER_UID, sock, conversations, o cualquier estado global.
 *        Todo estado necesario se pasa como parámetro.
 */

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const MIIA_CIERRE = `\n\n_Si quieres seguir hablando, responde *HOLA MIIA*. Si prefieres terminar, escribe *CHAU MIIA*._`;

const HOLIDAYS_BY_COUNTRY = {
  CO: ['01-01','01-06','03-24','03-28','03-29','05-01','06-02','06-23','06-30',
       '07-01','07-20','08-07','08-18','10-13','11-03','11-17','12-08','12-25'],
  AR: ['01-01','02-12','02-13','03-24','03-28','03-29','04-02','05-01','05-25',
       '06-17','06-20','07-09','08-17','10-12','11-20','12-08','12-25'],
  MX: ['01-01','02-03','03-17','03-28','03-29','05-01','05-05','09-16',
       '10-12','11-02','11-17','12-25'],
  CL: ['01-01','03-28','03-29','05-01','05-21','06-20','06-29','07-16',
       '08-15','09-18','09-19','10-12','10-31','11-01','12-08','12-25'],
  PE: ['01-01','03-28','03-29','05-01','06-07','06-29','07-23','07-28',
       '07-29','08-06','08-30','10-08','11-01','12-08','12-09','12-25'],
  EC: ['01-01','02-12','02-13','03-28','03-29','05-01','05-24',
       '08-10','10-09','11-02','11-03','12-25'],
  US: ['01-01','07-04','11-11','12-25'],
  ES: ['01-01','01-06','03-28','03-29','05-01','08-15','10-12','11-01','12-06','12-08','12-25']
};

const INSULT_KEYWORDS = [
  'idiota', 'estúpido', 'imbécil', 'inútil', 'maldito', 'hdp', 'hijo de puta',
  'puta', 'gilipollas', 'pendejo', 'asco', 'basura', 'mierda', 'te odio',
  'eres una porquería', 'mal servicio de mierda', 'son unos ladrones',
  'te voy a demandar', 'os voy a denunciar', 'voy a poner una queja',
  'nunca más', 'nunca mas', 'son lo peor', 'lo peor del mundo'
];

const COMPLAINT_KEYWORDS = [
  'no funciona', 'muy mal', 'terrible', 'horrible', 'pésimo', 'pesimo',
  'desastre', 'decepcionado', 'decepcionada', 'muy decepcionado',
  'no me ayudaste', 'no me ayudaron', 'me fallaste', 'me fallaron',
  'perdí tiempo', 'perdí plata', 'perdí dinero', 'no sirve', 'no sirvió',
  'quiero hablar con un humano', 'quiero hablar con una persona',
  'no quiero hablar con un bot', 'esto es inaceptable', 'estoy harto',
  'estoy harta', 'me tienen cansado', 'me tienen cansada'
];

const OPT_OUT_KEYWORDS = ['quitar', 'baja', 'no molestar', 'no me interesa', 'spam', 'parar', 'unsubscribe'];

const EMPATHETIC_INSULT_RESPONSES = [
  'Entiendo que estás frustrado/a, y lo respeto. Si hay algo que salió mal, me gustaría saberlo para ayudarte mejor. 🙏',
  'Percibo que algo no está bien y lo tomo en serio. Cuéntame qué pasó para que podamos resolverlo juntos.',
  'Lamento que te sientas así. Estoy aquí para ayudarte a resolver lo que sea necesario. ¿Qué ocurrió?'
];

const EMPATHETIC_COMPLAINT_RESPONSES = [
  'Lamento escuchar eso. Tu experiencia es muy importante para nosotros. ¿Puedes contarme más sobre lo que pasó para que pueda ayudarte? 🙏',
  'Entiendo tu frustración y la tomo muy en serio. Voy a alertar al equipo para que te contacten personalmente. ¿Cuál es el mejor momento para llamarte?',
  'Siento mucho lo que describes. Esto no es lo que esperamos para ti. Déjame escalarlo ahora mismo para darte una solución real.'
];

const MSG_SUSCRIPCION = `¡Genial! Para armar tu link de acceso solo necesito dos datos:

1. Tu correo electrónico
2. Método de pago preferido: ¿tarjeta de crédito o débito?

El resto ya lo tengo del plan que conversamos. El link tiene una validez de 24 horas desde que te lo envío, así que cuando lo recibas conviene completar el proceso ese mismo día para no perder el descuento. 😊`;

// ═══════════════════════════════════════════════════════════════
// FUNCIONES PURAS — TEXTO
// ═══════════════════════════════════════════════════════════════

/**
 * Normaliza texto para comparaciones (minúscula, sin acentos, sin especiales)
 */
function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

/**
 * Introduce un typo aleatorio (~2% probabilidad) para humanizar mensajes
 */
function maybeAddTypo(text) {
  if (Math.random() > 0.02 || text.length < 10) return text;
  const pos = Math.floor(Math.random() * (text.length - 2)) + 1;
  return text.slice(0, pos) + text[pos + 1] + text[pos] + text.slice(pos + 2);
}

/**
 * Detecta si un mensaje parece venir de un bot
 */
function isPotentialBot(text) {
  if (!text) return false;
  const botKeywords = [
    'soy un bot', 'asistente virtual', 'mensaje automático',
    'auto-responder', 'vía @', 'powered by', 'gracias por su mensaje',
    'transcripción de audio'
  ];
  const lowerText = text.toLowerCase();
  return botKeywords.some(kw => lowerText.includes(kw));
}

// ═══════════════════════════════════════════════════════════════
// FUNCIONES PURAS — HORARIOS Y GEOGRAFÍA
// ═══════════════════════════════════════════════════════════════

/**
 * Verifica si estamos dentro del horario de atención (con config de Firestore)
 * @param {Object|null} scheduleConfig - Config de horario del tenant
 * @returns {boolean}
 */
function isWithinScheduleConfig(scheduleConfig) {
  if (!scheduleConfig) return true; // sin config → siempre activo
  const tz = scheduleConfig.timezone || 'America/Bogota';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const day = now.getDay();
  const h = now.getHours();
  const m = now.getMinutes();
  const currentTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;

  if (scheduleConfig.activeDays && !scheduleConfig.activeDays.includes(day)) return false;

  const start = scheduleConfig.startTime || '09:00';
  const end = scheduleConfig.endTime || '21:00';
  if (currentTime < start || currentTime >= end) return false;

  return true;
}

/**
 * Detecta país por prefijo telefónico
 * @param {string} phone - Número de teléfono (con o sin @s.whatsapp.net)
 * @returns {string} Código de país (CO, AR, MX, etc.)
 */
function getCountryFromPhone(phone) {
  const num = phone.replace(/[^0-9]/g, '');
  if (num.startsWith('57')) return 'CO';
  if (num.startsWith('54')) return 'AR';
  if (num.startsWith('52')) return 'MX';
  if (num.startsWith('56')) return 'CL';
  if (num.startsWith('51')) return 'PE';
  if (num.startsWith('593')) return 'EC';
  if (num.startsWith('1')) return 'US';
  if (num.startsWith('34')) return 'ES';
  return 'CO'; // default Colombia
}

/**
 * Obtiene timezone por código de país
 */
function getTimezoneForCountry(country) {
  const tzMap = {
    CO: 'America/Bogota', AR: 'America/Argentina/Buenos_Aires', MX: 'America/Mexico_City',
    CL: 'America/Santiago', PE: 'America/Lima', EC: 'America/Guayaquil',
    US: 'America/New_York', ES: 'Europe/Madrid'
  };
  return tzMap[country] || 'America/Bogota';
}

/**
 * Genera contexto geográfico para el prompt de leads
 * @param {string} basePhone - Número base (sin @s.whatsapp.net)
 * @returns {string} Contexto geográfico para inyectar en el prompt
 */
function getCountryContext(basePhone) {
  const countryCode = basePhone.substring(0, 2);
  const countryCode3 = basePhone.substring(0, 3);

  if (countryCode === '57') return '🌍 El lead es de COLOMBIA (pais:"COLOMBIA", moneda:"COP"). SIIGO/BOLD: mencionar SOLO si el lead los trae; si tiene SIIGO + Titanium → facturador electrónico $0.';
  if (countryCode === '52') return '🌍 El lead es de MÉXICO (pais:"MEXICO", moneda:"MXN"). IVA 16% se calcula automáticamente. PROHIBIDO mencionar SIIGO o BOLD.';
  if (countryCode === '56') return '🌍 El lead es de CHILE (pais:"CHILE", moneda:"CLP"). PROHIBIDO mencionar SIIGO o BOLD.';
  if (countryCode === '54') return '🌍 El lead es de ARGENTINA (pais:"ARGENTINA", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. Si el lead es médico, ofrecer Receta Digital AR ($3 USD, incluirRecetaAR:true). PROHIBIDO mencionar SIIGO o BOLD.';
  if (countryCode3 === '180' || countryCode3 === '182' || countryCode3 === '184') return '🌍 El lead es de REPÚBLICA DOMINICANA (pais:"REPUBLICA_DOMINICANA", moneda:"USD"). Tiene factura electrónica (incluirFactura:true). PROHIBIDO mencionar SIIGO o BOLD.';
  if (countryCode === '34') return '🌍 El lead es de ESPAÑA (pais:"ESPAÑA", moneda:"EUR"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD.';
  return '🌍 El lead es INTERNACIONAL (pais:"INTERNACIONAL", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD.';
}

/**
 * Verifica si un follow-up está bloqueado (fin de semana o festivo)
 * @param {string} phone - JID del contacto
 * @returns {string|null} Razón del bloqueo, o null si no está bloqueado
 */
function isFollowUpBlocked(phone) {
  const country = getCountryFromPhone(phone);
  const tz = getTimezoneForCountry(country);
  const nowStr = new Date().toLocaleString('en-US', { timeZone: tz });
  const localNow = new Date(nowStr);
  const day = localNow.getDay();
  const hour = localNow.getHours();
  const min = localNow.getMinutes();
  const timeDecimal = hour + min / 60;

  if (day === 6 && timeDecimal >= 15) return `fin de semana (sáb ${hour}:${min.toString().padStart(2,'0')} ${country})`;
  if (day === 0) return `fin de semana (dom ${country})`;
  if (day === 1 && timeDecimal < 8.5) return `fin de semana (lun pre-8:30 ${country})`;

  const mm = (localNow.getMonth() + 1).toString().padStart(2, '0');
  const dd = localNow.getDate().toString().padStart(2, '0');
  const todayStr = `${mm}-${dd}`;
  const holidays = HOLIDAYS_BY_COUNTRY[country] || [];
  if (holidays.includes(todayStr)) return `festivo ${todayStr} (${country})`;

  return null;
}

/**
 * Calcula milisegundos equivalentes a N días hábiles
 * @param {number} days - Cantidad de días hábiles
 * @param {string} phone - JID para detectar país
 * @returns {number} Milisegundos
 */
function calcBusinessDaysMs(days, phone) {
  const country = getCountryFromPhone(phone);
  const tz = getTimezoneForCountry(country);
  const holidays = HOLIDAYS_BY_COUNTRY[country] || [];
  let counted = 0;
  let cursor = new Date();
  while (counted < days) {
    cursor.setDate(cursor.getDate() + 1);
    const localStr = cursor.toLocaleString('en-US', { timeZone: tz });
    const local = new Date(localStr);
    const dow = local.getDay();
    if (dow === 0 || dow === 6) continue;
    const mm = (local.getMonth() + 1).toString().padStart(2, '0');
    const dd = local.getDate().toString().padStart(2, '0');
    if (holidays.includes(`${mm}-${dd}`)) continue;
    counted++;
  }
  return cursor.getTime() - Date.now();
}

// ═══════════════════════════════════════════════════════════════
// FUNCIONES PURAS — DETECCIÓN DE SENTIMIENTO
// ═══════════════════════════════════════════════════════════════

/**
 * Detecta insultos o quejas en un mensaje
 * @param {string} text - Texto del mensaje
 * @returns {{ type: 'insulto'|'queja'|null, response: string|null }}
 */
function detectNegativeSentiment(text) {
  if (!text) return { type: null, response: null };
  const msgLc = text.toLowerCase();

  const isInsult = INSULT_KEYWORDS.some(kw => msgLc.includes(kw));
  if (isInsult) {
    return {
      type: 'insulto',
      response: EMPATHETIC_INSULT_RESPONSES[Math.floor(Math.random() * EMPATHETIC_INSULT_RESPONSES.length)]
    };
  }

  const isComplaint = COMPLAINT_KEYWORDS.some(kw => msgLc.includes(kw));
  if (isComplaint) {
    return {
      type: 'queja',
      response: EMPATHETIC_COMPLAINT_RESPONSES[Math.floor(Math.random() * EMPATHETIC_COMPLAINT_RESPONSES.length)]
    };
  }

  return { type: null, response: null };
}

/**
 * Detecta si un mensaje es opt-out
 * @param {string} text - Texto del mensaje (lowercase)
 * @returns {boolean}
 */
function isOptOut(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return OPT_OUT_KEYWORDS.some(kw => lower.includes(kw));
}

// ═══════════════════════════════════════════════════════════════
// PROCESAMIENTO DE TAGS DE IA
// ═══════════════════════════════════════════════════════════════

/**
 * Procesa los tags de aprendizaje en la respuesta de la IA.
 * Soporta 3 tags:
 *   [APRENDIZAJE_NEGOCIO:texto]  → guarda en business_cerebro
 *   [APRENDIZAJE_PERSONAL:texto] → guarda en personal_brain
 *   [APRENDIZAJE_DUDOSO:texto]   → encola para aprobación del owner en self-chat
 *   [GUARDAR_APRENDIZAJE:texto]  → legacy, se trata como NEGOCIO
 *
 * @param {string} aiMessage - Respuesta completa de la IA
 * @param {Object} ctx - Contexto del mensaje
 * @param {string} ctx.uid - UID del usuario (owner o agent)
 * @param {string} ctx.ownerUid - UID del owner (= uid si es owner, distinto si es agent)
 * @param {string} ctx.role - 'admin'|'owner'|'agent'
 * @param {boolean} ctx.isOwner - true si el usuario es el owner
 * @param {Object} callbacks - Funciones para ejecutar acciones
 * @param {Function} callbacks.saveBusinessLearning - (ownerUid, text, source) => Promise
 * @param {Function} callbacks.savePersonalLearning - (uid, text, source) => Promise
 * @param {Function} callbacks.queueDubiousLearning - (ownerUid, uid, text) => Promise
 * @param {Function} [callbacks.evaluateConfidence] - (text, callAI) => Promise<number> (solo admin legacy)
 * @param {Function} [callbacks.decideConfidenceAction] - (importance, text) => {action, confidence, reason}
 * @param {Function} [callbacks.callAI] - función para llamar a la IA (para evaluación)
 * @returns {Promise<{ cleanMessage: string, pendingQuestions: Array }>}
 */
async function processLearningTags(aiMessage, ctx, callbacks) {
  const pendingQuestions = [];
  let cleanMsg = aiMessage;

  // --- Tag NEGOCIO (nuevo) + GUARDAR_APRENDIZAJE (legacy → trata como negocio) ---
  const negocioRegex = /\[(?:APRENDIZAJE_NEGOCIO|GUARDAR_APRENDIZAJE):([^\]]+)\]/g;
  let match;
  while ((match = negocioRegex.exec(aiMessage)) !== null) {
    const text = match[1].trim();
    const targetUid = ctx.role === 'agent' ? ctx.ownerUid : ctx.uid;
    try {
      await callbacks.saveBusinessLearning(targetUid, text, `MIIA_AUTO_${ctx.role}`);
      console.log(`[LEARNING:NEGOCIO] ✅ Guardado para owner=${targetUid}: "${text.substring(0, 80)}..."`);
    } catch (e) {
      console.error(`[LEARNING:NEGOCIO] ❌ Error guardando:`, e.message);
    }
  }
  cleanMsg = cleanMsg.replace(/\[(?:APRENDIZAJE_NEGOCIO|GUARDAR_APRENDIZAJE):[^\]]+\]/g, '');

  // --- Tag PERSONAL ---
  const personalRegex = /\[APRENDIZAJE_PERSONAL:([^\]]+)\]/g;
  while ((match = personalRegex.exec(aiMessage)) !== null) {
    const text = match[1].trim();
    try {
      await callbacks.savePersonalLearning(ctx.uid, text, `MIIA_AUTO_${ctx.role}`);
      console.log(`[LEARNING:PERSONAL] ✅ Guardado para uid=${ctx.uid}: "${text.substring(0, 80)}..."`);
    } catch (e) {
      console.error(`[LEARNING:PERSONAL] ❌ Error guardando:`, e.message);
    }
  }
  cleanMsg = cleanMsg.replace(/\[APRENDIZAJE_PERSONAL:[^\]]+\]/g, '');

  // --- Tag DUDOSO → encolar para aprobación en self-chat ---
  const dudosoRegex = /\[APRENDIZAJE_DUDOSO:([^\]]+)\]/g;
  while ((match = dudosoRegex.exec(aiMessage)) !== null) {
    const text = match[1].trim();
    try {
      await callbacks.queueDubiousLearning(ctx.ownerUid, ctx.uid, text);
      pendingQuestions.push({ text, source: ctx.role });
      console.log(`[LEARNING:DUDOSO] ❓ Encolado para aprobación: "${text.substring(0, 80)}..."`);
    } catch (e) {
      console.error(`[LEARNING:DUDOSO] ❌ Error encolando:`, e.message);
    }
  }
  cleanMsg = cleanMsg.replace(/\[APRENDIZAJE_DUDOSO:[^\]]+\]/g, '');

  // --- Tag legacy [APRENDIZAJE_PENDIENTE:...] (del prompt_builder v2) ---
  cleanMsg = cleanMsg.replace(/\[APRENDIZAJE_PENDIENTE:[^\]]+\]/g, '');

  return { cleanMessage: cleanMsg.trim(), pendingQuestions };
}

/**
 * Procesa el tag [AGENDAR_EVENTO:contacto|fecha|razón|hint]
 * @param {string} aiMessage
 * @param {Object} ctx - { uid, ownerUid, role }
 * @param {Function} saveEvent - (ownerUid, eventData) => Promise
 * @param {Object} leadNames - mapa phone→nombre
 * @returns {string} mensaje limpio sin tags de agenda
 */
async function processAgendaTag(aiMessage, ctx, saveEvent, leadNames) {
  const agendarMatch = aiMessage.match(/\[AGENDAR_EVENTO:([^\]]+)\]/g);
  if (!agendarMatch) return aiMessage;

  const targetUid = ctx.role === 'agent' ? ctx.ownerUid : ctx.uid;

  for (const tag of agendarMatch) {
    const inner = tag.replace('[AGENDAR_EVENTO:', '').replace(']', '');
    const parts = inner.split('|').map(p => p.trim());
    if (parts.length >= 3) {
      const [contacto, fecha, razon, hint] = parts;
      try {
        await saveEvent(targetUid, {
          contactPhone: contacto,
          contactName: (leadNames || {})[`${contacto}@s.whatsapp.net`] || contacto,
          scheduledFor: fecha,
          reason: razon,
          promptHint: hint || '',
          status: 'pending',
          searchBefore: (razon || '').toLowerCase().includes('deporte') || (razon || '').toLowerCase().includes('partido'),
          createdAt: new Date().toISOString(),
          source: `auto_detected_${ctx.role}`
        });
        console.log(`[AGENDA] 📅 Evento agendado para uid=${targetUid}: ${contacto} el ${fecha} — ${razon}`);
      } catch (e) {
        console.error(`[AGENDA] ❌ Error agendando:`, e.message);
      }
    }
  }

  return aiMessage.replace(/\[AGENDAR_EVENTO:[^\]]+\]/g, '').trim();
}

/**
 * Procesa tag [LEAD_QUIERE_COMPRAR] — marca interés de compra
 * @param {string} aiMessage
 * @param {string} phone
 * @param {Object} subscriptionState - estado mutable de suscripciones
 * @returns {string} mensaje limpio
 */
function processSubscriptionTag(aiMessage, phone, subscriptionState) {
  if (!aiMessage.includes('[LEAD_QUIERE_COMPRAR]')) return aiMessage;

  if (!subscriptionState[phone] || subscriptionState[phone].estado === 'none') {
    subscriptionState[phone] = { estado: 'asked', data: {} };
    console.log(`[COMPRA] ${phone} marcado como interesado en suscripción.`);
  }

  return aiMessage.replace('[LEAD_QUIERE_COMPRAR]', '').trim();
}

/**
 * Limpia tags residuales que no deben mostrarse al usuario
 * @param {string} aiMessage
 * @returns {string}
 */
function cleanResidualTags(aiMessage) {
  return aiMessage
    .replace(/\[ENVIAR_CORREO_A_MAESTRO:[^\]]*\]/g, '')
    .replace(/\[GENERAR_COTIZACION_PDF(?::[^\]]*)?\]/g, '')
    .trim();
}

/**
 * Divide un mensaje con [MSG_SPLIT] en partes
 * @param {string} aiMessage
 * @returns {string[]|null} Array de partes, o null si no hay split
 */
function splitMessage(aiMessage) {
  if (!aiMessage.includes('[MSG_SPLIT]')) return null;
  return aiMessage.split('[MSG_SPLIT]').map(p => p.trim()).filter(p => p.length > 0);
}

// ═══════════════════════════════════════════════════════════════
// UTILIDADES DE PHONE/JID
// ═══════════════════════════════════════════════════════════════

const getBasePhone = (p) => (p || '').split('@')[0];
const toJid = (phone) => phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Constantes
  MIIA_CIERRE,
  HOLIDAYS_BY_COUNTRY,
  INSULT_KEYWORDS,
  COMPLAINT_KEYWORDS,
  OPT_OUT_KEYWORDS,
  MSG_SUSCRIPCION,

  // Funciones puras — texto
  normalizeText,
  maybeAddTypo,
  isPotentialBot,

  // Funciones puras — horarios y geografía
  isWithinScheduleConfig,
  getCountryFromPhone,
  getTimezoneForCountry,
  getCountryContext,
  isFollowUpBlocked,
  calcBusinessDaysMs,

  // Funciones puras — detección
  detectNegativeSentiment,
  isOptOut,

  // Procesamiento de tags
  processLearningTags,
  processAgendaTag,
  processSubscriptionTag,
  cleanResidualTags,
  splitMessage,

  // Utilidades
  getBasePhone,
  toJid,
  delay,
};
