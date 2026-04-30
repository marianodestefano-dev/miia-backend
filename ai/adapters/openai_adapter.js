'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [8000, 20000, 45000];

// T16-FIX HIGH-1 — patrón gemini_client.js (CLAUDE.md §6.18)
const FETCH_TIMEOUT_MS = 45000;
const FETCH_WARNING_MS = 40000;

async function call(apiKey, prompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const url = 'https://api.openai.com/v1/chat/completions';
  // ═══ B+ Strategy: temperature controlada por contexto ═══
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: opts.maxTokens || 4096,
    ...(opts.temperature != null && { temperature: opts.temperature })
  };

  const timeoutMs = opts.timeout || FETCH_TIMEOUT_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // T16-FIX HIGH-1: AbortController (CLAUDE.md §6.18)
    const controller = new AbortController();
    const warningTimer = setTimeout(() => {
      console.warn(`[OPENAI] ⚠️ fetch lleva ${FETCH_WARNING_MS/1000}s sin respuesta (timeout en ${(timeoutMs - FETCH_WARNING_MS)/1000}s más)`);
    }, FETCH_WARNING_MS);
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(warningTimer);
      clearTimeout(abortTimer);

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('No text in OpenAI response');
        return text;
      }

      const isRetryable = response.status === 429 || response.status === 503 || response.status === 500;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 45000;
        console.warn(`[OPENAI] Error ${response.status} — retry in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errText.substring(0, 200)}`);
    } catch (err) {
      clearTimeout(warningTimer);
      clearTimeout(abortTimer);
      if (err.name === 'AbortError') {
        console.error(`[OPENAI] ⏱️ TIMEOUT ${timeoutMs/1000}s — abort attempt ${attempt + 1}/${MAX_RETRIES}`);
      }
      if (attempt === MAX_RETRIES) throw err;
      if (err.message.includes('OpenAI API error')) throw err;
      console.warn(`[OPENAI] Network error — retry in 5s (${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return '';
}

async function callChat(apiKey, messages, systemPrompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const url = 'https://api.openai.com/v1/chat/completions';

  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }))
  ];

  // T16-FIX HIGH-1: AbortController
  const timeoutMs = opts.timeout || FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const warningTimer = setTimeout(() => {
    console.warn(`[OPENAI] ⚠️ chat fetch lleva ${FETCH_WARNING_MS/1000}s sin respuesta (timeout en ${(timeoutMs - FETCH_WARNING_MS)/1000}s más)`);
  }, FETCH_WARNING_MS);
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    console.log(`[OPENAI] Chat request: ${messages.length} msgs, prompt ${systemPrompt.length} chars`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: openaiMessages,
        max_tokens: opts.maxTokens || 4096,
        // ═══ B+ Strategy ═══
        ...(opts.temperature != null && { temperature: opts.temperature })
      }),
      signal: controller.signal
    });
    clearTimeout(warningTimer);
    clearTimeout(abortTimer);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OPENAI] ERROR ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      console.error('[OPENAI] Invalid response structure:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    console.log(`[OPENAI] OK: ${text.length} chars`);
    return text;
  } catch (error) {
    clearTimeout(warningTimer);
    clearTimeout(abortTimer);
    if (error.name === 'AbortError') {
      console.error(`[OPENAI] ⏱️ TIMEOUT ${timeoutMs/1000}s — chat aborted`);
    }
    console.error('[OPENAI] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { call, callChat };
