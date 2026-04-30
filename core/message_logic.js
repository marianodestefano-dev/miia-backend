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
 * Detecta si un mensaje contiene un trigger de activación de MIIA.
 * Diseño exquisito: "miia" siempre activa, "mía/mia" por contexto, "ia" solo vocativo.
 * Audio transcrito: más estricto (evita falsos de "esa cosa es mía").
 *
 * @param {string} messageBody - Mensaje original (sin normalizar)
 * @param {boolean} isTranscribedAudio - true si viene de audio transcrito
 * @returns {{ trigger: boolean, confidence: string, match: string }}
 */
function detectMiiaTrigger(messageBody, isTranscribedAudio = false) {
  const norm = normalizeText(messageBody);
  const words = norm.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  if (wordCount === 0) return { trigger: false, confidence: 'none', match: 'empty' };

  // ═══ NIVEL 1: "miia" (dos ii) → SIEMPRE activa ═══
  // "miia" no es una palabra del español. Si la escriben/dicen, es intencional.
  if (words.some(w => w === 'miia')) {
    return { trigger: true, confidence: 'high', match: 'miia_exact' };
  }

  // ═══ NIVEL 2: "mia" como palabra suelta → contexto necesario ═══
  // "mia" puede ser nombre propio, "mía" (posesivo), o trigger de MIIA
  const miaIndex = words.indexOf('mia');
  if (miaIndex !== -1) {
    // Vocativo: al inicio, o precedido de saludo/interjección
    const VOCATIVOS = ['hola', 'ey', 'oye', 'che', 'hey', 'dale', 'oi', 'epa', 'oiga'];
    const isVocative = miaIndex === 0 ||
                       (miaIndex === 1 && VOCATIVOS.includes(words[0]));

    if (!isTranscribedAudio) {
      // TEXTO: "mia" al inicio/vocativo → activa
      if (isVocative) return { trigger: true, confidence: 'high', match: 'mia_vocative_text' };
      // TEXTO: frase corta con "mia" → probablemente la llama
      if (wordCount <= 6) return { trigger: true, confidence: 'medium', match: 'mia_short_text' };
      // TEXTO: frase larga con "mia" en medio → "esa bolsa es mía" → NO
      return { trigger: false, confidence: 'low', match: 'mia_in_long_phrase' };
    } else {
      // AUDIO: más estricto. "mia" es super común en español hablado.
      if (isVocative && wordCount <= 8) return { trigger: true, confidence: 'medium', match: 'audio_mia_vocative' };
      // Audio: frase corta + intención (pregunta o imperativo)
      const IMPERATIVOS = ['haceme', 'ayudame', 'decime', 'pasame', 'buscame', 'avisame',
        'recordame', 'agendame', 'mandame', 'contame', 'dame', 'dime', 'hazme',
        'ayuda', 'busca', 'agenda', 'manda', 'necesito', 'quiero', 'podes', 'puedes'];
      const hasIntent = messageBody.includes('?') ||
                        words.some(w => IMPERATIVOS.includes(w));
      if (wordCount <= 8 && hasIntent) return { trigger: true, confidence: 'medium', match: 'audio_mia_intent' };
      return { trigger: false, confidence: 'low', match: 'audio_mia_no_intent' };
    }
  }

  // ═══ NIVEL 3: "ia" como palabra suelta → SOLO vocativo al inicio, frase corta ═══
  const iaIndex = words.indexOf('ia');
  if (iaIndex !== -1) {
    if (iaIndex === 0 && wordCount >= 2 && wordCount <= 6) {
      return { trigger: true, confidence: 'low', match: 'ia_vocative_short' };
    }
    return { trigger: false, confidence: 'none', match: 'ia_in_phrase' };
  }

  return { trigger: false, confidence: 'none', match: 'no_match' };
}

/**
 * Detecta si un mensaje contiene un trigger de desactivación de MIIA.
 * Más flexible que solo "chau miia" — acepta despedidas naturales + nombre.
 *
 * @param {string} messageBody
 * @returns {{ trigger: boolean, match: string }}
 */
