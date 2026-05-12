'use strict';

/**
 * R16-A — mod_catalog.js (IDEA #050)
 * Catálogo conversacional: detección de queries, contexto para prompt, carrito, pedidos.
 */

const MAX_RESULTS = 5;
const MIN_SCORE = 1;

const CATALOG_TAGS = {
  AGREGAR_CARRITO: /\[AGREGAR_A_CARRITO:([^|\]]+)\|(\d+)\]/,
  CERRAR_PEDIDO: /\[CERRAR_PEDIDO:(\{[^}]+\}|\[[^\]]*\]|[^\]]+)\]/,
  MOSTRAR_CATALOGO: /\[MOSTRAR_CATALOGO(?::([^\]]*))?\]/,
};

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _catalogCol(uid) {
  return db().collection('owners').doc(uid).collection('catalog');
}

function _pedidosCol(uid) {
  return db().collection('owners').doc(uid).collection('pedidos');
}

function _normalize(str) {
  return (str || /* istanbul ignore next */ '').toLowerCase().replace(/[^a-z0-9áéíóúüñ\s]/gi, ' ');
}

function _scoreProduct(producto, terms) {
  const haystack = _normalize(
    [producto.name, producto.description, ...(Array.isArray(producto.keywords) ? producto.keywords : [])].join(' ')
  );
  let score = 0;
  for (const term of terms) {
    /* istanbul ignore next */
    if (term.length < 3) continue;
    if (haystack.includes(term)) score++;
  }
  return score;
}

/**
 * Detecta productos relevantes para el mensaje del cliente.
 * @param {string} mensaje
 * @param {Array} catalogItems — productos activos pre-cargados
 * @returns {Array} top MAX_RESULTS productos con score >= MIN_SCORE
 */
function detectProductQuery(mensaje, catalogItems) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  if (!mensaje || !items.length) return [];
  const terms = _normalize(mensaje).split(/\s+/).filter(function (t) { return t.length >= 3; });
  if (!terms.length) return [];
  return items
    .filter(function (p) { return p && p.active !== false; })
    .map(function (p) { return { producto: p, score: _scoreProduct(p, terms) }; })
    .filter(function (r) { return r.score >= MIN_SCORE; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, MAX_RESULTS)
    .map(function (r) { return r.producto; });
}

/**
 * Construye el bloque de catálogo para inyectar en el prompt de Gemini.
 * @param {string} uid
 * @returns {string} bloque markdown
 */
async function buildCatalogContext(uid) {
  if (!uid) return '';
  try {
    const snap = await _catalogCol(uid).where('active', '==', true).get();
    if (snap.empty) return '';
    const items = [];
    snap.forEach(function (doc) {
      const d = doc.data();
      items.push({
        id: doc.id,
        name: d.name || '',
        description: d.description || '',
        price: d.price || null,
        currency: d.currency || 'USD',
        stock: d.stock !== false,
        keywords: Array.isArray(d.keywords) ? d.keywords : [],
      });
    });
    /* istanbul ignore next */
    if (!items.length) return '';
    const lines = ['## CATALOGO DE PRODUCTOS'];
    items.forEach(function (p, i) {
      const priceStr = p.price != null ? ' — ' + p.currency + ' ' + p.price : '';
      const stockStr = p.stock ? '' : ' [SIN STOCK]';
      lines.push((i + 1) + '. *' + p.name + '*' + priceStr + stockStr);
      if (p.description) lines.push('   ' + p.description);
    });
    console.log('[MOD-CATALOG] buildCatalogContext uid=' + uid.slice(0, 8) + ' productos=' + items.length);
    return lines.join('\n');
  } catch (e) {
    console.error('[MOD-CATALOG] buildCatalogContext error uid=' + uid.slice(0, 8) + ':', e.message);
    return '';
  }
}

/**
 * Agrega un producto al carrito de la conversación.
 * @param {Array} carrito — carrito actual (puede ser undefined)
 * @param {string} productId
 * @param {number} cantidad
 * @param {Array} catalogItems — para validar que el producto existe y tiene stock
 * @returns {{ carrito: Array, ok: boolean, error?: string }}
 */
function addToCart(carrito, productId, cantidad, catalogItems) {
  const cart = Array.isArray(carrito) ? [...carrito] : [];
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const producto = items.find(function (p) { return p && p.id === productId; });
  if (!producto) return { carrito: cart, ok: false, error: 'producto_no_encontrado' };
  if (producto.stock === false) return { carrito: cart, ok: false, error: 'sin_stock' };
  const qty = Math.max(1, parseInt(cantidad, 10) || 1);
  const idx = cart.findIndex(function (i) { return i.productId === productId; });
  if (idx >= 0) {
    cart[idx] = { ...cart[idx], cantidad: cart[idx].cantidad + qty };
  } else {
    cart.push({ productId, nombre: producto.name, precio: producto.price, currency: producto.currency || 'USD', cantidad: qty });
  }
  return { carrito: cart, ok: true };
}

/**
 * Persiste el pedido en Firestore y limpia el carrito.
 * @param {string} uid
 * @param {string} phone
 * @param {Array} carrito
 * @returns {{ pedidoId: string, total: number, currency: string }}
 */
async function closePedido(uid, phone, carrito) {
  const cart = Array.isArray(carrito) ? carrito : [];
  if (!cart.length) throw new Error('carrito_vacio');
  const currency = cart[0].currency || 'USD';
  const total = cart.reduce(function (sum, i) { return sum + (i.precio || 0) * (i.cantidad || 1); }, 0);
  const pedido = {
    uid,
    phone,
    items: cart,
    total,
    currency,
    status: 'pendiente',
    createdAt: new Date().toISOString(),
  };
  const ref = await _pedidosCol(uid).add(pedido);
  console.log('[MOD-CATALOG] closePedido uid=' + uid.slice(0, 8) + ' pedidoId=' + ref.id + ' total=' + total);
  return { pedidoId: ref.id, total, currency };
}

module.exports = {
  detectProductQuery,
  buildCatalogContext,
  addToCart,
  closePedido,
  CATALOG_TAGS,
  MAX_RESULTS,
  MIN_SCORE,
  __setFirestoreForTests,
};
