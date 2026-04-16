/**
 * AUDITORÍA v4: Verificar 573103157444 + timeline precisa
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
  console.log('═══ AUDITORÍA v4 ═══\n');

  // 1. contact_index de 573103157444
  console.log('══ 1. contact_index/573103157444 ══\n');
  const doc1 = await db.collection('users').doc(MARIANO_UID)
    .collection('contact_index').doc('573103157444').get();
  if (doc1.exists) {
    console.log(JSON.stringify(doc1.data(), null, 2));
  } else {
    console.log('❌ NO EXISTE');
  }

  // 2. ¿Existe el doc contact_index del bot con classifiedBy != auto_migration?
  // Es decir, ¿el doc existía ANTES de la migración?
  console.log('\n══ 2. Análisis de classifiedAt del bot ══\n');
  const botDoc = await db.collection('users').doc(MARIANO_UID)
    .collection('contact_index').doc('144740414689298').get();
  if (botDoc.exists) {
    const data = botDoc.data();
    console.log(`classifiedBy: ${data.classifiedBy}`);
    console.log(`classifiedAt: ${data.classifiedAt}`);
    console.log(`source: ${data.source}`);
    console.log(`firstMessageDate: ${data.firstMessageDate || '(no existe)'}`);
    console.log(`minedAt: ${data.minedAt || '(no existe)'}`);

    // Interpretar: classifiedAt = 2026-04-14T17:18:24.657Z
    // La migración corrió ~13:30 UTC (8:30 COT) según output anterior
    // 17:18 UTC = 12:18 COT = DESPUÉS del deploy
    // Entonces el doc NO fue migrado por el script, sino creado DESPUÉS
    console.log('\n--- ANÁLISIS TEMPORAL ---');
    console.log('Migración corrió: ~13:30 UTC (salida mostró updatedAt del doc fue 13:30)');
    console.log('classifiedAt del bot: 17:18:24 UTC = 12:18 COT');
    console.log('→ El doc fue creado DESPUÉS de la migración');
    console.log('→ classifiedBy=auto_migration es FALSO para este doc');
    console.log('→ Algún código escribió classifiedBy=auto_migration después del deploy');
  }

  // 3. ¿Quién escribió classifiedBy=auto_migration?
  // Buscar en TMH dónde se usa 'auto_migration'
  console.log('\n══ 3. Buscar "auto_migration" en código ══\n');
  console.log('Esto se verifica en el código, no en Firestore.');
  console.log('Grep "auto_migration" en TMH para ver si algo lo usa.');

  // 4. El doc tiene source=miia_fastpath — buscar qué es eso
  console.log('\n══ 4. ¿Qué es source=miia_fastpath? ══\n');
  console.log('Buscar "miia_fastpath" en TMH.');

  // 5. Timeline precisa: TODOS los msgs del bot con timestamps
  console.log('\n══ 5. Timeline completa del incidente ══\n');

  const persistDoc = await db.collection('users').doc(MARIANO_UID)
    .collection('miia_persistent').doc('tenant_conversations').get();
  const pData = persistDoc.data();
  const conversations = pData.conversations || {};

  // Get ALL msgs sorted by timestamp between 17:10 and 17:30 UTC
  const allMsgs = [];
  for (const [phone, msgs] of Object.entries(conversations)) {
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m.timestamp >= new Date('2026-04-14T17:10:00Z').getTime() &&
          m.timestamp <= new Date('2026-04-14T17:30:00Z').getTime()) {
        allMsgs.push({ phone, ...m });
      }
    }
  }

  allMsgs.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Total mensajes en ventana 12:10-12:30 COT: ${allMsgs.length}\n`);
  for (const m of allMsgs) {
    const ts = new Date(m.timestamp).toISOString();
    const cot = new Date(m.timestamp - 5*3600000).toISOString().split('T')[1].split('.')[0];
    console.log(`  ${cot} COT [${m.role}] ${m.phone.substring(0, 20)}...: ${(m.content || '').substring(0, 100)}`);
  }

  // 6. Check conversations history enrichment (contact_index fields)
  console.log('\n══ 6. Verificar firstMessage y lastMessage del bot ══\n');
  if (botDoc.exists) {
    const data = botDoc.data();
    console.log(`firstMessage: ${data.firstMessage || '(vacío)'}`);
    console.log(`lastMessage: ${data.lastMessage || '(vacío)'}`);
    console.log(`lastMessagePreview: ${data.lastMessagePreview || '(vacío)'}`);
    console.log(`contactMessageCount: ${data.contactMessageCount || 0}`);
    console.log(`ownerMessageCount: ${data.ownerMessageCount || 0}`);
    console.log(`conversationSummary: ${(data.conversationSummary || '').substring(0, 300)}`);
  }

  console.log('\n═══ FIN AUDITORÍA v4 ═══\n');
}

audit()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('ERROR FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
