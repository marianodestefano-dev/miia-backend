'use strict';

/**
 * AUDIT TRAIL — T55 (Vi 2026-04-30)
 *
 * Standalone module para registrar acciones criticas con append-only log.
 * Diseñado para auditoría ISO 27001 + complemento de log_sanitizer (T43).
 *
 * Categorías de eventos (extensibles):
 *   - tenant.link / tenant.unlink
 *   - config.change (cualquier campo del owner)
 *   - manual.intervention (admin/owner override flow)
 *   - security.event (login, password reset, key rotation)
 *   - data.export / data.delete (privacy actions)
 *
 * Diseño:
 *   - In-memory rolling buffer (default 1000 eventos) + opcional persist callback
 *     a Firestore o disk (inyectable por caller).
 *   - Hash chain SHA-256: cada evento referencia el hash del previo (audit
 *     integrity — detecta tampering si alguien borra/modifica eventos).
 *   - Sin PII en log (callers deben sanitizar antes de invocar).
 *   - getEventsByCategory / getEventsForActor / getEventsInRange.
 *
 * Standard: Google + Amazon + NASA — fail loudly, observable, append-only.
 * Wire-in a server.js endpoints requiere firma Mariano (T-future).
 */

const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const DEFAULT_BUFFER_SIZE = 1000;
const VALID_CATEGORIES = new Set([
  'tenant.link',
  'tenant.unlink',
  'config.change',
  'manual.intervention',
  'security.event',
  'data.export',
  'data.delete',
]);

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

let _buffer = [];
let _bufferSize = DEFAULT_BUFFER_SIZE;
let _lastHash = '0'.repeat(64); // genesis hash
let _persistCallback = null; // opcional: async (event) => Promise<void>

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Compute SHA-256 hash of canonical JSON event data + previous hash.
 */
function _computeHash(eventCanonical, prevHash) {
  return crypto
    .createHash('sha256')
    .update(prevHash + '|' + eventCanonical)
    .digest('hex');
}

/**
 * Canonicalize event for hashing (sorted keys, no whitespace).
 */
function _canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(_canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalize(obj[k])).join(',') + '}';
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — record
// ═══════════════════════════════════════════════════════════════

/**
 * Registrar un evento de audit trail.
 * @param {string} category - una de VALID_CATEGORIES
 * @param {object} data - payload (cero PII; callers sanitizan)
 * @param {object} [meta]
 * @param {string} [meta.actor] - quien ejecuto (uid masked or service account)
 * @param {string} [meta.uid]   - tenant uid afectado
 * @returns {object} evento registrado con hash + ts
 * @throws si category invalida o data null
 */
function record(category, data, meta = {}) {
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(`audit_trail: categoria invalida "${category}". Validas: ${[...VALID_CATEGORIES].join(', ')}`);
  }
  if (data === null || typeof data !== 'object') {
    throw new Error('audit_trail: data debe ser objeto no-null');
  }

  const ts = new Date().toISOString();
  const event = {
    ts,
    category,
    actor: meta.actor || 'unknown',
    uid: meta.uid || null,
    data,
    prev_hash: _lastHash,
  };

  const canonical = _canonicalize(event);
  const hash = _computeHash(canonical, _lastHash);
  event.hash = hash;
  _lastHash = hash;

  _buffer.push(event);
  // Rolling buffer
  if (_buffer.length > _bufferSize) {
    _buffer.shift();
  }

  // Best-effort persist (no bloquea si callback rechaza)
  if (_persistCallback) {
    Promise.resolve()
      .then(() => _persistCallback(event))
      .catch(err => {
        console.error('[AUDIT-TRAIL] persist callback error:', err.message);
      });
  }

  return event;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — query
// ═══════════════════════════════════════════════════════════════

/**
 * Retornar todos los eventos en buffer (copia).
 */
function getAll() {
  return _buffer.slice();
}

/**
 * Filtrar por categoria.
 */
function getEventsByCategory(category) {
  return _buffer.filter(e => e.category === category);
}

/**
 * Filtrar por actor (uid o service account name).
 */
function getEventsForActor(actor) {
  return _buffer.filter(e => e.actor === actor);
}

/**
 * Filtrar por rango de timestamps ISO (inclusive).
 */
function getEventsInRange(fromIso, toIso) {
  return _buffer.filter(e => e.ts >= fromIso && e.ts <= toIso);
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — integrity
// ═══════════════════════════════════════════════════════════════

/**
 * Verifica la cadena de hashes del buffer entero.
 * @returns {{ valid: boolean, brokenAt: number|null, total: number }}
 */
function verifyChain() {
  let prev = '0'.repeat(64);
  for (let i = 0; i < _buffer.length; i++) {
    const e = _buffer[i];
    const expectedPrev = prev;
    if (e.prev_hash !== expectedPrev) {
      return { valid: false, brokenAt: i, total: _buffer.length };
    }
    // Recompute hash of event without its own .hash field
    const { hash, ...rest } = e;
    const recomputed = _computeHash(_canonicalize(rest), expectedPrev);
    if (recomputed !== hash) {
      return { valid: false, brokenAt: i, total: _buffer.length };
    }
    prev = hash;
  }
  return { valid: true, brokenAt: null, total: _buffer.length };
}

// ═══════════════════════════════════════════════════════════════
// CONFIG / RESET
// ═══════════════════════════════════════════════════════════════

function setBufferSize(n) {
  if (typeof n !== 'number' || n < 1) throw new Error('bufferSize debe ser >= 1');
  _bufferSize = n;
  while (_buffer.length > _bufferSize) _buffer.shift();
}

function setPersistCallback(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new Error('persistCallback debe ser function o null');
  }
  _persistCallback = fn;
}

function getStats() {
  return {
    bufferSize: _bufferSize,
    eventsInBuffer: _buffer.length,
    lastHashPrefix: _lastHash.slice(0, 12) + '...',
    hasPersistCallback: !!_persistCallback,
  };
}

/**
 * Reset state (para tests).
 */
function _resetForTests() {
  _buffer = [];
  _lastHash = '0'.repeat(64);
  _bufferSize = DEFAULT_BUFFER_SIZE;
  _persistCallback = null;
}

module.exports = {
  record,
  getAll,
  getEventsByCategory,
  getEventsForActor,
  getEventsInRange,
  verifyChain,
  setBufferSize,
  setPersistCallback,
  getStats,
  VALID_CATEGORIES,
  // Test-only
  _resetForTests,
};
