#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// MIIA — Migración a estructura multi-negocio
// ════════════════════════════════════════════════════════════════════════════
// Ejecutar: node migrations/migrate_to_businesses.js [--dry-run] [--uid=xxx]
//
// Idempotente: si ya existe businesses/ para un uid, se salta.
// --dry-run: solo muestra qué haría sin escribir nada.
// --uid=xxx: migrar solo un usuario específico.
// ═════════════════════════════════════════════════════════════════════════���══

const path = require('path');

// Inicializar Firebase Admin
const admin = require('firebase-admin');
const serviceAccount = require(path.join(__dirname, '..', 'miia-app-8cbd0-firebase-adminsdk-fbsvc-15d19cee57.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const UID_FILTER = args.find(a => a.startsWith('--uid='))?.split('=')[1];

function log(msg) { console.log(`[MIGRATE] ${msg}`); }
function warn(msg) { console.warn(`[MIGRATE][WARN] ${msg}`); }

async function migrateUser(uid) {
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  if (!userDoc.exists) { warn(`User ${uid} no existe en users/. Saltando.`); return; }

  const userData = userDoc.data();
  log(`── Migrando uid=${uid} (${userData.name || userData.email || '?'}) ──`);

  // Check si ya tiene businesses
  const existingBiz = await userRef.collection('businesses').limit(1).get();
  if (!existingBiz.empty) {
    log(`  Ya tiene businesses/. Saltando migración de negocio.`);
    return;
  }

  // 1. Crear negocio default con datos del usuario
  const bizData = {
    name: userData.businessName || userData.name || 'Mi Negocio',
    email: userData.businessEmail || userData.email || '',
    address: userData.businessAddress || '',
    website: userData.businessWebsite || '',
    demoLink: userData.demoLink || '',
    description: userData.businessDescription || '',
    whatsapp_number: userData.whatsapp_number || '',
    ownerRole: userData.ownerRole || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  log(`  Creando negocio default: "${bizData.name}"`);
  let bizId;
  if (!DRY_RUN) {
    const bizRef = await userRef.collection('businesses').add(bizData);
    bizId = bizRef.id;
    await userRef.update({ defaultBusinessId: bizId });
  } else {
    bizId = '<dry-run-biz-id>';
  }
  log(`  bizId = ${bizId}`);

  // 2. Migrar training_products → businesses/{bizId}/products
  const productsSnap = await db.collection('training_products').doc(uid).collection('items').get();
  log(`  Productos: ${productsSnap.size} encontrados`);
  if (!DRY_RUN && productsSnap.size > 0) {
    for (const doc of productsSnap.docs) {
      await userRef.collection('businesses').doc(bizId).collection('products').doc(doc.id).set(doc.data());
    }
  }

  // 3. Migrar contact_rules → businesses/{bizId}/config/contact_rules
  const rulesDoc = await db.collection('contact_rules').doc(uid).get();
  if (rulesDoc.exists) {
    log(`  Contact rules: encontradas`);
    if (!DRY_RUN) {
      await userRef.collection('businesses').doc(bizId).collection('config').doc('contact_rules').set(rulesDoc.data());
    }
  }

  // 4. Migrar payment_methods → businesses/{bizId}/config/payment_methods
  const payDoc = await db.collection('payment_methods').doc(uid).get();
  if (payDoc.exists) {
    log(`  Payment methods: encontrados`);
    if (!DRY_RUN) {
      await userRef.collection('businesses').doc(bizId).collection('config').doc('payment_methods').set(payDoc.data());
    }
  }

  // 5. Migrar training_sessions → businesses/{bizId}/sessions
  const sessionsSnap = await db.collection('training_sessions').doc(uid).collection('sessions').get();
  log(`  Sesiones: ${sessionsSnap.size} encontradas`);
  if (!DRY_RUN && sessionsSnap.size > 0) {
    for (const doc of sessionsSnap.docs) {
      await userRef.collection('businesses').doc(bizId).collection('sessions').doc(doc.id).set(doc.data());
    }
  }

  // 6. Migrar brain existente → businesses/{bizId}/brain/business_cerebro
  // El brain está en el tenant_manager en memoria, pero si hay un doc en Firestore lo copiamos
  const brainDoc = await db.collection('tenant_brains').doc(uid).get();
  if (brainDoc.exists) {
    log(`  Brain: encontrado`);
    if (!DRY_RUN) {
      await userRef.collection('businesses').doc(bizId).collection('brain').doc('business_cerebro').set({
        content: brainDoc.data().content || brainDoc.data().training || '',
        updatedAt: new Date().toISOString()
      });
    }
  }

  // 7. Crear grupos pre-definidos: familia, equipo
  log(`  Creando grupos: familia, equipo`);
  if (!DRY_RUN) {
    const familiaRef = await userRef.collection('contact_groups').doc('familia').set({
      name: 'Familia',
      icon: '👨‍👩‍👧‍👦',
      tone: 'Habla con cariño y cercanía, como parte de la familia.',
      autoRespond: false,
      proactiveEnabled: false,
      createdAt: new Date().toISOString()
    });

    await userRef.collection('contact_groups').doc('equipo').set({
      name: 'Equipo',
      icon: '💼',
      tone: 'Profesional pero cercano, como un compañero de trabajo.',
      autoRespond: false,
      proactiveEnabled: false,
      createdAt: new Date().toISOString()
    });
  }

  // 8. Migrar familyContacts si existen en Firestore
  const familyDoc = await db.collection('family_contacts').doc(uid).get();
  if (familyDoc.exists && familyDoc.data()) {
    const contacts = familyDoc.data();
    let count = 0;
    for (const [phone, data] of Object.entries(contacts)) {
      if (typeof data !== 'object') continue;
      count++;
      if (!DRY_RUN) {
        const cleanPhone = phone.replace(/\D/g, '');
        await userRef.collection('contact_groups').doc('familia').collection('contacts').doc(cleanPhone).set({
          name: data.name || '',
          notes: data.relation || '',
          proactiveEnabled: false,
          addedAt: new Date().toISOString()
        });
        // contact_index
        await userRef.collection('contact_index').doc(cleanPhone).set({
          type: 'group',
          groupId: 'familia',
          groupName: 'Familia',
          name: data.name || '',
          updatedAt: new Date().toISOString()
        });
      }
    }
    log(`  Family contacts: ${count} migrados`);
  }

  // 9. Migrar teamContacts si existen
  const teamDoc = await db.collection('team_contacts').doc(uid).get();
  if (teamDoc.exists && teamDoc.data()) {
    const contacts = teamDoc.data();
    let count = 0;
    for (const [phone, data] of Object.entries(contacts)) {
      if (typeof data !== 'object') continue;
      count++;
      if (!DRY_RUN) {
        const cleanPhone = phone.replace(/\D/g, '');
        await userRef.collection('contact_groups').doc('equipo').collection('contacts').doc(cleanPhone).set({
          name: data.name || '',
          notes: data.role || '',
          proactiveEnabled: false,
          addedAt: new Date().toISOString()
        });
        await userRef.collection('contact_index').doc(cleanPhone).set({
          type: 'group',
          groupId: 'equipo',
          groupName: 'Equipo',
          name: data.name || '',
          updatedAt: new Date().toISOString()
        });
      }
    }
    log(`  Team contacts: ${count} migrados`);
  }

  log(`  ✅ Migración completada para ${uid}`);
}

async function main() {
  log(`═══════════════════════════════════════`);
  log(`Migración a estructura multi-negocio`);
  log(`Modo: ${DRY_RUN ? 'DRY RUN (sin escrituras)' : 'PRODUCCIÓN'}`);
  log(`═══════════════════════════════════════`);

  if (UID_FILTER) {
    await migrateUser(UID_FILTER);
  } else {
    // Migrar todos los usuarios con role owner o admin
    const usersSnap = await db.collection('users').get();
    const owners = usersSnap.docs.filter(d => {
      const role = d.data().role;
      return role === 'owner' || role === 'admin';
    });
    log(`Encontrados ${owners.length} owners/admins para migrar`);

    for (const doc of owners) {
      try {
        await migrateUser(doc.id);
      } catch (e) {
        warn(`Error migrando ${doc.id}: ${e.message}`);
      }
    }
  }

  log(`═══════════════════════════════════════`);
  log(`Migración ${DRY_RUN ? '(dry-run)' : ''} finalizada`);
  log(`═══════════════════════════════════════`);
  process.exit(0);
}

main().catch(e => {
  console.error(`[MIGRATE] Error fatal:`, e);
  process.exit(1);
});
