'use strict';

/**
 * MiiaF1 -- Gemini predictions (F1.25)
 * Genera predicciones del proximo GP usando Gemini.
 */

const admin = require('firebase-admin');
const { paths } = require('./f1_schema');

const CURRENT_SEASON = '2025';

/**
 * Construye el prompt para prediccion del proximo GP.
 * @param {object} nextGP - datos del proximo GP
 * @param {object[]} driverStandings - standings actuales
 * @param {object[]} recentResults - ultimos 3 resultados
 * @returns {string}
 */
function buildPredictionPrompt(nextGP, driverStandings, recentResults) {
  const top5 = (driverStandings || []).slice(0, 5);
  const recentSummary = (recentResults || []).slice(0, 3).map(function(r) {
    const winner = r.result && r.result.positions && r.result.positions[0];
    return r.gp.name + ': 1o ' + (winner ? winner.driver_name || '-' : '-');
  }).join(', ');

  return [
    'Eres un experto analista de Formula 1. Contexto actual:',
    '',
    'PROXIMO GP: ' + (nextGP ? nextGP.name + ' en ' + nextGP.circuit + ' (Ronda ' + nextGP.round + ')' : 'Desconocido'),
    '',
    'CLASIFICACION MUNDIAL (Top 5):',
    top5.map(function(d) { return 'P' + d.position + ': ' + d.driver_name + ' (' + d.points + ' pts)'; }).join('\n'),
    '',
    'ULTIMOS RESULTADOS: ' + (recentSummary || 'Sin datos'),
    '',
    'Basandote en estos datos, dame:',
    '1. Tu prediccion del podio para el proximo GP (3 pilotos)',
    '2. Una razon tecnica breve para tu prediccion',
    '3. Un piloto a sorprender (dark horse)',
    '',
    'Responde en espanol, maximo 200 palabras, tono apasionado como commentarista F1.',
  ].join('\n');
}

/**
 * Genera prediccion del proximo GP llamando a la IA.
 * @param {Function} callAI - fn(prompt) => Promise<string>
 * @returns {Promise<{prediction: string, nextGP: object}|null>}
 */
async function generateNextGPPrediction(callAI) {
  const db = admin.firestore();

  try {
    const nextGPSnap = await db.collection('f1_data/' + CURRENT_SEASON + '/schedule')
      .where('status', '==', 'scheduled')
      .orderBy('round')
      .limit(1).get();

    if (nextGPSnap.empty) return null;
    const nextGP = nextGPSnap.docs[0].data();

    const standingsSnap = await db.collection('f1_data/' + CURRENT_SEASON + '/driver_standings')
      .orderBy('position').limit(5).get();
    const standings = standingsSnap.docs.map(function(d) { return d.data(); });

    const recentSnap = await db.collection('f1_data/' + CURRENT_SEASON + '/schedule')
      .where('status', '==', 'completed')
      .orderBy('round', 'desc')
      .limit(3).get();

    const recentResults = [];
    for (const gpDoc of recentSnap.docs) {
      const resultDoc = await db.doc(paths.result(CURRENT_SEASON, gpDoc.id)).get();
      recentResults.push({ gp: gpDoc.data(), result: resultDoc.exists ? resultDoc.data() : null });
    }

    const prompt = buildPredictionPrompt(nextGP, standings, recentResults);
    const prediction = await callAI(prompt);
    return { prediction, nextGP };
  } catch (err) {
    console.error('[F1-GEMINI] Error generando prediccion: ' + err.message);
    return null;
  }
}

module.exports = { buildPredictionPrompt, generateNextGPPrediction };
