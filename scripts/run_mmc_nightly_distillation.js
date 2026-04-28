#!/usr/bin/env node
/**
 * MMC Nightly Distillation Runner — C-441 Piso 1.
 *
 * Origen: CARTA_C-441 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Ejecuta runNightlyDistillation para UID MIIA CENTER. Pensado para
 * cron 3 AM Argentina (CronCreate Claude Code session-only o Task
 * Scheduler Windows XML — opcion futura post-C-440 sequence Wi).
 *
 * Etapa 1 §2-bis estricta: SOLO MIIA CENTER (UID
 * A5pMESWlfmPWCoCPRbwy85EzUzy2). Etapa 2 (firma Mariano fresh) cambia
 * el guard.
 *
 * Uso:
 *   node scripts/run_mmc_nightly_distillation.js
 *
 * Env requeridas:
 *   - GEMINI_API_KEY (para destilar via Gemini)
 *   - FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *
 * Output: log [V2-ALERT][MMC-DISTILL] con processed + errors.
 * Exit code: 0 OK, 1 error fatal.
 */

'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const admin = require('firebase-admin');
const distiller = require('../core/mmc/episode_distiller');
const aiGateway = require('../ai/ai_gateway');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

async function _firestoreInit() {
  if (admin.apps.length > 0) return admin.firestore();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FIREBASE_* env vars missing — abort');
  }
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  return admin.firestore();
}

/**
 * Adaptador Gemini real → API minimal {generateContent} esperada
 * por episode_distiller.
 *
 * Reusa aiGateway interno con context GENERAL.
 */
function _makeGeminiClientForDistillation() {
  return {
    async generateContent({ prompt, signal }) {
      // signal pasa al AbortController interno via fetch en gemini_client.
      // aiGateway.smartCall ya maneja AbortController §6.18 propio.
      const result = await aiGateway.smartCall(
        aiGateway.CONTEXTS.GENERAL,
        prompt,
        {},
        { enableSearch: false, signal }
      );
      return { text: result?.text || '' };
    },
  };
}

/**
 * Lee episodios closed pendientes de destilación (summary=null) para
 * el owner. Filtra in-memory porque Firestore where('summary','==',null)
 * no es consistente cross-version.
 *
 * @param {string} ownerUid
 * @param {number} maxFetch — max docs traer antes de filtrar.
 * @returns {Promise<object[]>}
 */
async function _fetchClosedPending(ownerUid, maxFetch) {
  const fs = await _firestoreInit();
  const snap = await fs
    .collection('users')
    .doc(ownerUid)
    .collection('miia_memory')
    .where('status', '==', 'closed')
    .orderBy('startedAt', 'desc')
    .limit(maxFetch)
    .get();
  return snap.docs.map((d) => d.data()).filter((e) => !e.summary);
}

async function main() {
  const startTs = Date.now();
  console.log(`[MMC-NIGHTLY] start uid=${MIIA_CENTER_UID.substring(0, 12)}... ts=${new Date(startTs).toISOString()}`);

  try {
    const gemini = _makeGeminiClientForDistillation();
    const result = await distiller.runNightlyDistillation(MIIA_CENTER_UID, gemini, {
      limit: 50,
      getEpisodesFn: (uid) => _fetchClosedPending(uid, 100),
    });

    const elapsedMs = Date.now() - startTs;
    console.log(`[MMC-NIGHTLY] done processed=${result.processed} errors=${result.errors.length} elapsed_ms=${elapsedMs}`);

    if (result.errors.length > 0) {
      console.error('[V2-ALERT][MMC-NIGHTLY-ERRORS]', {
        ownerUid: MIIA_CENTER_UID.substring(0, 12) + '...',
        errors_count: result.errors.length,
        first_3_errors: result.errors.slice(0, 3),
      });
    }

    // Exit clean tras flush logs
    setTimeout(() => process.exit(0), 100);
  } catch (e) {
    console.error('[V2-ALERT][MMC-NIGHTLY-FATAL]', {
      ownerUid: MIIA_CENTER_UID.substring(0, 12) + '...',
      error: e.message,
      stack: (e.stack || '').split('\n').slice(0, 5).join('\n'),
    });
    setTimeout(() => process.exit(1), 100);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  _fetchClosedPending,
  _makeGeminiClientForDistillation,
  MIIA_CENTER_UID,
};
