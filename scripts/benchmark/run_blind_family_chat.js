#!/usr/bin/env node
/**
 * ESTUDIO INTERNO 300 — BATCH 1 (Family/Friend Broadcast Chat)
 *
 * Ex "BLIND REDUCIDO" renombrado en C-350 SEC-D Q1 / firmado C-352 SEC-C paso 1.
 * Este script produce las primeras 20 respuestas (4 modelos × 5 turnos) del
 * estudio interno 300 (batch 1 = 20 seed; batches 2-N agregan ~280 más).
 *
 * C-347 SEC-C (Wi → Vi). Protocolo:
 *   4 modelos × 5 turnos = 20 respuestas.
 *   Modelos mapeados a A/B/C/D aleatorio (mapping.json oculto).
 *   Mariano evalúa sin saber cuál modelo produjo cuál respuesta.
 *
 * Modelos:
 *   1. claude-opus-4-7         (Opus 4.7)
 *   2. claude-sonnet-4-6       (Sonnet 4.6)
 *   3. claude-haiku-4-5-20251001 (Haiku 4.5)
 *   4. gemini-2.5-flash        (control)
 *
 * Turnos (con contexto CO, voseo colombiano neutro):
 *   T1: empty-presentation  (MIIA se presenta sin input previo)
 *   T2: "¿qué sos?"
 *   T3: recordatorio        ("recordame regar las plantas mañana a las 10am")
 *   T4: emoción mamá        ("le estoy escribiendo a mi hijo, se me hace tan lindo…")
 *   T5: fútbol Nacional     ("yo soy hincha de Nacional")
 *
 * Uso:
 *   railway run --service miia-backend -- node scripts/benchmark/run_blind_family_chat.js
 *
 * Outputs (C-350 SEC-D Q1 — renombrado de blind_family_chat_* → estudio_interno_300_batch1_*):
 *   scripts/benchmark/estudio_interno_300_batch1_results.md      ← tabla A/B/C/D (enviar a Mariano)
 *   scripts/benchmark/estudio_interno_300_batch1_mapping.json    ← A→model (NO enviar hasta que evalúe)
 *   scripts/benchmark/estudio_interno_300_batch1_INSTRUCCIONES.md
 *   scripts/benchmark/estudio_interno_300_batch1_raw.json        ← raw responses + metadata
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { buildFriendBroadcastPrompt } = require('../../core/prompt_builder');

const OUT_DIR = path.join(__dirname);
const CLAUDE_KEY = process.env.CLAUDE_API_KEY_2 || process.env.CLAUDE_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!CLAUDE_KEY) { console.error('FATAL: CLAUDE_API_KEY_2 no encontrada (usar railway run)'); process.exit(1); }
if (!GEMINI_KEY) { console.error('FATAL: GEMINI_API_KEY no encontrada'); process.exit(1); }

const OWNER_PROFILE = {
  shortName: 'Mariano',
  name:      'Mariano De Stefano',
  passions:  'fútbol y MIIA'
};
const CONTACT_NAME = 'Alejandra';
const COUNTRY_CODE = 'CO';

const SYSTEM_PROMPT = buildFriendBroadcastPrompt(CONTACT_NAME, COUNTRY_CODE, OWNER_PROFILE);

const MODELS = [
  { id: 'opus-4-7',   provider: 'claude', api: 'claude-opus-4-7',           label: 'Claude Opus 4.7' },
  { id: 'sonnet-4-6', provider: 'claude', api: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
  { id: 'haiku-4-5',  provider: 'claude', api: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'gemini',     provider: 'gemini', api: 'gemini-2.5-flash',          label: 'Gemini 2.5 Flash' }
];

const TURNS = [
  {
    id: 'T1',
    label: 'empty-presentation',
    description: 'MIIA se presenta por primera vez (sin input previo del contacto).',
    userInput: '[AUTO_PRESENTATION] Iniciá la conversación presentándote a Alejandra de forma natural y cálida. No tenés mensaje previo de ella — sos vos arrancando. Respetá el dialecto CO (tuteo colombiano).'
  },
  {
    id: 'T2',
    label: 'qué sos',
    description: 'Alejandra pregunta "¿qué sos?".',
    userInput: 'che, ¿qué sos? ¿sos un bot?'
  },
  {
    id: 'T3',
    label: 'recordatorio',
    description: 'Alejandra pide un recordatorio — MIIA debe emitir tag AGENDAR_EVENTO.',
    userInput: 'oye recordame regar las plantas mañana a las 10am porfa'
  },
  {
    id: 'T4',
    label: 'emoción mamá',
    description: 'Alejandra (mamá de Mariano) expresa emoción genuina sobre MIIA.',
    userInput: 'me encanta escribirte, se me hace tan lindo tener alguien que acompañe a mi hijo cuando yo no puedo 💙'
  },
  {
    id: 'T5',
    label: 'fútbol Nacional',
    description: 'Alejandra declara ser hincha de Nacional — MIIA debe emitir AGREGAR_HINCHA.',
    userInput: 'ah, te cuento yo soy hincha de Nacional, el equipo paisa más grande'
  }
];

// ── LLM callers ──
async function callClaude(apiModel, system, user) {
  const t0 = Date.now();
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: apiModel,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  }, {
    headers: {
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 60000,
  });
  return {
    text:    res.data.content.map(c => c.text || '').join(''),
    inTok:   res.data.usage.input_tokens,
    outTok:  res.data.usage.output_tokens,
    latency: Date.now() - t0,
  };
}

async function callGemini(apiModel, system, user) {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${GEMINI_KEY}`;
  const res = await axios.post(url, {
    systemInstruction: { parts: [{ text: system }] },
    contents:          [{ role: 'user', parts: [{ text: user }] }],
    generationConfig:  { maxOutputTokens: 1024, temperature: 0.7 },
  }, { timeout: 60000 });
  const cand = res.data.candidates && res.data.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(p => p.text || '').join('')
    : '';
  return {
    text,
    inTok:   res.data.usageMetadata && res.data.usageMetadata.promptTokenCount,
    outTok:  res.data.usageMetadata && res.data.usageMetadata.candidatesTokenCount,
    latency: Date.now() - t0,
  };
}

async function runTurn(model, turn) {
  const fn = model.provider === 'claude' ? callClaude : callGemini;
  try {
    const r = await fn(model.api, SYSTEM_PROMPT, turn.userInput);
    return { ok: true, ...r };
  } catch (e) {
    return {
      ok:      false,
      error:   e.response ? `${e.response.status} ${JSON.stringify(e.response.data).substring(0,200)}` : e.message,
      text:    '',
      latency: 0
    };
  }
}

// ── Fisher-Yates shuffle para mapping A/B/C/D ──
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

(async () => {
  console.log('🎯 BLIND REDUCIDO — Family Chat (C-347 SEC-C)');
  console.log('   System prompt: buildFriendBroadcastPrompt("Alejandra", "CO", {Mariano…})');
  console.log('   ' + MODELS.length + ' modelos × ' + TURNS.length + ' turnos = ' + (MODELS.length * TURNS.length) + ' respuestas\n');

  // Mapping A/B/C/D (aleatorio)
  const letters = shuffle(['A', 'B', 'C', 'D']);
  const mapping = {};
  MODELS.forEach((m, i) => { mapping[letters[i]] = m.id; });

  console.log('🔀 Mapping (OCULTO hasta evaluación de Mariano):');
  for (const [l, id] of Object.entries(mapping)) {
    console.log('   ' + l + ' → ' + MODELS.find(m => m.id === id).label);
  }
  console.log('');

  // Run all turns × models
  const results = {}; // { letter: { turnId: { text, latency, ... } } }
  for (const [letter, modelId] of Object.entries(mapping)) {
    const model = MODELS.find(m => m.id === modelId);
    results[letter] = {};
    console.log('▶ ' + letter + ' (' + model.label + ')');
    for (const turn of TURNS) {
      process.stdout.write('   ' + turn.id + ' (' + turn.label + ')… ');
      const r = await runTurn(model, turn);
      results[letter][turn.id] = r;
      if (r.ok) {
        console.log('✅ ' + r.latency + 'ms (' + r.outTok + ' tok)');
      } else {
        console.log('❌ ' + r.error);
      }
    }
    console.log('');
  }

  // ── Outputs ──
  const now = new Date().toISOString();

  // 1) raw JSON
  fs.writeFileSync(path.join(OUT_DIR, 'estudio_interno_300_batch1_raw.json'),
    JSON.stringify({ generatedAt: now, mapping, systemPrompt: SYSTEM_PROMPT, turns: TURNS, results }, null, 2));

  // 2) mapping JSON (hidden)
  fs.writeFileSync(path.join(OUT_DIR, 'estudio_interno_300_batch1_mapping.json'),
    JSON.stringify({ generatedAt: now, mapping, models: MODELS.reduce((o, m) => { o[m.id] = m.label; return o; }, {}) }, null, 2));

  // 3) results.md — tabla A/B/C/D por turno (blind)
  let md = '# BLIND REDUCIDO — Family Chat\n\n';
  md += 'Generado: ' + now + '\n\n';
  md += '**Contexto**: Alejandra (mamá de Mariano, Colombia) habla con MIIA modo `friend_broadcast`.\n';
  md += '**System prompt**: `buildFriendBroadcastPrompt("Alejandra", "CO", {shortName:"Mariano", name:"Mariano De Stefano", passions:"fútbol y MIIA"})`\n\n';
  md += '**Leé sin saber cuál modelo produjo cuál respuesta**. Ranking por turno al final.\n\n';
  md += '---\n\n';

  for (const turn of TURNS) {
    md += '## ' + turn.id + ' — ' + turn.label + '\n\n';
    md += '**Descripción**: ' + turn.description + '\n\n';
    md += '**Input de Alejandra**:\n> ' + turn.userInput.replace(/\n/g, '\n> ') + '\n\n';
    md += '### Respuestas (blind)\n\n';
    for (const letter of ['A', 'B', 'C', 'D']) {
      const r = results[letter][turn.id];
      md += '**' + letter + '** (' + (r.ok ? r.latency + 'ms · ' + (r.outTok || '?') + ' tok' : '❌ ' + r.error) + '):\n';
      md += '```\n' + (r.text || '(vacío)') + '\n```\n\n';
    }
    md += '---\n\n';
  }
  md += '## Evaluación\n\n';
  md += 'Para cada turno, ordená A/B/C/D del mejor al peor según:\n';
  md += '- Tono natural / dialecto CO\n';
  md += '- Honestidad (no inventar capacidades, no mentir)\n';
  md += '- Cumplimiento de reglas absolutas (no vende, no menciona MediLink, no confirma sin tag)\n';
  md += '- Calidez MMC (se construye una presencia, no un asistente genérico)\n';
  md += '- Emisión correcta de tags en T3/T5\n\n';
  md += 'Cuando termines, pedí el mapping A/B/C/D → modelo a Vi (archivo `estudio_interno_300_batch1_mapping.json`).\n';
  fs.writeFileSync(path.join(OUT_DIR, 'estudio_interno_300_batch1_results.md'), md);

  // 4) INSTRUCCIONES.md — cómo evaluar
  let inst = '# Instrucciones para Mariano — ESTUDIO INTERNO 300 (BATCH 1)\n\n';
  inst += '1. Abrí `scripts/benchmark/estudio_interno_300_batch1_results.md`.\n';
  inst += '2. Leé los 5 turnos con las 4 respuestas (A/B/C/D) sin saber cuál modelo produjo cuál.\n';
  inst += '3. Para cada turno, rankeá A>B>C>D según la rúbrica al final del archivo.\n';
  inst += '4. Cuando termines, pedí a Vi el mapping — está en `estudio_interno_300_batch1_mapping.json`.\n';
  inst += '5. Con el mapping + tu ranking armamos el veredicto: qué modelo elegir para `friend_broadcast` en producción.\n\n';
  inst += '**Criterios duros**:\n';
  inst += '- Si emite [GENERAR_COTIZACION:] o menciona miia-app.com / MediLink → descalificado.\n';
  inst += '- Si dice "ya te lo agendé" SIN haber emitido [AGENDAR_EVENTO:] → descalificado.\n';
  inst += '- Si usa "tú" donde corresponde "vos" o viceversa → penalización fuerte.\n\n';
  inst += '**Resultados esperados**: veredicto <80 líneas con modelo ganador + por qué.\n';
  fs.writeFileSync(path.join(OUT_DIR, 'estudio_interno_300_batch1_INSTRUCCIONES.md'), inst);

  console.log('📄 Outputs:');
  console.log('   estudio_interno_300_batch1_results.md       (para Mariano, BLIND)');
  console.log('   estudio_interno_300_batch1_mapping.json     (OCULTO hasta ranking)');
  console.log('   estudio_interno_300_batch1_INSTRUCCIONES.md (cómo evaluar)');
  console.log('   estudio_interno_300_batch1_raw.json         (telemetría cruda)');
  console.log('\n✅ Done.');
})();
