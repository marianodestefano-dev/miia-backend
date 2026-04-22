/**
 * test_v2_smoke.js — B.1 smoke test pre-push C-386 sesión 3
 *
 * Verifica que los 4 componentes V2 (loader + splitter + emoji + auditor) funcionan
 * end-to-end SIN llamar a Gemini real (el smoke valida pipeline lógico, no LLM).
 *
 * Si CUALQUIER caso falla → exit code 1 → push BLOQUEADO (condición C-386 SEC-B.1).
 *
 * 6 casos:
 *   T1 — owner_selfchat: loader carga snapshot completo + splitter modo split_moderado (400c)
 *   T2 — family (mamá): loader subregistro 2.4 + splitter breve (140c) + emoji triple 🤗 si peak
 *   T3 — lead colombiano: loader 2.1 + splitter forza paredón (900c) + auditor pasa limpio
 *   T4 — ale_pareja: loader 2.7 + splitter ultra-corto (80c) + emoji 🥰 NO se triplica
 *   INY-1 — RF#7 micu en chat con Vivi (medilink_team) → auditor flag CRÍTICO + hint
 *   INY-2 — RF#8 "soy una asistente de IA" en chat con lead → auditor flag CRÍTICO + hint
 *
 * Uso: cd miia-backend && node scripts/test_v2_smoke.js
 */

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { resolveV2ChatType, loadVoiceDNAForGroup, getLoaderStats } = require('../core/voice_v2_loader');
const { splitBySubregistro, getSplitMode } = require('../core/split_smart_heuristic');
const { injectInBubbleArray } = require('../core/emoji_injector');
const { auditV2Response, getFallbackByChatType } = require('../core/v2_auditor');

const ALE_PHONE = '573137501884';
const VIVI_PHONE = '56994128069';
const MAMA_PHONE = '5491164431700';

let pass = 0, fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ❌ ${name}`);
    if (detail) console.log(`     detalle: ${detail}`);
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('B.1 SMOKE TEST V2 — C-386 sesión 3 pre-push');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ════════════════════════════════════════════════════════════════
// T1 — owner_selfchat
// ════════════════════════════════════════════════════════════════
console.log('T1 — owner_selfchat: snapshot completo + split_moderado 400c');
{
  const chatType = resolveV2ChatType({ isSelfChat: true });
  check('T1.1 resolveV2ChatType isSelfChat=true → owner_selfchat', chatType === 'owner_selfchat', `got: ${chatType}`);

  const dna = loadVoiceDNAForGroup(chatType, { ownerName: 'Mariano' });
  check('T1.2 loader devuelve systemBlock no vacío', !!dna.systemBlock && dna.systemBlock.length > 1000, `chars: ${dna.systemBlock?.length}`);
  check('T1.3 loader subregistro indica owner_selfchat (acepta snapshot)', dna.subregistro === 'owner_selfchat' || dna.subregistro === 'owner_selfchat_snapshot', `got: ${dna.subregistro}`);
  check('T1.4 loader fallback=false', dna.fallback === false, `fallback: ${dna.fallback}`);

  const mode = getSplitMode(chatType);
  check('T1.5 splitMode=split_moderado', mode === 'split_moderado', `got: ${mode}`);

  // Splitter sobre texto monolítico largo (~700c) → debe partirse
  const longText = 'Hola Mariano. ' + 'Lo reviso y te confirmo en un rato. '.repeat(20);
  const parts = splitBySubregistro(longText, chatType);
  check('T1.6 splitter monolítico largo → varias burbujas', parts.length > 1, `parts: ${parts.length}, total: ${longText.length}c`);

  // Auditor sobre respuesta limpia → no debe flagear
  const audit = auditV2Response('Dale Mariano, listo eso 🤗', chatType, {});
  check('T1.7 auditor self-chat respuesta limpia → ok', audit.ok && !audit.flagged, `flagged: ${audit.flagged}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// T2 — family (mamá Silvia, +5491164431700)
