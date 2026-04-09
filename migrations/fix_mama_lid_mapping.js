'use strict';

/**
 * FIX: Limpiar LID mapping incorrecto de Mama (Silvia)
 *
 * BUG: El SAFETY NET mapeó el LID 239573292572801 (Mama/Silvia)
 * al teléfono de Papa (5491131313325) porque pushName "." matcheó "Sr. Rafael"
 *
 * Este script:
 * 1. Borra el mapping incorrecto 239573292572801 → 5491131313325
 * 2. NO crea un mapping nuevo (no sabemos el teléfono real de Mama asociado a ese LID)
 *    El mapping correcto se creará cuando WhatsApp sincronice contactos
 *
 * NOTA: El mapping vive en memoria (lidToPhone/phoneToLid en server.js)
 * y se persiste en saveDB. Al reiniciar Railway, se carga desde DB.
 * Este script solo limpia Firestore. Railway debe reiniciarse después.
 *
 * USO: node migrations/fix_mama_lid_mapping.js
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

// AMBAS cuentas — el mapping incorrecto puede estar en cualquiera
const ACCOUNTS = [
  { uid: 'bq2BbtCVF8cZo30tum584zrGATJ3', name: 'MIIA Personal (Mariano)' },
  { uid: 'A5pMESWlfmPWCoCPRbwy85EzUzy2', name: 'MIIA CENTER' },
];

const BAD_LID = '239573292572801'; // LID de Mama que fue mapeado incorrectamente
const WRONG_PHONE = '5491131313325'; // Teléfono de Papa (mapping incorrecto)

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log('  FIX: Limpiar LID mapping incorrecto de Mama');
  console.log('  LID: ' + BAD_LID + ' (Mama/Silvia)');
  console.log('  Mapping incorrecto: → ' + WRONG_PHONE + ' (Papa/Rafael)');
  console.log('═'.repeat(60) + '\n');

  for (const account of ACCOUNTS) {
    console.log(`\n--- ${account.name} (${account.uid}) ---`);

    // Buscar en miia_persistent/lid_mappings si existe
    const persistentRef = db.collection('users').doc(account.uid)
      .collection('miia_persistent').doc('lid_mappings');
    const persistentDoc = await persistentRef.get();

    if (persistentDoc.exists) {
      const data = persistentDoc.data();
      if (data[BAD_LID]) {
        console.log(`  ⚠️ Encontrado en miia_persistent/lid_mappings: ${BAD_LID} → ${data[BAD_LID]}`);
        // Eliminar solo esa key
        await persistentRef.update({
          [BAD_LID]: admin.firestore.FieldValue.delete()
        });
        console.log(`  ✅ ELIMINADO mapping ${BAD_LID} de miia_persistent/lid_mappings`);
      } else {
        console.log(`  ℹ️ ${BAD_LID} NO encontrado en miia_persistent/lid_mappings`);
      }

      // También buscar el inverso
      const inverseKey = `${WRONG_PHONE}@s.whatsapp.net`;
      if (data[inverseKey] === BAD_LID || data[`phone_${WRONG_PHONE}`] === BAD_LID) {
        console.log(`  ⚠️ Encontrado mapping inverso`);
      }
    } else {
      console.log(`  ℹ️ No existe miia_persistent/lid_mappings`);
    }

    // Buscar en miia_persistent/conversations si hay data bajo el LID
    const convoRef = db.collection('users').doc(account.uid)
      .collection('miia_persistent').doc('conversations');
    const convoDoc = await convoRef.get();
    if (convoDoc.exists) {
      const data = convoDoc.data();
      const lidKey = `${BAD_LID}@lid`;
      const lidKeyNoAt = BAD_LID;
      if (data[lidKey] || data[lidKeyNoAt]) {
        console.log(`  ⚠️ Hay conversación guardada bajo LID ${BAD_LID} — esto debería limpiarse manualmente`);
      }
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  ✅ COMPLETADO — Redeploy Railway para que el mapa en memoria se limpie');
  console.log('═'.repeat(60) + '\n');

  process.exit(0);
}

run().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
