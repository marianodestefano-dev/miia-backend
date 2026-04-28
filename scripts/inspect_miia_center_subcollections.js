#!/usr/bin/env node
/**
 * C-459 helper: lista TODAS las subcollections de MIIA CENTER UID
 * + busca residuales de los phones target (Mariano + esposa) en cualquier
 * lugar del Firestore. Util para C-459 si el doc tenant_conversations
 * no aparece en la inspeccion estandar.
 *
 * Uso:
 *   node scripts/inspect_miia_center_subcollections.js
 */

'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const admin = require('firebase-admin');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const PHONE_MARIANO = '573163937365';
const PHONE_ESPOSA = '573137501884';
const TARGETS = [
  PHONE_MARIANO,
  PHONE_ESPOSA,
  `${PHONE_MARIANO}@s.whatsapp.net`,
  `${PHONE_ESPOSA}@s.whatsapp.net`,
];

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

  console.log(`[INSPECT] Probing known subcollections of users/${MIIA_CENTER_UID}/`);
  const ownerRef = db.collection('users').doc(MIIA_CENTER_UID);
  // Lista hardcoded de subcols conocidas (evita listCollections que requiere
  // permisos extra). Si MIIA CENTER tiene otra subcol, agregala.
  const KNOWN_SUBCOLS = [
    'miia_persistent', 'miia_memory', 'miia_agenda', 'miia_state',
    'miia_proposals_state', 'miia_gmail', 'contactTypes', 'calendar_events',
    'quotes', 'security_contacts', 'auth', 'inter_miia_log',
    'pending_responses', 'followups',
  ];
  for (const subName of KNOWN_SUBCOLS) {
    try {
      const snap = await ownerRef.collection(subName).limit(50).get();
      console.log(`  - ${subName}: ${snap.size} doc(s)`);
      if (snap.size > 0) {
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          const json = JSON.stringify(data);
          const matches = TARGETS.some((t) => doc.id.includes(t) || json.includes(t));
          if (matches) {
            console.log(`    ⚠️ MATCH: ${subName}/${doc.id}`);
            console.log(`       contactPhone=${data.contactPhone || data.phone || 'N/A'} status=${data.status || 'N/A'}`);
          }
        }
      }
    } catch (e) {
      console.log(`  - ${subName}: ERROR ${e.message}`);
    }
  }

  // Inspeccionar el doc tenant_conversations directo (si existe)
  console.log('');
  console.log(`[INSPECT] tenant_conversations doc check:`);
  const tcRef = ownerRef.collection('miia_persistent').doc('tenant_conversations');
  const tcDoc = await tcRef.get();
  console.log(`  exists=${tcDoc.exists}`);
  if (tcDoc.exists) {
    const data = tcDoc.data() || {};
    const keys = Object.keys(data);
    console.log(`  top-level keys=${JSON.stringify(keys)}`);
    if (data.conversations) {
      const convKeys = Object.keys(data.conversations);
      console.log(`  conversations keys count=${convKeys.length}`);
      const matches = convKeys.filter((k) => TARGETS.some((t) => k.includes(t)));
      console.log(`  conversations match target phones: ${JSON.stringify(matches)}`);
      if (matches.length > 0) {
        for (const k of matches) {
          console.log(`    ${k}: ${(data.conversations[k] || []).length} mensajes`);
        }
      }
    }
    if (data.contactTypes) {
      const ctKeys = Object.keys(data.contactTypes);
      const matches = ctKeys.filter((k) => TARGETS.some((t) => k.includes(t)));
      console.log(`  contactTypes match target phones: ${JSON.stringify(matches)}`);
    }
  }

  setTimeout(() => process.exit(0), 100);
}

main().catch((e) => {
  console.error('[INSPECT] error:', e.message);
  process.exit(1);
});
