'use strict';

/**
 * MIGRACIÓN: equipoMedilink hardcodeado → contact_groups/equipo en Firestore
 *
 * Contexto: equipoMedilink estaba hardcodeado como `const` en server.js:446.
 * Esta migración persiste los 12 números a Firestore para que server.js
 * pueda arrancar con `let equipoMedilink = {}` y cargar dinámicamente.
 *
 * IDEMPOTENTE: No sobreescribe datos existentes (merge: true).
 * DRY-RUN: Pasar --dry-run para ver qué haría sin escribir.
 *
 * Uso:
 *   node migrations/migrate_equipo_to_firestore.js
 *   node migrations/migrate_equipo_to_firestore.js --dry-run
 *   node migrations/migrate_equipo_to_firestore.js --uid=OTRO_UID
 */

const admin = require('firebase-admin');
const path = require('path');

// ── Config ──
const DRY_RUN = process.argv.includes('--dry-run');
const UID_ARG = process.argv.find(a => a.startsWith('--uid='));
const OWNER_UID = UID_ARG ? UID_ARG.split('=')[1] : 'bq2BbtCVF8cZo30tum584zrGATJ3'; // Mariano

// ── Los 12 números que estaban hardcodeados en server.js:446-458 ──
const EQUIPO_SEED = {
  '56971251474': { name: null, presented: false },
  '56964490945': { name: null, presented: false },
  '56971561322': { name: null, presented: false },
  '56974919305': { name: null, presented: false },
  '56978516275': { name: null, presented: false },
  '56989558306': { name: null, presented: false },
  '56994128069': { name: 'Vivi', presented: false },   // también JEFA en familyContacts
  '56974777648': { name: null, presented: false },
  '573125027604': { name: null, presented: false },
  '573108447586': { name: null, presented: false },
  '573175058386': { name: null, presented: false },
  '573014259700': { name: null, presented: false }
};

