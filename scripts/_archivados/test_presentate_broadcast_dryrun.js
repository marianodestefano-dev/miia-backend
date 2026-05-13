/**
 * TEST PRESENTATE BROADCAST — DRY-RUN
 *
 * Carta origen: C-370 Vi → Wi (corrección de C-369 SEC-D)
 * Autor: Vi 2026-04-21 noche
 *
 * CONTEXTO
 * El comando del owner "MIIA PRESENTATE CONMIGO" / "MIIA PRESENTATE CON TANDA N"
 * dispara un BROADCAST desde el celular del owner a contactos pre-poblados en
 * contact_index (T1=familia, T2=amigos, T3=equipo medilink). Implementado en
 * server.js:9493+ (feature T-G firmada en C-303, prompts reescritos en C-311).
 *
 * Los prompts reales están en core/prompt_builder.js:
 *   - buildFriendBroadcastPrompt(contactName, countryCode, ownerProfile, isFirstInteraction)
 *   - buildMedilinkTeamPrompt(contactName, ownerProfile, options)
 *
 * El handler invoca: aiGateway.smartCall(CONTEXTS.FAMILY_CHAT, prompt, {}, { enableSearch: false })
 * (ver server.js:9553)
 *
 * PROPÓSITO DE ESTE SCRIPT
 * Permitir a Mariano probar esos prompts REALES antes de disparar el broadcast
 * real por WhatsApp. Simula los 3 flujos (CONMIGO / TANDA / COMO MEDILINK_TEAM)
 * contra casos representativos — CERO side-effects.
 *
 * USO
 *   node scripts/test_presentate_broadcast_dryrun.js              # corre los 3 casos
 *   node scripts/test_presentate_broadcast_dryrun.js --case=family
 *   node scripts/test_presentate_broadcast_dryrun.js --case=friend-ar
 *   node scripts/test_presentate_broadcast_dryrun.js --case=medilink
 *   node scripts/test_presentate_broadcast_dryrun.js --case=family --firstInteraction=false
 *
 * LO QUE NO HACE
 * ❌ NO invoca safeSendMessage → cero mensajes de WhatsApp
 * ❌ NO lee contact_index (usa mocks locales)
 * ❌ NO escribe Firestore
 * ❌ NO invoca setTempContactOverride (no toca memoria compartida)
 * ❌ NO modifica los prompts — los usa tal cual están en prompt_builder.js
 *
 * NOTA DE SEGURIDAD
 * Los prompts buildFriendBroadcastPrompt / buildMedilinkTeamPrompt son ZONA
 * SENSIBLE firmada en C-311. Este script NO los modifica. Si Mariano quiere
 * iterar el contenido de los prompts, eso se hace por carta nueva Wi→Vi, NO
 * editando un .md paralelo ni este script.
 */

'use strict';

require('dotenv').config();

const path = require('path');

const {
  buildFriendBroadcastPrompt,
  buildMedilinkTeamPrompt,
} = require('../core/prompt_builder');

const aiGateway = require('../ai/ai_gateway');

// ── Parseo de args ───────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(flag, fallback = null) {
  const prefix = `${flag}=`;
  const found = args.find(a => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  return fallback;
}
const CASE = argVal('--case', 'all');
const FIRST_INTERACTION = argVal('--firstInteraction', 'true') === 'true';

// ── Mock owner (NO lee Firestore) ────────────────────────────────────
const MOCK_OWNER_PROFILE = {
  name: 'Mariano De Stefano',
  shortName: 'Mariano',
  nicknames: ['Mar', 'Marianito'],
  businessName: 'MediLink',
  role: 'fundador',
};

