'use strict';

/**
 * MiiaF1 — Notificaciones WhatsApp post-carrera
 * Se ejecuta via cron despues de cada GP (domingo noche)
 * Solo envia a owners con f1_prefs.notifications === true
 */

const admin = require('firebase-admin');
const { paths } = require('./f1_schema');

const CURRENT_SEASON = '2025';

/**
 * Genera el mensaje de notificacion post-carrera para un owner.
 * @param {string} driverName
 * @param {string} team
 * @param {number} position
 * @param {number} points
 * @param {string} gpName
 * @param {number} worldPosition
 * @param {number} worldPoints
 * @param {string} nextGpName
 * @param {string} nextGpDate
 * @returns {string}
 */
function buildPostRaceMessage(driverName, team, position, points, gpName, worldPosition, worldPoints, nextGpName, nextGpDate) {
  const posEmoji = position === 1 ? '🏆' : position <= 3 ? '🥈🥉'[position - 2] : '🏎️';
  const lines = [
    `${posEmoji} *F1 | ${gpName}*`,
    `${driverName} (${team}) terminó P${position} — +${points} puntos`,
    `Mundial: P${worldPosition} con ${worldPoints} puntos`,
  ];
  if (nextGpName) lines.push(`Próximo: ${nextGpName} · ${nextGpDate}`);
  return lines.join('\n');
}

/**
 * Envia notificaciones post-GP a todos los owners que las tienen activadas.
 * @param {string} gpId - ID del GP completado
 * @param {Function} sendWaMessage - fn(phone, message) para enviar WA
 * @returns {Promise<{sent: number, skipped: number, errors: number}>}
 */
async function sendPostRaceNotifications(gpId, sendWaMessage) {
  const db = admin.firestore();
  let sent = 0, skipped = 0, errors = 0;

  try {
    // Obtener datos del GP completado
    const gpDoc = await db.doc(paths.gp(CURRENT_SEASON, gpId)).get();
    if (!gpDoc.exists) {
      console.error(`[F1-NOTIF] GP ${gpId} no encontrado en Firestore`);
      return { sent, skipped, errors };
    }
    const gp = gpDoc.data();

    // Obtener resultados del GP
    const resultDoc = await db.doc(paths.result(CURRENT_SEASON, gpId)).get();
    if (!resultDoc.exists) {
      console.warn(`[F1-NOTIF] Resultado de ${gpId} no disponible aun`);
      return { sent, skipped, errors };
    }
    const result = resultDoc.data();

    // Obtener siguiente GP
    const scheduleSnap = await db.collection(`f1_data/${CURRENT_SEASON}/schedule`)
      .where('date', '>', gp.date).orderBy('date').limit(1).get();
    const nextGp = scheduleSnap.empty ? null : scheduleSnap.docs[0].data();

    // Obtener todos los owners con f1_prefs.notifications = true
    const prefsSnap = await db.collectionGroup('f1_prefs')
      .where('notifications', '==', true).get();

    console.log(`[F1-NOTIF] ${prefsSnap.size} owners con notificaciones activadas para GP ${gpId}`);

    for (const prefDoc of prefsSnap.docs) {
      const prefs = prefDoc.data();
      if (!prefs.adopted_driver || !prefs.uid) { skipped++; continue; }

      try {
        // Buscar resultado del piloto adoptado
        const driverResult = result.positions?.find(p => p.driver_id === prefs.adopted_driver);
        if (!driverResult) { skipped++; continue; }

        // Buscar datos del driver
        const driverDoc = await db.doc(paths.driver(CURRENT_SEASON, prefs.adopted_driver)).get();
        if (!driverDoc.exists) { skipped++; continue; }
        const driver = driverDoc.data();

        const msg = buildPostRaceMessage(
          driver.name, driver.team,
          driverResult.position, driverResult.points || 0,
          gp.name,
          0, 0, // worldPosition/Points: se calcularia con standings reales
          nextGp?.name || '', nextGp?.date || ''
        );

        // Obtener phone del owner
        const ownerDoc = await db.doc(`owners/${prefs.uid}`).get();
        const phone = ownerDoc.data()?.phone;
        if (!phone) { skipped++; continue; }

        await sendWaMessage(phone, msg);
        sent++;
        console.log(`[F1-NOTIF] Notif enviada a owner ${prefs.uid} por ${driver.name} P${driverResult.position}`);
      } catch (innerErr) {
        console.error(`[F1-NOTIF] Error procesando owner ${prefs.uid}: ${innerErr.message}`);
        errors++;
      }
    }
  } catch (err) {
    console.error(`[F1-NOTIF] Error general: ${err.message}`);
    errors++;
  }

  console.log(`[F1-NOTIF] Resultado: sent=${sent} skipped=${skipped} errors=${errors}`);
  return { sent, skipped, errors };
}

module.exports = { sendPostRaceNotifications, buildPostRaceMessage };
