'use strict';

/**
 * MIIA — Event Emitter interno (T125)
 * Bus de eventos tipado. Max 20 listeners por evento.
 * Eventos validos definidos en VALID_EVENTS.
 */

const VALID_EVENTS = Object.freeze([
  'message:received',
  'message:sent',
  'lead:classified',
  'lead:updated',
  'broadcast:started',
  'broadcast:completed',
  'consent:changed',
  'owner:connected',
  'owner:disconnected',
  'health:degraded',
  'health:ok',
]);

const MAX_LISTENERS = 20;

class MiiaEventEmitter {
  constructor() {
    this._listeners = {}; // event -> [{ id, fn, once }]
    this._nextId = 1;
  }

  /**
   * Valida que el evento sea valido.
   */
  _validateEvent(event) {
    if (!event || typeof event !== 'string') throw new Error('event requerido');
    if (!VALID_EVENTS.includes(event)) throw new Error(`evento invalido: ${event}`);
  }

  /**
   * Suscribe un listener a un evento.
   * @returns {number} subscriptionId para poder cancelar
   */
  on(event, fn) {
    this._validateEvent(event);
    if (typeof fn !== 'function') throw new Error('listener debe ser funcion');
    const listeners = this._listeners[event] || [];
    if (listeners.length >= MAX_LISTENERS) {
      throw new Error(`max listeners (${MAX_LISTENERS}) alcanzado para ${event}`);
    }
    const id = this._nextId++;
    this._listeners[event] = [...listeners, { id, fn, once: false }];
    return id;
  }

  /**
   * Suscribe un listener que se ejecuta solo una vez.
   */
  once(event, fn) {
    this._validateEvent(event);
    if (typeof fn !== 'function') throw new Error('listener debe ser funcion');
    const listeners = this._listeners[event] || [];
    if (listeners.length >= MAX_LISTENERS) {
      throw new Error(`max listeners (${MAX_LISTENERS}) alcanzado para ${event}`);
    }
    const id = this._nextId++;
    this._listeners[event] = [...listeners, { id, fn, once: true }];
    return id;
  }

  /**
   * Cancela suscripcion por id.
   */
  off(id) {
    for (const event of Object.keys(this._listeners)) {
      this._listeners[event] = this._listeners[event].filter(l => l.id !== id);
    }
  }

  /**
   * Emite un evento con datos opcionales.
   * @returns {number} numero de listeners invocados
   */
  emit(event, data = {}) {
    this._validateEvent(event);
    const listeners = this._listeners[event] || [];
    if (listeners.length === 0) return 0;

    let called = 0;
    const remaining = [];
    for (const listener of listeners) {
      try {
        listener.fn(data);
        called++;
      } catch (e) {
        console.error(`[EVENT-EMITTER] Error en listener id=${listener.id} event=${event}: ${e.message}`);
      }
      if (!listener.once) remaining.push(listener);
    }
    this._listeners[event] = remaining;
    return called;
  }

  /**
   * Retorna cantidad de listeners activos para un evento.
   */
  listenerCount(event) {
    return (this._listeners[event] || []).length;
  }

  /**
   * Remueve todos los listeners de un evento (o todos si no se especifica).
   */
  removeAllListeners(event) {
    if (event) {
      this._listeners[event] = [];
    } else {
      this._listeners = {};
    }
  }
}

module.exports = { MiiaEventEmitter, VALID_EVENTS, MAX_LISTENERS };
