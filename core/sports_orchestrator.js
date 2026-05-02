'use strict';

/**
 * sports_orchestrator.js -- T-MD-5 + T-MD-6 + T-MD-7
 * Orquesta:
 *  - Polling scheduler: detecta eventos en vivo via adapters por sport.
 *  - Message generator: arma texto emotivo via Gemini (con fallback templates).
 *  - Envio: delega a sender (TMH) inyectado.
 *
 * API:
 *   processSportTick(uid, sportSpec, prevState, opts) -> { event?, message?, sent? }
 *   buildMessageForEvent(event, sportSpec, ownerStyle, opts) -> string
 *   shouldNotifyContact(contact, sportSpec, event) -> boolean
 */

const futbol = require('./futbol_adapter');
const f1 = require('./f1_adapter');

// Templates fallback cuando Gemini no esta disponible
const TEMPLATES = Object.freeze({
  goal_us: [
    'GOOOOL!! ⚽ {team} {our}-{rival}!! Vamoooss!!',
    'GOLAZO!! 🔥 {team} arriba {our}-{rival}!!',
  ],
  goal_rival: [
    'Nooo... empataron 😤 Tranqui que esto se da vuelta {our}-{rival}',
    'Cagada... metieron uno {our}-{rival} 😤',
  ],
  half_time: [
    'Entretiempo: {team} {our}-{rival}',
    'Termino el primer tiempo, {team} {our}-{rival}',
  ],
  resumed: [
    'Arranco el segundo tiempo!! Vamos {team}!!',
  ],
  final: [
    '{outcome}!! Final: {team} {our}-{rival} 🏆',
  ],
  started: [
    'Arranco el partido!! Vamos {team}!! ⚽',
  ],
  // F1
  position_gain: [
    '{driver} subio a P{toPosition}!! 🏎️💨',
    'Adelantamiento!! {driver} ahora P{toPosition}',
  ],
  position_loss: [
    '{driver} bajo a P{toPosition} 😤 Vuelve eh',
  ],
  pit_stop: [
    '{driver} entro a boxes en vuelta {lap}',
  ],
  safety_car: [
    'Safety car!! 🚨 {driver} en P{position}',
  ],
  fastest_lap: [
    'Vuelta rapida de {driver}!! 💨',
  ],
  race_end: [
    'Carrera terminada!! {driver} P{position} 🏁',
  ],
  race_start: [
    'Arranca la carrera!! 🏁 Vamos {driver}!!',
  ],
});

function _randTemplate(eventType) {
  const arr = TEMPLATES[eventType];
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function _interpolate(template, vars) {
  let out = template;
  for (const k of Object.keys(vars)) {
    out = out.replace(new RegExp('\{' + k + '\}', 'g'), String(vars[k]));
  }
  return out;
}

/**
 * Construye mensaje emotivo para un evento detectado.
 * Si opts.geminiClient se pasa, lo usa; caso contrario usa templates.
 */
async function buildMessageForEvent(event, sportSpec, ownerStyle, opts) {
  if (!event || !event.event) return null;
  const o = opts || {};
  const vars = Object.assign({
    team: (sportSpec && sportSpec.team) || '',
    driver: (sportSpec && sportSpec.driver) || '',
    our: event.our != null ? event.our : 0,
    rival: event.rival != null ? event.rival : 0,
    fromPosition: event.fromPosition != null ? event.fromPosition : 0,
    toPosition: event.toPosition != null ? event.toPosition : 0,
    position: event.position != null ? event.position : 0,
    lap: event.lap != null ? event.lap : 0,
    outcome: event.our > event.rival ? 'GANAMOS' : event.our < event.rival ? 'Perdimos' : 'Empate',
  }, event);

  if (o.geminiClient && typeof o.geminiClient.generate === 'function') {
    try {
      const prompt = _buildGeminiPrompt(event, sportSpec, ownerStyle, vars);
      const txt = await o.geminiClient.generate(prompt);
      if (txt && typeof txt === 'string') return txt.trim();
    } catch (e) {
      // fall back to template
    }
  }
  const tpl = _randTemplate(event.event);
  if (!tpl) return null;
  return _interpolate(tpl, vars);
}

function _buildGeminiPrompt(event, sportSpec, ownerStyle, vars) {
  return [
    'Genera UN solo mensaje corto (max 80 chars) emotivo de WhatsApp para',
    'celebrar/reaccionar a un evento deportivo en vivo.',
    'Evento: ' + event.event,
    'Deporte: ' + (sportSpec.type || 'futbol'),
    'Equipo/Piloto: ' + (sportSpec.team || sportSpec.driver),
    'Marcador/Posicion: ' + JSON.stringify(vars),
    'Estilo del owner: ' + (ownerStyle || 'argentino, hincha, emotivo'),
    'NO incluyas explicacion. Solo el mensaje. Usa 1-2 emojis.',
  ].join('\n');
}

/**
 * Decide si un contacto debe ser notificado del evento.
 */
function shouldNotifyContact(contact, sportSpec, event) {
  if (!contact || !sportSpec || !event) return false;
  if (!contact.sports || !Array.isArray(contact.sports)) return false;
  const matchSport = contact.sports.find(s => {
    if (s.type !== sportSpec.type) return false;
    if (sportSpec.type === 'futbol') return s.team === sportSpec.team;
    if (sportSpec.type === 'f1') return s.driver === sportSpec.driver;
    return false;
  });
  return !!matchSport;
}

/**
 * Procesa un tick de polling para un sportSpec.
 *
 * @param {string} uid
 * @param {object} sportSpec - { type, team?, driver? }
 * @param {object|null} prevState - estado anterior del adapter
 * @param {object} opts
 * @param {function} opts.fetcher - inyectable
 * @param {function} opts.sender - async (uid, phone, text) => void
 * @param {array} opts.contacts - lista de contactos a notificar
 * @returns {Promise<{event, message, sent, currentState}>}
 */
async function processSportTick(uid, sportSpec, prevState, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!sportSpec || !sportSpec.type) throw new Error('sportSpec requerido');
  /* istanbul ignore next: defensive opts || {} -- callers reales siempre pasan opts */
  const o = opts || {};

  let current = null;
  let event = null;
  if (sportSpec.type === 'futbol') {
    current = await futbol.fetchMatchStatus(sportSpec.team, { fetcher: o.fetcher });
    event = futbol.detectScoreChange(prevState, current);
  } else if (sportSpec.type === 'f1') {
    current = await f1.fetchRaceStatus({ driver: sportSpec.driver, fetcher: o.fetcher });
    event = f1.detectRaceEvent(prevState, current);
  } else {
    return { event: null, message: null, sent: 0, currentState: null };
  }

  if (!event) return { event: null, message: null, sent: 0, currentState: current };

  const message = await buildMessageForEvent(event, sportSpec, o.ownerStyle, { geminiClient: o.geminiClient });
  /* istanbul ignore next */
  if (!message) return { event, message: null, sent: 0, currentState: current };

  let sent = 0;
  const contacts = Array.isArray(o.contacts) ? o.contacts : [];
  for (const contact of contacts) {
    if (shouldNotifyContact(contact, sportSpec, event)) {
      if (o.sender && typeof o.sender === 'function') {
        try {
          await o.sender(uid, contact.contactPhone, message);
          sent++;
        } catch (e) {
          // continue with other contacts
        }
      }
    }
  }
  return { event, message, sent, currentState: current };
}

module.exports = {
  processSportTick,
  buildMessageForEvent,
  shouldNotifyContact,
  TEMPLATES,
};
