'use strict';

// ─── Mock helpers ────────────────────────────────────────────
function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : 'doc1' };
}
function makeSnap(docs) {
  const wrapped = docs.map(d => ({ id: d.id || 'id1', data: () => d }));
  return { docs: wrapped, forEach: fn => wrapped.forEach(fn), size: docs.length, empty: docs.length === 0 };
}
function makeCol(docs, subColMap) {
  docs = docs || [];
  subColMap = subColMap || {};
  const snap = makeSnap(docs);
  return {
    doc: id => ({
      get: async () => makeDoc(docs.find(d => d.id === id) || null),
      set: async () => {},
      update: async () => {},
      collection: sub => subColMap[id + '/' + sub] || makeCol([])
    }),
    where: () => ({ get: async () => snap, forEach: fn => snap.forEach(fn), size: docs.length }),
    get: async () => snap,
    add: async () => ({ id: 'new-id' })
  };
}

// ─── agent_mode ────────────────────────────────────────────
const am = require('../core/agent_mode');

describe('agent_mode -- T411-T415', () => {
  test('AGENT_DECISIONS is frozen', () => {
    expect(Object.isFrozen(am.AGENT_DECISIONS)).toBe(true);
    expect(am.AGENT_DECISIONS).toContain('respond');
    expect(am.AGENT_DECISIONS).toContain('escalate');
  });
  test('AUTONOMY_LEVELS is frozen with 5 levels', () => {
    expect(Object.isFrozen(am.AUTONOMY_LEVELS)).toBe(true);
    expect(am.AUTONOMY_LEVELS.length).toBe(5);
  });
  test('setAutonomyLevel -- valid level stores and returns', async () => {
    const db = { collection: () => makeCol([{ id: 'uid1' }]) };
    am.__setFirestoreForTests(db);
    const r = await am.setAutonomyLevel('uid1', 'medium');
    expect(r.uid).toBe('uid1');
    expect(r.level).toBe('medium');
  });
  test('setAutonomyLevel -- invalid level throws', async () => {
    const db = { collection: () => makeCol([]) };
    am.__setFirestoreForTests(db);
    await expect(am.setAutonomyLevel('uid1', 'turbo')).rejects.toThrow('Invalid autonomy level');
  });
  test('decideAction -- agent disabled returns escalate', async () => {
    const db = { collection: () => makeCol([{ id: 'uid1', agent_enabled: false }]) };
    am.__setFirestoreForTests(db);
    const r = await am.decideAction('uid1', 'hola', {});
    expect(r.decision).toBe('escalate');
    expect(r.reason).toBe('agent_disabled');
  });
  test('decideAction -- agent enabled high confidence returns respond', async () => {
    const db = { collection: () => makeCol([{ id: 'uid1', agent_enabled: true, agent_autonomy_level: 'low' }]) };
    am.__setFirestoreForTests(db);
    const r = await am.decideAction('uid1', 'hola', { confidence: 0.9 });
    expect(r.decision).toBe('respond');
  });
  test('logAgentDecision -- valid decision returns entry with id', async () => {
    const subCol = makeCol([]);
    const ownerDoc = { get: async () => makeDoc({ id: 'uid1' }), set: async () => {}, collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    const db = { collection: () => ({ doc: () => ownerDoc }) };
    am.__setFirestoreForTests(db);
    const r = await am.logAgentDecision('uid1', { decision: 'respond', message: 'hola' });
    expect(r.id).toBeDefined();
    expect(r.decision).toBe('respond');
  });
  test('logAgentDecision -- invalid decision throws', async () => {
    const db = { collection: () => makeCol([]) };
    am.__setFirestoreForTests(db);
    await expect(am.logAgentDecision('uid1', { decision: 'fly' })).rejects.toThrow('Invalid decision');
  });
  test('detectNewLead -- no existing doc returns isNew true', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) }) }) };
    am.__setFirestoreForTests(db);
    const r = await am.detectNewLead('uid1', '+573001234567', 'hola');
    expect(r.isNew).toBe(true);
    expect(r.score).toBe(50);
  });
});

// ─── marketplace_v2 ────────────────────────────────────────
const mv2 = require('../core/marketplace_v2');

