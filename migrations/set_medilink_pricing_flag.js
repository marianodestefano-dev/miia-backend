/**
 * ONE-SHOT: Guardar hasCustomPricing=true y demoLink en Firestore para Mariano
 *
 * Esto permite que TMH → prompt_builder use buildMedilinkPricingBlock()
 * en vez de buildGenericPricingBlock() para leads de Medilink.
 *
 * Ejecutar: node migrations/set_medilink_pricing_flag.js [--dry-run]
 */

const admin = require('firebase-admin');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Inicializar Firebase (misma lógica que server.js)
if (!admin.apps.length) {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    let pk = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk
      })
    });
  } else {
    console.error('❌ Faltan variables de Firebase. Configurar .env');
    process.exit(1);
  }
}

const MARIANO_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';
const DEMO_LINK = 'https://meetings.hubspot.com/marianodestefano/demomedilink';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n═══ SET MEDILINK PRICING FLAG ═══`);
  console.log(`UID: ${MARIANO_UID}`);
  console.log(`Modo: ${DRY_RUN ? 'DRY RUN (no escribe)' : 'PRODUCCIÓN'}\n`);

  const db = admin.firestore();

  // 1. Actualizar doc raíz del usuario
  const userRef = db.collection('users').doc(MARIANO_UID);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    console.error('❌ Usuario no encontrado');
    process.exit(1);
  }

  const userData = userDoc.data();
  console.log(`📋 Estado actual:`);
  console.log(`   name: ${userData.name}`);
  console.log(`   businessName: ${userData.businessName || '(vacío)'}`);
  console.log(`   demoLink: ${userData.demoLink || '(vacío)'}`);
  console.log(`   hasCustomPricing: ${userData.hasCustomPricing || false}`);

  if (!DRY_RUN) {
    await userRef.update({
      demoLink: DEMO_LINK,
      hasCustomPricing: true,
    });
    console.log(`\n✅ users/${MARIANO_UID} actualizado:`);
    console.log(`   demoLink: ${DEMO_LINK}`);
    console.log(`   hasCustomPricing: true`);
  } else {
    console.log(`\n🔍 DRY RUN — se actualizaría:`);
    console.log(`   demoLink: ${DEMO_LINK}`);
    console.log(`   hasCustomPricing: true`);
  }

  // 2. Buscar y actualizar el business doc si existe
  const bizSnap = await userRef.collection('businesses').get();
  if (!bizSnap.empty) {
    for (const bizDoc of bizSnap.docs) {
      const bizData = bizDoc.data();
      console.log(`\n📦 Business: ${bizData.name} (${bizDoc.id})`);
      console.log(`   demoLink: ${bizData.demoLink || '(vacío)'}`);
      console.log(`   hasCustomPricing: ${bizData.hasCustomPricing || false}`);

      if (!DRY_RUN) {
        await bizDoc.ref.update({
          demoLink: DEMO_LINK,
          hasCustomPricing: true,
        });
        console.log(`   ✅ Actualizado`);
      } else {
        console.log(`   🔍 DRY RUN — se actualizaría`);
      }
    }
  } else {
    console.log(`\n⚠️ Sin businesses — los campos quedan en el doc raíz`);
  }

  console.log(`\n═══ LISTO ═══\n`);
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
