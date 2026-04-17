'use strict';

/**
 * CLASIFICACIÓN MASIVA DE CONTACTOS CON IA
 *
 * Lee TODAS las conversaciones de Firestore y clasifica cada contacto:
 * - familia, amigo, equipo, cliente, lead, desconocido
 * - nombre real, relación con el owner
 * - país por teléfono
 *
 * MIIA lee TODO el historial disponible para estar segura al 100%.
 *
 * Modos:
 *   --dry-run       → No escribe, solo muestra qué haría
 *   --uid=XXXX      → UID del owner (default: Mariano)
 *   --force         → Re-clasificar incluso contactos ya clasificados
 *   --phone=573XX   → Clasificar solo un teléfono específico
 *
 * Uso:
 *   node migrations/classify_contacts_ai.js --dry-run
 *   node migrations/classify_contacts_ai.js
 *   node migrations/classify_contacts_ai.js --force
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// ── Config ──
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const UID_ARG = process.argv.find(a => a.startsWith('--uid='));
const PHONE_ARG = process.argv.find(a => a.startsWith('--phone='));
const OWNER_UID = UID_ARG ? UID_ARG.split('=')[1] : 'bq2BbtCVF8cZo30tum584zrGATJ3';
const SINGLE_PHONE = PHONE_ARG ? PHONE_ARG.split('=')[1] : null;

// Rate limiting para Gemini
const GEMINI_DELAY_MS = 4000; // 4s entre llamadas (15 RPM free tier = 1 cada 4s)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Firebase init ──
function initFirebase() {
  if (admin.apps.length) return;
  let credential = null;
  const keyPath = path.join(__dirname, '..', 'firebase-admin-key.json');

  if (fs.existsSync(keyPath)) {
    credential = admin.credential.cert(require(keyPath));
    console.log('[FIREBASE] Inicializado con firebase-admin-key.json');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const rawJSON = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n');
    const sa = JSON.parse(rawJSON);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    credential = admin.credential.cert(sa);
    console.log('[FIREBASE] Inicializado con FIREBASE_SERVICE_ACCOUNT env');
  } else if (process.env.FIREBASE_PROJECT_ID) {
    let pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk
    });
    console.log('[FIREBASE] Inicializado con vars individuales');
  }

  if (!credential) {
    console.error('[FIREBASE] No se encontró credencial.');
    process.exit(1);
  }
  admin.initializeApp({ credential });
}

// ── Gemini call (single-turn, simple) ──
async function callGeminiClassify(apiKey, prompt) {
  const fetchModule = await import('node-fetch').then(m => m.default).catch(() => require('node-fetch'));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetchModule(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
      })
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || null;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ── Country detection ──
let getCountryByPhone;
try {
  const countries = require('../countries');
  getCountryByPhone = countries.getCountryByPhone;
} catch (e) {
  getCountryByPhone = () => ({ code: 'INTL' });
  console.warn('[COUNTRIES] No se pudo cargar, usando INTL por default');
}

// ── Main ──
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  CLASIFICACIÓN MASIVA DE CONTACTOS CON IA`);
  console.log(`  UID: ${OWNER_UID}`);
  console.log(`  Modo: ${DRY_RUN ? '🔍 DRY-RUN' : '🔥 ESCRITURA REAL'}`);
  console.log(`  Force: ${FORCE ? 'SÍ (re-clasifica todo)' : 'NO (solo nuevos/pendientes)'}`);
  if (SINGLE_PHONE) console.log(`  Solo: ${SINGLE_PHONE}`);
  console.log(`${'═'.repeat(60)}\n`);

  initFirebase();
  const db = admin.firestore();
  const userRef = db.collection('users').doc(OWNER_UID);

  // ── PASO 1: Obtener Gemini API key ──
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error('[ERROR] GEMINI_API_KEY no está configurada. Setear variable de entorno.');
    process.exit(1);
  }
  console.log('[PASO 1] ✅ Gemini API key disponible\n');

  // ── PASO 2: Cargar TODAS las fuentes de conversaciones ──
  console.log('[PASO 2] Cargando conversaciones de Firestore...');

  const allConversations = {}; // { phone: [{ role, content, timestamp }] }

  // 2a: miia_persistent/conversations (owner — Mariano)
  try {
    const convoDoc = await userRef.collection('miia_persistent').doc('conversations').get();
    if (convoDoc.exists && convoDoc.data().conversations) {
      const convos = convoDoc.data().conversations;
      for (const [phone, msgs] of Object.entries(convos)) {
        const cleanPhone = phone.replace('@s.whatsapp.net', '').split(':')[0];
        if (!allConversations[cleanPhone]) allConversations[cleanPhone] = [];
        if (Array.isArray(msgs)) {
          allConversations[cleanPhone].push(...msgs);
        }
      }
      console.log(`  📱 Owner conversations: ${Object.keys(convos).length} contactos`);
    }
  } catch (e) { console.warn('  ⚠️ Error cargando owner conversations:', e.message); }

  // 2b: miia_persistent/tenant_conversations (tenants/MIIA CENTER)
  try {
    const tenantDoc = await userRef.collection('miia_persistent').doc('tenant_conversations').get();
    if (tenantDoc.exists && tenantDoc.data().conversations) {
      const convos = tenantDoc.data().conversations;
      for (const [phone, msgs] of Object.entries(convos)) {
        const cleanPhone = phone.replace('@s.whatsapp.net', '').split(':')[0];
        if (!allConversations[cleanPhone]) allConversations[cleanPhone] = [];
        if (Array.isArray(msgs)) {
          allConversations[cleanPhone].push(...msgs);
        }
      }
      console.log(`  📱 Tenant conversations: ${Object.keys(convos).length} contactos`);
    }
  } catch (e) { console.warn('  ⚠️ Error cargando tenant conversations:', e.message); }

  // 2c: contact_index existente (para no re-clasificar lo que ya está)
  const existingIndex = {};
  try {
    const indexSnap = await userRef.collection('contact_index').get();
    indexSnap.forEach(doc => {
      existingIndex[doc.id] = doc.data();
    });
    console.log(`  📇 contact_index existente: ${Object.keys(existingIndex).length} contactos`);
  } catch (e) { console.warn('  ⚠️ Error cargando contact_index:', e.message); }

  // 2d: contactTypes del owner (legacy)
  let legacyContactTypes = {};
  try {
    const contactsDoc = await userRef.collection('miia_persistent').doc('contacts').get();
    if (contactsDoc.exists) {
      legacyContactTypes = contactsDoc.data().contactTypes || {};
      // También agregar leadNames
      const leadNames = contactsDoc.data().leadNames || {};
      for (const [ph, name] of Object.entries(leadNames)) {
        const clean = ph.replace('@s.whatsapp.net', '').split(':')[0];
        if (!existingIndex[clean]) {
          existingIndex[clean] = { name, type: legacyContactTypes[ph] || 'unknown' };
        }
      }
    }
    console.log(`  📋 Legacy contactTypes: ${Object.keys(legacyContactTypes).length}`);
  } catch (e) { console.warn('  ⚠️ Error cargando legacy contacts:', e.message); }

  // 2e: contact_groups (familia, equipo, etc.) — estos ya están clasificados
  const knownGroupContacts = new Set();
  try {
    const groupsSnap = await userRef.collection('contact_groups').get();
    for (const gDoc of groupsSnap.docs) {
      const contactsSnap = await userRef.collection('contact_groups').doc(gDoc.id).collection('contacts').get();
      contactsSnap.forEach(cDoc => {
        knownGroupContacts.add(cDoc.id);
      });
    }
    console.log(`  👥 Contactos ya en grupos: ${knownGroupContacts.size}`);
  } catch (e) { console.warn('  ⚠️ Error cargando contact_groups:', e.message); }

  // ── PASO 3: Determinar qué contactos clasificar ──
  console.log('\n[PASO 3] Determinando contactos a clasificar...');

  // Unir todas las fuentes de teléfonos conocidos
  const allPhones = new Set([
    ...Object.keys(allConversations),
    ...Object.keys(existingIndex)
  ]);

  // Filtrar self-chat y números inválidos
  const ownerPhones = ['573163937365', '573054169969']; // Mariano + MIIA CENTER
  const toClassify = [];

  for (const phone of allPhones) {
    if (SINGLE_PHONE && phone !== SINGLE_PHONE) continue;
    if (ownerPhones.includes(phone)) continue;
    if (phone.length < 8) continue; // números inválidos
    if (phone.includes('status')) continue;
    if (phone.includes('broadcast')) continue;

    // Skip si ya está bien clasificado (a menos que --force)
    if (!FORCE) {
      const existing = existingIndex[phone];
      if (existing && existing.type && !['pending', 'unknown'].includes(existing.type)) {
        // Ya clasificado como familia/equipo/lead/client — skip
        continue;
      }
      if (knownGroupContacts.has(phone)) continue; // ya en un grupo
    }

    toClassify.push(phone);
  }

  console.log(`  📊 Total teléfonos: ${allPhones.size}`);
  console.log(`  🎯 A clasificar: ${toClassify.length}`);

  if (toClassify.length === 0) {
    console.log('\n✅ Todos los contactos ya están clasificados. Nada que hacer.');
    if (!FORCE) console.log('   Tip: usa --force para re-clasificar todo.');
    process.exit(0);
  }

  // ── PASO 4: Clasificar con Gemini ──
  console.log(`\n[PASO 4] Clasificando con Gemini Flash (${toClassify.length} contactos)...\n`);

  const results = [];
  let classified = 0;
  let errors = 0;

  for (const phone of toClassify) {
    const convo = allConversations[phone] || [];
    const existing = existingIndex[phone] || {};
    const country = getCountryByPhone(phone);
    const countryCode = country?.code || 'INTL';

    // Preparar historial completo para Gemini
    let chatHistory = '';
    if (convo.length > 0) {
      // Usar TODO el historial disponible (Mariano dijo: "absolutamente todo")
      const messages = convo
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .map(m => {
          const role = m.role === 'assistant' ? 'MIIA' : 'CONTACTO';
          const time = m.timestamp ? new Date(m.timestamp).toLocaleString('es-CO') : '';
          return `[${role}${time ? ' ' + time : ''}]: ${(m.content || '').substring(0, 500)}`;
        });
      chatHistory = messages.join('\n');
    }

    const existingName = existing.name || '';
    const existingType = existing.type || '';
    const legacyType = legacyContactTypes[`${phone}@s.whatsapp.net`] || '';

    const prompt = `Eres un clasificador de contactos para MIIA, asistente de WhatsApp de Mariano (empresario colombo-argentino que vende software médico "Medilink" desde Chile).

TELÉFONO: +${phone}
PAÍS DETECTADO: ${countryCode}
NOMBRE REGISTRADO: ${existingName || 'desconocido'}
CLASIFICACIÓN ACTUAL: ${existingType || legacyType || 'sin clasificar'}

HISTORIAL DE CHAT COMPLETO:
${chatHistory || '(Sin historial de conversación disponible)'}

CONTEXTO DE MARIANO:
- Familia: mamá Silvia (Argentina), esposa Ale/Alejandra (Colombia), papá Sr. Rafael (Argentina), hermana Anabella, suegra Consu, cuñados Jota y Juancho
- Equipo Medilink: compañeros de trabajo, mayormente números chilenos (+56) y colombianos (+57)
- Negocio: Vende Medilink (software médico) a doctores/clínicas en LatAm y España
- Amigos: círculo personal, tono informal

Clasifica este contacto. Responde EXACTAMENTE en este formato JSON (sin markdown, sin backticks):
{"type":"familia|amigo|equipo|cliente|lead|desconocido","name":"nombre real o mejor aproximación","relation":"relación con Mariano (ej: mamá, esposa, amigo, colega, lead interesado en Medilink)","confidence":"alta|media|baja","reason":"explicación breve de por qué clasificaste así"}

REGLAS:
- Si hablan de familia, planes personales, tono cercano → familia o amigo
- Si hablan de trabajo/Medilink internamente → equipo
- Si preguntan precios, funcionalidades, demo → lead
- Si ya son usuarios/pagan Medilink → cliente
- Si no hay historial suficiente → desconocido con confidence baja
- Si el tono es MUY informal, chistes, planes de salida → amigo
- Si mencionan términos familiares (mamá, hijo, hermano, etc.) → familia
- NUNCA inventes. Si no estás seguro, pon "desconocido" con confidence "baja"`;

    try {
      process.stdout.write(`  📱 +${phone} (${countryCode}, ${convo.length} msgs)... `);

      const response = await callGeminiClassify(geminiKey, prompt);
      if (!response) {
        console.log('❌ Sin respuesta');
        errors++;
        continue;
      }

      // Parsear JSON de la respuesta
      let classification;
      try {
        // Limpiar posibles backticks o markdown
        const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        classification = JSON.parse(cleaned);
      } catch (parseErr) {
        console.log(`❌ JSON inválido: ${response.substring(0, 100)}`);
        errors++;
        await sleep(GEMINI_DELAY_MS);
        continue;
      }

      const { type, name, relation, confidence, reason } = classification;
      console.log(`${type.toUpperCase()} (${confidence}) — ${name || '?'} — ${relation || '?'}`);

      results.push({ phone, countryCode, type, name, relation, confidence, reason, msgCount: convo.length });

      // Guardar si no es dry-run
      if (!DRY_RUN) {
        // Guardar en contact_index
        const indexData = {
          type: type === 'desconocido' ? 'pending' : type,
          name: name || '',
          relation: relation || '',
          country: countryCode !== 'INTL' ? countryCode : undefined,
          classifiedBy: 'ai_migration',
          classifiedAt: new Date().toISOString(),
          confidence,
          updatedAt: new Date().toISOString()
        };
        // Limpiar undefined
        Object.keys(indexData).forEach(k => indexData[k] === undefined && delete indexData[k]);

        await userRef.collection('contact_index').doc(phone).set(indexData, { merge: true });

        // Si es familia/amigo/equipo, agregar al grupo correspondiente
        if (['familia', 'amigo', 'equipo'].includes(type)) {
          const groupId = type === 'amigo' ? 'amigos' : type;

          // Crear grupo "amigos" si no existe
          if (groupId === 'amigos') {
            const amigosRef = userRef.collection('contact_groups').doc('amigos');
            const amigosDoc = await amigosRef.get();
            if (!amigosDoc.exists) {
              await amigosRef.set({
                name: 'Amigos',
                icon: '🤝',
                tone: 'Informal, cercano, como un amigo más de Mariano.',
                autoRespond: false,
                proactiveEnabled: false,
                createdAt: new Date().toISOString(),
                source: 'ai_classification'
              });
              console.log(`    ✨ Grupo "amigos" creado`);
            }
          }

          await userRef.collection('contact_groups').doc(groupId)
            .collection('contacts').doc(phone)
            .set({
              name: name || phone,
              relation: relation || '',
              addedAt: new Date().toISOString(),
              source: 'ai_classification',
              confidence
            }, { merge: true });
        }
      }

      classified++;
      await sleep(GEMINI_DELAY_MS);

    } catch (e) {
      console.log(`❌ Error: ${e.message}`);
      errors++;
      await sleep(GEMINI_DELAY_MS * 2); // esperar más si hay error
    }
  }

  // ── PASO 5: Resumen ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RESULTADO:`);
  console.log(`  ✅ Clasificados: ${classified}`);
  console.log(`  ❌ Errores: ${errors}`);
  console.log(`  📊 Total procesados: ${classified + errors}/${toClassify.length}`);
  if (DRY_RUN) console.log(`  ⚠️ DRY-RUN — nada se escribió`);
  console.log(`${'═'.repeat(60)}`);

  // Tabla resumen por tipo
  if (results.length > 0) {
    const byType = {};
    for (const r of results) {
      if (!byType[r.type]) byType[r.type] = [];
      byType[r.type].push(r);
    }

    console.log('\n📋 RESUMEN POR TIPO:\n');
    for (const [type, contacts] of Object.entries(byType).sort()) {
      console.log(`  ${type.toUpperCase()} (${contacts.length}):`);
      for (const c of contacts) {
        console.log(`    +${c.phone} (${c.countryCode}) → ${c.name || '?'} — ${c.relation || '?'} [${c.confidence}] (${c.msgCount} msgs)`);
      }
    }

    // Guardar reporte
    const reportPath = path.join(__dirname, '..', 'data', 'classification_report.json');
    try {
      const reportDir = path.dirname(reportPath);
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        ownerUid: OWNER_UID,
        dryRun: DRY_RUN,
        force: FORCE,
        results,
        summary: {
          total: results.length,
          byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
          errors
        }
      }, null, 2));
      console.log(`\n📄 Reporte guardado en: ${reportPath}`);
    } catch (e) { console.warn('⚠️ No se pudo guardar reporte:', e.message); }
  }

  process.exit(0);
}

main().catch(e => {
  console.error('[CLASIFICACIÓN] ❌ Error fatal:', e);
  process.exit(1);
});
