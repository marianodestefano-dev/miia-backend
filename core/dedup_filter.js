'use strict';

/**
 * MIIA — Dedup Filter (T138)
 * Filtra mensajes duplicados con ventana temporal y hash de contenido.
 * Protege contra re-procesamiento de mensajes ya vistos (regla 6.13 adjacent).
 */

const crypto = require('crypto');

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const DEFAULT_MAX_SIZE = 10000; // max entradas en memoria

/**
 * Genera un hash MD5 corto del contenido de un mensaje.
 */
function hashMessage(phone, text) {
  const input = `${phone}:${text}`;
  return crypto.createHash('md5').update(input).digest('hex').slice(0, 12);
}

class DedupFilter {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxSize = DEFAULT_MAX_SIZE } = {}) {
    this._windowMs = windowMs;
    this._maxSize = maxSize;
    this._seen = new Map(); // hash -> timestampMs
  }

  /**
   * Verifica si un mensaje es duplicado y lo registra si no lo es.
   * @param {string} phone
   * @param {string} text
   * @param {number} [nowMs]
   * @returns {{ isDuplicate: boolean, hash: string }}
   */
  check(phone, text, nowMs = Date.now()) {
    if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
    if (text === undefined || text === null) throw new Error('text requerido');

    this._evictExpired(nowMs);

    const hash = hashMessage(phone, String(text));
    const lastSeen = this._seen.get(hash);

    if (lastSeen && nowMs - lastSeen < this._windowMs) {
      return { isDuplicate: true, hash };
    }

    // Evict si demasiado grande
    if (this._seen.size >= this._maxSize) {
      const oldest = this._seen.keys().next().value;
      this._seen.delete(oldest);
    }

    this._seen.set(hash, nowMs);
    return { isDuplicate: false, hash };
  }

  /**
   * Registra un messageId explicitamente (para mensajes enviados por la propia MIIA, regla 6.13).
   */
  registerSent(msgId, nowMs = Date.now()) {
    if (!msgId) throw new Error('msgId requerido');
    this._seen.set(`sent:${msgId}`, nowMs);
  }

  /**
   * Verifica si un msgId fue enviado por MIIA.
   */
  isSentByMiia(msgId, nowMs = Date.now()) {
    if (!msgId) return false;
    const key = `sent:${msgId}`;
    const ts = this._seen.get(key);
    return ts !== undefined && nowMs - ts < this._windowMs;
  }

  /**
   * Elimina entradas expiradas.
   */
  _evictExpired(nowMs = Date.now()) {
    const cutoff = nowMs - this._windowMs;
    for (const [key, ts] of this._seen.entries()) {
      if (ts < cutoff) this._seen.delete(key);
    }
  }

  get size() { return this._seen.size; }

  clear() { this._seen.clear(); }
}

module.exports = { DedupFilter, hashMessage, DEFAULT_WINDOW_MS, DEFAULT_MAX_SIZE };
