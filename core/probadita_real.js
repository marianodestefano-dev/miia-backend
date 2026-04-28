/**
 * Probadita REAL — C-446-FIX-ADN §B.2 (Bug 2 v3 fix conceptual).
 *
 * Origen: CARTA C-446-FIX-ADN [FIRMADA_VIVO_C446_FIX_ADN_MARIANO_2026-04-28].
 *
 * Cita Mariano 2026-04-28 08:34 COT:
 *   "Probadita es MIIA anotando que el lead es hincha de Boca, y que
 *    MIIA le envíe 'sabés que hoy Boca juega? Te lo recuerdo 10 min
 *    antes? O quieres seguimiento eventos del partido?'. Cosas así.
 *    Eso es probadita. NO enviar imagen o gif — eso es mierda podrida.
 *    PROBADITA ES PROBAR. Usar a MIIA y obtener lo que MIIA ofrece."
 *
 * Doctrina alineada con MIIA_SALES_PROFILE REGLA #1 line 94-100
 * prompt_builder.js: "DEMOS REALES. Cuando el lead pida algo (recordatorio,
 * clima, receta, agenda), HACELO DE VERDAD."
 *
 * Este módulo:
 *  1. Detecta preferencia/necesidad concreta del lead en mensaje.
 *  2. Genera prompt opt-in para que MIIA pregunte si quiere demo.
 *  3. Si lead acepta → caller agenda demo real via agenda-engine
 *     (wire-in §B.2 wire-in TMH va separado, este es el helper puro).
 */

'use strict';

/**
 * Catálogo de features MIIA que pueden activar probadita real.
 * Cada feature tiene:
 *  - keywords: regex array para detect en mensaje lead.
 *  - optInPrompt: lo que MIIA pregunta al lead.
 *  - demoTag: identifier para agendar el demo.
 *
 * Inspirado en MIIA_SALES_PROFILE REGLA #1 ejemplos:
 *   "Lead dice me olvido de todo → 'A ver, ¿qué tenés que hacer mañana?
 *    Decime y te aviso a la hora que necesites.'"
 *   "Lead dice me gusta el fútbol → '¿De qué equipo sos? Decime y el
 *    próximo partido te lo cuento en vivo.'"
 */
const PROBADITA_FEATURES = {
  deporte_seguimiento: {
    keywords: [
      /\b(boca|river|hincha|fan)\s+(de|del)\b/i,
      /\bsoy\s+(de|hincha\s+de|del)\s+(boca|river|barcelona|real\s+madrid|barça|psg)\b/i,
      /\b(me\s+gusta|amo)\s+(el\s+)?f[uú]tbol\b/i,
      /\b(me\s+gusta|me\s+encanta)\s+(la\s+)?nba\b/i,
    ],
    optInPrompt: 'Decime de qué equipo sos. Si querés, el próximo partido te aviso 10 min antes y te cuento jugadas en vivo.',
    demoTag: 'deporte_seguimiento',
  },
  agenda_recordatorio: {
    keywords: [
      /\b(me\s+olvid[oa]|no\s+me\s+acuerdo|olvidad[oa]?(?:\s+de)?)\b/i,
      /\b(record[aá]me|acord[aá](?:te)?)\b/i,
      /\b(tengo\s+(reuni[oó]n|cita|turno|llamada|examen))\b/i,
      /\b(no\s+pierdo|no\s+olvido)\s+(reuniones|citas|turnos)\b/i,
    ],
    optInPrompt: '¿Qué tenés que hacer mañana o pronto? Decime y te aviso a la hora exacta para que no se te pase.',
    demoTag: 'agenda_recordatorio',
  },
  finanzas_alerta: {
    keywords: [
      /\b(d[oó]lar|bitcoin|btc|eth|crypto|acci[oó]n(?:es)?)\b/i,
      /\b(invierto|inversi[oó]n|trading|bolsa)\b/i,
      /\b(me\s+interesa|sigo\s+(la|el))\s+(bolsa|crypto|d[oó]lar)\b/i,
    ],
    optInPrompt: '¿Qué activos seguís? Decime y te aviso cuando crucen el precio que importe (ej: dólar arriba de X, BTC abajo de Y).',
    demoTag: 'finanzas_alerta',
  },
  clima_diario: {
    keywords: [
      /\b(clima|lluvi[ao]?|llover|tormenta|temperatura)\b/i,
      /\b(qu[eé]\s+tiempo|c[oó]mo\s+est[aá]\s+el\s+(d[ií]a|tiempo))\b/i,
    ],
    optInPrompt: '¿En qué ciudad estás? Si querés, te mando el clima cada mañana antes de salir.',
    demoTag: 'clima_diario',
  },
  noticias_diaria: {
    keywords: [
      /\b(noticias?|actualidad|qu[eé]\s+pas[oó]|qu[eé]\s+est[aá]\s+pasando)\b/i,
      /\b(quiero\s+enterarme|quiero\s+saber|me\s+interesa)\s+(las\s+)?noticias?\b/i,
    ],
    optInPrompt: '¿Qué temas te importan? Te paso resumen diario solo de eso (deporte, política, tecnología, lo que vos digas).',
    demoTag: 'noticias_diaria',
  },
  salud_recordatorio: {
    keywords: [
      /\b(pastilla|medicamento|remedio|medicina)\b/i,
      /\b(no\s+tomo|olvid[oa]\s+(la\s+)?pastilla)\b/i,
      /\b(rutina\s+de\s+(gym|ejercicio|entrenamiento))\b/i,
    ],
    optInPrompt: '¿A qué hora tomás la pastilla? Te recuerdo todos los días para que no se te pase.',
    demoTag: 'salud_recordatorio',
  },
  precios_seguimiento: {
    keywords: [
      /\b(quiero\s+comprar|busco|estoy\s+buscando)\b/i,
      /\b(amazon|mercadolibre|aliexpress)\b/i,
      /\b(cuando\s+baje\s+(de\s+)?precio|alerta\s+precio)\b/i,
    ],
    optInPrompt: 'Pasame el link del producto. Te aviso ni bien baje de precio.',
    demoTag: 'precios_seguimiento',
  },
  cocina_receta: {
    keywords: [
      /\b(qu[eé]\s+cocino|qu[eé]\s+hago\s+(de\s+)?(comer|cena|almuerzo))\b/i,
      /\b(receta|recetas)\b/i,
      /\b(tengo\s+(en\s+)?(la\s+)?heladera|tengo\s+pollo)\b/i,
    ],
    optInPrompt: '¿Qué tenés en la heladera? Mandame foto o decime y te armo una receta con eso ahora mismo.',
    demoTag: 'cocina_receta',
  },
};

