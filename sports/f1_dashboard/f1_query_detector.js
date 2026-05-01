'use strict';

/**
 * MiiaF1 -- F1 Query Detector (F1.14)
 * Enriquece el prompt con datos F1 reales cuando el mensaje habla de Formula 1.
 */

const { getLiveCache } = require('./live_cache');
const admin = require('firebase-admin');

const CURRENT_SEASON = '2025';

const F1_PATTERNS = [
  /\bf1\b/i,
  /\bformula\s*1\b/i,
  /\bformula\s*uno\b/i,
  /\bgp\b/i,
  /\bgp\s+de\b/i,
  /\bgran\s+premio\b/i,
  /\bverstappen\b/i,
  /\bhamilton\b/i,
  /\bnorris\b/i,
  /\bleclerc\b/i,
  /\bpiastri\b/i,
  /\brussell\b/i,
  /\bsainz\b/i,
  /\balonso\b/i,
  /\b(vuelta|lap|drs|safety.*car|bandera.*roja)\b/i,
  /\b(red bull|mclaren|ferrari|mercedes|alpine|haas|aston.*martin|williams)\b/i,
];

const DRIVER_NAMES = {
  'verstappen': 'verstappen', 'hamilton': 'hamilton', 'norris': 'norris',
  'leclerc': 'leclerc', 'piastri': 'piastri', 'russell': 'russell',
  'sainz': 'sainz', 'alonso': 'alonso', 'perez': 'perez', 'stroll': 'stroll',
};

function isF1Query(msg) {
  if (!msg) return false;
  return F1_PATTERNS.some(rx => rx.test(msg));
}

function detectMentionedDriver(msg) {
  const lower = msg.toLowerCase();
  for (const [keyword, id] of Object.entries(DRIVER_NAMES)) {
    if (lower.includes(keyword)) return id;
  }
  return null;
}

function formatPositions(positions) {
  if (!positions || !positions.length) return 'Sin datos de posicion disponibles.';
  return positions.slice(0, 10).map(function(p) {
    return 'P' + p.position + ': ' + (p.driverName || '#' + p.number) + ' (' + (p.team || '-') + ') ' + (p.gap ? '+' + p.gap : 'LIDER');
  }).join('\n');
}

async function enrichF1Prompt(messageBody) {
  if (!isF1Query(messageBody)) return null;
  const lines = ['📊 [DATOS F1 EN TIEMPO REAL]:'];
  const cache = getLiveCache();
  const raceStatus = await cache.getRaceStatus();
  if (raceStatus && raceStatus.isLive) {
    lines.push('🔴 CARRERA EN CURSO: ' + (raceStatus.raceName || 'GP activo') + ' — Vuelta ' + (raceStatus.currentLap || '?') + '/' + (raceStatus.totalLaps || '?'));
    const allPos = await cache.getAllPositions();
    if (allPos && allPos.length) {
      lines.push('Posiciones actuales:');
      lines.push(formatPositions(allPos));
    }
  } else {
    lines.push('No hay carrera en vivo en este momento.');
    try {
      const db = admin.firestore();
      const standingsSnap = await db.collection('f1_data/' + CURRENT_SEASON + '/driver_standings').orderBy('position').limit(5).get();
      if (!standingsSnap.empty) {
        lines.push('Mundial Pilotos ' + CURRENT_SEASON + ' (Top 5):');
        standingsSnap.docs.forEach(function(doc) {
          const d = doc.data();
          lines.push('P' + d.position + ': ' + d.driver_name + ' — ' + d.points + ' pts');
        });
      }
    } catch (e) { /* Firestore no disponible */ }
  }
  const driverMention = detectMentionedDriver(messageBody);
  if (driverMention) {
    try {
      const db = admin.firestore();
      const snap = await db.collection('f1_data/' + CURRENT_SEASON + '/driver_standings').where('driver_id', '==', driverMention).limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0].data();
        lines.push('\nDatos de ' + d.driver_name + ': P' + d.position + ' mundial, ' + d.points + ' puntos, equipo ' + d.team);
      }
    } catch (e) { /* omitir */ }
  }
  lines.push('\nUSA ESTOS DATOS para responder sobre F1 con informacion precisa y actualizada.');
  return '\n\n' + lines.join('\n');
}

module.exports = { isF1Query, detectMentionedDriver, enrichF1Prompt };
