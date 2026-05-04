'use strict';

/**
 * AUTH ROUTES -- VI-AUTH-2/3 + VI-SETTINGS-1
 *
 * POST /api/auth/signup-magic { email, plan?, addon? }
 *   - crea Firebase user si no existe
 *   - guarda pending_intent en users/{uid}
 *   - NO envia mail (lo hace el cliente via firebase.auth().sendSignInLinkToEmail)
 *   - Railway bloquea SMTP outbound, por eso delegamos al SDK Firebase cliente.
 *
 * POST /api/auth/set-password { password }
 *   - actualiza password del user autenticado
 */

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

async function _findOrCreateUser(email) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    return { user, created: false };
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') {
      const newUser = await admin.auth().createUser({ email, emailVerified: false });
      return { user: newUser, created: true };
    }
    throw e;
  }
}

module.exports = function createAuthRoutes() {

  router.post('/signup-magic', express.json(), async (req, res) => {
    try {
      /* istanbul ignore next: express.json() siempre setea req.body, || {} es defensivo */
      const { email, plan, addon } = req.body || {};
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        return res.status(400).json({ error: 'email invalido' });
      }
      const { user, created } = await _findOrCreateUser(email);

      if (plan || addon) {
        await admin.firestore().collection('users').doc(user.uid).set({
          pending_intent: { plan: plan || null, addon: addon || null, ts: new Date().toISOString() },
        }, { merge: true });
      }

      console.log('[AUTH-MAGIC] uid=' + user.uid + ' created=' + created + ' (cliente envia mail)');
      res.json({ exists: !created, created, sent: true });
    } catch (e) {
      console.error('[AUTH-MAGIC] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/set-password', express.json(), async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'no_token' });
      const decoded = await admin.auth().verifyIdToken(token);
      const uid = decoded.uid;
      /* istanbul ignore next: express.json() siempre setea req.body, || {} es defensivo */
      const { password } = req.body || {};
      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'password_min_6' });
      }
      await admin.auth().updateUser(uid, { password });
      console.log('[AUTH-SETPW] uid=' + uid + ' password_updated');
      res.json({ ok: true });
    } catch (e) {
      console.error('[AUTH-SETPW] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
