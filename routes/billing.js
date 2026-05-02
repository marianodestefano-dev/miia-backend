'use strict';

/**
 * BILLING ROUTES -- VI-BILL-1
 *
 * POST /api/billing/cancel  (auth Bearer) -- Cancela la suscripcion del owner
 *   marca payment_status=cancelled y plan_end_date=now en users/{uid}
 *   no se cobra mas. retiene productos hasta plan_end_date original.
 */

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

module.exports = function createBillingRoutes() {

  router.post('/cancel', express.json(), async (req, res) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'no_token' });
      const decoded = await admin.auth().verifyIdToken(token);
      const uid = decoded.uid;

      const userRef = admin.firestore().collection('users').doc(uid);
      const snap = await userRef.get();
      if (!snap.exists) return res.status(404).json({ error: 'user_not_found' });
      const data = snap.data() || {};

      // No tocar plan_end_date original (el user retiene acceso hasta esa fecha).
      // Solo marcar cancelled para que el cron no renueve y el dashboard muestre estado.
      await userRef.update({
        payment_status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      });

      console.log('[BILLING-CANCEL] uid=' + uid + ' plan=' + (data.plan || 'unknown'));
      res.json({ ok: true, status: 'cancelled', retains_until: data.plan_end_date || null });
    } catch (e) {
      console.error('[BILLING-CANCEL] error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
