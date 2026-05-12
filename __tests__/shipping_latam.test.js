'use strict';

const shipping = require('../core/shipping_latam');
const {
  resolveCarrier,
  getShippingRate,
  createShipment,
  trackShipment,
  syncShipmentStatus,
  CARRIERS,
  _normalizeStatus,
  __setFirestoreForTests,
  __setFetchForTests,
  __setEnvForTests,
} = shipping;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnv(overrides) {
  return Object.assign({
    servientregaKey: 'srv-key-123',
    andreaniUser: 'user',
    andreaniPass: 'pass',
    dhlKey: 'dhl-key-123',
    dhlSecret: 'dhl-secret-456',
  }, overrides || {});
}

function makeFetch(status, jsonBody) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(jsonBody || {}),
  });
}

function makeFetchFail(status) {
  return jest.fn().mockResolvedValue({ ok: false, status });
}

function makeDb(existsFlag, data) {
  const mockSet = jest.fn().mockResolvedValue({});
  const mockAdd = jest.fn().mockResolvedValue({ id: 'firestore-doc-id' });
  const mockGet = jest.fn().mockResolvedValue({ exists: existsFlag, data: () => data || {} });
  const doc = jest.fn(() => ({ get: mockGet, set: mockSet }));
  const col = jest.fn(() => ({ doc, add: mockAdd }));
  const db = { collection: jest.fn(() => ({ doc: jest.fn(() => ({ collection: col })) })) };
  return { db, mockSet, mockAdd, mockGet };
}

beforeEach(() => {
  __setEnvForTests(null);
  __setFetchForTests(null);
  __setFirestoreForTests(null);
});

// ── resolveCarrier ────────────────────────────────────────────────────────────

describe('resolveCarrier', () => {
  test('CO -> servientrega', () => {
    expect(resolveCarrier('CO')).toBe('servientrega');
  });
  test('AR -> andreani', () => {
    expect(resolveCarrier('AR')).toBe('andreani');
  });
  test('MX -> dhl (default)', () => {
    expect(resolveCarrier('MX')).toBe('dhl');
  });
  test('null country -> dhl', () => {
    expect(resolveCarrier(null)).toBe('dhl');
  });
  test('preferredCarrier override', () => {
    expect(resolveCarrier('CO', 'dhl')).toBe('dhl');
  });
  test('preferredCarrier invalido -> resuelve por pais', () => {
    expect(resolveCarrier('CO', 'fedex')).toBe('servientrega');
  });
});

// ── _normalizeStatus ──────────────────────────────────────────────────────────

describe('_normalizeStatus', () => {
  test('en_transito -> in_transit', () => expect(_normalizeStatus('en_transito')).toBe('in_transit'));
  test('entregado -> delivered', () => expect(_normalizeStatus('entregado')).toBe('delivered'));
  test('devuelto -> returned', () => expect(_normalizeStatus('devuelto')).toBe('returned'));
  test('novedad -> failed', () => expect(_normalizeStatus('novedad')).toBe('failed'));
  test('recogido -> picked_up', () => expect(_normalizeStatus('recogido')).toBe('picked_up'));
  test('en transito (andreani) -> in_transit', () => expect(_normalizeStatus('en transito')).toBe('in_transit'));
  test('transit (dhl) -> in_transit', () => expect(_normalizeStatus('transit')).toBe('in_transit'));
  test('failure (dhl) -> failed', () => expect(_normalizeStatus('failure')).toBe('failed'));
  test('unknown -> pending', () => expect(_normalizeStatus('unknown')).toBe('pending'));
  test('desconocido -> pending (fallback)', () => expect(_normalizeStatus('algo_desconocido')).toBe('pending'));
  test('null -> pending', () => expect(_normalizeStatus(null)).toBe('pending'));
  test('uppercase -> normaliza', () => expect(_normalizeStatus('ENTREGADO')).toBe('delivered'));
});

// ── getShippingRate ───────────────────────────────────────────────────────────

