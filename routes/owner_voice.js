'use strict';

/**
 * EXTRA #5 — Routes Owner Voice Library (P3.3 ROADMAP).
 *
 * Endpoints gestion audios owner desde el dashboard:
 *   GET    /api/owner-voice/contexts            -> contextos disponibles
 *   GET    /api/owner-voice?uid=X               -> audios activos del owner
 *   POST   /api/owner-voice                     -> body {uid, context, fileUrl, transcript, durationSec}
 *   DELETE /api/owner-voice/:context?uid=X      -> soft-delete (deactivate)
 *   GET    /api/owner-voice/:context?uid=X      -> audio especifico
 */

const ownerVoice = require('../core/owner_voice_library');

let _module = ownerVoice;
function __setLibForTests(lib) { _module = lib; }

module.exports = function createOwnerVoiceRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function (req, res, next) { next(); };

  // GET /api/owner-voice/contexts
  router.get('/contexts', requireAuth, function (req, res) {
    return res.json({ contexts: _module.listAvailableContexts() });
  });

  // GET /api/owner-voice?uid=X
  router.get('/', requireAuth, async function (req, res) {
    const uid = req.query && req.query.uid;
    if (!uid) return res.status(400).json({ error: 'uid_required' });
    try {
      const audios = await _module.getAudiosForOwner(uid);
      return res.json({ uid, audios });
    } catch (e) {
      console.error('[OWNER-VOICE] list error uid=' + uid + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/owner-voice/:context?uid=X
  router.get('/:context', requireAuth, async function (req, res) {
    const uid = req.query && req.query.uid;
    const context = req.params.context;
    if (!uid) return res.status(400).json({ error: 'uid_required' });
    try {
      const audio = await _module.getAudioForContext(uid, context);
      if (!audio) return res.status(404).json({ error: 'not_found' });
      return res.json(audio);
    } catch (e) {
      const status = /context_invalido/.test(e.message) ? 400 : 500;
      return res.status(status).json({ error: e.message });
    }
  });

  // POST /api/owner-voice
  router.post('/', requireAuth, async function (req, res) {
    const body = req.body || /* istanbul ignore next */ {};
    const { uid, context, fileUrl, transcript, durationSec } = body;
    if (!uid) return res.status(400).json({ error: 'uid_required' });
    if (!context) return res.status(400).json({ error: 'context_required' });
    try {
      const result = await _module.registerAudio(uid, context, fileUrl, transcript, durationSec);
      return res.json(result);
    } catch (e) {
      const status = /context_invalido|fileUrl_requerido|durationSec_invalido|duracion_excede_max/.test(e.message)
        ? 400 : 500;
      return res.status(status).json({ error: e.message });
    }
  });

  // DELETE /api/owner-voice/:context?uid=X
  router.delete('/:context', requireAuth, async function (req, res) {
    const uid = req.query && req.query.uid;
    const context = req.params.context;
    if (!uid) return res.status(400).json({ error: 'uid_required' });
    try {
      const result = await _module.deactivateAudio(uid, context);
      return res.json(result);
    } catch (e) {
      const status = /context_invalido/.test(e.message) ? 400 : 500;
      return res.status(status).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setLibForTests = __setLibForTests;
