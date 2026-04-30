'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

const DEFAULT_MODEL = 'claude-sonnet-4-6'; // Safety net: si alguien llama sin model, NUNCA Opus por accidente
const MAX_RETRIES = 3;
const RETRY_DELAYS = [8000, 20000, 45000];
const API_VERSION = '2023-06-01'; // Versión estable — extended thinking funciona con este header

// T16-FIX HIGH-1 — patrón gemini_client.js (CLAUDE.md §6.18 fetch sin AbortController hang)
const FETCH_TIMEOUT_MS = 45000;
const FETCH_TIMEOUT_HEAVY_MS = 60000; // thinking enabled
const FETCH_WARNING_MS = 40000;

async function call(apiKey, prompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const url = 'https://api.anthropic.com/v1/messages';
  const useThinking = opts.thinking && opts.thinking > 0;

  // ═══ B+ Strategy: temperature + extended thinking ═══
  const payload = {
    model,
    max_tokens: opts.maxTokens || 4096,
    messages: [{ role: 'user', content: prompt }],
    // Temperature: solo si NO hay thinking (Claude no permite ambos juntos)
    ...(!useThinking && opts.temperature != null && { temperature: opts.temperature }),
    // Extended thinking: budget_tokens controla cuánto piensa antes de responder
    // MÍNIMO 1024 — Claude API rechaza valores menores desde 2025
    ...(useThinking && {
      thinking: { type: 'enabled', budget_tokens: Math.max(opts.thinking, 1024) }
    })
  };

  if (useThinking) {
    console.log(`[CLAUDE] 🧠 Thinking habilitado: ${opts.thinking} tokens budget`);
  }

  const timeoutMs = opts.timeout || (useThinking ? FETCH_TIMEOUT_HEAVY_MS : FETCH_TIMEOUT_MS);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // T16-FIX HIGH-1: AbortController para evitar hang infinito (CLAUDE.md §6.18)
    const controller = new AbortController();
    const warningTimer = setTimeout(() => {
      console.warn(`[CLAUDE] ⚠️ fetch lleva ${FETCH_WARNING_MS/1000}s sin respuesta (timeout en ${(timeoutMs - FETCH_WARNING_MS)/1000}s más)`);
    }, FETCH_WARNING_MS);
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(warningTimer);
      clearTimeout(abortTimer);

      if (response.ok) {
        const data = await response.json();
        // Con thinking, la respuesta tiene bloques thinking + text
        const textBlock = data.content?.find(b => b.type === 'text');
        const text = textBlock?.text || data.content?.[0]?.text;
        if (!text) throw new Error('No text in Claude response');
        // Log thinking usage si presente
        const thinkingBlock = data.content?.find(b => b.type === 'thinking');
        if (thinkingBlock) {
          console.log(`[CLAUDE] 🧠 Thinking usado: ${thinkingBlock.thinking?.length || 0} chars`);
        }
        return text;
      }

      const isRetryable = response.status === 429 || response.status === 503 || response.status === 529;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 45000;
        console.warn(`[CLAUDE] Error ${response.status} — retry in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const errText = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${errText.substring(0, 200)}`);
    } catch (err) {
      clearTimeout(warningTimer);
      clearTimeout(abortTimer);
      if (err.name === 'AbortError') {
        console.error(`[CLAUDE] ⏱️ TIMEOUT ${timeoutMs/1000}s — abort attempt ${attempt + 1}/${MAX_RETRIES}`);
      }
      if (attempt === MAX_RETRIES) throw err;
      if (err.message.includes('Claude API error')) throw err;
      console.warn(`[CLAUDE] Network error — retry in 5s (${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return '';
}

async function callChat(apiKey, messages, systemPrompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const url = 'https://api.anthropic.com/v1/messages';
  const useThinking = opts.thinking && opts.thinking > 0;

  const claudeMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  // T16-FIX HIGH-1: AbortController (CLAUDE.md §6.18)
  const timeoutMs = opts.timeout || (useThinking ? FETCH_TIMEOUT_HEAVY_MS : FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const warningTimer = setTimeout(() => {
    console.warn(`[CLAUDE] ⚠️ chat fetch lleva ${FETCH_WARNING_MS/1000}s sin respuesta (timeout en ${(timeoutMs - FETCH_WARNING_MS)/1000}s más)`);
  }, FETCH_WARNING_MS);
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    console.log(`[CLAUDE] Chat request: ${messages.length} msgs, prompt ${systemPrompt.length} chars${useThinking ? ` 🧠thinking:${opts.thinking}` : ''}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens || 4096,
        system: systemPrompt,
        messages: claudeMessages,
        // ═══ B+ Strategy ═══
        ...(!useThinking && opts.temperature != null && { temperature: opts.temperature }),
        ...(useThinking && {
          thinking: { type: 'enabled', budget_tokens: Math.max(opts.thinking, 1024) }
        })
      }),
      signal: controller.signal
    });
    clearTimeout(warningTimer);
    clearTimeout(abortTimer);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CLAUDE] ERROR ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    // Con thinking: buscar bloque type=text (puede haber thinking blocks antes)
    const textBlock = data.content?.find(b => b.type === 'text');
    const text = textBlock?.text || data.content?.[0]?.text;
    if (!text) {
      console.error('[CLAUDE] Invalid response structure:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    const thinkingBlock = data.content?.find(b => b.type === 'thinking');
    if (thinkingBlock) {
      console.log(`[CLAUDE] 🧠 Thinking: ${thinkingBlock.thinking?.length || 0} chars pensados`);
    }
    console.log(`[CLAUDE] OK: ${text.length} chars`);
    return text;
  } catch (error) {
    clearTimeout(warningTimer);
    clearTimeout(abortTimer);
    if (error.name === 'AbortError') {
      console.error(`[CLAUDE] ⏱️ TIMEOUT ${timeoutMs/1000}s — chat aborted`);
    }
    console.error('[CLAUDE] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { call, callChat };
