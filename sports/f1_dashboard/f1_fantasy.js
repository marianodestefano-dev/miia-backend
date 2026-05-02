'use strict';

/**
 * MiiaF1 -- Fantasy League (F1.27-F1.28)
 * Sistema de puntaje fantasy para owners que adoptaron un piloto.
 *
 * Puntos por posicion (estandar F1): 1->25, 2->18, 3->15, 4->12, 5->10,
 * 6->8, 7->6, 8->4, 9->2, 10->1, vuelta rapida->1 (si top10), DNF->0
 * Bonus fantasy: vuelta rapida +2, P1 desde P5+ al inicio +5, pole->3
 */

const admin = require('firebase-admin');
const { paths } = require('./f1_schema');

const CURRENT_SEASON = '2025';

const F1_POINTS = { 1:25, 2:18, 3:15, 4:12, 5:10, 6:8, 7:6, 8:4, 9:2, 10:1 };
const BONUS_FASTEST_LAP = 2;
const BONUS_POLE = 3;

/**
 * Calcula puntos fantasy para un piloto en un GP.
 * @param {object} result - { position, fastest_lap, dnf, started_pos }
 * @param {string} driverName
 * @returns {{ points: number, breakdown: object }}
 */
function calculateFantasyPoints(result, driverName) {
  let points = 0;
  const breakdown = {};

  if (result.dnf) {
    breakdown.race = 0;
  } else {
    const racePoints = F1_POINTS[result.position] || 0;
    points += racePoints;
    breakdown.race = racePoints;
  }

  if (result.fastest_lap && result.fastest_lap === driverName) {
    points += BONUS_FASTEST_LAP;
    breakdown.fastest_lap = BONUS_FASTEST_LAP;
  }

  if (result.pole_position && result.pole_position === driverName) {
    points += BONUS_POLE;
    breakdown.pole = BONUS_POLE;
  }

  // Bonus overtake: si arranco de P5+ y termino top3
  if (result.started_pos && result.started_pos > 4 && result.position <= 3) {
    breakdown.overtake_bonus = 5;
    points += 5;
  }

  breakdown.total = points;
  return { points, breakdown };
}

/**
 * Actualiza el fantasy score de un owner despues de un GP.
 * @param {string} ownerUid
 * @param {string} adoptedDriverId
 * @param {string} gpId
 * @param {object} gpResult - resultado del GP
 * @returns {Promise<{points: number, total: number}>}
 */
async function updateOwnerFantasyScore(ownerUid, adoptedDriverId, gpId, gpResult) {
  const db = admin.firestore();

  const driverDoc = await db.doc(paths.driver(CURRENT_SEASON, adoptedDriverId)).get();
  if (!driverDoc.exists) return { points: 0, total: 0 };
  const driver = driverDoc.data();

  const driverResult = (gpResult.positions || []).find(function(p) {
    return p.driver_id === adoptedDriverId || p.driverId === adoptedDriverId;
  });

  if (!driverResult) return { points: 0, total: 0 };

  const { points, breakdown } = calculateFantasyPoints({
    position: driverResult.position,
    fastest_lap: gpResult.fastest_lap,
    dnf: driverResult.dnf,
    started_pos: driverResult.started_pos,
    pole_position: gpResult.pole_position,
  }, driver.name);

  // Guardar entrada de fantasy
  const fantasyRef = db.doc('owners/' + ownerUid + '/f1_fantasy/' + gpId);
  await fantasyRef.set({
    gpId,
    driverId: adoptedDriverId,
    driverName: driver.name,
    points,
    breakdown,
    season: CURRENT_SEASON,
    created_at: new Date().toISOString(),
  });

  // Actualizar total acumulado
  const prefRef = db.doc('owners/' + ownerUid + '/f1_prefs/current');
  await prefRef.set({ fantasy_total: admin.firestore.FieldValue.increment(points) }, { merge: true });

  // Obtener total actualizado
  const updatedPrefs = await prefRef.get();
  const total = (updatedPrefs.data() && updatedPrefs.data().fantasy_total) || points;
  console.log('[F1-FANTASY] uid=' + ownerUid + ' driver=' + adoptedDriverId + ' gp=' + gpId + ' pts=' + points + ' total=' + total);
  return { points, total };
}

/**
 * Obtiene el ranking de fantasy entre todos los owners.
 * @param {string} season
 * @returns {Promise<Array<{uid, driverName, total}>>}
 */
async function getFantasyLeaderboard(season) {
  season = season || CURRENT_SEASON;
  const db = admin.firestore();

  const prefsSnap = await db.collectionGroup('f1_prefs').get();
  const entries = [];
  for (const doc of prefsSnap.docs) {
    const prefs = doc.data();
    if (!prefs.uid || !prefs.adopted_driver || !prefs.fantasy_total) continue;
    entries.push({
      uid: prefs.uid,
      driverId: prefs.adopted_driver,
      driverName: prefs.adopted_driver,
      total: /* istanbul ignore next */ prefs.fantasy_total || 0,
    });
  }
  entries.sort(function(a, b) { return b.total - a.total; });
  return entries.map(function(e, i) { return { ...e, rank: i + 1 }; });
}

module.exports = { calculateFantasyPoints, updateOwnerFantasyScore, getFantasyLeaderboard, F1_POINTS };
