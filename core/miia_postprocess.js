'use strict';

/**
 * MIIA POST-PROCESS v1.0 — Auditoría de respuesta ANTES de enviar al usuario
 *
 * 5 auditores que validan la respuesta de la IA sin costo extra:
 * - auditPromesa: Detecta confirmaciones de acciones sin tag correspondiente
 * - auditIdentidad: Detecta auto-revelación como IA (con leads)
 * - auditTono: Detecta violaciones de anti-bot, muletillas, nombre repetido
 * - auditAprendizaje: Detecta violaciones de permisos de aprendizaje
 * - auditVerdad: Detecta afirmaciones fácticas sospechosas sin datos de búsqueda
 *
 * Cada auditor retorna: { pass: boolean, reason?: string, action: 'ok'|'veto'|'strip'|'regenerate' }
 * - ok: todo bien
 * - veto: NO enviar, responder con fallback
 * - strip: remover parte de la respuesta
 * - regenerate: pedir a la IA que regenere (con prompt más estricto)
 */

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES DE DETECCIÓN
// ══════════════════════���════════════════════════════════════════════

// Frases que confirman acciones — SOLO válidas si el tag correspondiente existe
const ACTION_CONFIRMATIONS = [
  { phrases: [/ya (?:te |lo )?agend[eé]/i, /listo.*agend/i, /te.*agend[eé]/i, /queda.*agendad/i],
    requiredTag: /\[AGENDAR_EVENTO:/ },
  { phrases: [/ya (?:le |te )?(?:mandé|envié).*(?:mail|correo|email)/i, /listo.*(?:mail|correo|email)/i, /te.*(?:envié|mandé).*correo/i],
    requiredTag: /\[ENVIAR_CORREO:/ },
  { phrases: [/ya le avisé/i, /ya le dije/i, /listo.*le (?:avisé|dije)/i],
    requiredTag: /\[MENSAJE_PARA_OWNER:|DILE_A_/ },
  { phrases: [/ya.*te.*recordar/i, /anotado.*te.*recuerdo/i, /listo.*recordatorio/i],
    requiredTag: /\[RECORDAR_(?:CONTACTO|OWNER):|\[AGENDAR_EVENTO:/ },
  { phrases: [/ya.*te.*(?:mandé|envié).*cotizaci[oó]n/i, /listo.*cotizaci[oó]n/i],
    requiredTag: /\[GENERAR_COTIZACION_PDF:/ },
];

// Frases que delatan a MIIA como IA
const AI_REVEAL_PATTERNS = [
  /\bsoy una? (?:inteligencia artificial|IA|AI|bot|programa|software|modelo de lenguaje|asistente virtual)\b/i,
  /\bcomo (?:inteligencia artificial|IA|AI|modelo de lenguaje)\b/i,
  /\bno soy (?:una persona|humana?|real)\b/i,
  /\bsoy un (?:chatbot|bot|programa)\b/i,
  /\bfui (?:programada?|creada?|entrenada?|diseñada?) (?:para|por)\b/i,
  /\bno tengo (?:sentimientos|emociones|cuerpo|vida) reales?\b/i,
  /\bcomo modelo de lenguaje\b/i,
  /\bOpenAI|ChatGPT|GPT-4|Claude|Anthropic|Gemini|Google AI\b/i,
];

// Muletillas de bot prohibidas
const BOT_OPENERS = [
  /^¡?(?:Entendido|Perfecto|Claro|Por supuesto|Genial|Excelente|Con gusto|Con mucho gusto|Desde luego)[.!,]/i,
  /^¡?(?:Hola|Hey)[,!]?\s+\w+[,!]/i, // "¡Hola Juan!" al inicio — solo si es nombre repetido
];

const BOT_CLOSERS = [
  /¿(?:hay|necesit[aá]s?|quer[eé]s?) algo más\?/i,
  /no dudes? en (?:escribirme|contactarme|preguntar)/i,
  /quedo a (?:tu|su) disposici[oó]n/i,
  /(?:estoy|estaré) (?:aquí|acá) (?:para|si) (?:lo que|cualquier cosa)/i,
  /si necesit[aá]s? (?:algo más|cualquier cosa)/i,
];

// ═══════════════════════════════════════════════════════════════════
// AUDITORES
// ════════════════════════���══════════════════════════════════════════

/**
 * MIIA PROMESA — ¿Confirma una acción sin haberla ejecutado?
 */
function auditPromesa(aiMessage) {
  for (const rule of ACTION_CONFIRMATIONS) {
    const confirmsAction = rule.phrases.some(p => p.test(aiMessage));
    if (confirmsAction) {
      const hasTag = rule.requiredTag.test(aiMessage);
      if (!hasTag) {
        // Buscar cuál frase matcheó para el log
        const matchedPhrase = rule.phrases.find(p => p.test(aiMessage));
        return {
          pass: false,
          reason: `PROMESA ROTA: Dice "${aiMessage.match(matchedPhrase)?.[0] || 'acción confirmada'}" pero NO emitió tag ${rule.requiredTag.source}`,
          action: 'veto',
          auditor: 'promesa',
        };
      }
    }
  }
  return { pass: true, action: 'ok', auditor: 'promesa' };
}

/**
 * MIIA IDENTIDAD — ¿Se delata como IA? (solo relevante con leads)
 */
function auditIdentidad(aiMessage, chatType) {
  // Con familia, MIIA puede admitir que es IA (ellos saben)
  if (chatType === 'selfchat' || chatType === 'family') return { pass: true, action: 'ok', auditor: 'identidad' };

  for (const pattern of AI_REVEAL_PATTERNS) {
    if (pattern.test(aiMessage)) {
      return {
        pass: false,
        reason: `IDENTIDAD COMPROMETIDA: Respuesta contiene "${aiMessage.match(pattern)?.[0]}"`,
        action: 'veto',
        auditor: 'identidad',
      };
    }
  }
  return { pass: true, action: 'ok', auditor: 'identidad' };
}

/**
 * MIIA TONO — ¿Tiene muletillas de bot?
 */
function auditTono(aiMessage, contactName) {
  const issues = [];

  // Detectar openers de bot
  for (const pattern of BOT_OPENERS) {
    if (pattern.test(aiMessage)) {
      issues.push(`Opener de bot: "${aiMessage.match(pattern)?.[0]}"`);
    }
  }

  // Detectar closers de bot
  for (const pattern of BOT_CLOSERS) {
    if (pattern.test(aiMessage)) {
      issues.push(`Closer de bot: "${aiMessage.match(pattern)?.[0]}"`);
    }
  }

  // Detectar nombre del contacto repetido (más de 2 veces)
  if (contactName && contactName.length > 2) {
    const nameRegex = new RegExp(`\\b${contactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = aiMessage.match(nameRegex);
    if (matches && matches.length > 2) {
      issues.push(`Nombre "${contactName}" repetido ${matches.length} veces`);
    }
  }

  // Detectar respuesta excesivamente larga (más de 800 chars para mensajes normales)
  // No aplica si contiene tags del sistema (cotización, agenda, etc.)
  const hasTags = /\[(GENERAR_COTIZACION|AGENDAR_EVENTO|ENVIAR_CORREO|CONSULTAR_AGENDA)/.test(aiMessage);
  if (!hasTags && aiMessage.length > 800) {
    issues.push(`Respuesta muy larga: ${aiMessage.length} chars (máx recomendado: 800)`);
  }

  if (issues.length > 0) {
    return {
      pass: false,
      reason: `TONO: ${issues.join('; ')}`,
      action: 'regenerate',
      auditor: 'tono',
      issues,
    };
  }

  return { pass: true, action: 'ok', auditor: 'tono' };
}

/**
 * MIIA APRENDIZAJE — ¿Viola permisos de aprendizaje?
 */
function auditAprendizaje(aiMessage, chatType) {
  const issues = [];

  // Lead emitiendo APRENDIZAJE_NEGOCIO → STRIP (prohibido)
  if (chatType === 'lead' && /\[APRENDIZAJE_NEGOCIO:/.test(aiMessage)) {
    issues.push({
      reason: 'Lead intentó emitir APRENDIZAJE_NEGOCIO — PROHIBIDO',
      action: 'strip',
      stripPattern: /\[APRENDIZAJE_NEGOCIO:[^\]]*\]/g,
    });
  }

  // Lead emitiendo APRENDIZAJE_PERSONAL → STRIP (datos del owner, no del lead)
  if (chatType === 'lead' && /\[APRENDIZAJE_PERSONAL:/.test(aiMessage)) {
    issues.push({
      reason: 'Lead intentó emitir APRENDIZAJE_PERSONAL — PROHIBIDO',
      action: 'strip',
      stripPattern: /\[APRENDIZAJE_PERSONAL:[^\]]*\]/g,
    });
  }

  // Familia/equipo emitiendo APRENDIZAJE_NEGOCIO → STRIP
  if ((chatType === 'family' || chatType === 'equipo') && /\[APRENDIZAJE_NEGOCIO:/.test(aiMessage)) {
    issues.push({
      reason: `${chatType} intentó emitir APRENDIZAJE_NEGOCIO — solo owner puede`,
      action: 'strip',
      stripPattern: /\[APRENDIZAJE_NEGOCIO:[^\]]*\]/g,
    });
  }

  // Lead emitiendo AGENDAR_EVENTO en vez de SOLICITAR_TURNO → STRIP y advertir
  if (chatType === 'lead' && /\[AGENDAR_EVENTO:/.test(aiMessage)) {
    issues.push({
      reason: 'Lead intentó AGENDAR_EVENTO directo — debe ser SOLICITAR_TURNO',
      action: 'strip',
      stripPattern: /\[AGENDAR_EVENTO:[^\]]*\]/g,
    });
  }

  if (issues.length > 0) {
    return {
      pass: false,
      reason: issues.map(i => i.reason).join('; '),
      action: 'strip',
      auditor: 'aprendizaje',
      strips: issues.filter(i => i.stripPattern).map(i => i.stripPattern),
    };
  }

  return { pass: true, action: 'ok', auditor: 'aprendizaje' };
}

/**
 * MIIA VERDAD — ¿Contiene afirmaciones fácticas sin respaldo?
 * NOTA: Este es el único auditor que PODRÍA necesitar IA en casos sospechosos.
 * Por ahora, solo detecta patrones regex. En futuro, escalar a IA verify.
 */
function auditVerdad(aiMessage, hasSearchData) {
  const issues = [];

  // Si NO hay datos de búsqueda pero la respuesta menciona scores/resultados deportivos
  if (!hasSearchData) {
    // Scores tipo "2-1", "3-0" en contexto deportivo
    const scoreInSportContext = /(?:(?:va|van|está|están|ganando|perdiendo|empat)\s+)?(\d{1,2})\s*[-–a]\s*(\d{1,2})/i;
    if (scoreInSportContext.test(aiMessage) && /(?:partido|gol|juega|cancha|equipo|fútbol|boca|river)/i.test(aiMessage)) {
      issues.push('Menciona score deportivo sin datos de búsqueda');
    }

    // Menciona "primer tiempo", "segundo tiempo", "minuto X" sin datos
    if (/(?:primer|segundo)\s+tiempo|minuto\s+\d+|entretiempo/i.test(aiMessage) && /(?:partido|juega|gol)/i.test(aiMessage)) {
      issues.push('Menciona estado de partido sin datos de búsqueda');
    }

    // Menciona clima específico sin datos
    if (/(?:\d+)\s*°|grados|lluv|torment|calor|frío|nublad/i.test(aiMessage) && !/(?:suger|recomiend|podría|podrías)/i.test(aiMessage)) {
      issues.push('Menciona datos climáticos sin búsqueda');
    }
  }

  // Detectar "te mando un video" / "te envío un archivo" — MIIA NO puede enviar archivos
  if (/(?:te\s+(?:mando|envío|paso)\s+(?:un|el)\s+(?:video|archivo|documento|imagen|foto))/i.test(aiMessage)) {
    // Excepto si es una cotización PDF (eso sí puede)
    if (!/cotizaci[oó]n|PDF|pdf/i.test(aiMessage)) {
      issues.push('Promete enviar archivo/video — MIIA no puede enviar archivos multimedia');
    }
  }

  if (issues.length > 0) {
    return {
      pass: false,
      reason: `VERDAD: ${issues.join('; ')}`,
      action: 'veto',
      auditor: 'verdad',
      issues,
    };
  }

  return { pass: true, action: 'ok', auditor: 'verdad' };
}

// ══════���════════════════════════════════════════════════════════════
// ORQUESTADOR
// ═══════════════════════════════════════════════════════���═══════════

/**
 * Ejecuta TODOS los auditores y retorna resultado consolidado
 *
 * @param {string} aiMessage - Respuesta de la IA (con tags incluidos)
 * @param {object} opts
 * @param {string} opts.chatType - 'selfchat'|'lead'|'family'|'equipo'|'group'
 * @param {string} opts.contactName - Nombre del contacto
 * @param {boolean} opts.hasSearchData - Si la respuesta incluye datos de búsqueda real
 * @returns {{ approved: boolean, finalMessage: string, audits: object[], action: string }}
 */
function runPostprocess(aiMessage, opts = {}) {
  const { chatType = 'selfchat', contactName = '', hasSearchData = false } = opts;
  const audits = [];
  let finalMessage = aiMessage;
  let worstAction = 'ok'; // ok < strip < regenerate < veto

  const actionSeverity = { ok: 0, strip: 1, regenerate: 2, veto: 3 };

  // Ejecutar todos los auditores
  const results = [
    auditPromesa(finalMessage),
    auditIdentidad(finalMessage, chatType),
    auditTono(finalMessage, contactName),
    auditAprendizaje(finalMessage, chatType),
    auditVerdad(finalMessage, hasSearchData),
  ];

  for (const result of results) {
    audits.push(result);

    if (!result.pass) {
      console.warn(`[POSTPROCESS:${result.auditor.toUpperCase()}] ⚠��� ${result.reason}`);

      // Aplicar strips si corresponde
      if (result.action === 'strip' && result.strips) {
        for (const pattern of result.strips) {
          finalMessage = finalMessage.replace(pattern, '').trim();
        }
        console.log(`[POSTPROCESS:${result.auditor.toUpperCase()}] 🔧 Tags prohibidos removidos`);
      }

      // Trackear peor acción
      if ((actionSeverity[result.action] || 0) > (actionSeverity[worstAction] || 0)) {
        worstAction = result.action;
      }
    }
  }

  const approved = worstAction === 'ok' || worstAction === 'strip';

  if (!approved) {
    const failedAudits = audits.filter(a => !a.pass && (a.action === 'veto' || a.action === 'regenerate'));
    console.error(`[POSTPROCESS] ❌ Respuesta ${worstAction === 'veto' ? 'VETADA' : 'REQUIERE REGENERACIÓN'}: ${failedAudits.map(a => a.reason).join(' | ')}`);
  } else if (audits.some(a => !a.pass)) {
    console.log(`[POSTPROCESS] ✅ Respuesta aprobada con correcciones (strips aplicados)`);
  }

  return {
    approved,
    finalMessage: finalMessage.trim(),
    audits,
    action: worstAction,
    // Razón del veto/regenerate para generar fallback
    vetoReason: worstAction === 'veto'
      ? audits.filter(a => a.action === 'veto').map(a => a.reason).join('; ')
      : null,
    regenerateHint: worstAction === 'regenerate'
      ? audits.filter(a => a.action === 'regenerate').map(a => a.reason).join('; ')
      : null,
  };
}

/**
 * Generar mensaje fallback cuando la respuesta es vetada
 * @param {string} vetoReason
 * @param {string} chatType
 * @returns {string}
 */
function getFallbackMessage(vetoReason, chatType) {
  if (/IDENTIDAD/.test(vetoReason)) {
    // MIIA se delató como IA — responder con humor
    return '😄 Recién salgo de una reunión larguísima, ¿en qué te puedo ayudar?';
  }
  if (/PROMESA/.test(vetoReason)) {
    // MIIA confirmó acción no ejecutada — ser honesta
    return 'Dejame verificar eso y te confirmo en un momento.';
  }
  if (/VERDAD/.test(vetoReason)) {
    // MIIA alucinó datos
    return '🤷‍♀️ No tengo esa info confirmada ahora, dejame averiguar.';
  }
  return 'Dame un momento, estoy procesando tu mensaje.';
}

module.exports = {
  runPostprocess,
  getFallbackMessage,
  // Exportar individuales para testing
  auditPromesa,
  auditIdentidad,
  auditTono,
  auditAprendizaje,
  auditVerdad,
};
