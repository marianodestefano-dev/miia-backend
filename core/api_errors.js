'use strict';

/**
 * MIIA — API Error Codes (T94)
 * Patron estandar para respuestas 4xx/5xx:
 *   { error: 'ERROR_CODE', message: 'descripcion humana', requestId? }
 */

const ERROR_CODES = Object.freeze({
  UNAUTHORIZED:     'UNAUTHORIZED',
  FORBIDDEN:        'FORBIDDEN',
  NOT_FOUND:        'NOT_FOUND',
  RATE_LIMITED:     'RATE_LIMITED',
  INTERNAL_ERROR:   'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST:      'BAD_REQUEST',
  CONFLICT:         'CONFLICT',
});

const HTTP_STATUS = Object.freeze({
  UNAUTHORIZED:     401,
  FORBIDDEN:        403,
  NOT_FOUND:        404,
  RATE_LIMITED:     429,
  INTERNAL_ERROR:   500,
  VALIDATION_ERROR: 400,
  BAD_REQUEST:      400,
  CONFLICT:         409,
});

/**
 * Envia una respuesta de error estandarizada.
 * @param {import('express').Response} res
 * @param {string} code - uno de ERROR_CODES
 * @param {string} message - descripcion humana
 * @param {Object} [extra] - campos adicionales opcionales (requestId, details, etc.)
 */
function sendApiError(res, code, message, extra = {}) {
  const status = HTTP_STATUS[code] || 500;
  const body = { error: code, message: String(message) };
  if (extra.requestId) body.requestId = extra.requestId;
  if (extra.details) body.details = extra.details;
  console.warn(`[API-ERROR] ${code} (${status}): ${message}${extra.requestId ? ' reqId='+extra.requestId : ''}`);
  return res.status(status).json(body);
}

module.exports = { ERROR_CODES, HTTP_STATUS, sendApiError };