function detectChauMiiaTrigger(messageBody) {
  const norm = normalizeText(messageBody);
  const words = norm.split(/\s+/).filter(w => w.length > 0);

  // Exactos
  if (norm.includes('chau miia') || norm.includes('chao miia')) return { trigger: true, match: 'chau_miia' };
  if (norm.includes('chau mia') || norm.includes('chao mia')) return { trigger: true, match: 'chau_mia' };
  if (norm.includes('adios miia') || norm.includes('adios mia')) return { trigger: true, match: 'adios_miia' };
  if (norm.includes('nos vemos miia') || norm.includes('nos vemos mia')) return { trigger: true, match: 'nos_vemos_miia' };

  // Despedida + "miia" o "mia" en cualquier orden en frase corta
  const DESPEDIDAS = ['chau', 'chao', 'adios', 'bye', 'listo', 'gracias', 'bueno'];
  const hasMiia = words.some(w => w === 'miia' || w === 'mia');
  const hasDespedida = words.some(w => DESPEDIDAS.includes(w));
  if (hasMiia && hasDespedida && words.length <= 6) {
    return { trigger: true, match: 'despedida_con_nombre' };
  }

  return { trigger: false, match: 'no_match' };
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
  if (scheduleConfig.alwaysOn) return true; // 24/7 mode — MIIA CENTER y tenants que quieran responder siempre
  const tz = scheduleConfig.timezone || 'America/Bogota';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const day = now.getDay();
  const h = now.getHours();
  const m = now.getMinutes();
  const currentTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;

  if (scheduleConfig.activeDays && !scheduleConfig.activeDays.includes(day)) return false;

  const start = scheduleConfig.startTime || '07:00';
  const end = scheduleConfig.endTime || '23:00';
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
  if (num.startsWith('55')) return 'BR';  // Brasil (T40 multilang)
  if (num.startsWith('44')) return 'GB';  // Reino Unido (T40 multilang)
  if (num.startsWith('61')) return 'AU';  // Australia (T40 multilang)
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
    US: 'America/New_York', ES: 'Europe/Madrid',
    BR: 'America/Sao_Paulo', GB: 'Europe/London', AU: 'Australia/Sydney', // T40 multilang
  };
  return tzMap[country] || 'America/Bogota';
}

/**
 * Retorna info de idioma y dialecto para un código de país.
 * Detecta automáticamente si el lead escribe desde BR/US/GB/AU → idioma EN/PT.
 * Leads ES → retorna lang='es' (comportamiento por defecto, sin cambio).
 *
 * @param {string} cc - Código de país ('CO', 'AR', 'BR', 'US', 'GB', etc.)
 * @returns {{ lang: string, dialect: string, greeting: string, tuteo: string }}
 */
function getLangFromCountry(cc) {
  const map = {
    // English
    US: { lang: 'en', dialect: 'en_us', greeting: 'Hey', tuteo: 'you' },
    CA: { lang: 'en', dialect: 'en_ca', greeting: 'Hey', tuteo: 'you' },
    AU: { lang: 'en', dialect: 'en_au', greeting: 'Hey', tuteo: 'you' },
    GB: { lang: 'en', dialect: 'en_gb', greeting: 'Hello', tuteo: 'you' },
    // Portugues
    BR: { lang: 'pt', dialect: 'pt_br', greeting: 'Oi', tuteo: 'voce' },
    PT: { lang: 'pt', dialect: 'pt_pt', greeting: 'Ola', tuteo: 'voce' },
    // Espanol dialectos
    AR: { lang: 'es', dialect: 'es_ar', greeting: 'Hola', tuteo: 'vos' },
    MX: { lang: 'es', dialect: 'es_mx', greeting: 'Hola', tuteo: 'tu' },
    ES: { lang: 'es', dialect: 'es_es', greeting: 'Hola', tuteo: 'tu' },
    CO: { lang: 'es', dialect: 'es_co', greeting: 'Hola', tuteo: 'tu' },
    CL: { lang: 'es', dialect: 'es_cl', greeting: 'Hola', tuteo: 'tu' },
    PE: { lang: 'es', dialect: 'es_pe', greeting: 'Hola', tuteo: 'tu' },
    EC: { lang: 'es', dialect: 'es_ec', greeting: 'Hola', tuteo: 'tu' },
  };
  return map[cc] || { lang: 'es', dialect: 'es_co', greeting: 'Hola', tuteo: 'tu' };
}

