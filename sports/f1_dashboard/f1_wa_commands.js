'use strict';

/**
 * MiiaF1 -- WhatsApp command parser (F1.23)
 * Procesa comandos F1 en mensajes de WA del owner en self-chat.
 * Comandos:
 *   /f1 posiciones     -> tabla de posiciones live
 *   /f1 piloto NOMBRE  -> info + resultado de un piloto
 *   /f1 resultado      -> resultado del ultimo GP
 *   /f1 siguiente      -> proximo GP
 *   /f1 mipiloto       -> info del piloto adoptado
 *   /f1 adoptar NOMBRE -> adoptar piloto
 *   /f1 circuito ID    -> descripcion del circuito
 */

const admin = require('firebase-admin');
const { getLiveCache } = require('./live_cache');
const { getCircuit, getCircuitIds } = require('./circuit_maps');
const { paths } = require('./f1_schema');

const CURRENT_SEASON = '2025';

// Regex para detectar comandos F1
const F1_CMD_RE = /^\/f1(?:\s+(.+))?$/i;

/**
 * Detecta si el mensaje es un comando F1.
 * @param {string} msg
 * @returns {boolean}
 */
function isF1Command(msg) {
  return F1_CMD_RE.test((msg || '').trim());
}

/**
 * Procesa un comando F1 y retorna la respuesta.
 * @param {string} msg - mensaje completo del owner
 * @param {string} ownerUid
 * @returns {Promise<string|null>} respuesta o null si no es comando F1
 */
async function processF1Command(msg, ownerUid) {
  const match = F1_CMD_RE.exec((msg || '').trim());
  if (!match) return null;

  const args = (match[1] || '').trim().toLowerCase().split(/\s+/);
  const cmd = args[0] || 'help';

  try {
    switch (cmd) {
      case 'posiciones':
      case 'pos':
        return await _cmdPositions();

      case 'piloto':
        return await _cmdDriver(args.slice(1).join(' '));

      case 'resultado':
      case 'res':
        return await _cmdLastResult(ownerUid);

      case 'siguiente':
      case 'next':
        return await _cmdNextGP();

      case 'mipiloto':
      case 'mipilot':
        return await _cmdMyDriver(ownerUid);

      case 'adoptar':
        return await _cmdAdopt(args.slice(1).join(' '), ownerUid);

      case 'circuito':
        return _cmdCircuit(args.slice(1).join(' '));

      case 'help':
      default:
        return _cmdHelp();
    }
  } catch (err) {
    console.error('[F1-CMD] Error procesando comando ' + cmd + ': ' + err.message);
    return '❌ Error al procesar comando F1: ' + err.message;
  }
}

async function _cmdPositions() {
  const cache = getLiveCache();
  const [positions, raceStatus] = await Promise.all([cache.getAllPositions(), cache.getRaceStatus()]);

  if (!raceStatus || !raceStatus.isLive || !positions || !positions.length) {
    return '🏎️ No hay carrera en vivo ahora mismo.\n\nUsa */f1 resultado* para ver el ultimo GP.';
  }

  const lines = ['🔴 *EN VIVO — ' + (raceStatus.raceName || 'GP') + '* (V' + raceStatus.currentLap + ')'];
  positions.slice(0, 10).forEach(function(p) {
    lines.push('P' + p.position + ': ' + (p.driverName || '#' + p.number) + ' ' + (p.gap ? '+' + p.gap : 'LIDER'));
  });
  return lines.join('\n');
}

async function _cmdDriver(nameQuery) {
  if (!nameQuery) return '❓ Uso: */f1 piloto NOMBRE* (ej: /f1 piloto Norris)';
  const db = admin.firestore();
  const snap = await db.collection('f1_data/' + CURRENT_SEASON + '/drivers')
    .where('name_lower', '>=', nameQuery)
    .where('name_lower', '<=', nameQuery + 'z')
    .limit(1).get();

  if (snap.empty) return '❓ Piloto "' + nameQuery + '" no encontrado. Usa el apellido (ej: Norris, Verstappen).';
  const d = snap.docs[0].data();
  return '🏎️ *' + d.name + '*\nEquipo: ' + d.team + '\nNumero: #' + d.number + '\n' + (d.country || '');
}

