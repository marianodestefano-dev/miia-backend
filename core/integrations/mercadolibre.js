'use strict';

/**
 * R19-A — core/integrations/mercadolibre.js (Piso 4 P4.1 - IDEA #011)
 * Integración Mercado Libre API: OAuth2 por vendedor + listings + ventas + métricas.
 * Schema Firestore: owners/{uid}/integrations/mercadolibre
 *   { access_token, refresh_token, expires_at, seller_id, nickname, connectedAt }
 */

const ML_API_BASE = 'https://api.mercadolibre.com';
const ML_AUTH_BASE = 'https://auth.mercadolibre.com.ar/authorization';
const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min
const MAX_LISTING_LIMIT = 50;
const DEFAULT_SALES_DAYS = 7;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

let _fetch = /* istanbul ignore next */ function () { return require('node-fetch')(...arguments); };
function __setFetchForTests(fn) { _fetch = fn; }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _mlDoc(uid) {
  return db().collection('owners').doc(uid).collection('integrations').doc('mercadolibre');
}

function _mlAnsweredCol(uid) {
  return db().collection('owners').doc(uid).collection('ml_answered');
}

// ── ENV helpers ───────────────────────────────────────────────────────────────
function _getEnv() {
  return {
    appId: process.env.ML_APP_ID || null,
    secret: process.env.ML_SECRET || null,
    redirectUri: process.env.ML_REDIRECT_URI || null,
  };
}

// ── Token helpers ─────────────────────────────────────────────────────────────
async function _getTokenData(uid) {
  const snap = await _mlDoc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function _ensureValidToken(uid) {
  const data = await _getTokenData(uid);
  if (!data) throw new Error('ml_no_conectado');
  const expiresAt = data.expires_at || 0;
  if (Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return refreshToken(uid);
  }
  return data.access_token;
}

async function _getSellerId(uid) {
  const data = await _getTokenData(uid);
  if (!data || !data.seller_id) throw new Error('ml_no_conectado');
  return data.seller_id;
}

// ── API request helpers ───────────────────────────────────────────────────────
async function _mlGet(uid, path) {
  const token = await _ensureValidToken(uid);
  const res = await _fetch(ML_API_BASE + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('ml_api_error:' + res.status + ':' + errText.slice(0, 100));
  }
  return res.json();
}

async function _mlPost(uid, path, body) {
  const token = await _ensureValidToken(uid);
  const res = await _fetch(ML_API_BASE + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('ml_api_error:' + res.status + ':' + errText.slice(0, 100));
  }
  return res.json();
}

async function _mlPut(uid, path, body) {
  const token = await _ensureValidToken(uid);
  const res = await _fetch(ML_API_BASE + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('ml_api_error:' + res.status + ':' + errText.slice(0, 100));
  }
  return res.json();
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
/**
 * Genera la URL de redirección OAuth para que el owner conecte su cuenta ML.
 * @param {string} uid
 * @returns {string} URL de autorización
 */
function getAuthUrl(uid) {
  if (!uid) throw new Error('uid_requerido');
  const { appId, redirectUri } = _getEnv();
  if (!appId || !redirectUri) throw new Error('ml_env_no_configurado');
  return ML_AUTH_BASE
    + '?response_type=code'
    + '&client_id=' + appId
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&state=' + encodeURIComponent(uid);
}

/**
 * Procesa el código OAuth recibido del callback y guarda los tokens.
 * @param {string} uid
 * @param {string} code — código del callback OAuth
 * @returns {{ access_token, seller_id }}
 */
async function handleCallback(uid, code) {
  if (!uid || !code) throw new Error('parametros_requeridos');
  const { appId, secret, redirectUri } = _getEnv();
  if (!appId || !secret || !redirectUri) throw new Error('ml_env_no_configurado');

  const res = await _fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code'
      + '&client_id=' + appId
      + '&client_secret=' + secret
      + '&code=' + code
      + '&redirect_uri=' + encodeURIComponent(redirectUri),
  });
  if (!res.ok) throw new Error('ml_auth_failed:' + res.status);
  const data = await res.json();

  const tokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: Date.now() + (data.expires_in || 21600) * 1000,
    seller_id: String(data.user_id || ''),
    nickname: data.nickname || null,
    connectedAt: new Date().toISOString(),
  };
  await _mlDoc(uid).set(tokenData);
  console.log('[ML] handleCallback uid=' + uid.slice(0, 8) + ' seller_id=' + tokenData.seller_id);
  return { access_token: tokenData.access_token, seller_id: tokenData.seller_id };
}

