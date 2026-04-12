'use strict';

/**
 * MIIA VALIDATOR — Última barrera antes de enviar mensaje al usuario
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Corre DESPUÉS del postprocess y ANTES del envío. Verifica:
 *   1. ¿Quedan tags sin procesar? → eliminarlos + warning
 *   2. ¿MIIA dice "ya lo hice" sin flag de ejecución? → corregir
 *   3. ¿Mensaje vacío después de strip? → fallback
 *   4. ¿Mecánica interna expuesta? → sanitizar
 *   5. ¿Mensaje demasiado largo? → truncar inteligentemente
 *
 * REGLA: Este módulo NUNCA silencia errores. Todo se loggea.
 */

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═════════════════════════════════════════════════════���═════════

const MAX_MESSAGE_LENGTH = 4000; // WhatsApp limit es ~65K pero mensajes largos son mala UX

// Tags que NUNCA deben aparecer en el mensaje final al usuario
const INTERNAL_TAG_PATTERN = /\[[A-Z][A-Z_]+(?::[^\]]+)?\]/g;

// Palabras que revelan mecánica interna — PROHIBIDO en mensajes a leads/clientes
const INTERNAL_MECHANICS = [
  'firestore', 'firebase', 'baileys', 'whatsapp web', 'websocket',
  'backend', 'frontend', 'server.js', 'tenant_message_handler',
  'prompt_builder', 'gemini api', 'claude api', 'openai api',
  'process.env', 'console.log', 'json', 'api key',
  'cron job', 'setinterval', 'pipeline', 'tag system',
  'postprocess', 'preprocess', 'aiMessage', 'ctx.conversations',
];

// Patrones de confirmación de acciones (para PROMESA ROTA)
const ACTION_CONFIRMATIONS = {
  email: /ya (te |le )?(lo )?(envié|mandé|mand[eé]|envi[eé])|correo (enviado|mandado)|email (sent|enviado)/i,
  agenda: /ya (lo )?(agend[eé]|agendé|programé|cre[eé])|evento (creado|agendado|programado)|agend[eé] (el|la|tu)/i,
  tarea: /ya (la )?(cre[eé]|anot[eé])|tarea (creada|anotada)/i,
  cancel: /ya (lo )?(borr[eé]|elimin[eé]|cancel[eé])|evento (borrado|eliminado|cancelado)/i,
  move: /ya (lo )?(mov[ií]|cambi[eé])|evento (movido|cambiado)/i,
  cotizacion: /ya (te )?(la )?(envié|mandé)|cotizaci[oó]n (enviada|mandada)/i,
};

// ═══════════════════════════════════════════════════════════════
// VALIDADOR PRINCIPAL
// ═══════════════════════════════════════════════════════════════

/**
 * Validar y sanitizar mensaje de MIIA antes de enviarlo.
 *
 * @param {string} message - Mensaje de MIIA post-procesado
 * @param {Object} ctx - Contexto de validación
 * @param {boolean} ctx.isSelfChat - ¿Es self-chat del owner?
 * @param {string} ctx.chatType - 'lead'|'miia_lead'|'familia'|'equipo'|'owner'|...
 * @param {Object} ctx.executionFlags - { email: bool, agenda: bool, tarea: bool, cancel: bool, move: bool, cotizacion: bool }
 * @param {string} [ctx.logPrefix] - Prefijo para logs
 * @returns {{ message: string, issues: string[], wasModified: boolean }}
 */
