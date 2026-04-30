/**
 * AI CLIENT — Multi-provider abstraction layer for MIIA
 *
 * Routes AI calls to the appropriate provider adapter.
 * Supported providers: gemini, openai, claude
 * Integrated with Resilience Shield for circuit breaker + health tracking.
 *
 * Usage:
 *   const { callAI, callAIChat } = require('./ai_client');
 *   const text = await callAI('openai', apiKey, prompt);
 *   const chat = await callAIChat('claude', apiKey, messages, systemPrompt);
 */

'use strict';

const geminiAdapter = require('./adapters/gemini_adapter');
const openaiAdapter = require('./adapters/openai_adapter');
const claudeAdapter = require('./adapters/claude_adapter');
const groqAdapter = require('./adapters/groq_adapter');
const mistralAdapter = require('./adapters/mistral_adapter');
const keyPool = require('./key_pool');

// T46: structured AI pipeline logging (sin PII — solo metadata + lengths + latency)
function _aiObs(event, data) {
  // event: 'ai.call.start' | 'ai.call.ok' | 'ai.call.fail' | 'ai.chat.start' | 'ai.chat.ok' | 'ai.chat.fail'
  console.log(`[AI-OBS] ${event} ${JSON.stringify(data)}`);
}

// Shield integration — loaded lazily to avoid circular deps
let _shield = null;
function getShield() {
  if (!_shield) {
    try { _shield = require('../core/resilience_shield'); } catch (_) {}
  }
  return _shield;
}

const adapters = {
  gemini: geminiAdapter,
  openai: openaiAdapter,
  claude: claudeAdapter,
  groq: groqAdapter,
  mistral: mistralAdapter
};

const PROVIDER_LABELS = {
  gemini: 'Google Gemini',
  openai: 'OpenAI (GPT)',
  claude: 'Anthropic (Claude)',
  groq: 'Groq (Llama)',
  mistral: 'Mistral AI'
};

function getAdapter(provider) {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`Proveedor de IA no soportado: "${provider}". Proveedores válidos: ${Object.keys(adapters).join(', ')}`);
  }
  return adapter;
}

/**
 * Single-turn AI call routed to the specified provider.
 * @param {string} provider - 'gemini' | 'openai' | 'claude'
 * @param {string} apiKey
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
async function callAI(provider, apiKey, prompt, opts = {}) {
  const shield = getShield();
  const t0 = Date.now();
  const promptChars = (prompt || '').length;

  if (shield?.isCircuitOpen(shield.SYSTEMS.GEMINI)) {
    console.warn(`[AI-CLIENT] 🔴 Circuit breaker ABIERTO para IA — request bloqueada (provider: ${provider})`);
    _aiObs('ai.call.fail', { provider, model: opts.model || null, prompt_chars: promptChars, reason: 'circuit_open' });
    return null;
  }

  _aiObs('ai.call.start', { provider, model: opts.model || null, prompt_chars: promptChars, has_search: !!opts.enableSearch, has_thinking: !!opts.thinkingBudget });

  // Si hay key pool para este provider, usar rotación con retry
  if (keyPool.hasKeys(provider)) {
    try {
      const result = await _callWithPool(provider, 'call', [prompt, opts], shield);
      _aiObs('ai.call.ok', { provider, model: opts.model || null, prompt_chars: promptChars, response_chars: (result || '').length, latency_ms: Date.now() - t0, via: 'pool' });
      return result;
    } catch (err) {
      _aiObs('ai.call.fail', { provider, model: opts.model || null, prompt_chars: promptChars, latency_ms: Date.now() - t0, via: 'pool', err_status: err.status || err.statusCode || null });
      throw err;
    }
  }

  try {
    const adapter = getAdapter(provider);
    const result = await adapter.call(apiKey, prompt, opts);
    if (shield) shield.recordSuccess(shield.SYSTEMS.GEMINI);
    _aiObs('ai.call.ok', { provider, model: opts.model || null, prompt_chars: promptChars, response_chars: (result || '').length, latency_ms: Date.now() - t0, via: 'direct' });
    return result;
  } catch (err) {
    if (shield) shield.recordFail(shield.SYSTEMS.GEMINI, `${provider}: ${err.message}`);
    _aiObs('ai.call.fail', { provider, model: opts.model || null, prompt_chars: promptChars, latency_ms: Date.now() - t0, via: 'direct', err_status: err.status || err.statusCode || null });
    throw err;
  }
}

/**
 * Multi-turn chat AI call routed to the specified provider.
 * @param {string} provider - 'gemini' | 'openai' | 'claude'
 * @param {string} apiKey
 * @param {Array} messages - [{ role: 'user'|'assistant', content: string }]
 * @param {string} systemPrompt
 * @param {object} [opts]
 * @returns {Promise<string|null>}
 */
