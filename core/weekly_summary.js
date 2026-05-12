'use strict';

/**
 * PB.7 — Resumen semanal automatico al owner
 * Genera texto de resumen en base a array de metricas de 7 dias.
 * Envio via WA (inyectable) o retorna texto.
 */

const SUMMARY_FIELDS = ['messages_received', 'messages_sent', 'leads_new', 'leads_responded', 'gemini_errors', 'wa_reconnects'];

/**
 * Genera el texto del resumen semanal.
 * @param {Array<Object>} metricsArr - Array de objetos de metricas diarias
 * @returns {{ text: string, totals: Object }}
 */
function generateWeeklySummary(metricsArr) {
  if (!Array.isArray(metricsArr) || metricsArr.length === 0) {
    return { text: '📊 *Resumen semanal MIIA*\nSin actividad registrada esta semana.', totals: {} };
  }

  const totals = {};
  for (const field of SUMMARY_FIELDS) totals[field] = 0;

  for (const day of metricsArr) {
    for (const field of SUMMARY_FIELDS) {
      totals[field] += (typeof day[field] === 'number' ? day[field] : 0);
    }
  }

  const lines = [
    '📊 *Resumen semanal MIIA*',
    '──────────────────',
    '💬 Mensajes recibidos: ' + totals.messages_received,
    '📤 Mensajes enviados: ' + totals.messages_sent,
    '🆕 Leads nuevos: ' + totals.leads_new,
    '✅ Leads respondidos: ' + totals.leads_responded,
  ];
  if (totals.gemini_errors > 0) {
    lines.push('⚠️ Errores IA: ' + totals.gemini_errors);
  }
  if (totals.wa_reconnects > 0) {
    lines.push('🔌 Reconexiones WA: ' + totals.wa_reconnects);
  }
  lines.push('──────────────────');
  lines.push('¡Buena semana! 🚀');

  return { text: lines.join('\n'), totals };
}

/**
 * Verifica si hoy es lunes a las 9am COT (UTC-5).
 * @param {Date} [now]
 * @returns {boolean}
 */
function isMondayMorningCOT(now) {
  const d = now || new Date();
  // COT = UTC-5: usar UTC helpers para evitar timezone del servidor
  let cotHour = d.getUTCHours() - 5;
  let cotDay  = d.getUTCDay();
  if (cotHour < 0) { cotHour += 24; cotDay = (cotDay - 1 + 7) % 7; }
  return cotDay === 1 && cotHour === 9; // 1=Monday
}

module.exports = { generateWeeklySummary, isMondayMorningCOT, SUMMARY_FIELDS };
