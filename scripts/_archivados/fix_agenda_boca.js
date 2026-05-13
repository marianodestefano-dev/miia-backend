/**
 * C-475 fix CRITICAL: agendaEngine evento Boca 19:20 con fields undefined.
 *
 * ANTES: id=i74K04l8feuRsY8HUO3d status=expired reason=undefined
 *        contactPhone=undefined source=undefined.
 *
 * DESPUES: status=pending + reason completo + contactPhone Mariano
 *          + source='lead_smoke' + remindContact=true.
 *
 * Origen: ALERTA-ROJA Wi 2026-04-28 ~15:54 COT firma Mariano expansiva
 * "arranquen YAAA". Anti-ADN #4 INTEGRIDAD PROMESA cumplir o reportar.
 */

'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const admin = require('firebase-admin');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const EVENT_ID = 'i74K04l8feuRsY8HUO3d';
const MARIANO_PHONE = '573163937365';

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

  const ref = db.collection('users').doc(MIIA_CENTER_UID)
    .collection('miia_agenda').doc(EVENT_ID);

  const before = await ref.get();
  if (!before.exists) {
    console.log('ERROR: evento NO existe');
    process.exit(1);
  }
  console.log('BEFORE:', JSON.stringify(before.data(), null, 2));

  const update = {
    status: 'pending',
    reason: 'Recordatorio: Boca Juniors vs Cruzeiro - Copa Libertadores 7:30 PM',
    contactPhone: MARIANO_PHONE,
    contactName: 'Mariano',
    source: 'lead_smoke_recovery',
    remindContact: false,  // recordatorio al owner, no al contacto
    remindOwner: true,
    durationMinutes: 90,
    eventMode: 'casual',
    agendaType: 'personal',
    fixedAt: new Date().toISOString(),
    fixedBy: 'C-475-AGENDA-UNDEFINED-FIX Vi',
  };

  await ref.update(update);
  console.log('UPDATE OK');

  const after = await ref.get();
  console.log('AFTER:', JSON.stringify(after.data(), null, 2));

  setTimeout(() => process.exit(0), 100);
}

main().catch(e => {
  console.error('ERR:', e.message);
  process.exit(1);
});