describe('marketplace_v2 -- T416-T419', () => {
  test('REVIEW_STARS frozen 1-5', () => {
    expect(Object.isFrozen(mv2.REVIEW_STARS)).toBe(true);
    expect(mv2.REVIEW_STARS).toEqual([1,2,3,4,5]);
  });
  test('LISTING_TYPES frozen', () => {
    expect(Object.isFrozen(mv2.LISTING_TYPES)).toBe(true);
    expect(mv2.LISTING_TYPES).toContain('featured');
  });
  test('searchBusinesses -- matches by name', async () => {
    const biz = [{ id: 'b1', name: 'Peluqueria Sofia', description: 'cortes', category: 'salud' }];
    const db = { collection: () => makeCol(biz) };
    mv2.__setFirestoreForTests(db);
    const r = await mv2.searchBusinesses('Sofia');
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Peluqueria Sofia');
  });
  test('searchBusinesses -- no query returns all', async () => {
    const biz = [{ id: 'b1', name: 'A' }, { id: 'b2', name: 'B' }];
    const db = { collection: () => makeCol(biz) };
    mv2.__setFirestoreForTests(db);
    const r = await mv2.searchBusinesses('');
    expect(r.length).toBe(2);
  });
  test('addReview -- valid stars stores review', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    mv2.__setFirestoreForTests(db);
    const r = await mv2.addReview('biz1', { uid: 'uid1', stars: 5, text: 'Excelente!' });
    expect(r.stars).toBe(5);
    expect(r.id).toBeDefined();
  });
  test('addReview -- invalid stars throws', async () => {
    mv2.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(mv2.addReview('biz1', { uid: 'uid1', stars: 6, text: 'X' })).rejects.toThrow('Stars must be 1-5');
  });
  test('setFeaturedListing -- valid type stores', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    mv2.__setFirestoreForTests(db);
    const r = await mv2.setFeaturedListing('uid1', 'biz1', { listingType: 'premium' });
    expect(r.listingType).toBe('premium');
  });
  test('setFeaturedListing -- invalid type throws', async () => {
    mv2.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(mv2.setFeaturedListing('uid1', 'biz1', { listingType: 'platinum' })).rejects.toThrow('Invalid listing type');
  });
});

// ─── payments_v3 ────────────────────────────────────────────
const pv3 = require('../core/payments_v3');

describe('payments_v3 -- T420-T423', () => {
  test('INVOICE_STATUS frozen', () => {
    expect(Object.isFrozen(pv3.INVOICE_STATUS)).toBe(true);
    expect(pv3.INVOICE_STATUS).toContain('paid');
  });
  test('REFUND_STATUS frozen', () => {
    expect(Object.isFrozen(pv3.REFUND_STATUS)).toBe(true);
    expect(pv3.REFUND_STATUS).toContain('pending_owner_approval');
  });
  test('generateInvoice -- creates with pending status', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    pv3.__setFirestoreForTests(db);
    const r = await pv3.generateInvoice('uid1', { phone: '+573001234567', items: [], total: 50000, currency: 'COP' });
    expect(r.status).toBe('pending');
    expect(r.total).toBe(50000);
    expect(r.id).toBeDefined();
  });
  test('markInvoicePaid -- returns paid status', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {}, get: async () => makeDoc({ id: 'inv1', status: 'pending' }) }) }) }) }) };
    pv3.__setFirestoreForTests(db);
    const r = await pv3.markInvoicePaid('uid1', 'inv1', { ref: 'PAY-001' });
    expect(r.status).toBe('paid');
    expect(r.paymentRef).toBe('PAY-001');
  });
  test('getPaymentHistory -- returns invoices array', async () => {
    const invs = [{ id: 'i1', phone: '+573001234567', total: 10000 }];
    const db = { collection: () => ({ doc: () => ({ collection: () => makeCol(invs) }) }) };
    pv3.__setFirestoreForTests(db);
    const r = await pv3.getPaymentHistory('uid1', '+573001234567');
    expect(Array.isArray(r)).toBe(true);
  });
  test('initiateRefund -- status pending_owner_approval', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    pv3.__setFirestoreForTests(db);
    const r = await pv3.initiateRefund('uid1', 'inv1', { reason: 'cliente cambio de opinion' });
    expect(r.status).toBe('pending_owner_approval');
    expect(r.invoiceId).toBe('inv1');
  });
  test('createSplitPayment -- calculates totalAmount', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    pv3.__setFirestoreForTests(db);
    const r = await pv3.createSplitPayment('uid1', { items: [{ amount: 30000 }, { amount: 20000 }] });
    expect(r.totalAmount).toBe(50000);
    expect(r.status).toBe('pending');
  });
});

