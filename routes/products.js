'use strict';

/**
 * PRODUCTS ROUTES -- VI-DASH-2 (render condicional menus)
 *
 * GET  /api/products/permissions -- Retorna permisos del owner por producto
 * POST /api/products/grant-included -- Cross-grant addons (uso interno webhook MIIA)
 */

const express = require('express');
const router = express.Router();
const { getProductPermissions, grantMiiaIncludedAddons, PRODUCTS } = require('../core/product_permissions');

module.exports = function createProductsRoutes({ verifyToken }) {

  // GET /api/products/permissions -- requiere auth Firebase
  router.get('/permissions', async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'no_token' });
      const decoded = await require('firebase-admin').auth().verifyIdToken(token);
      const uid = decoded.uid;
      const perms = await getProductPermissions(uid);
      res.json({ uid, permissions: perms, products: PRODUCTS });
    } catch (e) {
      console.error('[PRODUCTS-ROUTE] permissions error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
