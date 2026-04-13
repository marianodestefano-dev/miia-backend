/**
 * Base class for all MIIA integrations (YouTube, Cocina, Gym, Spotify, etc.)
 * Patrón plugin — cada integración hereda de esta clase.
 */
const tokenEncryption = require('../core/token_encryption');

// Campos OAuth sensibles que se encriptan/desencriptan automáticamente
const SENSITIVE_FIELDS = ['accessToken', 'refreshToken', 'pageAccessToken', 'apiKey'];

class BaseIntegration {
  constructor({ type, displayName, emoji, checkIntervalMs = 3600000 }) {
    this.type = type;
    this.displayName = displayName;
    this.emoji = emoji;
    this.checkIntervalMs = checkIntervalMs; // Default: 1 hora
    this.lastCheck = 0;
    this._deps = {};
  }

  /** Inyectar dependencias (generateAIContent, safeSendMessage, etc.) */
  setDeps(deps) {
    this._deps = { ...this._deps, ...deps };
  }

  /** Verificar si toca chequear según intervalo */
  shouldCheck() {
    return Date.now() - this.lastCheck >= this.checkIntervalMs;
  }

  /** Marcar como chequeado */
  markChecked() {
    this.lastCheck = Date.now();
  }

  /**
   * Ejecutar la integración. Cada adapter implementa esto.
   * @param {Object} prefs - Preferencias del usuario para esta integración
   * @param {Object} ctx - { ownerUid, ownerPhone, ownerName, timezone }
   * @returns {Array<{message: string, priority: string}>} - Mensajes a enviar
   */
  async check(prefs, ctx) {
    throw new Error(`${this.type}.check() no implementado`);
  }

  /** Obtener preferencias desde Firestore (desencripta tokens automáticamente) */
  async getPrefs(admin, ownerUid) {
    try {
      const doc = await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection('miia_interests').doc(this.type)
        .get();
      if (!doc.exists) return null;
      const data = doc.data();
      // Desencriptar campos sensibles
      for (const field of SENSITIVE_FIELDS) {
        if (data[field] && tokenEncryption.isEncrypted(data[field])) {
          data[field] = tokenEncryption.decrypt(data[field]) || data[field];
        }
      }
      return data;
    } catch (e) {
      console.error(`[${this.type.toUpperCase()}] Error leyendo prefs:`, e.message);
      return null;
    }
  }

  /** Guardar preferencias en Firestore (encripta tokens automáticamente) */
  async savePrefs(admin, ownerUid, prefs) {
    // Encriptar campos sensibles antes de guardar
    const toSave = { ...prefs };
    for (const field of SENSITIVE_FIELDS) {
      if (toSave[field] && typeof toSave[field] === 'string') {
        toSave[field] = tokenEncryption.encrypt(toSave[field]);
      }
    }
    await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_interests').doc(this.type)
      .set(toSave, { merge: true });
  }

  _log(msg) { console.log(`[${this.emoji} ${this.type.toUpperCase()}] ${msg}`); }
  _error(msg, err) { console.error(`[${this.emoji} ${this.type.toUpperCase()}] ❌ ${msg}:`, err?.message || err); }
}

module.exports = BaseIntegration;
