/**
 * Verifica Firestore miia_agenda para recordatorio Boca 19:20 COT.
 * Si NO existe → MIIA rompió promesa. Avisar Mariano YA.
 */

'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const admin = require('firebase-admin');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }
  const db = admin.firestore();

  console.log('Buscando recordatorio Boca 19:20 hoy 2026-04-28...');
  const today = '2026-04-28';
  const snap = await db.collection('users').doc(MIIA_CENTER_UID)
    .collection('miia_agenda')
    .where('scheduledFor', '>=', `${today}T19:00:00`)
    .where('scheduledFor', '<=', `${today}T20:00:00`)
    .get();

  console.log(`Encontrados ${snap.size} eventos en ventana 19:00-20:00.`);
  for (const doc of snap.docs) {
    const data = doc.data();
    console.log('---');
    console.log(`id: ${doc.id}`);
    console.log(`status: ${data.status}`);
    console.log(`scheduledFor: ${data.scheduledFor}`);
    console.log(`reason: ${data.reason}`);
    console.log(`contactPhone: ${data.contactPhone}`);
    console.log(`source: ${data.source}`);
  }

  // Tambien grep cualquier "boca" en agenda
  console.log('---busqueda libre boca---');
  const all = await db.collection('users').doc(MIIA_CENTER_UID)
    .collection('miia_agenda')
    .where('status', '==', 'pending')
    .limit(20)
    .get();
  console.log(`Pending agenda total: ${all.size}`);
  for (const doc of all.docs) {
    const data = doc.data();
    const reason = (data.reason || '').toLowerCase();
    if (reason.includes('boca') || reason.includes('partido') || reason.includes('cruzeiro') || reason.includes('libertadores')) {
      console.log(`MATCH: ${doc.id} | ${data.scheduledFor} | "${data.reason}" | phone=${data.contactPhone}`);
    }
  }

  setTimeout(() => process.exit(0), 100);
}

main().catch(e => {
  console.error('ERR:', e.message);
  process.exit(1);
});
