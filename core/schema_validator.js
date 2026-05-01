'use strict';

/**
 * MIIA — Schema Validator (T139)
 * Validador JSON Schema lite para payloads de API.
 * Soporta: type, required, properties, enum, min/max, minLength/maxLength, pattern.
 */

const SUPPORTED_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'array', 'null']);

/**
 * Valida un valor contra un schema.
 * @param {*} value
 * @param {object} schema
 * @param {string} [path] - ruta para mensajes de error
 * @returns {string[]} array de errores (vacio = valido)
 */
function validateSchema(value, schema, path = 'root') {
  const errors = [];

  if (!schema || typeof schema !== 'object') return errors;

  // Type check
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actualType)) {
      errors.push(`${path}: se esperaba tipo ${types.join('|')}, se recibio ${actualType}`);
      return errors; // no continuar si el tipo es incorrecto
    }
  }

  // Null check
  if (value === null || value === undefined) {
    if (schema.required) errors.push(`${path}: valor requerido`);
    return errors;
  }

  // String validations
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: minLength ${schema.minLength} (actual: ${value.length})`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path}: maxLength ${schema.maxLength} (actual: ${value.length})`);
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) errors.push(`${path}: no coincide con patron ${schema.pattern}`);
    }
    if (schema.enum && !schema.enum.includes(value))
      errors.push(`${path}: debe ser uno de [${schema.enum.join(', ')}]`);
  }

  // Number validations
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: minimo ${schema.minimum} (actual: ${value})`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: maximo ${schema.maximum} (actual: ${value})`);
    if (schema.enum && !schema.enum.includes(value))
      errors.push(`${path}: debe ser uno de [${schema.enum.join(', ')}]`);
  }

  // Array validations
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: minItems ${schema.minItems} (actual: ${value.length})`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: maxItems ${schema.maxItems} (actual: ${value.length})`);
    if (schema.items) {
      value.forEach((item, i) => {
        const itemErrors = validateSchema(item, schema.items, `${path}[${i}]`);
        errors.push(...itemErrors);
      });
    }
  }

  // Object validations
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const required = schema.required || [];
    for (const field of required) {
      if (!(field in value) || value[field] === undefined || value[field] === null) {
        errors.push(`${path}.${field}: campo requerido`);
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          const propErrors = validateSchema(value[key], propSchema, `${path}.${key}`);
          errors.push(...propErrors);
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: propiedad no permitida`);
      }
    }
  }

  return errors;
}

/**
 * Valida y retorna resultado estructurado.
 */
function validate(value, schema) {
  const errors = validateSchema(value, schema);
  return { valid: errors.length === 0, errors };
}

module.exports = { validateSchema, validate, SUPPORTED_TYPES };
