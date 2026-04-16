/**
 * AUDITORÍA READ-ONLY: Incidente bot "Coordinadora" vs MIIA — 2026-04-14
 *
 * SOLO LECTURA. No modifica nada en Firestore.
 *
 * Tareas:
 *   1. Buscar contact_index con name="coordinadora"
 *   2. Verificar contactTypes en tenant_conversations
 *   3. Verificar contact_index del bot
 *   4. Contar mensajes del loop
 *   5. Verificar keywords de Medilink
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
  console.log('═══════════════════════════════════════════════════');
  console.log('  AUDITORÍA INCIDENTE BOT COORDINADORA — 2026-04-14');
  console.log('  MODO: SOLO LECTURA');
  console.log('═══════════════════════════════════════════════════\n');

  // ═══ TAREA 1: Buscar contact_index con name conteniendo "coordinadora" ═══
  console.log('══ TAREA 1: Buscar contact_index "coordinadora" ══\n');

  const indexSnap = await db.collection('users').doc(MARIANO_UID)
    .collection('contact_index').get();

  console.log(`Total docs en contact_index: ${indexSnap.size}\n`);

  const candidates = [];
  for (const doc of indexSnap.docs) {
    const data = doc.data();
    const name = (data.name || '').toLowerCase();
    const docId = doc.id.toLowerCase();
    // Buscar "coordinadora" en name, o cualquier campo que lo contenga
    if (name.includes('coordinador') || docId.includes('coordinador') ||
        (data.lastUnreadMessage || '').toLowerCase().includes('coordinador') ||
        (data.lastUnreadMessage || '').toLowerCase().includes('digita')) {
      candidates.push({ docId: doc.id, ...data });
    }
  }

  if (candidates.length === 0) {
    // Fallback: buscar por patrones de bot (mensajes de "digita", "información incorrecta")
    console.log('No encontrado por nombre. Buscando por patrones de bot...\n');
    for (const doc of indexSnap.docs) {
      const data = doc.data();
      const msg = (data.lastUnreadMessage || '').toLowerCase();
      if (msg.includes('digita') || msg.includes('información incorrecta') ||
          msg.includes('intenta nuevamente')) {
        candidates.push({ docId: doc.id, ...data });
      }
    }
  }

  if (candidates.length === 0) {
    // Segundo fallback: buscar docs actualizados hoy entre 12:15-12:25 COT (17:15-17:25 UTC)
    console.log('No encontrado por patrón. Buscando por timestamp 12:15-12:25 COT...\n');
    for (const doc of indexSnap.docs) {
      const data = doc.data();
      const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
      const lastMsg = data.lastMessageAt?._seconds ? data.lastMessageAt._seconds * 1000 :
                      data.lastMessageAt?.toDate ? data.lastMessageAt.toDate().getTime() : 0;
      // 12:15 COT = 17:15 UTC = 1713111300000 (approx for 2026-04-14)
      // Actually, let's just look for anything from today with high messageCount
      const mc = data.messageCount || 0;
      if (mc >= 5 && data.type === 'lead') {
        const ts = lastMsg || updatedAt;
        if (ts > 0) {
          const d = new Date(ts);
          const dateStr = d.toISOString().split('T')[0];
          if (dateStr === '2026-04-14') {
            candidates.push({ docId: doc.id, ...data, _tsUsed: ts });
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    // Third fallback: dump ALL docs updated today
    console.log('Buscando TODOS los docs actualizados hoy...\n');
    for (const doc of indexSnap.docs) {
      const data = doc.data();
      const updatedAt = data.updatedAt || '';
      if (typeof updatedAt === 'string' && updatedAt.startsWith('2026-04-14')) {
        candidates.push({ docId: doc.id, ...data });
      }
    }
  }

  console.log(`Candidatos encontrados: ${candidates.length}\n`);
  for (const c of candidates) {
    console.log(`  docId: ${c.docId}`);
    console.log(`  name: ${c.name || '(vacío)'}`);
    console.log(`  type: ${c.type || '(vacío)'}`);
    console.log(`  status: ${c.status || '(vacío)'}`);
    console.log(`  messageCount: ${c.messageCount || 0}`);
    console.log(`  lastUnreadMessage: ${(c.lastUnreadMessage || '').substring(0, 100)}`);
    console.log(`  updatedAt: ${c.updatedAt || '(vacío)'}`);
    console.log(`  classifiedBy: ${c.classifiedBy || '(vacío)'}`);
    console.log(`  classifiedAt: ${c.classifiedAt || '(vacío)'}`);
    console.log(`  alertSentToOwner: ${c.alertSentToOwner}`);
    console.log(`  awaitingClassification: ${c.awaitingClassification}`);
    const lma = c.lastMessageAt;
    if (lma && lma._seconds) {
      console.log(`  lastMessageAt: ${new Date(lma._seconds * 1000).toISOString()}`);
    } else if (lma && lma.toDate) {
      console.log(`  lastMessageAt: ${lma.toDate().toISOString()}`);
    } else {
      console.log(`  lastMessageAt: ${lma || '(vacío)'}`);
    }
    console.log('  ---');
  }

  // Identify the bot phone (best candidate)
  let botPhone = candidates.length > 0 ? candidates[0].docId : null;
  // If multiple, pick the one with highest messageCount or most recent
  if (candidates.length > 1) {
    candidates.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
    botPhone = candidates[0].docId;
    console.log(`\nMejor candidato (más mensajes): ${botPhone}\n`);
  }

  // ═══ TAREA 2: Verificar contactTypes en tenant_conversations ═══
  console.log('\n══ TAREA 2: contactTypes en tenant_conversations ══\n');

  const persistDoc = await db.collection('users').doc(MARIANO_UID)
    .collection('miia_persistent').doc('tenant_conversations').get();

  if (!persistDoc.exists) {
    console.log('❌ Doc tenant_conversations NO EXISTE');
  } else {
    const pData = persistDoc.data();
    const contactTypes = pData.contactTypes || {};
    const totalTypes = Object.keys(contactTypes).length;
    console.log(`contactTypes: ${totalTypes} entries`);
    console.log(`updatedAt: ${pData.updatedAt || pData._updatedAt || '(no field)'}`);

    // Check if any variant of botPhone exists
    if (botPhone) {
      const variants = [
        botPhone,
        `${botPhone}@s.whatsapp.net`,
        `${botPhone}@lid`,
      ];
      let found = false;
      for (const v of variants) {
        if (contactTypes[v] !== undefined) {
          console.log(`\n✅ BOT ENCONTRADO en contactTypes:`);
          console.log(`  key: "${v}"`);
          console.log(`  value: "${contactTypes[v]}"`);
          found = true;
        }
      }
      if (!found) {
        // Search by suffix
        for (const [key, val] of Object.entries(contactTypes)) {
          if (key.includes(botPhone) || (botPhone.length > 8 && key.includes(botPhone.slice(-10)))) {
            console.log(`\n✅ BOT ENCONTRADO (partial match) en contactTypes:`);
            console.log(`  key: "${key}"`);
            console.log(`  value: "${val}"`);
            found = true;
          }
        }
      }
      if (!found) {
        console.log(`\n❌ Bot phone "${botPhone}" NO encontrado en contactTypes`);
        // Dump first 20 keys as sample
        console.log('\nMuestra de keys (primeras 20):');
        Object.keys(contactTypes).slice(0, 20).forEach(k => {
          console.log(`  ${k} → ${contactTypes[k]}`);
        });
      }
    }

    // ═══ TAREA 4: Contar mensajes del loop ═══
    console.log('\n══ TAREA 4: Mensajes en el loop ══\n');

    const conversations = pData.conversations || {};
    let botConvo = null;
    if (botPhone) {
      const convVariants = [
        botPhone,
        `${botPhone}@s.whatsapp.net`,
        `${botPhone}@lid`,
      ];
      for (const v of convVariants) {
        if (conversations[v]) {
          botConvo = { key: v, msgs: conversations[v] };
          break;
        }
      }
      if (!botConvo) {
        // Partial match
        for (const [key, val] of Object.entries(conversations)) {
          if (key.includes(botPhone) || (botPhone.length > 8 && key.includes(botPhone.slice(-10)))) {
            botConvo = { key, msgs: val };
            break;
          }
        }
      }
    }

    if (!botConvo) {
      console.log(`❌ Conversación del bot no encontrada en tenant_conversations`);
      console.log(`Total conversations: ${Object.keys(conversations).length}`);
      // Try to find by content
      console.log('\nBuscando por contenido "digita" o "coordinadora"...');
      for (const [key, msgs] of Object.entries(conversations)) {
        if (!Array.isArray(msgs)) continue;
        const hasDigita = msgs.some(m =>
          (m.content || '').toLowerCase().includes('digita') ||
          (m.content || '').toLowerCase().includes('coordinadora') ||
          (m.content || '').toLowerCase().includes('información incorrecta')
        );
        if (hasDigita) {
          botConvo = { key, msgs };
          console.log(`✅ Encontrado por contenido en key: ${key}`);
          break;
        }
      }
    }

    if (botConvo) {
      console.log(`\nConversación del bot: key="${botConvo.key}"`);
      console.log(`Total mensajes: ${botConvo.msgs.length}`);

      // Separate by role
      const userMsgs = botConvo.msgs.filter(m => m.role === 'user');
      const assistantMsgs = botConvo.msgs.filter(m => m.role === 'assistant');
      console.log(`Mensajes del bot (role=user): ${userMsgs.length}`);
      console.log(`Mensajes de MIIA (role=assistant): ${assistantMsgs.length}`);

      // Filter by timestamp range: 12:15-12:25 COT = 17:15-17:25 UTC on 2026-04-14
      // COT = UTC-5, so 12:15 COT = 17:15 UTC
      // 2026-04-14T17:15:00Z
      const startTs = new Date('2026-04-14T17:15:00Z').getTime();
      const endTs = new Date('2026-04-14T17:25:00Z').getTime();

      const loopMsgs = botConvo.msgs.filter(m => {
        const ts = m.timestamp || 0;
        return ts >= startTs && ts <= endTs;
      });
      console.log(`\nMensajes en ventana 12:15-12:25 COT: ${loopMsgs.length}`);

      // If no msgs in range, show all timestamps
      if (loopMsgs.length === 0) {
        console.log('\nÚltimos 30 mensajes con timestamps:');
        botConvo.msgs.slice(-30).forEach((m, i) => {
          const ts = m.timestamp ? new Date(m.timestamp).toISOString() : 'no-ts';
          console.log(`  [${i}] ${m.role} @ ${ts}: ${(m.content || '').substring(0, 80)}`);
        });
      } else {
        console.log('\nMensajes en la ventana del loop:');
        loopMsgs.forEach((m, i) => {
          const ts = m.timestamp ? new Date(m.timestamp).toISOString() : 'no-ts';
          console.log(`  [${i}] ${m.role} @ ${ts}: ${(m.content || '').substring(0, 120)}`);
        });
      }

      // Show first and last message timestamps
      const allTs = botConvo.msgs.filter(m => m.timestamp).map(m => m.timestamp).sort();
      if (allTs.length > 0) {
        console.log(`\nPrimer mensaje: ${new Date(allTs[0]).toISOString()}`);
        console.log(`Último mensaje: ${new Date(allTs[allTs.length - 1]).toISOString()}`);
      }
    }
  }

  // ═══ TAREA 5: Keywords de Medilink ═══
  console.log('\n══ TAREA 5: Keywords de Medilink ══\n');

  // Get defaultBusinessId
  const userDoc = await db.collection('users').doc(MARIANO_UID).get();
  const userData = userDoc.data();
  const defaultBizId = userData?.defaultBusinessId;
  console.log(`defaultBusinessId: ${defaultBizId || '(no existe)'}`);

  // List all businesses
  const bizSnap = await db.collection('users').doc(MARIANO_UID)
    .collection('businesses').get();
  console.log(`Total businesses: ${bizSnap.size}\n`);

  for (const bizDoc of bizSnap.docs) {
    const biz = bizDoc.data();
    console.log(`Business: ${bizDoc.id}`);
    console.log(`  name: ${biz.name || '(vacío)'}`);
    console.log(`  description: ${(biz.description || '').substring(0, 200)}`);

    // Check contact_rules subcollection
    try {
      const rulesDoc = await db.collection('users').doc(MARIANO_UID)
        .collection('businesses').doc(bizDoc.id)
        .collection('contact_rules').doc('rules').get();
      if (rulesDoc.exists) {
        const rules = rulesDoc.data();
        console.log(`  contact_rules.lead_keywords: ${JSON.stringify(rules.lead_keywords || [])}`);
        console.log(`  contact_rules.client_keywords: ${JSON.stringify(rules.client_keywords || [])}`);
      } else {
        console.log('  contact_rules: no existe doc "rules"');
        // Try reading contact_rules as direct field in business doc
        if (biz.contact_rules) {
          console.log(`  contact_rules (inline): lead_keywords=${JSON.stringify(biz.contact_rules.lead_keywords || [])}`);
          console.log(`  contact_rules (inline): client_keywords=${JSON.stringify(biz.contact_rules.client_keywords || [])}`);
        }
      }
    } catch (e) {
      console.log(`  contact_rules error: ${e.message}`);
    }
    console.log('  ---');
  }

  // Also check legacy keywordsSet in user doc
  console.log('\nLegacy keywordsSet en user doc:');
  if (userData?.keywordsSet) {
    console.log(`  keywordsSet: ${JSON.stringify(userData.keywordsSet)}`);
  } else {
    console.log('  keywordsSet: no existe');
  }

  // Also check training_data doc for keywords
  try {
    const tdDoc = await db.collection('users').doc(MARIANO_UID)
      .collection('miia_persistent').doc('training_data').get();
    if (tdDoc.exists) {
      const td = tdDoc.data();
      if (td.keywordsSet) {
        console.log(`  miia_persistent/training_data.keywordsSet: ${JSON.stringify(td.keywordsSet)}`);
      }
      if (td.takeoverKeywords) {
        console.log(`  miia_persistent/training_data.takeoverKeywords: ${JSON.stringify(td.takeoverKeywords)}`);
      }
    }
  } catch (e) {
    console.log(`  training_data error: ${e.message}`);
  }

  // ═══ TAREA 3 COMPLEMENT: Full dump of bot's contact_index doc ═══
  if (botPhone) {
    console.log('\n══ TAREA 3: contact_index del bot (dump completo) ══\n');
    const botDoc = await db.collection('users').doc(MARIANO_UID)
      .collection('contact_index').doc(botPhone).get();
    if (botDoc.exists) {
      const data = botDoc.data();
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`❌ Doc contact_index/${botPhone} NO EXISTE`);
    }
  }

  console.log('\n═══ FIN AUDITORÍA ═══\n');
}

audit()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('ERROR FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
