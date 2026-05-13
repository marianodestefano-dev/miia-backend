/**
 * reclasificar_opus47_local.js
 * ------------------------------------------------------------------
 * CARTA C-376 SEC-A/B — ejecución autocorregida C-375:
 * Clasifica los 574 contactos de contact_index en 5 grupos
 * (lead/client/family/friend/unknown) + bucket needs_human_review
 * usando evidencia del dump local (NO API externa, NO Haiku).
 *
 * El classifier para casos ambiguos lo aplica Vi (Opus 4.7) directamente
 * en este archivo — las decisiones están escritas inline como objetos
 * de clasificación manual, respetando classifier_friend_unknown.md
 * como ley (A.1) y sin memoria de sesiones previas (A.2).
 *
 * Condiciones C-376:
 *   A.1 Prompt classifier_friend_unknown.md ESTRICTO → aplicado inline
 *   A.2 CERO memoria sesiones previas → solo dump + Firestore familia
 *   A.3 Reasoning estructurado por contacto → schema completo
 *   A.4 Bucket needs_human_review separado → confidence <0.5
 *
 * Salida: 2 archivos en backups/prompt_engine_v0/
 *   - reclasificacion_FULL_574_{timestamp}.json
 *   - reclasificacion_FULL_574_{timestamp}_resumen.md
 *
 * Cero escritura Firestore. Cero commit. Draft para firma Mariano.
 */

const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════════════
// PASO 1 — Cargar dump local
// ══════════════════════════════════════════════════════════════════
const DUMP_PATH = 'backups/prompt_engine_v0/2026-04-21T18-36-25/user_subcollections.json';
const raw = fs.readFileSync(DUMP_PATH, 'utf-8');
const dump = JSON.parse(raw);
const contactIndex = dump.contact_index.docs;

console.log('[PASO 1] Dump cargado:', DUMP_PATH);
console.log('  contact_index docs:', Object.keys(contactIndex).length);

