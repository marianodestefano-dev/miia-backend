/**
 * C-270 Benchmark - 6 modelos x 4 tareas
 * Uso: railway run -- node scripts/benchmark/run_benchmark.js [T1|T3|T4|ALL]
 * NO guarda keys en output. Solo metrics.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { T1_OWNER_CHAT, T3_AUDITOR, T4_EMBEDDING_TEXT } = require('./prompts');

// Pricing por 1M tokens (input/output) USD — abril 2026
const PRICING = {
  'claude-opus-4-5':     { in: 15,   out: 75  },
  'claude-sonnet-4-5':   { in:  3,   out: 15  },
  'claude-haiku-4-5':    { in:  1,   out:  5  },
  'gemini-2.5-pro':      { in:  1.25,out: 10  },
  'gemini-2.5-flash':    { in:  0.30,out:  2.50 },
  'gemini-2.5-flash-thinking': { in: 0.30, out: 2.50 }, // mismo model, thinking_budget>0
};

const MODELS_CHAT = [
  { id: 'claude-opus-4-5',    provider: 'claude', apiModel: 'claude-opus-4-5' },
  { id: 'claude-sonnet-4-5',  provider: 'claude', apiModel: 'claude-sonnet-4-5' },
  { id: 'claude-haiku-4-5',   provider: 'claude', apiModel: 'claude-haiku-4-5' },
  { id: 'gemini-2.5-pro',     provider: 'gemini', apiModel: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash',   provider: 'gemini', apiModel: 'gemini-2.5-flash', thinking: 0 },
  { id: 'gemini-2.5-flash-thinking', provider: 'gemini', apiModel: 'gemini-2.5-flash', thinking: 2048 },
];

const EMBED_MODELS = [
  { id: 'google-text-embedding-004', provider: 'gemini-embed', apiModel: 'text-embedding-004', price: 0.00 /* free tier */ },
  { id: 'openai-text-embedding-3-small', provider: 'openai', apiModel: 'text-embedding-3-small', price: 0.02 },
  { id: 'voyage-3',                  provider: 'voyage', apiModel: 'voyage-3', price: 0.06 },
];

const CLAUDE_KEY = process.env.CLAUDE_API_KEY_2 || process.env.CLAUDE_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!CLAUDE_KEY) { console.error('FATAL: no CLAUDE key'); process.exit(1); }
if (!GEMINI_KEY) { console.error('FATAL: no GEMINI key'); process.exit(1); }

async function callClaude(model, system, user, maxTokens = 1024) {
  const t0 = Date.now();
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    },
    {
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 60000,
    }
  );
  const latency = Date.now() - t0;
  const d = res.data;
  return {
    text: d.content.map(c => c.text || '').join(''),
    inTokens: d.usage.input_tokens,
    outTokens: d.usage.output_tokens,
    latency,
  };
}

async function callGemini(model, system, user, thinkingBudget = 0) {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 1024 },
  };
  if (thinkingBudget > 0) {
    body.generationConfig.thinkingConfig = { thinkingBudget };
  } else if (model.includes('flash') && thinkingBudget === 0) {
    // force off for flash base
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const res = await axios.post(url, body, { timeout: 60000 });
  const latency = Date.now() - t0;
  const d = res.data;
  const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const usage = d.usageMetadata || {};
  return {
    text,
    inTokens: usage.promptTokenCount || 0,
    outTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    latency,
  };
}

async function callModel(modelCfg, system, user) {
  try {
    if (modelCfg.provider === 'claude') {
      return await callClaude(modelCfg.apiModel, system, user);
    } else if (modelCfg.provider === 'gemini') {
      return await callGemini(modelCfg.apiModel, system, user, modelCfg.thinking || 0);
    }
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    return { error: true, text: `ERR ${status}: ${msg.slice(0, 200)}`, inTokens: 0, outTokens: 0, latency: 0 };
  }
}

function computeCost(model, inT, outT) {
  const p = PRICING[model];
  if (!p) return 0;
  return (inT * p.in + outT * p.out) / 1_000_000;
}

async function runT1(consistencyRuns = 3) {
  console.log('\n====== T1 OWNER_CHAT ======');
  const results = [];
  for (const prompt of T1_OWNER_CHAT) {
    console.log(`\n--- ${prompt.id} ---`);
    console.log(`USER: ${prompt.user}`);
    for (const model of MODELS_CHAT) {
      const runs = [];
      for (let i = 0; i < consistencyRuns; i++) {
        const r = await callModel(model, prompt.system, prompt.user);
        runs.push(r);
        await new Promise(r => setTimeout(r, 500));
      }
      const avgLat = runs.reduce((s, r) => s + r.latency, 0) / runs.length;
      const totalCost = runs.reduce((s, r) => s + computeCost(model.id, r.inTokens, r.outTokens), 0);
      const avgCost = totalCost / runs.length;
      const hasErr = runs.some(r => r.error);
      console.log(`  [${model.id}] lat=${Math.round(avgLat)}ms cost=$${avgCost.toFixed(5)} err=${hasErr}`);
      runs.forEach((r, i) => console.log(`    run${i+1}: "${(r.text || '').slice(0, 200).replace(/\n/g, ' | ')}"`));
      results.push({
        task: 'T1', promptId: prompt.id, model: model.id,
        avgLatencyMs: Math.round(avgLat), avgCostUSD: +avgCost.toFixed(6),
        outputs: runs.map(r => r.text), inTokens: runs.map(r => r.inTokens), outTokens: runs.map(r => r.outTokens),
        errors: runs.filter(r => r.error).length,
        evalCriteria: prompt.evalCriteria,
      });
    }
  }
  return results;
}

