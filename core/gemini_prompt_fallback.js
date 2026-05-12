'use strict';

/**
 * PB.8 — Fallback de prompt cuando Gemini esta caido
 * Si Gemini falla y no hay respuesta: enviar mensaje generico al lead.
 * NUNCA dejar al lead sin respuesta.
 */

const FALLBACK_MESSAGES = Object.freeze({
  lead: 'Gracias por tu mensaje! En este momento estamos procesando tu consulta. Te respondemos muy pronto. 🙏',
  miia_lead: 'Gracias por tu interes! Estamos procesando tu consulta y te responderemos a la brevedad. 🙏',
  client: 'Gracias por contactarnos! Estamos procesando tu solicitud y te respondemos pronto. 🙏',
  follow_up_cold: 'Gracias por tu respuesta! Te contactamos muy pronto con mas informacion. 🙏',
  default: 'Gracias por tu mensaje! Te responderemos pronto. 🙏',
});

/**
 * Retorna el mensaje de fallback segun el tipo de chat.
 * @param {string} chatType
 * @returns {string}
 */
function getFallbackMessage(chatType) {
  return FALLBACK_MESSAGES[chatType] || FALLBACK_MESSAGES.default;
}

/**
 * Determina si un error de Gemini amerita usar el fallback.
 * @param {Error|string|null} error
 * @returns {boolean}
 */
function shouldUseFallback(error) {
  if (!error) return false;
  const msg = String(error.message || error);
  return (
    msg.includes('timeout') ||
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('Gemini') ||
    msg.includes('QUOTA-EXHAUST') ||
    msg.includes('circuit')
  );
}

module.exports = { getFallbackMessage, shouldUseFallback, FALLBACK_MESSAGES };