/**
 * Detecta features mencionadas por el lead en messageBody.
 *
 * @param {string} messageBody — texto del mensaje del lead.
 * @returns {Array<{feature: string, optInPrompt: string, demoTag: string, matched: string}>}
 */
function detectProbaditaFeatures(messageBody) {
  if (!messageBody || typeof messageBody !== 'string') return [];
  const detected = [];
  for (const [feature, def] of Object.entries(PROBADITA_FEATURES)) {
    for (const rx of def.keywords) {
      const m = messageBody.match(rx);
      if (m) {
        detected.push({
          feature,
          optInPrompt: def.optInPrompt,
          demoTag: def.demoTag,
          matched: m[0],
        });
        break; // una match por feature suficiente
      }
    }
  }
  return detected;
}

/**
 * Detecta si el lead aceptó la oferta opt-in en su mensaje.
 *
 * Ejemplo: MIIA pregunta "querés que te recuerde?" → lead "sí dale".
 *
 * @param {string} messageBody — mensaje del lead post-opt-in.
 * @returns {boolean}
 */
function isOptInAccepted(messageBody) {
  if (!messageBody || typeof messageBody !== 'string') return false;
  const acceptPatterns = [
    /\b(s[ií]|dale|listo|ok(ay)?|de\s+una|por\s+supuesto|claro|obvio|me\s+gustar[ií]a)\b/i,
    /\b(s[ií],?\s+por\s+favor|s[ií],?\s+(porfa|porfis))\b/i,
    /\b(bueno|buen[ií]simo|excelente|perfecto)\b/i,
    /\b(va|vale|hag[aá]moslo|hagamos\s+eso)\b/i,
  ];
  for (const rx of acceptPatterns) {
    if (rx.test(messageBody)) return true;
  }
  return false;
}

/**
 * Construye el bloque a inyectar al prompt cuando se detectan features
 * probadita activables. Le instruye a MIIA preguntar opt-in en lugar de
 * tirar info random.
 *
 * @param {Array} detectedFeatures — output de detectProbaditaFeatures.
 * @returns {string|null}
 */
function buildProbaditaPromptContext(detectedFeatures) {
  if (!Array.isArray(detectedFeatures) || detectedFeatures.length === 0) return null;
  const optIns = detectedFeatures.map((d) => `- ${d.feature}: "${d.optInPrompt}"`).join('\n');
  return [
    '',
    '[CONTEXTO PROBADITA REAL — C-446 §B.2]',
    'El lead mencionó preferencia(s)/necesidad(es) concreta(s):',
    detectedFeatures.map((d) => `- ${d.feature} (matched: "${d.matched}")`).join('\n'),
    '',
    'Aplicá probadita REAL (NO marketing visual): preguntá opt-in con tono conversacional natural.',
    'Sugerencias adaptables:',
    optIns,
    '',
    'NO menciones precio/cotización en este turno. NO digas "puedo hacer X" — preguntá si quiere que lo hagas.',
    '',
  ].join('\n');
}

module.exports = {
  detectProbaditaFeatures,
  isOptInAccepted,
  buildProbaditaPromptContext,
  PROBADITA_FEATURES,
};
