'use strict';

/**
 * MIIA Auth/Role Middleware — C-406 Cimientos §3 C.7
 *
 * Spec: specs/01_IDENTIDAD.md §P0-02 + ROADMAP_POST_C398.md §3 C.7.
 *
 * Centraliza validación de Firebase ID token + role-based access control
 * para endpoints Express. Scope mínimo viable C-406: aplicado a endpoints
 * críticos SIN auth previo (export/import/admin-chat/admin/support-chat/
 * admin/migrate-email). Endpoints que ya usan verifyTenantAuth o
 * verifyAdminToken inline en server.js se conservan (deuda C-406.b).
 *
 * Exports:
 *   - requireAuth(req, res, next): valida Firebase ID token. 401 si falta/
 *     inválido. Inyecta req.user = { uid, email, role, claims }.
 *   - requireRole(roleOrRoles): HOF que valida req.user.role. 403 si
 *     mismatch. Admin (role='admin' o ADMIN_EMAILS match) bypasea.
 *   - requireAdmin: atajo para requireRole('admin').
 *   - requireOwner: atajo para requireRole(['owner', 'admin']).
 *   - requireOwnerOfResource(paramName): valida que req.params[paramName]
 *     coincide con req.user.uid. Admin bypasea. 403 si mismatch.
 *
 * NO depende de server.js — usa firebase-admin directamente. Idempotente:
 * si admin.app() no está inicializado, falla con 503 explicativo.
 *
 * Standard: Google + Amazon + Apple + NASA — fail loudly, observable.
 */

const admin = require('firebase-admin');

/**
 * Verifica que Firebase Admin SDK está inicializado.
 * Si no, responde 503 (backend mal configurado).
 */
function ensureFirebaseAdmin(res) {
  try {
    admin.app();
    return true;
  } catch (_) {
    res.status(503).json({
      error: 'firebase_admin_not_initialized',
      message: 'Firebase Admin SDK no está inicializado. Verificar FIREBASE_SERVICE_ACCOUNT.',
    });
    return false;
  }
}

/**
 * Extrae el Bearer token del header Authorization.
 * Retorna el token (string) o null si falta/malformado.
 */
function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Deriva el role del usuario a partir del decoded token + Firestore lookup
 * + ADMIN_EMAILS bypass.
 *
 * Orden de precedencia:
 *   1. ADMIN_EMAILS env var → role='admin'
 *   2. decoded.role (custom claim Firebase) → usar directo
 *   3. Firestore users/{uid}.role → fallback lookup
 *   4. default → 'user'
 *
 * @returns {Promise<string>} role string
 */
async function resolveUserRole(decoded) {
  // (1) ADMIN_EMAILS bypass
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = (decoded.email || '').toLowerCase();
  if (email && adminEmails.includes(email)) return 'admin';

  // (2) custom claim en token
  if (decoded.role && typeof decoded.role === 'string') return decoded.role;

  // (3) Firestore lookup
  try {
    const doc = await admin.firestore().collection('users').doc(decoded.uid).get();
    if (doc.exists && doc.data().role) return doc.data().role;
  } catch (_) {
    // Firestore no accesible en este entorno → degradar a default
  }

  // (4) default
  return 'user';
}

/**
 * Middleware: valida Firebase ID token + inyecta req.user.
 * 401 si token falta/inválido. 503 si Firebase Admin no disponible.
 */
async function requireAuth(req, res, next) {
  if (!ensureFirebaseAdmin(res)) return;

  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'missing_token',
      message: 'Header Authorization: Bearer <token> ausente o malformado.',
    });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const role = await resolveUserRole(decoded);
    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      role,
      isAdmin: role === 'admin',
      claims: decoded,
    };
    next();
  } catch (err) {
    console.warn(`[REQUIRE_ROLE] verifyIdToken failed: ${err.code || err.message}`);
    return res.status(401).json({
      error: 'invalid_token',
      message: 'Token inválido o expirado.',
    });
  }
}

/**
 * Middleware factory: valida que req.user.role esté en la lista `roles`.
 * Debe usarse DESPUÉS de requireAuth (sino req.user es undefined).
 *
 * @param {string|string[]} roleOrRoles - Rol esperado o lista de roles aceptados.
 * @returns {function} middleware Express
 */
function requireRole(roleOrRoles) {
  const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        error: 'not_authenticated',
        message: 'requireRole debe usarse DESPUÉS de requireAuth.',
      });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `Rol requerido: ${allowed.join(' | ')}. Tu rol: ${req.user.role}.`,
        required: allowed,
        actual: req.user.role,
      });
    }
    next();
  };
}

/**
 * Middleware factory: valida que req.params[paramName] coincida con
 * req.user.uid. Admin bypasea. Debe usarse DESPUÉS de requireAuth.
 *
 * @param {string} paramName - Nombre del param en la ruta (ej: 'uid').
 * @returns {function} middleware Express
 */
function requireOwnerOfResource(paramName = 'uid') {
  return function requireOwnerOfResourceMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        error: 'not_authenticated',
        message: 'requireOwnerOfResource debe usarse DESPUÉS de requireAuth.',
      });
    }
    // Admin bypasea ownership check
    if (req.user.isAdmin === true || req.user.role === 'admin') {
      return next();
    }
    const resourceUid = req.params && req.params[paramName];
    if (!resourceUid) {
      return res.status(400).json({
        error: 'missing_param',
        message: `Param :${paramName} ausente en la ruta.`,
      });
    }
    if (resourceUid !== req.user.uid) {
      return res.status(403).json({
        error: 'forbidden_ownership',
        message: `No tienes permiso sobre este recurso. :${paramName}=${resourceUid} ≠ tu uid.`,
      });
    }
    next();
  };
}

// Atajos de uso común
const requireAdmin = requireRole('admin');
const requireOwner = requireRole(['owner', 'admin']);

module.exports = {
  requireAuth,
  requireRole,
  requireAdmin,
  requireOwner,
  requireOwnerOfResource,
  // Exports internos para tests
  _extractBearerToken: extractBearerToken,
  _resolveUserRole: resolveUserRole,
};
