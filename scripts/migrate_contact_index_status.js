/**
 * MIGRACIÓN ONE-TIME: Agregar campo `status` a contact_index existentes
 *
 * Problema: El bloqueo precautorio (CARTA C-003) requiere `status: 'classified'`
 * para que MIIA responda. Docs existentes no tienen este campo → quedarían bloqueados.
 *
 * Solución: Para cada doc en contact_index que tenga `type` válido pero NO `status`,
 * agregar `status: 'classified'`.
 *
 * REGLAS:
 * - Solo usa .get() y .update() — NO crea docs nuevos, NO borra nada
 * - Idempotente: correr 2 veces produce el mismo resultado
 * - Reversible: no sobrescribe datos existentes (merge safe)
 * - Modo --dry-run por defecto: solo reporta, no modifica
 *
 * Uso:
 *   node scripts/migrate_contact_index_status.js              # dry-run
 *   node scripts/migrate_contact_index_status.js --execute     # ejecutar real
 */

const admin = require('firebase-admin');
const path = require('path');

const CREDS_PATH = 'C:/Users/usuario/OneDrive/Desktop/ClaudeWEB/miia-app-8cbd0-firebase-adminsdk-fbsvc-36d22063e7.json';
const VALID_TYPES = ['lead', 'client', 'familia', 'equipo', 'miia_lead', 'miia_client', 'group', 'enterprise_lead'];

const isDryRun = !process.argv.includes('--execute');

if (!admin.apps.length) {
  const serviceAccount = require(CREDS_PATH);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function migrate() {
  console.log(`\n═══ MIGRACIÓN contact_index → status ═══`);
  console.log(`Modo: ${isDryRun ? '🔍 DRY-RUN (solo reporta, no modifica)' : '🔴 EJECUCIÓN REAL'}\n`);

  const usersSnap = await db.collection('users').get();
  console.log(`Total users: ${usersSnap.size}\n`);

  let totalChecked = 0;
  let totalMigrated = 0;
  let totalAlreadyOk = 0;
  let totalNoType = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const userName = userDoc.data().name || userDoc.data().email || uid.substring(0, 12);

    const indexSnap = await db.collection('users').doc(uid).collection('contact_index').get();
    if (indexSnap.empty) {
      console.log(`  ${userName}: 0 docs en contact_index — skip`);
      continue;
    }

    let userMigrated = 0;
    for (const doc of indexSnap.docs) {
      totalChecked++;
      const data = doc.data();

      // Ya tiene status → no tocar
      if (data.status) {
        totalAlreadyOk++;
        continue;
      }

      // Tiene type válido pero no status → migrar
      if (data.type && VALID_TYPES.includes(data.type)) {
        if (!isDryRun) {
          await doc.ref.update({
            status: 'classified',
            classifiedAt: data.updatedAt || admin.firestore.FieldValue.serverTimestamp(),
            classifiedBy: 'auto_migration'
          });
        }
        totalMigrated++;
        userMigrated++;
        console.log(`    ${isDryRun ? '[DRY]' : '[OK]'} ${doc.id} — type=${data.type} → status=classified`);
      } else {
        totalNoType++;
      }
    }

    if (userMigrated > 0 || indexSnap.size > 0) {
      console.log(`  ${userName}: ${indexSnap.size} docs, ${userMigrated} migrados, ${indexSnap.size - userMigrated} ya ok/sin type`);
    }
  }

  console.log(`\n═══ RESUMEN ═══`);
  console.log(`Docs revisados:     ${totalChecked}`);
  console.log(`Ya tenían status:   ${totalAlreadyOk}`);
  console.log(`Sin type válido:    ${totalNoType}`);
  console.log(`Migrados:           ${totalMigrated} ${isDryRun ? '(dry-run, no se modificó nada)' : '(escritos en Firestore)'}`);

  if (isDryRun && totalMigrated > 0) {
    console.log(`\n⚠️  Para ejecutar real: node scripts/migrate_contact_index_status.js --execute`);
  }

  console.log('');
}

migrate()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('ERROR FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
