'use strict';

/**
 * MIIA - Log Sanitizer (T226)
 * C.4 ROADMAP: sanitiza logs Railway. Telefonos 4 ultimos digitos, mensajes truncados.
 * Flag MIIA_DEBUG_VERBOSE=1 para debug local.
 */

const PHONE_REGEX = /(\+?[0-9]{1,3}[\s\-]?)?(\(?\d{1,4}\)?[\s\-]?){2,5}\d{4}/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const TOKEN_REGEX = /(?:Bearer\s+|token[=:\s]+|key[=:\s]+|password[=:\s]+|pwd[=:\s]+|secret[=:\s]+)([A-Za-z0-9\-_./+]{8,})/gi;
const CARD_REGEX = /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g;

const DEFAULT_MAX_MESSAGE_LENGTH = 200;
const PHONE_MASK_KEEP = 4;
const VERBOSE_ENV_KEY = 'MIIA_DEBUG_VERBOSE';

function isVerboseMode() {
  return process.env[VERBOSE_ENV_KEY] === '1';
}

function maskPhone(phone) {
  if (!phone) return phone;
  var s = String(phone).replace(/[\s\-().]/g, '');
  if (s.length <= PHONE_MASK_KEEP) return '****';
  return '****' + s.slice(-PHONE_MASK_KEEP);
}

function maskEmail(email) {
  if (!email) return email;
  var parts = email.split('@');
  if (parts.length !== 2) return '****@****.***';
  var local = parts[0].length > 2 ? parts[0].slice(0, 2) + '***' : '***';
  return local + '@' + parts[1];
}

function truncateMessage(text, maxLen) {
  if (!text) return text;
  var max = maxLen || DEFAULT_MAX_MESSAGE_LENGTH;
  var s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + '...[truncado ' + (s.length - max) + ' chars]';
}

function sanitizePhones(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(PHONE_REGEX, function(match) {
    var digits = match.replace(/\D/g, '');
    if (digits.length < 6) return match;
    return '****' + digits.slice(-PHONE_MASK_KEEP);
  });
}

function sanitizeEmails(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(EMAIL_REGEX, maskEmail);
}

function sanitizeTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(TOKEN_REGEX, function(match, token) {
    return match.replace(token, token.slice(0, 4) + '****');
  });
}

function sanitizeCards(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(CARD_REGEX, '****-****-****-****');
}

function sanitizeText(text, opts) {
  if (!text) return text;
  if (isVerboseMode()) return text;
  var s = String(text);
  s = sanitizePhones(s);
  s = sanitizeEmails(s);
  s = sanitizeTokens(s);
  s = sanitizeCards(s);
  if (!opts || opts.truncate !== false) {
    s = truncateMessage(s, opts && opts.maxLen);
  }
  return s;
}

function sanitizeObject(obj, opts) {
  if (!obj || typeof obj !== 'object') return obj;
  if (isVerboseMode()) return obj;
  var SENSITIVE_KEYS = ['phone', 'email', 'token', 'password', 'secret', 'key', 'card', 'message', 'text', 'body'];
  var result = Array.isArray(obj) ? [] : {};
  for (var k in obj) {
    var val = obj[k];
    if (val === null || val === undefined) {
      result[k] = val;
    } else if (typeof val === 'object') {
      result[k] = sanitizeObject(val, opts);
    } else if (typeof val === 'string') {
      var keyLower = k.toLowerCase();
      var isSensitive = SENSITIVE_KEYS.some(function(sk) { return keyLower.includes(sk); });
      result[k] = isSensitive ? sanitizeText(val, opts) : val;
    } else {
      result[k] = val;
    }
  }
  return result;
}

function createSafeLogger(prefix) {
  var pfx = prefix ? '[' + prefix + '] ' : '';
  return {
    log: function(msg, data) {
      var safe = sanitizeText(String(msg));
      if (data !== undefined) {
        var safeData = sanitizeObject(data);
        console.log(pfx + safe, safeData);
      } else {
        console.log(pfx + safe);
      }
    },
    warn: function(msg, data) {
      var safe = sanitizeText(String(msg));
      if (data !== undefined) {
        console.warn(pfx + safe, sanitizeObject(data));
      } else {
        console.warn(pfx + safe);
      }
    },
    error: function(msg, data) {
      var safe = sanitizeText(String(msg));
      if (data !== undefined) {
        console.error(pfx + safe, sanitizeObject(data));
      } else {
        console.error(pfx + safe);
      }
    },
  };
}

// installConsoleOverride — global console patch para sanitizar logs en produccion.
// No-op si NODE_ENV != production o MIIA_DEBUG_VERBOSE === 'true'.
// Llamada una sola vez en server.js al arrancar. Idempotente.
let _consoleOverrideInstalled = false;
function installConsoleOverride() {
  if (_consoleOverrideInstalled) return;
  if (process.env.NODE_ENV !== 'production' || process.env.MIIA_DEBUG_VERBOSE === 'true') {
    _consoleOverrideInstalled = true;
    return;
  }
  const _origLog   = console.log.bind(console);
  const _origError = console.error.bind(console);
  const _origWarn  = console.warn.bind(console);
  const _origInfo  = console.info.bind(console);
  const _sanitize  = (a) => typeof a === 'string' ? sanitizeText(a) : a;
  console.log   = (...args) => _origLog(...args.map(_sanitize));
  console.error = (...args) => _origError(...args.map(_sanitize));
  console.warn  = (...args) => _origWarn(...args.map(_sanitize));
  console.info  = (...args) => _origInfo(...args.map(_sanitize));
  _consoleOverrideInstalled = true;
}


module.exports = {
  maskPhone,
  maskEmail,
  truncateMessage,
  sanitizePhones,
  sanitizeEmails,
  sanitizeTokens,
  sanitizeCards,
  sanitizeText,
  sanitizeObject,
  createSafeLogger,
  isVerboseMode,
  PHONE_MASK_KEEP,
  DEFAULT_MAX_MESSAGE_LENGTH,
  VERBOSE_ENV_KEY,
  installConsoleOverride,
};
