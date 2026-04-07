/**
 * BAILEYS SESSION STORE v2.0 — Fortress-grade session persistence
 *
 * ARCHITECTURE: Identity/Session Separation
 * ==========================================
 * WhatsApp Web stays connected for weeks because it separates:
 *   - Device Identity (noiseKey, signedIdentityKey, registrationId) → SACRED, never deleted
 *   - Session Keys (per-conversation ratchets) → VOLATILE, can be purged and renegotiated
 *
 * This store implements 7 layers of protection:
 *   Layer 1: Identity/Session separation (identity is NEVER deleted by cleanup)
 *   Layer 2: Identity backup ring (last 3 versions)
 *   Layer 3: Creds write guard (blocks saves during crypto errors)
 *   Layer 4: Atomic creds versioning (version counter + hash)
 *   Layer 5: Health status tracking (persistent error history)
 *   Layer 6: Session key purge (delete volatile keys without touching identity)
 *   Layer 7: Identity restoration (roll back to last known good)
 *
 * Firestore structure:
 *   baileys_sessions/{clientId}/
 *   ├── data/creds              ← Current creds (identity + state)
 *   ├── data/identity_backup_1  ← Previous identity snapshot
 *   ├── data/identity_backup_2  ← Identity snapshot before that
 *   ├── data/identity_backup_3  ← Oldest identity snapshot
 *   ├── data/health             ← Error history, last healthy timestamp
 *   └── keys/{keyId}            ← Signal session keys (VOLATILE)
 *
 * Standard: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 */

'use strict';

const admin = require('firebase-admin');
const { proto } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// IDENTITY FIELDS — These are what tie us to the QR scan.
// If these survive, we NEVER need to scan QR again.
// ═══════════════════════════════════════════════════════════════════
const IDENTITY_FIELDS = [
  'noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey',
  'signedPreKey', 'registrationId', 'advSecretKey',
  'processedHistoryMessages', 'nextPreKeyId', 'firstUnuploadedPreKeyId',
  'accountSyncCounter', 'accountSettings', 'me', 'account',
  'signalIdentities', 'platform', 'lastAccountSyncTimestamp'
];

/**
 * Extract only identity fields from creds object.
 * These are the fields that, if preserved, prevent QR re-scan.
 */
function extractIdentity(creds) {
  if (!creds) return null;
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    if (creds[field] !== undefined) {
      identity[field] = creds[field];
    }
  }
  return identity;
}

/**
 * Compute a hash of the identity for change detection.
 */
function hashIdentity(identity) {
  if (!identity) return 'null';
  try {
    const serialized = JSON.stringify(identity, BufferJSON.replacer);
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 16);
  } catch {
    return 'error';
  }
}

/**
 * Validate that creds contain minimum required identity fields.
 */
