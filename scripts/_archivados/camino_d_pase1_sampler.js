/**
 * C-378 PASO 3.a-3.c — Camino D pase 1: sampler + sanitización.
 *
 * Lee miia_persistent/training_data_chunk_{0,1,2} (2.27MB) de Firestore.
 * Parse por bloque [LEAD|CLIENTE phone]. Sanitiza PII in-memory.
 * Estratifica muestra: 30 top-volume + 30 mid + 10 low = 70 fragmentos.
 * Output local: backups/prompt_engine_v0/camino_d_muestra_tanda1_{ts}.json
 *
 * PASO 3.d (inferencia Vi/Opus 4.7 local → linguistic_dna_tanda1_DRAFT.json)
 * queda PENDIENTE para turno dedicado con firma viva Mariano (C-379).
 *
 * Schema C-367 E.1-E.2. Condiciones C-376 A.1-A.4 vigentes bajo C-378 SEC-D.
 * NIVEL 🟡 AMARILLO — lectura Firestore + escritura local, cero writes prod.
 */
require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');

if (!admin.apps.length) {
  let pk = process.env.FIREBASE_PRIVATE_KEY;
  if (pk.startsWith('"') || pk.startsWith("'")) pk = pk.slice(1, -1);
  pk = pk.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk,
    }),
  });
}
const db = admin.firestore();
const UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

// ══════════════════════════════════════════════════════════════════
// PASO 3.a — Lectura de chunks
// ══════════════════════════════════════════════════════════════════
async function loadChunks() {
  const mp = db.collection('users').doc(UID).collection('miia_persistent');
  const chunks = [];
  for (let i = 0; i < 3; i++) {
    const doc = await mp.doc(`training_data_chunk_${i}`).get();
    if (!doc.exists) throw new Error(`chunk_${i} no existe`);
    const d = doc.data();
    chunks.push({ index: d.index, content: d.content, chars: (d.content || '').length });
    console.log(`[3.a] chunk_${i}: ${(chunks[i].chars / 1024).toFixed(1)}KB`);
  }
  return chunks;
}

// ══════════════════════════════════════════════════════════════════
// PASO 3.b — Sanitización PII
// ══════════════════════════════════════════════════════════════════
function redactPhone(s) {
  // phones internacionales 8-15 dígitos (E.164 con/sin +)
  return s.replace(/\+?\d{10,15}/g, '[PHONE_REDACTED]');
}
function redactEmail(s) {
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL_REDACTED]');
}
function redactMedilinkId(s) {
  // IDs MediLink típicos: UUID o alfanuméricos largos
  return s.replace(/\b[A-Z0-9]{8,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}-[A-Z0-9]{8,}\b/gi, '[UUID_REDACTED]');
}
function sanitize(text) {
  if (!text) return text;
  let out = redactPhone(text);
  out = redactEmail(out);
  out = redactMedilinkId(out);
  return out;
}

// ══════════════════════════════════════════════════════════════════
// PASO 3.b (cont) — Parse por bloque
// [LEAD 573xxxxxxxxx] o [CLIENTE 573xxxxxxxxx]
// ══════════════════════════════════════════════════════════════════
function parseBlocks(concatenated) {
  // Regex match on labels at start of logical block. Keep phone to group.
  const blockRegex = /\[(LEAD|CLIENTE|LEAD\s|CLIENTE\s)\s*(\+?\d{8,15})\]/gi;
  const matches = [];
  let m;
  while ((m = blockRegex.exec(concatenated)) !== null) {
    matches.push({ type: m[1].trim(), phone: m[2], offset: m.index });
  }
  // build blocks using offsets
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].offset;
    const end = i + 1 < matches.length ? matches[i + 1].offset : concatenated.length;
    const raw = concatenated.slice(start, end);
    blocks.push({
      type: matches[i].type,
      phone: matches[i].phone,
      raw,
      chars: raw.length,
    });
  }
  return blocks;
}

// ══════════════════════════════════════════════════════════════════
// PASO 3.c — Estratificar por volumen y selección muestra
// ══════════════════════════════════════════════════════════════════
function groupByPhone(blocks) {
  const byPhone = {};
  for (const b of blocks) {
    if (!byPhone[b.phone]) byPhone[b.phone] = { phone: b.phone, type: b.type, blocks: [], totalChars: 0 };
    byPhone[b.phone].blocks.push(b);
    byPhone[b.phone].totalChars += b.chars;
  }
  return Object.values(byPhone);
}

function phoneHash(phone) {
  // Últimos 4 dígitos enmascarado: ***1234
  const s = String(phone || '');
  return '***' + s.slice(-4);
}

