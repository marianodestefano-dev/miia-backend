'use strict';

/**
 * MIIA — Message Queue (T121)
 * Cola de mensajes pendientes con prioridad y TTL.
 * Prioridades: high=1, normal=2, low=3 (menor = mayor prioridad)
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutos
const VALID_PRIORITIES = Object.freeze(['high', 'normal', 'low']);
const PRIORITY_VALUE = Object.freeze({ high: 1, normal: 2, low: 3 });

class MessageQueue {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this._ttlMs = ttlMs;
    this._queue = []; // [{ id, uid, phone, message, priority, enqueuedAt, expiresAt }]
    this._nextId = 1;
  }

  /**
   * Agrega un mensaje a la cola.
   * @param {string} uid
   * @param {string} phone
   * @param {string} message
   * @param {{ priority?: string }} opts
   * @returns {{ id, enqueuedAt, expiresAt }}
   */
  enqueue(uid, phone, message, { priority = 'normal' } = {}) {
    if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
    if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
    if (!message || typeof message !== 'string') throw new Error('message requerido');
    if (!VALID_PRIORITIES.includes(priority)) throw new Error(`priority invalido: ${priority}`);

    const now = Date.now();
    const item = {
      id: this._nextId++,
      uid,
      phone,
      message,
      priority,
      enqueuedAt: now,
      expiresAt: now + this._ttlMs,
    };
    this._queue.push(item);
    this._queue.sort((a, b) => {
      const pd = PRIORITY_VALUE[a.priority] - PRIORITY_VALUE[b.priority];
      return pd !== 0 ? pd : a.enqueuedAt - b.enqueuedAt;
    });
    return { id: item.id, enqueuedAt: item.enqueuedAt, expiresAt: item.expiresAt };
  }

  /**
   * Extrae el próximo mensaje no expirado para un uid/phone.
   * @param {string} uid
   * @param {string} phone
   * @param {number} [nowMs]
   * @returns {object|null}
   */
  dequeue(uid, phone, nowMs = Date.now()) {
    this._purgeExpired(nowMs);
    const idx = this._queue.findIndex(item => item.uid === uid && item.phone === phone);
    if (idx === -1) return null;
    return this._queue.splice(idx, 1)[0];
  }

  /**
   * Extrae el próximo mensaje de cualquier phone para un uid.
   * @param {string} uid
   * @param {number} [nowMs]
   * @returns {object|null}
   */
  dequeueNext(uid, nowMs = Date.now()) {
    this._purgeExpired(nowMs);
    const idx = this._queue.findIndex(item => item.uid === uid);
    if (idx === -1) return null;
    return this._queue.splice(idx, 1)[0];
  }

  /**
   * Retorna cantidad de items en cola para uid (no expirados).
   */
  size(uid, nowMs = Date.now()) {
    this._purgeExpired(nowMs);
    if (uid) return this._queue.filter(i => i.uid === uid).length;
    return this._queue.length;
  }

  /**
   * Limpia mensajes expirados.
   */
  _purgeExpired(nowMs = Date.now()) {
    const before = this._queue.length;
    this._queue = this._queue.filter(i => i.expiresAt > nowMs);
    const purged = before - this._queue.length;
    if (purged > 0) console.log(`[QUEUE] Purged ${purged} expired items`);
  }

  /**
   * Vacía la cola completa o de un uid específico.
   */
  clear(uid) {
    if (uid) {
      const before = this._queue.length;
      this._queue = this._queue.filter(i => i.uid !== uid);
      console.log(`[QUEUE] Cleared ${before - this._queue.length} items for uid=${uid.substring(0,8)}`);
    } else {
      this._queue = [];
    }
  }
}

module.exports = { MessageQueue, DEFAULT_TTL_MS, VALID_PRIORITIES, PRIORITY_VALUE };