// ─── brasil_config ──────────────────────────────────────────
const bc = require('../core/brasil_config');

describe('brasil_config -- T424-T427', () => {
  test('BRASIL_CONFIG frozen with BRL', () => {
    expect(Object.isFrozen(bc.BRASIL_CONFIG)).toBe(true);
    expect(bc.BRASIL_CONFIG.currency).toBe('BRL');
    expect(bc.BRASIL_CONFIG.pix_enabled).toBe(true);
  });
  test('LGPD_RIGHTS frozen with 6 rights', () => {
    expect(Object.isFrozen(bc.LGPD_RIGHTS)).toBe(true);
    expect(bc.LGPD_RIGHTS.length).toBe(6);
    expect(bc.LGPD_RIGHTS).toContain('deletion');
  });
  test('getBrasilConfig returns spread of BRASIL_CONFIG', () => {
    const r = bc.getBrasilConfig();
    expect(r.currency).toBe('BRL');
    expect(r.timezone).toBe('America/Sao_Paulo');
  });
  test('isBrasilPhone -- +55 prefix is true', () => {
    expect(bc.isBrasilPhone('+5511999887766')).toBe(true);
    expect(bc.isBrasilPhone('+573001234567')).toBe(false);
  });
  test('buildBrasilPersonality returns pt-BR', () => {
    const r = bc.buildBrasilPersonality();
    expect(r.language).toBe('pt-BR');
    expect(r.pixEnabled).toBe(true);
  });
  test('formatPixAmount formats correctly', () => {
    expect(bc.formatPixAmount(1500)).toBe('R$ 1500,00');
    expect(bc.formatPixAmount(0.5)).toBe('R$ 0,50');
  });
  test('recordLGPDConsent -- valid rights stores consent', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    bc.__setFirestoreForTests(db);
    const r = await bc.recordLGPDConsent('uid1', '+5511999887766', ['access', 'deletion']);
    expect(r.rights).toEqual(['access', 'deletion']);
    expect(r.lawBasis).toBe('LGPD Art. 7');
  });
  test('recordLGPDConsent -- invalid right throws', async () => {
    bc.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(bc.recordLGPDConsent('uid1', '+5511999887766', ['access', 'hacking'])).rejects.toThrow('Invalid LGPD rights');
  });
  test('handleLGPDRequest -- valid right creates pending request', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    bc.__setFirestoreForTests(db);
    const r = await bc.handleLGPDRequest('uid1', '+5511999887766', 'deletion');
    expect(r.status).toBe('pending');
    expect(r.right).toBe('deletion');
  });
});

// ─── notifications_v3 ───────────────────────────────────────
const nv3 = require('../core/notifications_v3');

describe('notifications_v3 -- T428-T430', () => {
  test('NOTIFICATION_CHANNELS frozen with 3 channels', () => {
    expect(Object.isFrozen(nv3.NOTIFICATION_CHANNELS)).toBe(true);
    expect(nv3.NOTIFICATION_CHANNELS.length).toBe(3);
  });
  test('sendMultiChannel -- queues to all channels', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    nv3.__setFirestoreForTests(db);
    const r = await nv3.sendMultiChannel('uid1', '+57300', 'Hola!', ['whatsapp', 'email']);
    expect(r.channels.length).toBe(2);
    expect(r.channels[0].status).toBe('queued');
  });
  test('sendMultiChannel -- invalid channel throws', async () => {
    nv3.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(nv3.sendMultiChannel('uid1', '+57300', 'msg', ['telepathy'])).rejects.toThrow('Invalid channels');
  });
  test('createABTest -- creates with 2 variants', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    nv3.__setFirestoreForTests(db);
    const r = await nv3.createABTest('uid1', { variants: [{ text: 'A' }, { text: 'B' }], targetSegment: 'leads' });
    expect(r.variants.length).toBe(2);
    expect(r.status).toBe('active');
  });
  test('createABTest -- less than 2 variants throws', async () => {
    nv3.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(nv3.createABTest('uid1', { variants: [{ text: 'solo' }] })).rejects.toThrow('Need at least 2 variants');
  });
  test('scheduleNotification -- returns scheduled status', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    nv3.__setFirestoreForTests(db);
    const r = await nv3.scheduleNotification('uid1', '+57300', 'Promo!', '2026-05-02T10:00:00Z', ['whatsapp']);
    expect(r.status).toBe('scheduled');
    expect(r.id).toBeDefined();
  });
  test('getPredictiveSendTime -- no history returns default hour 10', async () => {
    const db = { collection: () => makeCol([]) };
    nv3.__setFirestoreForTests(db);
    const r = await nv3.getPredictiveSendTime('uid1', '+57300');
    expect(r.hour).toBe(10);
    expect(r.source).toBe('default');
  });
});

