'use strict';

/**
 * MIIA — Config Validator (T126)
 * Valida configuracion de tenant contra schema tipado.
 * Falla ruidosamente (fail loudly) con errores detallados.
 */

const CONFIG_SCHEMA = Object.freeze({
  businessName: { type: 'string', required: true, maxLength: 100 },
  timezone: { type: 'string', required: true },
  language: { type: 'string', required: false, enum: ['es', 'en', 'pt'], default: 'es' },
  maxMessagesPerHour: { type: 'number', required: false, min: 1, max: 1000, default: 50 },
  autoReply: { type: 'boolean', required: false, default: true },
  workingHours: { type: 'object', required: false },
  notifyOnNewLead: { type: 'boolean', required: false, default: true },
  webhookUrl: { type: 'string', required: false, maxLength: 500 },
  tags: { type: 'array', required: false },
});

const VALID_TIMEZONES = Object.freeze([
  'America/Bogota', 'America/Buenos_Aires', 'America/Argentina/Buenos_Aires',
  'America/New_York', 'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/Madrid', 'UTC',
]);

/**
 * Valida un valor contra una regla del schema.
 * @returns {string|null} error message o null si valido
 */
function validateField(key, value, rule) {
  if (value === undefined || value === null) {
    if (rule.required) return `${key}: campo requerido`;
    return null;
  }

  if (rule.type === 'string') {
    if (typeof value !== 'string') return `${key}: debe ser string`;
    if (rule.maxLength && value.length > rule.maxLength) return `${key}: max ${rule.maxLength} chars`;
    if (rule.enum && !rule.enum.includes(value)) return `${key}: debe ser uno de [${rule.enum.join(',')}]`;
  } else if (rule.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) return `${key}: debe ser numero`;
    if (rule.min !== undefined && value < rule.min) return `${key}: min ${rule.min}`;
    if (rule.max !== undefined && value > rule.max) return `${key}: max ${rule.max}`;
  } else if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return `${key}: debe ser boolean`;
  } else if (rule.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value) || value === null) return `${key}: debe ser objeto`;
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) return `${key}: debe ser array`;
  }

  return null;
}

/**
 * Valida la configuracion completa de un tenant.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[], warnings: string[], normalized: object }}
 */
function validateTenantConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['config debe ser un objeto'], warnings: [], normalized: {} };
  }

  const errors = [];
  const warnings = [];
  const normalized = {};

  // Validar cada campo del schema
  for (const [key, rule] of Object.entries(CONFIG_SCHEMA)) {
    const value = config[key];
    const err = validateField(key, value, rule);
    if (err) {
      errors.push(err);
    } else {
      normalized[key] = value !== undefined && value !== null ? value : rule.default;
    }
  }

  // Validar timezone especificamente
  if (config.timezone && !VALID_TIMEZONES.includes(config.timezone)) {
    warnings.push(`timezone desconocido: ${config.timezone} (puede ser valido, verificar)`);
  }

  // Detectar campos desconocidos
  for (const key of Object.keys(config)) {
    if (!CONFIG_SCHEMA[key]) {
      warnings.push(`campo desconocido ignorado: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, normalized };
}

module.exports = { validateTenantConfig, validateField, CONFIG_SCHEMA, VALID_TIMEZONES };
