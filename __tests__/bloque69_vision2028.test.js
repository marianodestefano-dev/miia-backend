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
    doc: id => ({ get: async () => makeDoc(docs.find(d => d.id === id) || null), set: async () => {}, update: async () => {}, collection: () => makeCol([]) }),
    where: () => ({ get: async () => snap, forEach: fn => snap.forEach(fn), size: docs.length }),
    get: async () => snap,
    add: async () => ({ id: 'new-id' })
  };
}

// ─── voice_call ─────────────────────────────────────────────
const vc = require('../core/voice_call');

describe('voice_call -- T441-T443', () => {
  test('VOICE_CALL_STATUS frozen with 5 statuses', () => {
    expect(Object.isFrozen(vc.VOICE_CALL_STATUS)).toBe(true);
    expect(vc.VOICE_CALL_STATUS.length).toBe(5);
  });
  test('CALL_DIRECTION frozen', () => {
    expect(Object.isFrozen(vc.CALL_DIRECTION)).toBe(true);
    expect(vc.CALL_DIRECTION).toContain('inbound');
  });
  test('receiveCall -- creates incoming call record', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    vc.__setFirestoreForTests(db);
    const r = await vc.receiveCall('uid1', '+573001234567', { durationSeconds: 120 });
    expect(r.status).toBe('incoming');
    expect(r.direction).toBe('inbound');
    expect(r.id).toBeDefined();
  });
  test('transcribeCall -- stores transcript and returns summary', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    vc.__setFirestoreForTests(db);
    const r = await vc.transcribeCall('uid1', 'call1', 'El cliente quiere agendar una cita para el martes');
    expect(r.transcribed).toBe(true);
    expect(r.summary.length).toBeGreaterThan(0);
  });
  test('initiateOutboundCall -- creates outbound record', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    vc.__setFirestoreForTests(db);
    const r = await vc.initiateOutboundCall('uid1', '+573001234567', 'Hola, te llamo para confirmar tu cita');
    expect(r.direction).toBe('outbound');
    expect(r.status).toBe('outbound');
  });
  test('detectUrgencyInTone -- detects urgency words', () => {
    const r = vc.detectUrgencyInTone('necesito que vengan urgente es una emergencia');
    expect(r.urgent).toBe(true);
    expect(r.signals.length).toBeGreaterThan(0);
  });
  test('detectUrgencyInTone -- no urgency in normal text', () => {
    const r = vc.detectUrgencyInTone('quiero saber los precios del servicio');
    expect(r.urgent).toBe(false);
  });
});

// ─── email_marketing ────────────────────────────────────────
const em = require('../core/email_marketing');

describe('email_marketing -- T444-T446', () => {
  test('EMAIL_TEMPLATE_CATEGORIES frozen with 5 categories', () => {
    expect(Object.isFrozen(em.EMAIL_TEMPLATE_CATEGORIES)).toBe(true);
    expect(em.EMAIL_TEMPLATE_CATEGORIES.length).toBe(5);
  });
  test('CAMPAIGN_STATUS frozen', () => {
    expect(Object.isFrozen(em.CAMPAIGN_STATUS)).toBe(true);
    expect(em.CAMPAIGN_STATUS).toContain('scheduled');
  });
  test('createCampaign -- creates draft campaign', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    em.__setFirestoreForTests(db);
    const r = await em.createCampaign('uid1', { name: 'Promo Mayo', subject: 'Oferta especial', body: 'Hola {nombre}', targetSegment: 'leads' });
    expect(r.status).toBe('draft');
    expect(r.name).toBe('Promo Mayo');
    expect(r.id).toBeDefined();
  });
  test('createEmailTemplate -- valid category stores template', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    em.__setFirestoreForTests(db);
    const r = await em.createEmailTemplate('uid1', { name: 'Bienvenida', content: 'Hola {nombre}!', variables: ['nombre'], category: 'onboarding' });
    expect(r.category).toBe('onboarding');
    expect(r.id).toBeDefined();
  });
  test('createEmailTemplate -- invalid category throws', async () => {
    em.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(em.createEmailTemplate('uid1', { name: 'X', content: 'X', category: 'spam' })).rejects.toThrow('Invalid category');
  });
  test('renderEmailTemplate -- replaces variables', () => {
    const r = em.renderEmailTemplate('Hola {nombre}, bienvenido a {empresa}', { nombre: 'Juan', empresa: 'MIIA' });
    expect(r).toBe('Hola Juan, bienvenido a MIIA');
  });
  test('scheduleEmailWACampaign -- creates coordinated campaign', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    em.__setFirestoreForTests(db);
    const r = await em.scheduleEmailWACampaign('uid1', { emailCampaignId: 'c1', waMessage: 'Revisa tu email!', sendAtISO: '2026-05-02T10:00:00Z' });
    expect(r.status).toBe('scheduled');
    expect(r.emailCampaignId).toBe('c1');
  });
  test('getCampaignStats -- calculates openRate', async () => {
    const campaigns = [{ id: 'c1', name: 'Promo', sentCount: 100, openCount: 35, status: 'completed' }];
    const db = { collection: () => makeCol(campaigns) };
    em.__setFirestoreForTests(db);
    const r = await em.getCampaignStats('uid1', 'c1');
    expect(r.openRate).toBe(0.35);
    expect(r.sentCount).toBe(100);
  });
});

