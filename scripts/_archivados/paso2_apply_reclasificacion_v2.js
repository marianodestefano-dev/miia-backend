/**
 * C-378 PASO 2: Aplicar updates de reclasificación v2 a contact_index (prod).
 *
 * Fuente: backups/prompt_engine_v0/reclasificacion_FULL_574_v2_2026-04-22T02-22-15-246Z.json
 * Autoridades live: familia (12) + team (12) + amigos (14) — 0 overlap.
 *
 * Alcance: SOLO aplica los 32 "destacables" (type_old ≠ type_new + conf ≥ 0.8).
 *   - 13 → family
 *   - 12 → team (reemplazando 'group' o 'lead' previos)
 *   - 7  → friend
 * NO toca los 2 NHR — revisión manual de Mariano (MIIA grupo, doc fantasma papá).
 * NO toca entries sin cambio de type (lead→lead, client→client).
 *
 * Fields actualizados por doc:
 *   type            ← type_new
 *   subtype         ← 'family'|'team'|'friend' (igual que type para estos casos)
 *   confidence      ← 1.0
 *   voice_sample    ← (300 char) si existe — seed Camino D
 *   reclassifiedAt  ← serverTimestamp
 *   reclassifiedBy  ← 'C-378_PASO2_2026-04-22'
 *   reclassificationReason ← reasoning breve
 *   status          ← 'classified'
 *
 * NIVEL 🟠 NARANJA — escritura prod contact_index.
 * Autorización literal Mariano: "avanza!!!" (2026-04-22 tras aprobar PASO 1 v2).
 */
require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

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

const V2_JSON = 'backups/prompt_engine_v0/reclasificacion_FULL_574_v2_2026-04-22T02-25-22-345Z.json';

(async () => {
  console.log('[PASO 2] Cargando v2 JSON...');
  const data = JSON.parse(fs.readFileSync(V2_JSON, 'utf8'));
  const destacables = data.destacables || [];
  console.log(`[PASO 2] Destacables: ${destacables.length}`);

  // ====================================================================
  // SNAPSHOT BEFORE — leer estado actual de los 32 docs a modificar
  // ====================================================================
  console.log('\n=== SNAPSHOT ANTES ===');
  const ciRef = db.collection('users').doc(UID).collection('contact_index');
  const snapshotBefore = [];
  for (const d of destacables) {
    const key = d.docId || d.phone;
    if (!key) {
      console.log(`  ⚠️ SKIP destacable sin docId/phone: ${d.name || '(s/n)'}`);
      continue;
    }
    const doc = await ciRef.doc(key).get();
    snapshotBefore.push({
      docId: key,
      exists: doc.exists,
      type_old: doc.exists ? doc.data().type : '__no_doc__',
      subtype_old: doc.exists ? doc.data().subtype : null,
      name_old: doc.exists ? doc.data().name : null,
      status_old: doc.exists ? doc.data().status : null,
    });
  }
  console.log(`  Snapshot leído: ${snapshotBefore.length} docs`);

  // ====================================================================
  // APPLY UPDATES — 32 destacables
  // ====================================================================
  console.log('\n=== APLICAR UPDATES (merge=true) ===');
  let ok = 0, fail = 0, skip = 0;
  const auditTrail = [];
  for (const d of destacables) {
    const key = d.docId || d.phone;
    if (!key) { skip++; continue; }

    const update = {
      type: d.type_new,
      subtype: d.type_new, // mismo valor, útil para legacy readers
      confidence: 1.0,
      status: 'classified',
      reclassifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      reclassifiedBy: 'C-378_PASO2_2026-04-22',
      reclassificationReason: (d.reasoning || '').slice(0, 300),
    };
    if (d.voice_sample) update.voice_sample = d.voice_sample;

    try {
      await ciRef.doc(key).set(update, { merge: true });
      console.log(`  ✅ ${key} | ${d.type_old} → ${d.type_new} | ${d.name || '(s/n)'}`);
      auditTrail.push({ docId: key, result: 'ok', type_old: d.type_old, type_new: d.type_new });
      ok++;
    } catch (e) {
      console.error(`  ❌ ${key} | ${d.type_old} → ${d.type_new} — ${e.message}`);
      auditTrail.push({ docId: key, result: 'fail', error: e.message });
      fail++;
    }
  }
  console.log(`\n  Resumen: ${ok}/${destacables.length} ok | ${fail} fail | ${skip} skip`);

  // ====================================================================
  // SNAPSHOT AFTER
  // ====================================================================
  console.log('\n=== SNAPSHOT DESPUÉS ===');
  const snapshotAfter = [];
  for (const d of destacables) {
    const key = d.docId || d.phone;
    if (!key) continue;
    const doc = await ciRef.doc(key).get();
    snapshotAfter.push({
      docId: key,
      exists: doc.exists,
      type_new: doc.exists ? doc.data().type : '__no_doc__',
      subtype_new: doc.exists ? doc.data().subtype : null,
      status_new: doc.exists ? doc.data().status : null,
      has_voice_sample: doc.exists ? !!doc.data().voice_sample : false,
      reclassifiedBy: doc.exists ? doc.data().reclassifiedBy : null,
    });
  }

  // ====================================================================
  // BUCKET COUNT END-TO-END (574 docs)
  // ====================================================================
  console.log('\n=== BUCKET COUNT FULL contact_index ===');
  const allSnap = await ciRef.get();
  const buckets = {};
  allSnap.forEach(doc => {
    const t = doc.data().type || '__no_type__';
    buckets[t] = (buckets[t] || 0) + 1;
  });
  console.log(`  Total docs: ${allSnap.size}`);
  Object.entries(buckets).sort((a,b) => b[1] - a[1]).forEach(([t, n]) => {
    console.log(`    ${t.padEnd(25)}: ${n}`);
  });

  // ====================================================================
  // GUARDAR AUDIT
  // ====================================================================
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const auditPath = `backups/prompt_engine_v0/paso2_audit_${ts}.json`;
  fs.writeFileSync(auditPath, JSON.stringify({
    metadata: {
      carta: 'C-378_PASO2',
      timestamp: ts,
      source_json: V2_JSON,
      uid: UID,
      autorizacion: 'Mariano "avanza!!!" 2026-04-22',
      nivel: '🟠 NARANJA',
    },
    counts: { ok, fail, skip, total: destacables.length },
    buckets_after_full_index: buckets,
    snapshot_before: snapshotBefore,
    snapshot_after: snapshotAfter,
    audit_trail: auditTrail,
    destacables_applied: destacables,
    needs_human_review_skipped: data.needs_human_review || [],
  }, null, 2));
  console.log(`\n[PASO 2] Audit guardado: ${auditPath}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  PASO 2 COMPLETO');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Destacables aplicados: ${ok}/${destacables.length}`);
  console.log(`  NHR salteados (review manual): ${(data.needs_human_review || []).length}`);
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(0);
})().catch(e => { console.error('ERR PASO 2:', e.message, e.stack); process.exit(1); });
