'use strict';

/**
 * routes/paypal.js -- VI-PAYPAL-INTG
 *
 * POST /api/paypal/subscribe  -- crea suscripcion PayPal, devuelve approvalUrl
 * POST /api/paypal/webhook    -- recibe eventos PayPal, actualiza Firestore
 * POST /api/paypal/cancel     -- cancela suscripcion activa del owner
 *
 * INYECCION: _setPayPalClientForTests, _setDbFactoryForTests, _setVerifyTokenForTests
 * PLAN IDs:  PAYPAL_PLAN_MIIADT | PAYPAL_PLAN_LUDOMIIA | PAYPAL_PLAN_F1 (env vars)
 * WEBHOOK:   PAYPAL_WEBHOOK_ID (env var)
 */

const express = require('express');
const admin = require('firebase-admin');
const subscriptionsManager = require('../core/subscriptions_manager');
const webhookDedup = require('../core/webhook_dedup');

const PLAN_RESOLVERS = {
  miiadt:   function() { return process.env.PAYPAL_PLAN_MIIADT   || null; },
  ludomiia: function() { return process.env.PAYPAL_PLAN_LUDOMIIA || null; },
  miiaf1:   function() { return process.env.PAYPAL_PLAN_F1       || null; },
};
const VALID_PRODUCTS = Object.keys(PLAN_RESOLVERS);

/* istanbul ignore next */
let _paypalClient = null;
/* istanbul ignore next */
let _dbFactory = function() { return admin.firestore(); };
/* istanbul ignore next */
let _verifyToken = function(token) { return admin.auth().verifyIdToken(token); };

function _setPayPalClientForTests(c)  { _paypalClient = c; }
function _setDbFactoryForTests(fn)    { _dbFactory    = fn; }
function _setVerifyTokenForTests(fn)  { _verifyToken  = fn; }

/* istanbul ignore next */
function _getPayPalClient() {
  if (_paypalClient) return _paypalClient;
  const cid = process.env.PAYPAL_CLIENT_ID;
  const csc = process.env.PAYPAL_CLIENT_SECRET;
  if (!cid || !csc) { throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set'); }
  const fetch = require('node-fetch');
  const base  = 'https://api-m.sandbox.paypal.com';
  const creds = Buffer.from(cid + ':' + csc).toString('base64');

  async function getToken() {
    const r = await fetch(base + '/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    return (await r.json()).access_token;
  }

  return {
    createSubscription: async function(planId, uid) {
      const t = await getToken();
      const r = await fetch(base + '/v1/billing/subscriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, custom_id: uid, application_context: { brand_name: 'MIIA App', user_action: 'SUBSCRIBE_NOW', return_url: 'https://app.miia-app.com/billing?status=success', cancel_url: 'https://app.miia-app.com/billing?status=cancel' } }),
      });
      return r.json();
    },
    cancelSubscription: async function(subscriptionId, reason) {
      const t = await getToken();
      const r = await fetch(base + '/v1/billing/subscriptions/' + subscriptionId + '/cancel', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'User requested cancellation' }),
      });
      return r.status;
    },
    verifyWebhook: async function(webhookId, headers, body) {
      const t = await getToken();
      const r = await fetch(base + '/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: (typeof body === 'string' ? JSON.parse(body) : body) }),
      });
      return (await r.json()).verification_status === 'SUCCESS';
    },
  };
}