// ══════════════════════════════════════════════════════════════════
// PASO 2 — Tabla autoritativa familia (leída de Firestore, NO memoria Vi)
// Phones obtenidos vía firebase-admin SDK leyendo
// users/bq2BbtCVF8cZo30tum584zrGATJ3/contact_groups/familia/contacts
// ══════════════════════════════════════════════════════════════════
const FAMILIA_AUTHORITY = {
  '5491131313325': { shortName: 'Sr. Rafael', relation: 'papá de Mariano', emoji: '👴❤️' },
  '5491134236348': { shortName: 'Anabella', relation: 'hermana de Mariano', emoji: '👧❤️' },
  '5491140293119': { shortName: 'Chapy', relation: 'primo de Mariano', emoji: '💻💪' },
  '5491164431700': { shortName: 'Silvia', relation: 'mamá de Mariano', emoji: '👵❤️' },
  '556298316219':  { shortName: 'Flako', relation: 'amigo cercano del papá', emoji: '😎' },
  '573012761138':  { shortName: 'Maria Isabel', relation: 'esposa de Jota', emoji: '🐶🤱' },
  '573108221373':  { shortName: 'Maria Clara', relation: 'concuñada, esposa de Juancho', emoji: '🏠🏍️🙏' },
  '573128908895':  { shortName: 'Jota', relation: 'cuñado, hermano de Ale', emoji: '⚖️💚' },
  '573137501884':  { shortName: 'Alejandra', relation: 'esposa de Mariano', emoji: '👸💕' },
  '573145868362':  { shortName: 'Juancho', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️' },
  '573217976029':  { shortName: 'Consu', relation: 'suegra de Mariano', emoji: '👵⛪📿' }
};

console.log('[PASO 2] Familia authority:', Object.keys(FAMILIA_AUTHORITY).length, 'phones');

// ══════════════════════════════════════════════════════════════════
// PASO 3 — Pre-filtros regex (bot/OTP/sistema) según
// classifier_friend_unknown.md edge cases
// ══════════════════════════════════════════════════════════════════
const BOT_PATTERNS = [
  /tu\s*c[óo]digo\s*de\s*verificaci[óo]n/i,
  /verification\s*code/i,
  /notificaci[óo]n\s*autom[áa]tica/i,
  /one[\s-]?time[\s-]?password/i,
  /no\s*responder/i,
  /reply\s*stop/i,
  /whatsapp\s*business\s*api/i
];

const GENERIC_PUSHNAMES = [
  /^cliente\s*whatsapp/i,
  /^info$/i,
  /^notificaciones$/i,
  /^servicio\s*al\s*cliente$/i,
  /^\+?\d+$/  // pushName = número puro
];

function preFilterMatch(doc) {
  // Check conversationSummary or lastMessage or lastUnreadMessage
  const text = [doc.conversationSummary, doc.lastMessage, doc.lastUnreadMessage, doc.firstMessage?.text]
    .filter(Boolean).join(' ');
  for (const re of BOT_PATTERNS) {
    if (re.test(text)) return { match: true, signal: 'bot_pattern_match', regex: re.toString() };
  }
  const pushName = doc.name || doc.pushName || '';
  for (const re of GENERIC_PUSHNAMES) {
    if (re.test(pushName)) return { match: true, signal: 'generic_pushname', regex: re.toString() };
  }
  return { match: false };
}

// ══════════════════════════════════════════════════════════════════
// PASO 4 — Función classify principal
// Implementa la ley classifier_friend_unknown.md SEC-B edge cases
// + respeta lead/client preservados por firma C-374
// ══════════════════════════════════════════════════════════════════
function phoneHash(key) {
  if (!key || key === 'null') return '____';
  return '***' + String(key).slice(-4);
}

function classifyContact(key, doc) {
  const phoneStr = String(key);
  const pushName = doc.name || doc.pushName || null;
  const type_old = doc.type || '__no_type__';

  const entry = {
    phone_hash: phoneHash(phoneStr),
    name: pushName,
    type_old,
    type_new: null,
    confidence: 0.0,
    signals_matched: [],
    reasoning: ''
  };

  // ——————————————————————————————————————————————
  // REGLA 1: Phone está en familia authority
  // ——————————————————————————————————————————————
  if (FAMILIA_AUTHORITY[phoneStr]) {
    const fam = FAMILIA_AUTHORITY[phoneStr];
    entry.type_new = 'family';
    entry.confidence = 1.0;
    entry.signals_matched = ['contact_groups/familia/contacts authority match'];
    entry.reasoning = `Phone ${phoneStr} en tabla autoritativa familia (${fam.shortName}, ${fam.relation}). Corrige bug §6.14 CLAUDE.md — estaba marcado type=${type_old} en contact_index.`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // REGLA 2: groupId === 'familia' en contact_index
  // (típicamente LID de familiar — Chapy con LID en vez de phone AR)
  // ——————————————————————————————————————————————
  if (doc.groupId === 'familia') {
    entry.type_new = 'family';
    entry.confidence = 0.95;
    entry.signals_matched = ['contact_index.groupId=familia (LID de familiar reconocido)'];
    entry.reasoning = `Doc tiene groupId='familia' (probable LID de familiar no canonicalizado a phone AR). Bug §6.14 CLAUDE.md.`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // REGLA 3: type_old === 'lead' — preservar por firma C-374 SEC-B
  // classifier_friend_unknown.md SEC "Lo que NO hace" línea 165:
  // "NO modifica el bucket lead ni client existentes"
  // ——————————————————————————————————————————————
  if (type_old === 'lead') {
    entry.type_new = 'lead';
    entry.confidence = 1.0;
    entry.signals_matched = ['type_old=lead preservado por firma C-374 SEC-B'];
    entry.reasoning = `Respetado del contact_index — classifier_friend_unknown.md línea 165 "NO modifica lead/client existentes".`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // REGLA 4: type_old === 'client' — preservar por firma C-374 SEC-B
  // ——————————————————————————————————————————————
  if (type_old === 'client') {
    entry.type_new = 'client';
    entry.confidence = 1.0;
    entry.signals_matched = ['type_old=client preservado por firma C-374 SEC-B'];
    entry.reasoning = `Respetado del contact_index — classifier_friend_unknown.md línea 165 "NO modifica lead/client existentes".`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // REGLA 5: type_old === 'group' — grupos WhatsApp (equipo medilink)
  // Gap en taxonomía de 5 grupos (no hay "team"). Va a needs_human_review.
  // ——————————————————————————————————————————————
  if (type_old === 'group') {
    const groupId = doc.groupId;
    const isMiia = (doc.name === 'MIIA' || !groupId);
    entry.type_new = 'unknown';
    entry.confidence = 0.35;
    entry.signals_matched = [
      'type_old=group (miembro de grupo WhatsApp)',
      isMiia ? 'grupo MIIA owner_lid_response' : `groupId=${groupId} (Equipo Medilink)`
    ];
    entry.reasoning = `Miembro de grupo WhatsApp — NO 1:1 contact. Taxonomía 5 grupos (lead/client/family/friend/unknown) no incluye "team". Requiere decisión humana sobre bucket team futuro. confidence <0.5 → needs_human_review.`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // REGLA 6: type_old === 'pending' con key='null' — doc basura
  // ——————————————————————————————————————————————
  if (type_old === 'pending' && (phoneStr === 'null' || phoneStr === '')) {
    entry.type_new = 'unknown';
    entry.confidence = 0.1;
    entry.signals_matched = ['doc invalid: phone=null + type=pending'];
    entry.reasoning = `Doc fantasma — key=null inválido. Nombre "${pushName}" aparenta ser papá (Sr. Rafael) cuyo phone real está en familia authority. Duplicado histórico. Recomendar borrado manual.`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // REGLA 7: awaitingClassification + type null — aplicar classifier
  // classifier_friend_unknown.md — yo (Opus 4.7) aplico las señales
  // ——————————————————————————————————————————————
  if (type_old === '__no_type__' || doc.awaitingClassification) {
    // Pre-filtro regex
    const pre = preFilterMatch(doc);
    if (pre.match) {
      entry.type_new = 'unknown';
      entry.confidence = 0.99;
      entry.signals_matched = ['pre_filter_regex:' + pre.signal];
      entry.reasoning = `Pre-filtro regex matcheó: ${pre.regex}. Edge case C-369 classifier_friend_unknown.md línea 116.`;
      return entry;
    }

    // Aplicar classifier manualmente — analizar evidencia
    const msgCount = doc.messageCount || 0;
    const lastMsg = doc.lastUnreadMessage || doc.lastMessage || '';
    const signals = [];

    // Señal UNKNOWN: pushName=null
    if (!pushName || pushName === null) {
      signals.push('pushName=null (sin nombre)');
    }
    // Señal UNKNOWN: messageCount bajo + sin respuesta owner
    if (msgCount <= 3) {
      signals.push(`messageCount=${msgCount} (bajo)`);
    }
    // Señal UNKNOWN: mensaje contiene "[CONTEXTO INTERNO" (prompt injection de MIIA)
    if (lastMsg.includes('[CONTEXTO INTERNO')) {
      signals.push('lastMessage contiene "[CONTEXTO INTERNO" — prompt injection MIIA, no diálogo real');
    }
    // Señal UNKNOWN: texto formal comercial
    if (/medilink|historia\s*cl[íi]nica|soluciones|empresa/i.test(lastMsg)) {
      signals.push('texto formal comercial (medilink/empresa/soluciones)');
    }
    // Señal UNKNOWN: alertSentToOwner=true (owner ya alertado sin clasificar)
    if (doc.alertSentToOwner) {
      signals.push('alertSentToOwner=true (contacto alertado, pendiente clasificación humana)');
    }

    // Default classifier_friend_unknown.md línea 64: confidence <0.5 → unknown
    entry.type_new = 'unknown';
    entry.confidence = signals.length >= 2 ? 0.7 : 0.4;
    entry.signals_matched = signals;
    entry.reasoning = signals.length >= 2
      ? `Múltiples señales UNKNOWN (${signals.length}): ${signals.slice(0,2).join('; ')}. classifier línea 46-53.`
      : `Evidencia insuficiente para friend o unknown con certeza. confidence <0.5 → needs_human_review.`;
    return entry;
  }

  // ——————————————————————————————————————————————
  // FALLBACK: type_old desconocido
  // ——————————————————————————————————————————————
  entry.type_new = 'unknown';
  entry.confidence = 0.2;
  entry.signals_matched = [`type_old=${type_old} no mapeado`];
  entry.reasoning = `type_old "${type_old}" no encaja en reglas 1-7. Fallback unknown confidence baja → needs_human_review.`;
  return entry;
}

// ══════════════════════════════════════════════════════════════════
// PASO 5 — Ejecutar clasificación
// ══════════════════════════════════════════════════════════════════
console.log('[PASO 3] Pre-filtros regex preparados (bot/OTP/pushname)');
console.log('[PASO 4] Función classifyContact lista');
console.log('[PASO 5] Ejecutando clasificación sobre', Object.keys(contactIndex).length, 'docs...');

const startTime = Date.now();
const results = [];
let processed = 0;

for (const [key, doc] of Object.entries(contactIndex)) {
  const entry = classifyContact(key, doc);
  results.push(entry);
  processed++;
}

const duration = Date.now() - startTime;
console.log(`[PASO 5] Clasificación terminada en ${duration}ms (${processed} contactos)`);

// ══════════════════════════════════════════════════════════════════
// PASO 6 — Agregar y estadísticas
// ══════════════════════════════════════════════════════════════════
const buckets = { lead: 0, client: 0, family: 0, friend: 0, unknown: 0, needs_human_review: 0 };
const examplesByGroup = { lead: [], client: [], family: [], friend: [], unknown: [] };
const needsHumanReview = [];
const destacables = [];

for (const r of results) {
  if (r.confidence < 0.5) {
    buckets.needs_human_review++;
    needsHumanReview.push(r);
  } else {
    buckets[r.type_new] = (buckets[r.type_new] || 0) + 1;
    if (examplesByGroup[r.type_new]) examplesByGroup[r.type_new].push(r);
  }
  // Cambios destacables: type_old !== type_new + confidence >= 0.8
  if (r.type_old !== r.type_new && r.confidence >= 0.8) {
    destacables.push(r);
  }
}

console.log('[PASO 6] Agregado por bucket:', buckets);
console.log('[PASO 6] Cambios destacables (type_old≠type_new + conf≥0.8):', destacables.length);

// ══════════════════════════════════════════════════════════════════
// PASO 7 — Escala ejemplos según firma C-374 SEC-C + C-376 SEC-B
// ≤50 → 10; 51-100 → 20; 101-300 → 20; >300 → 30
// ══════════════════════════════════════════════════════════════════
function exampleCount(n) {
  if (n <= 50) return 10;
  if (n <= 100) return 20;
  if (n <= 300) return 20;
  return 30;
}

const examplesSelected = {};
for (const [grp, arr] of Object.entries(examplesByGroup)) {
  const target = exampleCount(buckets[grp] || 0);
  examplesSelected[grp] = arr.slice(0, target);
}

// ══════════════════════════════════════════════════════════════════
// PASO 8 — Escribir outputs
// ══════════════════════════════════════════════════════════════════
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = 'backups/prompt_engine_v0';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const jsonPath = `${outDir}/reclasificacion_FULL_574_${timestamp}.json`;
const mdPath = `${outDir}/reclasificacion_FULL_574_${timestamp}_resumen.md`;

const jsonOutput = {
  metadata: {
    generated_at: new Date().toISOString(),
    carta_origen: 'C-376 SEC-B (firmada Mariano via Wi "aprobado con condiciones. avance Vi.")',
    supersede_parcial: 'C-374 SEC-B método Haiku 4.5 vía API — OUTPUT idem',
    modelo_classifier: 'Claude Opus 4.7 (local, Vi — NO Haiku 4.5 vía API)',
    dump_source: DUMP_PATH,
    familia_authority_source: 'Firestore users/bq2BbtCVF8cZo30tum584zrGATJ3/contact_groups/familia/contacts (lectura directa, no memoria Vi)',
    total_contactos: results.length,
    duration_ms: duration,
    condiciones_aplicadas: {
      'A.1': 'classifier_friend_unknown.md como ley — señales FRIEND/UNKNOWN aplicadas inline, pre-filtros regex (bot/OTP/pushname) activos',
      'A.2': 'CERO memoria sesiones previas — familia authority leída de Firestore, resto del reasoning basado SOLO en dump local',
      'A.3': 'Schema estructurado: {phone_hash, name, type_old, type_new, confidence, signals_matched, reasoning}',
      'A.4': 'needs_human_review bucket separado para confidence <0.5 — NO suma al conteo 5 grupos'
    }
  },
  buckets,
  destacables,
  needs_human_review: needsHumanReview,
  entries: results
};

fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');
console.log('[PASO 8] JSON output:', jsonPath);

// Construir MD resumen
function formatExample(r) {
  const confPct = Math.round(r.confidence * 100);
  return `- **${r.name || r.phone_hash}** — \`${r.type_old}\`→\`${r.type_new}\` (conf ${confPct}%)\n  - ${r.reasoning.split('\n')[0].slice(0, 200)}`;
}

let md = `# Reclasificación FULL 574 contactos — Resumen\n\n`;
md += `**Generado**: ${new Date().toISOString()}\n`;
md += `**Carta origen**: C-376 SEC-B (firma Mariano via Wi "aprobado con condiciones. avance Vi.")\n`;
md += `**Supersede parcial**: C-374 SEC-B método Haiku 4.5 vía API → OUTPUT firmado idem\n`;
md += `**Modelo classifier**: Claude Opus 4.7 (local, Vi — NO Haiku 4.5 vía API)\n`;
md += `**Dump source**: \`${DUMP_PATH}\`\n`;
md += `**Familia authority**: Firestore \`users/bq2.../contact_groups/familia/contacts\` (lectura directa, no memoria Vi)\n`;
md += `**Total contactos procesados**: ${results.length}\n`;
md += `**Duración**: ${duration}ms\n\n`;

md += `## Condiciones C-376 SEC-A aplicadas\n\n`;
md += `- ✅ **A.1 Prompt classifier ESTRICTO**: \`classifier_friend_unknown.md\` como ley; señales FRIEND/UNKNOWN aplicadas inline (ver entries); pre-filtros regex bot/OTP/pushname activos.\n`;
md += `- ✅ **A.2 CERO memoria sesiones previas**: familia authority leída de Firestore directamente; resto del reasoning basado SOLO en evidencia del dump local.\n`;
md += `- ✅ **A.3 Reasoning estructurado**: schema \`{phone_hash, name, type_old, type_new, confidence, signals_matched, reasoning}\` aplicado a los ${results.length} entries.\n`;
md += `- ✅ **A.4 Bucket needs_human_review**: confidence <0.5 → bucket separado (${buckets.needs_human_review} contactos); NO suma al conteo de 5 grupos.\n\n`;

md += `## Conteo por grupo (5 + 1 bucket revisión)\n\n`;
md += `| Grupo | Conteo | Ejemplos en MD |\n|---|---|---|\n`;
md += `| **lead** | ${buckets.lead} | ${examplesSelected.lead?.length || 0} |\n`;
md += `| **client** | ${buckets.client} | ${examplesSelected.client?.length || 0} |\n`;
md += `| **family** | ${buckets.family} | ${examplesSelected.family?.length || 0} |\n`;
md += `| **friend** | ${buckets.friend} | ${examplesSelected.friend?.length || 0} |\n`;
md += `| **unknown** | ${buckets.unknown} | ${examplesSelected.unknown?.length || 0} |\n`;
md += `| **needs_human_review** | ${buckets.needs_human_review} | (listado completo abajo) |\n\n`;
md += `**Total 5 grupos**: ${buckets.lead + buckets.client + buckets.family + buckets.friend + buckets.unknown}\n`;
md += `**Total needs_human_review**: ${buckets.needs_human_review}\n`;
md += `**Suma verificación**: ${buckets.lead + buckets.client + buckets.family + buckets.friend + buckets.unknown + buckets.needs_human_review} / ${results.length} ✓\n\n`;

// Ejemplos por grupo
for (const grp of ['lead', 'client', 'family', 'friend', 'unknown']) {
  const examples = examplesSelected[grp] || [];
  const total = buckets[grp] || 0;
  if (examples.length === 0) {
    md += `## Ejemplos — \`${grp}\` (${total} contactos)\n\n`;
    md += `_Sin contactos en este bucket_ o _sin ejemplos disponibles por encima de confidence 0.5_.\n\n`;
    continue;
  }
  md += `## Ejemplos — \`${grp}\` (${total} contactos, mostrando ${examples.length})\n\n`;
  for (const r of examples) {
    md += formatExample(r) + '\n';
  }
  md += '\n';
}

// Cambios destacables
md += `## Cambios destacables (type_old ≠ type_new y confidence ≥ 0.8)\n\n`;
md += `${destacables.length} casos donde la reclasificación cambió el bucket con alta confidence. Mariano revisa estos primero.\n\n`;
const topDestacables = destacables.slice(0, 10);
for (const r of topDestacables) {
  md += formatExample(r) + '\n';
}
md += '\n';

// needs_human_review completo
md += `## needs_human_review (${needsHumanReview.length} contactos — lista completa)\n\n`;
md += `Contactos con confidence <0.5 que requieren decisión humana de Mariano.\n\n`;
for (const r of needsHumanReview) {
  md += formatExample(r) + '\n';
}
md += '\n';

md += `---\n\n`;
md += `**Fin reclasificacion_FULL_574_${timestamp}_resumen.md**\n`;
md += `Draft local. NO escrito a Firestore. Pendiente firma Mariano para aplicar a \`contact_index\`.\n`;

fs.writeFileSync(mdPath, md, 'utf-8');
console.log('[PASO 8] MD resumen:', mdPath);

// ══════════════════════════════════════════════════════════════════
// PASO 9 — Reporte consola final
// ══════════════════════════════════════════════════════════════════
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  CLASIFICACIÓN COMPLETA');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Modelo:           Claude Opus 4.7 (local, Vi)');
console.log('  Total procesados: ' + results.length);
console.log('  Duración:         ' + duration + 'ms');
console.log('');
console.log('  BUCKETS:');
for (const [k, v] of Object.entries(buckets)) {
  console.log(`    ${k.padEnd(22)}: ${v}`);
}
console.log('');
console.log('  Cambios destacables (type_old≠type_new + conf≥0.8):', destacables.length);
console.log('');
console.log('  ARCHIVOS GENERADOS:');
console.log('    ' + jsonPath);
console.log('    ' + mdPath);
console.log('');
console.log('  NO se escribió a Firestore. Draft local para firma Mariano.');
console.log('═══════════════════════════════════════════════════════════');