describe('getShippingRate', () => {
  test('origin null -> throw', async () => {
    await expect(getShippingRate('CO', null, 'Bogota', 1)).rejects.toThrow('origin_destination_requeridos');
  });
  test('destination null -> throw', async () => {
    await expect(getShippingRate('CO', 'Bogota', null, 1)).rejects.toThrow('origin_destination_requeridos');
  });
  test('peso invalido (0) -> throw', async () => {
    await expect(getShippingRate('CO', 'Bogota', 'Cali', 0)).rejects.toThrow('peso_invalido');
  });
  test('peso invalido (string) -> throw', async () => {
    await expect(getShippingRate('CO', 'Bogota', 'Cali', 'dos')).rejects.toThrow('peso_invalido');
  });

  test('CO -> servientrega rate OK', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { valor: 15000, dias_habiles: 3 }));
    const r = await getShippingRate('CO', 'Bogota', 'Cali', 2);
    expect(r.carrier).toBe('servientrega');
    expect(r.precio).toBe(15000);
    expect(r.moneda).toBe('COP');
    expect(r.dias).toBe(3);
  });

  test('CO servientrega sin key -> throw', async () => {
    __setEnvForTests(() => makeEnv({ servientregaKey: null }));
    await expect(getShippingRate('CO', 'Bogota', 'Cali', 2)).rejects.toThrow('servientrega_key_no_configurado');
  });

  test('CO servientrega API error -> throw', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(500));
    await expect(getShippingRate('CO', 'Bogota', 'Cali', 2)).rejects.toThrow('servientrega_api_error:500');
  });

  test('CO servientrega con dimensions', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { valor: 12000, dias_habiles: 2 }));
    const r = await getShippingRate('CO', 'Bogota', 'Medellin', 1, { largo: 30, ancho: 20, alto: 15 });
    expect(r.carrier).toBe('servientrega');
  });

  test('AR -> andreani rate OK', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { precio: 5000, plazo_dias: 5 }));
    const r = await getShippingRate('AR', 'Buenos Aires', 'Cordoba', 1.5);
    expect(r.carrier).toBe('andreani');
    expect(r.precio).toBe(5000);
    expect(r.moneda).toBe('ARS');
    expect(r.dias).toBe(5);
  });

  test('AR andreani sin creds -> throw', async () => {
    __setEnvForTests(() => makeEnv({ andreaniUser: null, andreaniPass: null }));
    await expect(getShippingRate('AR', 'BA', 'Cordoba', 1)).rejects.toThrow('andreani_creds_no_configurado');
  });

  test('AR andreani API error -> throw', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(503));
    await expect(getShippingRate('AR', 'BA', 'Cordoba', 1)).rejects.toThrow('andreani_api_error:503');
  });

  test('MX -> dhl rate OK', async () => {
    __setEnvForTests(() => makeEnv());
    const dhlResp = {
      products: [{ totalPrice: [{ price: 25, priceCurrency: 'USD' }], deliveryCapabilities: { estimatedDeliveryDateAndTime: '2026-05-15' } }]
    };
    __setFetchForTests(makeFetch(200, dhlResp));
    const r = await getShippingRate('MX', 'MX', 'US', 0.5);
    expect(r.carrier).toBe('dhl');
    expect(r.precio).toBe(25);
    expect(r.moneda).toBe('USD');
  });

  test('DHL sin key -> throw', async () => {
    __setEnvForTests(() => makeEnv({ dhlKey: null }));
    await expect(getShippingRate('MX', 'MX', 'US', 0.5)).rejects.toThrow('dhl_key_no_configurado');
  });

  test('DHL API error -> throw', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(400));
    await expect(getShippingRate('MX', 'MX', 'US', 0.5)).rejects.toThrow('dhl_api_error:400');
  });

  test('DHL rate - sin products -> precio=0', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {}));
    const r = await getShippingRate('MX', 'MX', 'US', 0.5);
    expect(r.precio).toBe(0);
    expect(r.moneda).toBe('USD');
    expect(r.dias).toBeNull();
  });

  test('DHL rate - products[0] sin totalPrice -> precio=0', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { products: [{}] }));
    const r = await getShippingRate('MX', 'MX', 'US', 0.5);
    expect(r.precio).toBe(0);
  });

  test('DHL rate - totalPrice[0] sin price ni currency -> defaults', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { products: [{ totalPrice: [{}] }] }));
    const r = await getShippingRate('MX', 'MX', 'US', 0.5);
    expect(r.precio).toBe(0);
    expect(r.moneda).toBe('USD');
  });

  test('preferredCarrier override dhl para CO', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { products: [{ totalPrice: [{ price: 30, priceCurrency: 'USD' }], deliveryCapabilities: {} }] }));
    const r = await getShippingRate('CO', 'CO', 'MX', 1, null, 'dhl');
    expect(r.carrier).toBe('dhl');
  });
});

