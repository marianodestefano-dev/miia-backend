'use strict';

/**
 * sports_mention_detector.js -- T-MD-2
 * Detecta menciones de deportes/equipos/pilotos en mensajes para auto-poblar
 * users/{uid}/miia_sports/{contactPhone}.
 *
 * Uso:
 *   detectSportMention("vamos Boca!! Vamos a ganar")
 *   -> { type: 'futbol', team: 'Boca Juniors' }
 */

// Mapeo equipo (incluye variantes) -> {teamCanonical, rivalry}
const FUTBOL_TEAMS = Object.freeze({
  // Argentina
  boca: { team: 'Boca Juniors', rivalry: 'River Plate', country: 'AR' },
  river: { team: 'River Plate', rivalry: 'Boca Juniors', country: 'AR' },
  racing: { team: 'Racing Club', rivalry: 'Independiente', country: 'AR' },
  independiente: { team: 'Independiente', rivalry: 'Racing Club', country: 'AR' },
  san_lorenzo: { team: 'San Lorenzo', rivalry: 'Huracan', country: 'AR' },
  huracan: { team: 'Huracan', rivalry: 'San Lorenzo', country: 'AR' },
  velez: { team: 'Velez Sarsfield', rivalry: null, country: 'AR' },
  estudiantes: { team: 'Estudiantes', rivalry: 'Gimnasia LP', country: 'AR' },
  // Colombia
  millonarios: { team: 'Millonarios', rivalry: 'Santa Fe', country: 'CO' },
  santa_fe: { team: 'Santa Fe', rivalry: 'Millonarios', country: 'CO' },
  nacional: { team: 'Atletico Nacional', rivalry: 'Medellin', country: 'CO' },
  medellin: { team: 'Independiente Medellin', rivalry: 'Nacional', country: 'CO' },
  // Mexico
  america: { team: 'Club America', rivalry: 'Chivas', country: 'MX' },
  chivas: { team: 'Chivas Guadalajara', rivalry: 'Club America', country: 'MX' },
  // Espana / EU
  barcelona: { team: 'FC Barcelona', rivalry: 'Real Madrid', country: 'ES' },
  madrid: { team: 'Real Madrid', rivalry: 'FC Barcelona', country: 'ES' },
});

const F1_DRIVERS = Object.freeze({
  verstappen: { driver: 'Max Verstappen', team: 'Red Bull', rivalry: 'Lewis Hamilton' },
  hamilton: { driver: 'Lewis Hamilton', team: 'Ferrari', rivalry: 'Max Verstappen' },
  norris: { driver: 'Lando Norris', team: 'McLaren', rivalry: null },
  leclerc: { driver: 'Charles Leclerc', team: 'Ferrari', rivalry: null },
  alonso: { driver: 'Fernando Alonso', team: 'Aston Martin', rivalry: null },
  colapinto: { driver: 'Franco Colapinto', team: 'Williams', rivalry: null },
  sainz: { driver: 'Carlos Sainz', team: 'Williams', rivalry: null },
  russell: { driver: 'George Russell', team: 'Mercedes', rivalry: null },
  perez: { driver: 'Sergio Perez', team: 'Red Bull', rivalry: null },
  piastri: { driver: 'Oscar Piastri', team: 'McLaren', rivalry: null },
});

// Triggers que indican que el contacto SE IDENTIFICA como hincha/fan
const FAN_TRIGGERS = Object.freeze([
  'vamos',           // "vamos boca"
  'aguante',         // "aguante racing"
  'soy hincha de',   // "soy hincha de boca"
  'hincha de',       // "hincha de river"
  'fan de',          // "fan de verstappen"
  'soy de',          // "soy de boca"
  'mi equipo',       // "mi equipo es boca"
  'mi piloto',       // "mi piloto es verstappen"
]);

function _normalize(text) {
  /* istanbul ignore next: defensive String(text || '') -- callers ya validan text != null */
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _matchTeam(normalizedText) {
  for (const key of Object.keys(FUTBOL_TEAMS)) {
    const variants = [key, key.replace(/_/g, ' ')];
    for (const v of variants) {
      if (normalizedText.includes(v)) {
        return { type: 'futbol', ...FUTBOL_TEAMS[key] };
      }
    }
  }
  return null;
}

function _matchDriver(normalizedText) {
  for (const key of Object.keys(F1_DRIVERS)) {
    if (normalizedText.includes(key)) {
      return { type: 'f1', ...F1_DRIVERS[key] };
    }
  }
  return null;
}

function _hasFanTrigger(normalizedText) {
  return FAN_TRIGGERS.some(t => normalizedText.includes(t));
}

/**
 * Detecta si un texto contiene una menciona de deporte/equipo/piloto
 * que auto-popule miia_sports.
 *
 * @param {string} text
 * @returns {object|null} { type, team?, driver?, rivalry?, confidence }
 */
function detectSportMention(text) {
  if (!text || typeof text !== 'string') return null;
  const norm = _normalize(text);
  if (!norm) return null;

  const hasTrigger = _hasFanTrigger(norm);
  const driver = _matchDriver(norm);
  if (driver) {
    return { ...driver, confidence: hasTrigger ? 'high' : 'medium' };
  }
  const team = _matchTeam(norm);
  if (team) {
    return { ...team, confidence: hasTrigger ? 'high' : 'medium' };
  }
  return null;
}

/**
 * Extrae todas las menciones distintas en un texto (para chats que mencionan
 * varios equipos a la vez).
 */
function detectAllMentions(text) {
  if (!text || typeof text !== 'string') return [];
  const norm = _normalize(text);
  const out = [];
  for (const key of Object.keys(FUTBOL_TEAMS)) {
    const variants = [key, key.replace(/_/g, ' ')];
    if (variants.some(v => norm.includes(v))) {
      out.push({ type: 'futbol', ...FUTBOL_TEAMS[key] });
    }
  }
  for (const key of Object.keys(F1_DRIVERS)) {
    if (norm.includes(key)) {
      out.push({ type: 'f1', ...F1_DRIVERS[key] });
    }
  }
  return out;
}

module.exports = {
  detectSportMention,
  detectAllMentions,
  FUTBOL_TEAMS,
  F1_DRIVERS,
  FAN_TRIGGERS,
};
