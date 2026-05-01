'use strict';

/**
 * MiiaF1 -- Historical GP view (F1.22)
 * Obtiene y formatea resultados historicos de GPs completados.
 */

const admin = require('firebase-admin');
const { paths } = require('./f1_schema');

const CURRENT_SEASON = '2025';

/**
 * Obtiene los ultimos N GPs completados con sus resultados.
 * @param {string} season
 * @param {number} limit
 * @returns {Promise<Array<{gp, result}>>}
 */
async function getRecentCompletedGPs(season, limit) {
  season = season || CURRENT_SEASON;
  limit = limit || 5;
  const db = admin.firestore();

  const scheduleSnap = await db.collection('f1_data/' + season + '/schedule')
    .where('status', '==', 'completed')
    .orderBy('round', 'desc')
    .limit(limit)
    .get();

  const results = [];
  for (const gpDoc of scheduleSnap.docs) {
    const gp = gpDoc.data();
    const resultDoc = await db.doc(paths.result(season, gpDoc.id)).get();
    results.push({
      gp: { id: gpDoc.id, ...gp },
      result: resultDoc.exists ? resultDoc.data() : null,
    });
  }
  return results;
}

/**
 * Formatea el podio de un GP para mostrar en dashboard.
 * @param {object} result
 * @returns {string}
 */
function formatPodium(result) {
  if (!result || !result.positions || !result.positions.length) return 'Sin datos';
  const top3 = result.positions.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  return top3.map((p, i) => medals[i] + ' ' + (p.driver_name || p.driverId || '-') + ' (' + (p.team || '-') + ')').join(' · ');
}

/**
 * Obtiene el historial de resultados de un piloto especifico en la temporada.
 * @param {string} driverId
 * @param {string} season
 * @returns {Promise<Array<{gpName, position, points}>>}
 */
async function getDriverSeasonHistory(driverId, season) {
  season = season || CURRENT_SEASON;
  const db = admin.firestore();

  const scheduleSnap = await db.collection('f1_data/' + season + '/schedule')
    .where('status', '==', 'completed')
    .orderBy('round')
    .get();

  const history = [];
  for (const gpDoc of scheduleSnap.docs) {
    const resultDoc = await db.doc(paths.result(season, gpDoc.id)).get();
    if (!resultDoc.exists) continue;
    const result = resultDoc.data();
    const driverResult = (result.positions || []).find(p => p.driver_id === driverId || p.driverId === driverId);
    if (driverResult) {
      history.push({
        round: gpDoc.data().round,
        gpName: gpDoc.data().name,
        position: driverResult.position,
        points: driverResult.points || 0,
      });
    }
  }
  return history;
}

module.exports = { getRecentCompletedGPs, formatPodium, getDriverSeasonHistory };
