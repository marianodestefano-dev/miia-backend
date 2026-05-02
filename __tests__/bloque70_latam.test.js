'use strict';

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : 'doc1' };
}
function makeSnap(docs) {
  const wrapped = docs.map(d => ({ id: d.id || 'id1', data: () => d }));
  return { docs: wrapped, forEach: fn => wrapped.forEach(fn), size: docs.length, empty: docs.length === 0 };
}
function makeCol(docs) {
  docs = docs || [];
  const snap = makeSnap(docs);
  return {
    doc: id => ({ get: async () => makeDoc(docs.find(d => d.id === id) || null), set: async () => {}, update: async () => {} }),
    where: () => ({ get: async () => snap }),
    get: async () => snap
  };
}

// ─── brasil_v2 ──────────────────────────────────────────────
const bv2 = require('../core/brasil_v2');

describe('brasil_v2 -- T461-T462', () => {
  test('BRASIL_V2_FEATURES frozen with 6 features', () => {
    expect(Object.isFrozen(bv2.BRASIL_V2_FEATURES)).toBe(true);
    expect(bv2.BRASIL_V2_FEATURES.length).toBe(6);
    expect(bv2.BRASIL_V2_FEATURES).toContain('pix_native');
  });
  test('BRASIL_DEPLOY_STATUS frozen', () => {
    expect(Object.isFrozen(bv2.BRASIL_DEPLOY_STATUS)).toBe(true);
    expect(bv2.BRASIL_DEPLOY_STATUS).toContain('active');
  });
  test('deployBrasilStandalone -- valid features creates active deployment', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    bv2.__setFirestoreForTests(db);
    const r = await bv2.deployBrasilStandalone('uid1', { features: ['standalone_product', 'pix_native'] });
    expect(r.status).toBe('active');
    expect(r.marketCode).toBe('BR');
    expect(r.id).toBeDefined();
  });
  test('deployBrasilStandalone -- invalid feature throws', async () => {
    bv2.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(bv2.deployBrasilStandalone('uid1', { features: ['blockchain'] })).rejects.toThrow('Invalid Brasil V2 features');
  });
  test('integrateWithLudoMIIA -- creates active integration', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    bv2.__setFirestoreForTests(db);
    const r = await bv2.integrateWithLudoMIIA('uid1', { gameTypes: ['quiz', 'trivia'] });
    expect(r.type).toBe('ludomiia');
    expect(r.status).toBe('active');
    expect(r.region).toBe('BR');
  });
  test('integrateWithMIIADT -- creates miiadt integration with alert channels', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    bv2.__setFirestoreForTests(db);
    const r = await bv2.integrateWithMIIADT('uid1', { alertChannels: ['whatsapp', 'email'] });
    expect(r.type).toBe('miiadt');
    expect(r.alertChannels).toContain('whatsapp');
  });
  test('getBrasilDeployStatus -- no deployment returns not_deployed', async () => {
    const db = { collection: () => makeCol([]) };
    bv2.__setFirestoreForTests(db);
    const r = await bv2.getBrasilDeployStatus('uid1');
    expect(r.status).toBe('not_deployed');
  });
  test('getBrasilMarketSummary -- returns market data', () => {
    const r = bv2.getBrasilMarketSummary();
    expect(r.code).toBe('BR');
    expect(r.currency).toBe('BRL');
    expect(r.language).toBe('pt-BR');
    expect(r.paymentMethods).toContain('Pix');
  });
});

// ─── latam_expansion ────────────────────────────────────────
const le = require('../core/latam_expansion');