/**
 * Refresca el access token usando el refresh token almacenado.
 * @param {string} uid
 * @returns {string} nuevo access_token
 */
async function refreshToken(uid) {
  const data = await _getTokenData(uid);
  if (!data) throw new Error('ml_no_conectado');
  if (!data.refresh_token) throw new Error('ml_refresh_sin_token');
  const { appId, secret } = _getEnv();
  if (!appId || !secret) throw new Error('ml_env_no_configurado');

  const res = await _fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token'
      + '&client_id=' + appId
      + '&client_secret=' + secret
      + '&refresh_token=' + data.refresh_token,
  });
  if (!res.ok) throw new Error('ml_refresh_failed:' + res.status);
  const newData = await res.json();

  const updated = {
    access_token: newData.access_token,
    refresh_token: newData.refresh_token || data.refresh_token,
    expires_at: Date.now() + (newData.expires_in || 21600) * 1000,
  };
  await _mlDoc(uid).set(updated, { merge: true });
  console.log('[ML] refreshToken uid=' + uid.slice(0, 8));
  return updated.access_token;
}

/**
 * Verifica si el owner tiene ML conectado.
 * @param {string} uid
 * @returns {boolean}
 */
async function isConnected(uid) {
  if (!uid) return false;
  const data = await _getTokenData(uid);
  return !!(data && data.access_token);
}

// ── PRODUCTOS / LISTINGS ──────────────────────────────────────────────────────
/**
 * Lista las publicaciones del vendedor.
 * @param {string} uid
 * @param {{ limit, offset }} opts
 * @returns {Array}
 */
async function getMyListings(uid, opts) {
  const o = opts || {};
  const sellerId = await _getSellerId(uid);
  const limit = Math.min(parseInt(o.limit) || 20, MAX_LISTING_LIMIT);
  const offset = parseInt(o.offset) || 0;
  const search = await _mlGet(uid, '/users/' + sellerId + '/items/search?limit=' + limit + '&offset=' + offset);
  const itemIds = search.results || [];
  if (itemIds.length === 0) return [];
  const ids = itemIds.slice(0, 20).join(',');
  const details = await _mlGet(uid, '/items?ids=' + ids);
  return (details || []).map(function (d) {
    const body = d.body || {};
    return {
      id: body.id || '',
      title: body.title || '',
      price: body.price || 0,
      available_quantity: body.available_quantity || 0,
      status: body.status || 'unknown',
      permalink: body.permalink || null,
    };
  });
}

/**
 * Detalle de una publicación específica.
 * @param {string} uid
 * @param {string} itemId
 * @returns {object}
 */
async function getListing(uid, itemId) {
  if (!itemId) throw new Error('itemId_requerido');
  const data = await _mlGet(uid, '/items/' + itemId);
  return {
    id: data.id || '',
    title: data.title || '',
    price: data.price || 0,
    available_quantity: data.available_quantity || 0,
    status: data.status || 'unknown',
    attributes: Array.isArray(data.attributes) ? data.attributes : [],
  };
}

/**
 * Actualiza el stock de una publicación.
 * @param {string} uid
 * @param {string} itemId
 * @param {number} cantidad
 * @returns {{ ok: true }}
 */
async function updateStock(uid, itemId, cantidad) {
  if (!itemId) throw new Error('itemId_requerido');
  if (typeof cantidad !== 'number' || cantidad < 0) throw new Error('cantidad_invalida');
  await _mlPut(uid, '/items/' + itemId, { available_quantity: cantidad });
  console.log('[ML] updateStock uid=' + uid.slice(0, 8) + ' item=' + itemId + ' qty=' + cantidad);
  return { ok: true };
}

/**
 * Actualiza el precio de una publicación.
 * @param {string} uid
 * @param {string} itemId
 * @param {number} precio
 * @returns {{ ok: true }}
 */
async function updatePrice(uid, itemId, precio) {
  if (!itemId) throw new Error('itemId_requerido');
  if (typeof precio !== 'number' || precio <= 0) throw new Error('precio_invalido');
  await _mlPut(uid, '/items/' + itemId, { price: precio });
  console.log('[ML] updatePrice uid=' + uid.slice(0, 8) + ' item=' + itemId + ' price=' + precio);
  return { ok: true };
}

// ── PREGUNTAS ─────────────────────────────────────────────────────────────────
/**
 * Obtiene las preguntas pendientes (sin responder) del vendedor.
 * @param {string} uid
 * @returns {Array}
 */
