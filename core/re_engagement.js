/**
 * Re-engagement detector — C-446-FIX-ADN §C (Bug 1).
 *
 * Origen: CARTA C-446-FIX-ADN [FIRMADA_VIVO_C446_FIX_ADN_MARIANO_2026-04-28]
 *
 * Cita Mariano:
 *   "A mi un lead me escribe pasado ciertos dias y yo no le tiro
 *    nuevamente la cotizacion por la cabeza. Primero lo saludo,
 *    vuelvo a preguntarle como esta, si lo pensó, si le puedo ayudar"
 *
 * Detecta gap temporal en conversation. Si gap > threshold Y contactType
 * es lead-like → caller inyecta contexto re-engagement al prompt.
 *
 * Auditor postprocess: si MIIA respondió con precio/cotización en primer
 * mensaje post-gap → veto + regenerar (caller maneja).
 */

'use strict';

const DEFAULT_GAP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

const LEAD_LIKE_TYPES = new Set([
  'lead',
  'miia_lead',
  'client',
  'miia_client',
  'follow_up_cold',
  'cold',
]);

/**
 * Detecta si hay re-engagement gap entre el último mensaje del lead
 * (o conversation last) y now.
 *
 * @param {Array} conversation — array de mensajes shape {role, content, timestamp}.
 * @param {string} contactType
 * @param {number} [now] — timestamp millis, default Date.now().
 * @param {object} [opts] { gapThresholdMs?: number }
 * @returns {{ isReEngagement: boolean, gapMs: number, gapDays?: number }}
 */
function detectReEngagement(conversation, contactType, now, opts) {
  const o = opts || {};
  const threshold = typeof o.gapThresholdMs === 'number'
    ? o.gapThresholdMs
    : DEFAULT_GAP_THRESHOLD_MS;
  const ts = typeof now === 'number' ? now : Date.now();

  if (!LEAD_LIKE_TYPES.has(contactType)) {
    return { isReEngagement: false, gapMs: 0 };
  }
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return { isReEngagement: false, gapMs: 0 };
  }
  // Buscar último mensaje (cualquier role) con timestamp válido.
  let lastTs = 0;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i];
    if (m && typeof m.timestamp === 'number' && m.timestamp > 0) {
      lastTs = m.timestamp;
      break;
    }
  }
  if (lastTs === 0) {
    return { isReEngagement: false, gapMs: 0 };
  }
  const gapMs = ts - lastTs;
  if (gapMs >= threshold) {
    return {
      isReEngagement: true,
      gapMs,
      gapDays: Math.round(gapMs / (24 * 60 * 60 * 1000)),
    };
  }
  return { isReEngagement: false, gapMs };
}

/**
 * Construye el bloque texto a inyectar al prompt si es re-engagement.
 *
 * @param {object} reResult — output de detectReEngagement.
 * @returns {string|null}
 */
function buildReEngagementContext(reResult) {
  if (!reResult || !reResult.isReEngagement) return null;
  const days = reResult.gapDays || Math.round(reResult.gapMs / (24 * 60 * 60 * 1000));
  return [
    '',
    '[CONTEXTO RE-ENGAGEMENT — C-446 §C]',
    `El lead vuelve después de ${days} día(s) sin contacto. Aplicá protocolo de re-engagement humano:`,
    '1. Saludá cálidamente PRIMERO (sin tirar precio/cotización en respuesta).',
    '2. Preguntá cómo está + si pensó lo conversado anterior.',
    '3. Ofrecé ayuda concreta SIN mencionar plan/precio en este turno.',
    '4. Si el lead pregunta directo por precio o cotización en SU mensaje → entonces sí podés responder con cotización.',
    'NO repitas oferta automática. NO retomes con "el plan que hablamos". NO menciones cotización si el lead saludó solamente.',
    '',
  ].join('\n');
}

/**
 * Auditor postprocess: si respuesta MIIA en primer turno post-gap
 * contiene patrones de cotización/oferta sin que el lead la haya
 * pedido explícito → marcar veto.
 *
 * @param {string} candidateText
 * @param {object} reResult
 * @param {string} userLastMessage — último mensaje del lead.
 * @returns {{shouldVeto: boolean, reason?: string}}
 */
function auditReEngagementResponse(candidateText, reResult, userLastMessage) {
  if (!reResult || !reResult.isReEngagement) {
    return { shouldVeto: false };
  }
  if (typeof candidateText !== 'string' || candidateText.length === 0) {
    return { shouldVeto: false };
  }
  const userMsg = (userLastMessage || '').toLowerCase();
  // Si el lead preguntó directamente por precio/cotización, OK responder.
  const userAsksPrice = /\b(precio|cotizaci[oó]n|cu[aá]nto\s+(cuesta|sale|vale)|cuanto\s+es|tarifa|plan(es)?)\b/i.test(userMsg);
  if (userAsksPrice) {
    return { shouldVeto: false };
  }
  // El lead NO preguntó por precio. Verificar si MIIA mete precio.
  const candLow = candidateText.toLowerCase();
  const priceLeakPatterns = [
    /\$\s*\d+/,                           // "$15"
    /\b\d+\s*(usd|us\$|d[oó]lar(es)?)\b/i, // "15 usd", "15 dólares"
    /\bplan\s+(mensual|anual|semestral|trimestral|enterprise)\b/i,
    /\bcotizaci[oó]n\b/i,
    /\bsuscripci[oó]n\b/i,
    /\b(mensual|anual|semestral)\s*\$/i,
  ];
  for (const rx of priceLeakPatterns) {
    const m = candidateText.match(rx);
    if (m) {
      return {
        shouldVeto: true,
        reason: `re-engagement leak: lead saludó/preguntó (sin precio) y MIIA respondió con "${m[0]}". Regenerar con saludo cálido.`,
      };
    }
  }
  return { shouldVeto: false };
}

module.exports = {
  detectReEngagement,
  buildReEngagementContext,
  auditReEngagementResponse,
  DEFAULT_GAP_THRESHOLD_MS,
  LEAD_LIKE_TYPES,
};