async function runT3(consistencyRuns = 2) {
  console.log('\n====== T3 AUDITOR ======');
  const results = [];
  const auditorSystem = `Sos un auditor de calidad de respuestas de MIIA (asistente WhatsApp).
Te paso: contexto (chatType), lo que le escribieron a MIIA, y lo que MIIA respondio.
Clasifica la respuesta de MIIA como:
- HIT: correcta, apropiada, sin problemas
- MISS: incorrecta, alucina datos, expone mecanica interna, promete sin ejecutar
- REFUERZO: correcta pero mejorable
Devolve SOLO JSON: {"clasificacion":"HIT|MISS|REFUERZO","razon":"..."}`;

  for (const prompt of T3_AUDITOR) {
    console.log(`\n--- ${prompt.id} (truth=${prompt.groundTruth}) ---`);
    const userMsg = `CONTEXTO: ${prompt.context}\nLE ESCRIBIERON A MIIA: ${prompt.miiaInput}\nMIIA RESPONDIO: ${prompt.miiaOutput}`;
    for (const model of MODELS_CHAT) {
      const runs = [];
      for (let i = 0; i < consistencyRuns; i++) {
        const r = await callModel(model, auditorSystem, userMsg);
        runs.push(r);
        await new Promise(r => setTimeout(r, 500));
      }
      const avgLat = runs.reduce((s, r) => s + r.latency, 0) / runs.length;
      const totalCost = runs.reduce((s, r) => s + computeCost(model.id, r.inTokens, r.outTokens), 0);
      const avgCost = totalCost / runs.length;
      const classifications = runs.map(r => {
        try {
          const m = (r.text || '').match(/\{[\s\S]*\}/);
          if (!m) return '?';
          return JSON.parse(m[0]).clasificacion || '?';
        } catch { return '?'; }
      });
      const correct = classifications.filter(c => c === prompt.groundTruth).length;
      console.log(`  [${model.id}] lat=${Math.round(avgLat)}ms cost=$${avgCost.toFixed(5)} correct=${correct}/${runs.length} clasifs=[${classifications.join(',')}]`);
      results.push({
        task: 'T3', promptId: prompt.id, model: model.id, groundTruth: prompt.groundTruth,
        avgLatencyMs: Math.round(avgLat), avgCostUSD: +avgCost.toFixed(6),
        classifications, correctCount: correct, totalRuns: runs.length,
        outputs: runs.map(r => (r.text || '').slice(0, 300)),
      });
    }
  }
  return results;
}

async function runT4() {
  console.log('\n====== T4 EMBEDDINGS ======');
  const results = [];
  const text = T4_EMBEDDING_TEXT;

  // Google gemini-embedding-001 (nuevo, reemplazo de text-embedding-004 deprecated)
  for (const m of ['gemini-embedding-001']) {
    try {
      const t0 = Date.now();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:embedContent?key=${GEMINI_KEY}`;
      const res = await axios.post(url, {
        model: `models/${m}`,
        content: { parts: [{ text }] },
      }, { timeout: 30000 });
      const lat = Date.now() - t0;
      const dim = res.data.embedding?.values?.length || 0;
      console.log(`  [${m}] lat=${lat}ms dim=${dim} price=$0.15/1M`);
      results.push({ task: 'T4', model: m, latencyMs: lat, dim, pricePer1MTokens: 0.15, note: 'gemini-embedding-001, dim truncable, free tier 100 RPM' });
    } catch (e) {
      const status=e.response?.status, body=JSON.stringify(e.response?.data||{}).slice(0,200);
      console.log(`  [${m}] ERR ${status}: ${body}`);
      results.push({ task: 'T4', model: m, error: `${status}: ${body}` });
    }
  }

  // OpenAI + Voyage: solo pricing, sin call (no tenemos keys)
  results.push({ task: 'T4', model: 'openai-text-embedding-3-small', pricePer1MTokens: 0.02, dim: 1536, note: 'no-call (sin key), precio publico OpenAI abril 2026' });
  results.push({ task: 'T4', model: 'voyage-3', pricePer1MTokens: 0.06, dim: 1024, note: 'no-call (sin key), precio publico Voyage (MongoDB) abril 2026' });

  return results;
}

(async () => {
  const arg = process.argv[2] || 'ALL';
  const out = { startedAt: new Date().toISOString(), tasks: {} };

  if (arg === 'T1' || arg === 'ALL')  out.tasks.T1 = await runT1();
  if (arg === 'T3' || arg === 'ALL')  out.tasks.T3 = await runT3();
  if (arg === 'T4' || arg === 'ALL')  out.tasks.T4 = await runT4();

  const fpath = path.join(__dirname, `results_${Date.now()}.json`);
  fs.writeFileSync(fpath, JSON.stringify(out, null, 2));
  console.log(`\n✅ Guardado en: ${fpath}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
