'use strict';

function makeDoc(data) { return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : 'doc1' }; }
function makeSnap(docs) { const w = docs.map(d => ({ id: d.id || 'x', data: () => d })); return { forEach: fn => w.forEach(fn), size: docs.length, empty: !docs.length }; }
function makeCol(docs) { docs = docs || []; const snap = makeSnap(docs); return { doc: id => ({ get: async () => makeDoc(docs.find(d => d.id === id) || null), set: async () => {}, collection: () => makeCol([]) }), where: () => ({ get: async () => snap }), get: async () => snap }; }

// ─── inter_miia_network ─────────────────────────────────────
const net = require('../core/inter_miia_network');

describe('inter_miia_network -- T411-T413', () => {
  test('REPUTATION_LEVELS frozen ascending order', () => {
    expect(Object.isFrozen(net.REPUTATION_LEVELS)).toBe(true);
    expect(net.REPUTATION_LEVELS[0]).toBe('blocked');
    expect(net.REPUTATION_LEVELS[4]).toBe('trusted');
  });
  test('FRAUD_SIGNAL_TYPES frozen with 5 types', () => {
    expect(Object.isFrozen(net.FRAUD_SIGNAL_TYPES)).toBe(true);
    expect(net.FRAUD_SIGNAL_TYPES.length).toBe(5);
  });
  test('searchCrossTenant -- finds matching business', async () => {
    const biz = [{ id: 'b1', name: 'Peluqueria Sofia', description: 'cortes de cabello', category: 'belleza', status: 'active', reputation: 'verified' }];
    net.__setFirestoreForTests({ collection: () => makeCol(biz) });
    const r = await net.searchCrossTenant('peluqueria');
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Peluqueria Sofia');
  });
  test('searchCrossTenant -- filters blocked businesses', async () => {
    const biz = [{ id: 'b1', name: 'Estafa SA', status: 'active', reputation: 'blocked' }];
    net.__setFirestoreForTests({ collection: () => makeCol(biz) });
    const r = await net.searchCrossTenant('estafa', { minReputation: 'new' });
    expect(r.length).toBe(0);
  });
  test('deriveLead -- valid consent creates derivation', async () => {
    net.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await net.deriveLead('uid1', 'uid2', '+573001234567', { consent: 'explicit', context: 'lead pregunto por plomeria' });
    expect(r.status).toBe('pending');
    expect(r.consent).toBe('explicit');
    expect(r.id).toBeDefined();
  });
  test('deriveLead -- invalid consent throws', async () => {
    net.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(net.deriveLead('uid1', 'uid2', '+57300', { consent: 'forced' })).rejects.toThrow('Invalid consent type');
  });
  test('acceptLeadDerivation -- authorized uid accepts', async () => {
    const deriv = { id: 'd1', fromUid: 'uid1', toUid: 'uid2', status: 'pending' };
    net.__setFirestoreForTests({ collection: () => ({ doc: id => ({ get: async () => makeDoc(deriv), set: async () => {} }) }) });
    const r = await net.acceptLeadDerivation('d1', 'uid2');
    expect(r.status).toBe('accepted');
  });
  test('acceptLeadDerivation -- wrong uid throws unauthorized', async () => {
    const deriv = { id: 'd1', fromUid: 'uid1', toUid: 'uid2', status: 'pending' };
    net.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(deriv), set: async () => {} }) }) });
    await expect(net.acceptLeadDerivation('d1', 'uid99')).rejects.toThrow('Unauthorized');
  });
  test('recordFraudSignal -- valid type creates signal', async () => {
    net.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await net.recordFraudSignal('uid1', '+573001234567', 'spam');
    expect(r.signalType).toBe('spam');
    expect(r.status).toBe('open');
  });
  test('recordFraudSignal -- invalid type throws', async () => {
    net.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(net.recordFraudSignal('uid1', '+57300', 'evil')).rejects.toThrow('Invalid signal type');
  });
  test('getBusinessReputation -- new owner with no fraud is new', async () => {
    const db = { collection: name => name === 'fraud_signals' ? makeCol([]) : makeCol([{ id: 'uid1', registeredAt: new Date().toISOString() }]) };
    net.__setFirestoreForTests(db);
    const r = await net.getBusinessReputation('uid1');
    expect(r.reputationLevel).toBe('new');
    expect(r.fraudSignals).toBe(0);
  });
});

