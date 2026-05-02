'use strict';

/**
 * futbol_adapter.js -- T-MD-3
 * Adapter de Futbol para Modo Deporte. MVP usa Google Search para
 * obtener marcadores en vivo (parsing del snippet).
 *
 * API:
 *   fetchMatchStatus(team, opts) -> { team, score: {our, rival}, minute, status, rival, ts }
 *   detectScoreChange(prev, current) -> null o {event:'goal_us'|'goal_rival'|'final'|'started'|'half_time', our, rival}
 *
 * Estado:
 *   status: 'scheduled' | 'live' | 'half_time' | 'finished' | 'unknown'
 */

const STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  HALF_TIME: 'half_time',
  FINISHED: 'finished',
  UNKNOWN: 'unknown',
});

const EVENT_TYPES = Object.freeze({
  STARTED: 'started',
  GOAL_US: 'goal_us',
  GOAL_RIVAL: 'goal_rival',
  HALF_TIME: 'half_time',
  RESUMED: 'resumed',
  FINAL: 'final',
});

/**
 * Realiza una request a un proveedor (Google Search o API) para obtener
 * el estado del partido. En MVP, parsea snippet/JSON dado.
 *
 * @param {string} team
 * @param {object} opts
 * @param {function} opts.fetcher - funcion que retorna {raw, source} (testeable)
 * @returns {Promise<object>}
 */
async function fetchMatchStatus(team, opts) {
  if (!team || typeof team !== 'string') throw new Error('team requerido');
  const o = opts || {};
  const fetcher = o.fetcher || _defaultFetcher;
  const result = await fetcher(team);
  return _parseMatchResult(team, result, o);
}

/* istanbul ignore next */
async function _defaultFetcher(team) {
  // Real implementation: HTTP GET a Google Search o API de futbol.
  // En tests se reemplaza con mock via opts.fetcher.
  throw new Error('default fetcher not implemented; pass opts.fetcher');
}

/**
 * Parsea un resultado generico (string snippet o objeto estructurado) y devuelve
 * estado normalizado.
 *
 * Formatos aceptados:
 *   - String snippet: "Boca 2 - 1 River, 67'" o "Boca 1 - 0 River en vivo"
 *   - Objeto: { our: 2, rival: 1, minute: 67, status: 'live', rival: 'River' }
 *   - Snippet final: "Finalizado: Boca 2-1 River"
 */
function _parseMatchResult(team, result, opts) {
  if (!result) return _empty(team);
  if (typeof result === 'object' && (result.our !== undefined || result.score !== undefined)) {
    return _normalizeStruct(team, result);
  }
  const raw = typeof result === 'string' ? result : (result.raw || '');
  if (!raw) return _empty(team);
  return _parseSnippet(team, raw);
}

function _empty(team) {
  return { team, score: { our: 0, rival: 0 }, minute: 0, status: STATUS.UNKNOWN, rival: null, ts: Date.now() };
}

function _normalizeStruct(team, r) {
  const score = r.score || { our: r.our, rival: r.rival_score !== undefined ? r.rival_score : r.opponent };
  return {
    team,
    score: { our: Number(score.our) || 0, rival: Number(score.rival) || 0 },
    minute: typeof r.minute === 'number' ? r.minute : 0,
    status: r.status || STATUS.UNKNOWN,
    rival: r.rival || null,
    ts: Date.now(),
  };
}

function _parseSnippet(team, raw) {
  const lower = raw.toLowerCase();
  const isFinal = lower.includes('finalizado') || lower.includes('final ') || lower.includes('terminado');
  const isHalf = lower.includes('entretiempo') || lower.includes('half time') || lower.includes('descanso');

  // Patron: "TeamA N1 - N2 TeamB" o "TeamA N1-N2 TeamB"
  const scoreMatch = raw.match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!scoreMatch) return _empty(team);
  const a = parseInt(scoreMatch[1], 10);
  const b = parseInt(scoreMatch[2], 10);

  // El "team" del owner aparece en el raw -- determinar si esta antes o despues del marcador
  const teamPos = lower.indexOf(team.toLowerCase());
  const scorePos = raw.indexOf(scoreMatch[0]);
  let our = a, rival = b;
  if (teamPos > scorePos) { our = b; rival = a; }

  // Minuto: " 45'" o " 67'"
  let minute = 0;
  const minMatch = raw.match(/(\d{1,3})\s*['′]/);
  if (minMatch) minute = parseInt(minMatch[1], 10);

  let status = STATUS.LIVE;
  if (isFinal) status = STATUS.FINISHED;
  else if (isHalf) status = STATUS.HALF_TIME;

  // Rival name: heuristica buscar palabras tras el marcador
  let rivalName = null;
  const afterScore = raw.substring(scorePos + scoreMatch[0].length).trim().split(/[,\s]/)[0];
  if (afterScore) rivalName = afterScore;

  return {
    team,
    score: { our, rival },
    minute,
    status,
    rival: rivalName,
    ts: Date.now(),
  };
}

/**
 * Compara dos snapshots y detecta cambios.
 *
 * @returns {object|null} evento detectado o null si nada cambio
 */
function detectScoreChange(prev, current) {
  if (!current || !current.score) return null;
  if (!prev || !prev.score) {
    if (current.status === STATUS.LIVE) {
      return { event: EVENT_TYPES.STARTED, our: current.score.our, rival: current.score.rival };
    }
    return null;
  }
  if (current.score.our > prev.score.our) {
    return { event: EVENT_TYPES.GOAL_US, our: current.score.our, rival: current.score.rival };
  }
  if (current.score.rival > prev.score.rival) {
    return { event: EVENT_TYPES.GOAL_RIVAL, our: current.score.our, rival: current.score.rival };
  }
  if (prev.status !== STATUS.HALF_TIME && current.status === STATUS.HALF_TIME) {
    return { event: EVENT_TYPES.HALF_TIME, our: current.score.our, rival: current.score.rival };
  }
  if (prev.status === STATUS.HALF_TIME && current.status === STATUS.LIVE) {
    return { event: EVENT_TYPES.RESUMED, our: current.score.our, rival: current.score.rival };
  }
  if (prev.status !== STATUS.FINISHED && current.status === STATUS.FINISHED) {
    return { event: EVENT_TYPES.FINAL, our: current.score.our, rival: current.score.rival };
  }
  return null;
}

module.exports = {
  fetchMatchStatus,
  detectScoreChange,
  STATUS,
  EVENT_TYPES,
};
