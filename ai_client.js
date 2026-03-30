/**
 * AI CLIENT — Multi-provider abstraction layer for MIIA
 *
 * Routes AI calls to the appropriate provider adapter.
 * Supported providers: gemini, openai, claude
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

const adapters = {
  gemini: geminiAdapter,
  openai: openaiAdapter,
  claude: claudeAdapter
};

const PROVIDER_LABELS = {
  gemini: 'Google Gemini',
  openai: 'OpenAI (GPT)',
  claude: 'Anthropic (Claude)'
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
  const adapter = getAdapter(provider);
  return adapter.call(apiKey, prompt, opts);
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
  const adapter = getAdapter(provider);
  return adapter.callChat(apiKey, messages, systemPrompt, opts);
}

module.exports = { callAI, callAIChat, PROVIDER_LABELS };
