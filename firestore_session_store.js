/**
 * FIRESTORE SESSION STORE — WhatsApp session persistence for Railway
 *
 * Implements the Store interface required by whatsapp-web.js RemoteAuth.
 * Stores session zip files as base64 chunks in Firestore (max ~900KB per doc).
 * This allows WhatsApp sessions to survive Railway container restarts.
 *
 * Firestore collection: whatsapp_sessions/{sessionId}/chunks/{0,1,2,...}
 */

'use strict';

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const CHUNK_SIZE = 800 * 1024; // 800KB per chunk (Firestore limit is ~1MB per doc)

class FirestoreSessionStore {
  constructor() {
    this.db = admin.firestore();
    this.collection = 'whatsapp_sessions';
  }

  async sessionExists({ session }) {
    try {
      const sessionId = this._normalizeSessionId(session);
      const doc = await this.db.collection(this.collection).doc(sessionId).get();
      if (!doc.exists || !(doc.data()?.totalChunks > 0)) {
        console.log(`[SESSION-STORE] sessionExists(${sessionId}): false (no metadata)`);
        return false;
      }
      // Also verify chunks actually exist to avoid ENOENT crash on extract
      const firstChunk = await this.db.collection(this.collection).doc(sessionId).collection('chunks').limit(1).get();
      const exists = !firstChunk.empty;
      console.log(`[SESSION-STORE] sessionExists(${sessionId}): ${exists}`);
      return exists;
    } catch (err) {
      console.error(`[SESSION-STORE] Error checking session ${session}:`, err.message);
      return false;
    }
  }

  /**
   * Normalize the session parameter from RemoteAuth.
   * Older versions pass just the session name (e.g. "RemoteAuth-tenant-XXX").
   * Newer versions may pass the full path (e.g. "/app/.wwebjs_auth/RemoteAuth-tenant-XXX").
   * We always want the short name as the Firestore doc ID.
   */
  _normalizeSessionId(session) {
    // If it's a path, extract the basename (no extension)
    const base = path.basename(session, '.zip');
    return base;
  }

  async save({ session }) {
    try {
      const sessionId = this._normalizeSessionId(session);

      // The zip file: RemoteAuth creates it at .wwebjs_auth/RemoteAuth-{clientId}.zip
      // Try absolute path first (Railway runs in /app), then relative
      const candidates = [
        path.join('/app', '.wwebjs_auth', `${sessionId}.zip`),
        path.join(process.cwd(), '.wwebjs_auth', `${sessionId}.zip`),
        path.join('.wwebjs_auth', `${sessionId}.zip`),
      ];
      const zipPath = candidates.find(p => fs.existsSync(p));
      if (!zipPath) {
        console.warn(`[SESSION-STORE] Zip not found for session ${sessionId}. Tried: ${candidates.join(', ')}`);
        return;
      }

      const data = fs.readFileSync(zipPath);
      const base64 = data.toString('base64');
      const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);

      console.log(`[SESSION-STORE] Saving session ${sessionId}: ${(data.length / 1024 / 1024).toFixed(2)}MB, ${totalChunks} chunks`);

      // Delete old chunks first
      await this._deleteChunks(sessionId);

      // Save metadata
      await this.db.collection(this.collection).doc(sessionId).set({
        totalChunks,
        totalSize: data.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Save chunks in batches of 400 (Firestore batch limit)
      const batchSize = 400;
      for (let batchStart = 0; batchStart < totalChunks; batchStart += batchSize) {
        const batch = this.db.batch();
        const batchEnd = Math.min(batchStart + batchSize, totalChunks);

        for (let i = batchStart; i < batchEnd; i++) {
          const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const chunkRef = this.db
            .collection(this.collection)
            .doc(sessionId)
            .collection('chunks')
            .doc(String(i));
          batch.set(chunkRef, { data: chunk, index: i });
        }

        await batch.commit();
      }

      console.log(`[SESSION-STORE] Session ${sessionId} saved successfully`);
    } catch (err) {
      console.error(`[SESSION-STORE] Error saving session ${session}:`, err.message);
    }
  }

  async extract({ session, path: extractPath }) {
    try {
      const sessionId = this._normalizeSessionId(session);
      const metaDoc = await this.db.collection(this.collection).doc(sessionId).get();
      if (!metaDoc.exists) {
        console.log(`[SESSION-STORE] No stored session for ${sessionId}`);
        return;
      }

      const { totalChunks } = metaDoc.data();
      console.log(`[SESSION-STORE] Extracting session ${sessionId}: ${totalChunks} chunks`);

      // Read all chunks
      const chunksSnap = await this.db
        .collection(this.collection)
        .doc(sessionId)
        .collection('chunks')
        .orderBy('index')
        .get();

      if (chunksSnap.empty) {
        console.warn(`[SESSION-STORE] No chunks found for session ${sessionId} — deleting stale metadata`);
        // Delete stale metadata so sessionExists returns false next time (prevents ENOENT crash)
        await this.db.collection(this.collection).doc(sessionId).delete().catch(() => {});
        return;
      }

      let base64 = '';
      chunksSnap.forEach(doc => {
        base64 += doc.data().data;
      });

      const buffer = Buffer.from(base64, 'base64');
      // RemoteAuth passes the full destination path (including filename.zip), not a directory
      const zipPath = extractPath;

      // Ensure parent directory exists
      const dir = path.dirname(zipPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(zipPath, buffer);
      console.log(`[SESSION-STORE] Session ${sessionId} extracted to ${zipPath} (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`);
    } catch (err) {
      console.error(`[SESSION-STORE] Error extracting session ${session}:`, err.message);
    }
  }

  async delete({ session }) {
    try {
      const sessionId = this._normalizeSessionId(session);
      await this._deleteChunks(sessionId);
      await this.db.collection(this.collection).doc(sessionId).delete();
      console.log(`[SESSION-STORE] Session ${sessionId} deleted`);
    } catch (err) {
      console.error(`[SESSION-STORE] Error deleting session ${session}:`, err.message);
    }
  }

  async _deleteChunks(session) {
    const chunksSnap = await this.db
      .collection(this.collection)
      .doc(session)
      .collection('chunks')
      .get();

    if (chunksSnap.empty) return;

    const batchSize = 400;
    const docs = chunksSnap.docs;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = this.db.batch();
      docs.slice(i, i + batchSize).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  }
}

module.exports = FirestoreSessionStore;
