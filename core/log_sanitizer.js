'use strict';

/**
 * MIIA Log Sanitizer — C-403 Cimientos §3 C.4
 *
 * Spec: DOC_PRIVACY_LEGAL_ENCRIPCION.md §E.3.bis.2 (firmada AJUSTE 2 C-368 SEC-I).
 * Refuerza lección L1 de C-400 (screenshots de secrets expuestos).
 *
 * PII target (producción):
 *   - Teléfonos E.164 `+573054169969` → `+57***9969` (últimos 4)
 *   - Emails `mariano@gmail.com` → `m***@***.com`
 *   - Tokens (Bearer, api_key, hex ≥32) → `[token:REDACTED]`
 *   - Mensajes conversacionales → `[msg:<sha256 8 chars>]`
 *   - Nombres: v1 SKIP (requiere lookup Firestore en hot path → v2).
 *
 * Activo solo si `NODE_ENV === 'production'` Y `MIIA_DEBUG_VERBOSE !== 'true'`.
 * Dev local o MIIA_DEBUG_VERBOSE explícito → no-op.
 *
 * ═══ POLICY (firmada Mariano 2026-04-24 — Opción C híbrida) ═══
 *
 * El override global de console.log/warn/error/info sanitiza PII FUERTE
 * (phone/email/token) + hashea mensaje SOLO cuando el string es puro
 * conversacional con marcadores (sin PII ya sanitizada). Cubre los 5.986
 * call sites existentes sin migración, preservando observabilidad de logs
 * estructurales tipo "lead +57***9969 dijo cotización para 5 usuarios"
 * donde el phone queda visible sanitizado y el contenido post-phone
 * (sin vocativos) no se hashea.
 *
 * Para GARANTÍA COMPLETA de hash en hot paths (ej: TMH receive, inbound
 * message logging), usar `slog.msgContent(label, text, ...extra)` que
 * hashea `text` SIEMPRE que el sanitizer esté activo, independiente del
 * contenido. Módulos nuevos o migrables DEBEN usar esa API para claridad
 * semántica.
 *
 * Migración de call sites críticos NO es parte de C-403 — queda para
 * carta futura cuando se decidan prioridades.
 *
 * Standard: Google + Amazon + Apple + NASA — fail loudly, observable.
 */

const crypto = require('crypto');

// ═══ GUARDS ═══
function isSanitizerActive() {
  if (process.env.MIIA_DEBUG_VERBOSE === 'true') return false;
  if (process.env.NODE_ENV !== 'production') return false;
  return true;
}

function isActive() {
  return isSanitizerActive();
}

// ═══ HELPERS ═══

/**
 * Sanitiza teléfonos E.164 `+<código><dígitos>`.
 * Preserva primeros 3 chars (+ código 2 dígitos) + *** + últimos 4.
 * Ejemplo: `+573054169969` → `+57***9969`.
 * Edge US/CA (+1): `+12025551234` → `+12***1234` (acepta v1 para simplicidad;
 * v2 puede refinar con tabla de códigos país).
 */
function sanitizePhone(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\+\d{7,15}(?!\d)/g, (match) => {
    const last4 = match.slice(-4);
    const prefix = match.slice(0, 3); // "+" + 2 dígitos
    return `${prefix}***${last4}`;
  });
}

/**
 * Sanitiza emails. `mariano@gmail.com` → `m***@***.com`.
 * Preserva solo primera letra del local-part + TLD.
 */
function sanitizeEmail(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/([a-zA-Z0-9._+-])[a-zA-Z0-9._+-]*@[a-zA-Z0-9.-]+\.([a-zA-Z]{2,})/g,
    (_match, firstChar, tld) => `${firstChar}***@***.${tld}`);
}

/**
 * Sanitiza tokens. Detecta:
 *  - `Bearer <token>` → `Bearer [token:REDACTED]`
 *  - `api_key=<valor>` o `apiKey: <valor>` → redactado
 *  - Strings hex largos (≥32 chars hex consecutivos) → `[token:REDACTED]`
 */
function sanitizeToken(str) {
  if (typeof str !== 'string') return str;
  let out = str;

  // Bearer tokens
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/g, '$1[token:REDACTED]');

  // api_key / apiKey assignments (separadores =, :, espacio)
  out = out.replace(/(api[_-]?key)[\s:=]+["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
    '$1=[token:REDACTED]');

  // Hex strings ≥32 chars (common for SHA256, UUIDs expandidos, keys)
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '[token:REDACTED]');

  return out;
}

/**
 * Detecta si un string parece mensaje conversacional (saludos, vocativos,
 * pregunta típica). Heurística conservadora para evitar falsos positivos
 * en logs técnicos.
 */
