'use strict';

/**
 * MIIA — Pricing Calculator (T144)
 * Calcula precios para cotizaciones MIIA segun plan y pais.
 * Basado en specs/04_COTIZACIONES.md.
 */

const PLANS = Object.freeze({
  starter: {
    name: 'Starter',
    priceUSD: 49,
    maxContacts: 100,
    maxMessages: 1000,
    features: ['whatsapp', 'basic_ai', 'dashboard'],
  },
  professional: {
    name: 'Professional',
    priceUSD: 99,
    maxContacts: 500,
    maxMessages: 5000,
    features: ['whatsapp', 'advanced_ai', 'dashboard', 'analytics', 'broadcasts'],
  },
  business: {
    name: 'Business',
    priceUSD: 199,
    maxContacts: 2000,
    maxMessages: 20000,
    features: ['whatsapp', 'advanced_ai', 'dashboard', 'analytics', 'broadcasts', 'api', 'webhooks'],
  },
  enterprise: {
    name: 'Enterprise',
    priceUSD: null, // precio custom
    maxContacts: null,
    maxMessages: null,
    features: ['all'],
  },
});

const COUNTRY_MULTIPLIERS = Object.freeze({
  CO: 1.0,   // Colombia (referencia)
  AR: 0.8,   // Argentina
  MX: 0.9,   // Mexico
  BR: 0.95,  // Brazil
  US: 1.5,   // US (no atendemos, pero por si acaso)
  default: 1.0,
});

const VALID_PLAN_IDS = Object.freeze(Object.keys(PLANS));

/**
 * Calcula el precio de un plan para un pais.
 * @param {string} planId
 * @param {string} [country='CO']
 * @param {{ months?, discount? }} [opts]
 * @returns {{ planId, planName, priceUSD, priceLocalMultiplied, country, months, total, breakdown }}
 */
function calculatePrice(planId, country = 'CO', opts = {}) {
  if (!planId || !VALID_PLAN_IDS.includes(planId)) {
    throw new Error(`planId invalido: ${planId}. Validos: ${VALID_PLAN_IDS.join(', ')}`);
  }

  const plan = PLANS[planId];
  if (plan.priceUSD === null) {
    return {
      planId,
      planName: plan.name,
      priceUSD: null,
      custom: true,
      message: 'Precio Enterprise es personalizado. Contactar a hola@miia-app.com',
    };
  }

  const multiplier = COUNTRY_MULTIPLIERS[country] || COUNTRY_MULTIPLIERS.default;
  const months = opts.months || 1;
  const discount = opts.discount || 0; // 0-1, ej: 0.1 = 10% off

  const baseMonthly = plan.priceUSD * multiplier;
  const discountAmount = baseMonthly * discount;
  const monthlyNet = baseMonthly - discountAmount;
  const total = parseFloat((monthlyNet * months).toFixed(2));

  return {
    planId,
    planName: plan.name,
    priceUSD: plan.priceUSD,
    multiplier,
    country,
    months,
    discount,
    baseMonthly: parseFloat(baseMonthly.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    monthlyNet: parseFloat(monthlyNet.toFixed(2)),
    total,
    features: plan.features,
    breakdown: {
      baseMonthly,
      discountAmount,
      monthlyNet,
      months,
      total,
    },
  };
}

/**
 * Recomienda el plan mas adecuado segun parametros de uso.
 * @param {{ estimatedContacts, estimatedMessages }} usage
 * @returns {{ recommended: string, reason: string }}
 */
function recommendPlan(usage = {}) {
  const { estimatedContacts = 0, estimatedMessages = 0 } = usage;

  if (estimatedContacts > 2000 || estimatedMessages > 20000) {
    return { recommended: 'enterprise', reason: 'Volumen supera el plan Business' };
  }
  if (estimatedContacts > 500 || estimatedMessages > 5000) {
    return { recommended: 'business', reason: 'Volumen supera el plan Professional' };
  }
  if (estimatedContacts > 100 || estimatedMessages > 1000) {
    return { recommended: 'professional', reason: 'Volumen supera el plan Starter' };
  }
  return { recommended: 'starter', reason: 'Volumen se ajusta al plan Starter' };
}

module.exports = {
  calculatePrice,
  recommendPlan,
  PLANS,
  VALID_PLAN_IDS,
  COUNTRY_MULTIPLIERS,
};
