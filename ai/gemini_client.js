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

const DEFAULT_MODEL = 'gemini-2.5-flash'; // 2.0-flash → 404, 1.5-flash → 404, 2.5-pro → 503
const RETRY_DELAYS = [8000, 20000, 45000];
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30000; // 30s — si Gemini no responde, abortar (previene isProcessing stuck)

/**
 * Extract text from a Gemini API response body.
 * With google_search, Gemini returns multiple parts — concatenate text parts.
 */
function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('');
  // Log grounding metadata if present (google_search results)
  const grounding = data?.candidates?.[0]?.groundingMetadata;
  if (grounding?.webSearchQueries?.length) {
    console.log(`[GEMINI-SEARCH] 🔍 Búsquedas: ${grounding.webSearchQueries.join(' | ')}`);
  }
  return text || null;
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

  // ═══ B+ Strategy: generationConfig con temperature + thinking ═══
  const genConfig = {};
  if (opts.temperature != null) genConfig.temperature = opts.temperature;
  if (opts.topP != null) genConfig.topP = opts.topP;
  if (opts.topK != null) genConfig.topK = opts.topK;
  // Gemini 2.5 Flash: thinking es GRATIS en free tier
  if (opts.thinkingBudget != null && opts.thinkingBudget > 0) {
    genConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
    console.log(`[GEMINI] 🧠 Thinking habilitado: ${opts.thinkingBudget} tokens budget`);
  }

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(opts.enableSearch && { tools: [{ google_search: {} }] }),
    ...(Object.keys(genConfig).length > 0 && { generationConfig: genConfig })
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);

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
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        console.error(`[GEMINI] ⏰ TIMEOUT: fetch abortado después de ${FETCH_TIMEOUT_MS/1000}s (attempt ${attempt + 1}/${retries})`);
        if (attempt < retries) {
          const delay = RETRY_DELAYS[attempt] || 45000;
          console.warn(`[GEMINI] Reintentando en ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Gemini timeout after ${FETCH_TIMEOUT_MS/1000}s (${retries} retries exhausted)`);
      }
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

  // ═══ B+ Strategy: generationConfig con temperature + thinking ═══
  const genConfig = {};
  if (opts.temperature != null) genConfig.temperature = opts.temperature;
  if (opts.topP != null) genConfig.topP = opts.topP;
  if (opts.topK != null) genConfig.topK = opts.topK;
  if (opts.thinkingBudget != null && opts.thinkingBudget > 0) {
    genConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  }

  const payload = {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    ...(Object.keys(genConfig).length > 0 && { generationConfig: genConfig })
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    console.log(`[GEMINI] Chat request: ${messages.length} msgs, prompt ${systemPrompt.length} chars`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

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
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      console.error(`[GEMINI] ⏰ TIMEOUT en callGeminiChat: fetch abortado después de ${FETCH_TIMEOUT_MS/1000}s`);
      return null;
    }
    console.error('[GEMINI] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { callGemini, callGeminiChat };
