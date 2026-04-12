/**
 * MIIA Biological Clock — Motor de seguimiento proactivo inteligente.
 *
 * Detecta leads en diferentes estados y genera seguimientos contextuales:
 * - "después veo" → retomar en 24h
 * - pidió cotización → verificar en 48h si la revisó
 * - dio referido → agradecer y preguntar por el referido
 * - no respondió → secuencia gradual (1d, 3d, 7d)
 * - compró → agradecer y ofrecer soporte
 *
 * Respeta: horario 8-19, no domingos, no festivos del país.
 * Configurable por owner via scheduleConfig.
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

'use strict';

// ═══ SEÑALES DE ESTADO POR MENSAJE ═══
const LATER_SIGNALS = ['después', 'despues', 'luego', 'mañana', 'otro dia', 'otro día',
  'lo pienso', 'lo voy a pensar', 'déjame ver', 'dejame ver', 'ya te aviso', 'te aviso',
  'no ahora', 'más tarde', 'mas tarde', 'cuando pueda', 'en estos días', 'en estos dias'];

const QUOTE_SIGNALS = ['cotización', 'cotizacion', 'presupuesto', 'precio', 'cuánto cuesta',
  'cuanto cuesta', 'valor', 'tarifa', 'costo', 'plan', 'oferta'];

const REFERRAL_SIGNALS = ['te paso el número', 'te paso el numero', 'contacto de', 'te recomiendo',
  'habla con', 'escribile a', 'te doy el contacto', 'referido', 'conocido que'];

const INTEREST_SIGNALS = ['me interesa', 'quiero saber', 'cómo funciona', 'como funciona',
  'demo', 'prueba', 'quiero probar', 'cuéntame más', 'cuentame mas', 'información', 'informacion'];

const COLD_SIGNALS = ['no me interesa', 'no gracias', 'no necesito', 'estoy bien así',
  'no estoy interesado', 'deja de escribir', 'no me escribas', 'spam', 'bloquear'];

/**
 * Analiza el último mensaje del lead y determina su estado.
 * @param {string} lastUserMsg - Último mensaje del lead
 * @param {string} lastMiiaMsg - Última respuesta de MIIA
 * @param {object} metadata - conversationMetadata[phone]
 * @returns {object} { state, signal, suggestedDelay }
 */
function classifyLeadState(lastUserMsg, lastMiiaMsg, metadata = {}) {
  const msgLower = (lastUserMsg || '').toLowerCase();
  const miiaLower = (lastMiiaMsg || '').toLowerCase();

  // ¿Lead dijo "después/luego"?
  if (LATER_SIGNALS.some(s => msgLower.includes(s))) {
    return { state: 'postponed', signal: 'later', suggestedDelayHours: 24 };
  }

  // ¿Lead pidió cotización y MIIA la envió?
  if (QUOTE_SIGNALS.some(s => msgLower.includes(s)) ||
      miiaLower.includes('cotización') || miiaLower.includes('cotizacion') || miiaLower.includes('presupuesto')) {
    return { state: 'quote_sent', signal: 'quote', suggestedDelayHours: 48 };
  }

  // ¿Lead dio un referido?
  if (REFERRAL_SIGNALS.some(s => msgLower.includes(s))) {
    return { state: 'referral_given', signal: 'referral', suggestedDelayHours: 72 };
  }

  // ¿Lead mostró interés activo?
  if (INTEREST_SIGNALS.some(s => msgLower.includes(s))) {
    return { state: 'interested', signal: 'interest', suggestedDelayHours: 4 };
  }

  // ¿Lead está frío?
  if (COLD_SIGNALS.some(s => msgLower.includes(s))) {
    return { state: 'cold', signal: 'cold', suggestedDelayHours: Infinity };
  }

  // Default: sin respuesta al último mensaje de MIIA
  return { state: 'no_response', signal: 'silent', suggestedDelayHours: 24 };
}

/**
 * Genera el prompt de seguimiento según el estado del lead.
 */
function buildFollowupPrompt(leadState, firstName, lastUserMsg, lastMiiaMsg, followupCount, ownerProfile) {
  const bizName = ownerProfile?.businessName || 'el negocio';
  const maxChars = followupCount >= 2 ? 200 : 150;
  const isLastAttempt = followupCount >= 2;

  const baseRules = `Máximo 2 líneas, ${maxChars} chars. NO digas "seguimiento" ni "te escribo de nuevo". Sé natural, como un humano real. NO uses emojis excesivos (max 1). Lenguaje informal pero profesional.`;

  switch (leadState) {
    case 'postponed':
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. ${firstName ? `${firstName} te` : 'Un lead te'} dijo que lo pensaba/veía después. Retomá suave, sin presión. Ofrecé algo útil o preguntá si tuvo tiempo de pensarlo. Su último msg: "${(lastUserMsg || '').substring(0, 100)}". ${baseRules}`;

    case 'quote_sent':
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. Le mandaste cotización/presupuesto a ${firstName || 'un lead'} y no respondió. Preguntá si la revisó, si tiene dudas, o si necesita ajustar algo (moneda, cantidades, etc). ${baseRules}`;

    case 'referral_given':
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. ${firstName || 'Un lead'} te dio el contacto de alguien. Agradecé y contale cómo le fue con ese referido (o preguntale si podés contactarlo). ${baseRules}`;

    case 'interested':
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. ${firstName || 'Un lead'} mostró interés pero no avanzó. Ofrecé algo concreto: una demo, un ejemplo, un caso de éxito. Hacé que sea fácil dar el siguiente paso. ${baseRules}`;

    case 'cold':
      // Lead dijo "no me interesa" — despedida respetuosa, no insistir
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. ${firstName || 'El lead'} dijo que no le interesa. Despedite con clase y respeto. Dejá la puerta abierta SIN presión: "Fue un gusto hablar con vos. Si alguna vez necesitás algo, acá estoy." PROHIBIDO insistir, preguntar por qué, o hacer pitch. ${baseRules}`;

    case 'farewell_recontact':
      // Re-contacto 7 días después de la despedida — tono fresco, sin carga
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. Hace una semana te despediste de ${firstName || 'un lead'} porque no respondía. Ahora le escribís UNA ÚLTIMA VEZ con tono fresco, como si no hubiera pasado nada malo. NO menciones que no respondió. NO uses "te escribo de nuevo". Simplemente ofrecé algo de valor o un dato interesante del negocio. Si no responde a esto → silencio definitivo. ${baseRules}`;

    default:
      if (isLastAttempt) {
        return `Sos MIIA, asistente de ${bizName} por WhatsApp. ${firstName || 'Un lead'} no respondió tus últimos mensajes. Este es tu ÚLTIMO intento — despedite con gracia, dejá la puerta abierta: "Fue un gusto. Si necesitás algo, acá estoy 💜". PROHIBIDO presionar o hacer pitch. Último msg del lead: "${(lastUserMsg || '').substring(0, 80)}". ${baseRules}`;
      }
      return `Sos MIIA, asistente de ${bizName} por WhatsApp. ${firstName || 'Un lead'} no respondió. Retomá natural, ofrecé valor. Último msg del lead: "${(lastUserMsg || '').substring(0, 80)}". Follow-up #${followupCount + 1}. ${baseRules}`;
  }
}

module.exports = {
  classifyLeadState,
  buildFollowupPrompt,
  LATER_SIGNALS,
  QUOTE_SIGNALS,
  REFERRAL_SIGNALS,
  INTEREST_SIGNALS,
  COLD_SIGNALS
};