async function getPendingQuestions(uid) {
  const sellerId = await _getSellerId(uid);
  const data = await _mlGet(uid, '/questions/search?seller_id=' + sellerId + '&status=UNANSWERED');
  const questions = data.questions || [];
  return questions.map(function (q) {
    return {
      id: q.id,
      item_id: q.item_id || null,
      text: q.text || '',
      date_created: q.date_created || null,
      from: q.from ? { nickname: q.from.nickname || '' } : null,
    };
  });
}

/**
 * Responde una pregunta de un comprador.
 * @param {string} uid
 * @param {string|number} questionId
 * @param {string} respuesta
 * @returns {{ ok: true }}
 */
async function answerQuestion(uid, questionId, respuesta) {
  if (!questionId) throw new Error('questionId_requerido');
  if (!respuesta || !respuesta.trim()) throw new Error('respuesta_requerida');
  await _mlPost(uid, '/answers', { question_id: questionId, text: respuesta.trim() });
  await _mlAnsweredCol(uid).doc(String(questionId)).set({
    questionId,
    respuesta: respuesta.trim(),
    answeredAt: new Date().toISOString(),
  });
  console.log('[ML-AUTO-ANSWER] uid=' + uid.slice(0, 8) + ' questionId=' + questionId + ' resp=' + respuesta.slice(0, 50));
  return { ok: true };
}

// ── VENTAS Y MÉTRICAS ─────────────────────────────────────────────────────────
/**
 * Obtiene ventas recientes del vendedor.
 * @param {string} uid
 * @param {{ days }} opts
 * @returns {Array}
 */
async function getRecentSales(uid, opts) {
  const o = opts || {};
  const days = parseInt(o.days) || DEFAULT_SALES_DAYS;
  const sellerId = await _getSellerId(uid);
  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const data = await _mlGet(uid, '/orders/search?seller=' + sellerId + '&order.date_created.from=' + dateFrom);
  const results = data.results || [];
  return results.map(function (ord) {
    return {
      id: ord.id,
      status: ord.status || '',
      total_amount: ord.total_amount || 0,
      currency_id: ord.currency_id || 'ARS',
      date_created: ord.date_created || null,
      buyer: ord.buyer ? { nickname: ord.buyer.nickname || '' } : null,
    };
  });
}

/**
 * Obtiene métricas de reputación y ventas del vendedor.
 * @param {string} uid
 * @returns {{ total_ventas, reputacion, visitas, nickname }}
 */
async function getSaleMetrics(uid) {
  const sellerId = await _getSellerId(uid);
  const data = await _mlGet(uid, '/users/' + sellerId);
  const rep = data.seller_reputation || {};
  return {
    total_ventas: (rep.transactions && rep.transactions.total) || 0,
    reputacion: rep.level_id || null,
    visitas: data.site_status || null,
    nickname: data.nickname || null,
  };
}

// ── ENVÍOS ────────────────────────────────────────────────────────────────────
/**
 * Lista envíos del vendedor, opcionalmente filtrados por status.
 * @param {string} uid
 * @param {{ status }} opts
 * @returns {Array}
 */
async function getShipments(uid, opts) {
  const o = opts || {};
  const sellerId = await _getSellerId(uid);
  let path = '/shipments/search?seller_id=' + sellerId;
  if (o.status) path += '&status=' + encodeURIComponent(o.status);
  const data = await _mlGet(uid, path);
  const results = data.results || [];
  return results.map(function (s) {
    return {
      id: s.id,
      status: s.status || '',
      tracking_number: s.tracking_number || null,
      date_created: s.date_created || null,
      receiver_city: (s.receiver_address && s.receiver_address.city && s.receiver_address.city.name) || null,
    };
  });
}

/**
 * Obtiene el tracking de un envío específico.
 * @param {string} uid
 * @param {string|number} shipmentId
 * @returns {object}
 */
async function getShipmentTracking(uid, shipmentId) {
  if (!shipmentId) throw new Error('shipmentId_requerido');
  const data = await _mlGet(uid, '/shipments/' + shipmentId);
  return {
    id: data.id || shipmentId,
    status: data.status || '',
    tracking_number: data.tracking_number || null,
    substatus: data.substatus || null,
    last_updated: data.last_updated || null,
  };
}

module.exports = {
  getAuthUrl,
  handleCallback,
  refreshToken,
  isConnected,
  getMyListings,
  getListing,
  updateStock,
  updatePrice,
  getPendingQuestions,
  answerQuestion,
  getRecentSales,
  getSaleMetrics,
  getShipments,
  getShipmentTracking,
  TOKEN_REFRESH_BUFFER_MS,
  ML_API_BASE,
  ML_AUTH_BASE,
  __setFirestoreForTests,
  __setFetchForTests,
};
