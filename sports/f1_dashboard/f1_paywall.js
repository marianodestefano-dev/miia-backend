'use strict';

/**
 * MiiaF1 -- Paywall $3/mes (F1.29-F1.30)
 * Verifica si el owner tiene el add-on F1 activo.
 * Add-on procesado via MercadoPago o PayPal (misma logica que planes MIIA).
 */

const admin = require('firebase-admin');

const F1_ADDON_PRICE_USD = 3;
const F1_ADDON_ID = 'f1_dashboard';

/**
 * Verifica si el owner tiene el add-on F1 activo.
 * @param {string} ownerUid
 * @returns {Promise<boolean>}
 */
async function hasF1Addon(ownerUid) {
  if (!ownerUid) return false;
  try {
    const db = admin.firestore();
    const ownerDoc = await db.doc('owners/' + ownerUid).get();
    if (!ownerDoc.exists) return false;
    const data = ownerDoc.data();
    // Check: addons array o campo f1_active
    if (data.f1_active === true) return true;
    if (Array.isArray(data.addons) && data.addons.includes(F1_ADDON_ID)) return true;
    // Check subscripcion activa con addon_id
    const subSnap = await db.collection('subscriptions')
      .where('owner_uid', '==', ownerUid)
      .where('addon_id', '==', F1_ADDON_ID)
      .where('status', '==', 'active')
      .limit(1).get();
    return !subSnap.empty;
  } catch (err) {
    console.error('[F1-PAYWALL] Error verificando addon para ' + ownerUid + ': ' + err.message);
    return false;
  }
}

/**
 * Activa el add-on F1 para un owner (post-pago confirmado).
 * @param {string} ownerUid
 * @param {string} paymentId - ID de pago MP o PayPal
 * @param {string} provider - 'mercadopago' | 'paypal'
 * @returns {Promise<void>}
 */
async function activateF1Addon(ownerUid, paymentId, provider) {
  const db = admin.firestore();
  await db.doc('owners/' + ownerUid).set(
    { f1_active: true, addons: admin.firestore.FieldValue.arrayUnion(F1_ADDON_ID) },
    { merge: true }
  );
  await db.collection('subscriptions').add({
    owner_uid: ownerUid,
    addon_id: F1_ADDON_ID,
    payment_id: paymentId,
    provider: provider || 'unknown',
    price_usd: F1_ADDON_PRICE_USD,
    status: 'active',
    activated_at: new Date().toISOString(),
  });
  console.log('[F1-PAYWALL] Addon F1 activado para ' + ownerUid + ' via ' + provider);
}

/**
 * Desactiva el add-on F1 (cancelacion o vencimiento).
 * @param {string} ownerUid
 * @returns {Promise<void>}
 */
async function deactivateF1Addon(ownerUid) {
  const db = admin.firestore();
  await db.doc('owners/' + ownerUid).set(
    { f1_active: false },
    { merge: true }
  );
  console.log('[F1-PAYWALL] Addon F1 desactivado para ' + ownerUid);
}

/**
 * Middleware Express para verificar addon F1.
 * Retorna 402 si el owner no tiene el addon.
 */
function requireF1Addon(req, res, next) {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: 'No autenticado' });

  hasF1Addon(uid).then(function(active) {
    if (!active) {
      return res.status(402).json({
        error: 'F1 Dashboard requiere add-on ($3 USD/mes)',
        addon_id: F1_ADDON_ID,
        price_usd: F1_ADDON_PRICE_USD,
        upgrade_url: '/dashboard#f1-upgrade',
      });
    }
    next();
  }).catch(function(err) {
    console.error('[F1-PAYWALL] Middleware error: ' + err.message);
    next(); // fail-open para no bloquear en caso de error
  });
}

module.exports = { hasF1Addon, activateF1Addon, deactivateF1Addon, requireF1Addon, F1_ADDON_ID, F1_ADDON_PRICE_USD };
