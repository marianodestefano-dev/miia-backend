'use strict';

/**
 * FIX: Revertir "Cumpleaños de papá" de status:'cancelled' a status:'pending'
 *
 * Bug: CANCELAR_EVENTO marcó el evento equivocado (papá en vez de Sr. Rafael)
 * y además solo cambió Firestore sin tocar Google Calendar.
 *
 * USO: node migrations/fix_cumple_papa_status.js
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

const MARIANO_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

async function fixCumplePapa() {
  console.log('🔍 Buscando eventos cancelados en miia_agenda de Mariano...');

  const agendaRef = db.collection(`users/${MARIANO_UID}/miia_agenda`);
  const snap = await agendaRef.where('status', '==', 'cancelled').get();

  if (snap.empty) {
    console.log('⚠️ No hay eventos con status cancelled');
    return;
  }

  console.log(`📋 Encontrados ${snap.size} eventos cancelados:`);

  let targetDoc = null;

  for (const doc of snap.docs) {
    const data = doc.data();
    console.log(`  - [${doc.id}] "${data.reason}" | contacto: ${data.contactName || 'N/A'} | fecha: ${data.date || 'N/A'}`);

    const reason = (data.reason || '').toLowerCase();
    if (reason.includes('cumpleaños') && reason.includes('papá')) {
      targetDoc = doc;
      console.log(`    ✅ ^^^^ ESTE es el que hay que revertir`);
    }
  }

  if (!targetDoc) {
    console.log('\n⚠️ No encontré un evento cancelled con "Cumpleaños de papá" en reason.');
    console.log('Verificando si ya fue corregido...');

    const allSnap = await agendaRef.get();
    for (const doc of allSnap.docs) {
      const data = doc.data();
      const reason = (data.reason || '').toLowerCase();
      if (reason.includes('cumpleaños') && reason.includes('papá')) {
        console.log(`  Encontrado: [${doc.id}] "${data.reason}" status="${data.status}"`);
        if (data.status === 'pending') {
          console.log('  ✅ Ya está en pending. No hay nada que hacer.');
        }
      }
    }
    return;
  }

  const targetData = targetDoc.data();
  console.log(`\n🔧 Revirtiendo "${targetData.reason}" (${targetDoc.id})...`);
  console.log(`   status: cancelled → pending`);
  console.log(`   Removiendo: cancelledAt, cancelMode`);

  await targetDoc.ref.update({
    status: 'pending',
    cancelledAt: admin.firestore.FieldValue.delete(),
    cancelMode: admin.firestore.FieldValue.delete(),
    fixedAt: new Date().toISOString(),
    fixNote: 'Revertido por script — CANCELAR_EVENTO borró evento equivocado (Sesión 42)'
  });

  // Verificar
  const updated = await targetDoc.ref.get();
  const updatedData = updated.data();
  console.log(`\n✅ CORREGIDO: "${updatedData.reason}" ahora tiene status="${updatedData.status}"`);
  console.log('🎉 Fix aplicado exitosamente.');
}

fixCumplePapa()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
