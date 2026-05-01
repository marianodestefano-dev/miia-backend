'use strict';

/**
 * MiiaF1 -- Notificaciones EN VIVO durante la carrera (F1.13)
 * Rate limit: max 1 msg cada 5 vueltas por owner.
 */

const admin = require('firebase-admin');
const { getLiveCache } = require('./live_cache');
const { paths } = require('./f1_schema');

const CURRENT_SEASON = '2025';
const LAP_RATE_LIMIT = 5;

const _lastNotifiedLap = new Map();

function buildLiveMessage(driverName, team, newPos, oldPos, gpName, lap, totalLaps) {
  const gained = oldPos > newPos;
  const lost   = oldPos < newPos;
  const arrow  = gained ? 'subio' : (lost ? 'cayo' : 'mantiene');
  const posEmoji = newPos === 1 ? '🏆' : '🏎️';
  const lapStr = totalLaps ? `(V${lap}/${totalLaps})` : `(V${lap})`;
  let line1;
  if (newPos === 1)   line1 = `¡${driverName} LIDERA la carrera!`;
  else if (gained)    line1 = `${driverName} subio a P${newPos}`;
  else if (lost)      line1 = `${driverName} cayo a P${newPos}`;
  else                line1 = `${driverName} mantiene P${newPos}`;
  return `🔴 *F1 EN VIVO | ${gpName}* ${lapStr}\n${posEmoji} ${line1}\nEquipo: ${team}`;
}

async function checkDriverPositionChange(ownerUid, adoptedDriverId, currentPositions, previousPositions, currentLap, totalLaps, gpName) {
  if (!adoptedDriverId || !currentPositions || !currentPositions.length) return null;
  const db = admin.firestore();
  const driverDoc = await db.doc(paths.driver(CURRENT_SEASON, adoptedDriverId)).get();
  if (!driverDoc.exists) return null;
  const driver = driverDoc.data();
  const driverNum = driver.number;
  const current = currentPositions.find(p =>
    String(p.driver_number) === String(driverNum) || String(p.number) === String(driverNum)
  );
  if (!current) return null;
  const newPos = current.position;
  const oldPos = previousPositions[driverNum] || newPos;
  if (newPos === oldPos) return null;
  const lastLap = _lastNotifiedLap.get(ownerUid) || 0;
  if (currentLap - lastLap < LAP_RATE_LIMIT) return null;
  _lastNotifiedLap.set(ownerUid, currentLap);
  return buildLiveMessage(driver.name, driver.team, newPos, oldPos, gpName, currentLap, totalLaps);
}

async function processLivePositionUpdates(currentPositions, previousPositions, currentLap, totalLaps, gpName, sendWaMessage) {
  if (!currentPositions || !currentPositions.length || !currentLap) return;
  const db = admin.firestore();
  try {
    const prefsSnap = await db.collectionGroup('f1_prefs').where('notifications', '==', true).get();
    for (const prefDoc of prefsSnap.docs) {
      const prefs = prefDoc.data();
      if (!prefs.adopted_driver || !prefs.uid) continue;
      const msg = await checkDriverPositionChange(prefs.uid, prefs.adopted_driver, currentPositions, previousPositions, currentLap, totalLaps, gpName);
      if (!msg) continue;
      const ownerDoc = await db.doc('owners/' + prefs.uid).get();
      const phone = ownerDoc.data() && ownerDoc.data().phone;
      if (!phone) continue;
      await sendWaMessage(phone, msg);
      console.log('[F1-LIVE-NOTIF] Notif enviada uid=' + prefs.uid);
    }
    for (const p of currentPositions) {
      if (p.driver_number !== undefined) previousPositions[p.driver_number] = p.position;
      if (p.number !== undefined) previousPositions[p.number] = p.position;
    }
  } catch (err) {
    console.error('[F1-LIVE-NOTIF] Error: ' + err.message);
  }
}

module.exports = { buildLiveMessage, checkDriverPositionChange, processLivePositionUpdates, _lastNotifiedLap };
