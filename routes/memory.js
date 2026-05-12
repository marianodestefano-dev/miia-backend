'use strict';

/**
 * MMC.4 — Privacy report routes
 * GET  /api/owner/memory-report?uid=X&contact=Y  -> { contact, key_facts, ... }
 * DELETE /api/owner/memory?uid=X&contact=Y       -> { ok: true }
 * Auth: solo el owner puede ver/eliminar su propia memoria (uid match)
 */

const { getEpisodicMemory, deleteEpisodicMemory } = require('../core/episodic_memory');

module.exports = function createMemoryRoutes(opts) {
  var express = require('express');
  var router = express.Router();
  var requireAuth = (opts && opts.requireAuth) || function(req, res, next) { next(); };

  // GET /api/owner/memory-report
  router.get('/memory-report', requireAuth, async function(req, res) {
    var uid = req.query.uid;
    var contact = req.query.contact;
    if (!uid || !contact) return res.status(400).json({ error: 'uid y contact requeridos' });
    if (req.user && req.user.uid !== uid) return res.status(403).json({ error: 'No autorizado' });

    try {
      var memory = await getEpisodicMemory(uid, contact);
      if (!memory) return res.status(404).json({ error: 'Memoria no encontrada' });

      var history = memory.sentiment_history || [];
      var sentiment_avg = history.length > 0
        ? history.reduce(function(s, h) { return s + (h.score || 0); }, 0) / history.length
        : null;

      return res.json({
        contact: contact,
        key_facts: memory.key_facts || [],
        interaction_count: memory.interaction_count || 0,
        last_interaction: memory.last_interaction || null,
        sentiment_avg: sentiment_avg,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/owner/memory
  router.delete('/memory', requireAuth, async function(req, res) {
    var uid = req.query.uid;
    var contact = req.query.contact;
    if (!uid || !contact) return res.status(400).json({ error: 'uid y contact requeridos' });
    if (req.user && req.user.uid !== uid) return res.status(403).json({ error: 'No autorizado' });

    try {
      await deleteEpisodicMemory(uid, contact);
      return res.json({ ok: true, deleted: contact });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
