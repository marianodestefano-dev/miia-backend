'use strict';

/**
 * MIIA — Circuit Breaker (T128)
 * Protege llamadas externas con patron circuit breaker.
 * Estados: CLOSED (normal) -> OPEN (falla) -> HALF_OPEN (prueba)
 */

const STATES = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' });

const DEFAULTS = Object.freeze({
  failureThreshold: 5,    // fallos consecutivos para abrir
  successThreshold: 2,    // exitos consecutivos en half_open para cerrar
  openTimeoutMs: 30000,   // tiempo en OPEN antes de pasar a HALF_OPEN
  name: 'default',
});

class CircuitBreaker {
  constructor(opts = {}) {
    this._name = opts.name || DEFAULTS.name;
    this._failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this._successThreshold = opts.successThreshold ?? DEFAULTS.successThreshold;
    this._openTimeoutMs = opts.openTimeoutMs ?? DEFAULTS.openTimeoutMs;

    this._state = STATES.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._openedAt = null;
  }

  get state() { return this._state; }
  get failureCount() { return this._failureCount; }

  /**
   * Ejecuta fn protegida por el circuit breaker.
   * @throws {Error} con code 'CIRCUIT_OPEN' si el circuito está abierto
   */
  async execute(fn, nowMs = Date.now()) {
    if (typeof fn !== 'function') throw new Error('fn requerido');

    this._maybeTransitionToHalfOpen(nowMs);

    if (this._state === STATES.OPEN) {
      const err = new Error(`[CIRCUIT-BREAKER] ${this._name}: circuito abierto`);
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (e) {
      this._onFailure();
      throw e;
    }
  }

  _maybeTransitionToHalfOpen(nowMs) {
    if (this._state === STATES.OPEN && this._openedAt !== null) {
      if (nowMs - this._openedAt >= this._openTimeoutMs) {
        this._state = STATES.HALF_OPEN;
        this._successCount = 0;
        console.log(`[CIRCUIT-BREAKER] ${this._name}: OPEN -> HALF_OPEN`);
      }
    }
  }

  _onSuccess() {
    if (this._state === STATES.HALF_OPEN) {
      this._successCount++;
      if (this._successCount >= this._successThreshold) {
        this._state = STATES.CLOSED;
        this._failureCount = 0;
        this._successCount = 0;
        this._openedAt = null;
        console.log(`[CIRCUIT-BREAKER] ${this._name}: HALF_OPEN -> CLOSED`);
      }
    } else {
      this._failureCount = 0;
    }
  }

  _onFailure() {
    this._failureCount++;
    if (this._state === STATES.HALF_OPEN) {
      this._state = STATES.OPEN;
      this._openedAt = Date.now();
      this._successCount = 0;
      console.warn(`[CIRCUIT-BREAKER] ${this._name}: HALF_OPEN -> OPEN (fallo en prueba)`);
    } else if (this._failureCount >= this._failureThreshold) {
      this._state = STATES.OPEN;
      this._openedAt = Date.now();
      console.warn(`[CIRCUIT-BREAKER] ${this._name}: CLOSED -> OPEN (${this._failureCount} fallos)`);
    }
  }

  reset() {
    this._state = STATES.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._openedAt = null;
  }

  getStats() {
    return {
      name: this._name,
      state: this._state,
      failureCount: this._failureCount,
      successCount: this._successCount,
      openedAt: this._openedAt,
    };
  }
}

module.exports = { CircuitBreaker, STATES, DEFAULTS };
