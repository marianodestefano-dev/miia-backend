'use strict';

/**
 * routes/product_status.js -- C.6 firma Mariano 2026-05-02
 *
 * Endpoints status por producto (consulta users/{uid}/subscriptions/{producto}):
 *   GET /api/miia/status?uid=X       -> { product, active, plan, expiresAt }
 *   GET /api/miiadt/status?uid=X     -> idem
 *   GET /api/ludomiia/status?uid=X   -> idem
 *   GET /api/f1/status?uid=X     -> idem
 *   GET /api/products/status?uid=X   -> { miia: {...}, miiadt: {...}, ludomiia: {...}, f1: {...} }
 *
 * Usado por owner-dashboard.html para render menus dinamicos (C.1).
 *
 * INYECCION: __setSubscriptionsManagerForTests(m)
 */

const express = require('express');
let _subsManager = require('../core/subscriptions_manager');

function __setSubscriptionsManagerForTests(m) { _subsManager = m; }

function _getUidFromQuery(req) {
  const uid = (req.query && req.query.uid) || (req.params && req.params.uid) || null;
  if (!uid || typeof uid !== 'string') return null;
  return uid;
}

async function _statusForProduct(uid, product) {
  const sub = await _subsManager.readSubscription(uid, product);
  if (!sub) {
    return { product, active: false, plan: null, expiresAt: null };
  }
  const active = await _subsManager.isProductActive(uid, product);
  return {
    product,
    active,
    plan: sub.plan || null,
    expiresAt: sub.expiresAt || null,
  };
}

function createProductStatusRoutes() {
  const router = express.Router();

  // Endpoints individuales
  for (const product of _subsManager.VALID_PRODUCTS) {
    router.get('/' + product + '/status', async function(req, res) {
      const uid = _getUidFromQuery(req);
      if (!uid) return res.status(400).json({ error: 'uid_required' });
      try {
        const status = await _statusForProduct(uid, product);
        return res.json(status);
      } catch (e) {
        console.error('[PRODUCT-STATUS] error product=' + product + ':', e.message);
        return res.status(500).json({ error: e.message });
      }
    });
  }

  // Endpoint agregado para dashboard
  router.get('/products/status', async function(req, res) {
    const uid = _getUidFromQuery(req);
    if (!uid) return res.status(400).json({ error: 'uid_required' });
    try {
      const out = {};
      for (const product of _subsManager.VALID_PRODUCTS) {
        out[product] = await _statusForProduct(uid, product);
      }
      return res.json(out);
    } catch (e) {
      console.error('[PRODUCT-STATUS] all-status error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = {
  createProductStatusRoutes,
  __setSubscriptionsManagerForTests,
};
