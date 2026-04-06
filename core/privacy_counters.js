// ════════════════════════════════════════════════════════════════════════════
// MIIA — Privacy Counters
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Contadores AGREGADOS por usuario. El admin ve métricas sin leer mensajes.
//
// Firestore: users/{uid}/stats/counters
//   { messagesProcessed, messagesOut, contactsTotal, businessesTotal,
//     lastMessageAt, lastActiveAt, createdAt }
//
// Se incrementan con FieldValue.increment() — atómico, sin leer el doc.
// Debounced: acumula en memoria y flushea cada 60s para reducir writes.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// In-memory buffer: { uid: { messagesProcessed: N, messagesOut: N, ... } }
const buffer = {};
const FLUSH_INTERVAL = 60_000; // 60s

/**
 * Incrementa un contador en el buffer (no escribe a Firestore aún)
 */
function increment(uid, field, amount = 1) {
  if (!uid || !field) return;
  if (!buffer[uid]) buffer[uid] = {};
  buffer[uid][field] = (buffer[uid][field] || 0) + amount;
}

/**
 * Registra mensaje entrante procesado
 */
function recordIncoming(uid) {
  increment(uid, 'messagesProcessed');
  buffer[uid] = buffer[uid] || {};
  buffer[uid]._lastMessageAt = new Date();
}

/**
 * Registra mensaje saliente enviado por MIIA
 */
function recordOutgoing(uid) {
  increment(uid, 'messagesOut');
  buffer[uid] = buffer[uid] || {};
  buffer[uid]._lastActiveAt = new Date();
}

/**
 * Registra nuevo contacto clasificado
 */
function recordNewContact(uid) {
  increment(uid, 'contactsTotal');
}

/**
 * Registra nuevo negocio creado
 */
function recordNewBusiness(uid) {
  increment(uid, 'businessesTotal');
}

/**
 * Flush buffer a Firestore (batch atómico)
 */
async function flush() {
  const uids = Object.keys(buffer);
  if (uids.length === 0) return;

  const batch = db.batch();
  let writes = 0;

  for (const uid of uids) {
    const data = buffer[uid];
    if (!data) continue;

    const ref = db.collection('users').doc(uid).collection('stats').doc('counters');
    const update = {};

    // Incrementales
    if (data.messagesProcessed) update.messagesProcessed = FieldValue.increment(data.messagesProcessed);
    if (data.messagesOut) update.messagesOut = FieldValue.increment(data.messagesOut);
    if (data.contactsTotal) update.contactsTotal = FieldValue.increment(data.contactsTotal);
    if (data.businessesTotal) update.businessesTotal = FieldValue.increment(data.businessesTotal);

    // Timestamps (set, no increment)
    if (data._lastMessageAt) update.lastMessageAt = data._lastMessageAt;
    if (data._lastActiveAt) update.lastActiveAt = data._lastActiveAt;

    if (Object.keys(update).length > 0) {
      batch.set(ref, update, { merge: true });
      writes++;
    }

    delete buffer[uid];
  }

  if (writes > 0) {
    try {
      await batch.commit();
      console.log(`[PRIVACY-COUNTERS] ✅ Flushed ${writes} user counter(s)`);
    } catch (e) {
      console.error(`[PRIVACY-COUNTERS] ❌ Flush error: ${e.message}`);
    }
  }
}

/**
 * Lee contadores de un usuario (para admin dashboard)
 */
async function getCounters(uid) {
  try {
    const doc = await db.collection('users').doc(uid).collection('stats').doc('counters').get();
    return doc.exists ? doc.data() : { messagesProcessed: 0, messagesOut: 0, contactsTotal: 0, businessesTotal: 0 };
  } catch (e) {
    console.error(`[PRIVACY-COUNTERS] ❌ getCounters(${uid}): ${e.message}`);
    return { messagesProcessed: 0, messagesOut: 0, contactsTotal: 0, businessesTotal: 0 };
  }
}

// Auto-flush cada 60s
let flushTimer = null;
function startAutoFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL);
  console.log('[PRIVACY-COUNTERS] 🟢 Auto-flush iniciado (cada 60s)');
}

function stopAutoFlush() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

module.exports = {
  recordIncoming,
  recordOutgoing,
  recordNewContact,
  recordNewBusiness,
  getCounters,
  flush,
  startAutoFlush,
  stopAutoFlush
};