// ════════════════════════════════════════════════════════════════
console.log('T2 — family: subregistro 2.4 + split_breve 140c + emoji triple 🤗');
{
  const chatType = resolveV2ChatType({
    isSelfChat: false,
    contactType: 'familia',
    basePhone: MAMA_PHONE,
    countryCode: 'AR',
  });
  check('T2.1 resolveV2ChatType familia → family', chatType === 'family', `got: ${chatType}`);

  const dna = loadVoiceDNAForGroup(chatType);
  check('T2.2 loader systemBlock contiene "Silvia"', !!dna.systemBlock && /Silvia/i.test(dna.systemBlock), 'esperaba mención mamá Silvia en subregistro 2.4');
  check('T2.3 loader systemBlock contiene "Holiiii"', !!dna.systemBlock && /Holiiii/i.test(dna.systemBlock), 'apertura familia');

  const mode = getSplitMode(chatType);
  check('T2.4 splitMode=split_breve', mode === 'split_breve', `got: ${mode}`);

  // Texto largo (>140c, límite family) → splitter divide en breve
  const longText = 'Holiiii ma! Sí, todo bien por acá hoy. Estoy con Vivi resolviendo lo del cliente nuevo.\n\nAcá ando con un montón de cosas pero todo en orden, no te preocupes nada. Apenas termine te llamo y charlamos tranquilos como siempre.\n\nDale, te quiero mucho 🤗';
  const parts = splitBySubregistro(longText, chatType);
  check('T2.5 splitter family divide texto >140c en multiples', parts.length >= 2, `parts: ${parts.length}, longText=${longText.length}c`);

  // Emoji injector sobre array — última burbuja termina en 🤗 → triplica
  const lastWith = ['Hola ma', 'Te quiero 🤗'];
  const r = injectInBubbleArray(lastWith, chatType, { peakLevel: 'high' });
  check('T2.6 emoji injector triplica 🤗 en family/peak=high', r.applied && r.parts[1].endsWith('🤗🤗🤗'), `result: ${JSON.stringify(r.parts)}`);

  const audit = auditV2Response('Holiiii ma! Acá ando 🤗', chatType, {});
  check('T2.7 auditor family respuesta limpia → ok', audit.ok && !audit.flagged, `flagged: ${audit.flagged}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// T3 — lead colombiano: paredón + auditor limpio
// ════════════════════════════════════════════════════════════════
console.log('T3 — lead: subregistro 2.1 + paredón 900c + auditor pasa');
{
  const chatType = resolveV2ChatType({
    isSelfChat: false,
    contactType: 'lead',
    basePhone: '573001234567',
    countryCode: 'CO',
  });
  check('T3.1 resolveV2ChatType lead → lead', chatType === 'lead', `got: ${chatType}`);

  const dna = loadVoiceDNAForGroup(chatType);
  check('T3.2 loader contiene "Quedo atento"', !!dna.systemBlock && /Quedo\s+atento/i.test(dna.systemBlock), 'frase-firma esperada');

  const mode = getSplitMode(chatType);
  check('T3.3 splitMode=paredon', mode === 'paredon', `got: ${mode}`);

  // 3 párrafos como input → splitter forza paredón único
  const input = ['Hola Dr. Pedro!', 'Mucho gusto, soy Mariano de MediLink.', 'Cuénteme un poco más sobre su clínica.'];
  const parts = splitBySubregistro(input, chatType);
  check('T3.4 splitter lead colapsa 3 partes a paredón único', parts.length === 1, `parts: ${parts.length}`);

  // Auditor lead respuesta normal → no flag
  const audit = auditV2Response('Hola Dr. Pedro, mucho gusto. Cuénteme un poco más sobre su clínica para asesorarlo mejor 🤗', chatType, {});
  check('T3.5 auditor lead respuesta limpia → ok', audit.ok && !audit.flagged, `flagged: ${audit.flagged}, critical: ${audit.criticalFlags.map(f=>f.code).join(',')}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// T4 — ale_pareja: ultra-corto + emoji 🥰 NO triplicar
// ════════════════════════════════════════════════════════════════
console.log('T4 — ale_pareja: subregistro 2.7 + ultra-corto 80c + 🥰 sin triplicar');
{
  const chatType = resolveV2ChatType({
    isSelfChat: false,
    contactType: 'group', // viene como group sin classify específico
    basePhone: ALE_PHONE,
    countryCode: 'CO',
  });
  check('T4.1 resolveV2ChatType Ale phone override → ale_pareja', chatType === 'ale_pareja', `got: ${chatType}`);

  const dna = loadVoiceDNAForGroup(chatType);
  check('T4.2 loader contiene "micu"', !!dna.systemBlock && /micu/i.test(dna.systemBlock), 'vocativo Ale esperado');
  check('T4.3 loader contiene "🥰"', !!dna.systemBlock && /🥰/.test(dna.systemBlock), 'emoji Ale esperado');

  const mode = getSplitMode(chatType);
  check('T4.4 splitMode=split_ultra_corto', mode === 'split_ultra_corto', `got: ${mode}`);

  // Texto largo → splitter divide en chunks <=80c
  const longText = 'Te amo micu micu, todo bien acá. Salí del médico hace un rato y voy en camino. Llego en 20 min.';
  const parts = splitBySubregistro(longText, chatType);
  check('T4.5 splitter ale divide >1 burbuja para texto >80c', parts.length >= 2, `parts: ${parts.length}, total: ${longText.length}c`);

  // Emoji injector con 🥰 → NO triplica (🥰 no está en TRIPLE_EMOJIS)
  const r = injectInBubbleArray(['Te amo micu 🥰'], chatType, { peakLevel: 'explosive' });
  check('T4.6 emoji injector NO triplica 🥰 (no en TRIPLE_EMOJIS)', !r.applied, `applied: ${r.applied}, reason: ${r.details?.reason}`);

  // Pero SÍ triplica 🤗 en ale si está al final
  const r2 = injectInBubbleArray(['Dale amor 🤗'], chatType, { peakLevel: 'high' });
  check('T4.7 emoji injector triplica 🤗 en ale_pareja', r2.applied && r2.parts[0].endsWith('🤗🤗🤗'), `parts: ${JSON.stringify(r2.parts)}`);

  // Auditor ale con micu → NO flag (es su chat)
  const audit = auditV2Response('Hola micu, te amo 🥰', chatType, { basePhone: ALE_PHONE });
  check('T4.8 auditor ale_pareja con micu/🥰 → ok (es su chat)', audit.ok && !audit.flagged, `flagged: ${audit.flagged}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// INY-1 — RF#7 micu/🥰 en chat con Vivi (medilink_team) → CRÍTICO
// ════════════════════════════════════════════════════════════════
console.log('INY-1 — RF#7 leak Ale en chat Vivi (medilink_team) → CRÍTICO');
{
  const chatType = resolveV2ChatType({
    isSelfChat: false,
    contactType: 'equipo',
    basePhone: VIVI_PHONE,
    countryCode: 'CL',
  });
  check('INY1.1 resolveV2ChatType equipo → medilink_team', chatType === 'medilink_team', `got: ${chatType}`);

  const candidate = 'Vale Vivi, gracias micu 🥰';
  const audit = auditV2Response(candidate, chatType, { basePhone: VIVI_PHONE, attemptNumber: 1 });
  check('INY1.2 auditor flagged=true', audit.flagged === true, `flagged: ${audit.flagged}`);
  check('INY1.3 RF7_exclusividad_ale en criticalFlags', !!audit.criticalFlags.find(f => f.code === 'RF7_exclusividad_ale'), `flags: ${audit.criticalFlags.map(f=>f.code).join(',')}`);
  check('INY1.4 shouldRegenerate=true (1er intento)', audit.shouldRegenerate === true, `shouldRegenerate: ${audit.shouldRegenerate}`);
  check('INY1.5 hint contiene "PROHIBIDO" + "Ale"', !!audit.hint && /PROHIBIDO/i.test(audit.hint) && /Ale/i.test(audit.hint), 'hint debe instruir al modelo');

  // Simular 2do intento que vuelve a fallar → fallback §8
  const audit2 = auditV2Response(candidate, chatType, { basePhone: VIVI_PHONE, attemptNumber: 2 });
  check('INY1.6 attemptNumber=2 + flag → shouldUseFallback=true', audit2.shouldUseFallback === true, `shouldUseFallback: ${audit2.shouldUseFallback}`);
  check('INY1.7 fallback medilink_team = "Vale, dejame revisarlo y vuelvo en un rato 🤗"', audit2.fallback === 'Vale, dejame revisarlo y vuelvo en un rato 🤗', `got: ${audit2.fallback}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// INY-2 — RF#8 "soy una asistente de IA" en chat lead → CRÍTICO
// ════════════════════════════════════════════════════════════════
console.log('INY-2 — RF#8 admite IA en chat con lead → CRÍTICO');
{
  const chatType = resolveV2ChatType({
    isSelfChat: false,
    contactType: 'lead',
    basePhone: '573001234567',
    countryCode: 'CO',
  });
  check('INY2.1 resolveV2ChatType lead → lead', chatType === 'lead', `got: ${chatType}`);

  const candidate = 'Hola Dr. Pedro, soy una asistente de IA que automatiza estos mensajes';
  const audit = auditV2Response(candidate, chatType, { lastContactMessage: 'hola', attemptNumber: 1 });
  check('INY2.2 auditor flagged=true', audit.flagged === true, `flagged: ${audit.flagged}`);
  check('INY2.3 RF8_no_ia_con_leads en criticalFlags', !!audit.criticalFlags.find(f => f.code === 'RF8_no_ia_con_leads'), `flags: ${audit.criticalFlags.map(f=>f.code).join(',')}`);
  check('INY2.4 shouldRegenerate=true', audit.shouldRegenerate === true, `shouldRegenerate: ${audit.shouldRegenerate}`);
  check('INY2.5 hint contiene "PROHIBIDO admitir ser IA"', !!audit.hint && /PROHIBIDO/i.test(audit.hint) && /IA/i.test(audit.hint), 'hint debe instruir al modelo');

  // 2do intento → fallback §8 lead
  const audit2 = auditV2Response(candidate, chatType, { lastContactMessage: 'hola', attemptNumber: 2 });
  check('INY2.6 fallback lead = "Vale, dejame revisarlo y vuelvo en un rato 🤗"', audit2.fallback === 'Vale, dejame revisarlo y vuelvo en un rato 🤗', `got: ${audit2.fallback}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// RESULTADO
// ════════════════════════════════════════════════════════════════
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`RESULTADO: ${pass} pass / ${fail} fail (total ${pass + fail})`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (fail > 0) {
  console.log('\n❌ B.1 FALLÓ — push BLOQUEADO según condición C-386 SEC-B.1');
  console.log('Fallos:');
  for (const f of failures) {
    console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
  }
  process.exit(1);
}

console.log('\n✅ B.1 OK — push autorizado');
console.log('Loader stats:', JSON.stringify(getLoaderStats(), null, 2));
process.exit(0);