function createPayPalRoutes() {
  const router = express.Router();

  // POST /subscribe
  router.post('/subscribe', express.json(), async function(req, res) {
    const auth = req.headers.authorization || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!tok) { return res.status(401).json({ error: 'no_token' }); }
    let uid;
    try { const d = await _verifyToken(tok); uid = d.uid; }
    catch (e) { return res.status(401).json({ error: 'invalid_token' }); }
    /* istanbul ignore next */
    const product = (req.body || {}).product;
    if (!product || !PLAN_RESOLVERS[product]) {
      return res.status(400).json({ error: 'invalid_product', valid: VALID_PRODUCTS });
    }
    const planId = PLAN_RESOLVERS[product]();
    if (!planId) { return res.status(503).json({ error: 'plan_not_configured', product }); }
    try {
      const result = await _getPayPalClient().createSubscription(planId, uid);
      const link = result.links && result.links.find(function(l) { return l.rel === 'approve'; });
      console.log('[PAYPAL-SUBSCRIBE] uid=' + uid + ' product=' + product);
      return res.json({ subscriptionId: result.id || null, approvalUrl: link ? link.href : null, status: result.status || null });
    } catch (e) {
      console.error('[PAYPAL-SUBSCRIBE] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /webhook
  router.post('/webhook', express.json(), async function(req, res) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
    try {
      const valid = await _getPayPalClient().verifyWebhook(webhookId, req.headers, req.body);
      if (!valid) { return res.status(401).json({ error: 'invalid_signature' }); }
    } catch (e) {
      console.error('[PAYPAL-WEBHOOK] verify error:', e.message);
      return res.status(500).json({ error: 'signature_verify_failed' });
    }
    /* istanbul ignore next */
    const payload   = req.body   || {};
    const eventType = payload.event_type || '';
    const resource  = payload.resource  || {};
    const ownerUid  = resource.custom_id;
    const eventId   = payload.id || resource.id || null;
    const productHint = resource.plan_id || null;
    if (!ownerUid) { return res.status(400).json({ error: 'uid_missing' }); }
    // A.7 -- dedup idempotente por event_id
    try {
      const dedup = await webhookDedup.markProcessed('paypal', eventId, { uid: ownerUid, eventType });
      if (dedup.duplicate) {
        console.log('[PAYPAL-WEBHOOK] DUPLICATE eventId=' + eventId);
        return res.json({ ok: true, action: 'duplicate_skipped', eventId });
      }
    } catch (e) {
      console.warn('[PAYPAL-WEBHOOK] dedup fail:', e.message);
    }
    // resolver producto desde plan_id
    let product = null;
    for (const key of Object.keys(PLAN_RESOLVERS)) {
      const planId = PLAN_RESOLVERS[key]();
      if (planId && planId === productHint) { product = key; break; }
    }
    try {
      const db = _dbFactory();
      if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
        await db.collection('users').doc(ownerUid).update({ payment_status: 'active', paypal_subscription_id: resource.id || null, activated_at: new Date().toISOString() });
        if (product) {
          await subscriptionsManager.addProductPermission(ownerUid, product, 'monthly', null);
        }
        console.log('[PAYPAL-WEBHOOK] ACTIVATED uid=' + ownerUid + ' product=' + product);
        return res.json({ ok: true, action: 'activated', uid: ownerUid, product });
      }
      if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') {
        await db.collection('users').doc(ownerUid).update({ payment_status: 'cancelled', cancelled_at: new Date().toISOString() });
        if (product) {
          await subscriptionsManager.writeSubscription(ownerUid, product, { active: false, cancelledAt: new Date().toISOString() });
        }
        console.log('[PAYPAL-WEBHOOK] CANCELLED uid=' + ownerUid);
        return res.json({ ok: true, action: 'cancelled', uid: ownerUid, product });
      }
      if (eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
        await db.collection('users').doc(ownerUid).update({ payment_status: 'payment_failed', last_failed_at: new Date().toISOString() });
        console.log('[PAYPAL-WEBHOOK] PAYMENT.FAILED uid=' + ownerUid);
        return res.json({ ok: true, action: 'payment_failed', uid: ownerUid });
      }
      return res.json({ ok: true, action: 'ignored', event_type: eventType });
    } catch (e) {
      console.error('[PAYPAL-WEBHOOK] db error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /cancel
  router.post('/cancel', express.json(), async function(req, res) {
    const auth = req.headers.authorization || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!tok) { return res.status(401).json({ error: 'no_token' }); }
    let uid;
    try { const d = await _verifyToken(tok); uid = d.uid; }
    catch (e) { return res.status(401).json({ error: 'invalid_token' }); }
    /* istanbul ignore next */
    const body = req.body || {};
    const subscriptionId = body.subscriptionId;
    if (!subscriptionId) { return res.status(400).json({ error: 'subscription_id_required' }); }
    try {
      const status = await _getPayPalClient().cancelSubscription(subscriptionId, body.reason);
      if (typeof status === 'number' && status >= 400) {
        return res.status(status < 600 ? status : 500).json({ error: 'paypal_cancel_failed', paypal_status: status });
      }
      await _dbFactory().collection('users').doc(uid).update({ payment_status: 'cancelled', paypal_subscription_id: null, cancelled_at: new Date().toISOString() });
      console.log('[PAYPAL-CANCEL] uid=' + uid);
      return res.json({ ok: true, status: 'cancelled' });
    } catch (e) {
      console.error('[PAYPAL-CANCEL] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createPayPalRoutes, _setPayPalClientForTests, _setDbFactoryForTests, _setVerifyTokenForTests, VALID_PRODUCTS };
