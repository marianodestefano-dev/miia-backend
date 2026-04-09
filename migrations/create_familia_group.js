'use strict';

/**
 * MIGRACIÓN: Crear grupo FAMILIA en cuenta personal de Mariano
 * UID: bq2BbtCVF8cZo30tum584zrGATJ3
 *
 * Inyecta TODOS los familiares conocidos desde familyContacts de server.js
 * + crea contact_index para cada uno (type: 'group', groupId: 'familia')
 *
 * USO: node migrations/create_familia_group.js [--dry-run]
 */

const admin = require('firebase-admin');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Inicializar Firebase (misma lógica que server.js)
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

// Todos los familiares conocidos (de familyContacts en server.js)
const FAMILY_MEMBERS = {
  '573137501884': { name: 'Alejandra', fullName: 'Alejandra Sánchez', relation: 'esposa de Mariano', emoji: '👸💕' },
  '5491131313325': { name: 'Sr. Rafael', fullName: 'Mario Rafael De Stefano', relation: 'papá de Mariano', emoji: '👴❤️' },
  '5491164431700': { name: 'Silvia', fullName: 'Silvia', relation: 'mamá de Mariano', emoji: '👵❤️' },
  '5491134236348': { name: 'Anabella', fullName: 'Anabella Florencia De Stefano', relation: 'hermana de Mariano', emoji: '👧❤️' },
  '573217976029': { name: 'Consu', fullName: 'Consuelo', relation: 'suegra de Mariano', emoji: '👵⛪📿' },
  '573128908895': { name: 'Jota', fullName: 'Jorge Mario', relation: 'cuñado, hermano de Ale', emoji: '⚖️💚' },
  '573012761138': { name: 'Maria Isabel', fullName: 'Maria Isabel', relation: 'esposa de Jota', emoji: '🐶🤱' },
  '573145868362': { name: 'Juancho', fullName: 'Juan Diego', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️' },
  '573108221373': { name: 'Maria Clara', fullName: 'Maria Clara', relation: 'concuñada, esposa de Juancho', emoji: '🏠🏍️🙏' },
  '5491140293119': { name: 'Chapy', fullName: 'Juan Pablo', relation: 'primo de Mariano', emoji: '💻💪' },
  '556298316219': { name: 'Flako', fullName: 'Jorge Luis Gianni', relation: 'amigo cercano del papá', emoji: '😎' },
};

async function run() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  MIGRACIÓN: Crear grupo FAMILIA para Mariano`);
  console.log(`  UID: ${OWNER_UID}`);
  console.log(`  Modo: ${isDryRun ? 'DRY RUN' : 'PRODUCCIÓN'}`);
  console.log(`${'═'.repeat(60)}\n`);

  const groupRef = db.collection('users').doc(OWNER_UID).collection('contact_groups').doc(GROUP_ID);

  // 1. Crear/actualizar el grupo
  const groupData = {
    name: 'Familia',
    icon: '👨‍👩‍👧‍👦',
    tone: 'Sos MIIA, la asistente personal de Mariano. Este contacto es FAMILIA. Sé cálida, cercana, y cariñosa. Usá el nombre de pila. Si no los conocés todavía, presentate como la asistente de Mariano. La familia SABE que sos IA.',
    autoRespond: false,
    proactiveEnabled: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (isDryRun) {
    console.log(`[DRY] Crear grupo: ${GROUP_ID}`, groupData);
  } else {
    await groupRef.set(groupData, { merge: true });
    console.log(`✅ Grupo 'familia' creado/actualizado`);
  }

  // 2. Agregar cada familiar como contacto del grupo
  let count = 0;
  for (const [phone, data] of Object.entries(FAMILY_MEMBERS)) {
    const contactData = {
      name: data.fullName || data.name,
      shortName: data.name,
      relation: data.relation,
      emoji: data.emoji,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
      proactiveEnabled: false,
    };

    const indexData = {
      type: 'group',
      groupId: GROUP_ID,
      name: data.name,
      relation: data.relation,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isDryRun) {
      console.log(`[DRY] Contacto ${phone}: ${data.name} (${data.relation})`);
      console.log(`[DRY] contact_index/${phone}: type=group, groupId=familia`);
    } else {
      // Contacto en el grupo
      await groupRef.collection('contacts').doc(phone).set(contactData, { merge: true });
      // Index para búsqueda rápida
      await db.collection('users').doc(OWNER_UID).collection('contact_index').doc(phone).set(indexData, { merge: true });
      console.log(`  ✅ ${data.name} (${phone}) — ${data.relation}`);
    }
    count++;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${isDryRun ? '[DRY RUN]' : '✅ COMPLETADO'}: ${count} familiares en grupo 'familia'`);
  console.log(`${'═'.repeat(60)}\n`);

  if (!isDryRun) {
    console.log('Finalizando...');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('❌ Error en migración:', err);
  process.exit(1);
});
