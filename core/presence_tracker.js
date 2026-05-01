'use strict';

/**
 * MIIA — Presence Tracker (T137)
 * Rastrea la presencia del owner para evitar respuestas automaticas
 * cuando el owner esta activo (regla 6.17: trigger override).
 */

const DEFAULT_COOLDOWN_MS = 90 * 60 * 1000; // 90 minutos (regla existente)
const DEFAULT_AWAY_THRESHOLD_MS = 5 * 60 * 1000; // 5 min sin actividad = away

class PresenceTracker {
  constructor({ cooldownMs = DEFAULT_COOLDOWN_MS, awayThresholdMs = DEFAULT_AWAY_THRESHOLD_MS } = {}) {
    this._cooldownMs = cooldownMs;
    this._awayThresholdMs = awayThresholdMs;
    this._lastSeen = {}; // uid -> timestampMs
    this._presence = {}; // uid -> 'online'|'away'|'offline'
  }

  /**
   * Registra actividad del owner.
   */
  recordActivity(uid, nowMs = Date.now()) {
    if (!uid) throw new Error('uid requerido');
    this._lastSeen[uid] = nowMs;
    this._presence[uid] = 'online';
    console.log(`[PRESENCE] uid=${uid.substring(0,8)} online at=${new Date(nowMs).toISOString()}`);
  }

  /**
   * Obtiene el estado de presencia actual.
   * @returns {'online'|'away'|'offline'}
   */
  getPresence(uid, nowMs = Date.now()) {
    if (!uid) throw new Error('uid requerido');
    const lastSeen = this._lastSeen[uid];
    if (!lastSeen) return 'offline';

    const elapsed = nowMs - lastSeen;
    if (elapsed <= this._awayThresholdMs) return 'online';
    if (elapsed <= this._cooldownMs) return 'away';
    return 'offline';
  }

  /**
   * Verifica si el owner esta en cooldown (online o away).
   * Cuando esta en cooldown, MIIA no debe auto-responder (a menos que haya trigger override).
   */
  isInCooldown(uid, nowMs = Date.now()) {
    const presence = this.getPresence(uid, nowMs);
    return presence === 'online' || presence === 'away';
  }

  /**
   * Retorna tiempo restante de cooldown en ms.
   */
  getCooldownRemaining(uid, nowMs = Date.now()) {
    const lastSeen = this._lastSeen[uid];
    if (!lastSeen) return 0;
    const elapsed = nowMs - lastSeen;
    return Math.max(0, this._cooldownMs - elapsed);
  }

  /**
   * Retorna el timestamp de ultima actividad.
   */
  getLastSeen(uid) {
    return this._lastSeen[uid] || null;
  }

  /**
   * Marca al owner como offline manualmente.
   */
  setOffline(uid) {
    if (!uid) throw new Error('uid requerido');
    delete this._lastSeen[uid];
    this._presence[uid] = 'offline';
  }

  /**
   * Limpia todos los registros de presencia.
   */
  clear(uid) {
    if (uid) {
      delete this._lastSeen[uid];
      delete this._presence[uid];
    } else {
      this._lastSeen = {};
      this._presence = {};
    }
  }
}

module.exports = { PresenceTracker, DEFAULT_COOLDOWN_MS, DEFAULT_AWAY_THRESHOLD_MS };
