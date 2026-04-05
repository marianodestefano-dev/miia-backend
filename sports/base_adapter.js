/**
 * MIIA Sport Base Adapter
 * Clase base para todos los adapters deportivos.
 * Cada deporte extiende esta clase e implementa los métodos abstractos.
 *
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

class BaseSportAdapter {
  /**
   * @param {string} sportType — Identificador único del deporte (futbol, f1, tenis, etc.)
   * @param {object} opts
   * @param {number} opts.pollIntervalMs — Intervalo de polling durante evento vivo (ms)
   * @param {number} opts.scheduleCheckIntervalMs — Intervalo entre checks de calendario (ms)
   * @param {string} opts.displayName — Nombre legible del deporte
   * @param {string} opts.emoji — Emoji representativo
   */
  constructor(sportType, opts = {}) {
    if (new.target === BaseSportAdapter) {
      throw new Error('[SPORT] BaseSportAdapter no puede instanciarse directamente');
    }
    this.sportType = sportType;
    this.pollIntervalMs = opts.pollIntervalMs || 60000;
    this.scheduleCheckIntervalMs = opts.scheduleCheckIntervalMs || 1800000;
    this.displayName = opts.displayName || sportType;
    this.emoji = opts.emoji || '⚽';
    this._lastError = null;
  }

  /**
   * Obtiene el calendario de eventos para una fecha dada.
   * @param {string} date — Formato YYYY-MM-DD
   * @returns {Promise<Array<SportEvent>>} Lista de eventos
   *
   * SportEvent: {
   *   matchId: string,          — ID único del evento
   *   name: string,             — "Boca Juniors vs River Plate"
   *   teams: string[],          — ["Boca Juniors", "River Plate"] o participantes
   *   startTime: string,        — ISO 8601
   *   status: string,           — 'scheduled'|'live'|'finished'|'cancelled'|'postponed'
   *   league: string,           — "Liga Argentina", "Grand Prix de Monaco"
   *   metadata: object          — Datos extra sport-specific
   * }
   */
  async getSchedule(date) {
    throw new Error(`[SPORT:${this.sportType}] getSchedule() no implementado`);
  }

  /**
   * Obtiene el estado en vivo de un evento específico.
   * @param {string} matchId — ID del evento
   * @param {object} metadata — Datos extra del evento (para contexto)
   * @returns {Promise<object>} Estado sport-specific
   */
  async getLiveState(matchId, metadata = {}) {
    throw new Error(`[SPORT:${this.sportType}] getLiveState() no implementado`);
  }

  /**
   * Detecta cambios entre dos estados consecutivos.
   * @param {object} oldState — Estado anterior (null si es el primer poll)
   * @param {object} newState — Estado actual
   * @returns {Array<SportChange>} Lista de cambios detectados
   *
   * SportChange: {
   *   type: string,             — 'goal', 'position_change', 'set_won', etc.
   *   description: string,      — "Boca metió gol: 1-0 (minuto 14)"
   *   emotion: string,          — 'low'|'medium'|'high'|'explosive'
   *   data: object,             — Datos extra sport-specific
   *   affectsTeams: string[]    — Equipos/participantes afectados
   * }
   */
  detectChanges(oldState, newState) {
    throw new Error(`[SPORT:${this.sportType}] detectChanges() no implementado`);
  }

  /**
   * Formatea un evento + estado para inyección en prompt.
   * @param {SportEvent} event
   * @param {object} state — Estado actual del evento
   * @returns {string} Descripción legible
   */
  formatEvent(event, state) {
    if (!event) return '';
    return `${this.emoji} ${event.name} — ${event.league || ''}`;
  }

  /**
   * Verifica si un evento coincide con la preferencia deportiva de un contacto.
   * @param {SportEvent} event
   * @param {object} sportPref — { type, team, driver, rivalry, league }
   * @returns {boolean}
   */
  matchesPreference(event, sportPref) {
    if (!event || !sportPref) return false;
    if (sportPref.type !== this.sportType) return false;

    const target = (sportPref.team || sportPref.driver || '').toLowerCase();
    if (!target) return false;

    return (event.teams || []).some(t =>
      this._normalize(t).includes(this._normalize(target)) ||
      this._normalize(target).includes(this._normalize(t))
    );
  }

  /**
   * Determina el nivel de emoción de un cambio.
   * Override en cada adapter para lógica sport-specific.
   * @param {SportChange} change
   * @returns {string} 'low'|'medium'|'high'|'explosive'
   */
  getEmotionLevel(change) {
    return change?.emotion || 'medium';
  }

  /**
   * Determina si un cambio es positivo o negativo para un equipo/participante.
   * @param {SportChange} change
   * @param {string} team — Equipo/participante del contacto
   * @returns {string} 'positive'|'negative'|'neutral'
   */
  getSentiment(change, team) {
    return 'neutral';
  }

  /**
   * Indica si el evento ha terminado basándose en el estado.
   * @param {object} state
   * @returns {boolean}
   */
  isFinished(state) {
    if (!state) return false;
    return state.status === 'finished' || state.status === 'final' || state.status === 'ended';
  }

  // ═══ UTILIDADES INTERNAS ═══

  /**
   * Normaliza texto para comparación fuzzy.
   * Remueve acentos, espacios extras, y convierte a minúsculas.
   */
  _normalize(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Genera un eventKey único para tracking.
   */
  _eventKey(event) {
    const teams = (event.teams || []).map(t => this._normalize(t).replace(/\s/g, '_')).join('_vs_');
    const date = (event.startTime || '').slice(0, 10);
    return `${this.sportType}_${teams}_${date}`;
  }

  /**
   * Log con prefijo del adapter.
   */
  _log(msg, ...args) {
    console.log(`[SPORT:${this.sportType.toUpperCase()}] ${msg}`, ...args);
  }

  /**
   * Error log con prefijo del adapter.
   */
  _error(msg, ...args) {
    console.error(`[SPORT:${this.sportType.toUpperCase()}] ERROR: ${msg}`, ...args);
    this._lastError = { message: msg, timestamp: Date.now() };
  }
}

module.exports = BaseSportAdapter;