/**
 * Genera instrucción de idioma para inyectar al inicio del prompt de Gemini.
 * Para leads EN/PT: instrucción MANDATORY obligando el idioma.
 * Para leads ES: retorna '' (Gemini ya responde en español por defecto).
 *
 * Capa B (wire-in a prompts) requiere decisión Wi sobre política §6.27 US.
 * Esta función es Capa A: solo la definición, sin wire-in aún.
 *
 * @param {{ lang: string }} langInfo - Objeto retornado por getLangFromCountry
 * @returns {string} Instrucción a prepender al prompt, o '' si lang=es
 */
function buildLangInstruction(langInfo) {
  if (!langInfo || langInfo.lang === 'es') return '';
  if (langInfo.lang === 'en') {
    return 'MANDATORY LANGUAGE: Respond ONLY in English. Never switch to Spanish or any other language. Use natural conversational English.\n\n';
  }
  if (langInfo.lang === 'pt') {
    return 'IDIOMA OBRIGATORIO: Responda APENAS em Portugues Brasileiro. Nunca mude para Espanhol. Portugues coloquial natural.\n\n';
  }
  return '';
}

/**
 * Genera contexto geográfico + dialecto para el prompt de CUALQUIER contacto
 * @param {string} basePhone - Número base (sin @s.whatsapp.net)
 * @returns {string} Contexto geográfico + dialecto para inyectar en el prompt
 */
