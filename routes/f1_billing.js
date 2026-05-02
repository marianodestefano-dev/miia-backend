'use strict';

/**
 * routes/f1_billing.js — TEC-MIIAF1-BILLING-1.
 *
 * Endpoints checkout + webhook para MiiaF1 $3 USD/mes addon.
 * Mismo patron que LudoMIIA (apps/api-ludomiia/routes/ludomiia-billing.js)
 * y MIIADT (cuando se cree).
 *
 * Providers: MercadoPago (LATAM core) + PayPal (resto).
 * Stripe FUERA per memoria firma Mariano 2026-04-30 18:34 COT.
 *
 * Inyeccion via _setProviderResolverForTests + _setDbFactoryForTests.
 */

const express = require('express');
const admin = require('firebase-admin');
const { F1_ADDON_ID, F1_ADDON_PRICE_USD } = require('../sports/f1_dashboard/f1_paywall');

// Stub provider mientras SDKs MercadoPago/PayPal no instalados en miia-backend.
/* istanbul ignore next */
const STUB_PROVIDER = {
  createCheckoutSession: async () => { throw new Error('SDK_NOT_INSTALLED'); },
  verifyWebhook: async () => false,
};

/* istanbul ignore next */
function _defaultProviderResolver(country) { return STUB_PROVIDER; }


let _resolveProvider = _defaultProviderResolver;
let _dbFactory = /* istanbul ignore next */ () => admin.firestore();

function _setProviderResolverForTests(fn) { _resolveProvider = fn; }
function _setDbFactoryForTests(fn) { _dbFactory = fn; }

function createF1BillingRouter() {
  const router = express.Router();

  router.post('/checkout', async (req, res) => {
    /* istanbul ignore next — express.json garantiza body */
    const body = req.body || {};
    const { uid, country } = body;
    if (!uid) return res.status(400).json({ error: 'uid_required' });
    try {
      const provider = _resolveProvider(country || 'US');
      const result = await provider.createCheckoutSession({
        amount: F1_ADDON_PRICE_USD,
        currency: 'USD',
        addon_id: F1_ADDON_ID,
        uid,
      });
      return res.json({
        checkoutUrl: result.checkoutUrl || result.init_point || null,
        provider: result.provider || 'unknown',
        sessionId: result.sessionId || result.id || null,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/webhook', async (req, res) => {
    const country = req.query && req.query.country;
    try {
      const provider = _resolveProvider(country || 'US');
      const signature = req.headers['x-mp-signature'] || req.headers['paypal-transmission-sig'] || '';
      const valid = await provider.verifyWebhook(JSON.stringify(req.body), signature, process.env.WEBHOOK_SECRET || '');
      if (!valid) return res.status(401).json({ error: 'invalid_signature' });

      /* istanbul ignore next — express.json garantiza body */
      const payload = req.body || {};
      const status = payload.status || payload.event_type || '';
      const isSuccess = status === 'approved' || status === 'PAYMENT.CAPTURE.COMPLETED' || status === 'completed';

      if (!isSuccess) return res.status(200).json({ ok: true, action: 'ignored', status });

      const ownerUid = payload.uid || (payload.metadata && payload.metadata.uid);
      if (!ownerUid) return res.status(400).json({ error: 'uid_missing_in_payload' });

      const db = _dbFactory();
      await db.collection('subscriptions').add({
        owner_uid: ownerUid,
        addon_id: F1_ADDON_ID,
        payment_id: payload.payment_id || payload.id || null,
        provider: payload.provider || 'unknown',
        price_usd: F1_ADDON_PRICE_USD,
        status: 'active',
        activated_at: new Date().toISOString(),
      });
      return res.json({ ok: true, action: 'activated', uid: ownerUid });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  createF1BillingRouter,
  _setProviderResolverForTests,
  _setDbFactoryForTests,
};
