'use strict';

/**
 * f1_adapter.js -- T-MD-4
 * Adapter de F1 usando OpenF1 API (gratis).
 * Detecta cambios de posicion, pit stops, safety car, fastest lap.
 *
 * API:
 *   fetchRaceStatus(opts) -> { driver, position, lap, pitStops, status, ts }
 *   detectRaceEvent(prev, current) -> evento detectado
 */

const F1_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  PRE_RACE: 'pre_race',
  RACE_LIVE: 'race_live',
  SAFETY_CAR: 'safety_car',
  RED_FLAG: 'red_flag',
  FINISHED: 'finished',
  UNKNOWN: 'unknown',
});

const F1_EVENT_TYPES = Object.freeze({
  POS_GAIN: 'position_gain',
  POS_LOSS: 'position_loss',
  PIT_STOP: 'pit_stop',
  SAFETY_CAR: 'safety_car',
  RACE_END: 'race_end',
  RACE_START: 'race_start',
  FASTEST_LAP: 'fastest_lap',
});

/**
 * Fetcher OpenF1 API o struct directa (testeable).
 * @param {object} opts
 * @param {string} opts.driverNumber - numero del piloto (e.g., '1' Verstappen)
 * @param {function} opts.fetcher - funcion async que retorna data del piloto
 * @returns {Promise<object>}
 */
async function fetchRaceStatus(opts) {
  const o = opts || {};
  if (!o.driver && !o.driverNumber) throw new Error('driver o driverNumber requerido');
  const fetcher = o.fetcher || _defaultFetcher;
  const result = await fetcher(o);
  return _parseF1Result(o, result);
}

/* istanbul ignore next */
async function _defaultFetcher(opts) {
  throw new Error('default fetcher not implemented; pass opts.fetcher');
}

function _parseF1Result(opts, result) {
  if (!result) return _empty(opts);
  if (typeof result !== 'object') return _empty(opts);
  return {
    driver: opts.driver || result.driver || null,
    driverNumber: opts.driverNumber || result.driverNumber || null,
    position: typeof result.position === 'number' ? result.position : 0,
    lap: typeof result.lap === 'number' ? result.lap : 0,
    pitStops: typeof result.pitStops === 'number' ? result.pitStops : 0,
    status: result.status || F1_STATUS.UNKNOWN,
    fastestLap: result.fastestLap === true,
    ts: Date.now(),
  };
}

function _empty(opts) {
  return {
    driver: opts.driver || null,
    driverNumber: opts.driverNumber || null,
    position: 0, lap: 0, pitStops: 0,
    status: F1_STATUS.UNKNOWN, fastestLap: false, ts: Date.now(),
  };
}

/**
 * Compara dos snapshots y detecta eventos relevantes.
 * @returns {object|null}
 */
function detectRaceEvent(prev, current) {
  if (!current) return null;
  if (!prev) {
    if (current.status === F1_STATUS.RACE_LIVE && current.lap > 0) {
      return { event: F1_EVENT_TYPES.RACE_START, position: current.position, lap: current.lap };
    }
    return null;
  }

  // Posicion mejor (numero menor = posicion mejor)
  if (prev.position > 0 && current.position > 0 && current.position < prev.position) {
    return { event: F1_EVENT_TYPES.POS_GAIN, fromPosition: prev.position, toPosition: current.position, lap: current.lap };
  }
  if (prev.position > 0 && current.position > 0 && current.position > prev.position) {
    return { event: F1_EVENT_TYPES.POS_LOSS, fromPosition: prev.position, toPosition: current.position, lap: current.lap };
  }

  // Pit stop
  if (current.pitStops > prev.pitStops) {
    return { event: F1_EVENT_TYPES.PIT_STOP, position: current.position, pitStops: current.pitStops, lap: current.lap };
  }

  // Safety car
  if (prev.status !== F1_STATUS.SAFETY_CAR && current.status === F1_STATUS.SAFETY_CAR) {
    return { event: F1_EVENT_TYPES.SAFETY_CAR, position: current.position, lap: current.lap };
  }

  // Race end
  if (prev.status !== F1_STATUS.FINISHED && current.status === F1_STATUS.FINISHED) {
    return { event: F1_EVENT_TYPES.RACE_END, position: current.position, lap: current.lap };
  }

  // Fastest lap
  if (!prev.fastestLap && current.fastestLap) {
    return { event: F1_EVENT_TYPES.FASTEST_LAP, position: current.position, lap: current.lap };
  }

  return null;
}

module.exports = {
  fetchRaceStatus,
  detectRaceEvent,
  F1_STATUS,
  F1_EVENT_TYPES,
};
