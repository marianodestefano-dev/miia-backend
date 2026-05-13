#!/usr/bin/env node
/**
 * C-445 §B — ForgetMe Executor (cron daily 3:30 AM).
 *
 * Origen: CARTA_C-445 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Procesa owners con flag forgetme_pending=true + confirmed=true.
 * Por cada uno llama executeForgetMe() del helper C-444.
 *
 * Cron schedule: daily 3:30 AM (post nightly distillation 3:07 AM).
 * Pensado para CronCreate Claude Code session-only o Task Scheduler
 * Windows XML cuando Mariano lo importe (post-C-441 sequence).
 *
 * Output: log [V2-ALERT][FORGETME-EXECUTED] count + errors.
 * Exit code: 0 OK / 1 error fatal.
 */

'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const admin = require('firebase-admin');
const forgetMe = require('../core/privacy/forget_me');

const BATCH_LIMIT = 20; // Defensivo: max 20 deletes por run

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
 * Lista owners con forgetme_pending=true Y forgetme_confirmed=true.
 * @returns {Promise<string[]>} array de uids candidatos.
 */
async function _findPendingExecutions() {
  const fs = await _firestoreInit();
  const snap = await fs
    .collection('users')
    .where('forgetme_pending', '==', true)
    .where('forgetme_confirmed', '==', true)
    .limit(BATCH_LIMIT)
    .get();
  return snap.docs.map((d) => d.id);
}

async function main() {
  const startTs = Date.now();
  console.log(`[FORGETME-EXECUTOR] start ts=${new Date(startTs).toISOString()}`);

  let candidates;
  try {
    candidates = await _findPendingExecutions();
  } catch (e) {
    console.error('[V2-ALERT][FORGETME-EXECUTOR-FATAL]', {
      error: e.message,
      stage: 'find_pending',
    });
    setTimeout(() => process.exit(1), 100);
    return;
  }

  console.log(`[FORGETME-EXECUTOR] candidates=${candidates.length}`);

  const executed = [];
  const errors = [];
  for (const uid of candidates) {
    try {
      const r = await forgetMe.executeForgetMe(uid);
      executed.push({ uid: uid.substring(0, 12) + '...', deleted: r.deleted });
    } catch (e) {
      errors.push({ uid: uid.substring(0, 12) + '...', error: e.message });
    }
  }

  const elapsedMs = Date.now() - startTs;
  console.log(`[FORGETME-EXECUTOR] done executed=${executed.length} errors=${errors.length} elapsed_ms=${elapsedMs}`);

  if (executed.length > 0) {
    console.log('[V2-ALERT][FORGETME-EXECUTED]', {
      count: executed.length,
      errors_count: errors.length,
    });
  }

  if (errors.length > 0) {
    console.error('[V2-ALERT][FORGETME-EXECUTOR-ERRORS]', { errors });
  }

  setTimeout(() => process.exit(0), 100);
}

if (require.main === module) {
  main();
}

module.exports = {
  _findPendingExecutions,
  BATCH_LIMIT,
};
