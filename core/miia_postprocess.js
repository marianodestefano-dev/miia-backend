'use strict';

const { attemptAutoRepair } = require('./integrity_engine');

/**
 * MIIA POST-PROCESS v1.1 — Auditoría de respuesta ANTES de enviar al usuario
 * v1.1: Integra auto-repair del Integrity Engine (Capa 2)
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
    requiredTag: /\[AGENDAR_EVENTO:|\[SOLICITAR_TURNO:/ },
  { phrases: [/ya (?:le |te )?(?:mandé|envié).*(?:mail|correo|email)/i, /listo.*(?:mail|correo|email)/i, /te.*(?:envié|mandé).*correo/i],
    requiredTag: /\[ENVIAR_CORREO:/ },
  { phrases: [/ya le avisé/i, /ya le dije/i, /listo.*le (?:avisé|dije)/i],
    requiredTag: /\[MENSAJE_PARA_OWNER:|DILE_A_/ },
  { phrases: [/ya.*te.*recordar/i, /anotado.*te.*recuerdo/i, /listo.*recordatorio/i],
    requiredTag: /\[RECORDAR_(?:CONTACTO|OWNER):|\[AGENDAR_EVENTO:/ },
  { phrases: [/ya.*te.*(?:mandé|envié).*cotizaci[oó]n/i, /listo.*cotizaci[oó]n/i],
    requiredTag: /\[GENERAR_COTIZACION_PDF:/ },
  // CANCELAR_EVENTO: "ya eliminé/cancelé/borré" sin tag
  { phrases: [/ya (?:lo |la |te )?(?:eliminé|cancelé|borré|quité)/i, /listo.*(?:eliminé|cancelé|borré)/i, /(?:cancelad[oa]|eliminad[oa]).*agenda/i],
    requiredTag: /\[CANCELAR_EVENTO:/ },
  // MOVER_EVENTO: "ya lo moví/cambié de hora" sin tag
  { phrases: [/ya (?:lo |la |te )?(?:moví|cambié|pasé).*(?:hora|horario|fecha|día)/i, /listo.*(?:moví|cambié|pasé)/i],
    requiredTag: /\[MOVER_EVENTO:/ },
  // RESPONDELE: "ya le respondí/dije/escribí/mandé" sin tag
  { phrases: [/ya le (?:respondí|dije|escribí|mandé|contesté|avisé)/i, /listo.*le (?:respondí|dije|escribí|mandé)/i],
    requiredTag: /\[RESPONDELE:|\[MENSAJE_PARA_OWNER:/ },
];

// Frases que exponen mecánica interna de MIIA (PELIGROSO con leads)
const INTERNAL_MECHANICS_PATTERNS = [
  /\bel backend\b/i,
  /\bel sistema (?:emite|procesa|intercepta|genera|detecta|clasifica)\b/i,
  /\btags? del sistema\b/i,
  /\btags? intern(?:os?|as?)\b/i,
  /\bel motor de IA\b/i,
  /\bel servidor\b/i,
  /\bel procesamiento\b/i,
  /\bfirestore\b/i,
  /\bbaileys\b/i,
  /\bla API\b/i,
  /\bel prompt\b/i,
  /\bel cron\b/i,
  /\bel pipeline\b/i,
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
 * v1.1: Intenta auto-repair antes de vetar (Capa 2 del Integrity Engine)
 */
