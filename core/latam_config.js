"use strict";

const LATAM_CONFIGS = Object.freeze({
  CO: { name: "Colombia", currency: "COP", symbol: "$", timezone: "America/Bogota", locale: "es-CO", phone_prefix: "+57", date_format: "DD/MM/YYYY" },
  AR: { name: "Argentina", currency: "ARS", symbol: "$", timezone: "America/Argentina/Buenos_Aires", locale: "es-AR", phone_prefix: "+54", date_format: "DD/MM/YYYY" },
  MX: { name: "Mexico", currency: "MXN", symbol: "$", timezone: "America/Mexico_City", locale: "es-MX", phone_prefix: "+52", date_format: "DD/MM/YYYY" },
  CL: { name: "Chile", currency: "CLP", symbol: "$", timezone: "America/Santiago", locale: "es-CL", phone_prefix: "+56", date_format: "DD/MM/YYYY" },
  PE: { name: "Peru", currency: "PEN", symbol: "S/", timezone: "America/Lima", locale: "es-PE", phone_prefix: "+51", date_format: "DD/MM/YYYY" },
  BR: { name: "Brasil", currency: "BRL", symbol: "R$", timezone: "America/Sao_Paulo", locale: "pt-BR", phone_prefix: "+55", date_format: "DD/MM/YYYY" },
});

function getConfig(countryCode) {
  return LATAM_CONFIGS[countryCode.toUpperCase()] || null;
}

function formatCurrency(amount, countryCode) {
  const config = getConfig(countryCode);
  if (!config) return String(amount);
  return config.symbol + " " + amount.toLocaleString(config.locale);
}

function detectCountryFromPhone(phone) {
  const cleaned = phone.replace(/[^0-9+]/g, "");
  for (const [code, cfg] of Object.entries(LATAM_CONFIGS)) {
    const prefix = cfg.phone_prefix.replace("+", "");
    if (cleaned.startsWith("+" + prefix) || cleaned.startsWith(prefix)) return code;
  }
  return null;
}

module.exports = { LATAM_CONFIGS, getConfig, formatCurrency, detectCountryFromPhone };
