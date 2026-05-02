'use strict';

/**
 * AUTH ROUTES -- VI-AUTH-2/3 (signup auto Modelo B + magic link)
 *
 * POST /api/auth/signup-magic { email, plan?, addon? }
 *   - crea Firebase user si no existe
 *   - genera signInWithEmailLink y envia mail
 *   - retorna { exists: bool, sent: bool }
 */

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || 'https://miia-app.com';
const ACS_LINK_SETTINGS = {
  url: FRONTEND_BASE + '/login.html?magic=1',
  handleCodeInApp: true,
};

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

async function _sendMagicLinkMail(email, link) {
  // SMTP optional: usa SMTP_HOST/SMTP_USER/SMTP_PASS si estan, sino loguea
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.log('[AUTH-MAGIC] SMTP no configurado, link:', link);
    return { sent: false, reason: 'smtp_missing' };
  }
  const transporter = nodemailer.createTransport({ host, port: 587, secure: false, auth: { user, pass } });
  await transporter.sendMail({
    from: 'MIIA <noreply@miia-app.com>',
    to: email,
    subject: 'Tu link de acceso a MIIA',
    html: '<p>Hola,</p><p>Para entrar a MIIA hacé click acá:</p><p><a href="' + link + '">Entrar a MIIA</a></p><p>El link expira en 1 hora.</p>',
  });
  return { sent: true };
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

      // Persistir intencion de plan/addon para captura post-login
      if (plan || addon) {
        await admin.firestore().collection('users').doc(user.uid).set({
          pending_intent: { plan: plan || null, addon: addon || null, ts: new Date().toISOString() },
        }, { merge: true });
      }

      const link = await admin.auth().generateSignInWithEmailLink(email, ACS_LINK_SETTINGS);
      const sendResult = await _sendMagicLinkMail(email, link);

      console.log('[AUTH-MAGIC] uid=' + user.uid + ' created=' + created + ' sent=' + sendResult.sent);
      res.json({ exists: !created, created, sent: sendResult.sent });
    } catch (e) {
      console.error('[AUTH-MAGIC] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // VI-SETTINGS-1: set/change password
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
