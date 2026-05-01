"use strict";

const STRATEGY_SIGNALS = Object.freeze({
  high_intent: ["precio", "comprar", "adquirir", "cuanto", "disponible", "cuando puedo"],
  objection: ["caro", "costoso", "pensarlo", "no se", "tal vez", "despues"],
  ready_to_close: ["lo quiero", "me lo llevo", "como pago", "envian", "factura"],
});

function detectStrategyContext(messages) {
  if (!Array.isArray(messages)) return { context: "unknown", signals: [] };
  const text = messages.filter(m => m.role === "lead").map(m => (m.text || m.content || "").toLowerCase()).join(" ");
  const signals = [];
  for (const [ctx, patterns] of Object.entries(STRATEGY_SIGNALS)) {
    const matched = patterns.filter(p => text.includes(p));
    if (matched.length > 0) signals.push({ context: ctx, matched });
  }
  if (signals.length === 0) return { context: "neutral", signals: [] };
  signals.sort((a, b) => b.matched.length - a.matched.length);
  return { context: signals[0].context, signals };
}

function buildStrategyPrompt(context, productName) {
  const product = productName || "el producto";
  const prompts = {
    high_intent: "El lead muestra interes activo en " + product + ". Presentar precio con valor claro y llamada a la accion.",
    objection: "El lead tiene objecion de precio. Mostrar ROI, testimonios, garantia, opciones de cuotas.",
    ready_to_close: "El lead esta listo para cerrar. Simplificar el proceso de pago. Dar pasos concretos.",
    neutral: "Lead en etapa exploratoria. Hacer preguntas para identificar necesidad concreta.",
    unknown: "Contexto no identificado. Responder consulta directamente.",
  };
  return prompts[context] || prompts.neutral;
}

module.exports = { detectStrategyContext, buildStrategyPrompt, STRATEGY_SIGNALS };
