'use strict';

/**
 * FIX C-307 — Quitar campo `tanda` del doc de Mariano en contact_index
 *
 * Problema: Mariano (+573163937365) tiene `relation='owner_personal'` Y `tanda='T1'`.
 * El parser T-G (server.js:9431-9500):
 *   - `CONMIGO` → where relation=='owner_personal' → trae Mariano ✅
 *   - `CON TANDA 1` → where tanda=='T1' → trae 13 contactos (incluye Mariano) ❌
 *
 * Fix: Update 1 campo → `tanda: FieldValue.delete()` en el doc 573163937365.
 * Resultado: CONMIGO sigue trayendo Mariano, TANDA 1 trae 12.
 *
 * Idempotente: correrlo de nuevo no rompe (si ya no existe el campo, update no-op).
 *
 * Uso: railway run --service="miia-backend" node migrations/fix_mariano_duplicate_C307.js
 */

const admin = require('firebase-admin');
const path = require('path');
const { initFirebase: initFirebaseShared } = require('../lib/firebase_init');

const OWNER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';   // MIIA CENTER
const MARIANO_PHONE = '573163937365';               // personal

async function main() {
  const ok = initFirebaseShared({ backendRoot: path.join(__dirname, '..') });
  if (!ok) {
    console.error('[FIX-C307] ❌ No se pudo inicializar Firebase');
    process.exit(1);
  }

  const db = admin.firestore();
  const ciRef = db.collection('users').doc(OWNER_UID).collection('contact_index');
  const marianoRef = ciRef.doc(MARIANO_PHONE);

  // READ ANTES
  console.log('[FIX-C307] 🔎 Leyendo doc Mariano ANTES del fix...');
  const beforeSnap = await marianoRef.get();
  if (!beforeSnap.exists) {
    console.error(`[FIX-C307] ❌ Doc ${MARIANO_PHONE} no existe en contact_index`);
    process.exit(1);
  }
  const before = beforeSnap.data();
  console.log('[FIX-C307] ANTES:', JSON.stringify(before, null, 2));

  if (!('tanda' in before)) {
    console.log('[FIX-C307] ℹ️ Campo `tanda` ya no existe en el doc — idempotente OK, nada que hacer');
  } else {
    // UPDATE — borrar solo el campo tanda
    console.log(`[FIX-C307] ✏️ Removiendo campo tanda (valor actual: "${before.tanda}")...`);
    await marianoRef.update({ tanda: admin.firestore.FieldValue.delete() });
    console.log('[FIX-C307] ✅ Update aplicado');
  }

  // READ DESPUÉS
  console.log('[FIX-C307] 🔎 Leyendo doc Mariano DESPUÉS del fix...');
  const afterSnap = await marianoRef.get();
  const after = afterSnap.data();
  console.log('[FIX-C307] DESPUÉS:', JSON.stringify(after, null, 2));

  const hasTandaAfter = 'tanda' in after;
  console.log(`[FIX-C307] Tanda presente después? ${hasTandaAfter ? '❌ SÍ (algo salió mal)' : '✅ NO (correcto)'}`);

  // VERIFICACIÓN 1 — Otro doc de T1 debe seguir intacto (Alejandra)
  console.log('[FIX-C307] 🔎 Verificación: otro doc T1 (Alejandra 573137501884) sigue intacto...');
  try {
    const aleSnap = await ciRef.doc('573137501884').get();
    if (aleSnap.exists) {
      const ale = aleSnap.data();
      console.log(`[FIX-C307]   Alejandra tanda="${ale.tanda}" name="${ale.name}" → ${ale.tanda === 'T1' ? '✅' : '❌'}`);
    } else {
      console.log('[FIX-C307]   ℹ️ Alejandra no existe en contact_index (no bloquea fix Mariano)');
    }
  } catch (e) {
    console.warn('[FIX-C307]   ⚠️ Error leyendo Alejandra (no bloquea):', e.message);
  }

  // VERIFICACIÓN 2 — Counts finales
  console.log('[FIX-C307] 🔎 Counts finales...');
  const t1Snap = await ciRef.where('tanda', '==', 'T1').get();
  const ownerSnap = await ciRef.where('relation', '==', 'owner_personal').get();
  console.log(`[FIX-C307]   tanda==T1 → ${t1Snap.size} contactos (esperado: 12)`);
  console.log(`[FIX-C307]   relation==owner_personal → ${ownerSnap.size} contactos (esperado: 1)`);

  // Resumen
  const t1Ok = t1Snap.size === 12;
  const ownerOk = ownerSnap.size === 1;
  const fixOk = !hasTandaAfter;
  console.log(`[FIX-C307] ============================================================`);
  console.log(`[FIX-C307] RESULTADO: ${fixOk && t1Ok && ownerOk ? '✅ FIX OK' : '❌ REVISAR'}`);
  console.log(`[FIX-C307]   - tanda removida: ${fixOk ? '✅' : '❌'}`);
  console.log(`[FIX-C307]   - T1 count == 12: ${t1Ok ? '✅' : `❌ (${t1Snap.size})`}`);
  console.log(`[FIX-C307]   - owner_personal == 1: ${ownerOk ? '✅' : `❌ (${ownerSnap.size})`}`);
  console.log(`[FIX-C307] ============================================================`);

  process.exit(fixOk && t1Ok && ownerOk ? 0 : 1);
}

main().catch(err => {
  console.error('[FIX-C307] ❌ Error fatal:', err);
  process.exit(1);
});
