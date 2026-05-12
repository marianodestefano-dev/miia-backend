'use strict';

/**
 * C7-REQUIRE-ROLE-MIDDLEWARE
 * Centraliza validacion de roles de Firebase para endpoints sensibles en server.js.
 * Reemplaza validaciones inline duplicadas.
 */

const admin = require('firebase-admin');

let _admin = null;
function __setAdminForTests(a) { _admin = a; }
function getAdmin() { return _admin || admin; }

/**
 * requireRole(role) -- Middleware Express
 * Verifica que el usuario autenticado tiene el rol requerido.
 * Founder bypasea todos los checks (acceso global).
 * @param {'owner'|'admin'|'agent'|'founder'} role
 * @returns {Function} middleware
 */
function requireRole(role) {
  return async function(req, res, next) {
    try {
      const authHeader = req.headers && req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', detail: 'Missing Bearer token' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decoded = await getAdmin().auth().verifyIdToken(token);
      const uid = decoded.uid;

      const ownerSnap = await getAdmin().firestore().collection('owners').doc(uid).get();
      const ownerData = ownerSnap.exists ? ownerSnap.data() : null;
      const uidRole = ownerData ? ownerData.role : null;

      if (uidRole === 'founder') {
        req.uid = uid;
        req.uidRole = uidRole;
        return next();
      }

      if (uidRole !== role) {
        return res.status(403).json({ error: 'Forbidden', required: role, actual: uidRole });
      }

      req.uid = uid;
      req.uidRole = uidRole;
      return next();
    } catch (err) {
      console.error('[REQUIRE-ROLE] Error:', err.message);
      return res.status(401).json({ error: 'Unauthorized', detail: err.message });
    }
  };
}

/**
 * requireOwner(ownerUidParam) -- Shorthand requireRole('owner') + uid param check
 * Verifica que uid del token coincide con el recurso pedido.
 * @param {string} ownerUidParam - nombre del req.params key (ej: 'uid', 'ownerId')
 * @returns {Function} middleware
 */
function requireOwner(ownerUidParam) {
  return async function(req, res, next) {
    try {
      const authHeader = req.headers && req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', detail: 'Missing Bearer token' });
      }
      const token = authHeader.split('Bearer ')[1];
      const decoded = await getAdmin().auth().verifyIdToken(token);
      const uid = decoded.uid;

      const ownerSnap = await getAdmin().firestore().collection('owners').doc(uid).get();
      const ownerData = ownerSnap.exists ? ownerSnap.data() : null;
      const uidRole = ownerData ? ownerData.role : null;

      if (uidRole === 'founder') {
        req.uid = uid;
        req.uidRole = uidRole;
        return next();
      }

      if (uidRole !== 'owner') {
        return res.status(403).json({ error: 'Forbidden', required: 'owner', actual: uidRole });
      }

      const resourceUid = req.params && req.params[ownerUidParam];
      if (resourceUid && uid !== resourceUid) {
        return res.status(403).json({ error: 'Forbidden', detail: 'uid mismatch' });
      }

      req.uid = uid;
      req.uidRole = uidRole;
      return next();
    } catch (err) {
      console.error('[REQUIRE-ROLE] Error:', err.message);
      return res.status(401).json({ error: 'Unauthorized', detail: err.message });
    }
  };
}

module.exports = { requireRole, requireOwner, __setAdminForTests };
