/**
 * T2 MMC DESTILACION — 6 modelos × 3 episodios × 2 runs = 36 calls
 * Mide: JSON valido 1er intento, campos obligatorios, coherencia cadencia, lat+cost, juicio subjetivo
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DESTILATION_SYSTEM, EPISODES } = require('./t2_prompts');

const PRICING = {
  'claude-opus-4-5':     { in: 15,   out: 75  },
  'claude-sonnet-4-5':   { in:  3,   out: 15  },
  'claude-haiku-4-5':    { in:  1,   out:  5  },
  'gemini-2.5-pro':      { in:  1.25,out: 10  },
  'gemini-2.5-flash':    { in:  0.30,out:  2.50 },
  'gemini-2.5-flash-thinking': { in: 0.30, out: 2.50 },
};

const MODELS = [
  { id: 'claude-opus-4-5',    provider: 'claude', apiModel: 'claude-opus-4-5' },
  { id: 'claude-sonnet-4-5',  provider: 'claude', apiModel: 'claude-sonnet-4-5' },
  { id: 'claude-haiku-4-5',   provider: 'claude', apiModel: 'claude-haiku-4-5' },
  { id: 'gemini-2.5-pro',     provider: 'gemini', apiModel: 'gemini-2.5-pro' },
  { id: 'gemini-2.5-flash',   provider: 'gemini', apiModel: 'gemini-2.5-flash', thinking: 0 },
  { id: 'gemini-2.5-flash-thinking', provider: 'gemini', apiModel: 'gemini-2.5-flash', thinking: 2048 },
];

const CLAUDE_KEY = process.env.CLAUDE_API_KEY_2 || process.env.CLAUDE_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!CLAUDE_KEY) { console.error('FATAL: no CLAUDE key'); process.exit(1); }
if (!GEMINI_KEY) { console.error('FATAL: no GEMINI key'); process.exit(1); }

function formatEpisode(ep) {
  return ep.messages.map(m => `[${m.ts}] ${m.from}: ${m.text}`).join('\n');
}

async function callClaude(model, system, user, maxTokens = 2048) {
  const t0 = Date.now();
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
    { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 90000 }
  );
  const latency = Date.now() - t0;
  const d = res.data;
  return { text: d.content.map(c => c.text || '').join(''), inTokens: d.usage.input_tokens, outTokens: d.usage.output_tokens, latency };
}

async function callGemini(model, system, user, thinkingBudget = 0) {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 2048, responseMimeType: 'application/json' },
  };
  if (thinkingBudget > 0) body.generationConfig.thinkingConfig = { thinkingBudget };
  else if (model.includes('flash') && thinkingBudget === 0) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await axios.post(url, body, { timeout: 90000 });
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

async function callModel(m, system, user) {
  try {
    if (m.provider === 'claude') return await callClaude(m.apiModel, system, user);
    return await callGemini(m.apiModel, system, user, m.thinking || 0);
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    return { error: true, text: `ERR ${status}: ${(msg || '').slice(0, 250)}`, inTokens: 0, outTokens: 0, latency: 0 };
  }
}

function parseJsonSafe(text) {
  if (!text) return { valid: false, reason: 'empty' };
  // 1. direct parse
  try {
    return { valid: true, obj: JSON.parse(text) };
  } catch {}
  // 2. extract {...} block
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { valid: false, reason: 'no_json_block' };
  try {
    return { valid: true, obj: JSON.parse(match[0]), extracted: true };
  } catch (e) {
    return { valid: false, reason: `parse_fail: ${e.message.slice(0,80)}` };
  }
}

function validateSchema(obj, expected) {
  const required = ['resumen', 'tono', 'lecciones', 'tags', 'idiomaDetectado'];
  const cadence = ['expectativa', 'desvioTension', 'resolucion', 'sensacion', 'tipo', 'cadenceConfidence'];
  const result = { missingRequired: [], missingCadence: [], invalidLessons: false, respectsEmptyLessons: null };

  for (const k of required) if (!(k in obj)) result.missingRequired.push(k);
  for (const k of cadence) if (!(k in obj)) result.missingCadence.push(k);

  if (Array.isArray(obj.lecciones)) {
    // si operacional → lecciones debe ser []
    if (expected.operational) {
      result.respectsEmptyLessons = obj.lecciones.length === 0;
    }
    if (obj.lecciones.length > 0) {
      // cada lesson debe tener text + confidence
      for (const l of obj.lecciones) {
        if (typeof l !== 'object' || !l.text || !l.confidence) {
          result.invalidLessons = true;
          break;
        }
      }
    }
  } else {
    result.invalidLessons = true;
  }

  // sensacion debe tener before/after/delta (pueden ser null)
  if (obj.sensacion && typeof obj.sensacion === 'object') {
    const senKeys = ['before','after','delta'];
    result.sensacionComplete = senKeys.every(k => k in obj.sensacion);
  } else {
    result.sensacionComplete = obj.sensacion === null; // null es valido para operacional
  }

  return result;
}

function computeCost(id, inT, outT) {
  const p = PRICING[id];
  if (!p) return 0;
  return (inT * p.in + outT * p.out) / 1_000_000;
}

async function runT2(runsPerEpisode = 2) {
  console.log('\n====== T2 MMC DESTILACION — schema v0.3 ======');
  const results = [];

  for (const ep of EPISODES) {
    console.log(`\n--- ${ep.id} (operational=${ep.expected.operational}) ---`);
    const userMsg = `EPISODIO:\n${formatEpisode(ep)}\n\nDestilá este episodio en el JSON del schema v0.3.`;

    for (const m of MODELS) {
      const runs = [];
      for (let i = 0; i < runsPerEpisode; i++) {
        const r = await callModel(m, DESTILATION_SYSTEM, userMsg);
        runs.push(r);
        await new Promise(res => setTimeout(res, 600));
      }

      const avgLat = Math.round(runs.reduce((s, r) => s + r.latency, 0) / runs.length);
      const totalCost = runs.reduce((s, r) => s + computeCost(m.id, r.inTokens, r.outTokens), 0);
      const avgCost = totalCost / runs.length;
      const errors = runs.filter(r => r.error).length;

      const parses = runs.map(r => parseJsonSafe(r.text));
      const validJson = parses.filter(p => p.valid).length;
      const firstTryValid = parses.filter(p => p.valid && !p.extracted).length;

      const validations = parses.map((p, idx) => {
        if (!p.valid) return null;
        return validateSchema(p.obj, ep.expected);
      });

      const respectsEmpty = ep.expected.operational
        ? validations.filter(v => v && v.respectsEmptyLessons === true).length
        : null;

      const completeRequired = validations.filter(v => v && v.missingRequired.length === 0).length;
      const completeCadence = validations.filter(v => v && v.missingCadence.length === 0).length;

      console.log(`  [${m.id}] lat=${avgLat}ms cost=$${avgCost.toFixed(5)} err=${errors} JSON_ok=${validJson}/${runs.length} firstTry=${firstTryValid}/${runs.length} req_ok=${completeRequired}/${runs.length} cad_ok=${completeCadence}/${runs.length}${ep.expected.operational ? ` empty_lessons=${respectsEmpty}/${runs.length}` : ''}`);

      // snippet primer output (truncado)
      parses.forEach((p, i) => {
        if (p.valid) {
          const snippet = JSON.stringify(p.obj).slice(0, 250);
          const lessonsCount = Array.isArray(p.obj.lecciones) ? p.obj.lecciones.length : 'INVALID';
          console.log(`    run${i+1}: lessons=${lessonsCount} tono="${(p.obj.tono || '').slice(0,30)}" tipo="${p.obj.tipo || 'null'}"`);
        } else {
          console.log(`    run${i+1}: INVALID (${p.reason})`);
        }
      });

      results.push({
        task: 'T2',
        episodeId: ep.id,
        operational: ep.expected.operational,
        model: m.id,
        avgLatencyMs: avgLat,
        avgCostUSD: +avgCost.toFixed(6),
        errors,
        jsonValid: validJson,
        firstTryValid,
        completeRequired,
        completeCadence,
        respectsEmptyLessons: respectsEmpty,
        totalRuns: runs.length,
        sampleOutputs: parses.map((p, i) => p.valid ? {
          lecciones: Array.isArray(p.obj.lecciones) ? p.obj.lecciones.length : null,
          tono: p.obj.tono,
          tipo: p.obj.tipo,
          cadenceConfidence: p.obj.cadenceConfidence,
          resumen: (p.obj.resumen || '').slice(0, 120),
          idiomaDetectado: p.obj.idiomaDetectado,
          tonadaDetectada: p.obj.tonadaDetectada,
          hasCadence: !!(p.obj.expectativa || p.obj.desvioTension),
        } : { invalid: p.reason, rawSnippet: (runs[i].text || '').slice(0, 200) }),
      });
    }
  }

  return results;
}

(async () => {
  const out = { startedAt: new Date().toISOString(), tasks: {} };
  out.tasks.T2 = await runT2(2);
  const fpath = path.join(__dirname, `results_t2_${Date.now()}.json`);
  fs.writeFileSync(fpath, JSON.stringify(out, null, 2));
  console.log(`\nGuardado en: ${fpath}`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
