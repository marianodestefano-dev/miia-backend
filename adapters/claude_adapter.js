'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [8000, 20000, 45000];
const API_VERSION = '2023-06-01';

async function call(apiKey, prompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model,
    max_tokens: opts.maxTokens || 4096,
    messages: [{ role: 'user', content: prompt }]
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.content?.[0]?.text;
        if (!text) throw new Error('No text in Claude response');
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

  const claudeMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  try {
    console.log(`[CLAUDE] Chat request: ${messages.length} msgs, prompt ${systemPrompt.length} chars`);
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
        messages: claudeMessages
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CLAUDE] ERROR ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      console.error('[CLAUDE] Invalid response structure:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    console.log(`[CLAUDE] OK: ${text.length} chars`);
    return text;
  } catch (error) {
    console.error('[CLAUDE] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { call, callChat };