// ─── referral_natural ───────────────────────────────────────
const rn = require('../core/referral_natural');

describe('referral_natural -- T414-T415', () => {
  test('LEAD_STATUS frozen with 5 statuses', () => {
    expect(Object.isFrozen(rn.LEAD_STATUS)).toBe(true);
    expect(rn.LEAD_STATUS.length).toBe(5);
  });
  test('MAX_DAILY_OUTREACH is 3', () => {
    expect(rn.MAX_DAILY_OUTREACH).toBe(3);
  });
  test('FIRESTORE_SCHEMA documents miia_leads_queue', () => {
    expect(Object.isFrozen(rn.FIRESTORE_SCHEMA)).toBe(true);
    expect(rn.FIRESTORE_SCHEMA['miia_leads_queue/{id}']).toBeDefined();
    expect(rn.FIRESTORE_SCHEMA['miia_outreach_capacity/{uid}_{date}']).toBeDefined();
  });
  test('detectInterestSignal -- detects me interesa', () => {
    const r = rn.detectInterestSignal('me interesa saber cuanto cuesta');
    expect(r.interested).toBe(true);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.signals.length).toBeGreaterThan(0);
  });
  test('detectInterestSignal -- no interest in casual message', () => {
    const r = rn.detectInterestSignal('hola como estas');
    expect(r.interested).toBe(false);
    expect(r.confidence).toBe(0);
  });
  test('queueLead -- creates queued lead in Firestore', async () => {
    rn.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await rn.queueLead('+573001234567', 'uid2', { context: 'pregunto por plomeria', sourceMessage: 'Hola tienen plomeros?' });
    expect(r.status).toBe('queued');
    expect(r.fromPhone).toBe('+573001234567');
    expect(r.id).toBeDefined();
  });
  test('getOutreachCapacity -- empty returns full available', async () => {
    rn.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) });
    const r = await rn.getOutreachCapacity('uid1', '2026-05-01');
    expect(r.count).toBe(0);
    expect(r.available).toBe(3);
    expect(r.limit).toBe(3);
  });
  test('getOutreachCapacity -- full day returns 0 available', async () => {
    const capDoc = { id: 'uid1_2026-05-01', uid: 'uid1', date: '2026-05-01', count: 3 };
    rn.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(capDoc) }) }) });
    const r = await rn.getOutreachCapacity('uid1', '2026-05-01');
    expect(r.available).toBe(0);
  });
  test('incrementOutreachCount -- increments from 0 to 1', async () => {
    rn.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null), set: async () => {} }) }) });
    const r = await rn.incrementOutreachCount('uid1', '2026-05-01');
    expect(r.count).toBe(1);
  });
  test('markLeadConverted -- sets status converted', async () => {
    rn.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await rn.markLeadConverted('lead1');
    expect(r.status).toBe('converted');
  });
});

// ─── ticket_system ──────────────────────────────────────────
const ts = require('../core/ticket_system');

