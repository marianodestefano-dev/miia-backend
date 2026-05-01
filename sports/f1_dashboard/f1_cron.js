'use strict';

/**
 * MiiaF1 -- Post-GP cron job (F1.24)
 * Se ejecuta via cron cada domingo noche para:
 * 1. Scraper los resultados del GP
 * 2. Actualizar Firestore con resultados y standings
 * 3. Enviar notificaciones WA a owners con pilotos adoptados
 */

const admin = require('firebase-admin');
const { getGPResults, getDriverStandings, getConstructorStandings } = require('./results_scraper');
const { sendPostRaceNotifications } = require('./f1_notifications');
const { paths, validateResult } = require('./f1_schema');

const CURRENT_SEASON = '2025';

/**
 * Ejecuta el cron post-GP.
 * @param {string} gpId - ID del GP que acaba de terminar
 * @param {Function} sendWaMessage - fn(phone, msg)
 * @returns {Promise<{ok: boolean, gpId: string, errors: string[]}>}
 */
async function runPostGPCron(gpId, sendWaMessage) {
  const errors = [];
  const db = admin.firestore();
  console.log('[F1-CRON] Iniciando post-GP para ' + gpId);

  try {
    // 1. Marcar GP como completado
    await db.doc('f1_data/' + CURRENT_SEASON + '/schedule/' + gpId).set(
      { status: 'completed', completed_at: new Date().toISOString() },
      { merge: true }
    );
    console.log('[F1-CRON] GP ' + gpId + ' marcado como completed');

    // 2. Scraper resultados del GP
    let gpResults = null;
    try {
      gpResults = await getGPResults(gpId, CURRENT_SEASON);
      if (gpResults && gpResults.positions && gpResults.positions.length) {
        const validated = validateResult(gpId, gpResults);
        await db.doc(paths.result(CURRENT_SEASON, gpId)).set(validated);
        console.log('[F1-CRON] Resultados del GP guardados: ' + gpResults.positions.length + ' pilotos');
      }
    } catch (e) {
      errors.push('Resultados: ' + e.message);
      console.error('[F1-CRON] Error scrapeando resultados: ' + e.message);
    }

    // 3. Actualizar standings de pilotos
    try {
      const driverStandings = await getDriverStandings(CURRENT_SEASON);
      if (driverStandings && driverStandings.length) {
        const batch = db.batch();
        driverStandings.forEach(function(d, i) {
          const ref = db.doc('f1_data/' + CURRENT_SEASON + '/driver_standings/' + (d.driver_id || 'driver_' + i));
          batch.set(ref, { ...d, updated_at: new Date().toISOString() });
        });
        await batch.commit();
        console.log('[F1-CRON] Standings pilotos actualizados: ' + driverStandings.length);
      }
    } catch (e) {
      errors.push('Standings pilotos: ' + e.message);
    }

    // 4. Actualizar standings constructores
    try {
      const constrStandings = await getConstructorStandings(CURRENT_SEASON);
      if (constrStandings && constrStandings.length) {
        const batch = db.batch();
        constrStandings.forEach(function(d, i) {
          const ref = db.doc('f1_data/' + CURRENT_SEASON + '/constructor_standings/constr_' + i);
          batch.set(ref, { ...d, updated_at: new Date().toISOString() });
        });
        await batch.commit();
        console.log('[F1-CRON] Standings constructores actualizados: ' + constrStandings.length);
      }
    } catch (e) {
      errors.push('Standings constructores: ' + e.message);
    }

    // 5. Enviar notificaciones WA
    try {
      const notifResult = await sendPostRaceNotifications(gpId, sendWaMessage);
      console.log('[F1-CRON] Notificaciones: sent=' + notifResult.sent + ' errors=' + notifResult.errors);
    } catch (e) {
      errors.push('Notificaciones: ' + e.message);
    }

    console.log('[F1-CRON] Post-GP ' + gpId + ' completado. Errores: ' + errors.length);
    return { ok: errors.length === 0, gpId, errors };

  } catch (err) {
    console.error('[F1-CRON] Error fatal: ' + err.message);
    return { ok: false, gpId, errors: [err.message] };
  }
}

module.exports = { runPostGPCron };
