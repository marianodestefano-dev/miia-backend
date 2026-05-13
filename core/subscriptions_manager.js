'use strict';

/**
 * core/subscriptions_manager.js -- VI-A2A3-SUBS
 *
 * Modulo unificado para users/{uid}/subscriptions/{producto} firmado Mariano 2026-05-02 ~16:00 COT.
 *
 * API:
 *   writeSubscription(uid, product, data)   -- escribe/merge entrada producto
 *   readSubscription(uid, product)          -- lee entrada producto
 *   isProductActive(uid, product)           -- true si active=true Y no vencida
 *   addProductPermission(uid, product, plan, expiresAt) -- agrega producto a cuenta existente
 *   listActiveProducts(uid)                 -- lista productos activos del owner
 *
 * INYECCION testeable:
 *   __setFirestoreForTests(fs) | __setNowForTests(fn)
 */

const admin = require('firebase-admin');

const VALID_PRODUCTS = ['miia', 'miiadt', 'ludomiia', 'f1'];

let _fsOverride = null;
let _nowOverride = null;
let _skipDualWrite = false;

function __setSkipDualWriteForTests(skip) { _skipDualWrite = skip; }

function __setFirestoreForTests(fs) { _fsOverride = fs; }
function __setNowForTests(fn) { _nowOverride = fn; }

function _fs() { return _fsOverride || /* istanbul ignore next */ admin.firestore(); }
function _now() { return _nowOverride ? _nowOverride() : /* istanbul ignore next */ new Date(); }

function _validProduct(product) {
  return typeof product === 'string' && VALID_PRODUCTS.includes(product);
}

async function writeSubscription(uid, product, data) {
  if (!uid || typeof uid !== 'string') { throw new Error('invalid_uid'); }
  if (!_validProduct(product)) { throw new Error('invalid_product'); }
  const ref = _fs().collection('users').doc(uid).collection('subscriptions').doc(product);
  const payload = Object.assign({}, data, { updatedAt: _now().toISOString() });
  await ref.set(payload, { merge: true });
  return payload;
}

async function readSubscription(uid, product) {
  if (!uid || !_validProduct(product)) return null;
  const snap = await _fs().collection('users').doc(uid).collection('subscriptions').doc(product).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function isProductActive(uid, product) {
  const sub = await readSubscription(uid, product);
  if (!sub || sub.active !== true) return false;
  if (sub.expiresAt) {
    const exp = new Date(sub.expiresAt);
    if (!isNaN(exp.getTime()) && exp < _now()) return false;
  }
  return true;
}

async function addProductPermission(uid, product, plan, expiresAt) {
  if (!uid || typeof uid !== 'string') { throw new Error('invalid_uid'); }
  if (!_validProduct(product)) { throw new Error('invalid_product'); }
  const payload = {
    active: true,
    plan: plan || 'monthly',
    expiresAt: expiresAt || null,
    activatedAt: _now().toISOString(),
  };
  const out = await writeSubscription(uid, product, payload);
  // Dual-write a product_permissions (compat con dashboard existente VI-DASH-1)
  /* istanbul ignore next */
  if (!_skipDualWrite) {
    try {
      const productPerms = require('./product_permissions');
      await productPerms.setProductPermission(uid, product, {
        active: true,
        plan: payload.plan,
        expiresAt: payload.expiresAt,
        source: 'standalone',
      });
    } catch (e) {
      console.warn('[SUBS-MANAGER] dual-write product_permissions fail:', e.message);
    }
  }
  return out;
}

async function listActiveProducts(uid) {
  if (!uid || typeof uid !== 'string') return [];
  const snap = await _fs().collection('users').doc(uid).collection('subscriptions').get();
  const active = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.active !== true) continue;
    if (data.expiresAt) {
      const exp = new Date(data.expiresAt);
      if (!isNaN(exp.getTime()) && exp < _now()) continue;
    }
    active.push(doc.id);
  }
  return active;
}

module.exports = {
  writeSubscription,
  readSubscription,
  isProductActive,
  addProductPermission,
  listActiveProducts,
  VALID_PRODUCTS,
  __setFirestoreForTests,
  __setNowForTests,
  __setSkipDualWriteForTests,
};