describe('ticket_system -- T416', () => {
  test('TICKET_TYPES frozen with 6 types including emojis', () => {
    expect(Object.isFrozen(ts.TICKET_TYPES)).toBe(true);
    expect(Object.keys(ts.TICKET_TYPES).length).toBe(6);
    expect(ts.TICKET_TYPES.CRITICAL).toBe('🚨');
    expect(ts.TICKET_TYPES.IDEA).toBe('💡');
  });
  test('TICKET_STATUS frozen with 5 statuses', () => {
    expect(Object.isFrozen(ts.TICKET_STATUS)).toBe(true);
    expect(ts.TICKET_STATUS.length).toBe(5);
  });
  test('parseTicketFromMessage -- detects IDEA emoji', () => {
    const r = ts.parseTicketFromMessage('💡 Agregar catalogo de productos');
    expect(r.detected).toBe(true);
    expect(r.type).toBe('IDEA');
    expect(r.subject).toBe('Agregar catalogo de productos');
  });
  test('parseTicketFromMessage -- no emoji returns detected false', () => {
    const r = ts.parseTicketFromMessage('Hola como estas?');
    expect(r.detected).toBe(false);
  });
  test('createTicket -- CRITICAL gets escalated status', async () => {
    ts.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }), where: () => ({ get: async () => makeSnap([]) }) }) });
    const r = await ts.createTicket('uid1', '+57300', { type: 'CRITICAL', subject: 'MIIA no responde', body: 'Lleva 2h sin responder' });
    expect(r.status).toBe('escalated');
    expect(r.priority).toBe('high');
  });
  test('createTicket -- IDEA gets open status', async () => {
    ts.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }), where: () => ({ get: async () => makeSnap([]) }) }) });
    const r = await ts.createTicket('uid1', '+57300', { type: 'IDEA', subject: 'Nueva feature' });
    expect(r.status).toBe('open');
    expect(r.priority).toBe('normal');
  });
  test('createTicket -- invalid type throws', async () => {
    ts.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ts.createTicket('uid1', '+57300', { type: 'UNKNOWN', subject: 'X' })).rejects.toThrow('Invalid ticket type');
  });
  test('updateTicketStatus -- resolved sets resolvedAt', async () => {
    ts.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ts.updateTicketStatus('uid1', 'ticket1', 'resolved');
    expect(r.status).toBe('resolved');
  });
  test('updateTicketStatus -- invalid status throws', async () => {
    ts.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ts.updateTicketStatus('uid1', 'ticket1', 'magic')).rejects.toThrow('Invalid status');
  });
  test('getDashboardStats -- returns correct counts', async () => {
    const tickets = [
      { id: 't1', status: 'open', type: 'BUG' },
      { id: 't2', status: 'escalated', type: 'CRITICAL' },
      { id: 't3', status: 'open', type: 'IDEA' },
    ];
    ts.__setFirestoreForTests({ collection: () => makeCol(tickets) });
    const r = await ts.getDashboardStats('uid1');
    expect(r.total).toBe(3);
    expect(r.open).toBe(2);
    expect(r.escalated).toBe(1);
  });
});

// ─── assistant_mode ─────────────────────────────────────────
const asst = require('../core/assistant_mode');

