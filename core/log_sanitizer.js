'use strict';

/**
 * MIIA — Log Sanitizer (Cimientos C.4 ROADMAP + C-403 + C-464 T10 + T86)
 *
 * Sanitiza logs antes de que lleguen a Railway / stdout.
 *
 * API:
 *   sanitize(text, opts)         -> texto sanitizado (phones+emails+tokens+hash msg)
 *   sanitizePhone(text)          -> SOLO sanitiza phones (E.164, WA JID, standalone digits)
 *   sanitizeMessage(msg, maxLen) -> alias sanitize + truncate (Wi EXTRA #1 spec)
 *   sanitizeLog(obj)             -> alias sanitizeObject (Wi EXTRA #1 spec)
 *   shouldVerboseLog()           -> true si MIIA_DEBUG_VERBOSE=true (Wi EXTRA #1 spec)
 *   isActive()                   -> true si NODE_ENV=production && !verbose
 *   maskUid(uid)                 -> primeros 8 chars + ... (UIDs Firebase)
 *   maskPhone(phone)             -> alias singular (legacy compat)
 *   maskEmail(email)             -> mascara local + dominio sanitizado
 *   installConsoleOverride()     -> monkey-patch console.log/warn/error/info
 *   restoreConsoleOriginal()     -> restaura console original
 *   slog(label, ...args)         -> log con label sanitizado
 *   slog.msgContent(label, text) -> hashea text SIEMPRE (Opción C híbrida Mariano 2026-04-24)
 *
 * Guards:
 *   - NODE_ENV != 'production' -> sanitize() es NO-OP (dev local seguro)
 *   - MIIA_DEBUG_VERBOSE='true' -> sanitize() es NO-OP (debug puntual)
 */

const crypto = require('crypto');

const PHONE_MASK_KEEP = 4;
const UID_MASK_KEEP = 8;
const DEFAULT_MAX_MESSAGE_LENGTH = 200;
const VERBOSE_ENV_KEY = 'MIIA_DEBUG_VERBOSE';

// Detectores
const PHONE_E164_REGEX = /\+(\d{1,3})\d{6,11}/g; // +XX...
const PHONE_WA_JID_REGEX = /(\d{10,15})(?::\d+)?@s\.whatsapp\.net/g;
const PHONE_STANDALONE_REGEX = /\b\d{10,15}\b/g;
const EMAIL_REGEX = /(?<![*])[a-zA-Z0-9._%+\-]+@(?!s\.whatsapp\.net)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9\-_.+/=]+/gi;
const TOKEN_ASSIGN_REGEX = /\b(api_key|token|password|pwd|secret|key)\s*(=|:\s*)([A-Za-z0-9\-_.+/=]{4,})/gi;
const HEX_LONG_REGEX = /\b[a-f0-9]{32,}\b/gi;

// Conversational message detection: heuristica simple, hashea contenido
// para evitar leak de chats.
const CONVERSATIONAL_HASH_LEN = 8;

// ── Guards ────────────────────────────────────────────────────────────────────
function shouldVerboseLog() {
  return process.env[VERBOSE_ENV_KEY] === 'true' || process.env[VERBOSE_ENV_KEY] === '1';
}

function isActive() {
  if (shouldVerboseLog()) return false;
  return process.env.NODE_ENV === 'production';
}

// ── Helpers internos ──────────────────────────────────────────────────────────
function _hashMsg(text) {
  return '[msg:' + crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, CONVERSATIONAL_HASH_LEN) + ']';
}

function _maskPhoneFromDigits(digits) {
  return '***' + digits.slice(-PHONE_MASK_KEEP);
}

// ── Mascaras simples ──────────────────────────────────────────────────────────
function maskPhone(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 0) return '****';
  return _maskPhoneFromDigits(digits);
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const parts = email.split('@');
  if (parts.length !== 2) return '****@****.***';
  const local = parts[0].length > 0 ? parts[0][0] + '***' : '***';
  const domainParts = parts[1].split('.');
  const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : '***';
  return local + '@***.' + tld;
}

function maskUid(uid) {
  if (typeof uid !== 'string') return uid;
  if (uid.length === 0) return uid;
  if (!isActive()) return uid;
  if (uid.length <= UID_MASK_KEEP) return uid;
  return uid.slice(0, UID_MASK_KEEP) + '...';
}

