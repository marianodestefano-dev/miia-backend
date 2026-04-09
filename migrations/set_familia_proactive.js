'use strict';

/**
 * MIGRACIÓN: Setear proactiveEnabled=true en grupo FAMILIA
 * UID: bq2BbtCVF8cZo30tum584zrGATJ3 (cuenta personal Mariano)
 *
 * Mariano pidió explícitamente: "proactive=true = MIIA puede escribirles sin que ellos la invoquen"
 *
 * USO: node migrations/set_familia_proactive.js
 */

const admin = require('firebase-admin');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

if (!admin.apps.length) {
  let credential = null;
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    pk = pk.replace(/\\n/g, '\n');
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
const GROUP_ID = 'familia';

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log('  MIGRACIÓN: Setear proactiveEnabled=true en grupo FAMILIA');
  console.log('  UID: ' + OWNER_UID);
  console.log('═'.repeat(60) + '\n');

  const groupRef = db.collection('users').doc(OWNER_UID).collection('contact_groups').doc(GROUP_ID);

  // Verificar que el grupo existe
  const doc = await groupRef.get();
  if (!doc.exists) {
    console.error('❌ Grupo familia no existe! Ejecutá primero create_familia_group.js');
    process.exit(1);
  }

  const before = doc.data();
  console.log(`  Estado ANTES: proactiveEnabled = ${before.proactiveEnabled}`);

  // Actualizar
  await groupRef.update({
    proactiveEnabled: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`  Estado DESPUÉS: proactiveEnabled = true`);
  console.log(`\n✅ Grupo familia ahora tiene proactive ACTIVADO`);
  console.log('   MIIA puede escribirles sin que ellos la invoquen\n');

  process.exit(0);
}

run().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
