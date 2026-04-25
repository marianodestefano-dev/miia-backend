'use strict';

/**
 * MIIA — Consent Routes (C-410 Cimientos §3 C.10 / Mitigación B)
 *
 * Endpoints para que el owner administre:
 *   1. Modo de disclaimer (A=silencioso / B=al firmar / C=al hablar con MIIA)
 *      → persistido en users/{uid}/onboarding_consent/v1
 *   2. Lista de exclusiones (contactos excluidos del flujo IA por opt-out)
 *      → persistidos en users/{uid}/consent_exclusions/{phone}
 *
 * Endpoints (todos requireAuth + requireOwner + ownership uid==req.user.uid):
 *   - POST   /api/owner/consent/disclaimer-mode      body: { mode, acknowledgment? }
 *   - GET    /api/owner/consent/exclusions
 *   - PUT    /api/owner/consent/exclusions/:phone    body: { reason?, source? }
 *   - DELETE /api/owner/consent/exclusions/:phone
 *
 * Spec legal: terms.html §10 "Tratamiento de Datos de Terceros" + dna-extraction.html
 * "Limitaciones". Mecanismo de exclusión hoy es soporte (hola@miia-app.com); estos
 * endpoints habilitan el self-service planificado y el dashboard de Mitigación B.
 *
 * Standard: Google + Amazon + Apple + NASA — fail loudly, observable,
 * zero silent failures. requireOwner garantiza role 'owner' o 'admin'.
 */

const express = require('express');
const admin = require('firebase-admin');
const {
  requireAuth,
  requireOwner,
} = require('../core/require_role');

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const VALID_MODES = ['A', 'B', 'C'];
const MODE_DESCRIPTIONS = {
  A: 'Silencioso — el owner asume informar a contactos por su cuenta',
  B: 'Al firmar el contrato — disclaimer mostrado al activar MIIA',
  C: 'Al hablar con MIIA por primera vez — disclaimer in-line en primer mensaje',
};

// E.164 sin + (solo dígitos). Aceptamos 8-15 dígitos para cubrir todos los países.
const PHONE_REGEX = /^[1-9][0-9]{7,14}$/;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

let _db;
function db() {
  if (!_db) _db = admin.firestore();
  return _db;
}

function consentDocRef(uid) {
  return db().collection('users').doc(uid).collection('onboarding_consent').doc('v1');
}

function exclusionsCol(uid) {
  return db().collection('users').doc(uid).collection('consent_exclusions');
}

function exclusionRef(uid, phone) {
  return exclusionsCol(uid).doc(phone);
}

/**
 * Normaliza phone a solo dígitos. Retorna null si no es válido E.164.
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (!PHONE_REGEX.test(digits)) return null;
  return digits;
}

/**
 * Middleware: bloquea si req.user.uid no es el dueño del recurso. Admin bypasea.
 * Usamos req.user (no req.params) porque las rutas de consent son
 * /api/owner/consent/* sin :uid — el owner SIEMPRE actúa sobre sí mismo.
 */
function selfOnly(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'not_authenticated',
      message: 'requireAuth debe correr antes que selfOnly.',
    });
  }
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} deps - dependencias inyectables (para tests)
 * @param {Function} [deps.requireAuth]
 * @param {Function} [deps.requireOwner]
 * @returns {express.Router}
 */
