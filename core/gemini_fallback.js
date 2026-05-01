'use strict';

/**
 * MIIA — Gemini Fallback (T110)
 * Si primary (gemini-2.5-flash) falla con 503/429/5xx → intenta secondary (gemini-1.5-flash).
 * Cumple regla 6.18: AbortController con timeout en cada fetch.
 */

const MODELS = Object.freeze({
  PRIMARY: 'gemini-2.5-flash',
  SECONDARY: 'gemini-1.5-flash',
});

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 45000;

// Status codes que justifican fallback
const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504]);

let _fetchFn = null;
function __setFetchForTests(fn) { _fetchFn = fn; }
function getFetch() { return _fetchFn || fetch; }

/**
 * Llama a un modelo Gemini con timeout.
 * @param {string} model - nombre del modelo
 * @param {string} apiKey
 * @param {object} body - request body
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, data?: object, error?: string }>}
 */
async function callModel(model, apiKey, body, timeoutMs = TIMEOUT_MS) {
  const url = `${BASE_URL}/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchFn = getFetch();
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { ok: false, status: 408, error: `Timeout (${timeoutMs}ms) en modelo ${model}` };
    }
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Llama a Gemini con fallback automático.
 * Intenta PRIMARY. Si falla con FALLBACK_STATUSES → intenta SECONDARY.
 * @param {string} apiKey
 * @param {object} body - request body { contents: [...] }
 * @param {{ primaryModel?: string, secondaryModel?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ data: object, modelUsed: string, usedFallback: boolean }>}
 */
async function callWithFallback(apiKey, body, opts = {}) {
  if (!apiKey) throw new Error('apiKey requerida');
  if (!body || !body.contents) throw new Error('body.contents requerido');

  const primaryModel = opts.primaryModel || MODELS.PRIMARY;
  const secondaryModel = opts.secondaryModel || MODELS.SECONDARY;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  console.log(`[GEMINI-FALLBACK] Llamando primary=${primaryModel}`);
  const primaryResult = await callModel(primaryModel, apiKey, body, timeoutMs);

  if (primaryResult.ok) {
    return { data: primaryResult.data, modelUsed: primaryModel, usedFallback: false };
  }

  const shouldFallback = FALLBACK_STATUSES.has(primaryResult.status) || primaryResult.status === 0 || primaryResult.status === 408;
  if (!shouldFallback) {
    throw new Error(`Gemini primary error ${primaryResult.status}: ${JSON.stringify(primaryResult.data || primaryResult.error)}`);
  }

  console.warn(`[GEMINI-FALLBACK] Primary ${primaryModel} falló (${primaryResult.status}), intentando ${secondaryModel}`);
  const secondaryResult = await callModel(secondaryModel, apiKey, body, timeoutMs);

  if (secondaryResult.ok) {
    return { data: secondaryResult.data, modelUsed: secondaryModel, usedFallback: true };
  }

  throw new Error(`Gemini fallback también falló: primary=${primaryResult.status} secondary=${secondaryResult.status}`);
}

module.exports = {
  callWithFallback, callModel,
  MODELS, FALLBACK_STATUSES, TIMEOUT_MS,
  __setFetchForTests,
};