// ── createShipment ────────────────────────────────────────────────────────────

describe('createShipment', () => {
  test('uid null -> throw', async () => {
    await expect(createShipment(null, 'CO', { origin: 'A', destination: 'B' })).rejects.toThrow('uid_requerido');
  });
  test('shipmentData null -> throw', async () => {
    await expect(createShipment('uid1', 'CO', null)).rejects.toThrow('shipment_data_incompleto');
  });
  test('shipmentData sin origin -> throw', async () => {
    await expect(createShipment('uid1', 'CO', { destination: 'B' })).rejects.toThrow('shipment_data_incompleto');
  });
  test('shipmentData sin destination -> throw', async () => {
    await expect(createShipment('uid1', 'CO', { origin: 'A' })).rejects.toThrow('shipment_data_incompleto');
  });

  test('CO -> servientrega create OK', async () => {
    const { db, mockAdd } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { numero_guia: 'SRV-001', id: 'ext-id-1' }));
    const r = await createShipment('uid123456', 'CO', { origin: 'Bogota', destination: 'Cali', weightKg: 1 });
    expect(r.carrier).toBe('servientrega');
    expect(r.trackingNumber).toBe('SRV-001');
    expect(r.firestoreId).toBe('firestore-doc-id');
    expect(mockAdd).toHaveBeenCalled();
  });

  test('CO servientrega create - sin key -> throw', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv({ servientregaKey: null }));
    await expect(createShipment('uid123456', 'CO', { origin: 'A', destination: 'B' })).rejects.toThrow('servientrega_key_no_configurado');
  });

  test('CO servientrega create API error -> throw', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(500));
    await expect(createShipment('uid123456', 'CO', { origin: 'A', destination: 'B' })).rejects.toThrow('servientrega_create_error:500');
  });

  test('AR -> andreani create OK', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { numero_andreani: 'AND-001', id: 'ext-id-2' }));
    const r = await createShipment('uid123456', 'AR', { origin: 'BA', destination: 'Cordoba' });
    expect(r.carrier).toBe('andreani');
    expect(r.trackingNumber).toBe('AND-001');
  });

  test('AR andreani create API error -> throw', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(403));
    await expect(createShipment('uid123456', 'AR', { origin: 'BA', destination: 'Cordoba' })).rejects.toThrow('andreani_create_error:403');
  });

  test('MX -> dhl create OK', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { shipmentTrackingNumber: 'DHL-001' }));
    const r = await createShipment('uid123456', 'MX', { origin: 'MX', destination: 'US' });
    expect(r.carrier).toBe('dhl');
    expect(r.trackingNumber).toBe('DHL-001');
  });

  test('DHL create sin dhlSecret -> throw', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv({ dhlKey: null, dhlSecret: null }));
    await expect(createShipment('uid123456', 'MX', { origin: 'MX', destination: 'US' })).rejects.toThrow('dhl_creds_no_configurado');
  });

  test('DHL create API error -> throw', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(422));
    await expect(createShipment('uid123456', 'MX', { origin: 'MX', destination: 'US' })).rejects.toThrow('dhl_create_error:422');
  });

  test('DHL create sin shipmentTrackingNumber -> trackingNumber vacio', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {}));
    const r = await createShipment('uid123456', 'MX', { origin: 'MX', destination: 'US' });
    expect(r.trackingNumber).toBe('');
  });
});

// ── trackShipment ─────────────────────────────────────────────────────────────

