/**
 * AUDITORÍA v3: Datos específicos del bot 144740414689298@lid
 * SOLO LECTURA.
 */

const admin = require('firebase-admin');
const CREDS_PATH = 'C:/Users/usuario/OneDrive/Desktop/ClaudeWEB/miia-app-8cbd0-firebase-adminsdk-fbsvc-36d22063e7.json';
const MARIANO_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

if (!admin.apps.length) {
  const serviceAccount = require(CREDS_PATH);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function audit() {
  console.log('═══ AUDITORÍA v3: Bot 144740414689298 ═══\n');

  const botLid = '144740414689298';
  const botLidFull = '144740414689298@lid';
  const botLidJid = '144740414689298@s.whatsapp.net';

  // ═══ 1. contact_index: buscar por docId exacto y variantes ═══
  console.log('══ 1. contact_index del bot ══\n');

  const variants = [botLid, botLidFull, botLidJid];
  for (const v of variants) {
    const doc = await db.collection('users').doc(MARIANO_UID)
      .collection('contact_index').doc(v).get();
    if (doc.exists) {
      console.log(`✅ ENCONTRADO: contact_index/${v}`);
      console.log(JSON.stringify(doc.data(), null, 2));
      console.log('');
    } else {
      console.log(`❌ contact_index/${v} NO EXISTE`);
    }
  }

  // ═══ 2. Buscar en TODA la colección contact_index por docId parcial ═══
  console.log('\n══ 2. Búsqueda parcial "144740" en contact_index ══\n');
  const indexSnap = await db.collection('users').doc(MARIANO_UID)
    .collection('contact_index').get();

  for (const doc of indexSnap.docs) {
    if (doc.id.includes('144740')) {
      console.log(`✅ Match parcial: ${doc.id}`);
      console.log(JSON.stringify(doc.data(), null, 2));
      console.log('');
    }
  }

  // ═══ 3. Conversación completa desde tenant_conversations ═══
  console.log('══ 3. Conversación completa del bot ══\n');

  const persistDoc = await db.collection('users').doc(MARIANO_UID)
    .collection('miia_persistent').doc('tenant_conversations').get();

  if (!persistDoc.exists) {
    console.log('❌ tenant_conversations no existe');
    return;
  }

  const pData = persistDoc.data();
  const conversations = pData.conversations || {};
  const contactTypes = pData.contactTypes || {};
  const leadNames = pData.leadNames || {};

  // Search all conversation keys for 144740
  console.log('Keys que contienen "144740":');
  for (const key of Object.keys(conversations)) {
    if (key.includes('144740')) {
      console.log(`  conversations["${key}"] — ${conversations[key].length} msgs`);
    }
  }
  for (const key of Object.keys(contactTypes)) {
    if (key.includes('144740')) {
      console.log(`  contactTypes["${key}"] = "${contactTypes[key]}"`);
    }
  }
  for (const key of Object.keys(leadNames)) {
    if (key.includes('144740')) {
      console.log(`  leadNames["${key}"] = "${leadNames[key]}"`);
    }
  }

  // ═══ 4. Verificar el campo updatedAt del doc tenant_conversations ═══
  console.log('\n══ 4. Metadata de tenant_conversations ══\n');

  // Check all top-level fields that are timestamps
  for (const [key, val] of Object.entries(pData)) {
    if (key === 'conversations' || key === 'contactTypes' || key === 'leadNames' || key === 'conversationMetadata' || key === 'ownerActiveChats') {
      console.log(`  ${key}: [object with ${Object.keys(val || {}).length} keys]`);
    } else {
      if (val && val._seconds) {
        console.log(`  ${key}: ${new Date(val._seconds * 1000).toISOString()} (Firestore Timestamp)`);
      } else {
        console.log(`  ${key}: ${JSON.stringify(val)}`);
      }
    }
  }

  // ═══ 5. Verificar conversación 573103157444 (segundo más reciente en incidente) ═══
  console.log('\n══ 5. Conversación 573103157444 (segundo más reciente ~17:17 UTC) ══\n');
  for (const [key, msgs] of Object.entries(conversations)) {
    if (key.includes('573103157444')) {
      console.log(`Key: ${key}, msgs: ${msgs.length}`);
      console.log(`contactType: ${contactTypes[key]}`);
      console.log(`leadName: ${leadNames[key]}`);
      for (const m of msgs) {
        const ts = m.timestamp ? new Date(m.timestamp).toISOString() : 'no-ts';
        console.log(`  [${m.role}] ${ts}: ${(m.content || '').substring(0, 200)}`);
      }
    }
  }

  // ═══ 6. Contar TODOS los mensajes role=assistant entre 17:15-17:25 UTC ═══
  console.log('\n══ 6. TODOS los mensajes de MIIA entre 12:15-12:25 COT ══\n');

  const startTs = new Date('2026-04-14T17:15:00Z').getTime();
  const endTs = new Date('2026-04-14T17:25:00Z').getTime();

  let totalMiia = 0;
  let totalUser = 0;
  const byPhone = {};

  for (const [phone, msgs] of Object.entries(conversations)) {
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m.timestamp >= startTs && m.timestamp <= endTs) {
        if (!byPhone[phone]) byPhone[phone] = { user: 0, assistant: 0 };
        if (m.role === 'assistant') {
          totalMiia++;
          byPhone[phone].assistant++;
        } else {
          totalUser++;
          byPhone[phone].user++;
        }
      }
    }
  }

  console.log(`Total mensajes MIIA (assistant) en ventana: ${totalMiia}`);
  console.log(`Total mensajes entrantes (user) en ventana: ${totalUser}`);
  console.log('\nDesglose por phone:');
  for (const [phone, counts] of Object.entries(byPhone)) {
    console.log(`  ${phone}: MIIA=${counts.assistant}, user=${counts.user}`);
  }

  // ═══ 7. NOTA IMPORTANTE: Explicar por qué solo 5 msgs ═══
  console.log('\n══ 7. Nota sobre limitación de datos ══\n');
  console.log('tenant_conversations se persiste con debounce de 30s.');
  console.log('Si Mariano desvinculó a los ~2 minutos del loop,');
  console.log('el debounce pudo haber guardado solo 1-2 snapshots.');
  console.log('Además, conversations se limitan a .slice(-40) por phone.');
  console.log('Los mensajes del BOT (role=user) pueden haberse perdido');
  console.log('si no se persistieron antes de desvincular.');
  console.log('');
  console.log('La conversación del bot muestra SOLO 5 msgs role=assistant');
  console.log('y 0 msgs role=user. Esto es consistente con:');
  console.log('- Bot enviaba msgs → TMH los procesaba → MIIA respondía');
  console.log('- Pero los msgs del bot (role=user) no se guardaron en la');
  console.log('  persistencia porque el debounce no alcanzó a correr');
  console.log('  O porque los msgs del bot se guardaron y luego el slice');
  console.log('  los descartó al llegar a 40.');

  console.log('\n═══ FIN AUDITORÍA v3 ═══\n');
}

audit()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('ERROR FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
