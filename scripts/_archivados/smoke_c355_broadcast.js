'use strict';

/**
 * SMOKE LOG C-355 — smartCall FAMILY_CHAT con prompt sanitizado.
 *
 * Dispara buildFriendBroadcastPrompt con perfil corrupto ("Hola Mariano")
 * contra aiGateway.smartCall(CONTEXTS.FAMILY_CHAT, ...) con enableSearch=false.
 * Loguea la respuesta cruda de Gemini a stdout SIN enviar por WhatsApp.
 *
 * Uso:
 *   cd miia-backend && node scripts/smoke_c355_broadcast.js
 *
 * Requiere: GEMINI_API_KEY en env (o dotenv).
 *
 * Wi → Vi (F.5 validación conjunta): el unit test cubre lógica determinística,
 * este smoke cubre que Gemini SÍ genera una respuesta natural con el prompt base
 * reescrito, sin frases tipo "soy una asistente de inteligencia artificial" en
 * la primera burbuja (presentación).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  buildFriendBroadcastPrompt,
  buildMedilinkTeamPrompt,
} = require('../core/prompt_builder');
const { applyMiiaEmoji } = require('../core/miia_emoji');
const aiGateway = require('../ai/ai_gateway');

async function main() {
  const corruptProfile = { name: 'Hola Mariano', shortName: 'Hola' };

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('SMOKE LOG C-355 — Validación F.5');
  console.log('Perfil mockeado: { name: "Hola Mariano", shortName: "Hola" }');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ───────────────────────────────────────────────────────────────
  // CASO 1: FRIEND_BROADCAST AR (voseo) — Cata
  // ───────────────────────────────────────────────────────────────
  const prompt1 = buildFriendBroadcastPrompt('Cata', 'AR', corruptProfile);
  console.log('[CASO 1] FRIEND_BROADCAST AR — contacto: Cata');
  console.log('─── Primeras 200 chars del prompt ───');
  console.log(prompt1.slice(0, 200) + '...\n');

  try {
    const r1 = await aiGateway.smartCall(
      aiGateway.CONTEXTS.FAMILY_CHAT,
      prompt1,
      {},
      { enableSearch: false },
    );
    const raw1 = (r1?.text || r1 || '').trim();
    const final1 = applyMiiaEmoji(raw1, {
      chatType: 'friend_broadcast',
      isFamily: true,
      isAutoPresentation: true,
    });
    console.log('─── RESPUESTA CRUDA Gemini ───');
    console.log(raw1);
    console.log('\n─── RESPUESTA FINAL (applyMiiaEmoji con isAutoPresentation) ───');
    console.log(final1);
    console.log('\n─── CHECKS ───');
    console.log(`  Contiene "Mariano": ${raw1.toLowerCase().includes('mariano') ? '✅' : '❌'}`);
    console.log(`  NO contiene "Hola armó": ${!raw1.includes('Hola armó') ? '✅' : '❌'}`);
    console.log(`  NO contiene "inteligencia artificial": ${!raw1.toLowerCase().includes('inteligencia artificial') ? '✅ (en 1ra burbuja)' : '⚠️ (si contiene, ver si es en capa 3 reactiva)'}`);
    console.log(`  Emoji final arranca "👱‍♀️:": ${final1.startsWith('👱‍♀️:') ? '✅' : '❌'}`);
    console.log(`  NO contiene "🎨": ${!final1.includes('🎨') ? '✅' : '❌'}`);
  } catch (err) {
    console.error('[CASO 1] ❌ Error smartCall:', err.message);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  // ───────────────────────────────────────────────────────────────
  // CASO 2: MEDILINK_TEAM — Sol (no-boss)
  // ───────────────────────────────────────────────────────────────
  const prompt2 = buildMedilinkTeamPrompt('Sol', corruptProfile, { isBoss: false });
  console.log('[CASO 2] MEDILINK_TEAM — contacto: Sol (no-boss)');
  console.log('─── Primeras 200 chars del prompt ───');
  console.log(prompt2.slice(0, 200) + '...\n');

  try {
    const r2 = await aiGateway.smartCall(
      aiGateway.CONTEXTS.FAMILY_CHAT,
      prompt2,
      {},
      { enableSearch: false },
    );
    const raw2 = (r2?.text || r2 || '').trim();
    const final2 = applyMiiaEmoji(raw2, {
      chatType: 'medilink_team',
      isFamily: false,
      isAutoPresentation: true,
    });
    console.log('─── RESPUESTA CRUDA Gemini ───');
    console.log(raw2);
    console.log('\n─── RESPUESTA FINAL ───');
    console.log(final2);
    console.log('\n─── CHECKS ───');
    console.log(`  Contiene "Mariano" o "MediLink": ${raw2.toLowerCase().includes('mariano') || raw2.toLowerCase().includes('medilink') ? '✅' : '❌'}`);
    console.log(`  NO contiene "Hola armó": ${!raw2.includes('Hola armó') ? '✅' : '❌'}`);
    console.log(`  Emoji final arranca "👱‍♀️:": ${final2.startsWith('👱‍♀️:') ? '✅' : '❌'}`);
  } catch (err) {
    console.error('[CASO 2] ❌ Error smartCall:', err.message);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('Smoke log terminado. NO se envió nada por WhatsApp.');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[SMOKE] ❌ Falla fatal:', err);
  process.exit(1);
});
