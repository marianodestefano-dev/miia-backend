/**
 * test_v2_smoke.js — B.1 smoke test pre-push C-388 (corrección scope C-386)
 *
 * Verifica que los 4 componentes V2 (loader + splitter + emoji + auditor) funcionan
 * end-to-end SIN llamar a Gemini real (el smoke valida pipeline lógico, no LLM).
 *
 * SCOPE ETAPA 1 (firmado Mariano C-388 D.1 verbatim):
 *   - Solo MIIA CENTER (UID A5pMESWlfmPWCoCPRbwy85EzUzy2) usa V2.
 *   - Subregistros activos en MIIA CENTER: lead / client / follow_up_cold / owner_selfchat.
 *   - Subregistros INACTIVOS en MIIA CENTER: family / friend_* / ale_pareja / medilink_team.
 *   - MIIA Personal (bq2...) corre V1 puro hasta etapa 2 (firma futura).
 *
 * Si CUALQUIER caso falla → exit code 1 → push BLOQUEADO.
 *
 * Casos:
 *   T1     — owner_selfchat MIIA CENTER: snapshot completo + split_moderado
 *   T-LEAD — lead/miia_lead colombiano: paredón + auditor pasa
 *   T-CLI  — client/miia_client: subregistro 2.2
 *   T-FOL  — follow_up_cold: subregistro 2.3
 *   INY-2  — RF#8 "soy una asistente de IA" en lead → CRÍTICO + regenerate
 *   INY-3  — GUARD UID: UID Personal o random → resolveV2ChatType='unknown' (V1 puro)
 *
 * Uso: cd miia-backend && node scripts/test_v2_smoke.js
 */

