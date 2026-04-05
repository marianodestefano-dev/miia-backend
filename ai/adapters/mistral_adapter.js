'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

const DEFAULT_MODEL = 'mistral-small-latest';
const API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MAX_RETRIES = 2;
const RETRY_DELAYS = [5000, 15000];

async function call(apiKey, prompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: opts.maxTokens || 4096
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('No text in Mistral response');
        return text;
      }

      const isRetryable = response.status === 429 || response.status === 503;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] || 15000;
        console.warn(`[MISTRAL] Error ${response.status} — retry in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const errText = await response.text();
      throw new Error(`Mistral API error: ${response.status} - ${errText.substring(0, 200)}`);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      if (err.message.includes('Mistral API error')) throw err;
      console.warn(`[MISTRAL] Network error — retry in 3s (${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Mistral: all retries exhausted without response');
}

async function callChat(apiKey, messages, systemPrompt, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;

  const mistralMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }))
  ];

  try {
    console.log(`[MISTRAL] Chat request: ${messages.length} msgs, model ${model}`);
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: mistralMessages,
        max_tokens: opts.maxTokens || 4096
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[MISTRAL] ERROR ${response.status}:`, errorText.substring(0, 200));
      const err = new Error(`Mistral chat error: ${response.status}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      console.error('[MISTRAL] Invalid response structure:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    console.log(`[MISTRAL] OK: ${text.length} chars`);
    return text;
  } catch (error) {
    console.error('[MISTRAL] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { call, callChat };
