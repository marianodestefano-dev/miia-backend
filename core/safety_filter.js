'use strict';

/**
 * MIIA Safety Filter — C-410.b Cimientos §3 C.10 / Mitigación C
 *
 * Pre-filtro auto-skip de información sensible en mensajes entrantes.
 * 5 categorías regex (salud / finanzas / judicial / menores / credenciales)
 * con `action` granular por categoría:
 *   - block      → wire-in skip IA + add a consent_exclusions + alert owner
 *   - log_warn   → marca msg como excluded_from_training + alert owner
 *   - log_only   → registro auditoría sin alert
 *   - disabled   → no evalúa la categoría
 *
 * Doctrina §2-bis (CARTA_C-388 D.1): activa SOLO en MIIA CENTER inicialmente.
 * Migración a Personal/otros owners requiere firma textual Mariano +
 * scope C-410.c (refinamiento regex contactos médicos MediLink legítimos).
 *
 * Throttle anti-spam: 1 alert por (uid, phone, category) en ventana 24h.
 * Después de la primera, los siguientes incidents se persisten pero NO
 * notifican self-chat (evita inundar al owner con alerts repetidos del
 * mismo lead/categoría).
 *
 * Bootstrap idempotente al boot: si MIIA CENTER no tiene config, la setea
 * con DEFAULT_CENTER_CONFIG. Lock `safety_filter_bootstrap_locked=true`
 * permite al owner override manual desde dashboard sin que el deploy
 * lo restablezca.
 *
 * Standard: Google + Amazon + Apple + NASA — fail loudly, observable,
 * zero silent failures.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

const VALID_ACTIONS = ['block', 'log_warn', 'log_only', 'disabled'];

const CATEGORIES = ['salud', 'finanzas', 'judicial', 'menores', 'credenciales'];

const FILTER_VERSION = 'c410.b.v1';

// Bootstrap config para MIIA CENTER (vertical-agnóstico — corrección Mariano
// 2026-04-25, ver memory project_miia_center_vs_medilink.md). Salud=log_warn
// porque CENTER NO es ICP médico — médicos son minoría entre leads CENTER.
const DEFAULT_CENTER_CONFIG = Object.freeze({
  enabled: true,
  categories: {
    salud:        { enabled: true, action: 'log_warn' },
    finanzas:     { enabled: true, action: 'block' },
    judicial:     { enabled: true, action: 'log_warn' },
    menores:      { enabled: true, action: 'block' },
    credenciales: { enabled: true, action: 'block' },
  },
});

// Cache TTLs
const CONFIG_CACHE_TTL_MS = 60 * 1000;             // 60s — config flag
const ALERT_THROTTLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — alert dedup
const CACHE_MAX_ENTRIES = 5000;                    // soft cap memoria

// ════════════════════════════════════════════════════════════════════════════
// REGEX 5 CATEGORÍAS
// ════════════════════════════════════════════════════════════════════════════

// Salud — incluye variantes morfológicas españolas comunes
const REGEX_SALUD = /\b(diagn[óo]stic|tratamient|medicament|medicaci[óo]n|f[áa]rmac|VIH|HIV|c[áa]ncer|tumor|diabetes|hipertensi[óo]n|embarazo|aborto|psiquiatr|psic[óo]l[oa]g[oa]|terapia|depresi[óo]n|ansiedad|trastorn|operaci[óo]n|cirug[íi]a|paciente|s[íi]ntoma|enfermedad|cl[íi]nica|hospital)/i;

// Finanzas — solo dispara con keyword + opcionalmente número Luhn-valid.
// NO standalone por dígitos: IMEIs cumplen Luhn por diseño (check digit Luhn),
// trackings/EAN-13/IDs comunes pueden falsamente cumplir → falso positivo masivo.
const REGEX_FINANZAS_KEYWORDS = /\b(n[úu]mero de tarjeta|CVV|CVC|PIN\s+(banc|tarj)|cuenta bancaria|IBAN|CBU|CCI|CLABE|SWIFT|BIC|contrase[ñn]a.*banc|password.*banc|saldo|deuda)\b/i;
// Pattern conjunto: keyword + número 13-19 dígitos cerca → mayor confianza
const REGEX_FINANZAS_KW_PLUS_DIGITS = /\b(tarjeta|card|cr[ée]dito|d[ée]bito|cuenta|account)\b[^\n]{0,40}?(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|\d{13,19})/i;

// Judicial — general + sub-detección violencia/amenaza para escalar a block
const REGEX_JUDICIAL = /\b(juicio|demanda|querella|denuncia|abogado|fiscal|juez|tribunal|juzgado|polic[íi]a|comisar[íi]a|denuncia.*penal|expediente.*\d)\b/i;
const REGEX_JUDICIAL_VIOLENCE = /\b(violencia|agresi[óo]n|amenaza|asalto|abuso)\b/i;

// Menores — patrón conservador
const REGEX_MENORES = /\b(menor de edad|<\s*18\s*años|mi hij[oa].*\d{1,2}\s*a[ñn]os|colegio|escuela primaria|secundaria.*\b(?:hij[oa]|sobrin|nieto))\b/i;

// Credenciales — passwords / API keys / tokens
const REGEX_CREDENCIALES = /\b(password|contrase[ñn]a|clave|token|api[_\s-]?key|secret)\s*[:=]?\s*[\w.\-/+]{6,}/i;
// Patrones específicos de keys conocidos (AWS, Google, Stripe, GitHub)
const REGEX_CREDS_AWS = /\bAKIA[0-9A-Z]{16}\b/;
const REGEX_CREDS_STRIPE = /\b(sk|pk)_(test|live)_[0-9a-zA-Z]{24,}/;
const REGEX_CREDS_GITHUB = /\bghp_[0-9a-zA-Z]{36,}\b/;
const REGEX_CREDS_GOOGLE = /\bAIza[0-9A-Za-z\-_]{35}\b/;

// ════════════════════════════════════════════════════════════════════════════
// LUHN VALIDATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Valida si una secuencia de dígitos pasa el algoritmo Luhn (mod 10).
 * Usado para distinguir números de tarjeta reales de IDs/IMEIs/EAN-13.
 */
