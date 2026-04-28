#!/usr/bin/env node
/**
 * C-459-CLEANUP-MARIANO-ESPOSA-CENTER — One-shot ejecutor.
 *
 * Origen: CARTA C-459 [FIRMADA_VIVO_MARIANO_2026-04-28].
 * Mariano necesita borrar TODO rastro de su Personal + esposa en
 * MIIA CENTER para que vuelvan a entrar como leads NUEVOS sin
 * historial probaditas.
 *
 * Uso:
 *   # Dry-run (inspeccion sin borrar - DEFAULT seguro):
 *   node scripts/run_cleanup_mariano_esposa.js
 *
 *   # Borrado real (requiere flag explicito):
 *   node scripts/run_cleanup_mariano_esposa.js --execute
 *
 * Env requeridas:
 *   - FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *
 * Output:
 *   - Backup defensivo a c:/tmp/cleanup_mariano_esposa_<ts>.json.
 *   - Reporte de claves borradas + count.
 *   - Exit code 0 OK / 1 error fatal.
 *
 * IMPORTANTE: Mariano debe confirmar phone esposa antes de ejecutar
 * borrado real. Hasta entonces, dry-run es la unica modalidad permitida.
 */

'use strict';

require('dotenv').config({ path: __dirname + '/../.env' });

const path = require('path');
const admin = require('firebase-admin');
const cleanup = require('../core/admin/cleanup_lead_data');

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

// Phones target firmados por Mariano (esposa pendiente confirmacion).
const PHONES_TARGET = [
  '573163937365', // Mariano Personal (firmado)
  // '<esposa>',  // ← AGREGAR cuando Mariano confirme via mail.
];

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

function _backupPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `c:/tmp/cleanup_mariano_esposa_${ts}.json`;
}

async function main() {
  const isExecute = process.argv.includes('--execute');
  const startTs = Date.now();
  console.log(`[CLEANUP] start ts=${new Date(startTs).toISOString()} mode=${isExecute ? 'EXECUTE' : 'DRY_RUN'}`);
  console.log(`[CLEANUP] tenant=${MIIA_CENTER_UID}`);
  console.log(`[CLEANUP] phones=${JSON.stringify(PHONES_TARGET)}`);

  if (PHONES_TARGET.length === 0) {
    console.error('[CLEANUP] ❌ PHONES_TARGET vacio — Mariano confirma phones primero');
    setTimeout(() => process.exit(1), 100);
    return;
  }

  await _firestoreInit();

  // 1. Inspeccion inicial (siempre)
  let snapshot;
  try {
    snapshot = await cleanup.inspectLeadData(MIIA_CENTER_UID, PHONES_TARGET);
  } catch (e) {
    console.error('[V2-ALERT][CLEANUP-INSPECT-FATAL]', { error: e.message });
    setTimeout(() => process.exit(1), 100);
    return;
  }

  const backupPath = _backupPath();
  cleanup.writeBackup(snapshot, backupPath);
  console.log(`[CLEANUP] ✅ Backup written -> ${backupPath}`);

  // Reporte snapshot
  for (const [jid, slot] of Object.entries(snapshot.tenantConversations)) {
    const counts = {
      conversations: Array.isArray(slot.conversations) ? slot.conversations.length : 0,
      hasContactType: !!slot.contactTypes,
      hasLeadName: !!slot.leadNames,
      hasMetadata: !!slot.conversationMetadata,
      hasActiveChat: !!slot.ownerActiveChats,
    };
    console.log(`[CLEANUP] phone=${jid} tenant_conversations=${JSON.stringify(counts)}`);
  }
  console.log(`[CLEANUP] miia_memory matches: ${snapshot.miiaMemory.length}`);
  for (const ep of snapshot.miiaMemory) {
    console.log(`[CLEANUP]   - episodeId=${ep.episodeId} status=${ep.status} contactPhone=${ep.contactPhone}`);
  }

  if (!isExecute) {
    console.log('[CLEANUP] DRY_RUN mode — NO se borro nada. Re-run con --execute para borrado real.');
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // 2. Borrado real (solo si --execute)
  let result;
  try {
    result = await cleanup.deleteLeadData(MIIA_CENTER_UID, PHONES_TARGET);
  } catch (e) {
    console.error('[V2-ALERT][CLEANUP-DELETE-FATAL]', { error: e.message });
    setTimeout(() => process.exit(1), 100);
    return;
  }

  console.log('[V2-ALERT][CLEANUP-EXECUTED]', {
    tenant: MIIA_CENTER_UID,
    phones: PHONES_TARGET,
    deletedKeys: result.deletedKeys,
    deletedEpisodes: result.deletedEpisodes,
  });

  // 3. Verificacion post-borrado (re-inspect)
  const postSnap = await cleanup.inspectLeadData(MIIA_CENTER_UID, PHONES_TARGET);
  const stillHas = Object.values(postSnap.tenantConversations).some((slot) =>
    slot.conversations || slot.contactTypes || slot.leadNames ||
    slot.conversationMetadata || slot.ownerActiveChats
  );
  if (stillHas || postSnap.miiaMemory.length > 0) {
    console.warn('[CLEANUP] ⚠️ Verificacion post-borrado encontro residuales:', JSON.stringify(postSnap, null, 2));
  } else {
    console.log('[CLEANUP] ✅ Verificacion post-borrado: vacio para los phones target');
  }

  const elapsedMs = Date.now() - startTs;
  console.log(`[CLEANUP] done elapsed_ms=${elapsedMs}`);
  setTimeout(() => process.exit(0), 100);
}

if (require.main === module) {
  main();
}

module.exports = {
  MIIA_CENTER_UID,
  PHONES_TARGET,
};
