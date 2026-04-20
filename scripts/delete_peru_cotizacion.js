#!/usr/bin/env node
// Borra cotización de Perú (hash 3617b60d) de Firestore.
// Motivo: Mariano no pasó precios en soles (PEN). Se regenera cuando tengamos.

const admin = require('firebase-admin');
const path  = require('path');

const keyPath = path.join(__dirname, '..', 'miia-app-8cbd0-firebase-adminsdk-fbsvc-15d19cee57.json');
admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

const HASH = process.argv[2] || '3617b60d';

(async () => {
  const db  = admin.firestore();
  const ref = db.collection('cotizaciones').doc(HASH);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`ℹ️  cotizaciones/${HASH} no existe — nada para borrar.`);
    process.exit(0);
  }
  const d = snap.data();
  console.log(`Encontrado: lead=${d.lead_name} phone=${d.lead_phone} country=${d?.params?.country} created=${d.created_at?.toDate?.()}`);
  await ref.delete();
  console.log(`✅ cotizaciones/${HASH} eliminada.`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