async function loadMessageCounts() {
  // contact_index messageCount para estratificar por volumen
  const snap = await db.collection('users').doc(UID).collection('contact_index').get();
  const counts = {};
  snap.forEach(d => {
    const data = d.data();
    counts[d.id] = data.messageCount || data.msgCount || 0;
  });
  return counts;
}

function stratifySample(contactsGrouped, messageCounts) {
  // Anotar messageCount desde contact_index
  contactsGrouped.forEach(c => {
    c.messageCount = messageCounts[c.phone] || 0;
    c.effectiveVolume = Math.max(c.messageCount, c.blocks.length);
  });

  // Ordenar por effectiveVolume desc
  contactsGrouped.sort((a, b) => b.effectiveVolume - a.effectiveVolume);

  const top = contactsGrouped.filter(c => c.effectiveVolume >= 50).slice(0, 30);
  const mid = contactsGrouped.filter(c => c.effectiveVolume >= 10 && c.effectiveVolume < 50).slice(0, 30);
  const low = contactsGrouped.filter(c => c.effectiveVolume >= 5 && c.effectiveVolume < 10).slice(0, 10);

  return { top, mid, low };
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  CAMINO D PASE 1 — sampler + sanitización (PASO 3.a-3.c)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('[3.a] Cargando training_data_chunk_{0,1,2}...');
  const chunks = await loadChunks();
  const concatenated = chunks.map(c => c.content).join('\n\n');
  const totalChars = concatenated.length;
  console.log(`[3.a] Concat total: ${(totalChars / 1024 / 1024).toFixed(2)}MB (${totalChars.toLocaleString()} chars)\n`);

  console.log('[3.b] Sanitizando PII (phones/emails/UUIDs)...');
  const sanitized = sanitize(concatenated);
  const redactedCount = (concatenated.match(/\+?\d{10,15}/g) || []).length;
  console.log(`[3.b] Phones redactados: ${redactedCount}`);
  console.log(`[3.b] Chars post-sanitización: ${sanitized.length.toLocaleString()}\n`);

  console.log('[3.b] Parse por bloques [LEAD|CLIENTE phone]...');
  const blocks = parseBlocks(sanitized);
  // Nota: como ya sanitizamos, los phones en matches son [PHONE_REDACTED]
  // Re-parse antes de sanitizar para mantener phones como clave interna
  const blocksRaw = parseBlocks(concatenated);
  console.log(`[3.b] Bloques detectados (pre-sanit): ${blocksRaw.length}`);
  console.log(`[3.b] Bloques post-sanit: ${blocks.length} (esperado igual — regex matchea labels no phones)\n`);

  console.log('[3.c] Agrupando por contacto...');
  const grouped = groupByPhone(blocksRaw);
  console.log(`[3.c] Contactos únicos: ${grouped.length}\n`);

  console.log('[3.c] Cargando messageCount desde contact_index...');
  const counts = await loadMessageCounts();
  console.log(`[3.c] contact_index docs con count: ${Object.keys(counts).length}\n`);

  console.log('[3.c] Estratificando 30 top / 30 mid / 10 low...');
  const sample = stratifySample(grouped, counts);
  console.log(`[3.c] top (≥50): ${sample.top.length}`);
  console.log(`[3.c] mid (10-49): ${sample.mid.length}`);
  console.log(`[3.c] low (5-9): ${sample.low.length}`);
  console.log(`[3.c] total muestra: ${sample.top.length + sample.mid.length + sample.low.length}/70\n`);

  // Sanitizar los bloques de la muestra para output
  const sanitizeBlockForOutput = (b) => ({
    type: b.type,
    raw_sanitized: sanitize(b.raw).slice(0, 8000), // truncar a 8000 chars por fragmento
    chars_original: b.chars,
    chars_sanitized: sanitize(b.raw).length,
  });

  const outputSample = {
    top: sample.top.map(c => ({
      phone_hash: phoneHash(c.phone),
      type: c.type,
      messageCount: c.messageCount,
      blocks_count: c.blocks.length,
      totalChars: c.totalChars,
      blocks_sample: c.blocks.slice(0, 3).map(sanitizeBlockForOutput), // max 3 bloques por contacto
    })),
    mid: sample.mid.map(c => ({
      phone_hash: phoneHash(c.phone),
      type: c.type,
      messageCount: c.messageCount,
      blocks_count: c.blocks.length,
      totalChars: c.totalChars,
      blocks_sample: c.blocks.slice(0, 3).map(sanitizeBlockForOutput),
    })),
    low: sample.low.map(c => ({
      phone_hash: phoneHash(c.phone),
      type: c.type,
      messageCount: c.messageCount,
      blocks_count: c.blocks.length,
      totalChars: c.totalChars,
      blocks_sample: c.blocks.slice(0, 3).map(sanitizeBlockForOutput),
    })),
  };

  // ══════════════════════════════════════════════════════════════════
  // OUTPUT
  // ══════════════════════════════════════════════════════════════════
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = `backups/prompt_engine_v0/camino_d_muestra_tanda1_${ts}.json`;
  fs.writeFileSync(outPath, JSON.stringify({
    metadata: {
      carta: 'C-378 PASO 3.a-3.c',
      timestamp: ts,
      source: 'users/bq2.../miia_persistent/training_data_chunk_{0,1,2}',
      total_chars_input: totalChars,
      total_chars_input_mb: (totalChars / 1024 / 1024).toFixed(2),
      bloques_totales: blocksRaw.length,
      contactos_unicos: grouped.length,
      sanitization: {
        phones_redacted: redactedCount,
        scheme: 'PHONE/EMAIL/UUID → [*_REDACTED]',
        preserved: 'apodos/dialecto/emojis/errores tipográficos',
      },
      estratificacion: {
        top_criterio: 'effectiveVolume ≥ 50',
        mid_criterio: '10 ≤ effectiveVolume < 50',
        low_criterio: '5 ≤ effectiveVolume < 10',
        fuente_messageCount: 'contact_index',
      },
      pending_next: 'PASO 3.d — inferencia Vi/Opus 4.7 local → linguistic_dna_tanda1_DRAFT.json (requiere firma viva Mariano y turno dedicado)',
      condiciones_C376: ['A.1 classifier estricto', 'A.2 cero memoria', 'A.3 reasoning estructurado', 'A.4 NHR bucket separado'],
    },
    sample: outputSample,
  }, null, 2));
  console.log(`\n[OUT] Muestra estratificada: ${outPath}`);

  // Resumen MD
  const md = [
    '# Camino D pase 1 — muestra estratificada tanda 1',
    '',
    `**Generado**: ${new Date().toISOString()}`,
    `**Carta**: C-378 PASO 3.a-3.c`,
    `**Source**: miia_persistent/training_data_chunk_{0,1,2} (${(totalChars / 1024 / 1024).toFixed(2)}MB)`,
    '',
    '## Métricas',
    `- Chars totales input: ${totalChars.toLocaleString()}`,
    `- Bloques [LEAD|CLIENTE phone] detectados: ${blocksRaw.length.toLocaleString()}`,
    `- Contactos únicos: ${grouped.length}`,
    `- Phones redactados: ${redactedCount}`,
    '',
    '## Muestra estratificada',
    `- **top** (volumen ≥50): ${sample.top.length}/30`,
    `- **mid** (10-49): ${sample.mid.length}/30`,
    `- **low** (5-9): ${sample.low.length}/10`,
    `- **total**: ${sample.top.length + sample.mid.length + sample.low.length}/70`,
    '',
    '## Top 10 contactos por volumen',
    '',
    ...sample.top.slice(0, 10).map((c, i) =>
      `${i + 1}. ${phoneHash(c.phone)} (${c.type}) — ${c.messageCount} msgs / ${c.blocks.length} bloques / ${(c.totalChars / 1024).toFixed(1)}KB`
    ),
    '',
    '## PASO 3.d PENDIENTE',
    '',
    'Inferencia Vi/Opus 4.7 local → `linguistic_dna_tanda1_DRAFT.json` (schema C-367).',
    '',
    'Lo que queda por hacer:',
    '1. Vi (Claude Code Opus 4.7) lee los 70 fragmentos sanitizados',
    '2. Extrae tono, latiguillos, registro, modismos, frases características de Mariano-vendedor',
    '3. Genera schema C-367 con secciones: tono, latiguillos, vocabulario, registro, emojis, patrones apertura/cierre',
    '4. Output a `linguistic_dna_tanda1_DRAFT.json` + _resumen.md',
    '5. NO publicar a prompt_registry hasta firma Mariano PASS',
    '',
    'Requiere sesión dedicada con firma viva Mariano (C-378 SEC-D obliga cerrar PASO 2 antes; ya cerrado 2026-04-22 32/32 ok).',
  ].join('\n');
  const mdPath = outPath.replace('.json', '_resumen.md');
  fs.writeFileSync(mdPath, md);
  console.log(`[OUT] Resumen MD:          ${mdPath}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  PASO 3.a-3.c COMPLETO — Muestra lista para PASO 3.d');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message, e.stack); process.exit(1); });
