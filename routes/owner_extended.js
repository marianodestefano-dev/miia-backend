'use strict';

/**
 * D.5-D.8 — Owner Extended Dashboard Routes
 * D.5: GET /api/owner/leads
 * D.6: GET /api/owner/alerts + POST /api/owner/alerts/:id/read
 * D.7: GET /api/owner/training + DELETE /api/owner/training/:id
 * D.8: GET/PUT /api/owner/config
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const VALID_LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'];
const VALID_TRAINING_TYPES = ['product', 'faq', 'price', 'general'];
const VALID_TONES = ['formal', 'casual', 'friendly'];
const VALID_LANGUAGES = ['es', 'en', 'pt'];
const VALID_LENGTHS = ['short', 'medium', 'long'];

function _ownerCol(uid, colName) {
  return db().collection('owners').doc(uid).collection(colName);
}

module.exports = function createOwnerExtendedRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function(req, res, next) { next(); };

  // ── D.5 ──────────────────────────────────────────────────────────
  // GET /api/owner/leads?status=new|contacted|converted&limit=20&offset=0
  router.get('/leads', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const status = req.query.status;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    if (status && !VALID_LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status invalido. Validos: ' + VALID_LEAD_STATUSES.join(', ') });
    }

    try {
      let query = _ownerCol(uid, 'leads').orderBy('last_contact_ts', 'desc');
      if (status) query = query.where('status', '==', status);
      const snap = await query.limit(limit + offset).get();
      const docs = snap.docs.slice(offset).map(function(doc) {
        const d = doc.data();
        return {
          phone: doc.id,
          name: d.name || doc.id,
          first_contact_ts: d.first_contact_ts || null,
          last_contact_ts: d.last_contact_ts || null,
          message_count: d.message_count || 0,
          status: d.status || 'new',
          memory_facts: (d.memory_facts || []).slice(0, 3),
        };
      });
      return res.json(docs);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── D.6 ──────────────────────────────────────────────────────────
  // GET /api/owner/alerts?unread_only=true
  router.get('/alerts', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const unreadOnly = req.query.unread_only === 'true';

    try {
      let query = _ownerCol(uid, 'alerts').orderBy('created_at', 'desc').limit(50);
      if (unreadOnly) query = query.where('read', '==', false);
      const snap = await query.get();
      const alerts = snap.docs.map(function(doc) {
        return Object.assign({ id: doc.id }, doc.data());
      });
      return res.json(alerts);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/owner/alerts/:id/read
  router.post('/alerts/:id/read', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const alertId = req.params.id;
    try {
      await _ownerCol(uid, 'alerts').doc(alertId).set({ read: true, read_at: new Date().toISOString() }, { merge: true });
      return res.json({ ok: true, id: alertId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── D.7 ──────────────────────────────────────────────────────────
  // GET /api/owner/training?type=product|faq|price&limit=20
  router.get('/training', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const type = req.query.type;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    if (type && !VALID_TRAINING_TYPES.includes(type)) {
      return res.status(400).json({ error: 'type invalido. Validos: ' + VALID_TRAINING_TYPES.join(', ') });
    }

    try {
      let query = _ownerCol(uid, 'training_data').orderBy('created_at', 'desc').limit(limit);
      if (type) query = query.where('type', '==', type);
      const snap = await query.get();
      const items = snap.docs.map(function(doc) {
        return Object.assign({ id: doc.id }, doc.data());
      });
      return res.json(items);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/owner/training/:id
  router.delete('/training/:id', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      await _ownerCol(uid, 'training_data').doc(req.params.id).delete();
      return res.json({ ok: true, deleted: req.params.id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── D.8 ──────────────────────────────────────────────────────────
  // GET /api/owner/config
  router.get('/config', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      const doc = await _ownerCol(uid, 'config').doc('main').get();
      const cfg = doc.exists ? doc.data() : {};
      return res.json({
        tone: cfg.tone || 'friendly',
        language: cfg.language || 'es',
        response_length: cfg.response_length || 'medium',
        use_emojis: cfg.use_emojis !== undefined ? cfg.use_emojis : true,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/owner/config
  router.put('/config', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const body = req.body || {};
    const errors = [];

    if (body.tone !== undefined && !VALID_TONES.includes(body.tone)) {
      errors.push('tone invalido: ' + body.tone + '. Validos: ' + VALID_TONES.join(', '));
    }
    if (body.language !== undefined && !VALID_LANGUAGES.includes(body.language)) {
      errors.push('language invalido: ' + body.language + '. Validos: ' + VALID_LANGUAGES.join(', '));
    }
    if (body.response_length !== undefined && !VALID_LENGTHS.includes(body.response_length)) {
      errors.push('response_length invalido. Validos: ' + VALID_LENGTHS.join(', '));
    }
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    const update = {};
    if (body.tone !== undefined) update.tone = body.tone;
    if (body.language !== undefined) update.language = body.language;
    if (body.response_length !== undefined) update.response_length = body.response_length;
    if (body.use_emojis !== undefined) update.use_emojis = !!body.use_emojis;
    update.updated_at = new Date().toISOString();

    try {
      await _ownerCol(uid, 'config').doc('main').set(update, { merge: true });
      return res.json(Object.assign({ ok: true }, update));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
