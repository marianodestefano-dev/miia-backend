/**
 * GEMINI CLIENT — Unified Gemini AI API module for MIIA
 *
 * Consolidates all Gemini API calls into a single module:
 * - callGemini(apiKey, prompt)             → simple single-turn (replaces generateAIContent + callGeminiForTenant)
 * - callGeminiChat(apiKey, messages, systemPrompt) → multi-turn with system instruction (replaces callGeminiAPI)
 *
 * Both handle automatic retry on 503/429 with exponential backoff.
 */

'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

const DEFAULT_MODEL = 'gemini-2.0-flash';
const RETRY_DELAYS = [8000, 20000, 45000];
const MAX_RETRIES = 3;

/**
 * Extract text from a Gemini API response body.
 */
function extractText(data) {
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

/**
 * Build the Gemini API URL for a given model and key.
 */
function buildUrl(apiKey, model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

/**
 * Single-turn Gemini call with automatic retry.
 *
 * @param {string} apiKey  - Gemini API key
 * @param {string} prompt  - The user prompt
 * @param {object} [opts]
 * @param {string} [opts.model]   - Model name (default: gemini-2.0-flash)
 * @param {number} [opts.retries] - Max retries (default: 3)
 * @returns {Promise<string>} AI response text
 */
async function callGemini(apiKey, prompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const retries = opts.retries ?? MAX_RETRIES;
  const url = buildUrl(apiKey, model);
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = extractText(data);
        if (!text) throw new Error('No text in Gemini response');
        return text;
      }

      const isRetryable = response.status === 503 || response.status === 429;
      if (isRetryable && attempt < retries) {
        const delay = RETRY_DELAYS[attempt] || 45000;
        console.warn(`[GEMINI] Error ${response.status} — retry in ${delay / 1000}s (${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const errText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errText.substring(0, 200)}`);
    } catch (err) {
      if (attempt === retries) throw err;
      if (err.message.includes('Gemini API error')) throw err;
      console.warn(`[GEMINI] Network error — retry in 5s (${attempt + 1}/${retries}): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return '';
}

/**
 * Multi-turn Gemini call with system instruction and automatic retry.
 * Used for conversation-style AI where message history matters.
 *
 * @param {string} apiKey        - Gemini API key
 * @param {Array}  messages      - Array of { role: 'user'|'assistant', content: string }
 * @param {string} systemPrompt  - System instruction text
 * @param {object} [opts]
 * @param {string} [opts.model]  - Model name (default: gemini-2.0-flash)
 * @returns {Promise<string|null>} AI response text or null on error
 */
async function callGeminiChat(apiKey, messages, systemPrompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const url = buildUrl(apiKey, model);
  const payload = {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    }
  };

  try {
    console.log(`[GEMINI] Chat request: ${messages.length} msgs, prompt ${systemPrompt.length} chars`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GEMINI] ERROR ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    const text = extractText(data);
    if (!text) {
      console.error('[GEMINI] Invalid response structure:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    console.log(`[GEMINI] OK: ${text.length} chars`);
    return text;
  } catch (error) {
    console.error('[GEMINI] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { callGemini, callGeminiChat };