'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const {
  resolveV2ChatType,
  loadVoiceDNAForGroup,
  isV2EligibleUid,
  getLoaderStats,
  MIIA_CENTER_UID,
  OWNER_PERSONAL_UID,
} = require('../core/voice_v2_loader');
const { splitBySubregistro, getSplitMode } = require('../core/split_smart_heuristic');
const { injectInBubbleArray } = require('../core/emoji_injector');
const { auditV2Response, getFallbackByChatType } = require('../core/v2_auditor');

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
console.log('B.1 SMOKE TEST V2 — C-388 corrección scope MIIA CENTER pre-push');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ════════════════════════════════════════════════════════════════
// T1 — owner_selfchat MIIA CENTER
// ════════════════════════════════════════════════════════════════
console.log('T1 — owner_selfchat MIIA CENTER: snapshot completo + split_moderado');
{
  const chatType = resolveV2ChatType({ uid: MIIA_CENTER_UID, isSelfChat: true });
  check('T1.1 resolveV2ChatType uid=CENTER + isSelfChat=true → owner_selfchat', chatType === 'owner_selfchat', `got: ${chatType}`);

  const dna = loadVoiceDNAForGroup(chatType, { ownerName: 'Mariano' });
  check('T1.2 loader devuelve systemBlock no vacío', !!dna.systemBlock && dna.systemBlock.length > 1000, `chars: ${dna.systemBlock?.length}`);
  check('T1.3 loader subregistro indica owner_selfchat', dna.subregistro === 'owner_selfchat' || dna.subregistro === 'owner_selfchat_snapshot', `got: ${dna.subregistro}`);
  check('T1.4 loader fallback=false', dna.fallback === false, `fallback: ${dna.fallback}`);

  const mode = getSplitMode(chatType);
  check('T1.5 splitMode=split_moderado', mode === 'split_moderado', `got: ${mode}`);

  const longText = 'Hola Mariano. ' + 'Lo reviso y te confirmo en un rato. '.repeat(20);
  const parts = splitBySubregistro(longText, chatType);
  check('T1.6 splitter monolítico largo → varias burbujas', parts.length > 1, `parts: ${parts.length}, total: ${longText.length}c`);

  const audit = auditV2Response('Dale Mariano, listo eso 🤗', chatType, {});
  check('T1.7 auditor self-chat respuesta limpia → ok', audit.ok && !audit.flagged, `flagged: ${audit.flagged}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// T-LEAD — lead colombiano MIIA CENTER (también testa miia_lead → lead)
// ════════════════════════════════════════════════════════════════
console.log('T-LEAD — lead/miia_lead MIIA CENTER: paredón + auditor pasa');
{
  // Variante a — contactType 'lead' clásico
  const chatTypeA = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
    isSelfChat: false,
    contactType: 'lead',
    basePhone: '573001234567',
    countryCode: 'CO',
  });
  check('TL.1a resolveV2ChatType lead → lead', chatTypeA === 'lead', `got: ${chatTypeA}`);

  // Variante b — contactType 'miia_lead' (postprocess MIIA CENTER usa ese)
  const chatTypeB = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
    isSelfChat: false,
    contactType: 'miia_lead',
    basePhone: '573001234567',
    countryCode: 'CO',
  });
  check('TL.1b resolveV2ChatType miia_lead → lead (mapping CLAUDE.md §2)', chatTypeB === 'lead', `got: ${chatTypeB}`);

  const dna = loadVoiceDNAForGroup('lead');
  check('TL.2 loader contiene "Quedo atento"', !!dna.systemBlock && /Quedo\s+atento/i.test(dna.systemBlock), 'frase-firma esperada');

  const mode = getSplitMode('lead');
  check('TL.3 splitMode=paredon', mode === 'paredon', `got: ${mode}`);

  const input = ['Hola Dr. Pedro!', 'Mucho gusto, soy Mariano de MediLink.', 'Cuénteme un poco más sobre su clínica.'];
  const parts = splitBySubregistro(input, 'lead');
  check('TL.4 splitter lead colapsa 3 partes a paredón único', parts.length === 1, `parts: ${parts.length}`);

  const audit = auditV2Response('Hola Dr. Pedro, mucho gusto. Cuénteme un poco más sobre su clínica para asesorarlo mejor 🤗', 'lead', {});
  check('TL.5 auditor lead respuesta limpia → ok', audit.ok && !audit.flagged, `flagged: ${audit.flagged}, critical: ${audit.criticalFlags.map(f=>f.code).join(',')}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// T-CLI — client/miia_client MIIA CENTER
// ════════════════════════════════════════════════════════════════
console.log('T-CLI — client/miia_client MIIA CENTER: subregistro 2.2 clientes_medilink');
{
  const chatTypeA = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
    isSelfChat: false,
    contactType: 'client',
    basePhone: '573009998877',
    countryCode: 'CO',
  });
  check('TC.1a resolveV2ChatType client → client', chatTypeA === 'client', `got: ${chatTypeA}`);

  const chatTypeB = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
    isSelfChat: false,
    contactType: 'miia_client',
    basePhone: '573009998877',
    countryCode: 'CO',
  });
  check('TC.1b resolveV2ChatType miia_client → client', chatTypeB === 'client', `got: ${chatTypeB}`);

  const dna = loadVoiceDNAForGroup('client');
  check('TC.2 loader systemBlock no vacío para client', !!dna.systemBlock && dna.systemBlock.length > 200, `chars: ${dna.systemBlock?.length}`);
  check('TC.3 loader fallback=false', dna.fallback === false, `fallback: ${dna.fallback}`);

  const audit = auditV2Response('Hola, claro que sí, te lo reviso ya mismo 🤗', 'client', {});
  check('TC.4 auditor client respuesta limpia → ok', audit.ok && !audit.flagged, `flagged: ${audit.flagged}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// T-FOL — follow_up_cold MIIA CENTER
// ════════════════════════════════════════════════════════════════
console.log('T-FOL — follow_up_cold MIIA CENTER: subregistro 2.3');
{
  const chatTypeA = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
    isSelfChat: false,
    contactType: 'follow_up_cold',
    basePhone: '573009998877',
    countryCode: 'CO',
  });
  check('TF.1a resolveV2ChatType follow_up_cold → follow_up_cold', chatTypeA === 'follow_up_cold', `got: ${chatTypeA}`);

  const chatTypeB = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
    isSelfChat: false,
    contactType: 'cold',
    basePhone: '573009998877',
    countryCode: 'CO',
  });
  check('TF.1b resolveV2ChatType cold → follow_up_cold', chatTypeB === 'follow_up_cold', `got: ${chatTypeB}`);

  const dna = loadVoiceDNAForGroup('follow_up_cold');
  check('TF.2 loader systemBlock no vacío para follow_up_cold', !!dna.systemBlock && dna.systemBlock.length > 200, `chars: ${dna.systemBlock?.length}`);
  check('TF.3 loader fallback=false', dna.fallback === false, `fallback: ${dna.fallback}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// INY-2 — RF#8 "soy una asistente de IA" en chat lead → CRÍTICO
// ════════════════════════════════════════════════════════════════
console.log('INY-2 — RF#8 admite IA en chat con lead → CRÍTICO');
{
  const chatType = resolveV2ChatType({
    uid: MIIA_CENTER_UID,
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

  const audit2 = auditV2Response(candidate, chatType, { lastContactMessage: 'hola', attemptNumber: 2 });
  check('INY2.6 fallback lead = "Vale, dejame revisarlo y vuelvo en un rato 🤗"', audit2.fallback === 'Vale, dejame revisarlo y vuelvo en un rato 🤗', `got: ${audit2.fallback}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// INY-3 — GUARD UID: UID Personal o random → resolveV2ChatType='unknown' (V1 puro)
// ════════════════════════════════════════════════════════════════
console.log('INY-3 — GUARD UID: solo MIIA CENTER pasa, Personal y random caen a unknown');
{
  // 3.1 — isV2EligibleUid solo true para MIIA CENTER
  check('INY3.1 isV2EligibleUid(CENTER) → true', isV2EligibleUid(MIIA_CENTER_UID) === true, `got: ${isV2EligibleUid(MIIA_CENTER_UID)}`);
  check('INY3.2 isV2EligibleUid(PERSONAL bq2) → false', isV2EligibleUid(OWNER_PERSONAL_UID) === false, `got: ${isV2EligibleUid(OWNER_PERSONAL_UID)}`);
  check('INY3.3 isV2EligibleUid(random uid) → false', isV2EligibleUid('xyz123randomuid') === false, `got: ${isV2EligibleUid('xyz123randomuid')}`);
  check('INY3.4 isV2EligibleUid(undefined) → false', isV2EligibleUid(undefined) === false, `got: ${isV2EligibleUid(undefined)}`);
  check('INY3.5 isV2EligibleUid(null) → false', isV2EligibleUid(null) === false, `got: ${isV2EligibleUid(null)}`);

  // 3.2 — resolveV2ChatType retorna 'unknown' para UID Personal aunque sea self-chat o lead
  const r1 = resolveV2ChatType({ uid: OWNER_PERSONAL_UID, isSelfChat: true });
  check('INY3.6 resolveV2ChatType(uid=PERSONAL, isSelfChat) → unknown (no V2 path)', r1 === 'unknown', `got: ${r1}`);

  const r2 = resolveV2ChatType({ uid: OWNER_PERSONAL_UID, contactType: 'lead', basePhone: '573001234567' });
  check('INY3.7 resolveV2ChatType(uid=PERSONAL, lead) → unknown', r2 === 'unknown', `got: ${r2}`);

  const r3 = resolveV2ChatType({ uid: 'random_other_owner', contactType: 'client', basePhone: '573009998877' });
  check('INY3.8 resolveV2ChatType(uid=random, client) → unknown', r3 === 'unknown', `got: ${r3}`);

  // 3.3 — Subregistros INACTIVOS (family/equipo/ale phone) en MIIA CENTER también dan 'unknown'
  const r4 = resolveV2ChatType({ uid: MIIA_CENTER_UID, contactType: 'familia', basePhone: '5491164431700' });
  check('INY3.9 resolveV2ChatType(uid=CENTER, familia) → unknown (etapa 1 no incluye family)', r4 === 'unknown', `got: ${r4}`);

  const r5 = resolveV2ChatType({ uid: MIIA_CENTER_UID, contactType: 'equipo', basePhone: '56994128069' });
  check('INY3.10 resolveV2ChatType(uid=CENTER, equipo) → unknown (etapa 1 no incluye medilink_team)', r5 === 'unknown', `got: ${r5}`);

  const r6 = resolveV2ChatType({ uid: MIIA_CENTER_UID, contactType: 'group', basePhone: '573137501884' });
  check('INY3.11 resolveV2ChatType(uid=CENTER, group/Ale phone) → unknown (etapa 1 no incluye ale_pareja)', r6 === 'unknown', `got: ${r6}`);
}
console.log('');

// ════════════════════════════════════════════════════════════════
// RESULTADO
// ════════════════════════════════════════════════════════════════
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`RESULTADO: ${pass} pass / ${fail} fail (total ${pass + fail})`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (fail > 0) {
  console.log('\n❌ B.1 FALLÓ — push BLOQUEADO según condición C-388 SEC-C.2');
  console.log('Fallos:');
  for (const f of failures) {
    console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
  }
  process.exit(1);
}

console.log('\n✅ B.1 OK — push autorizado');
console.log('Loader stats:', JSON.stringify(getLoaderStats(), null, 2));
process.exit(0);