const CONVERSATIONAL_MARKERS = /(^|[\s,.;:¡¿!?"'()[\]])(hola|holi|holis|hey|buen[oa]s|dia|tardes|noche|chau|besos?|abrazo|ma+m[aá]|ma+mi|pa+p[aá]|pa+pi|hermana|hermano|amig[oa]|ti[oa]|dale|gracias|plis|porfa|co?mo|que?|est[aá]s?|vos|usted|señ[oa]r[a]?|doctor|doctora|dra|querid[oa]|amor|cari[ñn]o|bell[oa])([\s,.;:¡¿!?"'()[\]]|$)/i;

function looksLikeMessage(str) {
  if (typeof str !== 'string') return false;
  if (str.length < 6) return false; // "Hola" solo no alcanza
  const words = str.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return false;
  return CONVERSATIONAL_MARKERS.test(str);
}

function hashMessage(str) {
  const hex = crypto.createHash('sha256').update(str, 'utf8').digest('hex');
  return `[msg:${hex.slice(0, 8)}]`;
}

/**
 * Sanitiza contenido de mensaje si el string parece conversacional.
 * No toca logs técnicos sin marcadores.
 *
 * Guard: si el string YA FUE sanitizado parcialmente (contiene `***`,
 * `[token:REDACTED]` o `[msg:XXXX]`), preservarlo intacto. Hashear completo
 * destruiría la info sanitizada previa (phone/email visibles con prefijo)
 * que queremos conservar para observabilidad de logs estructurales.
 * El hash de mensaje completo se reserva para strings conversacionales
 * "puros" (ej: `console.log(msg.text)` standalone).
 */
function sanitizeMessage(str) {
  if (typeof str !== 'string') return str;
  if (str.includes('***') || str.includes('[token:') || str.includes('[msg:')) {
    return str;
  }
  if (!looksLikeMessage(str)) return str;
  return hashMessage(str);
}

/**
 * Sanitiza nombres. v1 SKIP — requiere lookup Firestore en hot path
 * (familyContacts/teamContacts/contact_index). Placeholder para v2.
 */
function sanitizeName(str) {
  return str;
}

// ═══ ENTRY PRINCIPAL ═══

/**
 * Aplica todas las reglas de sanitización en orden: tokens → emails →
 * phones → names (skip) → messages (último porque consume string completo).
 * Guards: NODE_ENV !== production o MIIA_DEBUG_VERBOSE=true → no-op.
 */
function sanitize(value) {
  if (!isSanitizerActive()) return value;
  if (typeof value !== 'string') return value;

  let out = value;
  out = sanitizeToken(out);
  out = sanitizeEmail(out);
  out = sanitizePhone(out);
  out = sanitizeName(out); // no-op v1
  out = sanitizeMessage(out); // último — puede hashear string completo
  return out;
}

// ═══ SLOG WRAPPER ═══

/**
 * Wrapper de logging sanitized equivalente a console.log(label, ...args).
 * Cada arg string se pasa por sanitize() antes de loguear.
 */
function slog(label, ...args) {
  const sanitizedLabel = typeof label === 'string' ? sanitize(label) : label;
  const sanitizedArgs = args.map((a) => (typeof a === 'string' ? sanitize(a) : a));
  // Usar el console ORIGINAL si el override está instalado (para no doble-sanitizar)
  const fn = _originalConsole.log || console.log;
  fn.call(console, sanitizedLabel, ...sanitizedArgs);
}

/**
 * Helper para logging de contenido de mensaje GARANTIZADO hasheado.
 * Firmado Mariano 2026-04-24 Opción C híbrida — cubre hot paths donde
 * el string puede no tener marcadores conversacionales pero igual es
 * contenido privado que debe hashearse (ej: TMH receive de lead silencioso
 * tipo "quiero agendar lunes" que no dispara looksLikeMessage).
 *
 * Comportamiento:
 *   - Sanitizer activo (production + no debug verbose): `text` → [msg:XXXX]
 *     SIEMPRE, sin importar contenido. `label` y `extra` pasan por
 *     sanitize() normal (phone/email/token/etc).
 *   - Sanitizer inactivo (dev local o MIIA_DEBUG_VERBOSE=true): todo pasa
 *     tal cual (label + text + extra).
 *
 * Uso: `slog.msgContent('[MSG IN]', msg.text, { phone, chatType })`.
 */
slog.msgContent = function msgContent(label, text, ...extra) {
  const fn = _originalConsole.log || console.log;
  if (!isSanitizerActive()) {
    // No-op: pasar todo tal cual
    fn.call(console, label, text, ...extra);
    return;
  }
  const sanitizedLabel = typeof label === 'string' ? sanitize(label) : label;
  const hashedText = typeof text === 'string' ? hashMessage(text) : text;
  const sanitizedExtra = extra.map((a) => (typeof a === 'string' ? sanitize(a) : a));
  fn.call(console, sanitizedLabel, hashedText, ...sanitizedExtra);
};

// ═══ OVERRIDE GLOBAL ═══

const _originalConsole = {};
let _overrideInstalled = false;

/**
 * Monkey-patch de console.log/warn/error/info globalmente.
 * Guarda referencias originales para restauración eventual + para slog().
 * Idempotente — múltiples invocaciones no re-instalan.
 */
function installConsoleOverride() {
  if (_overrideInstalled) return;

  const METHODS = ['log', 'warn', 'error', 'info'];
  for (const method of METHODS) {
    _originalConsole[method] = console[method].bind(console);
  }

  for (const method of METHODS) {
    console[method] = function sanitizedConsoleMethod(...args) {
      if (!isSanitizerActive()) {
        // Dev local o debug verbose → pasar tal cual
        return _originalConsole[method](...args);
      }
      const sanitizedArgs = args.map((a) => (typeof a === 'string' ? sanitize(a) : a));
      return _originalConsole[method](...sanitizedArgs);
    };
  }

  _overrideInstalled = true;
}

/**
 * Restaura console.log/warn/error/info originales. Solo para tests.
 */
function restoreConsoleOriginal() {
  if (!_overrideInstalled) return;
  const METHODS = ['log', 'warn', 'error', 'info'];
  for (const method of METHODS) {
    if (_originalConsole[method]) {
      console[method] = _originalConsole[method];
    }
  }
  _overrideInstalled = false;
}

module.exports = {
  sanitize,
  sanitizePhone,
  sanitizeEmail,
  sanitizeToken,
  sanitizeMessage,
  sanitizeName,
  slog,
  installConsoleOverride,
  restoreConsoleOriginal,
  isActive,
  // Exports para tests
  _looksLikeMessage: looksLikeMessage,
};