function createConsentRoutes(deps = {}) {
  const router = express.Router();
  const auth = deps.requireAuth || requireAuth;
  const owner = deps.requireOwner || requireOwner;

  // ─── POST /disclaimer-mode ─────────────────────────────────────────────
  router.post(
    '/disclaimer-mode',
    auth,
    owner,
    selfOnly,
    express.json(),
    async (req, res) => {
      try {
        const { mode, acknowledgment } = req.body || {};
        if (!VALID_MODES.includes(mode)) {
          return res.status(400).json({
            error: 'invalid_mode',
            message: `mode debe ser uno de: ${VALID_MODES.join(', ')}`,
            received: mode,
          });
        }
        const uid = req.user.uid;
        const payload = {
          mode,
          modeDescription: MODE_DESCRIPTIONS[mode],
          acknowledgment: typeof acknowledgment === 'string' ? acknowledgment.trim().slice(0, 1000) : null,
          updatedAt: new Date().toISOString(),
          updatedBy: uid,
        };
        await consentDocRef(uid).set(payload, { merge: true });
        console.log(`[CONSENT] disclaimer-mode set uid=${uid} mode=${mode}`);
        return res.json({ success: true, ...payload });
      } catch (e) {
        console.error(`[CONSENT] error disclaimer-mode uid=${req.user && req.user.uid}: ${e.message}`);
        return res.status(500).json({ error: 'internal_error', message: e.message });
      }
    }
  );

  // ─── GET /exclusions ───────────────────────────────────────────────────
  router.get(
    '/exclusions',
    auth,
    owner,
    selfOnly,
    async (req, res) => {
      try {
        const uid = req.user.uid;
        const snap = await exclusionsCol(uid).orderBy('addedAt', 'desc').get();
        const exclusions = snap.docs.map((d) => ({ phone: d.id, ...d.data() }));
        return res.json({ count: exclusions.length, exclusions });
      } catch (e) {
        console.error(`[CONSENT] error list exclusions uid=${req.user && req.user.uid}: ${e.message}`);
        return res.status(500).json({ error: 'internal_error', message: e.message });
      }
    }
  );

  // ─── PUT /exclusions/:phone ────────────────────────────────────────────
  router.put(
    '/exclusions/:phone',
    auth,
    owner,
    selfOnly,
    express.json(),
    async (req, res) => {
      try {
        const phone = normalizePhone(req.params.phone);
        if (!phone) {
          return res.status(400).json({
            error: 'invalid_phone',
            message: 'phone debe ser E.164 sin + (solo dígitos, 8-15).',
            received: req.params.phone,
          });
        }
        const { reason, source } = req.body || {};
        const uid = req.user.uid;
        const payload = {
          excluded: true,
          reason: typeof reason === 'string' ? reason.trim().slice(0, 500) : 'opt_out',
          source: typeof source === 'string' ? source.trim().slice(0, 50) : 'self_service',
          addedAt: new Date().toISOString(),
          addedBy: uid,
        };
        await exclusionRef(uid, phone).set(payload, { merge: true });
        console.log(`[CONSENT] exclusion ADD uid=${uid} phone=${phone} reason=${payload.reason}`);
        return res.json({ success: true, phone, ...payload });
      } catch (e) {
        console.error(`[CONSENT] error add exclusion uid=${req.user && req.user.uid} phone=${req.params.phone}: ${e.message}`);
        return res.status(500).json({ error: 'internal_error', message: e.message });
      }
    }
  );

  // ─── DELETE /exclusions/:phone ─────────────────────────────────────────
  router.delete(
    '/exclusions/:phone',
    auth,
    owner,
    selfOnly,
    async (req, res) => {
      try {
        const phone = normalizePhone(req.params.phone);
        if (!phone) {
          return res.status(400).json({
            error: 'invalid_phone',
            message: 'phone debe ser E.164 sin + (solo dígitos, 8-15).',
            received: req.params.phone,
          });
        }
        const uid = req.user.uid;
        const docRef = exclusionRef(uid, phone);
        const snap = await docRef.get();
        if (!snap.exists) {
          return res.status(404).json({
            error: 'not_found',
            message: 'No existe exclusión para ese phone.',
            phone,
          });
        }
        await docRef.delete();
        console.log(`[CONSENT] exclusion DELETE uid=${uid} phone=${phone}`);
        return res.json({ success: true, phone, restored: true });
      } catch (e) {
        console.error(`[CONSENT] error delete exclusion uid=${req.user && req.user.uid} phone=${req.params.phone}: ${e.message}`);
        return res.status(500).json({ error: 'internal_error', message: e.message });
      }
    }
  );

  return router;
}

// ════════════════════════════════════════════════════════════════════════════
// PROGRAMMATIC API — para uso interno de safety_filter / otros módulos
// ════════════════════════════════════════════════════════════════════════════

/**
 * Agrega una exclusión programáticamente (no vía HTTP).
 * Usado por core/safety_filter.js cuando detecta info sensible con action='block'.
 *
 * @param {string} uid - owner UID
 * @param {string} rawPhone - phone (E.164 con o sin +, será normalizado)
 * @param {Object} payload - { reason, source, category?, incidentId? }
 * @returns {Promise<{ success: boolean, phone: string, reason: string } | { error: string }>}
 */
async function addExclusionInternal(uid, rawPhone, payload = {}) {
  if (!uid || typeof uid !== 'string') {
    return { error: 'invalid_uid' };
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return { error: 'invalid_phone' };
  }
  try {
    const doc = {
      excluded: true,
      reason: typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 500) : 'sensitive_data_auto',
      source: typeof payload.source === 'string' ? payload.source.trim().slice(0, 50) : 'safety_filter',
      addedAt: new Date().toISOString(),
      addedBy: 'system',
    };
    if (payload.category) doc.category = String(payload.category).slice(0, 30);
    if (payload.incidentId) doc.incidentId = String(payload.incidentId).slice(0, 100);
    await exclusionRef(uid, phone).set(doc, { merge: true });
    console.log(`[CONSENT] exclusion AUTO uid=${uid} phone=${phone} reason=${doc.reason} category=${doc.category || '-'}`);
    return { success: true, phone, reason: doc.reason };
  } catch (e) {
    console.error(`[CONSENT] addExclusionInternal error uid=${uid} phone=${phone}: ${e.message}`);
    return { error: 'internal_error', message: e.message };
  }
}

module.exports = createConsentRoutes;
module.exports.addExclusionInternal = addExclusionInternal;
module.exports._normalizePhone = normalizePhone;
module.exports._VALID_MODES = VALID_MODES;
