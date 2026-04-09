'use strict';

/**
 * MIGRACIÓN: Limpiar contact_index de contactos clasificados incorrectamente como lead
 * en la cuenta personal de Mariano (bq2BbtCVF8cZo30tum584zrGATJ3)
 *
 * Los contactos que NO son leads reales (no tienen keyword match) fueron
 * auto-clasificados erróneamente por el bug del auto-classify.
 *
 * USO: node migrations/cleanup_wrong_leads.js [--dry-run]
 */

const admin = require('firebase-admin');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

if (!admin.apps.length) {
  let credential = null;
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    let pk = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk
    });
  } else {
    console.error('❌ Faltan variables de Firebase');
    process.exit(1);
  }
  admin.initializeApp({ credential });
}

const db = admin.firestore();
const OWNER_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';
const DRY_RUN = process.argv.includes('--dry-run');

// Contactos que sabemos que NO son leads (mal clasificados)
// Agregar aquí cualquier teléfono que fue clasificado erróneamente
const WRONG_LEADS = [
  '573174362950',     // Inmobiliaria APTO Veleros 23 (Cami)
  '200055298519135',  // Sebastián (LID) — cliente Medilink, NO lead
  '573137501884',     // Alejandra (esposa) — ya en grupo familia, pero limpiar lead
];

async function run() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  CLEANUP: Eliminar leads mal clasificados del contact_index`);
  console.log(`  UID: ${OWNER_UID}`);
  console.log(`  Modo: ${DRY_RUN ? 'DRY RUN' : 'PRODUCCIÓN'}`);
  console.log(`${'═'.repeat(60)}\n`);

  let cleaned = 0;
  for (const phone of WRONG_LEADS) {
    const ref = db.collection('users').doc(OWNER_UID).collection('contact_index').doc(phone);
    const doc = await ref.get();
    if (doc.exists) {
      const data = doc.data();
      // Solo limpiar si es lead (no tocar si es group/client/enterprise_lead)
      if (data.type === 'lead') {
        if (DRY_RUN) {
          console.log(`[DRY] Eliminar: ${phone} (type=${data.type}, name=${data.name || '-'})`);
        } else {
          await ref.delete();
          console.log(`  ✅ Eliminado: ${phone} (era type=lead, name=${data.name || '-'})`);
        }
        cleaned++;
      } else {
        console.log(`  ⏭️ Skip ${phone}: type=${data.type} (no es lead)`);
      }
    } else {
      console.log(`  ⏭️ Skip ${phone}: no existe en contact_index`);
    }
  }

  // También listar TODOS los leads del contact_index para revisión
  console.log(`\n--- Todos los leads actuales en contact_index ---`);
  const allSnap = await db.collection('users').doc(OWNER_UID).collection('contact_index').where('type', '==', 'lead').get();
  for (const doc of allSnap.docs) {
    const d = doc.data();
    console.log(`  📋 ${doc.id}: name=${d.name || '-'}, biz=${d.businessId || '-'}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${DRY_RUN ? '[DRY RUN]' : '✅ COMPLETADO'}: ${cleaned} leads eliminados`);
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(0);
}

run().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