// ─── ai_coaching ────────────────────────────────────────────
const aic = require('../core/ai_coaching');

describe('ai_coaching -- T431-T433', () => {
  test('analyzeConversation -- empty messages returns score 0', () => {
    const r = aic.analyzeConversation([]);
    expect(r.score).toBe(0);
    expect(r.flags).toEqual([]);
  });
  test('analyzeConversation -- success signal detected raises score', () => {
    const msgs = [{ text: 'me interesa el servicio, cuanto cuesta?' }];
    const r = aic.analyzeConversation(msgs);
    expect(r.score).toBeGreaterThan(50);
    expect(r.insights.length).toBeGreaterThan(0);
  });
  test('analyzeConversation -- short messages flag RESPONSES_TOO_SHORT', () => {
    const msgs = [{ text: 'si' }, { text: 'ok' }];
    const r = aic.analyzeConversation(msgs);
    expect(r.flags).toContain('RESPONSES_TOO_SHORT');
  });
  test('buildSalesScript -- cold segment generates opener', () => {
    const r = aic.buildSalesScript('uid1', { productName: 'MIIA', targetSegment: 'cold' });
    expect(r.script).toContain('MIIA');
    expect(r.script).toContain('negocios como el tuyo');
  });
  test('buildSalesScript -- warm segment different copy', () => {
    const r = aic.buildSalesScript('uid1', { productName: 'MIIA', targetSegment: 'warm' });
    expect(r.script).toContain('Seguimos en contacto');
  });
  test('saveCoachingSnapshot -- hasConversion true when score >= 70', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) }) };
    aic.__setFirestoreForTests(db);
    const analysis = { score: 80, flags: [], insights: [{ type: 'conversion_rate' }] };
    const r = await aic.saveCoachingSnapshot('uid1', '+57300', analysis);
    expect(r.hasConversion).toBe(true);
    expect(r.score).toBe(80);
  });
  test('getCoachingReport -- empty snapshots returns avgScore 0', async () => {
    const db = { collection: () => ({ doc: () => ({ collection: () => makeCol([]) }) }) };
    aic.__setFirestoreForTests(db);
    const r = await aic.getCoachingReport('uid1');
    expect(r.avgScore).toBe(0);
    expect(r.totalConversations).toBe(0);
  });
});

// ─── benchmark ──────────────────────────────────────────────
const bm = require('../core/benchmark');

describe('benchmark -- T434-T435', () => {
  test('BENCHMARK_METRICS frozen with 4 keys', () => {
    expect(Object.isFrozen(bm.BENCHMARK_METRICS)).toBe(true);
    expect(bm.BENCHMARK_METRICS.length).toBe(4);
  });
  test('recordMetrics -- stores entry with id and timestamp', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    bm.__setFirestoreForTests(db);
    const r = await bm.recordMetrics('uid1', { response_time_avg: 200, conversion_rate: 0.15, sector: 'salud' });
    expect(r.id).toBeDefined();
    expect(r.metrics.conversion_rate).toBe(0.15);
  });
  test('getSectorBenchmark -- no data returns nulls', async () => {
    const db = { collection: () => makeCol([]) };
    bm.__setFirestoreForTests(db);
    const r = await bm.getSectorBenchmark('salud');
    expect(r.sector).toBe('salud');
    expect(r.conversion_rate).toBeNull();
  });
  test('getFederatedInsight -- returns stub', () => {
    const r = bm.getFederatedInsight('conversion trends');
    expect(r.status).toBe('stub');
    expect(r.query).toBe('conversion trends');
  });
  test('compareOwnerToSector -- returns comparison object', async () => {
    const db = { collection: () => makeCol([]) };
    bm.__setFirestoreForTests(db);
    const r = await bm.compareOwnerToSector('uid1', 'salud');
    expect(r.uid).toBe('uid1');
    expect(r.sector).toBe('salud');
    expect(typeof r.comparison).toBe('object');
  });
});