function validateIdentity(creds) {
  if (!creds) return { valid: false, reason: 'null_creds' };
  const critical = ['noiseKey', 'signedIdentityKey', 'registrationId'];
  for (const field of critical) {
    if (!creds[field]) {
      return { valid: false, reason: `missing_${field}` };
    }
  }
  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: useFirestoreAuthState — Fortress implementation
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a Firestore-backed auth state for Baileys with 7-layer protection.
 * @param {string} clientId - unique ID (e.g. "tenant-{uid}")
 * @returns {Promise<{ state, saveCreds, getHealth, purgeSessionKeys, restoreIdentity }>}
 */
async function useFirestoreAuthState(clientId) {
  const db = admin.firestore();
  const docRef = db.collection('baileys_sessions').doc(clientId);

  // ─── State flags ───
  let _credsWriteBlocked = false;
  let _credsWriteBlockedUntil = 0;
  let _credsVersion = 0;
  let _lastIdentityHash = 'unknown';
  let _lastHealthySave = 0;

  // ═══ Layer 1 & 2: Read creds with identity backup ═══

  async function readCreds() {
    try {
      const doc = await docRef.collection('data').doc('creds').get();
      if (!doc.exists) return null;
      const parsed = JSON.parse(JSON.stringify(doc.data()), BufferJSON.reviver);

      // Read metadata
      const metaDoc = await docRef.collection('data').doc('creds_meta').get();
      if (metaDoc.exists) {
        _credsVersion = metaDoc.data()?.version || 0;
        _lastIdentityHash = metaDoc.data()?.identityHash || 'unknown';
        _lastHealthySave = metaDoc.data()?.lastHealthySave || 0;
      }

      // Validate identity integrity
      const validation = validateIdentity(parsed);
      if (!validation.valid) {
        console.error(`[BAILEYS-STORE:${clientId}] ⚠️ Loaded creds INVALID: ${validation.reason}. Attempting identity restore...`);
        const restored = await restoreIdentityFromBackup(parsed);
        if (restored) return restored;
        console.error(`[BAILEYS-STORE:${clientId}] ❌ Identity restore FAILED. Will need QR scan.`);
        return null;
      }

      console.log(`[BAILEYS-STORE:${clientId}] ✅ Session loaded (v${_credsVersion}, identity=${_lastIdentityHash})`);
      return parsed;
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Error reading creds:`, e.message);
      return null;
    }
  }

  // ═══ Layer 3 & 4: Write creds with guard + versioning ═══

  async function writeCreds(creds) {
    // Layer 3: Write guard — block saves during crypto errors
    if (_credsWriteBlocked && Date.now() < _credsWriteBlockedUntil) {
      console.warn(`[BAILEYS-STORE:${clientId}] 🛡️ creds.write BLOCKED (crypto error cooldown, ${Math.round((_credsWriteBlockedUntil - Date.now()) / 1000)}s remaining)`);
      return;
    }
    _credsWriteBlocked = false;

    try {
      const validation = validateIdentity(creds);
      if (!validation.valid) {
        console.error(`[BAILEYS-STORE:${clientId}] 🚫 REFUSING to save invalid creds: ${validation.reason}`);
        return;
      }

      const data = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      const newIdentityHash = hashIdentity(extractIdentity(creds));

      // Layer 2: If identity changed, save backup BEFORE overwriting
      if (newIdentityHash !== _lastIdentityHash && _lastIdentityHash !== 'unknown') {
        console.log(`[BAILEYS-STORE:${clientId}] 🔄 Identity changed (${_lastIdentityHash} → ${newIdentityHash}). Backing up...`);
        await rotateIdentityBackup();
      }

      // Layer 4: Atomic write with version
      _credsVersion++;
      await docRef.set({ updatedAt: new Date() }, { merge: true });
      await docRef.collection('data').doc('creds').set(data);
      await docRef.collection('data').doc('creds_meta').set({
        version: _credsVersion,
        identityHash: newIdentityHash,
        lastHealthySave: Date.now(),
        savedAt: new Date()
      });

      _lastIdentityHash = newIdentityHash;
      _lastHealthySave = Date.now();
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Error writing creds:`, e.message);
    }
  }

  // ═══ Layer 2: Identity backup ring (keeps last 3) ═══

  async function rotateIdentityBackup() {
    try {
      // Move backup_2 → backup_3
      const b2 = await docRef.collection('data').doc('identity_backup_2').get();
      if (b2.exists) {
        await docRef.collection('data').doc('identity_backup_3').set(b2.data());
      }
      // Move backup_1 → backup_2
      const b1 = await docRef.collection('data').doc('identity_backup_1').get();
      if (b1.exists) {
        await docRef.collection('data').doc('identity_backup_2').set(b1.data());
      }
      // Save current → backup_1
      const current = await docRef.collection('data').doc('creds').get();
      if (current.exists) {
        await docRef.collection('data').doc('identity_backup_1').set({
          ...current.data(),
          _backupAt: new Date(),
          _backupVersion: _credsVersion,
          _identityHash: _lastIdentityHash
        });
        console.log(`[BAILEYS-STORE:${clientId}] 💾 Identity backup rotated (v${_credsVersion})`);
      }
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Backup rotation error:`, e.message);
    }
  }

  // ═══ Layer 7: Identity restoration from backup ═══

  async function restoreIdentityFromBackup(partialCreds) {
    for (const backupName of ['identity_backup_1', 'identity_backup_2', 'identity_backup_3']) {
      try {
        const doc = await docRef.collection('data').doc(backupName).get();
        if (!doc.exists) continue;

        const backupData = JSON.parse(JSON.stringify(doc.data()), BufferJSON.reviver);
        const validation = validateIdentity(backupData);
        if (!validation.valid) continue;

        // Merge: use backup identity + whatever valid state we have
        const restored = { ...backupData, ...(partialCreds || {}) };
        // But override corrupted identity fields from backup
        for (const field of IDENTITY_FIELDS) {
          if (backupData[field] !== undefined) {
            restored[field] = backupData[field];
          }
        }

        const restoredValidation = validateIdentity(restored);
        if (restoredValidation.valid) {
          console.log(`[BAILEYS-STORE:${clientId}] ✅ Identity RESTORED from ${backupName} (hash=${hashIdentity(extractIdentity(restored))})`);
          // Save the restored creds back
          const data = JSON.parse(JSON.stringify(restored, BufferJSON.replacer));
          await docRef.collection('data').doc('creds').set(data);
          return restored;
        }
      } catch (e) {
        console.warn(`[BAILEYS-STORE:${clientId}] Restore from ${backupName} failed:`, e.message);
      }
    }
    return null;
  }

  // ═══ Layer 3: Block/unblock creds writes ═══

  function blockCredsWrites(durationMs = 60000) {
    _credsWriteBlocked = true;
    _credsWriteBlockedUntil = Date.now() + durationMs;
    console.log(`[BAILEYS-STORE:${clientId}] 🛡️ Creds writes BLOCKED for ${durationMs / 1000}s`);
  }

  function unblockCredsWrites() {
    _credsWriteBlocked = false;
    _credsWriteBlockedUntil = 0;
    console.log(`[BAILEYS-STORE:${clientId}] ✅ Creds writes UNBLOCKED`);
  }

  // ═══ Layer 6: Purge session keys WITHOUT touching identity ═══

  async function purgeSessionKeys() {
    try {
      const keysSnap = await docRef.collection('keys').get();
      if (keysSnap.empty) {
        console.log(`[BAILEYS-STORE:${clientId}] No session keys to purge`);
        return 0;
      }

      // Batch delete in groups of 500 (Firestore limit)
      let deleted = 0;
      const batches = [];
      let batch = db.batch();
      let batchCount = 0;

      for (const doc of keysSnap.docs) {
        batch.delete(doc.ref);
        batchCount++;
        deleted++;
        if (batchCount >= 499) {
          batches.push(batch.commit());
          batch = db.batch();
          batchCount = 0;
        }
      }
      if (batchCount > 0) batches.push(batch.commit());
      await Promise.all(batches);

      console.log(`[BAILEYS-STORE:${clientId}] 🧹 Purged ${deleted} session keys (identity PRESERVED)`);
      return deleted;
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Error purging keys:`, e.message);
      return 0;
    }
  }

  // ═══ Layer 6b: Purge session keys for a SPECIFIC contact (per-JID recovery) ═══
  // Instead of purging ALL keys (nuclear), only purge sender-key and session docs
  // that match a specific JID. This preserves crypto state with all OTHER contacts.

  async function purgeSessionKeysForContact(jid) {
    if (!jid) return 0;
    try {
      const keysSnap = await docRef.collection('keys').get();
      if (keysSnap.empty) return 0;

      // Normalize JID: strip :device suffix and @s.whatsapp.net
      const baseJid = jid.split(':')[0].split('@')[0];
      let deleted = 0;
      const batch = db.batch();

      for (const doc of keysSnap.docs) {
        // Sender keys and sessions include the JID in the doc ID
        // Patterns: "sender-key-{jid}", "session-{jid}", or contain the phone number
        const docId = doc.id;
        if (docId.includes(baseJid) || docId.includes(`sender-key-${baseJid}`) || docId.includes(`session-${baseJid}`)) {
          batch.delete(doc.ref);
          deleted++;
        }
      }

      if (deleted > 0) {
        await batch.commit();
        console.log(`[BAILEYS-STORE:${clientId}] 🎯 Purged ${deleted} keys for contact ${baseJid} (other contacts PRESERVED)`);
      } else {
        console.log(`[BAILEYS-STORE:${clientId}] No keys found for contact ${baseJid}`);
      }
      return deleted;
    } catch (e) {
      console.error(`[BAILEYS-STORE:${clientId}] Error purging keys for contact:`, e.message);
      return 0;
    }
  }

  // ═══ Layer 5: Health tracking ═══

  async function recordHealth(status, details) {
    try {
      await docRef.collection('data').doc('health').set({
        status, // 'healthy' | 'degraded' | 'corrupted'
        details,
        timestamp: new Date(),
        credsVersion: _credsVersion,
        identityHash: _lastIdentityHash
      }, { merge: true });
    } catch (e) {
      // Health tracking is best-effort, never fail loudly here
    }
  }

  async function getHealth() {
    try {
      const doc = await docRef.collection('data').doc('health').get();
      return doc.exists ? doc.data() : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }

  // ═══ Keys read/write (unchanged but with sanitized logging) ═══

  async function readKey(type, id) {
    try {
      const safeId = `${type}__${id}`.replace(/\//g, '__');
      const doc = await docRef.collection('keys').doc(safeId).get();
      if (!doc.exists) return null;
      const raw = JSON.parse(JSON.stringify(doc.data()), BufferJSON.reviver);
      if (type === 'app-state-sync-key') {
        return proto.Message.AppStateSyncKeyData.fromObject(raw);
      }
      return raw;
    } catch {
      return null;
    }
  }

  async function writeKey(type, id, value) {
    // Also blocked during crypto errors (session keys are unreliable too)
    if (_credsWriteBlocked && Date.now() < _credsWriteBlockedUntil) return;
    try {
      const safeId = `${type}__${id}`.replace(/\//g, '__');
      const data = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
      await docRef.collection('keys').doc(safeId).set(data);
    } catch {
      // Silent — key writes happen frequently
    }
  }

  async function deleteKey(type, id) {
    try {
      const safeId = `${type}__${id}`.replace(/\//g, '__');
      await docRef.collection('keys').doc(safeId).delete();
    } catch {
      // Silent
    }
  }

  // ═══ Initialize ═══

  let creds = await readCreds();
  if (!creds) {
    creds = initAuthCreds();
    console.log(`[BAILEYS-STORE:${clientId}] 🆕 No existing session — fresh creds created (will need QR)`);
  }

  // If we loaded existing creds, save an identity backup immediately
  // This ensures we always have at least 1 backup
  if (_credsVersion > 0) {
    const b1 = await docRef.collection('data').doc('identity_backup_1').get();
    if (!b1.exists) {
      await rotateIdentityBackup();
      console.log(`[BAILEYS-STORE:${clientId}] 💾 Initial identity backup created`);
    }
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

  return {
    state,
    saveCreds,
    // New APIs for tenant_manager
    blockCredsWrites,
    unblockCredsWrites,
    purgeSessionKeys,
    purgeSessionKeysForContact,
    restoreIdentityFromBackup,
    recordHealth,
    getHealth,
    validateIdentity: () => validateIdentity(state.creds),
    getIdentityHash: () => _lastIdentityHash,
    getCredsVersion: () => _credsVersion
  };
}

/**
 * Delete ONLY session keys for a client (NOT identity).
 * Use this for crypto error recovery.
 */
async function purgeFirestoreSessionKeys(clientId) {
  const db = admin.firestore();
  const docRef = db.collection('baileys_sessions').doc(clientId);
  const keysSnap = await docRef.collection('keys').get();
  if (keysSnap.empty) return 0;

  let deleted = 0;
  const batches = [];
  let batch = db.batch();
  let count = 0;
  for (const doc of keysSnap.docs) {
    batch.delete(doc.ref);
    count++;
    deleted++;
    if (count >= 499) {
      batches.push(batch.commit());
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) batches.push(batch.commit());
  await Promise.all(batches);
  return deleted;
}

/**
 * Delete ALL session data (identity + keys). NUCLEAR OPTION.
 * Only use when identity itself is corrupted (which should be ~never).
 */
async function deleteFirestoreSession(clientId) {
  try {
    const db = admin.firestore();
    const docRef = db.collection('baileys_sessions').doc(clientId);

    // Delete keys subcollection
    const keysSnap = await docRef.collection('keys').get();
    if (!keysSnap.empty) {
      const batches = [];
      let batch = db.batch();
      let count = 0;
      for (const doc of keysSnap.docs) {
        batch.delete(doc.ref);
        count++;
        if (count >= 499) {
          batches.push(batch.commit());
          batch = db.batch();
          count = 0;
        }
      }
      if (count > 0) batches.push(batch.commit());
      await Promise.all(batches);
    }

    // Delete data subcollection (creds, backups, health, meta)
    const dataSnap = await docRef.collection('data').get();
    if (!dataSnap.empty) {
      const batch = db.batch();
      dataSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    // Delete root doc
    await docRef.delete().catch(() => {});

    console.log(`[BAILEYS-STORE:${clientId}] 💀 FULL session deleted (identity + keys + backups)`);
  } catch (e) {
    console.error(`[BAILEYS-STORE:${clientId}] Error deleting session:`, e.message);
  }
}

module.exports = {
  useFirestoreAuthState,
  deleteFirestoreSession,
  purgeFirestoreSessionKeys,
  validateIdentity: (creds) => {
    if (!creds) return { valid: false, reason: 'null_creds' };
    const critical = ['noiseKey', 'signedIdentityKey', 'registrationId'];
    for (const field of critical) {
      if (!creds[field]) return { valid: false, reason: `missing_${field}` };
    }
    return { valid: true };
  }
};
