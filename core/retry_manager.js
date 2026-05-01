'use strict';

/**
 * MIIA — Retry Manager (T122)
 * Retry con backoff exponencial + jitter.
 * maxRetries, baseDelayMs, maxDelayMs, jitter (0-1), retryableErrors
 */

const DEFAULTS = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitter: 0.3,
});

/**
 * Calcula el delay para el intento n (0-indexed).
 * @param {number} attempt - 0-indexed
 * @param {{ baseDelayMs, maxDelayMs, jitter }} opts
 * @returns {number} ms
 */
function calcDelay(attempt, { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs, jitter = DEFAULTS.jitter } = {}) {
  const exp = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxDelayMs);
  const jitterMs = capped * jitter * Math.random();
  return Math.floor(capped + jitterMs);
}

/**
 * Determina si un error es reintentable.
 * @param {Error} err
 * @param {Set<string>} [retryableErrors] - set de message patterns o status codes
 * @returns {boolean}
 */
function isRetryable(err, retryableErrors) {
  if (!retryableErrors) return true; // null = todo es reintentable
  if (retryableErrors.size === 0) return false; // set vacio = nada es reintentable
  if (err.status && retryableErrors.has(String(err.status))) return true;
  for (const pattern of retryableErrors) {
    if (err.message && err.message.includes(pattern)) return true;
  }
  return false;
}

/**
 * Ejecuta fn con reintentos.
 * @param {Function} fn - async () => any
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3]
 * @param {number} [opts.baseDelayMs=500]
 * @param {number} [opts.maxDelayMs=30000]
 * @param {number} [opts.jitter=0.3]
 * @param {Set<string>} [opts.retryableErrors] - si vacío, todos los errores son reintentables
 * @param {Function} [opts._sleep] - override para tests
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
  if (typeof fn !== 'function') throw new Error('fn requerido');

  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitter = opts.jitter ?? DEFAULTS.jitter;
  const retryableErrors = opts.retryableErrors || null;
  const sleepFn = opts._sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retriable = retryableErrors ? isRetryable(e, retryableErrors) : true;
      if (!retriable || attempt >= maxRetries) {
        console.error(`[RETRY] FAILED after ${attempt + 1} attempts: ${e.message}`);
        throw e;
      }
      const delay = calcDelay(attempt, { baseDelayMs, maxDelayMs, jitter: 0 }); // sin jitter en tests
      console.warn(`[RETRY] attempt=${attempt + 1}/${maxRetries} error="${e.message}" delay=${delay}ms`);
      await sleepFn(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, calcDelay, isRetryable, DEFAULTS };
