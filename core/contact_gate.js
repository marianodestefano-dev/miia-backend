'use strict';

/**
 * CONTACT GATE v1.0 — Decide si MIIA responde o permanece invisible
 *
 * REGLA ABSOLUTA: MIIA NO EXISTE hasta que la invoquen o detecte keywords.
 *
 * Cascada de decisión:
 *   1. Self-chat del owner → SIEMPRE responder
 *   2. Grupo de WhatsApp (@g.us) → BLOQUEADO SIEMPRE
 *   3. contact_index existe con type 'ignore' → BLOQUEADO SIEMPRE
 *   4. Familia/equipo → SOLO con trigger "Hola MIIA"
 *   5. Lead conocido (ya clasificado) → responder
 *   6. Desconocido con keywords del negocio → clasificar como lead, responder
 *   7. Desconocido sin keywords → BLOQUEADO + notificar al owner
 */

// ═══════════════════════════════════════════════════════════
// BLACKLIST: Palabras que NUNCA pueden ser keywords de negocio
// ═══════════════════════════════════════════════════════════
const FORBIDDEN_KEYWORDS = new Set([
  // Saludos universales
  'hola', 'hey', 'hi', 'hello', 'buenas', 'buen dia', 'buenos dias',
  'buenas tardes', 'buenas noches', 'que tal', 'como estas',
  'como andas', 'como va', 'que onda', 'que haces',
  'que hacen', 'como les va', 'como te va',
  // Despedidas
  'chau', 'adios', 'nos vemos', 'hasta luego', 'bye', 'hasta manana',
  'nos hablamos', 'que descanses',
  // Cortesías
  'gracias', 'por favor', 'perdon', 'disculpa', 'dale', 'listo',
  'ok', 'si', 'no', 'bueno', 'perfecto', 'claro', 'ya', 'vale',
  'de nada', 'con gusto', 'a la orden',
  // Preguntas genéricas
  'quien sos', 'que es esto', 'me pasaron tu numero',
  'de donde sos', 'donde queda', 'como te llamas',
  'quien es', 'que haces', 'a que te dedicas',
  // Monosílabos y expresiones
  'ja', 'jaja', 'jajaja', 'jajajaja', 'ah', 'oh', 'uh', 'mmm',
  'ajam', 'aja', 'epa', 'upa', 'ey', 'oye',
  // Emojis/stickers (texto)
  'xd', 'lol', 'jeje', 'jejeje',
]);

/**
 * Normalizar texto para matching: minúsculas, sin tildes, sin puntuación extra
 */
function _normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // quitar tildes
    .replace(/[^\w\s]/g, ' ')          // puntuación → espacio
    .replace(/\s+/g, ' ')             // múltiples espacios → uno
    .trim();
}

/**
 * Verificar si una keyword es válida (no está en blacklist)
 *
 * @param {string} keyword - Keyword a verificar
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateKeyword(keyword) {
  const norm = _normalize(keyword);
  if (!norm || norm.length < 2) {
    return { valid: false, reason: 'La palabra clave debe tener al menos 2 caracteres.' };
  }
  if (norm.length > 50) {
    return { valid: false, reason: 'La palabra clave es demasiado larga (máx 50 caracteres).' };
  }
  if (FORBIDDEN_KEYWORDS.has(norm)) {
    return {
      valid: false,
      reason: `"${keyword}" es demasiado genérica. Usá palabras específicas de tu negocio.`
    };
  }
  // Verificar que no sea solo números
  if (/^\d+$/.test(norm)) {
    return { valid: false, reason: 'La palabra clave no puede ser solo números.' };
  }
  return { valid: true };
}

/**
 * Verificar si un mensaje contiene keywords de negocio del owner
 *
 * @param {string} messageBody - Mensaje del contacto
 * @param {string[]} businessKeywords - Keywords configuradas por el owner
 * @returns {{ matched: boolean, keyword?: string }}
 */
