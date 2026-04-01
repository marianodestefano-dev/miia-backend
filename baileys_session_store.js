/**
 * BAILEYS SESSION STORE — Firestore-backed auth state for Baileys
 *
 * Stores Baileys auth credentials (creds + keys) in Firestore.
 * Each tenant gets a separate Firestore document collection:
 *   baileys_sessions/{clientId}/keys/{keyId}
 *   baileys_sessions/{clientId}/creds  (single doc)
 *
 * ~50KB per session vs ~5-20MB for whatsapp-web.js Chrome sessions.
 */

'use strict';

const admin = require('firebase-admin');
const { proto } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

/**
 * Create a Firestore-backed auth state for Baileys.
 * @param {string} clientId - unique ID (e.g. "tenant-{uid}")
 * @returns {Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }>}
 */
async function useFirestoreAuthState(clientId) {
  const db = admin.firestore();
  const collection = `baileys_sessions`;
  const docRef = db.collection(collection).doc(clientId);

  // ─── Read/write creds ───
  async function readCreds() {
    try {
      const doc = await docRef.collection('data').doc('creds').get();
      if (!doc.exists) return null;
      return JSON.parse(JSON.stringify(doc.data()), BufferJSON.reviver);
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Error reading creds:`, e.message);
      return null;
    }
  }

  async function writeCreds(creds) {
    try {
      const data = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      // CRÍTICO: crear el documento padre para que auto-init pueda encontrarlo con .get()
      // En Firestore, subcollecciones no crean el doc padre automáticamente
      await docRef.set({ updatedAt: new Date() }, { merge: true });
      await docRef.collection('data').doc('creds').set(data);
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Error writing creds:`, e.message);
    }
  }

  // ─── Read/write keys ───
  async function readKey(type, id) {
    try {
      // Firestore doc IDs can't have '/' — replace with '__'
      const safeId = `${type}__${id}`.replace(/\//g, '__');
      const doc = await docRef.collection('keys').doc(safeId).get();
      if (!doc.exists) return null;
      const raw = JSON.parse(JSON.stringify(doc.data()), BufferJSON.reviver);
      // For pre-keys and other proto types, deserialize
      if (type === 'pre-key') return raw;
      if (type === 'session') return raw;
      if (type === 'sender-key') return raw;
      if (type === 'app-state-sync-key') {
        return proto.Message.AppStateSyncKeyData.fromObject(raw);
      }
      if (type === 'app-state-sync-version') return raw;
      if (type === 'sender-key-memory') return raw;
      return raw;
    } catch (e) {
      return null;
    }
  }

  async function writeKey(type, id, value) {
    try {
      const safeId = `${type}__${id}`.replace(/\//g, '__');
      const data = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
      await docRef.collection('keys').doc(safeId).set(data);
    } catch (e) {
      // Silent — key writes happen frequently
    }
  }

  async function deleteKey(type, id) {
    try {
      const safeId = `${type}__${id}`.replace(/\//g, '__');
      await docRef.collection('keys').doc(safeId).delete();
    } catch (e) {
      // Silent
    }
  }

  // ─── Initialize ───
  let creds = await readCreds();
  if (!creds) {
    creds = initAuthCreds();
    console.log(`[BAILEYS-STORE:${clientId}] No existing session — new creds created`);
  } else {
    console.log(`[BAILEYS-STORE:${clientId}] Existing session loaded from Firestore`);
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const val = await readKey(type, id);
          if (val) result[id] = val;
        }
        return result;
      },
      set: async (data) => {
        const promises = [];
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries)) {
            if (value) {
              promises.push(writeKey(type, id, value));
            } else {
              promises.push(deleteKey(type, id));
            }
          }
        }
        await Promise.all(promises);
      }
    }
  };

  const saveCreds = async () => {
    await writeCreds(state.creds);
  };

  return { state, saveCreds };
}

/**
 * Delete all session data for a client from Firestore.
 * @param {string} clientId
 */
async function deleteFirestoreSession(clientId) {
  try {
    const db = admin.firestore();
    const docRef = db.collection('baileys_sessions').doc(clientId);

    // Delete keys subcollection
    const keysSnap = await docRef.collection('keys').get();
    if (!keysSnap.empty) {
      const batch = db.batch();
      keysSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    // Delete creds
    await docRef.collection('data').doc('creds').delete().catch(() => {});

    // Delete root doc
    await docRef.delete().catch(() => {});

    console.log(`[BAILEYS-STORE:${clientId}] Session deleted from Firestore`);
  } catch (e) {
    console.error(`[BAILEYS-STORE:${clientId}] Error deleting session:`, e.message);
  }
}

module.exports = { useFirestoreAuthState, deleteFirestoreSession };