async function _cmdLastResult(ownerUid) {
  const db = admin.firestore();
  const snap = await db.collection('f1_data/' + CURRENT_SEASON + '/schedule')
    .where('status', '==', 'completed')
    .orderBy('round', 'desc')
    .limit(1).get();

  if (snap.empty) return '📊 No hay resultados disponibles para ' + CURRENT_SEASON + '.';
  const gp = snap.docs[0].data();
  const gpId = snap.docs[0].id;

  const resultDoc = await db.doc(paths.result(CURRENT_SEASON, gpId)).get();
  if (!resultDoc.exists) return '📊 Resultado de ' + gp.name + ' aun no disponible.';

  const result = resultDoc.data();
  const top3 = (result.positions || []).slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['📊 *' + gp.name + '* — Resultados'];
  top3.forEach(function(p, i) { lines.push(medals[i] + ' ' + (p.driver_name || '-') + ' (' + (p.team || '-') + ')'); });
  if (result.fastest_lap) lines.push('⚡ Vuelta rapida: ' + result.fastest_lap);
  return lines.join('\n');
}

async function _cmdNextGP() {
  const db = admin.firestore();
  const now = new Date().toISOString().split('T')[0];
  const snap = await db.collection('f1_data/' + CURRENT_SEASON + '/schedule')
    .where('status', '==', 'scheduled')
    .orderBy('round')
    .limit(1).get();

  if (snap.empty) return '📅 No hay mas GPs programados en ' + CURRENT_SEASON + '.';
  const gp = snap.docs[0].data();
  return '📅 *Proximo GP*\n' + gp.name + '\n' + gp.circuit + '\nFecha: ' + gp.date + '\nRonda ' + gp.round + ' de 24';
}

async function _cmdMyDriver(ownerUid) {
  if (!ownerUid) return '❓ No se pudo identificar tu perfil.';
  const db = admin.firestore();
  const prefDoc = await db.doc('owners/' + ownerUid + '/f1_prefs/current').get();
  if (!prefDoc.exists || !prefDoc.data().adopted_driver) {
    return '🏎️ No tienes un piloto adoptado.\nUsa */f1 adoptar NOMBRE* para elegir uno.';
  }
  const prefs = prefDoc.data();
  const driverDoc = await db.doc(paths.driver(CURRENT_SEASON, prefs.adopted_driver)).get();
  if (!driverDoc.exists) return '🏎️ Tu piloto adoptado: ' + prefs.adopted_driver;
  const d = driverDoc.data();
  const notifStatus = prefs.notifications ? '✅ activadas' : '❌ desactivadas';
  return '🏎️ *Tu piloto: ' + d.name + '*\nEquipo: ' + d.team + '\n#' + d.number + '\nNotificaciones WA: ' + notifStatus;
}

async function _cmdAdopt(nameQuery, ownerUid) {
  if (!nameQuery) return '❓ Uso: */f1 adoptar NOMBRE* (ej: /f1 adoptar Norris)';
  if (!ownerUid) return '❓ No se pudo identificar tu perfil.';
  const db = admin.firestore();
  const snap = await db.collection('f1_data/' + CURRENT_SEASON + '/drivers')
    .where('name_lower', '>=', nameQuery.toLowerCase())
    .where('name_lower', '<=', nameQuery.toLowerCase() + 'z')
    .limit(1).get();

  if (snap.empty) return '❓ Piloto "' + nameQuery + '" no encontrado.';
  const d = snap.docs[0].data();
  const driverId = snap.docs[0].id;

  await db.doc('owners/' + ownerUid + '/f1_prefs/current').set(
    { adopted_driver: driverId, uid: ownerUid, updated_at: new Date().toISOString() },
    { merge: true }
  );
  return '✅ *' + d.name + '* es ahora tu piloto!\nEquipo: ' + d.team + '\n\nUsa */f1 mipiloto* para ver sus stats.';
}

function _cmdCircuit(circuitQuery) {
  if (!circuitQuery) {
    const ids = getCircuitIds();
    return '🏁 Circuitos disponibles:\n' + ids.slice(0, 10).join(', ') + '...\nUsa: */f1 circuito monaco*';
  }
  const c = getCircuit(circuitQuery.toLowerCase().replace(/\s+/g, '_'));
  if (!c) return '❓ Circuito "' + circuitQuery + '" no encontrado.\nUsa un ID como: monaco, britain, italy...';
  return '🏁 *' + c.name + '*\n' + c.country + '\n' + c.laps + ' vueltas · ' + c.length_km + ' km/vuelta\nDistancia total: ' + (c.laps * c.length_km).toFixed(1) + ' km';
}

function _cmdHelp() {
  return [
    '🏎️ *MiiaF1 — Comandos disponibles*',
    '',
    '*/f1 posiciones* — Tabla live durante carrera',
    '*/f1 resultado* — Ultimo GP completado',
    '*/f1 siguiente* — Proximo GP',
    '*/f1 mipiloto* — Tu piloto adoptado',
    '*/f1 adoptar NOMBRE* — Adoptar piloto',
    '*/f1 piloto NOMBRE* — Info de un piloto',
    '*/f1 circuito ID* — Datos de un circuito',
  ].join('\n');
}

module.exports = { isF1Command, processF1Command };