// ── Casos representativos ────────────────────────────────────────────
const CASES = {
  'family': {
    label: 'CONMIGO / TANDA 1 → familia en CO',
    promptFn: () => buildFriendBroadcastPrompt('Silvia', 'AR', MOCK_OWNER_PROFILE, FIRST_INTERACTION),
    userMessage: '¡Hola!',
    notes: [
      'Simula broadcast T1 (familia). Mamá de Mariano en Argentina.',
      'Verificar: voseo AR, tono cálido, NO vende MediLink, menciona MMC.',
    ],
  },
  'friend-ar': {
    label: 'TANDA 2 → amigo cercano AR',
    promptFn: () => buildFriendBroadcastPrompt('Tío Roberto', 'AR', MOCK_OWNER_PROFILE, FIRST_INTERACTION),
    userMessage: '¡Hola!',
    notes: [
      'Simula broadcast T2 (amigo). Variante AR voseo.',
      'Verificar: mismo prompt que family (friend_broadcast comparte builder), tono casual.',
    ],
  },
  'friend-co': {
    label: 'TANDA 2 → amigo cercano CO',
    promptFn: () => buildFriendBroadcastPrompt('Diego', 'CO', MOCK_OWNER_PROFILE, FIRST_INTERACTION),
    userMessage: '¡Hola!',
    notes: [
      'Simula broadcast T2 (amigo) en CO.',
      'Verificar: tuteo CO, expresiones locales, nada de voseo.',
    ],
  },
  'medilink': {
    label: 'COMO MEDILINK_TEAM → equipo MediLink',
    promptFn: () => buildMedilinkTeamPrompt('Vivi', MOCK_OWNER_PROFILE, { isBoss: false }),
    userMessage: '¡Hola!',
    notes: [
      'Simula test owner-self con contact_type=medilink_team.',
      'Verificar: tono profesional, scoped al negocio MediLink, NO menciona miia-app.com.',
    ],
  },
};

function line() {
  console.log('─'.repeat(72));
}
function banner(txt) {
  console.log('═'.repeat(72));
  console.log(`  ${txt}`);
  console.log('═'.repeat(72));
}

async function runCase(key) {
  const c = CASES[key];
  if (!c) {
    console.error(`❌ Caso desconocido: ${key}. Disponibles: ${Object.keys(CASES).join(', ')}`);
    return { key, ok: false };
  }

  banner(`CASO: ${key} — ${c.label}`);
  c.notes.forEach(n => console.log(`· ${n}`));
  console.log(`· isFirstInteraction=${FIRST_INTERACTION}`);
  console.log(`· userMessage="${c.userMessage}"`);
  line();

  const prompt = c.promptFn();
  // aiGateway.smartCall espera (context, prompt, ownerConfig, opts). El prompt
  // ya trae todo el contexto; para testing dry-run se manda como string único
  // igual que hace server.js:9553.
  const promptWithUserTurn = `${prompt}\n\n───\n${c.userMessage}`;

  console.log(`📝 Prompt length: ${promptWithUserTurn.length} chars`);
  console.log('🚀 Invocando aiGateway.smartCall(CONTEXTS.FAMILY_CHAT)...');

  const t0 = Date.now();
  let result;
  try {
    result = await aiGateway.smartCall(
      aiGateway.CONTEXTS.FAMILY_CHAT,
      promptWithUserTurn,
      {},
      { enableSearch: false }
    );
  } catch (err) {
    console.error(`❌ Error en smartCall: ${err.message}`);
    return { key, ok: false, error: err.message };
  }
  const tTotal = Date.now() - t0;

  const text = (result?.text || result || '').toString().trim();
  if (!text) {
    console.error(`❌ Respuesta vacía (provider=${result?.provider}, failedOver=${result?.failedOver})`);
    return { key, ok: false };
  }

  console.log(`✅ Provider: ${result.provider}  failedOver: ${result.failedOver}  latencyMs: ${result.latencyMs}  (total: ${tTotal}ms)`);
  line();
  console.log('📥 RESPUESTA');
  line();
  console.log(text);
  line();
  console.log('');
  return { key, ok: true, tokens: text.length };
}

async function main() {
  banner('TEST PRESENTATE BROADCAST — DRY-RUN  (C-370)');
  console.log(`Prompts reales desde: core/prompt_builder.js (firmados C-311)`);
  console.log(`Handler real que los invoca: server.js:9493+ (T-G, C-303)`);
  console.log(`Owner mock: ${MOCK_OWNER_PROFILE.shortName} (sin Firestore)`);
  console.log('');

  const keys = CASE === 'all'
    ? Object.keys(CASES)
    : [CASE];

  const results = [];
  for (const k of keys) {
    results.push(await runCase(k));
  }

  banner('RESUMEN');
  results.forEach(r => {
    const icon = r.ok ? '✅' : '❌';
    const detail = r.ok ? `${r.tokens} chars` : (r.error || 'falló');
    console.log(`  ${icon} ${r.key} — ${detail}`);
  });
  console.log('');
  console.log('Cero escrituras a Firestore. Cero mensajes WhatsApp.');
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(99);
});