function getCountryContext(basePhone) {
  const countryCode = basePhone.substring(0, 2);
  const countryCode3 = basePhone.substring(0, 3);

  if (countryCode === '57') return '🌍 El contacto es de COLOMBIA (pais:"COLOMBIA", moneda:"COP"). SIIGO/BOLD: mencionar SOLO si el contacto los trae; si tiene SIIGO + Titanium → facturador electrónico $0. 🗣️ DIALECTO: Usá TÚ (tuteo colombiano). Decí "cuéntame", "dime", "mira". NUNCA "contame", "decime", "mirá" (eso es argentino). Expresiones: "listo", "dale", "claro que sí", "con mucho gusto".';
  if (countryCode === '52') return '🌍 El contacto es de MÉXICO (pais:"MEXICO", moneda:"MXN"). IVA 16% se calcula automáticamente. PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo mexicano). Decí "cuéntame", "platícame", "mira". NUNCA "contame", "decime", "mirá" (eso es argentino). Expresiones: "órale", "sale", "claro", "con gusto".';
  if (countryCode === '56') return '🌍 El contacto es de CHILE (pais:"CHILE", moneda:"CLP"). PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo chileno). Decí "cuéntame", "dime". NUNCA "contame", "decime", "mirá" (eso es argentino). Expresiones: "dale", "ya", "perfecto".';
  if (countryCode === '54') return '🌍 El contacto es de ARGENTINA (pais:"ARGENTINA", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. Si el contacto es médico, ofrecer Receta Digital AR ($3 USD, incluirRecetaAR:true). PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá VOS (voseo rioplatense). Decí "contame", "decime", "mirá", "fijate". Expresiones: "dale", "genial", "bárbaro".';
  if (countryCode3 === '180' || countryCode3 === '182' || countryCode3 === '184') return '🌍 El contacto es de REPÚBLICA DOMINICANA (pais:"REPUBLICA_DOMINICANA", moneda:"USD"). Tiene factura electrónica (incluirFactura:true). PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo caribeño). Decí "cuéntame", "dime". NUNCA "contame" ni "decime". Expresiones: "claro", "perfecto", "con gusto".';
  if (countryCode === '34') return '🌍 El contacto es de ESPAÑA (pais:"ESPAÑA", moneda:"EUR"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (tuteo español). Decí "cuéntame", "dime", "mira". NUNCA "contame", "decime", "mirá" (eso es argentino). NUNCA usar "vos". Expresiones: "vale", "genial", "perfecto", "estupendo".';
  return '🌍 El contacto es INTERNACIONAL (pais:"INTERNACIONAL", moneda:"USD"). PROHIBIDO factura electrónica — usar incluirFactura:false. PROHIBIDO mencionar SIIGO o BOLD. 🗣️ DIALECTO: Usá TÚ (español neutro). Decí "cuéntame", "dime". NUNCA "contame" ni "decime" (eso es argentino). Tono profesional neutro.';
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
  // 🔒 SISTEMA DE AUTENTICACIÓN DE APRENDIZAJE — 5 niveles de confianza:
  //
  // | Quién              | Personal    | Negocio                          |
  // |--------------------|-------------|----------------------------------|
  // | Owner (self-chat)  | ✅ Directo  | ✅ Directo (es el dueño)         |
  // | Admin              | ✅ Directo  | ✅ Directo                       |
  // | Agente + CLAVE     | ✅ Directo  | ✅ Directo (tiene clave)         |
  // | Agente sin clave   | ✅ Directo  | ⏳ Encolar → owner aprueba      |
  // | Familia/Equipo+KEY | ✅ Directo  | ✅ Directo (owner les dio clave) |
  // | Familia/Equipo     | ✅ De ellos | ⏳ Encolar → owner aprueba      |
  // | Lead               | ❌ BLOQUEADO| ❌ BLOQUEADO (SIEMPRE)           |
  //
  // La clave de aprendizaje (learningKey) es alfanumérica de 6 dígitos,
  // se genera al crear el negocio y se ve en el dashboard del owner/agente.
  // El contacto la incluye en su mensaje de confirmación: "sí AB12CD"
  // MIIA detecta la clave en ctx.learningKeyProvided (pre-procesado por el handler).

  const negocioRegex = /\[(?:APRENDIZAJE_NEGOCIO|GUARDAR_APRENDIZAJE):([^\]]+)\]/g;
  let match;
  while ((match = negocioRegex.exec(aiMessage)) !== null) {
    const text = match[1].trim();
    const targetUid = ctx.role === 'agent' ? ctx.ownerUid : ctx.uid;

    // Nivel 1: Owner/Admin → guardar directo
    if (ctx.isOwner || ctx.role === 'admin') {
      try {
        await callbacks.saveBusinessLearning(targetUid, text, `MIIA_AUTO_${ctx.role}`);
        console.log(`[LEARNING:NEGOCIO] ✅ Guardado (${ctx.role}) para owner=${targetUid}: "${text.substring(0, 80)}..."`);
      } catch (e) {
        console.error(`[LEARNING:NEGOCIO] ❌ Error guardando:`, e.message);
      }
      continue;
    }

    // Nivel 2: Agente/Familia/Equipo CON clave de aprobación válida → guardar directo
    if ((ctx.role === 'agent' || ctx.role === 'family' || ctx.role === 'team') && ctx.learningKeyValid) {
      try {
        await callbacks.saveBusinessLearning(targetUid, text, `MIIA_APPROVED_${ctx.role}`);
        // Marcar la aprobación como aplicada
        if (ctx.approvalDocRef && callbacks.markApprovalApplied) {
          await callbacks.markApprovalApplied(ctx.approvalDocRef);
        }
        console.log(`[LEARNING:NEGOCIO] 🔑 Guardado con clave aprobada (${ctx.role}) para owner=${targetUid}: "${text.substring(0, 80)}..."`);
      } catch (e) {
        console.error(`[LEARNING:NEGOCIO] ❌ Error guardando:`, e.message);
      }
      continue;
    }

    // Nivel 3: Agente/Familia/Equipo SIN clave → solicitar aprobación dinámica al owner
    if (ctx.role === 'agent' || ctx.role === 'family' || ctx.role === 'team') {
      try {
        // Crear solicitud de aprobación con clave dinámica
        if (callbacks.createLearningApproval) {
          const { key, expiresAt } = await callbacks.createLearningApproval(ctx.ownerUid || targetUid, {
            agentUid: ctx.uid,
            agentName: ctx.contactName || ctx.role,
            agentPhone: ctx.contactPhone || '',
            changes: text,
            scope: ctx.learningScope || 'business_global'
          });
          const expDate = expiresAt instanceof Date ? expiresAt.toLocaleDateString('es', { day: 'numeric', month: 'long' }) : '';
          // Notificar al owner con clave + detalle
          if (callbacks.notifyOwner) {
            await callbacks.notifyOwner(
              `📋 *Solicitud de aprendizaje*\n` +
              `De: *${ctx.contactName || ctx.role}*\n` +
              `Cambio: "${text.substring(0, 300)}"\n` +
              `Alcance: ${ctx.learningScope === 'agent_only' ? 'Solo para este agente' : 'General del negocio'}\n\n` +
              `🔑 Clave de aprobación: *${key}*\n` +
              `Válida hasta: ${expDate}\n\n` +
              `Si apruebas, reenvía o copia esta clave al agente.`
            );
          }
          console.log(`[LEARNING:NEGOCIO] 🔑 Aprobación solicitada (${ctx.role}) key=${key}: "${text.substring(0, 80)}..."`);
        } else {
          // Fallback: encolar como dudoso
          await callbacks.queueDubiousLearning(ctx.ownerUid || targetUid, ctx.uid, `[NEGOCIO pendiente de ${ctx.role}] ${text}`);
          console.log(`[LEARNING:NEGOCIO] ⏳ Encolado para aprobación (fallback): "${text.substring(0, 80)}..."`);
        }
        pendingQuestions.push({ text, source: ctx.role, type: 'business_needs_approval' });
      } catch (e) {
        console.error(`[LEARNING:NEGOCIO] ❌ Error creando aprobación:`, e.message);
      }
      continue;
    }

    // Nivel 4: Lead o rol desconocido → BLOQUEADO SIEMPRE (con o sin clave)
    console.warn(`[LEARNING:NEGOCIO] 🚨 BLOQUEADO — rol="${ctx.role}" contacto="${ctx.contactName || '?'}" intentó guardar: "${text.substring(0, 120)}"`);
    if (callbacks.notifyOwner) {
      try {
        await callbacks.notifyOwner(
          `⚠️ *Intento de aprendizaje bloqueado*\n` +
          `Contacto: *${ctx.contactName || 'Desconocido'}* (${ctx.contactPhone || '?'})\n` +
          `Intentó enseñarme: "${text.substring(0, 200)}"\n` +
          `Motivo: rol "${ctx.role}" no tiene permisos.\n` +
          `No guardé nada. Si es legítimo, ingresalo desde el self-chat.`
        );
      } catch (_) {}
    }
  }
  cleanMsg = cleanMsg.replace(/\[(?:APRENDIZAJE_NEGOCIO|GUARDAR_APRENDIZAJE):[^\]]+\]/g, '');

  // --- Tag PERSONAL ---
  // 🔒 SEGURIDAD: Leads NO pueden guardar aprendizaje personal (solo su perfil se guarda via otro mecanismo)
  const personalRegex = /\[APRENDIZAJE_PERSONAL:([^\]]+)\]/g;
  while ((match = personalRegex.exec(aiMessage)) !== null) {
    const text = match[1].trim();
    if (ctx.role === 'lead') {
      console.warn(`[LEARNING:PERSONAL] 🚫 BLOQUEADO: Lead ${ctx.contactPhone} — no puede guardar aprendizaje personal: "${text.substring(0, 80)}"`);
      continue;
    }
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

  // --- Tag GUARDAR_NOTA (referencia, no cambia comportamiento) ---
  // 🔒 SEGURIDAD: Solo owner, agent y equipo pueden guardar notas. Leads BLOQUEADOS.
  const notaRegex = /\[GUARDAR_NOTA:([^\]]+)\]/g;
  while ((match = notaRegex.exec(aiMessage)) !== null) {
    const text = match[1].trim();
    if (ctx.role === 'lead') {
      console.warn(`[LEARNING:NOTA] 🚫 BLOQUEADO: Lead ${ctx.contactPhone} intentó guardar nota: "${text.substring(0, 80)}"`);
      continue;
    }
    const targetUid = ctx.role === 'agent' ? ctx.ownerUid : ctx.uid;
    try {
      await callbacks.saveBusinessLearning(targetUid, `[NOTA] ${text}`, `MIIA_NOTA_${ctx.role}`);
      console.log(`[LEARNING:NOTA] 📌 Guardado para owner=${targetUid}: "${text.substring(0, 80)}..."`);
    } catch (e) {
      console.error(`[LEARNING:NOTA] ❌ Error guardando:`, e.message);
    }
  }
  cleanMsg = cleanMsg.replace(/\[GUARDAR_NOTA:[^\]]+\]/g, '');

  // --- Tag legacy [APRENDIZAJE_PENDIENTE:...] (del prompt_builder v2) ---
  cleanMsg = cleanMsg.replace(/\[APRENDIZAJE_PENDIENTE:[^\]]+\]/g, '');

  return { cleanMessage: cleanMsg.trim(), pendingQuestions };
}