function matchesBusinessKeywords(messageBody, businessKeywords) {
  if (!messageBody || !businessKeywords || businessKeywords.length === 0) {
    return { matched: false };
  }

  const normBody = _normalize(messageBody);

  for (const kw of businessKeywords) {
    const normKw = _normalize(kw);
    if (!normKw) continue;
    // Verificar que no esté en blacklist (safety check)
    if (FORBIDDEN_KEYWORDS.has(normKw)) continue;

    // Match por palabra completa o frase
    // "me interesa" debe matchear en "hola me interesa el servicio"
    if (normBody.includes(normKw)) {
      return { matched: true, keyword: kw };
    }
  }

  return { matched: false };
}

/**
 * DECISIÓN PRINCIPAL: ¿MIIA responde o no?
 *
 * @param {object} opts
 * @param {boolean} opts.isSelfChat - Es self-chat del owner
 * @param {boolean} opts.isGroup - Es grupo de WhatsApp (@g.us)
 * @param {string} opts.contactType - Tipo del contacto: 'owner'|'familia'|'equipo'|'lead'|'group'|'ignore'|null
 * @param {boolean} opts.miiaActive - Si MIIA está activa para este contacto (trigger previo)
 * @param {boolean} opts.isHolaMiia - Si el mensaje contiene "Hola MIIA"
 * @param {boolean} opts.isChauMiia - Si el mensaje contiene "Chau MIIA"
 * @param {boolean} opts.isInvocation - Si el mensaje es una invocación de MIIA ("MIIA estás?", "MIIA ven")
 * @param {boolean} opts.isMiiaInvoked - Si MIIA está actualmente invocada en este chat (3-way mode)
 * @param {string} opts.messageBody - Cuerpo del mensaje
 * @param {string[]} opts.businessKeywords - Keywords del negocio del owner
 * @param {string} opts.basePhone - Teléfono base del contacto
 *
 * @returns {{
 *   respond: boolean,
 *   reason: string,
 *   action?: 'notify_owner'|'farewell'|'invocation'|'invocation_farewell'|'none',
 *   matchedKeyword?: string
 * }}
 */
function shouldMiiaRespond(opts) {
  const {
    isSelfChat, isGroup, contactType, miiaActive,
    isHolaMiia, isChauMiia, isInvocation, isMiiaInvoked,
    messageBody, businessKeywords, basePhone
  } = opts;

  // ═══ PASO 1: Self-chat → SIEMPRE responder ═══
  if (isSelfChat) {
    return { respond: true, reason: 'self-chat', action: 'none' };
  }

  // ═══ PASO 2: Grupos → BLOQUEADO SIEMPRE ═══
  if (isGroup) {
    return { respond: false, reason: 'group_blocked', action: 'none' };
  }

  // ═══ PASO 3: Contacto marcado como 'ignore' → BLOQUEADO ═══
  if (contactType === 'ignore') {
    return { respond: false, reason: 'contact_ignored', action: 'none' };
  }

  // ═══ PASO 3b: MIIA INVOCADA (3-way mode) — Tiene prioridad ═══
  // Si MIIA fue invocada en un chat ("MIIA estás?"), responde a todo hasta que la despidan
  if (isInvocation) {
    console.log(`[CONTACT-GATE] 🎤 Invocación de MIIA detectada por ${basePhone}`);
    return { respond: true, reason: 'invocation', action: 'invocation' };
  }

  if (isMiiaInvoked) {
    // MIIA está activa en modo invocado — despedida especial
    if (isChauMiia) {
      console.log(`[CONTACT-GATE] 👋 Despedida de MIIA invocada por ${basePhone}`);
      return { respond: true, reason: 'invocation_farewell', action: 'invocation_farewell' };
    }
    // Cualquier mensaje mientras MIIA está invocada → responder (dentro de scope)
    return { respond: true, reason: 'miia_invoked', action: 'none' };
  }

  // ═══ PASO 3c: "Chau MIIA" → despedirse y desactivar ═══
  if (isChauMiia) {
    return { respond: true, reason: 'farewell', action: 'farewell' };
  }

  // ═══ PASO 4: Familia/equipo → SOLO con trigger ═══
  if (contactType === 'familia' || contactType === 'equipo') {
    if (miiaActive || isHolaMiia) {
      return { respond: true, reason: `${contactType}_triggered`, action: 'none' };
    }
    return { respond: false, reason: `${contactType}_no_trigger`, action: 'none' };
  }

  // ═══ PASO 5: Lead conocido (ya clasificado) → responder ═══
  if (contactType === 'lead') {
    // Lead ya fue clasificado previamente por keywords — responder
    return { respond: true, reason: 'known_lead', action: 'none' };
  }

  // ═══ PASO 6: Grupo dinámico con autoRespond ═══
  if (contactType === 'group') {
    if (miiaActive || isHolaMiia) {
      return { respond: true, reason: 'group_triggered', action: 'none' };
    }
    return { respond: false, reason: 'group_no_trigger', action: 'none' };
  }

  // ═══ PASO 7: Desconocido → verificar keywords de negocio ═══
  const kwMatch = matchesBusinessKeywords(messageBody, businessKeywords);
  if (kwMatch.matched) {
    console.log(`[CONTACT-GATE] ✅ Keyword match: "${kwMatch.keyword}" de ${basePhone}`);
    return {
      respond: true,
      reason: 'keyword_match',
      action: 'none',
      matchedKeyword: kwMatch.keyword
    };
  }

  // ═══ PASO 8: Sin keywords → BLOQUEADO + notificar al owner ═══
  console.log(`[CONTACT-GATE] 🚫 ${basePhone} sin keyword match. MIIA no existe. Notificando al owner.`);
  return {
    respond: false,
    reason: 'no_keyword_match',
    action: 'notify_owner'
  };
}

