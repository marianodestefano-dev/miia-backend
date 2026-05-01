'use strict';

/**
 * MIIA — Intent Classifier (T119)
 * Clasifica la intención de un mensaje entrante.
 * Retorna: { intent, confidence, signals }
 */

const INTENTS = Object.freeze([
  'booking', 'price', 'complaint', 'info', 'greeting', 'farewell', 'unknown'
]);

const PATTERNS = Object.freeze({
  greeting: [/\b(hola|buenas|buenos dias|buenos d[ií]as|buenas tardes|buenas noches|hey|hi|hello)\b/i],
  farewell: [/\b(adi[oó]s|bye|hasta luego|hasta ma[nñ]ana|chau|ciao|nos vemos)\b/i],
  booking: [/\b(agendar|reservar|cita|turno|appointment|reserva|programar|quiero una hora)\b/i],
  price: [/\b(precio|costo|cu[aá]nto|cu[aá]nto vale|cu[aá]nto cuesta|tarifa|valor|cobr[ao])\b/i],
  complaint: [/\b(queja|reclamo|problema|no funciona|mal servicio|molesto|insatisfecho|p[eé]simo|terrible|horrible)\b/i],
  info: [/\b(informaci[oó]n|info|d[oó]nde|horario|direcci[oó]n|c[oó]mo funciona|qu[eé] es|qu[eé] ofrece)\b/i],
});

const CONFIDENCE = Object.freeze({ HIGH: 0.9, MEDIUM: 0.7, LOW: 0.5 });

/**
 * Clasifica la intención de un mensaje.
 * @param {string} text
 * @returns {{ intent: string, confidence: number, signals: string[] }}
 */
function classifyIntent(text) {
  if (!text || typeof text !== 'string') {
    return { intent: 'unknown', confidence: 0, signals: [] };
  }

  const normalized = text.toLowerCase().trim();
  const matches = {};

  for (const [intent, patterns] of Object.entries(PATTERNS)) {
    const signals = [];
    for (const pattern of patterns) {
      const m = normalized.match(pattern);
      if (m) signals.push(m[0]);
    }
    if (signals.length > 0) matches[intent] = signals;
  }

  const found = Object.keys(matches);
  if (found.length === 0) {
    return { intent: 'unknown', confidence: CONFIDENCE.LOW, signals: [] };
  }

  // Prioridad: complaint > booking > price > info > greeting > farewell
  const PRIORITY = ['complaint', 'booking', 'price', 'info', 'greeting', 'farewell'];
  let topIntent = null;
  for (const p of PRIORITY) {
    if (matches[p]) { topIntent = p; break; }
  }
  if (!topIntent) topIntent = found[0];

  const confidence = found.length === 1 ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM;
  return { intent: topIntent, confidence, signals: matches[topIntent] };
}

/**
 * Clasifica múltiples mensajes y agrega resultados.
 * @param {string[]} texts
 * @returns {{ dominant: string, results: Array }}
 */
function classifyBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { dominant: 'unknown', results: [] };
  }
  const results = texts.map(t => classifyIntent(t));
  const counts = {};
  for (const r of results) {
    counts[r.intent] = (counts[r.intent] || 0) + 1;
  }
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return { dominant, results };
}

module.exports = { classifyIntent, classifyBatch, INTENTS, CONFIDENCE };