/**
 * Procesa el tag [AGENDAR_EVENTO:contacto|fecha|razón|hint|modo|ubicacion]
 * Guarda en Firestore Y crea evento en Google Calendar si el owner tiene Calendar conectado.
 *
 * @param {string} aiMessage
 * @param {Object} ctx - { uid, ownerUid, role, isSelfChat, basePhone, phone }
 * @param {Function} saveEvent - (ownerUid, eventData) => Promise
 * @param {Object} leadNames - mapa phone→nombre
 * @param {Object} [calendarOpts] - Opciones de Google Calendar (opcional)
 * @param {Function} [calendarOpts.createCalendarEvent] - Función para crear evento en Calendar
 * @param {Function} [calendarOpts.getTimezone] - (uid) => timezone string
 * @returns {string} mensaje limpio sin tags de agenda
 */
async function processAgendaTag(aiMessage, ctx, saveEvent, leadNames, calendarOpts) {
  const agendarMatch = aiMessage.match(/\[AGENDAR_EVENTO:([^\]]+)\]/g);
  if (!agendarMatch) return aiMessage;

  const targetUid = ctx.role === 'agent' ? ctx.ownerUid : ctx.uid;

  for (const tag of agendarMatch) {
    const inner = tag.replace('[AGENDAR_EVENTO:', '').replace(']', '');
    const parts = inner.split('|').map(p => p.trim());
    if (parts.length >= 3) {
      const [contacto, fecha, razon, hint, modo, ubicacion] = parts;
      try {
        // FIX: Si contacto no es un teléfono válido (ej: "Mariano"), usar el phone real del chat
        const isValidPhone = contacto && /^\d{8,15}$/.test(contacto.replace(/\D/g, ''));
        const isSelfChat = ctx.isSelfChat || false;
        const resolvedPhone = isValidPhone ? contacto :
          (isSelfChat ? 'self' : (ctx.basePhone || ctx.phone || contacto));
        const contactName = (leadNames || {})[`${contacto}@s.whatsapp.net`] || contacto;

        // ═══ PASO 1: Crear evento en Google Calendar (si disponible) ═══
        let calendarOk = false;
        let meetLink = null;
        const eventMode = (modo || 'presencial').toLowerCase();

        if (calendarOpts?.createCalendarEvent) {
          try {
            const parsedDate = new Date(fecha);
            if (!isNaN(parsedDate)) {
              const ownerTz = calendarOpts.getTimezone ? await calendarOpts.getTimezone(targetUid) : 'America/Bogota';
              const hourMatch = fecha.match(/(\d{1,2}):(\d{2})/);
              const startH = hourMatch ? parseInt(hourMatch[1]) : 10;
              const startMin = hourMatch ? parseInt(hourMatch[2]) : 0;
              const calResult = await calendarOpts.createCalendarEvent({
                summary: razon || 'Evento MIIA',
                dateStr: fecha.split('T')[0],
                startHour: startH,
                startMinute: startMin,
                endHour: startH + 1,
                endMinute: startMin,
                description: `Agendado por MIIA para ${contactName}. ${hint || ''}`.trim(),
                uid: targetUid,
                timezone: ownerTz,
                eventMode: eventMode,
                location: eventMode === 'presencial' ? (ubicacion || '') : '',
                phoneNumber: (eventMode === 'telefono' || eventMode === 'telefónico') ? (ubicacion || contacto) : '',
                reminderMinutes: 10
              });
              calendarOk = true;
              meetLink = calResult.meetLink || null;
              var mlCalEventId = calResult.eventId || null;
              console.log(`[AGENDA] 📅 Google Calendar OK para uid=${targetUid}: "${razon}" el ${fecha} modo=${eventMode} calEventId=${mlCalEventId}${meetLink ? ` meet=${meetLink}` : ''}`);
            }
          } catch (calErr) {
            console.warn(`[AGENDA] ⚠️ Google Calendar no disponible para uid=${targetUid}: ${calErr.message}. Solo Firestore.`);
          }
        }

        // ═══ PASO 2: Guardar en Firestore (SIEMPRE, Calendar o no) ═══
        await saveEvent(targetUid, {
          contactPhone: resolvedPhone,
          contactName,
          scheduledFor: fecha,
          reason: razon,
          promptHint: hint || '',
          eventMode,
          meetLink,
          calendarSynced: calendarOk,
          calendarEventId: mlCalEventId || null,
          status: 'pending',
          searchBefore: (razon || '').toLowerCase().includes('deporte') || (razon || '').toLowerCase().includes('partido'),
          createdAt: new Date().toISOString(),
          source: `auto_detected_${ctx.role}`
        });
        console.log(`[AGENDA] 📅 Evento agendado para uid=${targetUid}: ${contacto} el ${fecha} — ${razon} (calendar=${calendarOk})`);
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
  let cleaned = aiMessage
    .replace(/\[ENVIAR_CORREO_A_MAESTRO:[^\]]*\]/g, '')
    .replace(/\[GENERAR_COTIZACION(?:_PDF)?(?::[^\]]*)?\]/g, '')
    .replace(/\[CONSULTAR_AGENDA\]/g, '')
    .replace(/\[CANCELAR_EVENTO:[^\]]*\]/g, '')
    .replace(/\[ELIMINAR_EVENTO:[^\]]*\]/g, '')  // Alias inventado por IA → strip
    .replace(/\[MOVER_EVENTO:[^\]]*\]/g, '')
    .replace(/\[PROPONER_HORARIO(?::\d+)?\]/g, '')
    .replace(/\[AGENDAR_EVENTO:[^\]]*\]/g, '')
    .replace(/\[APRENDIZAJE_(?:NEGOCIO|PERSONAL|DUDOSO|PENDIENTE):[^\]]*\]/g, '')
    .replace(/\[GUARDAR_(?:APRENDIZAJE|NOTA):[^\]]*\]/g, '')
    .replace(/\[LEAD_QUIERE_COMPRAR\]/g, '')
    .replace(/\[MSG_SPLIT\]/g, '')
    .replace(/\[ENVIAR_CORREO:[^\]]*\]/g, '')
    .replace(/\[HARTAZGO_CONFIRMADO:[^\]]*\]/g, '')
    .replace(/\[SILENCIAR_LEAD:[^\]]*\]/g, '');

  // ═══ UNIVERSAL TAG STRIPPER — NUNCA mostrar tags crudos al usuario ═══
  // Atrapa CUALQUIER tag con formato [ALGO_ALGO:...] o [ALGO_ALGO] que no fue procesado
  // Esto es la última línea de defensa: si la IA inventa un tag que no existe,
  // se elimina silenciosamente en vez de mostrarse al usuario
  const residualTags = cleaned.match(/\[[A-Z][A-Z_]+(?::[^\]]+)?\]/g);
  if (residualTags) {
    for (const tag of residualTags) {
      console.warn(`[CLEAN_TAGS] ⚠️ Tag residual eliminado (no procesado): ${tag.substring(0, 80)}`);
      cleaned = cleaned.replace(tag, '');
    }
  }

  return cleaned.trim();
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
  detectMiiaTrigger,
  detectChauMiiaTrigger,

  // Funciones puras — horarios y geografía
  isWithinScheduleConfig,
  getCountryFromPhone,
  getTimezoneForCountry,
  getCountryContext,
  getLangFromCountry,       // T40 multilang Capa A
  buildLangInstruction,     // T40 multilang Capa A
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