/**
 * Generar mensaje de notificación al owner cuando un desconocido escribe sin keywords
 *
 * @param {string} basePhone - Número del contacto
 * @param {string} messageBody - Lo que escribió
 * @returns {string} Mensaje para el self-chat del owner
 */
function buildUnknownContactAlert(basePhone, messageBody, pushName) {
  const preview = (messageBody || '').substring(0, 200);
  const nameLine = pushName ? `Nombre: *${pushName}*\n` : '';
  return `📱 *Alguien te escribió*\n\n` +
    `${nameLine}` +
    `Número: +${basePhone}\n` +
    `Mensaje: "${preview}"\n\n` +
    `No respondí porque no detecté palabras de tu negocio.\n\n` +
    `¿Quién es? Respondé:\n` +
    `• *amigo* → lo agrego a amigos\n` +
    `• *familia* → lo agrego a familia\n` +
    `• *lead* → lo agrego como lead de tu negocio\n` +
    `• *respondele* → le escribo presentándome\n` +
    `• *ignorar* → no le respondo nunca más`;
}

/**
 * Obtener keywords de negocio del owner desde sus businesses
 *
 * @param {object} ctx - Contexto del tenant
 * @returns {string[]} Lista de keywords de todos los negocios del owner
 */
function getOwnerBusinessKeywords(ctx) {
  const keywords = [];

  // Keywords configuradas en keywordsSet (legacy, admin flow)
  if (ctx.keywordsSet && Array.isArray(ctx.keywordsSet)) {
    for (const kw of ctx.keywordsSet) {
      if (typeof kw === 'string') keywords.push(kw);
      else if (kw && kw.keyword) keywords.push(kw.keyword);
    }
  }

  // Keywords de contact_rules de cada negocio
  if (ctx.businesses && Array.isArray(ctx.businesses)) {
    for (const biz of ctx.businesses) {
      if (biz.contact_rules && biz.contact_rules.lead_keywords) {
        for (const kw of biz.contact_rules.lead_keywords) {
          if (!keywords.includes(kw)) keywords.push(kw);
        }
      }
    }
  }

  // Keywords del takeoverKeywords (hardcoded para admin legacy)
  // Estos se mantienen para backward compatibility con server.js
  if (ctx.takeoverKeywords && Array.isArray(ctx.takeoverKeywords)) {
    for (const kw of ctx.takeoverKeywords) {
      if (!keywords.includes(kw)) keywords.push(kw);
    }
  }

  return keywords;
}

module.exports = {
  FORBIDDEN_KEYWORDS,
  validateKeyword,
  matchesBusinessKeywords,
  shouldMiiaRespond,
  buildUnknownContactAlert,
  getOwnerBusinessKeywords,
  _normalize, // exported for testing
};