// ─── whatsapp_flows ─────────────────────────────────────────
const wf = require('../core/whatsapp_flows');

describe('whatsapp_flows -- T436-T438', () => {
  test('WA_FLOW_TYPES frozen with 5 types', () => {
    expect(Object.isFrozen(wf.WA_FLOW_TYPES)).toBe(true);
    expect(wf.WA_FLOW_TYPES.length).toBe(5);
  });
  test('FLOW_STATUS frozen', () => {
    expect(Object.isFrozen(wf.FLOW_STATUS)).toBe(true);
    expect(wf.FLOW_STATUS).toContain('active');
  });
  test('createFlow -- valid type stores draft flow', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    wf.__setFirestoreForTests(db);
    const r = await wf.createFlow('uid1', { type: 'survey', title: 'Post-servicio', fields: ['rating', 'comentario'] });
    expect(r.status).toBe('draft');
    expect(r.type).toBe('survey');
    expect(r.id).toBeDefined();
  });
  test('createFlow -- invalid type throws', async () => {
    wf.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(wf.createFlow('uid1', { type: 'magic', title: 'X' })).rejects.toThrow('Invalid flow type');
  });
  test('activateFlow -- existing flow activates', async () => {
    const flowData = { id: 'f1', uid: 'uid1', type: 'survey', status: 'draft' };
    const db = { collection: () => ({ doc: id => ({ get: async () => makeDoc(flowData), set: async () => {} }) }) };
    wf.__setFirestoreForTests(db);
    const r = await wf.activateFlow('uid1', 'f1');
    expect(r.status).toBe('active');
  });
  test('activateFlow -- wrong uid throws unauthorized', async () => {
    const flowData = { id: 'f1', uid: 'uid2', type: 'survey', status: 'draft' };
    const db = { collection: () => ({ doc: id => ({ get: async () => makeDoc(flowData), set: async () => {} }) }) };
    wf.__setFirestoreForTests(db);
    await expect(wf.activateFlow('uid1', 'f1')).rejects.toThrow('Unauthorized');
  });
  test('launchFlowForLead -- stores launch with sent status', async () => {
    const flowData = { id: 'f1', uid: 'uid1', type: 'survey' };
    const db = {
      collection: name => {
        if (name === 'wa_flows') return { doc: () => ({ get: async () => makeDoc(flowData) }) };
        return { doc: () => ({ set: async () => {} }) };
      }
    };
    wf.__setFirestoreForTests(db);
    const r = await wf.launchFlowForLead('uid1', '+57300', 'f1');
    expect(r.status).toBe('sent');
    expect(r.phone).toBe('+57300');
  });
  test('processSurveyResponse -- stores response entry', async () => {
    const db = { collection: () => ({ doc: () => ({ set: async () => {} }) }) };
    wf.__setFirestoreForTests(db);
    const r = await wf.processSurveyResponse('f1', '+57300', { rating: 5, comment: 'excelente' });
    expect(r.flowId).toBe('f1');
    expect(r.responses.rating).toBe(5);
    expect(r.id).toBeDefined();
  });
  test('getFlowStats -- returns stats with responseRate', async () => {
    const flowData = { id: 'f1', uid: 'uid1', type: 'survey', status: 'active' };
    const launchDocs = [{ id: 'l1', flowId: 'f1' }, { id: 'l2', flowId: 'f1' }];
    const respDocs = [{ id: 'r1', flowId: 'f1' }];
    const db = {
      collection: name => {
        if (name === 'wa_flows') return { doc: () => ({ get: async () => makeDoc(flowData) }) };
        if (name === 'flow_launches') return makeCol(launchDocs);
        if (name === 'flow_responses') return makeCol(respDocs);
        return makeCol([]);
      }
    };
    wf.__setFirestoreForTests(db);
    const r = await wf.getFlowStats('uid1', 'f1');
    expect(r.totalLaunches).toBe(2);
    expect(r.totalResponses).toBe(1);
    expect(r.responseRate).toBe(0.5);
  });
});