// ─── miia_platform ──────────────────────────────────────────
const mp = require('../core/miia_platform');

describe('miia_platform -- T447-T449', () => {
  test('PLUGIN_STATUS frozen', () => {
    expect(Object.isFrozen(mp.PLUGIN_STATUS)).toBe(true);
    expect(mp.PLUGIN_STATUS).toContain('approved');
  });
  test('REVENUE_SHARE_PERCENT is 30', () => {
    expect(mp.REVENUE_SHARE_PERCENT).toBe(30);
  });
  test('registerPlugin -- creates pending_review plugin', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mp.__setFirestoreForTests(db);
    const r = await mp.registerPlugin('uid1', { name: 'CalSync', description: 'Google Calendar sync', apiEndpoint: 'https://calsync.io/api' });
    expect(r.status).toBe('pending_review');
    expect(r.name).toBe('CalSync');
  });
  test('approvePlugin -- sets status to approved', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mp.__setFirestoreForTests(db);
    const r = await mp.approvePlugin('plugin1');
    expect(r.status).toBe('approved');
  });
  test('recordPluginRevenue -- calculates developer and miia shares', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mp.__setFirestoreForTests(db);
    const r = await mp.recordPluginRevenue('plugin1', 10000, 'COP');
    expect(r.miiaShare).toBe(3000);
    expect(r.developerShare).toBe(7000);
  });
  test('listPlugins -- returns approved plugins', async () => {
    const plugins = [{ id: 'p1', name: 'CalSync', status: 'approved' }];
    const db = { collection: () => makeCol(plugins) };
    mp.__setFirestoreForTests(db);
    const r = await mp.listPlugins({ status: 'approved' });
    expect(Array.isArray(r)).toBe(true);
  });
});

// ─── miia_id ────────────────────────────────────────────────
const mid = require('../core/miia_id');

describe('miia_id -- T450-T452', () => {
  test('MIIA_ID_STATUS frozen', () => {
    expect(Object.isFrozen(mid.MIIA_ID_STATUS)).toBe(true);
    expect(mid.MIIA_ID_STATUS).toContain('active');
  });
  test('createMiiaId -- creates new ID when phone not exists', async () => {
    const db = { collection: () => makeCol([]) };
    mid.__setFirestoreForTests(db);
    const r = await mid.createMiiaId('+573001234567', { name: 'Juan Perez', email: 'juan@test.com' });
    expect(r.status).toBe('active');
    expect(r.phone).toBe('+573001234567');
    expect(r.id).toBeDefined();
  });
  test('getMiiaProfile -- existing ID returns data', async () => {
    const idData = { id: 'mid1', phone: '+573001234567', status: 'active', authorizedOwners: [] };
    const db = { collection: () => ({ doc: id => ({ get: async () => makeDoc(idData) }) }) };
    mid.__setFirestoreForTests(db);
    const r = await mid.getMiiaProfile('mid1');
    expect(r.phone).toBe('+573001234567');
  });
  test('getMiiaProfile -- non-existent throws', async () => {
    const db = { collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) };
    mid.__setFirestoreForTests(db);
    await expect(mid.getMiiaProfile('nonexistent')).rejects.toThrow('MIIA ID not found');
  });
  test('authorizeProfileShare -- adds owner to authorizedOwners', async () => {
    const idData = { id: 'mid1', phone: '+573001234567', status: 'active', authorizedOwners: [] };
    const db = { collection: () => ({ doc: id => ({ get: async () => makeDoc(idData), set: async () => {} }) }) };
    mid.__setFirestoreForTests(db);
    const r = await mid.authorizeProfileShare('mid1', 'uid1');
    expect(r.authorized).toBe(true);
    expect(r.targetUid).toBe('uid1');
  });
  test('getSSOToken -- returns base64 token with expiresIn', () => {
    const r = mid.getSSOToken('uid1');
    expect(r.uid).toBe('uid1');
    expect(r.expiresIn).toBe(3600);
    expect(typeof r.token).toBe('string');
    expect(r.token.length).toBeGreaterThan(0);
  });
});

// ─── market_intelligence ────────────────────────────────────
const mi = require('../core/market_intelligence');

