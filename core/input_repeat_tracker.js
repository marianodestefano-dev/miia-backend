'use strict';

/**
 * MIIA — Input Repeat Tracker (T97)
 * Detecta repeticion de inputs de contactos para anti-loop mejorado.
 * - inputRepeatCount[phone]++ por cada input similar (Jaccard >= 0.95) en window
 * - Si >= MAX_REPEATS en window → auto-pause via loopWatcher
 * - Logging explícito de cada repeat y cada pausa
 */

const { similarityRatio } = require('./similarity');

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const MAX_REPEATS = 3;
const SIMILARITY_THRESHOLD = 0.95;

class InputRepeatTracker {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxRepeats = MAX_REPEATS, threshold = SIMILARITY_THRESHOLD } = {}) {
    this.windowMs = windowMs;
    this.maxRepeats = maxRepeats;
    this.threshold = threshold;
    // phone -> { lastText, lastTs, repeatCount, pausedAt }
    this._state = {};
  }

  /**
   * Registra un nuevo input. Retorna { isRepeat, repeatCount, shouldPause }.
   * @param {string} phone
   * @param {string} text
   * @param {number} [nowMs]
   * @returns {{ isRepeat: boolean, repeatCount: number, shouldPause: boolean }}
   */
  record(phone, text, nowMs = Date.now()) {
    if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
    if (!text || typeof text !== 'string') {
      return { isRepeat: false, repeatCount: 0, shouldPause: false };
    }

    if (!this._state[phone]) {
      this._state[phone] = { lastText: text, lastTs: nowMs, repeatCount: 0, pausedAt: null };
      console.log(`[ANTI-LOOP-V2] phone=${phone} primer mensaje registrado`);
      return { isRepeat: false, repeatCount: 0, shouldPause: false };
    }

    const entry = this._state[phone];

    // Si está pausado, siempre reportar shouldPause=true hasta que se limpie
    if (entry.pausedAt !== null) {
      console.log(`[ANTI-LOOP-V2] phone=${phone} en pausa desde ${new Date(entry.pausedAt).toISOString()}`);
      return { isRepeat: true, repeatCount: entry.repeatCount, shouldPause: true };
    }

    // Limpiar si venció la ventana
    const elapsed = nowMs - entry.lastTs;
    if (elapsed >= this.windowMs) {
      console.log(`[ANTI-LOOP-V2] phone=${phone} ventana vencida (${Math.round(elapsed/1000)}s), reset`);
      this._state[phone] = { lastText: text, lastTs: nowMs, repeatCount: 0, pausedAt: null };
      return { isRepeat: false, repeatCount: 0, shouldPause: false };
    }

    const ratio = similarityRatio(text, entry.lastText);
    const isRepeat = ratio >= this.threshold;

    if (isRepeat) {
      entry.repeatCount++;
      entry.lastTs = nowMs;
      console.log(`[ANTI-LOOP-V2] REPEAT phone=${phone} ratio=${ratio.toFixed(3)} count=${entry.repeatCount}/${this.maxRepeats}`);
      const shouldPause = entry.repeatCount >= this.maxRepeats;
      if (shouldPause) {
        entry.pausedAt = nowMs;
        console.warn(`[ANTI-LOOP-V2] AUTO-PAUSE phone=${phone} despues de ${entry.repeatCount} repeticiones en ventana`);
      }
      return { isRepeat: true, repeatCount: entry.repeatCount, shouldPause };
    } else {
      // Input diferente — reset
      this._state[phone] = { lastText: text, lastTs: nowMs, repeatCount: 0, pausedAt: null };
      return { isRepeat: false, repeatCount: 0, shouldPause: false };
    }
  }

  /**
   * Despausa un phone (llamado cuando owner dice "MIIA retoma con +XXXX").
   */
  unpause(phone) {
    if (!phone) throw new Error('phone requerido');
    if (this._state[phone]) {
      console.log(`[ANTI-LOOP-V2] UNPAUSE phone=${phone}`);
      this._state[phone].pausedAt = null;
      this._state[phone].repeatCount = 0;
    }
  }

  /**
   * Retorna estado actual para un phone.
   */
  getState(phone) {
    return this._state[phone] || null;
  }

  /**
   * Limpia el estado de un phone.
   */
  clear(phone) {
    delete this._state[phone];
  }
}

module.exports = { InputRepeatTracker, DEFAULT_WINDOW_MS, MAX_REPEATS, SIMILARITY_THRESHOLD };
