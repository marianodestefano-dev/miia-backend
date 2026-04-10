'use strict';

/**
 * VERIFICACIÓN: familyContacts en Firestore
 *
 * Sesión 34: Se eliminó el hardcode de familyContacts en server.js.
 * Este script verifica que los datos existan en Firestore.
 * Si NO existen, los inyecta como safety net.
 *
 * USO: node migrations/verify_family_in_firestore.js
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
    console.error('Faltan variables de Firebase');
    process.exit(1);
  }
  admin.initializeApp({ credential });
}

const db = admin.firestore();

// Datos de respaldo (los que estaban hardcodeados en server.js)
const FAMILY_BACKUP = {
  '573137501884': { name: 'Alejandra', fullName: 'Alejandra Sánchez', relation: 'esposa de Mariano', emoji: '👸💕', personality: 'Spicy, F1 (Leclerc/Colapinto), Parcera, interés en Libros', isHandshakeDone: false },
  '5491131313325': { name: 'Sr. Rafael', fullName: 'Mario Rafael De Stefano', relation: 'papá de Mariano', emoji: '👴❤️', personality: 'Respetuosa, cariñosa. Muy admirado por Mariano. SIEMPRE llamarlo Sr. Rafael.', isHandshakeDone: false },
  '56994128069': { name: 'Vivi', fullName: 'Viviana Gaviria', relation: 'JEFA de Mariano', emoji: '👩‍💼👑', personality: 'Profesional, ejecutiva, técnica. Solo responde si ella dice Hola MIIA.', isHandshakeDone: false },
  '573128908895': { name: 'Jota', fullName: 'Jorge Mario', relation: 'hermano de Ale', emoji: '⚖️💚', personality: 'Abogado, fan del Nacional, padre de Renata', isHandshakeDone: false },
  '573012761138': { name: 'Maria Isabel', fullName: 'Maria Isabel', relation: 'esposa de Jota', emoji: '🐶🤱', personality: 'Madre de Renata, ama los perros (Kiara). Preguntarle siempre por Kiara.', isHandshakeDone: false },
  '5491164431700': { name: 'Silvia', fullName: 'Silvia', relation: 'mamá de Mariano', emoji: '👵❤️', personality: 'Super dulce, amistosa, disponibilidad 24/7 para ayudar', isHandshakeDone: false },
  '5491134236348': { name: 'Anabella', fullName: 'Anabella Florencia De Stefano', relation: 'hermana de Mariano', emoji: '👧❤️', personality: 'Le gusta Boca Juniors, leer y libros de autoayuda. Necesita ayuda con amores (ser discreta). Cuidarla siempre.', isHandshakeDone: false },
  '556298316219': { name: 'Flako', fullName: 'Jorge Luis Gianni', relation: 'amigo del papá de Mariano', emoji: '😎', personality: 'Amigo cercano de la familia', isHandshakeDone: false },
  '5491140293119': { name: 'Chapy', fullName: 'Juan Pablo', relation: 'primo de Mariano', emoji: '💻💪', personality: 'Capo en programación, fan del gym', isHandshakeDone: false },
  '573145868362': { name: 'Juancho', fullName: 'Juan Diego', relation: 'cuñado, hermano mayor de Ale', emoji: '🥑⚖️🏍️', personality: 'Amistoso. Experto en leyes colombianas. Le gusta viajar en moto y tiene campo de aguacates.', isHandshakeDone: false },
  '573108221373': { name: 'Maria', fullName: 'Maria Clara', relation: 'concuñada, esposa de Juancho', emoji: '🏠🏍️🙏', personality: 'Muy amistosa y agradable. Tiene inmobiliaria. Le encanta viajar en moto con Juancho. Ayudarle con deseos de rezar.', isHandshakeDone: false },
  '573217976029': { name: 'Consu', fullName: 'Consuelo', relation: 'suegra, mamá de Ale y Juancho', emoji: '👵⛪📿', personality: 'Mujer súper dulce. Fanática de Dios, la religión y rezar. Cuidarla y ayudarle en todo.', isHandshakeDone: false },
  '573014822744': { name: 'Kamila', fullName: 'Kamila', relation: 'amiga de Alejandra y Mariano', emoji: '💜🤗', personality: 'Amiga cercana de Ale y Mariano. Colombiana. Conocerla, ser cálida y curiosa.', isHandshakeDone: false },
  '573015392753': { name: 'Liliana', fullName: 'Liliana', relation: 'amiga de Alejandra y Mariano', emoji: '💛🤗', personality: 'Amiga cercana de Ale y Mariano. Colombiana. Conocerla, ser cálida y curiosa.', isHandshakeDone: false }
};

// Ambas cuentas
const ACCOUNTS = [
  { uid: 'bq2BbtCVF8cZo30tum584zrGATJ3', name: 'MIIA Personal (Mariano)' },
  { uid: 'A5pMESWlfmPWCoCPRbwy85EzUzy2', name: 'MIIA CENTER' },
];

async function run() {
  console.log('\n' + '='.repeat(60));
  console.log('  VERIFICACION: familyContacts en Firestore');
  console.log('='.repeat(60) + '\n');

  for (const account of ACCOUNTS) {
    console.log(`\n--- ${account.name} (${account.uid}) ---`);

    const contactsRef = db.collection('users').doc(account.uid)
      .collection('miia_persistent').doc('contacts');
    const doc = await contactsRef.get();

    if (!doc.exists) {
      console.log(`  [!] miia_persistent/contacts NO EXISTE`);

      // Solo inyectar en la cuenta personal de Mariano (no MIIA CENTER)
      if (account.uid === 'bq2BbtCVF8cZo30tum584zrGATJ3') {
        console.log(`  -> Inyectando familyContacts de respaldo...`);
        await contactsRef.set({
          familyContacts: FAMILY_BACKUP,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`  [OK] ${Object.keys(FAMILY_BACKUP).length} contactos inyectados`);
      }
      continue;
    }

    const data = doc.data();
    const fc = data.familyContacts || {};
    const fcCount = Object.keys(fc).length;
    console.log(`  familyContacts: ${fcCount} contactos`);

    if (fcCount === 0 && account.uid === 'bq2BbtCVF8cZo30tum584zrGATJ3') {
      console.log(`  [!] familyContacts VACIO! Inyectando respaldo...`);
      await contactsRef.set({
        familyContacts: FAMILY_BACKUP,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`  [OK] ${Object.keys(FAMILY_BACKUP).length} contactos inyectados`);
    } else if (fcCount > 0) {
      // Listar nombres
      for (const [phone, info] of Object.entries(fc)) {
        console.log(`    ${phone} -> ${info.name || '?'} (${info.relation || '?'})`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('  COMPLETADO');
  console.log('='.repeat(60) + '\n');

  process.exit(0);
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
