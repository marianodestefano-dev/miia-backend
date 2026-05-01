'use strict';

/**
 * MIIA — Rate Window (T136)
 * Ventana deslizante para rate limiting con limpieza automatica de entradas antiguas.
 * Thread-safe para uso single-process (Node.js).
 */

const CLEANUP_INTERVAL_MS = 60 * 1000; // limpiar cada minuto

class RateWindow {
  /**
   * @param {{ windowMs, maxRequests, cleanupIntervalMs? }} opts
   */
  constructor({ windowMs, maxRequests, cleanupIntervalMs = CLEANUP_INTERVAL_MS } = {}) {
    if (!windowMs || windowMs <= 0) throw new Error('windowMs requerido y > 0');
    if (!maxRequests || maxRequests <= 0) throw new Error('maxRequests requerido y > 0');

    this._windowMs = windowMs;
    this._maxRequests = maxRequests;
    this._buckets = {}; // key -> [timestamp, ...]

    this._cleanupTimer = null;
    if (cleanupIntervalMs > 0) {
      this._cleanupTimer = setInterval(() => this._cleanup(), cleanupIntervalMs);
      if (this._cleanupTimer.unref) this._cleanupTimer.unref(); // no bloquear shutdown
    }
  }

  /**
   * Registra un request y verifica si esta dentro del limite.
   * @param {string} key - identificador (uid, phone, ip, etc.)
   * @param {number} [nowMs]
   * @returns {{ allowed: boolean, count: number, remaining: number, resetAt: number }}
   */
  check(key, nowMs = Date.now()) {
    if (!key || typeof key !== 'string') throw new Error('key requerido');

    const cutoff = nowMs - this._windowMs;
    const bucket = this._buckets[key] || [];

    // Eliminar entradas fuera de la ventana
    const active = bucket.filter(ts => ts > cutoff);
    const count = active.length;
    const allowed = count < this._maxRequests;

    if (allowed) {
      active.push(nowMs);
    }

    this._buckets[key] = active;

    const oldest = active.length > 0 ? active[0] : nowMs;
    const resetAt = oldest + this._windowMs;

    return {
      allowed,
      count: allowed ? count + 1 : count,
      remaining: Math.max(0, this._maxRequests - (allowed ? count + 1 : count)),
      resetAt,
    };
  }

  /**
   * Retorna el conteo actual SIN registrar un nuevo request.
   */
  peek(key, nowMs = Date.now()) {
    if (!key) return { count: 0, remaining: this._maxRequests };
    const cutoff = nowMs - this._windowMs;
    const active = (this._buckets[key] || []).filter(ts => ts > cutoff);
    return {
      count: active.length,
      remaining: Math.max(0, this._maxRequests - active.length),
    };
  }

  /**
   * Resetea el bucket de una key.
   */
  reset(key) {
    if (key) delete this._buckets[key];
    else this._buckets = {};
  }

  /**
   * Limpia entradas expiradas de todos los buckets.
   */
  _cleanup(nowMs = Date.now()) {
    const cutoff = nowMs - this._windowMs;
    let cleaned = 0;
    for (const key of Object.keys(this._buckets)) {
      const before = this._buckets[key].length;
      this._buckets[key] = this._buckets[key].filter(ts => ts > cutoff);
      if (this._buckets[key].length === 0) delete this._buckets[key];
      cleaned += before - (this._buckets[key] ? this._buckets[key].length : 0);
    }
    return cleaned;
  }

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._buckets = {};
  }

  get bucketCount() { return Object.keys(this._buckets).length; }
}

module.exports = { RateWindow, CLEANUP_INTERVAL_MS };
