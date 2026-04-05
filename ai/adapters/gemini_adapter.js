'use strict';

const { callGemini, callGeminiChat } = require('../gemini_client');

async function call(apiKey, prompt, opts = {}) {
  return callGemini(apiKey, prompt, opts);
}

async function callChat(apiKey, messages, systemPrompt, opts = {}) {
  return callGeminiChat(apiKey, messages, systemPrompt, opts);
}

module.exports = { call, callChat };