// ── sanitizePhone (T10/T86 — sanitiza phones en string completo) ─────────────
function sanitizePhone(text) {
  if (!isActive()) return text;
  if (typeof text !== 'string') return text;
  let s = text;
  // 1. WA JID con/sin device suffix
  s = s.replace(PHONE_WA_JID_REGEX, function (_, digits) {
    return '***' + digits.slice(-PHONE_MASK_KEEP) + '@s.whatsapp.net';
  });
  // 2. E.164 (+XX...)
  s = s.replace(PHONE_E164_REGEX, function (match) {
    const cc = match.slice(0, 3); // +XX
    const last4 = match.slice(-PHONE_MASK_KEEP);
    return cc + '***' + last4;
  });
  // 3. Standalone digits 10-15 (no precedido por @ ni : ni +)
  s = s.replace(PHONE_STANDALONE_REGEX, function (match, offset, str) {
    // Ya fue sanitizado si el carácter previo no es dígito ni +
    const prev = offset > 0 ? str[offset - 1] : '';
    /* istanbul ignore next */
    if (prev === '+') return match; // ya manejado por E.164 (defensive)
    /* istanbul ignore next */
    if (prev === ':') return match; // suffix WA (defensive)
    return '***' + match.slice(-PHONE_MASK_KEEP);
  });
  return s;
}

// ── sanitize (función unificada) ──────────────────────────────────────────────
/**
 * Sanitiza un texto: phones + emails + tokens + cards + hashea contenido
 * conversacional si NO contiene PII ya sanitizada.
 *
 * @param {string} text
 * @param {object} [opts] - { skipMessageHash } para casos especiales (slog principal)
 * @returns {string}
 */
function sanitize(text, opts) {
  if (!isActive()) return text;
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') return text;

  let s = text;
  let hasPII = false;

  // 1. Phones (E.164 + WA JID + standalone)
  const beforePhones = s;
  s = sanitizePhone(s);
  if (s !== beforePhones) hasPII = true;

  // 2. Tokens primero (Bearer + assignments) — antes de email para no matchear tokens como email
  const beforeTokens = s;
  s = s.replace(BEARER_REGEX, 'Bearer [token:REDACTED]');
  s = s.replace(TOKEN_ASSIGN_REGEX, function (match, key, _eq, value) {
    if (/REDACTED/.test(value)) return match;
    return key + '=[token:REDACTED]';
  });
  s = s.replace(HEX_LONG_REGEX, '[token:REDACTED]');
  if (s !== beforeTokens) hasPII = true;

  // 3. Emails — el regex ya excluye matches precedidos por *** y dominio @s.whatsapp.net
  const beforeEmails = s;
  s = s.replace(EMAIL_REGEX, function (match) {
    /* istanbul ignore next */
    if (match.indexOf('***') >= 0) return match;
    return maskEmail(match);
  });
  if (s !== beforeEmails) hasPII = true;

  // 4. Si el texto original NO tenía PII sanitizada Y parece mensaje conversacional,
  //    hashearlo entero. Heuristica: tiene espacios y no es log tecnico ni vacio.
  if (!hasPII && !(opts && opts.skipMessageHash) && _looksLikeConversational(s)) {
    return _hashMsg(s);
  }

  return s;
}

function _looksLikeConversational(text) {
  if (!text || text.length < 3) return false;
  // Texto ya pre-sanitizado (contiene marcadores ***) → no re-hashear
  if (text.indexOf('***') >= 0) return false;
  // Log tecnico: comienza con [TAG]
  if (/^\[[A-Z0-9_\-]+\]/.test(text)) return false;
  // HTTP / verbs técnicos
  if (/^(HTTP|GET|POST|PUT|DELETE|PATCH|OPTIONS)\b/.test(text)) return false;
  // Heurística positiva: contiene saludo / vocativo / pregunta típica de mensaje humano
  const conversationalSignals = /\b(hola|hey|chao|adi[oó]s|buenos|gracias|mama|mamá|papa|papá|amor|querido|che|dale|posta|c[oó]mo est[aá]s|qu[eé] tal|c[oó]mo|cu[aá]ndo|d[oó]nde|por qu[eé]|quiero|necesito|me gustar[ií]a|por favor)\b/i;
  return conversationalSignals.test(text);
}

// ── sanitizeMessage / sanitizeLog / sanitizeObject (Wi EXTRA #1 aliases) ──────
function sanitizeMessage(msg, maxLen) {
  if (!isActive()) return msg;
  if (typeof msg !== 'string') return msg;
  const max = typeof maxLen === 'number' && maxLen > 0 ? maxLen : DEFAULT_MAX_MESSAGE_LENGTH;
  const sanitized = sanitize(msg);
  if (sanitized.length <= max) return sanitized;
  return sanitized.slice(0, max) + '...[truncado ' + (sanitized.length - max) + ' chars]';
}

