/**
 * ADN de Ventas — Extractor v2 (Carta #C-095)
 *
 * Lee el training_data minado por el history sync y el contact_index
 * para generar el input del análisis ADN.
 *
 * Uso: node scripts/adn_ventas_extract.js
 */

require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Init Firebase
let pk = process.env.FIREBASE_PRIVATE_KEY || '';
if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
  pk = pk.slice(1, -1);
}
pk = pk.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: pk,
  }),
});

const db = admin.firestore();
const UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  ADN VENTAS EXTRACTOR v2 — Carta #C-095');
  console.log('═══════════════════════════════════════════════════\n');

  // ── TAREA 1: Conteo y clasificación de contact_index ──
  console.log('── TAREA 1: CONTEO Y CLASIFICACIÓN ──\n');

  const contactIndexRef = db.collection(`users/${UID}/contact_index`);
  const snapshot = await contactIndexRef.get();

  const leads = [];
  const clients = [];
  const others = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    const entry = { phone: doc.id, ...data };

    if (data.type === 'lead' || data.type === 'miia_lead') {
      leads.push(entry);
    } else if (data.type === 'client' || data.type === 'cliente') {
      clients.push(entry);
    } else {
      others.push(entry);
    }
  });

  console.log(`Total documentos en contact_index: ${snapshot.size}`);
  console.log(`  - Leads: ${leads.length}`);
  console.log(`  - Clientes: ${clients.length}`);
  console.log(`  - Otros: ${others.length} (tipos: ${[...new Set(others.map(o => o.type))].join(', ') || 'ninguno'})`);

  // Leads con datos enriquecidos (del history mining)
  const enrichedLeads = leads.filter(l => l.source === 'history_mining' && l.messageCount > 0);
  const enrichedClients = clients.filter(c => c.source === 'history_mining' && c.messageCount > 0);
  console.log(`\nEnriquecidos por history mining:`);
  console.log(`  - Leads con conversación: ${enrichedLeads.length}`);
  console.log(`  - Clientes con conversación: ${enrichedClients.length}`);

  // Distribución de mensajes
  const leadMsgCounts = enrichedLeads.map(l => l.messageCount || 0).sort((a, b) => a - b);
  if (leadMsgCounts.length > 0) {
    console.log(`\nDistribución de mensajes por lead:`);
    console.log(`  - Min: ${leadMsgCounts[0]}, Mediana: ${leadMsgCounts[Math.floor(leadMsgCounts.length / 2)]}, Max: ${leadMsgCounts[leadMsgCounts.length - 1]}`);
    console.log(`  - Con 5+ msgs: ${leadMsgCounts.filter(n => n >= 5).length}`);
    console.log(`  - Con 10+ msgs: ${leadMsgCounts.filter(n => n >= 10).length}`);
    console.log(`  - Con 20+ msgs: ${leadMsgCounts.filter(n => n >= 20).length}`);
  }

  // Muestra de leads enriquecidos
  console.log('\nMuestra de LEADS enriquecidos (top 5 por mensajes):');
  enrichedLeads.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
  enrichedLeads.slice(0, 5).forEach(l => {
    console.log(`  📞 ${l.phone.substring(0, 6)}*** — ${l.name || 'sin nombre'} | msgs: ${l.messageCount} (owner: ${l.ownerMessageCount}, contact: ${l.contactMessageCount})`);
    if (l.conversationSummary) console.log(`     📝 ${l.conversationSummary.substring(0, 120)}...`);
  });

  // ── TAREA 2: TRAINING DATA (conversaciones raw del ADN mining) ──
  console.log('\n── TAREA 2: TRAINING DATA (ADN Mining) ──\n');

  // Buscar en miia_persistent/training_data
  const trainingRef = db.collection(`users/${UID}/miia_persistent`).doc('training_data');
  const trainingDoc = await trainingRef.get();

  let rawADN = '';
  if (trainingDoc.exists) {
    const tData = trainingDoc.data();
    rawADN = tData.content || tData.data || '';
    console.log(`training_data encontrado: ${rawADN.length} chars`);

    // Contar conversaciones de leads y clientes en el raw
    const leadMatches = rawADN.match(/\[LEAD \d+/g);
    const clientMatches = rawADN.match(/\[CLIENTE \d+/g);
    console.log(`  - Bloques de LEAD: ${leadMatches ? leadMatches.length : 0}`);
    console.log(`  - Bloques de CLIENTE: ${clientMatches ? clientMatches.length : 0}`);
  } else {
    console.log('⚠️ training_data no encontrado en miia_persistent');
  }

  // También buscar en tenant_conversations.trainingData
  const tenantConvRef = db.collection(`users/${UID}/miia_persistent`).doc('tenant_conversations');
  const tenantConvDoc = await tenantConvRef.get();
  if (tenantConvDoc.exists) {
    const tcData = tenantConvDoc.data();
    if (tcData.trainingData) {
      console.log(`\ntrainingData en tenant_conversations: ${tcData.trainingData.length} chars`);
      if (!rawADN || tcData.trainingData.length > rawADN.length) {
        rawADN = tcData.trainingData;
        console.log(`  → Usando esta fuente (más grande)`);
      }
    }
  }

  // Listar todos los docs en miia_persistent para encontrar el training data
  if (!rawADN) {
    console.log('\nBuscando en todos los docs de miia_persistent...');
    const allPersistent = await db.collection(`users/${UID}/miia_persistent`).listDocuments();
    for (const docRef of allPersistent) {
      const doc = await docRef.get();
      if (doc.exists) {
        const data = doc.data();
        const keys = Object.keys(data);
        const sizes = keys.map(k => `${k}:${typeof data[k] === 'string' ? data[k].length + 'ch' : typeof data[k]}`);
        console.log(`  📄 ${docRef.id}: ${sizes.join(', ')}`);
      }
    }
  }

  if (rawADN.length > 0) {
    // Extraer solo la sección de leads
    const leadSection = rawADN.split('[CLIENTE ')[0]; // Todo antes del primer CLIENTE
    const clientSection = rawADN.substring(rawADN.indexOf('[CLIENTE ') >= 0 ? rawADN.indexOf('[CLIENTE ') : rawADN.length);

    console.log(`\nSección LEADS: ${leadSection.length} chars`);
    console.log(`Sección CLIENTES: ${clientSection.length} chars`);

    // Guardar para análisis
    const outputDir = path.join(__dirname, 'adn_output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    // Guardar leads raw (para análisis Opus)
    fs.writeFileSync(path.join(outputDir, 'adn_leads_raw.txt'), leadSection);
    console.log(`\n✅ Leads raw guardado: scripts/adn_output/adn_leads_raw.txt (${leadSection.length} chars)`);

    // Guardar clients raw
    fs.writeFileSync(path.join(outputDir, 'adn_clients_raw.txt'), clientSection);
    console.log(`✅ Clients raw guardado: scripts/adn_output/adn_clients_raw.txt (${clientSection.length} chars)`);

    // Guardar metadata
    fs.writeFileSync(path.join(outputDir, 'adn_metadata.json'), JSON.stringify({
      extractedAt: new Date().toISOString(),
      uid: UID,
      contactIndex: {
        totalDocs: snapshot.size,
        leads: leads.length,
        clients: clients.length,
        others: others.length,
        enrichedLeads: enrichedLeads.length,
        enrichedClients: enrichedClients.length,
      },
      trainingData: {
        totalChars: rawADN.length,
        leadSectionChars: leadSection.length,
        clientSectionChars: clientSection.length,
      },
      topLeadsByMessages: enrichedLeads.slice(0, 20).map(l => ({
        phone: l.phone.substring(0, 6) + '***',
        name: l.name || null,
        messageCount: l.messageCount,
        ownerMessages: l.ownerMessageCount,
        contactMessages: l.contactMessageCount,
        summary: l.conversationSummary?.substring(0, 200) || null,
      })),
    }, null, 2));
    console.log(`✅ Metadata guardado: scripts/adn_output/adn_metadata.json`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  EXTRACCIÓN COMPLETA');
  console.log('═══════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
