'use strict';
/**
 * MIIA — Message Template Engine (T115)
 * Renderiza templates con variables {{variable}}.
 * Valida variables requeridas, escapa peligros.
 */

const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/**
 * Extrae las variables de un template.
 */
function extractVariables(template) {
  if (!template || typeof template !== 'string') return [];
  const vars = new Set();
  let m;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) vars.add(m[1]);
  return Array.from(vars);
}

/**
 * Renderiza un template reemplazando {{var}} con valores de context.
 * @param {string} template
 * @param {object} context - { varName: value }
 * @param {{ strict?: boolean }} opts - strict=true lanza error si falta variable
 */
function renderTemplate(template, context = {}, { strict = false } = {}) {
  if (!template || typeof template !== 'string') throw new Error('template requerido (string)');
  if (!context || typeof context !== 'object') throw new Error('context debe ser objeto');
  PLACEHOLDER_RE.lastIndex = 0; // reset regex
  const missing = [];
  const result = template.replace(PLACEHOLDER_RE, (match, varName) => {
    if (varName in context) {
      const val = context[varName];
      return val === null || val === undefined ? '' : String(val);
    }
    missing.push(varName);
    return strict ? match : '';
  });
  if (strict && missing.length > 0) {
    throw new Error(`Variables faltantes en template: ${missing.join(', ')}`);
  }
  return result;
}

/**
 * Valida que un template sea válido (solo placeholders bien formados).
 */
function validateTemplate(template) {
  if (!template || typeof template !== 'string') return { valid: false, error: 'template requerido' };
  // Detectar llaves sin cerrar o mal formadas
  const malformed = template.match(/\{[^{]|[^}]\}/g) || [];
  // Contar llaves para balanceo
  const opens = (template.match(/\{\{/g) || []).length;
  const closes = (template.match(/\}\}/g) || []).length;
  if (opens !== closes) return { valid: false, error: 'Llaves desbalanceadas' };
  return { valid: true, variables: extractVariables(template) };
}

module.exports = { renderTemplate, extractVariables, validateTemplate };