function validatePreSend(message, ctx = {}) {
  const issues = [];
  const logPrefix = ctx.logPrefix || '[VALIDATOR]';
  let wasModified = false;
  let msg = message;

  if (!msg || typeof msg !== 'string') {
    console.error(`${logPrefix} ❌ Mensaje nulo/vacío recibido en validador`);
    return { message: '🤷‍♀️: Disculpa, tuve un problema procesando tu mensaje. ¿Podés repetirlo?', issues: ['empty_message'], wasModified: true };
  }

  // ═══ CHECK 1: Tags residuales ═══
  const residualTags = msg.match(INTERNAL_TAG_PATTERN);
  if (residualTags) {
    for (const tag of residualTags) {
      console.warn(`${logPrefix} ⚠️ [VALIDATOR] Tag residual en mensaje final: ${tag.substring(0, 80)}`);
      msg = msg.replace(tag, '');
      issues.push(`residual_tag:${tag.substring(0, 40)}`);
    }
    msg = msg.replace(/\s{2,}/g, ' ').trim();
    wasModified = true;
  }

  // ═══ CHECK 2: PROMESA ROTA — "ya lo hice" sin ejecución real ═══
  if (ctx.executionFlags) {
    const flags = ctx.executionFlags;
    for (const [action, pattern] of Object.entries(ACTION_CONFIRMATIONS)) {
      if (pattern.test(msg) && flags[action] === false) {
        console.error(`${logPrefix} 🚨 [VALIDATOR:PROMESA-ROTA] MIIA dice que hizo ${action} pero flag=${flags[action]} — CORRIGIENDO`);
        // Reemplazar confirmación falsa por respuesta honesta
        const replacements = {
          email: 'Lo intenté pero hubo un problema técnico con el correo. Voy a reintentarlo.',
          agenda: 'No pude agendar el evento por un problema técnico. ¿Querés que lo intente de nuevo?',
          tarea: 'No pude crear la tarea por un problema técnico. Reintentando...',
          cancel: 'No pude eliminar el evento. Puede que necesite que lo hagas manualmente desde el calendario.',
          move: 'No pude mover el evento por un problema técnico. ¿Querés que lo intente de nuevo?',
          cotizacion: 'Hubo un problema generando la cotización. Intenta de nuevo en un momento.',
        };
        msg = replacements[action] || 'Hubo un problema ejecutando esa acción. ¿Querés que lo intente de nuevo?';
        issues.push(`promesa_rota:${action}`);
        wasModified = true;
        break; // Solo corregir la primera promesa rota encontrada
      }
    }
  }

  // ═══ CHECK 3: Mecánica interna expuesta (solo para leads/clientes) ═══
  if (!ctx.isSelfChat && ctx.chatType !== 'owner' && ctx.chatType !== 'familia' && ctx.chatType !== 'equipo') {
    const lowerMsg = msg.toLowerCase();
    for (const term of INTERNAL_MECHANICS) {
      if (lowerMsg.includes(term)) {
        console.error(`${logPrefix} 🚨 [VALIDATOR:LEAK] Mecánica interna expuesta: "${term}" en mensaje a ${ctx.chatType}`);
        issues.push(`internal_leak:${term}`);
        // No reemplazar automáticamente — solo loggear. El postprocess ya debería haberlo atrapado.
        // Si llega aquí es un bug en el prompt o postprocess.
      }
    }
  }

  // ═══ CHECK 4: Mensaje vacío después de sanitización ═══
  if (!msg.trim()) {
    console.warn(`${logPrefix} ⚠️ [VALIDATOR] Mensaje vacío post-sanitización`);
    msg = ctx.isSelfChat ? '✅ Listo.' : '🤷‍♀️: Disculpa, no pude procesar tu mensaje correctamente.';
    issues.push('empty_after_sanitize');
    wasModified = true;
  }

  // ═══ CHECK 5: Mensaje demasiado largo ═══
  if (msg.length > MAX_MESSAGE_LENGTH) {
    console.warn(`${logPrefix} ⚠️ [VALIDATOR] Mensaje muy largo (${msg.length} chars) — truncando a ${MAX_MESSAGE_LENGTH}`);
    // Cortar en el último punto/salto antes del límite
    let cutPoint = msg.lastIndexOf('.', MAX_MESSAGE_LENGTH);
    if (cutPoint < MAX_MESSAGE_LENGTH * 0.5) cutPoint = msg.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (cutPoint < MAX_MESSAGE_LENGTH * 0.5) cutPoint = MAX_MESSAGE_LENGTH;
    msg = msg.substring(0, cutPoint + 1).trim();
    issues.push('truncated');
    wasModified = true;
  }

  // Log resumen si hubo issues
  if (issues.length > 0) {
    console.warn(`${logPrefix} [VALIDATOR] ${issues.length} issue(s) detectados: ${issues.join(', ')}`);
  }

  return { message: msg, issues, wasModified };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  validatePreSend,
  ACTION_CONFIRMATIONS,
  INTERNAL_MECHANICS,
  MAX_MESSAGE_LENGTH,
};
