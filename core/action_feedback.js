'use strict';

/**
 * ACTION FEEDBACK v1.0 — Cierra el loop entre "MIIA dijo que hizo algo" y "¿realmente se hizo?"
 *
 * Problema que resuelve (el 0.5% restante):
 * MIIA dice "te lo agendé ✅" y emite [AGENDAR_EVENTO:...] → auditoría ve tag = OK.
 * Pero Calendar/Firestore falla silenciosamente → el evento NO se creó.
 * El contacto cree que está agendado. No lo está. Confianza destruida.
 *
 * Solución: después de ejecutar cada tag, registrar el resultado (éxito/fallo)
 * e inyectarlo en el historial de conversación como mensaje de sistema.
 * Así MIIA sabe en el próximo turno si la acción se ejecutó o no.
 *
 * También: detectar reacciones negativas del contacto post-respuesta.
 */

// Buffer de feedback pendiente por teléfono — se inyecta en el próximo prompt
// { phone: [{ action, success, detail, timestamp }] }
const _pendingFeedback = {};

/**
 * Registrar resultado de una acción ejecutada por un tag
 *
 * @param {string} phone - Teléfono del contacto
 * @param {string} action - Tipo de acción: 'agendar', 'email', 'cotizacion', 'cancelar', 'mover', 'turno', 'cobro'
 * @param {boolean} success - Si la acción se ejecutó correctamente
 * @param {string} detail - Detalle del resultado
 */
function recordActionResult(phone, action, success, detail) {
  if (!_pendingFeedback[phone]) _pendingFeedback[phone] = [];

  const entry = {
    action,
    success,
    detail,
    timestamp: new Date().toISOString(),
  };

  _pendingFeedback[phone].push(entry);

  // Mantener máximo 5 feedbacks por contacto (evitar acumulación)
  if (_pendingFeedback[phone].length > 5) {
    _pendingFeedback[phone] = _pendingFeedback[phone].slice(-5);
  }

  const emoji = success ? '✅' : '❌';
  console.log(`[ACTION-FEEDBACK] ${emoji} ${action} para ${phone.split('@')[0]}: ${detail}`);
}

/**
 * Obtener feedback pendiente para inyectar en el prompt y limpiarlo
 *
 * @param {string} phone - Teléfono del contacto
 * @returns {string} Bloque de texto para inyectar en el prompt (o '' si no hay)
 */
function consumeFeedback(phone) {
  const items = _pendingFeedback[phone];
  if (!items || items.length === 0) return '';

  const lines = items.map(item => {
    const emoji = item.success ? '✅' : '❌';
    return `${emoji} ${item.action.toUpperCase()}: ${item.detail}`;
  });

  // Limpiar después de consumir
  delete _pendingFeedback[phone];

  return `\n[RESULTADO DE ACCIONES ANTERIORES — Lee con atención]\n${lines.join('\n')}\n[FIN RESULTADOS]\n`;
}

/**
 * Detectar reacción negativa del contacto a la respuesta anterior de MIIA
 * Retorna un hint para inyectar en el prompt si detecta problema
 *
 * @param {string} userMessage - Mensaje actual del contacto
 * @param {string} lastMiiaMessage - Última respuesta de MIIA
 * @returns {string} Hint para el prompt (o '' si no hay problema)
 */
function detectNegativeReaction(userMessage, lastMiiaMessage) {
  if (!userMessage || !lastMiiaMessage) return '';

  const msg = userMessage.toLowerCase().trim();

  // Correcciones explícitas del contacto
  const corrections = [
    { pattern: /\b(?:no|eso no|mal|equivocad|incorrect|error|mentira|falso|ment[ií]s|me mentiste)\b/i, type: 'correction' },
    { pattern: /\b(?:no (?:era|es|fue|dije)|eso no es (?:así|cierto|verdad))\b/i, type: 'factual_error' },
    { pattern: /\b(?:no te ped[ií]|no quiero|no dije eso|yo no dije)\b/i, type: 'misunderstanding' },
    { pattern: /\b(?:otra vez|de nuevo|ya te dije|te lo dije|repet[ií])\b/i, type: 'repetition_frustration' },
    { pattern: /\b(?:no se agend[oó]|no me lleg[oó]|no recib[ií]|no funcion[oó])\b/i, type: 'action_failed' },
  ];

  for (const { pattern, type } of corrections) {
    if (pattern.test(msg)) {
      console.log(`[ACTION-FEEDBACK] 🔍 Reacción negativa detectada: ${type} — "${msg.substring(0, 100)}"`);

      switch (type) {
        case 'correction':
          return `\n⚠️ [SISTEMA] El contacto está corrigiendo algo que dijiste. Revisá tu respuesta anterior y PEDÍ DISCULPAS si te equivocaste. No te defiendas ni insistas.\n`;
        case 'factual_error':
          return `\n⚠️ [SISTEMA] El contacto dice que un dato que diste es incorrecto. ACEPTÁ el error, pedí disculpas, y corregí. NUNCA insistas en un dato que el contacto niega.\n`;
        case 'misunderstanding':
          return `\n⚠️ [SISTEMA] El contacto dice que entendiste mal. ESCUCHÁ de nuevo y reformulá. No asumas que tenías razón.\n`;
        case 'repetition_frustration':
          return `\n⚠️ [SISTEMA] El contacto está frustrado porque ya te dijo algo antes. RECONOCÉ el error, no repitas la misma pregunta.\n`;
        case 'action_failed':
          return `\n⚠️ [SISTEMA] El contacto dice que una acción que confirmaste NO se ejecutó correctamente. Verificá y ofrecé resolverlo. NO digas "ya lo hice" de nuevo.\n`;
      }
    }
  }

  return '';
}

/**
 * Obtener todas las métricas de feedback (para health endpoint)
 */
function getFeedbackMetrics() {
  let total = 0;
  let successes = 0;
  let failures = 0;
  for (const items of Object.values(_pendingFeedback)) {
    for (const item of items) {
      total++;
      if (item.success) successes++;
      else failures++;
    }
  }
  return { pendingPhones: Object.keys(_pendingFeedback).length, total, successes, failures };
}

module.exports = {
  recordActionResult,
  consumeFeedback,
  detectNegativeReaction,
  getFeedbackMetrics,
};
