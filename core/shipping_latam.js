'use strict';

/**
 * R23 — core/shipping_latam.js (Piso 4 P4.2)
 * Integración carriers LATAM: Servientrega (CO), Andreani (AR), DHL (global).
 * Consulta tarifas, crea envíos, rastrea estado por carrier segun country_code.
 * Schema Firestore: owners/{uid}/shipments/{shipmentId}
 */

const CARRIERS = Object.freeze({
  servientrega: 'servientrega',
  andreani: 'andreani',
  dhl: 'dhl',
});

const COUNTRY_DEFAULT_CARRIER = Object.freeze({
  CO: 'servientrega',
  AR: 'andreani',
});

const DEFAULT_CARRIER = 'dhl';

const VALID_STATUSES = Object.freeze([
  'pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned',
]);

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

let _fetch = /* istanbul ignore next */ function () { return require('node-fetch')(...arguments); };
function __setFetchForTests(fn) { _fetch = fn; }

// ── ENV helpers ───────────────────────────────────────────────────────────────
let _getEnv = /* istanbul ignore next */ function () {
  return {
    servientregaKey: process.env.SERVIENTREGA_API_KEY || null,
    andreaniUser: process.env.ANDREANI_USER || null,
    andreaniPass: process.env.ANDREANI_PASS || null,
    dhlKey: process.env.DHL_API_KEY || null,
    dhlSecret: process.env.DHL_API_SECRET || null,
  };
};
function __setEnvForTests(fn) { _getEnv = fn; }

// ── Firestore helpers ─────────────────────────────────────────────────────────
function _shipmentsCol(uid) {
  return db().collection('owners').doc(uid).collection('shipments');
}

// ── Carrier resolution ────────────────────────────────────────────────────────
/**
 * Resuelve el carrier para un pais dado.
 * @param {string} countryCode - 'CO', 'AR', etc.
 * @param {string} [preferredCarrier] - override
 * @returns {string} carrier name
 */
function resolveCarrier(countryCode, preferredCarrier) {
  if (preferredCarrier && CARRIERS[preferredCarrier]) return preferredCarrier;
  const cc = (countryCode || '').toUpperCase();
  return COUNTRY_DEFAULT_CARRIER[cc] || DEFAULT_CARRIER;
}

