'use strict';

/**
 * catalog_conversational.js -- T-P3-1
 * Productos por owner con name, price, stock, category, sku.
 * El owner agrega via self-chat usando comandos como:
 *   "MIIA agregalo: Pizza Muzzarella $12000 stock 50"
 *
 * Schema: users/{uid}/products/{productId}
 *   { id, name, price, currency, stock, category, sku, description, createdAt, updatedAt }
 */

const { randomUUID } = require('crypto');

const COL_PRODUCTS = 'products';
const DEFAULT_CURRENCY = 'ARS';
const VALID_CURRENCIES = Object.freeze(['ARS', 'USD', 'COP', 'CLP', 'PEN', 'BRL', 'MXN']);

/* istanbul ignore next */
let _db = null;
/* istanbul ignore next */
function __setFirestoreForTests(fs) { _db = fs; }
/* istanbul ignore next */
function db() { return _db || require('firebase-admin').firestore(); }

function _normalizeName(name) {
  /* istanbul ignore next: defensive String(name || '') -- callers reales siempre pasan string truthy */
  return String(name || '').trim().toLowerCase();
}

function _validateProduct(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('productSpec requerido');
  if (!spec.name || typeof spec.name !== 'string' || spec.name.trim().length === 0) throw new Error('name requerido');
  if (typeof spec.price !== 'number' || spec.price < 0) throw new Error('price debe ser numero >= 0');
  if (spec.currency && !VALID_CURRENCIES.includes(spec.currency)) throw new Error('currency invalida: ' + spec.currency);
  if (spec.stock !== undefined && (typeof spec.stock !== 'number' || spec.stock < 0)) throw new Error('stock debe ser numero >= 0');
  return true;
}

async function addProduct(uid, productSpec) {
  if (!uid) throw new Error('uid requerido');
  _validateProduct(productSpec);
  const id = productSpec.id || randomUUID();
  const product = {
    id,
    name: productSpec.name.trim(),
    price: productSpec.price,
    currency: productSpec.currency || DEFAULT_CURRENCY,
    stock: typeof productSpec.stock === 'number' ? productSpec.stock : 0,
    category: productSpec.category || null,
    sku: productSpec.sku || null,
    description: productSpec.description || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db().collection('owners').doc(uid).collection(COL_PRODUCTS).doc(id).set(product);
  return product;
}

async function updateProduct(uid, productId, updates) {
  if (!uid) throw new Error('uid requerido');
  if (!productId) throw new Error('productId requerido');
  if (!updates || typeof updates !== 'object') throw new Error('updates requerido');
  if (updates.price !== undefined && (typeof updates.price !== 'number' || updates.price < 0)) throw new Error('price invalido');
  if (updates.stock !== undefined && (typeof updates.stock !== 'number' || updates.stock < 0)) throw new Error('stock invalido');
  const merge = Object.assign({}, updates, { updatedAt: new Date().toISOString() });
  await db().collection('owners').doc(uid).collection(COL_PRODUCTS).doc(productId).set(merge, { merge: true });
  return merge;
}

async function removeProduct(uid, productId) {
  if (!uid) throw new Error('uid requerido');
  if (!productId) throw new Error('productId requerido');
  await db().collection('owners').doc(uid).collection(COL_PRODUCTS).doc(productId).delete();
}

async function getProductById(uid, productId) {
  if (!uid) throw new Error('uid requerido');
  if (!productId) throw new Error('productId requerido');
  const doc = await db().collection('owners').doc(uid).collection(COL_PRODUCTS).doc(productId).get();
  if (!doc || !doc.exists) return null;
  return doc.data ? doc.data() : null;
}

async function getAllProducts(uid) {
  if (!uid) throw new Error('uid requerido');
  const snap = await db().collection('owners').doc(uid).collection(COL_PRODUCTS).get();
  const out = [];
  snap.forEach(d => out.push(d.data ? d.data() : {}));
  return out;
}

async function searchProductByName(uid, query) {
  if (!uid) throw new Error('uid requerido');
  if (!query || typeof query !== 'string') return [];
  const q = _normalizeName(query);
  const all = await getAllProducts(uid);
  return all.filter(p => p.name && _normalizeName(p.name).includes(q));
}

/**
 * Parsea comando self-chat tipo:
 *   "MIIA agregalo: Pizza Muzzarella $12000 stock 50 categoria comidas"
 *   "agregalo: Cafe $1500"
 *   "MIIA agregar producto: Hamburguesa precio 8000 stock 30"
 *
 * @returns {object|null} productSpec parseado o null si no coincide
 */
function parseAddProductCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  const triggers = ['miia agregalo:', 'agregalo:', 'miia agregar producto:', 'agregar producto:'];
  let matchedTrigger = null;
  for (const t of triggers) {
    if (lower.includes(t)) { matchedTrigger = t; break; }
  }
  if (!matchedTrigger) return null;
  const idx = lower.indexOf(matchedTrigger) + matchedTrigger.length;
  const rest = text.substring(idx).trim();
  if (!rest) return null;

  // Extraer precio: $NNNN o "precio NNNN"
  const priceMatch = rest.match(/\$\s*(\d+(?:[.,]\d+)?)|precio\s+(\d+(?:[.,]\d+)?)/i);
  const price = priceMatch ? parseFloat((priceMatch[1] || priceMatch[2]).replace(',', '.')) : null;

  // Extraer stock
  const stockMatch = rest.match(/stock\s+(\d+)/i);
  const stock = stockMatch ? parseInt(stockMatch[1], 10) : undefined;

  // Extraer categoria
  const catMatch = rest.match(/categoria\s+([a-zA-Z]+)/i);
  const category = catMatch ? catMatch[1].toLowerCase() : null;

  // Nombre = lo que queda tras remover los matches
  let name = rest
    .replace(/\$\s*\d+(?:[.,]\d+)?/gi, '')
    .replace(/precio\s+\d+(?:[.,]\d+)?/gi, '')
    .replace(/stock\s+\d+/gi, '')
    .replace(/categoria\s+[a-zA-Z]+/gi, '')
    .trim();

  if (!name) return null;
  if (price === null || isNaN(price)) return null;

  return { name, price, stock, category };
}

module.exports = {
  addProduct,
  updateProduct,
  removeProduct,
  getProductById,
  getAllProducts,
  searchProductByName,
  parseAddProductCommand,
  VALID_CURRENCIES,
  DEFAULT_CURRENCY,
  __setFirestoreForTests,
};