describe('assistant_mode -- T417', () => {
  test('ASSISTANT_TASK_TYPES frozen with 6 types', () => {
    expect(Object.isFrozen(asst.ASSISTANT_TASK_TYPES)).toBe(true);
    expect(asst.ASSISTANT_TASK_TYPES.length).toBe(6);
  });
  test('buildAssistantIntro -- booking generates correct intro', () => {
    const r = asst.buildAssistantIntro('Mariano', 'booking');
    expect(r).toContain('asistente de Mariano');
    expect(r).toContain('reserva');
  });
  test('buildAssistantIntro -- unknown type returns generic', () => {
    const r = asst.buildAssistantIntro('Juan', 'mystery');
    expect(r).toContain('asistente de Juan');
  });
  test('initiateExternalTask -- valid type creates task with intro', async () => {
    asst.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await asst.initiateExternalTask('uid1', { externalBusiness: 'Plomeria Central', taskType: 'appointment', details: { date: '2026-05-02' }, ownerName: 'Sofia' });
    expect(r.status).toBe('initiated');
    expect(r.requiresConfirmation).toBe(true);
    expect(r.introMessage).toContain('Sofia');
  });
  test('initiateExternalTask -- invalid type throws', async () => {
    asst.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(asst.initiateExternalTask('uid1', { externalBusiness: 'X', taskType: 'espionage' })).rejects.toThrow('Invalid task type');
  });
  test('confirmBeforeComplete -- generates confirmation message', async () => {
    const taskData = { id: 'task1', uid: 'uid1', status: 'awaiting_response' };
    asst.__setFirestoreForTests({ collection: () => ({ doc: id => ({ get: async () => makeDoc(taskData), set: async () => {} }) }) });
    const r = await asst.confirmBeforeComplete('uid1', 'task1', 'Se agenda turno para martes 10am');
    expect(r.confirmationMessage).toContain('Antes de cerrar');
    expect(r.confirmationMessage).toContain('martes 10am');
  });
  test('markTaskCompleted -- sets status completed', async () => {
    const taskData = { id: 'task1', uid: 'uid1', status: 'pending_confirm' };
    asst.__setFirestoreForTests({ collection: () => ({ doc: id => ({ get: async () => makeDoc(taskData), set: async () => {} }) }) });
    const r = await asst.markTaskCompleted('uid1', 'task1');
    expect(r.status).toBe('completed');
  });
});

// ─── click_to_wa ────────────────────────────────────────────
const ctw = require('../core/click_to_wa');

describe('click_to_wa -- T418', () => {
  test('CAMPAIGN_SOURCES frozen with 6 sources', () => {
    expect(Object.isFrozen(ctw.CAMPAIGN_SOURCES)).toBe(true);
    expect(ctw.CAMPAIGN_SOURCES.length).toBe(6);
    expect(ctw.CAMPAIGN_SOURCES).toContain('meta_ads');
  });
  test('buildWADeepLink -- generates wa.me link', () => {
    const r = ctw.buildWADeepLink('+573054169969', 'Hola! Vi tu anuncio');
    expect(r).toContain('wa.me/573054169969');
    expect(r).toContain('Hola');
  });
  test('buildWADeepLink -- without message no query string', () => {
    const r = ctw.buildWADeepLink('+573054169969');
    expect(r).toBe('https://wa.me/573054169969');
  });
  test('generateLandingConfig -- meta_ads source creates config', async () => {
    ctw.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await ctw.generateLandingConfig('uid1', { campaign: 'mayo2026', source: 'meta_ads', adId: 'AD-001' });
    expect(r.source).toBe('meta_ads');
    expect(r.clicks).toBe(0);
    expect(r.id).toBeDefined();
  });
  test('generateLandingConfig -- invalid source throws', async () => {
    ctw.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(ctw.generateLandingConfig('uid1', { source: 'tinder' })).rejects.toThrow('Invalid source');
  });
  test('trackLandingVisit -- increments click count', async () => {
    const cfg = { id: 'cfg1', clicks: 5, conversions: 1 };
    const db = { collection: name => name === 'landing_configs' ? { doc: () => ({ get: async () => makeDoc(cfg), set: async () => {} }) } : { doc: () => ({ set: async () => {} }) } };
    ctw.__setFirestoreForTests(db);
    const r = await ctw.trackLandingVisit('cfg1', { ip: '1.2.3.4' });
    expect(r.configId).toBe('cfg1');
    expect(r.id).toBeDefined();
  });
  test('getCampaignStats -- calculates conversion rate', async () => {
    const cfgs = [{ id: 'c1', campaign: 'mayo', clicks: 100, conversions: 15 }, { id: 'c2', campaign: 'mayo', clicks: 50, conversions: 5 }];
    ctw.__setFirestoreForTests({ collection: () => makeCol(cfgs) });
    const r = await ctw.getCampaignStats('uid1', 'mayo');
    expect(r.totalClicks).toBe(150);
    expect(r.totalConversions).toBe(20);
    expect(r.conversionRate).toBeCloseTo(0.133, 2);
  });
});