async function callAIChat(provider, apiKey, messages, systemPrompt, opts = {}) {
  const shield = getShield();
  const t0 = Date.now();
  const msgCount = Array.isArray(messages) ? messages.length : 0;
  const systemChars = (systemPrompt || '').length;
  const totalMsgChars = Array.isArray(messages) ? messages.reduce((s, m) => s + ((m && m.content) || '').length, 0) : 0;

  if (shield?.isCircuitOpen(shield.SYSTEMS.GEMINI)) {
    console.warn(`[AI-CLIENT] 🔴 Circuit breaker ABIERTO para IA — chat bloqueada (provider: ${provider})`);
    _aiObs('ai.chat.fail', { provider, model: opts.model || null, msg_count: msgCount, system_chars: systemChars, total_msg_chars: totalMsgChars, reason: 'circuit_open' });
    return null;
  }

  _aiObs('ai.chat.start', { provider, model: opts.model || null, msg_count: msgCount, system_chars: systemChars, total_msg_chars: totalMsgChars });

  if (keyPool.hasKeys(provider)) {
    try {
      const result = await _callWithPool(provider, 'callChat', [messages, systemPrompt, opts], shield);
      _aiObs('ai.chat.ok', { provider, model: opts.model || null, msg_count: msgCount, system_chars: systemChars, response_chars: (result || '').length, latency_ms: Date.now() - t0, via: 'pool' });
      return result;
    } catch (err) {
      _aiObs('ai.chat.fail', { provider, model: opts.model || null, msg_count: msgCount, system_chars: systemChars, latency_ms: Date.now() - t0, via: 'pool', err_status: err.status || err.statusCode || null });
      throw err;
    }
  }

  try {
    const adapter = getAdapter(provider);
    const result = await adapter.callChat(apiKey, messages, systemPrompt, opts);
    if (shield) shield.recordSuccess(shield.SYSTEMS.GEMINI);
    _aiObs('ai.chat.ok', { provider, model: opts.model || null, msg_count: msgCount, system_chars: systemChars, response_chars: (result || '').length, latency_ms: Date.now() - t0, via: 'direct' });
    return result;
  } catch (err) {
    if (shield) shield.recordFail(shield.SYSTEMS.GEMINI, `${provider}: ${err.message}`);
    _aiObs('ai.chat.fail', { provider, model: opts.model || null, msg_count: msgCount, system_chars: systemChars, latency_ms: Date.now() - t0, via: 'direct', err_status: err.status || err.statusCode || null });
    throw err;
  }
}

/**
 * Llama a un adapter usando key pool con failover automático.
 * Intenta hasta agotar todas las keys disponibles.
 */
async function _callWithPool(provider, method, args, shield) {
  const adapter = getAdapter(provider);
  const stats = keyPool.getStats(provider);
  const maxAttempts = stats.total;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = keyPool.getKey(provider);
    if (!key) break;

    try {
      const result = await adapter[method](key, ...args);
      keyPool.markSuccess(provider, key);
      if (shield) shield.recordSuccess(shield.SYSTEMS.GEMINI);
      return result;
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || '';
      const isQuota = String(status) === '429' || /quota|rate.?limit|resource.?exhaust/i.test(err.message);
      const isAuth = String(status) === '401' || String(status) === '403';

      if (isQuota) {
        keyPool.markFailed(provider, key, '429');
        console.warn(`[AI-CLIENT] 🔄 ${provider} key agotada (429), rotando a siguiente (intento ${attempt + 1}/${maxAttempts})`);
        continue;
      } else if (isAuth) {
        keyPool.markFailed(provider, key, String(status));
        console.error(`[AI-CLIENT] 🔴 ${provider} key inválida (${status}), rotando`);
        continue;
      } else {
        // Error no-recoverable (timeout, server error) → no rotar, propagar
        keyPool.markFailed(provider, key, String(status || 'ERROR'));
        if (shield) shield.recordFail(shield.SYSTEMS.GEMINI, `${provider}: ${err.message}`);
        throw err;
      }
    }
  }

  // Todas las keys fallaron
  if (shield) shield.recordFail(shield.SYSTEMS.GEMINI, `${provider}: todas las keys agotadas`);
  console.error(`[AI-CLIENT] 🔴 ${provider}: TODAS las keys fallaron (${maxAttempts} intentos)`);
  throw lastError || new Error(`${provider}: todas las API keys agotadas`);
}

module.exports = { callAI, callAIChat, PROVIDER_LABELS, keyPool };
