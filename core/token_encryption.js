'use strict';

/**
 * TOKEN ENCRYPTION — Encripta/desencripta tokens sensibles en Firestore
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, zero silent failures)
 *
 * Usa AES-256-GCM (autenticado) con master key desde env var.
 * Si no hay master key → funciona en modo passthrough (no encripta, solo advierte).
 *
 * CAMPOS QUE SE ENCRIPTAN:
 *   - accessToken (Google OAuth)
 *   - refreshToken (Google OAuth)
 *   - aiApiKey (Gemini/Claude API key)
 *
 * FORMATO ENCRIPTADO: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * El prefijo "enc:v1:" permite detectar si un valor ya está encriptado.
 *
 * ENV VAR: MIIA_ENCRYPTION_KEY (32 bytes hex = 64 chars hex)
 * Generar: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENC_PREFIX = 'enc:v1:';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits

let _masterKey = null;
let _warned = false;

/**
 * Obtener la master key desde env var.
 * @returns {Buffer|null}
 */
function _getMasterKey() {
  if (_masterKey) return _masterKey;

  const keyHex = process.env.MIIA_ENCRYPTION_KEY;
  if (!keyHex) {
    if (!_warned) {
      console.warn('[ENCRYPTION] ⚠️ MIIA_ENCRYPTION_KEY no configurada — tokens se guardan sin encriptar. Genera una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      _warned = true;
    }
    return null;
  }

  if (keyHex.length !== 64) {
    console.error(`[ENCRYPTION] ❌ MIIA_ENCRYPTION_KEY debe tener 64 chars hex (32 bytes), tiene ${keyHex.length}`);
    return null;
  }

  console.log(`[ENCRYPTION] ✅ Key configurada (length: ${keyHex.length})`); // TEMPORAL — quitar después del primer deploy exitoso
  _masterKey = Buffer.from(keyHex, 'hex');
  return _masterKey;
}

/**
 * Encriptar un valor.
 * @param {string} plaintext - Texto a encriptar
 * @returns {string} Texto encriptado con prefijo "enc:v1:..." o plaintext si no hay key
 */
function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext; // Ya encriptado

  const key = _getMasterKey();
  if (!key) return plaintext; // Passthrough sin key

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${ENC_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (e) {
    console.error(`[ENCRYPTION] ❌ Error encriptando: ${e.message}`);
    return plaintext; // Fallback: guardar sin encriptar
  }
}

/**
 * Desencriptar un valor.
 * @param {string} ciphertext - Texto encriptado (con prefijo "enc:v1:...")
 * @returns {string} Texto original o el input si no está encriptado
 */
function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith(ENC_PREFIX)) return ciphertext; // No encriptado

  const key = _getMasterKey();
  if (!key) {
    console.error('[ENCRYPTION] ❌ Token encriptado pero MIIA_ENCRYPTION_KEY no configurada — no se puede desencriptar');
    return null;
  }

  try {
    const parts = ciphertext.substring(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) {
      console.error(`[ENCRYPTION] ❌ Formato encriptado inválido (${parts.length} partes, esperadas 3)`);
      return null;
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (e) {
    console.error(`[ENCRYPTION] ❌ Error desencriptando: ${e.message}`);
    return null;
  }
}

/**
 * ¿El valor está encriptado?
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Encriptar campos sensibles de un objeto (mutates in place).
 * @param {Object} data - Documento de Firestore
 * @param {string[]} fields - Campos a encriptar
 * @returns {Object} Mismo objeto con campos encriptados
 */
function encryptFields(data, fields = ['accessToken', 'refreshToken', 'aiApiKey']) {
  if (!data) return data;
  for (const field of fields) {
    if (data[field] && typeof data[field] === 'string' && !isEncrypted(data[field])) {
      data[field] = encrypt(data[field]);
    }
  }
  return data;
}

/**
 * Desencriptar campos sensibles de un objeto (mutates in place).
 * @param {Object} data - Documento de Firestore
 * @param {string[]} fields - Campos a desencriptar
 * @returns {Object} Mismo objeto con campos desencriptados
 */
function decryptFields(data, fields = ['accessToken', 'refreshToken', 'aiApiKey']) {
  if (!data) return data;
  for (const field of fields) {
    if (data[field] && isEncrypted(data[field])) {
      const decrypted = decrypt(data[field]);
      if (decrypted !== null) {
        data[field] = decrypted;
      } else {
        console.error(`[ENCRYPTION] ❌ No se pudo desencriptar ${field} — dejando encriptado`);
      }
    }
  }
  return data;
}

/**
 * ¿Está la encriptación activa?
 */
function isEnabled() {
  return _getMasterKey() !== null;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  encryptFields,
  decryptFields,
  isEnabled,
  ENC_PREFIX,
};
