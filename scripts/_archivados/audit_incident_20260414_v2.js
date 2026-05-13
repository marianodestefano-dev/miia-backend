/**
 * AUDITORÍA v2: Búsqueda expandida del bot "Coordinadora"
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
  console.log('═══ AUDITORÍA v2: Búsqueda expandida ═══\n');

  // ═══ 1. BUSCAR EN TODAS LAS CONVERSACIONES por contenido del bot ═══
  console.log('══ 1. Buscar en conversations por contenido del bot ══\n');

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

  console.log(`Total conversations: ${Object.keys(conversations).length}`);
  console.log(`Total contactTypes: ${Object.keys(contactTypes).length}`);
  console.log(`Total leadNames: ${Object.keys(leadNames).length}\n`);

  // Search ALL conversations for bot-like content
  const botPatterns = ['digita', 'coordinadora', 'información incorrecta', 'intenta nuevamente',
                       'número telefónico', '10 dígitos', 'proporcionada es incorrecta'];

  const matches = [];
  for (const [phone, msgs] of Object.entries(conversations)) {
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      const content = (m.content || '').toLowerCase();
      for (const pat of botPatterns) {
        if (content.includes(pat)) {
          matches.push({ phone, msg: m, pattern: pat });
          break;
        }
      }
    }
  }

  console.log(`Matches encontrados por contenido: ${matches.length}\n`);

  // Group by phone
  const byPhone = {};
  for (const m of matches) {
    if (!byPhone[m.phone]) byPhone[m.phone] = [];
    byPhone[m.phone].push(m);
  }

  for (const [phone, phoneMatches] of Object.entries(byPhone)) {
    console.log(`\n📱 Phone: ${phone}`);
    console.log(`  contactType: ${contactTypes[phone] || '(no existe)'}`);
    console.log(`  leadName: ${leadNames[phone] || '(no existe)'}`);
    console.log(`  Mensajes que matchean: ${phoneMatches.length}`);
    for (const pm of phoneMatches) {
      const ts = pm.msg.timestamp ? new Date(pm.msg.timestamp).toISOString() : 'no-ts';
      console.log(`    [${pm.msg.role}] ${ts}: ${(pm.msg.content || '').substring(0, 150)}`);
    }

    // Show FULL conversation for this phone
    const fullConvo = conversations[phone] || [];
    console.log(`\n  === Conversación completa (${fullConvo.length} msgs) ===`);
    for (const m of fullConvo) {
      const ts = m.timestamp ? new Date(m.timestamp).toISOString() : 'no-ts';
      console.log(`    [${m.role}] ${ts}: ${(m.content || '').substring(0, 200)}`);
    }
  }

  // ═══ 2. Si no encontramos nada, buscar conversaciones con muchos msgs de hoy ═══
  if (matches.length === 0) {
    console.log('\n══ 2. Fallback: conversaciones con actividad reciente ══\n');

    // 12:15 COT = 17:15 UTC
    const incidentStart = new Date('2026-04-14T17:10:00Z').getTime();
    const incidentEnd = new Date('2026-04-14T17:30:00Z').getTime();

    const recentConvos = [];
    for (const [phone, msgs] of Object.entries(conversations)) {
      if (!Array.isArray(msgs)) continue;
      const recentMsgs = msgs.filter(m => m.timestamp >= incidentStart && m.timestamp <= incidentEnd);
      if (recentMsgs.length >= 3) {
        recentConvos.push({ phone, total: msgs.length, recent: recentMsgs.length, type: contactTypes[phone] });
      }
    }

    recentConvos.sort((a, b) => b.recent - a.recent);
    console.log(`Conversaciones con 3+ msgs entre 12:10-12:30 COT: ${recentConvos.length}\n`);
    for (const rc of recentConvos.slice(0, 10)) {
      console.log(`  ${rc.phone}: ${rc.recent} msgs recientes (total: ${rc.total}), type: ${rc.type}`);
      // Show the recent messages
      const msgs = conversations[rc.phone].filter(m => m.timestamp >= incidentStart && m.timestamp <= incidentEnd);
      for (const m of msgs.slice(0, 5)) {
        const ts = m.timestamp ? new Date(m.timestamp).toISOString() : 'no-ts';
        console.log(`    [${m.role}] ${ts}: ${(m.content || '').substring(0, 120)}`);
      }
      if (msgs.length > 5) console.log(`    ... y ${msgs.length - 5} más`);
    }
  }

  // ═══ 3. contact_index: docs con status != classified (C-004 creados) ═══
  console.log('\n══ 3. contact_index docs con awaitingClassification o status=unknown ══\n');

  const indexSnap = await db.collection('users').doc(MARIANO_UID)
    .collection('contact_index').get();

  let unknowns = 0;
  for (const doc of indexSnap.docs) {
    const data = doc.data();
    if (data.awaitingClassification || data.status === 'unknown' || data.alertSentToOwner) {
      unknowns++;
      console.log(`  ${doc.id}: status=${data.status}, awaiting=${data.awaitingClassification}, alert=${data.alertSentToOwner}, name=${data.name}`);
    }
  }
  console.log(`\nTotal docs con awaitingClassification/unknown/alertSent: ${unknowns}`);
  if (unknowns === 0) {
    console.log('→ C-004 NO creó NINGÚN doc de bloqueo precautorio para Mariano.');
  }

  // ═══ 4. Buscar en ALL conversations los msgs más recientes (último de cada) ═══
  console.log('\n══ 4. Top 15 conversaciones más recientes ══\n');

  const convoRecency = [];
  for (const [phone, msgs] of Object.entries(conversations)) {
    if (!Array.isArray(msgs) || msgs.length === 0) continue;
    const lastTs = Math.max(...msgs.filter(m => m.timestamp).map(m => m.timestamp));
    convoRecency.push({ phone, lastTs, count: msgs.length, type: contactTypes[phone] || '-', name: leadNames[phone] || '-' });
  }
  convoRecency.sort((a, b) => b.lastTs - a.lastTs);

  for (const c of convoRecency.slice(0, 15)) {
    const lastDate = new Date(c.lastTs).toISOString();
    console.log(`  ${c.phone} | last: ${lastDate} | msgs: ${c.count} | type: ${c.type} | name: ${c.name}`);
  }

  // ═══ 5. Keyword match test ═══
  console.log('\n══ 5. Keyword match test contra mensajes del bot ══\n');

  const botMessages = [
    'Digita por favor tu número telefónico de 10 dígitos.',
    'La información proporcionada es incorrecta, Por favor intenta nuevamente.'
  ];
  const keywords = ["software médico","software clínica","sistema clínica","gestión clínica","historia clínica","historias clínicas","HCE","agenda médica","citas médicas","facturación clínica","facturación médica","telemedicina","consultorio","centro de salud","precios","planes","demo","cotización","cotizar","cuánto cuesta","precio","prueba gratis","trial","medilink","implementación","migración","pacientes","recetas","medicamentos","inventario médico"];

  for (const botMsg of botMessages) {
    const normalized = botMsg.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    let matched = false;
    for (const kw of keywords) {
      const normKw = kw.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (normalized.includes(normKw)) {
        console.log(`  ⚠️ "${botMsg}" MATCHEA keyword "${kw}"`);
        matched = true;
      }
    }
    if (!matched) {
      console.log(`  ✅ "${botMsg}" NO matchea ninguna keyword`);
    }
  }

  console.log('\n═══ FIN AUDITORÍA v2 ═══\n');
}

audit()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('ERROR FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