describe('latam_expansion -- T463-T469', () => {
  test('LATAM_COUNTRIES frozen with 10 countries', () => {
    expect(Object.isFrozen(le.LATAM_COUNTRIES)).toBe(true);
    expect(Object.keys(le.LATAM_COUNTRIES).length).toBe(10);
  });
  test('MODISMOS frozen with 6 countries', () => {
    expect(Object.isFrozen(le.MODISMOS)).toBe(true);
    expect(Object.keys(le.MODISMOS).length).toBe(6);
  });
  test('getCountryConfig -- CO returns Colombian config', () => {
    const r = le.getCountryConfig('CO');
    expect(r.currency).toBe('COP');
    expect(r.payment).toBe('nequi');
    expect(r.cities.length).toBeGreaterThan(3);
  });
  test('getCountryConfig -- MX has verticals', () => {
    const r = le.getCountryConfig('MX');
    expect(r.verticals).toContain('tacos');
    expect(r.verticals).toContain('lucha_libre');
  });
  test('getCountryConfig -- unsupported country throws', () => {
    expect(() => le.getCountryConfig('US')).toThrow('Country not supported');
  });
  test('getCountryConfig -- CL has compliance', () => {
    const r = le.getCountryConfig('CL');
    expect(r.compliance).toBe('Ley19628');
  });
  test('registerCountryPresence -- valid country stores entry', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    le.__setFirestoreForTests(db);
    const r = await le.registerCountryPresence('uid1', 'MX');
    expect(r.countryCode).toBe('MX');
    expect(r.status).toBe('active');
  });
  test('registerCountryPresence -- invalid country throws', async () => {
    le.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(le.registerCountryPresence('uid1', 'XX')).rejects.toThrow('Country not supported');
  });
  test('processYapePayment -- valid Peru phone processes payment', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    le.__setFirestoreForTests(db);
    const r = await le.processYapePayment('uid1', '+51999887766', 150);
    expect(r.provider).toBe('yape');
    expect(r.currency).toBe('PEN');
    expect(r.status).toBe('processing');
  });
  test('processYapePayment -- non-Peru phone throws', async () => {
    le.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(le.processYapePayment('uid1', '+573001234567', 150)).rejects.toThrow('Yape only available for Peru');
  });
  test('processModoPayment -- valid Argentina phone processes payment', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    le.__setFirestoreForTests(db);
    const r = await le.processModoPayment('uid1', '+541112345678', 5000);
    expect(r.provider).toBe('modo');
    expect(r.currency).toBe('ARS');
  });
  test('processModoPayment -- non-AR phone throws', async () => {
    le.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(le.processModoPayment('uid1', '+573001234567', 5000)).rejects.toThrow('Modo only available for Argentina');
  });
  test('getMultiCountryStats -- returns active country count', async () => {
    const presenceDocs = [{ id: 'p1', uid: 'uid1', countryCode: 'CO', status: 'active' }, { id: 'p2', uid: 'uid1', countryCode: 'MX', status: 'active' }];
    const db = { collection: () => makeCol(presenceDocs) };
    le.__setFirestoreForTests(db);
    const r = await le.getMultiCountryStats('uid1');
    expect(r.count).toBe(2);
    expect(r.activeCountries).toContain('CO');
    expect(r.activeCountries).toContain('MX');
  });
  test('buildLocalizedMessage -- CO greeting uses quiubo', () => {
    const r = le.buildLocalizedMessage('CO', 'greeting', {});
    expect(r.message).toContain('Quiubo');
    expect(r.countryCode).toBe('CO');
  });
  test('buildLocalizedMessage -- MX greeting uses que onda', () => {
    const r = le.buildLocalizedMessage('MX', 'confirmation', {});
    expect(r.message).toContain('Orale');
  });
  test('buildLocalizedMessage -- BR farewell uses tchau', () => {
    const r = le.buildLocalizedMessage('BR', 'farewell', {});
    expect(r.message).toContain('Tchau');
  });
  test('detectModisms -- CO detects quiubo', () => {
    const r = le.detectModisms('Quiubo parcero como estas?', 'CO');
    expect(r.detected.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0);
  });
  test('detectModisms -- unsupported country returns empty', () => {
    const r = le.detectModisms('hello there', 'ZZ');
    expect(r.detected).toEqual([]);
    expect(r.confidence).toBe(0);
  });
});