async function main() {
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  MIGRACIÓN: equipoMedilink → Firestore`);
  console.log(`  UID: ${OWNER_UID}`);
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY-RUN (no escribe)' : '🔥 ESCRITURA REAL'}`);
  console.log(`══════════════════════════════════════════════\n`);

  // Init Firebase si no está inicializado (misma lógica que server.js)
  if (!admin.apps.length) {
    let credential = null;
    const keyPath = path.join(__dirname, '..', 'firebase-admin-key.json');
    const fs = require('fs');

    if (fs.existsSync(keyPath)) {
      // Local dev: archivo JSON
      credential = admin.credential.cert(require(keyPath));
      console.log('[FIREBASE] ✅ Inicializado con firebase-admin-key.json');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Railway/prod: variable de entorno
      const rawJSON = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n');
      const sa = JSON.parse(rawJSON);
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      credential = admin.credential.cert(sa);
      console.log('[FIREBASE] ✅ Inicializado con FIREBASE_SERVICE_ACCOUNT env');
    } else if (process.env.FIREBASE_PROJECT_ID) {
      // Railway con vars individuales
      let pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk
      });
      console.log('[FIREBASE] ✅ Inicializado con vars individuales');
    }

    if (!credential) {
      console.error('[FIREBASE] ❌ No se encontró credencial. Opciones:');
      console.error('    1. Archivo firebase-admin-key.json en miia-backend/');
      console.error('    2. Variable FIREBASE_SERVICE_ACCOUNT');
      console.error('    3. Variables FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY');
      process.exit(1);
    }
    admin.initializeApp({ credential });
  }

  const db = admin.firestore();
  const equipoGroupRef = db.collection('users').doc(OWNER_UID)
    .collection('contact_groups').doc('equipo');

  // PASO 1: Verificar si el grupo "equipo" existe
  const groupDoc = await equipoGroupRef.get();
  if (!groupDoc.exists) {
    console.log('[PASO 1] Grupo "equipo" NO existe. Creándolo...');
    if (!DRY_RUN) {
      await equipoGroupRef.set({
        name: 'Equipo Medilink',
        icon: '👥',
        tone: 'Profesional pero cercano. Son compañeros de trabajo de Mariano.',
        autoRespond: false,
        proactiveEnabled: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'migration_equipo_to_firestore'
      });
      console.log('[PASO 1] ✅ Grupo "equipo" creado');
    } else {
      console.log('[PASO 1] 🔍 (dry-run) Se crearía grupo "equipo"');
    }
  } else {
    console.log('[PASO 1] ✅ Grupo "equipo" ya existe');
  }

  // PASO 2: Escribir cada contacto del equipo
  const contactsRef = equipoGroupRef.collection('contacts');
  let created = 0;
  let skipped = 0;

  for (const [phone, data] of Object.entries(EQUIPO_SEED)) {
    const existingDoc = await contactsRef.doc(phone).get();
    if (existingDoc.exists) {
      const existing = existingDoc.data();
      console.log(`  📱 ${phone} — YA EXISTE (name: ${existing.name || 'null'}). Skip.`);
      skipped++;
      continue;
    }

    console.log(`  📱 ${phone} — NUEVO (name: ${data.name || 'null'}).${DRY_RUN ? ' (dry-run)' : ''}`);
    if (!DRY_RUN) {
      await contactsRef.doc(phone).set({
        name: data.name || null,
        presented: data.presented || false,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'migration_from_hardcode'
      });
    }
    created++;
  }

  // PASO 3: También persistir en miia_persistent/contacts.equipoMedilink (legacy)
  console.log('\n[PASO 3] Verificando legacy miia_persistent/contacts...');
  const legacyRef = db.collection('users').doc(OWNER_UID)
    .collection('miia_persistent').doc('contacts');
  const legacyDoc = await legacyRef.get();

  if (legacyDoc.exists && legacyDoc.data().equipoMedilink) {
    const existingEquipo = legacyDoc.data().equipoMedilink;
    const existingCount = Object.keys(existingEquipo).length;
    console.log(`[PASO 3] ✅ Legacy ya tiene ${existingCount} miembros de equipo`);

    // Merge los nuevos que no estén
    let legacyMerged = 0;
    for (const [phone, data] of Object.entries(EQUIPO_SEED)) {
      if (!existingEquipo[phone]) {
        existingEquipo[phone] = data;
        legacyMerged++;
      }
    }
    if (legacyMerged > 0 && !DRY_RUN) {
      await legacyRef.set({ equipoMedilink: existingEquipo }, { merge: true });
      console.log(`[PASO 3] ✅ Merged ${legacyMerged} nuevos miembros al legacy`);
    } else if (legacyMerged > 0) {
      console.log(`[PASO 3] 🔍 (dry-run) Se mergarían ${legacyMerged} miembros al legacy`);
    }
  } else {
    console.log('[PASO 3] Legacy NO tiene equipoMedilink. Escribiendo seed completo...');
    if (!DRY_RUN) {
      await legacyRef.set({ equipoMedilink: EQUIPO_SEED }, { merge: true });
      console.log('[PASO 3] ✅ Seed completo escrito en legacy');
    } else {
      console.log('[PASO 3] 🔍 (dry-run) Se escribiría seed completo en legacy');
    }
  }

  // Resumen
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  RESULTADO:`);
  console.log(`  • Creados en contact_groups/equipo: ${created}`);
  console.log(`  • Saltados (ya existían): ${skipped}`);
  console.log(`  • Total equipo: ${Object.keys(EQUIPO_SEED).length}`);
  if (DRY_RUN) console.log(`  ⚠️ DRY-RUN — nada se escribió realmente`);
  console.log(`══════════════════════════════════════════════\n`);

  process.exit(0);
}

main().catch(e => {
  console.error('[MIGRACIÓN] ❌ Error fatal:', e);
  process.exit(1);
});
