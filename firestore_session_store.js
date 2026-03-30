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
      const doc = await this.db.collection(this.collection).doc(session).get();
      const exists = doc.exists && doc.data()?.totalChunks > 0;
      console.log(`[SESSION-STORE] sessionExists(${session}): ${exists}`);
      return exists;
    } catch (err) {
      console.error(`[SESSION-STORE] Error checking session ${session}:`, err.message);
      return false;
    }
  }

  async save({ session }) {
    try {
      // RemoteAuth creates the zip at .wwebjs_auth/RemoteAuth-{session}.zip
      const zipPath = path.join('.wwebjs_auth', `RemoteAuth-${session}.zip`);
      if (!fs.existsSync(zipPath)) {
        console.warn(`[SESSION-STORE] Zip not found: ${zipPath}`);
        return;
      }

      const data = fs.readFileSync(zipPath);
      const base64 = data.toString('base64');
      const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);

      console.log(`[SESSION-STORE] Saving session ${session}: ${(data.length / 1024 / 1024).toFixed(2)}MB, ${totalChunks} chunks`);

      // Delete old chunks first
      await this._deleteChunks(session);

      // Save metadata
      await this.db.collection(this.collection).doc(session).set({
        totalChunks,
        totalSize: data.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Save chunks in batches of 500 (Firestore batch limit)
      const batchSize = 400;
      for (let batchStart = 0; batchStart < totalChunks; batchStart += batchSize) {
        const batch = this.db.batch();
        const batchEnd = Math.min(batchStart + batchSize, totalChunks);

        for (let i = batchStart; i < batchEnd; i++) {
          const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const chunkRef = this.db
            .collection(this.collection)
            .doc(session)
            .collection('chunks')
            .doc(String(i));
          batch.set(chunkRef, { data: chunk, index: i });
        }

        await batch.commit();
      }

      console.log(`[SESSION-STORE] Session ${session} saved successfully`);
    } catch (err) {
      console.error(`[SESSION-STORE] Error saving session ${session}:`, err.message);
    }
  }

  async extract({ session, path: extractPath }) {
    try {
      const metaDoc = await this.db.collection(this.collection).doc(session).get();
      if (!metaDoc.exists) {
        console.log(`[SESSION-STORE] No stored session for ${session}`);
        return;
      }

      const { totalChunks } = metaDoc.data();
      console.log(`[SESSION-STORE] Extracting session ${session}: ${totalChunks} chunks`);

      // Read all chunks
      const chunksSnap = await this.db
        .collection(this.collection)
        .doc(session)
        .collection('chunks')
        .orderBy('index')
        .get();

      if (chunksSnap.empty) {
        console.warn(`[SESSION-STORE] No chunks found for session ${session}`);
        return;
      }

      let base64 = '';
      chunksSnap.forEach(doc => {
        base64 += doc.data().data;
      });

      const buffer = Buffer.from(base64, 'base64');
      const zipPath = path.join(extractPath, `RemoteAuth-${session}.zip`);

      // Ensure directory exists
      const dir = path.dirname(zipPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(zipPath, buffer);
      console.log(`[SESSION-STORE] Session ${session} extracted to ${zipPath} (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`);
    } catch (err) {
      console.error(`[SESSION-STORE] Error extracting session ${session}:`, err.message);
    }
  }

  async delete({ session }) {
    try {
      await this._deleteChunks(session);
      await this.db.collection(this.collection).doc(session).delete();
      console.log(`[SESSION-STORE] Session ${session} deleted`);
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