// ── Servientrega ──────────────────────────────────────────────────────────────
async function _servientregaGetRate(origin, destination, weightKg, dimensions) {
  const env = _getEnv();
  if (!env.servientregaKey) throw new Error('servientrega_key_no_configurado');
  const body = {
    origen: origin,
    destino: destination,
    peso: weightKg,
    largo: (dimensions && dimensions.largo) || 10,
    ancho: (dimensions && dimensions.ancho) || 10,
    alto: (dimensions && dimensions.alto) || 10,
  };
  const res = await _fetch('https://api.servientrega.com/v1/tarifas', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.servientregaKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('servientrega_api_error:' + res.status);
  const data = await res.json();
  return { carrier: 'servientrega', precio: data.valor || 0, moneda: 'COP', dias: data.dias_habiles || null };
}

async function _servientregaCreateShipment(uid, payload) {
  const env = _getEnv();
  if (!env.servientregaKey) throw new Error('servientrega_key_no_configurado');
  const res = await _fetch('https://api.servientrega.com/v1/envios', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.servientregaKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('servientrega_create_error:' + res.status);
  const data = await res.json();
  return { carrier: 'servientrega', trackingNumber: data.numero_guia || '', shipmentId: data.id || '' };
}

async function _servientregaTrack(trackingNumber) {
  const env = _getEnv();
  if (!env.servientregaKey) throw new Error('servientrega_key_no_configurado');
  const res = await _fetch('https://api.servientrega.com/v1/rastreo/' + trackingNumber, {
    headers: { 'Authorization': 'Bearer ' + env.servientregaKey },
  });
  if (!res.ok) throw new Error('servientrega_track_error:' + res.status);
  const data = await res.json();
  return {
    carrier: 'servientrega',
    trackingNumber,
    status: _normalizeStatus(data.estado || ''),
    lastUpdate: data.fecha_actualizacion || null,
    location: data.ciudad_actual || null,
  };
}

// ── Andreani ──────────────────────────────────────────────────────────────────
function _andreaniAuthHeader() {
  const env = _getEnv();
  if (!env.andreaniUser || !env.andreaniPass) throw new Error('andreani_creds_no_configurado');
  const token = Buffer.from(env.andreaniUser + ':' + env.andreaniPass).toString('base64');
  return 'Basic ' + token;
}

async function _andreaniGetRate(origin, destination, weightKg) {
  const auth = _andreaniAuthHeader();
  const res = await _fetch(
    'https://apis.andreani.com/v1/tarifas?origen=' + encodeURIComponent(origin) +
    '&destino=' + encodeURIComponent(destination) + '&peso=' + weightKg,
    { headers: { 'Authorization': auth } }
  );
  if (!res.ok) throw new Error('andreani_api_error:' + res.status);
  const data = await res.json();
  return { carrier: 'andreani', precio: data.precio || 0, moneda: 'ARS', dias: data.plazo_dias || null };
}

async function _andreaniCreateShipment(uid, payload) {
  const auth = _andreaniAuthHeader();
  const res = await _fetch('https://apis.andreani.com/v1/envios', {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('andreani_create_error:' + res.status);
  const data = await res.json();
  return { carrier: 'andreani', trackingNumber: data.numero_andreani || '', shipmentId: data.id || '' };
}

async function _andreaniTrack(trackingNumber) {
  const auth = _andreaniAuthHeader();
  const res = await _fetch('https://apis.andreani.com/v1/envios/' + trackingNumber, {
    headers: { 'Authorization': auth },
  });
  if (!res.ok) throw new Error('andreani_track_error:' + res.status);
  const data = await res.json();
  return {
    carrier: 'andreani',
    trackingNumber,
    status: _normalizeStatus(data.estado || ''),
    lastUpdate: data.ultima_actualizacion || null,
    location: data.sucursal_actual || null,
  };
}

// ── DHL ───────────────────────────────────────────────────────────────────────
async function _dhlGetRate(origin, destination, weightKg, countryCode) {
  const env = _getEnv();
  if (!env.dhlKey) throw new Error('dhl_key_no_configurado');
  const res = await _fetch(
    'https://api.dhl.com/rates?fromCountry=' + (countryCode || 'CO') +
    '&toCountry=' + destination + '&weight=' + weightKg,
    { headers: { 'DHL-API-Key': env.dhlKey } }
  );
  if (!res.ok) throw new Error('dhl_api_error:' + res.status);
  const data = await res.json();
  const product = (data.products && data.products[0]) || {};
  return {
    carrier: 'dhl',
    precio: (product.totalPrice && product.totalPrice[0] && product.totalPrice[0].price) || 0,
    moneda: (product.totalPrice && product.totalPrice[0] && product.totalPrice[0].priceCurrency) || 'USD',
    dias: (product.deliveryCapabilities && product.deliveryCapabilities.estimatedDeliveryDateAndTime) || null,
  };
}

async function _dhlCreateShipment(uid, payload) {
  const env = _getEnv();
  if (!env.dhlKey || !env.dhlSecret) throw new Error('dhl_creds_no_configurado');
  const res = await _fetch('https://api.dhl.com/shipments', {
    method: 'POST',
    headers: {
      'DHL-API-Key': env.dhlKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('dhl_create_error:' + res.status);
  const data = await res.json();
  const shipmentRef = (data.shipmentTrackingNumber) || '';
  return { carrier: 'dhl', trackingNumber: shipmentRef, shipmentId: shipmentRef };
}

async function _dhlTrack(trackingNumber) {
  const env = _getEnv();
  if (!env.dhlKey) throw new Error('dhl_key_no_configurado');
  const res = await _fetch('https://api.dhl.com/track/shipments?trackingNumber=' + trackingNumber, {
    headers: { 'DHL-API-Key': env.dhlKey },
  });
  if (!res.ok) throw new Error('dhl_track_error:' + res.status);
  const data = await res.json();
  const shipment = (data.shipments && data.shipments[0]) || {};
  const events = shipment.events || [];
  const lastEvent = events[0] || {};
  return {
    carrier: 'dhl',
    trackingNumber,
    status: _normalizeStatus(shipment.status || ''),
    lastUpdate: lastEvent.timestamp || null,
    location: (lastEvent.location && lastEvent.location.address && lastEvent.location.address.addressLocality) || null,
  };
}

// ── Status normalization ──────────────────────────────────────────────────────
const STATUS_MAP = {
  // Servientrega
  'en_transito': 'in_transit',
  'recogido': 'picked_up',
  'entregado': 'delivered',
  'devuelto': 'returned',
  'novedad': 'failed',
  // Andreani
  'en transito': 'in_transit',
  'entregada': 'delivered',
  'devuelta': 'returned',
  // DHL
  'transit': 'in_transit',
  'delivered': 'delivered',
  'failure': 'failed',
  'returned': 'returned',
  'unknown': 'pending',
};

function _normalizeStatus(rawStatus) {
  const key = (rawStatus || '').toLowerCase().trim();
  return STATUS_MAP[key] || 'pending';
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Obtiene tarifa de envio para el carrier correspondiente al pais.
 * @param {string} countryCode - 'CO', 'AR', etc.
 * @param {string} origin - ciudad/codigo origen
 * @param {string} destination - ciudad/codigo destino
 * @param {number} weightKg
 * @param {object} [dimensions] - {largo, ancho, alto} en cm (solo Servientrega)
 * @param {string} [preferredCarrier]
 * @returns {{ carrier, precio, moneda, dias }}
 */
async function getShippingRate(countryCode, origin, destination, weightKg, dimensions, preferredCarrier) {
  if (!origin || !destination) throw new Error('origin_destination_requeridos');
  if (typeof weightKg !== 'number' || weightKg <= 0) throw new Error('peso_invalido');
  const carrier = resolveCarrier(countryCode, preferredCarrier);
  if (carrier === 'servientrega') return _servientregaGetRate(origin, destination, weightKg, dimensions);
  if (carrier === 'andreani') return _andreaniGetRate(origin, destination, weightKg);
  return _dhlGetRate(origin, destination, weightKg, countryCode);
}

/**
 * Crea un envio con el carrier correspondiente y lo guarda en Firestore.
 * @param {string} uid
 * @param {string} countryCode
 * @param {object} shipmentData - { origin, destination, weightKg, recipient, items, ... }
 * @param {string} [preferredCarrier]
 * @returns {{ carrier, trackingNumber, shipmentId, firestoreId }}
 */
async function createShipment(uid, countryCode, shipmentData, preferredCarrier) {
  if (!uid) throw new Error('uid_requerido');
  if (!shipmentData || !shipmentData.origin || !shipmentData.destination) {
    throw new Error('shipment_data_incompleto');
  }
  const carrier = resolveCarrier(countryCode, preferredCarrier);
  let result;
  if (carrier === 'servientrega') {
    result = await _servientregaCreateShipment(uid, shipmentData);
  } else if (carrier === 'andreani') {
    result = await _andreaniCreateShipment(uid, shipmentData);
  } else {
    result = await _dhlCreateShipment(uid, shipmentData);
  }
  const docRef = await _shipmentsCol(uid).add({
    carrier: result.carrier,
    trackingNumber: result.trackingNumber,
    externalShipmentId: result.shipmentId,
    countryCode: countryCode || null,
    shipmentData,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  console.log('[SHIPPING] uid=' + uid.slice(0, 8) + ' carrier=' + carrier + ' track=' + result.trackingNumber);
  return { ...result, firestoreId: docRef.id };
}

/**
 * Rastrea el estado de un envio.
 * @param {string} carrier - 'servientrega' | 'andreani' | 'dhl'
 * @param {string} trackingNumber
 * @returns {{ carrier, trackingNumber, status, lastUpdate, location }}
 */
async function trackShipment(carrier, trackingNumber) {
  if (!carrier || !CARRIERS[carrier]) throw new Error('carrier_invalido: ' + carrier);
  if (!trackingNumber) throw new Error('trackingNumber_requerido');
  if (carrier === 'servientrega') return _servientregaTrack(trackingNumber);
  if (carrier === 'andreani') return _andreaniTrack(trackingNumber);
  return _dhlTrack(trackingNumber);
}

/**
 * Actualiza el status de un envio en Firestore tras consultar al carrier.
 * @param {string} uid
 * @param {string} firestoreId
 * @returns {{ firestoreId, status, trackingNumber }}
 */
async function syncShipmentStatus(uid, firestoreId) {
  if (!uid) throw new Error('uid_requerido');
  if (!firestoreId) throw new Error('firestoreId_requerido');
  const docRef = _shipmentsCol(uid).doc(firestoreId);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error('shipment_no_encontrado');
  const data = snap.data();
  const tracking = await trackShipment(data.carrier, data.trackingNumber);
  await docRef.set({ status: tracking.status, lastSyncAt: new Date().toISOString() }, { merge: true });
  console.log('[SHIPPING] sync uid=' + uid.slice(0, 8) + ' id=' + firestoreId + ' status=' + tracking.status);
  return { firestoreId, status: tracking.status, trackingNumber: data.trackingNumber };
}

module.exports = {
  resolveCarrier,
  getShippingRate,
  createShipment,
  trackShipment,
  syncShipmentStatus,
  CARRIERS,
  COUNTRY_DEFAULT_CARRIER,
  DEFAULT_CARRIER,
  VALID_STATUSES,
  __setFirestoreForTests,
  __setFetchForTests,
  __setEnvForTests,
  _normalizeStatus,
};