function auditPromesa(aiMessage, opts = {}) {
  const { contactPhone, contactName } = opts;

  for (const rule of ACTION_CONFIRMATIONS) {
    const confirmsAction = rule.phrases.some(p => p.test(aiMessage));
    if (confirmsAction) {
      const hasTag = rule.requiredTag.test(aiMessage);
      if (!hasTag) {
        const matchedPhrase = rule.phrases.find(p => p.test(aiMessage));
        const actionType = rule.requiredTag.source.includes('AGENDAR') ? 'agendar'
          : rule.requiredTag.source.includes('CORREO') ? 'email'
          : rule.requiredTag.source.includes('CANCELAR') ? 'cancelar'
          : rule.requiredTag.source.includes('MOVER') ? 'mover' : 'otro';

        // CAPA 2: Intentar auto-repair antes de vetar
        const repairedTag = attemptAutoRepair(aiMessage, actionType, contactPhone, contactName);
        if (repairedTag) {
          console.log(`[POSTPROCESS:PROMESA] 🔧 Auto-repair exitoso: ${repairedTag}`);
          return {
            pass: true,
            action: 'repair',
            auditor: 'promesa',
            repairedTag,
            reason: `Auto-repair: faltaba tag, reconstruido como ${repairedTag}`,
          };
        }

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
function auditIdentidad(aiMessage, chatType, revealAsAI) {
  // Con familia, MIIA puede admitir que es IA (ellos saben)
  // Con miia_lead, MIIA SE VENDE A SÍ MISMA — puede decir que es IA, es su producto
  // Si el owner configuró revealAsAI=true, también puede revelar
  if (chatType === 'selfchat' || chatType === 'self' || chatType === 'family' || chatType === 'miia_lead' || chatType === 'miia_client' || chatType === 'team' || revealAsAI) return { pass: true, action: 'ok', auditor: 'identidad' };

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
function auditTono(aiMessage, contactName, chatType) {
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

  // Detectar respuesta excesivamente larga
  // miia_lead tiene más margen (MIIA se explayea explicando sus funciones)
  // No aplica si contiene tags del sistema (cotización, agenda, etc.)
  const hasTags = /\[(GENERAR_COTIZACION|AGENDAR_EVENTO|ENVIAR_CORREO|CONSULTAR_AGENDA)/.test(aiMessage);
  const maxChars = chatType === 'miia_lead' ? 1200 : 800;
  if (!hasTags && aiMessage.length > maxChars) {
    issues.push(`Respuesta muy larga: ${aiMessage.length} chars (máx recomendado: ${maxChars})`);
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

  // Lead emitiendo APRENDIZAJE_NEGOCIO → STRIP (prohibido) — aplica a lead Y miia_lead
  if ((chatType === 'lead' || chatType === 'miia_lead') && /\[APRENDIZAJE_NEGOCIO:/.test(aiMessage)) {
    issues.push({
      reason: 'Lead intentó emitir APRENDIZAJE_NEGOCIO — PROHIBIDO',
      action: 'strip',
      stripPattern: /\[APRENDIZAJE_NEGOCIO:[^\]]*\]/g,
    });
  }

  // Lead emitiendo APRENDIZAJE_PERSONAL → STRIP (datos del owner, no del lead) — aplica a lead Y miia_lead
  if ((chatType === 'lead' || chatType === 'miia_lead') && /\[APRENDIZAJE_PERSONAL:/.test(aiMessage)) {
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

  // Lead emitiendo AGENDAR_EVENTO en vez de SOLICITAR_TURNO → STRIP y advertir — aplica a lead Y miia_lead
  if ((chatType === 'lead' || chatType === 'miia_lead') && /\[AGENDAR_EVENTO:/.test(aiMessage)) {
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
 * MIIA MECÁNICA INTERNA — ¿Expone detalles técnicos al usuario?
 * Peligroso con leads: revela que es IA/sistema automatizado
 */
function auditMecanicaInterna(aiMessage, chatType) {
  // Solo importa con leads y contactos externos — familia/owner saben
  if (chatType === 'selfchat' || chatType === 'family' || chatType === 'equipo') {
    return { pass: true, action: 'ok', auditor: 'mecanica' };
  }

  // miia_lead: MIIA se vende a sí misma, puede decir "el sistema", "la API", "IA"
  // Pero NUNCA debe exponer mecánica interna REAL (Firestore, Baileys, backend, prompts, cron, pipeline, tags)
  const patternsToCheck = chatType === 'miia_lead'
    ? INTERNAL_MECHANICS_PATTERNS.filter(p => /firestore|baileys|backend|prompt|cron|pipeline|tags/.test(p.source))
    : INTERNAL_MECHANICS_PATTERNS;

  for (const pattern of patternsToCheck) {
    if (pattern.test(aiMessage)) {
      return {
        pass: false,
        reason: `MECÁNICA INTERNA EXPUESTA: Respuesta contiene "${aiMessage.match(pattern)?.[0]}" — revela sistema automatizado`,
        action: 'regenerate',
        auditor: 'mecanica',
      };
    }
  }
  return { pass: true, action: 'ok', auditor: 'mecanica' };
}

/**
 * MIIA VERDAD — ¿Contiene afirmaciones fácticas sin respaldo?
 * NOTA: Este es el único auditor que PODRÍA necesitar IA en casos sospechosos.
 * Por ahora, solo detecta patrones regex. En futuro, escalar a IA verify.
 */
function auditVerdad(aiMessage, hasSearchData, chatType) {
  const issues = [];

  // Self-chat del owner y familia: no vetar por datos deportivos/clima
  // El owner puede hablar de deportes libremente, Gemini tiene contexto directo
  const isTrustedChat = ['self', 'selfchat', 'family', 'team', 'equipo', 'miia_lead', 'miia_client'].includes(chatType);

  // Si NO hay datos de búsqueda pero la respuesta menciona scores/resultados deportivos
  if (!hasSearchData && !isTrustedChat) {
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

// ═══════════════════════════════════════════════════════════════════
// AUDITOR IA — Gemini Flash verifica CADA respuesta (100% coverage)
// ═══════════════════════════════════════════════════════════════════

/**
 * Prompt para el auditor IA — Gemini Flash verifica la respuesta
 * Diseñado para ser ultra-conciso (~300 tokens input) y rápido (~200ms)
 */
function buildAuditPrompt(aiMessage, userMessage, chatType, contactName, hasSearchData) {
  return `Sos un auditor de calidad. Analizá esta respuesta de una IA que se hace pasar por humana en WhatsApp.

CONTEXTO:
- Tipo de chat: ${chatType} (${chatType === 'lead' ? 'con cliente potencial — JAMÁS revelar que es IA' : chatType === 'selfchat' ? 'con su creador — puede ser informal' : 'con familiar/equipo — saben que es IA'})
- Contacto: ${contactName || 'desconocido'}
- Tiene datos de búsqueda real: ${hasSearchData ? 'SÍ' : 'NO'}
- Mensaje del usuario: "${(userMessage || '').substring(0, 200)}"

RESPUESTA A AUDITAR:
"${aiMessage.substring(0, 1500)}"

VERIFICAR (responder SOLO con JSON, sin markdown):
1. ¿Confirma acciones sin tag del sistema? (ej: "ya te agendé" sin [AGENDAR_EVENTO:])
2. ¿Se delata como IA? (solo importa si chatType=lead)
3. ¿Inventa datos fácticos sin búsqueda real? (scores, clima, noticias, fechas de eventos)
4. ¿Promete enviar archivos/videos que no puede?
5. ¿Usa muletillas robóticas? ("Perfecto", "¿Hay algo más?", "No dudes en escribirme")
6. ¿Tono inapropiado para el contexto?

{"pass":true/false,"issues":["descripción corta"],"severity":"ok"|"minor"|"major"|"critical"}
- ok: todo bien
- minor: muletillas o tono (no bloquear, solo logear)
- major: promesa rota o dato inventado (regenerar)
- critical: se delata como IA con lead (veto inmediato)`;
}

/**
 * Parsear respuesta del auditor IA
 */
function parseAuditResponse(text) {
  try {
    // Extraer JSON de la respuesta (puede venir con texto extra)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { pass: true, issues: [], severity: 'ok' };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      pass: !!parsed.pass,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      severity: parsed.severity || 'ok',
    };
  } catch (e) {
    console.warn(`[POSTPROCESS:AI] ⚠️ No se pudo parsear respuesta del auditor: ${e.message}`);
    return { pass: true, issues: [], severity: 'ok' }; // Fail-open: si no puede parsear, dejar pasar
  }
}

// ═══════════════════════════════════════════════════════════════════
// ORQUESTADOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Ejecuta TODOS los auditores (regex) y retorna resultado consolidado.
 * FASE 1: Solo regex, 0 IA.
 *
 * @param {string} aiMessage - Respuesta de la IA (con tags incluidos)
 * @param {object} opts
 * @param {string} opts.chatType - 'selfchat'|'lead'|'family'|'equipo'|'group'
 * @param {string} opts.contactName - Nombre del contacto
 * @param {boolean} opts.hasSearchData - Si la respuesta incluye datos de búsqueda real
 * @returns {{ approved: boolean, finalMessage: string, audits: object[], action: string }}
 */
function runPostprocess(aiMessage, opts = {}) {
  const { chatType = 'selfchat', contactName = '', hasSearchData = false, revealAsAI = false } = opts;
  const audits = [];
  let finalMessage = aiMessage;
  let worstAction = 'ok'; // ok < strip < regenerate < veto

  const actionSeverity = { ok: 0, strip: 1, regenerate: 2, veto: 3 };

  // Ejecutar todos los auditores regex
  const results = [
    auditPromesa(finalMessage, { contactPhone: opts.contactPhone, contactName }),
    auditIdentidad(finalMessage, chatType, revealAsAI),
    auditMecanicaInterna(finalMessage, chatType),
    auditTono(finalMessage, contactName, chatType),
    auditAprendizaje(finalMessage, chatType),
    auditVerdad(finalMessage, hasSearchData, chatType),
  ];

  let repairedTags = [];

  for (const result of results) {
    audits.push(result);

    // Auto-repair: inyectar tag reconstruido
    if (result.action === 'repair' && result.repairedTag) {
      finalMessage = result.repairedTag + ' ' + finalMessage;
      repairedTags.push(result.repairedTag);
      console.log(`[POSTPROCESS:REPAIR] 🔧 Tag inyectado: ${result.repairedTag}`);
      continue; // No es falla — fue reparado
    }

    if (!result.pass) {
      console.warn(`[POSTPROCESS:${result.auditor.toUpperCase()}] ⚠️ ${result.reason}`);

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
    repairedTags,
    vetoReason: worstAction === 'veto'
      ? audits.filter(a => a.action === 'veto').map(a => a.reason).join('; ')
      : null,
    regenerateHint: worstAction === 'regenerate'
      ? audits.filter(a => a.action === 'regenerate').map(a => a.reason).join('; ')
      : null,
  };
}

/**
 * FASE 2: Auditoría IA con Gemini Flash — ejecutar SIEMPRE después del regex.
 * Atrapa lo que el regex no puede: confirmaciones implícitas, alucinaciones sutiles,
 * delaciones indirectas, tono inapropiado contextual.
 *
 * @param {string} aiMessage - Respuesta ya filtrada por regex
 * @param {object} opts
 * @param {string} opts.chatType
 * @param {string} opts.contactName
 * @param {boolean} opts.hasSearchData
 * @param {string} opts.userMessage - Mensaje original del usuario
 * @param {Function} opts.generateAI - Función para llamar a Gemini (inyectada desde server.js)
 * @returns {Promise<{approved: boolean, issues: string[], severity: string, action: string}>}
 */
async function runAIAudit(aiMessage, opts = {}) {
  const { chatType, contactName, hasSearchData, userMessage, generateAI } = opts;

  if (!generateAI) {
    console.warn('[POSTPROCESS:AI] ⚠️ generateAI no inyectado — saltando auditoría IA');
    return { approved: true, issues: [], severity: 'ok', action: 'ok' };
  }

  try {
    const prompt = buildAuditPrompt(aiMessage, userMessage, chatType, contactName, hasSearchData);
    const response = await generateAI(prompt);
    const result = parseAuditResponse(response);

    if (!result.pass) {
      console.warn(`[POSTPROCESS:AI] 🤖 Auditor IA detectó: [${result.severity}] ${result.issues.join('; ')}`);

      // Self-chat/familia con search activo: NO regenerar por datos fácticos/deportivos
      // El owner preguntó directamente y Gemini buscó — confiar en los datos
      const isTrustedWithSearch = hasSearchData && ['selfchat', 'self', 'family', 'team', 'equipo'].includes(chatType);
      if (isTrustedWithSearch && result.severity === 'major') {
        const onlyFactualIssues = result.issues.every(i =>
          /(?:dato|fáctic|búsqueda|deport|score|clima|noticias|fecha|evento|inventa)/i.test(i)
        );
        if (onlyFactualIssues) {
          console.log(`[POSTPROCESS:AI] ✅ Override: self-chat + search activo → datos fácticos permitidos (no regenerar)`);
          result.pass = true;
          result.severity = 'minor';
        }
      }
    } else {
      console.log(`[POSTPROCESS:AI] ✅ Auditor IA: OK`);
    }

    // Mapear severity a action
    const severityToAction = {
      ok: 'ok',
      minor: 'ok',        // Solo logear, no bloquear
      major: 'regenerate', // Regenerar respuesta
      critical: 'veto',   // Veto inmediato
    };

    return {
      approved: result.severity === 'ok' || result.severity === 'minor',
      issues: result.issues,
      severity: result.severity,
      action: severityToAction[result.severity] || 'ok',
    };
  } catch (err) {
    // Fail-open: si el auditor IA falla, dejar pasar (ya pasó regex)
    console.error(`[POSTPROCESS:AI] ❌ Error en auditoría IA (fail-open): ${err.message}`);
    return { approved: true, issues: [], severity: 'ok', action: 'ok' };
  }
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
  if (/MECÁNICA/.test(vetoReason)) {
    // MIIA expuso mecánica interna — regenerar con tono humano
    return 'Dejame verificar eso y te cuento.';
  }
  return 'Dame un momento, estoy procesando tu mensaje.';
}

module.exports = {
  runPostprocess,
  runAIAudit,
  getFallbackMessage,
  buildAuditPrompt,
  parseAuditResponse,
  // Exportar individuales para testing
  auditPromesa,
  auditIdentidad,
  auditMecanicaInterna,
  auditTono,
  auditAprendizaje,
  auditVerdad,
};