describe('market_intelligence -- T453-T455', () => {
  test('INTELLIGENCE_TYPES frozen', () => {
    expect(Object.isFrozen(mi.INTELLIGENCE_TYPES)).toBe(true);
    expect(mi.INTELLIGENCE_TYPES).toContain('trend');
  });
  test('recordTrend -- stores entry with id', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mi.__setFirestoreForTests(db);
    const r = await mi.recordTrend('salud', 'avg_ticket', 85000);
    expect(r.sector).toBe('salud');
    expect(r.value).toBe(85000);
    expect(r.id).toBeDefined();
  });
  test('getTrends -- returns trends for sector', async () => {
    const db = { collection: () => makeCol([{ id: 't1', sector: 'salud', metric: 'avg_ticket', value: 85000 }]) };
    mi.__setFirestoreForTests(db);
    const r = await mi.getTrends('salud', {});
    expect(r.sector).toBe('salud');
    expect(Array.isArray(r.trends)).toBe(true);
  });
  test('alertCompetitor -- creates active alert', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mi.__setFirestoreForTests(db);
    const r = await mi.alertCompetitor('uid1', { competitorName: 'OtroBot', triggerType: 'new_activation' });
    expect(r.status).toBe('active');
    expect(r.competitorName).toBe('OtroBot');
  });
  test('predictDemand -- high season multiplies by 1.4', () => {
    const r = mi.predictDemand({ season: 'high', historicalAvg: 100 });
    expect(r.predicted).toBe(140);
    expect(r.level).toBe('high');
  });
  test('predictDemand -- low season reduces demand', () => {
    const r = mi.predictDemand({ season: 'low', historicalAvg: 100 });
    expect(r.predicted).toBe(70);
    expect(r.level).toBe('low');
  });
  test('getPriceRecommendation -- surge demand increases price', () => {
    const r = mi.getPriceRecommendation({ demand: 'surge', competitorAvgPrice: 100000 });
    expect(r.recommendedPrice).toBeGreaterThan(100000);
    expect(r.demand).toBe('surge');
  });
  test('getPriceRecommendation -- low demand reduces price', () => {
    const r = mi.getPriceRecommendation({ demand: 'low', competitorAvgPrice: 100000 });
    expect(r.recommendedPrice).toBeLessThan(100000);
  });
});

// ─── miia_ai_engine ─────────────────────────────────────────
const mae = require('../core/miia_ai_engine');

describe('miia_ai_engine -- T456-T458', () => {
  test('AI_MODELS frozen with 3 models', () => {
    expect(Object.isFrozen(mae.AI_MODELS)).toBe(true);
    expect(mae.AI_MODELS.length).toBe(3);
    expect(mae.AI_MODELS).toContain('gemini-1.5-pro');
  });
  test('AB_TEST_METRICS frozen', () => {
    expect(Object.isFrozen(mae.AB_TEST_METRICS)).toBe(true);
    expect(mae.AB_TEST_METRICS).toContain('latency_ms');
  });
  test('recordFineTuningData -- stores entry unapproved', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mae.__setFirestoreForTests(db);
    const r = await mae.recordFineTuningData('uid1', { input: 'Cuanto cuesta?', expectedOutput: 'El precio es $50.000' });
    expect(r.approved).toBe(false);
    expect(r.id).toBeDefined();
  });
  test('scheduleABTest -- valid models creates test', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mae.__setFirestoreForTests(db);
    const r = await mae.scheduleABTest('uid1', { modelA: 'gemini-1.5-pro', modelB: 'miia-v1-finetuned', metric: 'response_quality' });
    expect(r.status).toBe('scheduled');
    expect(r.modelA).toBe('gemini-1.5-pro');
  });
  test('scheduleABTest -- invalid model throws', async () => {
    mae.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(mae.scheduleABTest('uid1', { modelA: 'gpt-4', modelB: 'miia-v1-finetuned', metric: 'latency_ms' })).rejects.toThrow('Invalid modelA');
  });
  test('scheduleABTest -- invalid metric throws', async () => {
    mae.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(mae.scheduleABTest('uid1', { modelA: 'gemini-1.5-pro', modelB: 'miia-v1-finetuned', metric: 'feelings' })).rejects.toThrow('Invalid metric');
  });
  test('getRecommendedModel -- no data returns gemini default', async () => {
    const db = { collection: () => makeCol([]) };
    mae.__setFirestoreForTests(db);
    const r = await mae.getRecommendedModel('uid1');
    expect(r.recommendedModel).toBe('gemini-1.5-pro');
    expect(r.reason).toBe('no_ab_data');
  });
  test('recordABTestResult -- stores result for model', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mae.__setFirestoreForTests(db);
    const r = await mae.recordABTestResult('test1', { model: 'miia-v1-finetuned', score: 0.87, latency: 320 });
    expect(r.model).toBe('miia-v1-finetuned');
    expect(r.score).toBe(0.87);
  });
});