describe('trackShipment', () => {
  test('carrier null -> throw', async () => {
    await expect(trackShipment(null, 'TRACK-001')).rejects.toThrow('carrier_invalido');
  });
  test('carrier invalido -> throw', async () => {
    await expect(trackShipment('fedex', 'TRACK-001')).rejects.toThrow('carrier_invalido: fedex');
  });
  test('trackingNumber null -> throw', async () => {
    await expect(trackShipment('dhl', null)).rejects.toThrow('trackingNumber_requerido');
  });

  test('servientrega track OK', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { estado: 'entregado', fecha_actualizacion: '2026-05-10', ciudad_actual: 'Bogota' }));
    const r = await trackShipment('servientrega', 'SRV-001');
    expect(r.carrier).toBe('servientrega');
    expect(r.status).toBe('delivered');
    expect(r.location).toBe('Bogota');
  });

  test('servientrega track sin key -> throw', async () => {
    __setEnvForTests(() => makeEnv({ servientregaKey: null }));
    await expect(trackShipment('servientrega', 'SRV-001')).rejects.toThrow('servientrega_key_no_configurado');
  });

  test('servientrega track API error -> throw', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(404));
    await expect(trackShipment('servientrega', 'SRV-001')).rejects.toThrow('servientrega_track_error:404');
  });

  test('servientrega track - estado vacio -> pending', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {}));
    const r = await trackShipment('servientrega', 'SRV-001');
    expect(r.status).toBe('pending');
    expect(r.lastUpdate).toBeNull();
    expect(r.location).toBeNull();
  });

  test('andreani track OK', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { estado: 'en transito', ultima_actualizacion: '2026-05-11', sucursal_actual: 'Rosario' }));
    const r = await trackShipment('andreani', 'AND-001');
    expect(r.carrier).toBe('andreani');
    expect(r.status).toBe('in_transit');
    expect(r.location).toBe('Rosario');
  });

  test('andreani track API error -> throw', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(500));
    await expect(trackShipment('andreani', 'AND-001')).rejects.toThrow('andreani_track_error:500');
  });

  test('andreani track - sin estado -> pending', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {}));
    const r = await trackShipment('andreani', 'AND-001');
    expect(r.status).toBe('pending');
    expect(r.lastUpdate).toBeNull();
    expect(r.location).toBeNull();
  });

  test('dhl track OK', async () => {
    __setEnvForTests(() => makeEnv());
    const dhlResp = {
      shipments: [{
        status: 'transit',
        events: [{ timestamp: '2026-05-11T10:00:00Z', location: { address: { addressLocality: 'Miami' } } }],
      }]
    };
    __setFetchForTests(makeFetch(200, dhlResp));
    const r = await trackShipment('dhl', 'DHL-001');
    expect(r.carrier).toBe('dhl');
    expect(r.status).toBe('in_transit');
    expect(r.lastUpdate).toBe('2026-05-11T10:00:00Z');
    expect(r.location).toBe('Miami');
  });

  test('dhl track sin key -> throw', async () => {
    __setEnvForTests(() => makeEnv({ dhlKey: null }));
    await expect(trackShipment('dhl', 'DHL-001')).rejects.toThrow('dhl_key_no_configurado');
  });

  test('dhl track API error -> throw', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetchFail(404));
    await expect(trackShipment('dhl', 'DHL-001')).rejects.toThrow('dhl_track_error:404');
  });

  test('dhl track - sin shipments -> pending, null', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {}));
    const r = await trackShipment('dhl', 'DHL-001');
    expect(r.status).toBe('pending');
    expect(r.lastUpdate).toBeNull();
    expect(r.location).toBeNull();
  });

  test('dhl track - shipment sin events -> lastUpdate null', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { shipments: [{ status: 'delivered', events: [] }] }));
    const r = await trackShipment('dhl', 'DHL-001');
    expect(r.status).toBe('delivered');
    expect(r.lastUpdate).toBeNull();
    expect(r.location).toBeNull();
  });

  test('dhl track - event sin location.address.addressLocality -> null', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { shipments: [{ status: 'transit', events: [{ timestamp: 'T', location: {} }] }] }));
    const r = await trackShipment('dhl', 'DHL-001');
    expect(r.location).toBeNull();
  });

  test('dhl track - event sin location -> null', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { shipments: [{ status: 'transit', events: [{ timestamp: 'T' }] }] }));
    const r = await trackShipment('dhl', 'DHL-001');
    expect(r.location).toBeNull();
  });
});

// ── syncShipmentStatus ────────────────────────────────────────────────────────

