'use strict';

/**
 * INVENTARIO CELULAR PERSONAL — C-364 SEC-C-iv (Corrección 1)
 *
 * Objetivo per Mariano textual: "verifiques cómo/dónde están persistidas hoy:
 * ¿Hay pipeline Baileys activo que guarda el celular personal en
 * users/bq2.../conversations/{phone}? ¿O está en otra colección?"
 *
 * Scope READ-ONLY. No escribe nada en Firestore.
 *
 * Preguntas a responder:
 *   Q1 — ¿Existe users/bq2.../conversations/* ? ¿Cuántos docs?
 *   Q2 — ¿Existe conversations/* a root? ¿Qué phones aparecen?
 *   Q3 — ¿Existe baileys_sessions/* ? ¿Qué tenants tienen creds?
 *   Q4 — De los phones con persistencia, top-5 por cantidad de mensajes
 *   Q5 — ¿Hay persistencia específica de +573163937365 (celular personal)?
 *
 * USO:
 *   node scripts/inventario_celular_personal.js
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const OWNER_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';
const PHONE_PERSONAL = '573163937365';
const PHONE_MIIA_CENTER = '573054169969';

const CREDS_PATHS = [
  path.join(__dirname, '..', '..', '.claude', 'credentials', 'miia-app-8cbd0-firebase-adminsdk-fbsvc-36d22063e7.json'),
  path.join(__dirname, '..', 'miia-app-8cbd0-firebase-adminsdk-fbsvc-15d19cee57.json'),
  path.join(__dirname, '..', 'miia-app-8cbd0-firebase-adminsdk-fbsvc-f01a2b2269.json'),
];

function findCreds() {
  for (const p of CREDS_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('serviceAccountKey no encontrado');
}

function init() {
  if (!admin.apps.length) {
    const creds = findCreds();
    console.log('[INV] 🔐 Creds:', creds.replace(/.*[\\\/]/, ''));
    admin.initializeApp({ credential: admin.credential.cert(require(creds)) });
  }
  return admin.firestore();
}

async function q1_userConversations(db) {
  console.log('\n[INV] Q1 — users/' + OWNER_UID + '/conversations/*');
  try {
    const snap = await db.collection('users').doc(OWNER_UID).collection('conversations').get();
    console.log(`      Total docs: ${snap.size}`);
    if (snap.size === 0) {
      console.log('      ⚠️  VACÍO — no hay persistencia de conversations bajo el UID de Mariano');
      return { exists: false, count: 0, phones: [] };
    }
    const phones = [];
    snap.forEach(d => {
      const data = d.data();
      const msgCount = Array.isArray(data.messages) ? data.messages.length
        : (typeof data.msgCount === 'number' ? data.msgCount : null);
      phones.push({ id: d.id, msgCount, lastMsg: data.lastMessageAt || data.updatedAt || null });
    });
    phones.sort((a, b) => (b.msgCount || 0) - (a.msgCount || 0));
    console.log('      Top-10 phones por msgCount:');
    phones.slice(0, 10).forEach((p, i) => {
      console.log(`        ${i+1}. ${p.id} — ${p.msgCount ?? '?'} msgs`);
    });
    return { exists: true, count: snap.size, phones };
  } catch (e) {
    console.error('      ❌', e.message);
    return { error: e.message };
  }
}

async function q2_rootConversations(db) {
  console.log('\n[INV] Q2 — conversations/* (colección raíz)');
  try {
    const snap = await db.collection('conversations').limit(100).get();
    console.log(`      Docs (limitado a 100): ${snap.size}`);
    if (snap.size === 0) {
      console.log('      ⚠️  VACÍO o no existe');
      return { exists: false, count: 0 };
    }
    const ids = [];
    snap.forEach(d => ids.push(d.id));
    console.log(`      Primeros 20 ids:`);
    ids.slice(0, 20).forEach(id => console.log(`        - ${id}`));
    const hasPersonal = ids.includes(PHONE_PERSONAL);
    const hasMiiaCenter = ids.includes(PHONE_MIIA_CENTER);
    console.log(`      ¿Contiene ${PHONE_PERSONAL} (personal)? ${hasPersonal ? '✅ SÍ' : '❌ NO'}`);
    console.log(`      ¿Contiene ${PHONE_MIIA_CENTER} (MIIA CENTER)? ${hasMiiaCenter ? '✅ SÍ' : '❌ NO'}`);
    return { exists: true, count: snap.size, ids, hasPersonal, hasMiiaCenter };
  } catch (e) {
    console.error('      ❌', e.message);
    return { error: e.message };
  }
}

async function q3_baileysSessions(db) {
  console.log('\n[INV] Q3 — baileys_sessions/*');
  try {
    const snap = await db.collection('baileys_sessions').get();
    console.log(`      Tenants con sesión: ${snap.size}`);
    const tenants = [];
    snap.forEach(d => tenants.push(d.id));
    tenants.forEach(t => console.log(`        - ${t}`));
    return { exists: true, count: snap.size, tenants };
  } catch (e) {
    console.error('      ❌', e.message);
    return { error: e.message };
  }
}

async function q4_personalSpecific(db) {
  console.log('\n[INV] Q4 — Persistencia específica de ' + PHONE_PERSONAL);
  const results = {};

  try {
    const doc1 = await db.collection('users').doc(OWNER_UID).collection('conversations').doc(PHONE_PERSONAL).get();
    results.userConvo = doc1.exists;
    console.log(`      users/${OWNER_UID}/conversations/${PHONE_PERSONAL}: ${doc1.exists ? '✅ EXISTE' : '❌ NO existe'}`);
    if (doc1.exists) {
      const d = doc1.data();
      const mc = Array.isArray(d.messages) ? d.messages.length : (d.msgCount || '?');
      console.log(`        msgCount: ${mc}`);
    }
  } catch (e) { results.userConvoErr = e.message; }

  try {
    const doc2 = await db.collection('conversations').doc(PHONE_PERSONAL).get();
    results.rootConvo = doc2.exists;
    console.log(`      conversations/${PHONE_PERSONAL}: ${doc2.exists ? '✅ EXISTE' : '❌ NO existe'}`);
    if (doc2.exists) {
      const d = doc2.data();
      const mc = Array.isArray(d.messages) ? d.messages.length : (d.msgCount || '?');
      console.log(`        msgCount: ${mc}`);
    }
  } catch (e) { results.rootConvoErr = e.message; }

  try {
    const doc3 = await db.collection('baileys_sessions').doc(`tenant-${OWNER_UID}`).get();
    results.baileysTenant = doc3.exists;
    console.log(`      baileys_sessions/tenant-${OWNER_UID}: ${doc3.exists ? '✅ EXISTE' : '❌ NO existe'}`);
  } catch (e) { results.baileysTenantErr = e.message; }

  return results;
}

async function q5_miiaPersistent(db) {
  console.log('\n[INV] Q5 — miia_persistent/tenant_conversations (ctx TMH)');
  try {
    const doc = await db.collection('users').doc(OWNER_UID).collection('miia_persistent').doc('tenant_conversations').get();
    if (!doc.exists) {
      console.log('      ❌ NO existe');
      return { exists: false };
    }
    const data = doc.data();
    const convos = data.conversations || {};
    const phones = Object.keys(convos);
    console.log(`      Total phones en ctx: ${phones.length}`);
    const counts = phones.map(p => {
      const arr = Array.isArray(convos[p]) ? convos[p] : [];
      return { phone: p, msgCount: arr.length };
    }).sort((a, b) => b.msgCount - a.msgCount);
    console.log('      Top-10 por msgCount:');
    counts.slice(0, 10).forEach((c, i) => {
      const marker = c.phone.includes(PHONE_PERSONAL) ? '  ← PERSONAL' : '';
      console.log(`        ${i+1}. ${c.phone} — ${c.msgCount} msgs${marker}`);
    });
    const personalEntries = phones.filter(p => p.includes(PHONE_PERSONAL));
    console.log(`      Entries con ${PHONE_PERSONAL}: ${personalEntries.length}`);
    return { exists: true, totalPhones: phones.length, topCounts: counts.slice(0, 20), personalEntries };
  } catch (e) {
    console.error('      ❌', e.message);
    return { error: e.message };
  }
}

(async () => {
  const db = init();

  const r1 = await q1_userConversations(db);
  const r2 = await q2_rootConversations(db);
  const r3 = await q3_baileysSessions(db);
  const r4 = await q4_personalSpecific(db);
  const r5 = await q5_miiaPersistent(db);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('[INV] RESUMEN PARA C-365 SEC-C-iv');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  users/${OWNER_UID}/conversations/*:  ${r1.count || 0} docs`);
  console.log(`  conversations/* (root, limit 100):   ${r2.count || 0} docs`);
  console.log(`  baileys_sessions/*:                  ${r3.count || 0} tenants`);
  console.log(`  miia_persistent/tenant_conversations phones: ${r5.totalPhones || 0}`);
  console.log(`  ¿Celular personal persistido?:       ${r4.userConvo || r4.rootConvo ? 'SÍ' : 'NO'}`);

  process.exit(0);
})().catch(e => {
  console.error('[INV] ❌ FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
