'use strict';

/**
 * CAT.1 — Catalogo CRUD routes
 * POST   /api/owner/catalog        - crear item
 * GET    /api/owner/catalog        - listar (filtrar por category/active)
 * PUT    /api/owner/catalog/:id    - editar
 * DELETE /api/owner/catalog/:id   - soft-delete (active=false)
 */

const REQUIRED_FIELDS = ['name', 'description'];

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function _catalogCol(uid) {
  return db().collection('owners').doc(uid).collection('catalog');
}

module.exports = function createCatalogRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function(req, res, next) { next(); };

  // POST /api/owner/catalog
  router.post('/', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const body = req.body || {};
    const missing = REQUIRED_FIELDS.filter(function(f) { return !body[f]; });
    if (missing.length > 0) return res.status(400).json({ error: 'Campos requeridos: ' + missing.join(', ') });

    const item = {
      name: body.name,
      description: body.description,
      price: body.price || null,
      currency: body.currency || 'USD',
      category: body.category || 'general',
      active: true,
      image_url: body.image_url || null,
      keywords: Array.isArray(body.keywords) ? body.keywords : [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      const ref = await _catalogCol(uid).add(item);
      return res.status(201).json(Object.assign({ id: ref.id }, item));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/owner/catalog
  router.get('/', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const category = req.query.category;
    const activeOnly = req.query.active !== 'false'; // default: solo activos

    try {
      let query = _catalogCol(uid).orderBy('created_at', 'desc');
      if (activeOnly) query = query.where('active', '==', true);
      if (category) query = query.where('category', '==', category);
      const snap = await query.get();
      const items = snap.docs.map(function(doc) {
        return Object.assign({ id: doc.id }, doc.data());
      });
      return res.json(items);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/owner/catalog/:id
  router.put('/:id', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const body = req.body || {};
    const update = Object.assign({}, body, { updated_at: new Date().toISOString() });
    delete update.id;

    try {
      await _catalogCol(uid).doc(req.params.id).set(update, { merge: true });
      return res.json({ ok: true, id: req.params.id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/owner/catalog/:id (soft-delete)
  router.delete('/:id', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      await _catalogCol(uid).doc(req.params.id).set({ active: false, updated_at: new Date().toISOString() }, { merge: true });
      return res.json({ ok: true, id: req.params.id, active: false });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