describe('syncShipmentStatus', () => {
  test('uid null -> throw', async () => {
    await expect(syncShipmentStatus(null, 'doc1')).rejects.toThrow('uid_requerido');
  });
  test('firestoreId null -> throw', async () => {
    await expect(syncShipmentStatus('uid1', null)).rejects.toThrow('firestoreId_requerido');
  });

  test('doc no existe -> throw', async () => {
    const { db } = makeDb(false, null);
    __setFirestoreForTests(db);
    await expect(syncShipmentStatus('uid123456', 'doc1')).rejects.toThrow('shipment_no_encontrado');
  });

  test('sync servientrega OK', async () => {
    const docData = { carrier: 'servientrega', trackingNumber: 'SRV-001' };
    const { db, mockSet } = makeDb(true, docData);
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { estado: 'entregado', fecha_actualizacion: '2026-05-12', ciudad_actual: 'Cali' }));
    const r = await syncShipmentStatus('uid123456', 'doc1');
    expect(r.status).toBe('delivered');
    expect(r.trackingNumber).toBe('SRV-001');
    expect(mockSet).toHaveBeenCalled();
  });

  test('sync andreani OK', async () => {
    const docData = { carrier: 'andreani', trackingNumber: 'AND-001' };
    const { db } = makeDb(true, docData);
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { estado: 'devuelta', ultima_actualizacion: '2026-05-11', sucursal_actual: null }));
    const r = await syncShipmentStatus('uid123456', 'doc1');
    expect(r.status).toBe('returned');
  });

  test('sync dhl OK', async () => {
    const docData = { carrier: 'dhl', trackingNumber: 'DHL-001' };
    const { db } = makeDb(true, docData);
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { shipments: [{ status: 'delivered', events: [] }] }));
    const r = await syncShipmentStatus('uid123456', 'doc1');
    expect(r.status).toBe('delivered');
  });
});

// ── Gap branches ──────────────────────────────────────────────────────────────

describe('gap branches: || falsy en returns', () => {
  test('servientrega rate - data.valor y data.dias_habiles ausentes -> 0, null', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {})); // sin valor ni dias_habiles
    const r = await getShippingRate('CO', 'Bogota', 'Cali', 1);
    expect(r.precio).toBe(0);
    expect(r.dias).toBeNull();
  });

  test('servientrega create - numero_guia y id ausentes -> string vacio', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {})); // sin numero_guia ni id
    const r = await createShipment('uid123456', 'CO', { origin: 'A', destination: 'B' });
    expect(r.trackingNumber).toBe('');
    expect(r.shipmentId).toBe('');
  });

  test('andreani rate - data.precio y data.plazo_dias ausentes -> 0, null', async () => {
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {})); // sin precio ni plazo_dias
    const r = await getShippingRate('AR', 'BA', 'Cordoba', 1);
    expect(r.precio).toBe(0);
    expect(r.dias).toBeNull();
  });

  test('andreani create - numero_andreani y id ausentes -> string vacio', async () => {
    const { db } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, {})); // sin numero_andreani ni id
    const r = await createShipment('uid123456', 'AR', { origin: 'BA', destination: 'Cordoba' });
    expect(r.trackingNumber).toBe('');
    expect(r.shipmentId).toBe('');
  });

  test('dhl rate - countryCode null -> usa CO como default en URL', async () => {
    __setEnvForTests(() => makeEnv());
    const fetchMock = makeFetch(200, {});
    __setFetchForTests(fetchMock);
    const r = await getShippingRate(null, 'CO', 'US', 1, null, 'dhl');
    expect(r.carrier).toBe('dhl');
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('fromCountry=CO');
  });

  test('createShipment - countryCode null -> Firestore guarda null', async () => {
    const { db, mockAdd } = makeDb(false, {});
    __setFirestoreForTests(db);
    __setEnvForTests(() => makeEnv());
    __setFetchForTests(makeFetch(200, { numero_guia: 'SRV-001', id: 'ext-1' }));
    const r = await createShipment('uid123456', null, { origin: 'A', destination: 'B' });
    expect(r.firestoreId).toBe('firestore-doc-id');
    const addArg = mockAdd.mock.calls[0][0];
    expect(addArg.countryCode).toBeNull();
  });
});