function sanitizeObject(obj) {
  if (!isActive()) return obj;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [] : {};
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const val = obj[k];
    if (val === null || val === undefined) {
      result[k] = val;
    } else if (typeof val === 'object') {
      result[k] = sanitizeObject(val);
    } else if (typeof val === 'string') {
      result[k] = sanitize(val);
    } else {
      result[k] = val;
    }
  }
  return result;
}

// Alias Wi spec
const sanitizeLog = sanitizeObject;

// ── installConsoleOverride / restoreConsoleOriginal ───────────────────────────
let _consoleOverrideInstalled = false;
let _origLog = null;
let _origError = null;
let _origWarn = null;
let _origInfo = null;

function installConsoleOverride() {
  if (_consoleOverrideInstalled) return;
  if (!isActive()) {
    _consoleOverrideInstalled = true;
    return;
  }
  _origLog = console.log.bind(console);
  _origError = console.error.bind(console);
  _origWarn = console.warn.bind(console);
  _origInfo = console.info.bind(console);
  const _sanitizeArg = function (a) { return typeof a === 'string' ? sanitize(a) : a; };
  console.log = function () { _origLog.apply(null, Array.prototype.map.call(arguments, _sanitizeArg)); };
  console.error = function () { _origError.apply(null, Array.prototype.map.call(arguments, _sanitizeArg)); };
  console.warn = function () { _origWarn.apply(null, Array.prototype.map.call(arguments, _sanitizeArg)); };
  console.info = function () { _origInfo.apply(null, Array.prototype.map.call(arguments, _sanitizeArg)); };
  _consoleOverrideInstalled = true;
}

function restoreConsoleOriginal() {
  if (!_consoleOverrideInstalled) return;
  if (_origLog) console.log = _origLog;
  if (_origError) console.error = _origError;
  if (_origWarn) console.warn = _origWarn;
  if (_origInfo) console.info = _origInfo;
  _origLog = _origError = _origWarn = _origInfo = null;
  _consoleOverrideInstalled = false;
}

// ── slog / slog.msgContent ────────────────────────────────────────────────────
function slog(label) {
  const args = Array.prototype.slice.call(arguments, 1);
  const safeLabel = sanitize(String(label), { skipMessageHash: true });
  const safeArgs = args.map(function (a) { return typeof a === 'string' ? sanitize(a) : a; });
  console.log.apply(null, [safeLabel].concat(safeArgs));
}

slog.msgContent = function (label, text) {
  const extras = Array.prototype.slice.call(arguments, 2);
  const safeLabel = sanitize(String(label), { skipMessageHash: true });
  // Si verbose => text pasa tal cual
  if (!isActive()) {
    const safeExtrasV = extras.map(function (a) { return typeof a === 'string' ? sanitize(a) : a; });
    console.log.apply(null, [safeLabel, text].concat(safeExtrasV));
    return;
  }
  // Producción: text SIEMPRE hasheado
  const hashed = _hashMsg(text);
  const safeExtras = extras.map(function (a) { return typeof a === 'string' ? sanitize(a) : a; });
  console.log.apply(null, [safeLabel, hashed].concat(safeExtras));
};

// ── createSafeLogger (legacy compat) ──────────────────────────────────────────
function createSafeLogger(prefix) {
  const pfx = prefix ? '[' + prefix + '] ' : '';
  return {
    log: function (msg, data) {
      const safe = sanitize(String(msg));
      if (data !== undefined) console.log(pfx + safe, sanitizeObject(data));
      else console.log(pfx + safe);
    },
    warn: function (msg, data) {
      const safe = sanitize(String(msg));
      if (data !== undefined) console.warn(pfx + safe, sanitizeObject(data));
      else console.warn(pfx + safe);
    },
    error: function (msg, data) {
      const safe = sanitize(String(msg));
      if (data !== undefined) console.error(pfx + safe, sanitizeObject(data));
      else console.error(pfx + safe);
    },
  };
}

// ── isVerboseMode (legacy compat con tests viejos) ────────────────────────────
function isVerboseMode() {
  return shouldVerboseLog();
}

module.exports = {
  // Wi EXTRA #1 spec
  sanitizePhone,
  sanitizeMessage,
  sanitizeLog,
  shouldVerboseLog,
  // C-403 / C-464 API
  sanitize,
  isActive,
  maskUid,
  maskPhone,
  maskEmail,
  installConsoleOverride,
  restoreConsoleOriginal,
  slog,
  // Legacy compat
  sanitizeObject,
  createSafeLogger,
  isVerboseMode,
  truncateMessage: sanitizeMessage,
  // Constants
  PHONE_MASK_KEEP,
  UID_MASK_KEEP,
  DEFAULT_MAX_MESSAGE_LENGTH,
  VERBOSE_ENV_KEY,
};
