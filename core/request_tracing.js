'use strict';

/**
 * MIIA — Request Tracing E2E (T111)
 * Genera requestId por request, lo propaga en logs y respuestas de error.
 * Middleware Express: añade req.requestId.
 * Usa crypto.randomUUID() o fallback con timestamp+random.
 */

const crypto = require('crypto');

/**
 * Genera un requestId único.
 */
function generateRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return `req_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Middleware Express que añade req.requestId y lo incluye en X-Request-ID header.
 * @returns {Function} Express middleware
 */
function requestTracingMiddleware() {
  return (req, res, next) => {
    // Respetar X-Request-ID del cliente si viene (para tracing E2E frontend→backend)
    const incoming = req.headers['x-request-id'];
    req.requestId = (incoming && typeof incoming === 'string' && incoming.length < 64)
      ? incoming
      : generateRequestId();
    res.setHeader('X-Request-ID', req.requestId);
    console.log(`[TRACE] ${req.method} ${req.path} requestId=${req.requestId}`);
    next();
  };
}

/**
 * Extrae requestId de un objeto req o retorna 'no-request-id'.
 */
function getRequestId(req) {
  if (!req) return 'no-request-id';
  return req.requestId || req.headers?.['x-request-id'] || 'no-request-id';
}

/**
 * Crea un logger contextual con requestId.
 */
function createRequestLogger(requestId) {
  const prefix = `[${requestId}]`;
  return {
    log: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    requestId,
  };
}

module.exports = {
  generateRequestId,
  requestTracingMiddleware,
  getRequestId,
  createRequestLogger,
};
