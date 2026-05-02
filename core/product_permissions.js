'use strict';

/**
 * product_permissions.js -- VI-DASH-1
 * Sistema de permisos por producto. Cada owner tiene flags por producto:
 *   miia, miiadt, ludomiia, f1
 * Cada uno: { active, plan, expiresAt, source: 'miia_included' | 'standalone' }
 */

const PRODUCTS = Object.freeze(['miia', 'miiadt', 'ludomiia', 'f1']);
const SOURCES = Object.freeze(['miia_included', 'standalone']);
const COL_PERMS = 'product_permissions';

/* istanbul ignore next */
let _db = null;
/* istanbul ignore next */
function __setFirestoreForTests(fs) { _db = fs; }
/* istanbul ignore next */
function db() { return _db || require('firebase-admin').firestore(); }

function _defaultPermission(product) {
  return { active: false, plan: null, expiresAt: null, source: null };
}

async function getProductPermissions(uid) {
  if (!uid) throw new Error('uid requerido');
  let data = {};
  try {
    const doc = await db().collection(COL_PERMS).doc(uid).get();
    if (doc && doc.exists && doc.data) data = doc.data();
  } catch (e) {
    data = {};
  }
  const out = {};
  for (const p of PRODUCTS) {
    out[p] = data[p] && typeof data[p] === 'object'
      ? { ..._defaultPermission(p), ...data[p] }
      : _defaultPermission(p);
  }
  return out;
}

async function isProductActive(uid, product) {
  if (!uid) throw new Error('uid requerido');
  if (!PRODUCTS.includes(product)) throw new Error('product invalido: ' + product);
  const perms = await getProductPermissions(uid);
  const p = perms[product];
  if (!p.active) return false;
  if (p.expiresAt) {
    const exp = new Date(p.expiresAt).getTime();
    if (!isNaN(exp) && exp < Date.now()) return false;
  }
  return true;
}

async function setProductPermission(uid, product, perm) {
  if (!uid) throw new Error('uid requerido');
  if (!PRODUCTS.includes(product)) throw new Error('product invalido: ' + product);
  if (!perm || typeof perm !== 'object') throw new Error('perm requerido');
  if (perm.source && !SOURCES.includes(perm.source)) throw new Error('source invalida: ' + perm.source);
  const data = {
    active: !!perm.active,
    plan: perm.plan || null,
    expiresAt: perm.expiresAt || null,
    source: perm.source || null,
    updatedAt: new Date().toISOString(),
  };
  await db().collection(COL_PERMS).doc(uid).set({ [product]: data }, { merge: true });
  return data;
}

/**
 * Cross-grant: si owner activa MIIA principal, otorga GRATIS los addons.
 * Llamar tras webhook de pago confirmado.
 */
async function grantMiiaIncludedAddons(uid, parentPlan) {
  if (!uid) throw new Error('uid requerido');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const updates = {};
  for (const p of PRODUCTS) {
    if (p === 'miia') continue;
    updates[p] = {
      active: true,
      plan: parentPlan || 'miia_included',
      expiresAt,
      source: 'miia_included',
      updatedAt: new Date().toISOString(),
    };
  }
  await db().collection(COL_PERMS).doc(uid).set(updates, { merge: true });
  return updates;
}

module.exports = {
  getProductPermissions,
  isProductActive,
  setProductPermission,
  grantMiiaIncludedAddons,
  PRODUCTS,
  SOURCES,
  __setFirestoreForTests,
};