function passesLuhn(digitsStr) {
  if (!digitsStr || typeof digitsStr !== 'string') return false;
  const digits = digitsStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE INFRA — config TTL + alert throttle
// ════════════════════════════════════════════════════════════════════════════

const _configCache = new Map(); // uid → { config, expiresAt }
const _alertThrottle = new Map(); // `${uid}:${phone}:${category}` → expiresAt

function _cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  const expires = typeof entry === 'object' ? entry.expiresAt : entry;
  if (Date.now() > expires) {
    map.delete(key);
    return null;
  }
  return entry;
}

function _cacheSet(map, key, value, ttlMs) {
  if (map.size >= CACHE_MAX_ENTRIES) {
    // Evict oldest entries to keep memory bounded
    const toEvict = Math.floor(CACHE_MAX_ENTRIES * 0.1);
    let i = 0;
    for (const k of map.keys()) {
      if (i++ >= toEvict) break;
      map.delete(k);
    }
  }
  if (typeof value === 'object' && value !== null) {
    value.expiresAt = Date.now() + ttlMs;
    map.set(key, value);
  } else {
    map.set(key, Date.now() + ttlMs);
  }
}

// Exported for testing — permite reset entre tests
function _resetCaches() {
  _configCache.clear();
  _alertThrottle.clear();
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG ACCESS — lee Firestore con cache TTL
// ════════════════════════════════════════════════════════════════════════════

let _db;
function db() {
  if (!_db) _db = admin.firestore();
  return _db;
}

/**
 * Lee config completa para un owner desde Firestore (con cache TTL 60s).
 * Retorna null si el owner no existe o no tiene config.
 */
async function _loadOwnerConfig(uid) {
  const cached = _cacheGet(_configCache, uid);
  if (cached) return cached.config;
  try {
    const snap = await db().collection('users').doc(uid).get();
    if (!snap.exists) {
      _cacheSet(_configCache, uid, { config: null }, CONFIG_CACHE_TTL_MS);
      return null;
    }
    const config = snap.data().safety_filter_config || null;
    _cacheSet(_configCache, uid, { config }, CONFIG_CACHE_TTL_MS);
    return config;
  } catch (e) {
    console.warn(`[SAFETY] _loadOwnerConfig error uid=${uid}: ${e.message}`);
    return null; // fail-safe: si Firestore falla, filtro NO se ejecuta
  }
}

/**
 * @param {string} uid - owner UID
 * @returns {Promise<boolean>} true si el filtro está habilitado a nivel general.
 */
async function isSafetyFilterEnabledForUid(uid) {
  if (!uid || typeof uid !== 'string') return false;
  const config = await _loadOwnerConfig(uid);
  return config?.enabled === true;
}

/**
 * @param {string} uid - owner UID
 * @param {string} category - una de CATEGORIES
 * @returns {Promise<{ enabled: boolean, action: string }>} config para la categoría.
 *   Default si no encontrada: { enabled: false, action: 'disabled' }.
 */
async function getCategoryConfig(uid, category) {
  if (!CATEGORIES.includes(category)) {
    return { enabled: false, action: 'disabled' };
  }
  const config = await _loadOwnerConfig(uid);
  const cat = config?.categories?.[category];
  if (!cat) return { enabled: false, action: 'disabled' };
  return {
    enabled: cat.enabled === true,
    action: VALID_ACTIONS.includes(cat.action) ? cat.action : 'disabled',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CLASSIFY MESSAGE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Aplica las 5 regex en orden de severidad descendente. Retorna el primer
 * match (o null si ninguna matchea). NO consulta Firestore — pure function.
 *
 * @param {string} messageBody - texto del mensaje (o transcripción de audio).
 * @returns {null | { category, regexMatch, severity }}
 */
function classifyMessageSensitivity(messageBody) {
  if (!messageBody || typeof messageBody !== 'string') return null;
  const body = messageBody;

  // Credenciales (severidad ALTA — orden primero porque más específico)
  if (REGEX_CREDS_AWS.test(body) || REGEX_CREDS_STRIPE.test(body) ||
      REGEX_CREDS_GITHUB.test(body) || REGEX_CREDS_GOOGLE.test(body)) {
    return { category: 'credenciales', regexMatch: 'api_key_pattern', severity: 'ALTA' };
  }
  const credsMatch = body.match(REGEX_CREDENCIALES);
  if (credsMatch) {
    return { category: 'credenciales', regexMatch: credsMatch[0].slice(0, 30), severity: 'ALTA' };
  }

  // Finanzas — keywords primero
  const finKwMatch = body.match(REGEX_FINANZAS_KEYWORDS);
  if (finKwMatch) {
    return { category: 'finanzas', regexMatch: finKwMatch[0], severity: 'ALTA' };
  }
  // Keyword tarjeta/cuenta + número Luhn-valid → alta confianza
  const finKwDigitsMatch = body.match(REGEX_FINANZAS_KW_PLUS_DIGITS);
  if (finKwDigitsMatch) {
    const digits = finKwDigitsMatch[2] || '';
    if (passesLuhn(digits)) {
      return { category: 'finanzas', regexMatch: 'card_kw_plus_luhn', severity: 'ALTA' };
    }
  }

  // Menores (severidad ALTA — riesgo legal)
  const menMatch = body.match(REGEX_MENORES);
  if (menMatch) {
    return { category: 'menores', regexMatch: menMatch[0], severity: 'ALTA' };
  }

  // Judicial — violencia primero (escalación)
  if (REGEX_JUDICIAL.test(body)) {
    if (REGEX_JUDICIAL_VIOLENCE.test(body)) {
      return { category: 'judicial', regexMatch: 'violence_subpattern', severity: 'ALTA' };
    }
    const judMatch = body.match(REGEX_JUDICIAL);
    return { category: 'judicial', regexMatch: judMatch[0], severity: 'MEDIA' };
  }

  // Salud (último — más amplio, más prone a falsos positivos)
  const saludMatch = body.match(REGEX_SALUD);
  if (saludMatch) {
    return { category: 'salud', regexMatch: saludMatch[0], severity: 'ALTA' };
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// THROTTLE — 1 alert por (uid, phone, category) en ventana 24h
// ════════════════════════════════════════════════════════════════════════════

/**
 * @returns {boolean} true si el alert DEBE enviarse (primer match en ventana).
 *   false si ya hay alert pendiente para esta combinación.
 */
function shouldAlertOwner(uid, phone, category) {
  const key = `${uid}:${phone}:${category}`;
  const cached = _cacheGet(_alertThrottle, key);
  if (cached) return false; // ya hay alert pendiente
  _cacheSet(_alertThrottle, key, true, ALERT_THROTTLE_TTL_MS);
  return true;
}

/**
 * Reset throttle para un (uid, phone, category) cuando el owner toma acción
 * manual sobre la exclusión (restored/confirmed_excluded).
 */
function resetAlertThrottle(uid, phone, category) {
  const key = `${uid}:${phone}:${category}`;
  _alertThrottle.delete(key);
}

// ════════════════════════════════════════════════════════════════════════════
// RECORD INCIDENT
// ════════════════════════════════════════════════════════════════════════════

function _hashMessage(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 8);
}

function _redactPhone(phoneE164) {
  if (!phoneE164 || typeof phoneE164 !== 'string') return '+***';
  const digits = phoneE164.replace(/\D/g, '');
  if (digits.length < 6) return phoneE164;
  const cc = phoneE164.startsWith('+') ? phoneE164.slice(0, 3) : `+${digits.slice(0, 2)}`;
  const last4 = digits.slice(-4);
  return `${cc}***${last4}`;
}

/**
 * Construye texto de alert según action. Sanitiza phone (regla C-403).
 *
 * @param {string} phoneE164 - phone del contacto
 * @param {Object} classification - { category, severity, ... }
 * @param {string} action - 'block' | 'log_warn' | 'log_only'
 * @param {string} contactName - nombre del contacto (o 'anónimo')
 * @returns {string} texto del alert para self-chat owner
 */
function buildOwnerAlertText(phoneE164, classification, action, contactName) {
  const phoneRedacted = _redactPhone(phoneE164);
  const name = contactName || 'anónimo';
  const cat = classification.category;

  if (action === 'block') {
    return `🛑 MIIA pausó automáticamente el chat con ${name} (${phoneRedacted}). Detecté información sensible (categoría: ${cat}). El contacto fue excluido del flujo automático. Decidí: respondé manualmente desde tu WhatsApp si querés seguir, o restaurá la exclusión en el dashboard de privacidad.`;
  }
  if (action === 'log_warn') {
    return `⚠️ Detecté información sensible (categoría: ${cat}) en chat con ${name} (${phoneRedacted}). MIIA siguió respondiendo pero NO incorporó el mensaje al ADN comercial. Revisá si querés excluir manualmente desde el dashboard.`;
  }
  // log_only sin alert (función no debería llamarse, pero defensivo)
  return `ℹ️ Safety filter (log_only) categoría=${cat} contacto=${phoneRedacted}`;
}

/**
 * Envía alerta al owner por self-chat. Inyecta sendFn para evitar dependencia
 * circular con TMH. sendFn debe ser una función `(uid, jid, text) => Promise`.
 *
 * Marca `ownerNotifiedAt` en el incident doc (best-effort, no bloquea).
 *
 * @param {string} uid - owner UID
 * @param {string} ownerSelfJid - JID del self-chat del owner (WhatsApp)
 * @param {string} contactPhoneE164 - phone del contacto detectado
 * @param {Object} classification - resultado de classifyMessageSensitivity
 * @param {string} action - 'block' | 'log_warn' | 'log_only'
 * @param {string} contactName - nombre del contacto
 * @param {string|null} incidentId - id del doc safety_incident (para marcar notified)
 * @param {Function} sendFn - inyectada: (uid, jid, text) => Promise
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendOwnerSafetyAlert({ uid, ownerSelfJid, contactPhoneE164, classification, action, contactName, incidentId, sendFn }) {
  if (!sendFn || typeof sendFn !== 'function') {
    return { sent: false, reason: 'no_send_fn' };
  }
  if (action === 'log_only') {
    return { sent: false, reason: 'log_only_no_alert' };
  }
  if (!ownerSelfJid) {
    return { sent: false, reason: 'no_owner_jid' };
  }
  const text = buildOwnerAlertText(contactPhoneE164, classification, action, contactName);
  try {
    await sendFn(uid, ownerSelfJid, text);
    // Best-effort: marcar ownerNotifiedAt en el incident doc
    if (incidentId) {
      try {
        await db().collection('users').doc(uid).collection('safety_incidents').doc(incidentId)
          .set({ ownerNotifiedAt: new Date().toISOString() }, { merge: true });
      } catch (e) {
        console.warn(`[SAFETY] notifiedAt update fail uid=${uid} inc=${incidentId}: ${e.message}`);
      }
    }
    return { sent: true };
  } catch (e) {
    console.error(`[SAFETY] sendOwnerSafetyAlert error uid=${uid}: ${e.message}`);
    return { sent: false, reason: 'send_error', error: e.message };
  }
}

/**
 * Registra un safety_incident en Firestore.
 *
 * @returns {Promise<string|null>} incidentId o null si falla (no aborta caller).
 */
async function recordSafetyIncident(uid, phone, classification, messagePreview, action, contactName) {
  if (!uid || !classification) return null;
  try {
    const phoneE164 = phone && phone.startsWith('+') ? phone : `+${(phone || '').replace(/\D/g, '')}`;
    const sanitizedPreview = (messagePreview || '').slice(0, 80);
    const doc = {
      // Identificación
      phoneE164,
      phoneRedacted: _redactPhone(phoneE164),
      contactName: contactName || 'anónimo',

      // Clasificación
      category: classification.category,
      severity: classification.severity || 'MEDIA',
      regexMatch: classification.regexMatch || '',
      action,

      // Contenido auditoría owner-only
      messagePreview: sanitizedPreview,
      messageHash: _hashMessage(messagePreview || ''),

      // Timestamps
      detectedAt: new Date().toISOString(),
      ownerNotifiedAt: null,

      // Acción del owner (post-incident)
      ownerActionTaken: null,
      ownerActionAt: null,

      // Trazabilidad
      filterVersion: FILTER_VERSION,
    };
    const ref = await db().collection('users').doc(uid).collection('safety_incidents').add(doc);
    console.log(`[SAFETY] incident ${ref.id} uid=${uid} phone=${doc.phoneRedacted} cat=${classification.category} action=${action}`);
    return ref.id;
  } catch (e) {
    console.error(`[SAFETY] recordSafetyIncident error uid=${uid}: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP — idempotente al boot del servidor
// ════════════════════════════════════════════════════════════════════════════

/**
 * Idempotente: si MIIA CENTER no tiene config (o tiene enabled=false),
 * setea DEFAULT_CENTER_CONFIG. Lock `safety_filter_bootstrap_locked=true`
 * permite override manual del owner sin que deploy lo restablezca.
 *
 * Skip si env var SAFETY_FILTER_SKIP_BOOTSTRAP=1 (tests / debug local).
 */
async function ensureBootstrap() {
  if (process.env.SAFETY_FILTER_SKIP_BOOTSTRAP === '1') {
    console.log('[SAFETY] Bootstrap CENTER skipped — SAFETY_FILTER_SKIP_BOOTSTRAP=1');
    return { skipped: true, reason: 'env_flag' };
  }
  try {
    const ref = db().collection('users').doc(MIIA_CENTER_UID);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log('[SAFETY] Bootstrap CENTER skipped — owner doc no existe aún');
      return { skipped: true, reason: 'no_owner_doc' };
    }
    const data = snap.data();
    if (data.safety_filter_bootstrap_locked === true) {
      console.log('[SAFETY] Bootstrap CENTER skipped — locked by owner');
      return { skipped: true, reason: 'locked' };
    }
    const current = data.safety_filter_config;
    if (current && current.enabled === true) {
      // Ya configurado — no sobrescribir (preserva ajustes manuales del owner)
      return { skipped: true, reason: 'already_configured' };
    }
    await ref.set({
      safety_filter_config: DEFAULT_CENTER_CONFIG,
      safety_filter_bootstrap_at: new Date().toISOString(),
    }, { merge: true });
    // Invalidar cache para que próxima lectura traiga la config nueva
    _configCache.delete(MIIA_CENTER_UID);
    console.log('[SAFETY] Bootstrap CENTER aplicado');
    return { skipped: false, applied: true };
  } catch (e) {
    console.error(`[SAFETY] ensureBootstrap error: ${e.message}`);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  // API principal
  isSafetyFilterEnabledForUid,
  getCategoryConfig,
  classifyMessageSensitivity,
  recordSafetyIncident,
  shouldAlertOwner,
  resetAlertThrottle,
  sendOwnerSafetyAlert,
  buildOwnerAlertText,
  ensureBootstrap,

  // Constantes públicas
  MIIA_CENTER_UID,
  CATEGORIES,
  VALID_ACTIONS,
  DEFAULT_CENTER_CONFIG,
  FILTER_VERSION,

  // Helpers exportados para tests
  _passesLuhn: passesLuhn,
  _hashMessage,
  _redactPhone,
  _resetCaches,
};
