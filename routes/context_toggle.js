'use strict';

/**
 * R15-A — Context Toggle routes (Piso 2 P2.1 / MEJORA #49)
 * PUT  /api/owner/context-toggle            -> activa/desactiva un contexto
 * GET  /api/owner/context-toggle            -> estado de todos los contextos
 * POST /api/owner/context-toggle/undo       -> revierte cambio si dentro del window
 */

const VALID_CONTEXTS = ['leads', 'clientes', 'familia', 'equipo', 'selfchat'];
const UNDO_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _contextSettingsCol(uid) {
  return db().collection('owners').doc(uid).collection('context_settings');
}

module.exports = function createContextToggleRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function (req, res, next) { next(); };

  // PUT /api/owner/context-toggle
  router.put('/', requireAuth, async function (req, res) {
    const body = req.body || /* istanbul ignore next */ {};
    const uid = body.uid;
    const context = body.context;
    const enabled = body.enabled;

    if (!uid) return res.status(400).json({ error: 'uid_required' });
    if (!context) return res.status(400).json({ error: 'context_required' });
    if (!VALID_CONTEXTS.includes(context)) {
      return res.status(400).json({ error: 'context_invalido', valid: VALID_CONTEXTS });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled_debe_ser_boolean' });
    }

    try {
      const ref = _contextSettingsCol(uid).doc(context);
      const snap = await ref.get();
      const prevEnabled = snap.exists ? (snap.data().enabled === true) : false;
      const now = new Date().toISOString();
      const undoUntil = new Date(Date.now() + UNDO_WINDOW_MS).toISOString();

      await ref.set({
        uid,
        context,
        enabled,
        updatedAt: now,
        previousEnabled: prevEnabled,
        undoUntil,
      }, { merge: true });

      console.log('[CONTEXT-TOGGLE] uid=' + uid.slice(0, 8) + ' context=' + context + ' enabled=' + enabled);
      return res.json({ ok: true, uid, context, enabled, updatedAt: now, undoUntil });
    } catch (e) {
      console.error('[CONTEXT-TOGGLE] PUT error uid=' + uid.slice(0, 8) + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/owner/context-toggle?uid=X
  router.get('/', requireAuth, async function (req, res) {
    const uid = req.query && req.query.uid;
    if (!uid) return res.status(400).json({ error: 'uid_required' });

    try {
      const snap = await _contextSettingsCol(uid).get();
      const result = {};
      for (const ctx of VALID_CONTEXTS) {
        result[ctx] = { enabled: false, updatedAt: null, undoUntil: null };
      }
      snap.forEach(function (doc) {
        const data = doc.data();
        if (VALID_CONTEXTS.includes(doc.id)) {
          result[doc.id] = {
            enabled: data.enabled === true,
            updatedAt: data.updatedAt || null,
            undoUntil: data.undoUntil || null,
          };
        }
      });
      return res.json({ uid, contexts: result });
    } catch (e) {
      console.error('[CONTEXT-TOGGLE] GET error uid=' + uid.slice(0, 8) + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/owner/context-toggle/undo
  router.post('/undo', requireAuth, async function (req, res) {
    const body = req.body || /* istanbul ignore next */ {};
    const uid = body.uid;
    const context = body.context;

    if (!uid) return res.status(400).json({ error: 'uid_required' });
    if (!context) return res.status(400).json({ error: 'context_required' });
    if (!VALID_CONTEXTS.includes(context)) {
      return res.status(400).json({ error: 'context_invalido', valid: VALID_CONTEXTS });
    }

    try {
      const ref = _contextSettingsCol(uid).doc(context);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'contexto_no_encontrado' });

      const data = snap.data();
      const now = Date.now();
      const undoUntilMs = data.undoUntil ? new Date(data.undoUntil).getTime() : 0;
      if (now > undoUntilMs) {
        return res.status(409).json({ error: 'ventana_undo_expirada', undoUntil: data.undoUntil });
      }

      const restored = data.previousEnabled === true;
      await ref.set({
        enabled: restored,
        updatedAt: new Date().toISOString(),
        undoUntil: null,
        previousEnabled: data.enabled,
      }, { merge: true });

      console.log('[CONTEXT-TOGGLE] UNDO uid=' + uid.slice(0, 8) + ' context=' + context + ' restored=' + restored);
      return res.json({ ok: true, uid, context, enabled: restored, undone: true });
    } catch (e) {
      console.error('[CONTEXT-TOGGLE] UNDO error uid=' + uid.slice(0, 8) + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
module.exports.VALID_CONTEXTS = VALID_CONTEXTS;
module.exports.UNDO_WINDOW_MS = UNDO_WINDOW_MS;
