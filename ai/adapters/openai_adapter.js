'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)).catch(() => require('node-fetch')(...args));

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [8000, 20000, 45000];

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
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
      })
    });

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
    console.error('[OPENAI] CRITICAL ERROR:', error.message);
    return null;
  }
}

module.exports = { call, callChat };
