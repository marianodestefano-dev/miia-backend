'use strict';

const g = require('../core/growth_ctwa');
const {
  buildCTWAUrl,
  createCampaign,
  setCampaignActive,
  recordClick,
  markClickConverted,
  triggerGrowthLoop,
  updateGrowthTrigger,
  VALID_CHANNELS,
  __setFirestoreForTests,
} = g;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const campaigns = o.campaigns || {};
  const clicks = o.clicks || {};
  const triggers = o.triggers || {};
  const captures = { campaignSets: [], clickSets: [], triggerSets: [] };

  const campaignDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!campaigns[id], data: () => campaigns[id] || {} }),
    set: jest.fn((payload, merge) => {
      captures.campaignSets.push({ id, payload, merge });
      return Promise.resolve({});
    }),
  }));

  const clickDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!clicks[id], data: () => clicks[id] || {} }),
    set: jest.fn((payload, merge) => {
      captures.clickSets.push({ id, payload, merge });
      return Promise.resolve({});
    }),
  }));

  const triggerDocFn = jest.fn((id) => ({
    get: jest.fn().mockResolvedValue({ exists: !!triggers[id], data: () => triggers[id] || {} }),
    set: jest.fn((payload, merge) => {
      captures.triggerSets.push({ id, payload, merge });
      return Promise.resolve({});
    }),
  }));

  const subcollFn = jest.fn((name) => {
    if (name === 'campaigns') return { doc: campaignDocFn };
    return { doc: clickDocFn };
  });

  const ownerDocFn = jest.fn(() => ({ collection: subcollFn }));

  const db = {
    collection: jest.fn((name) => {
      if (name === 'growth_loop_triggers') return { doc: triggerDocFn };
      return { doc: ownerDocFn };
    }),
  };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── buildCTWAUrl ──────────────────────────────────────────────────────────────

describe('buildCTWAUrl', () => {
  test('ownerPhone null -> throw', () => {
    expect(() => buildCTWAUrl(null, { campaignId: 'c1' })).toThrow('ownerPhone_requerido');
  });
  test('campaignId null -> throw', () => {
    expect(() => buildCTWAUrl('+573054169969', {})).toThrow('campaignId_requerido');
  });
  test('opts null -> throw (campaignId missing)', () => {
    expect(() => buildCTWAUrl('+573054169969', null)).toThrow('campaignId_requerido');
  });

  test('OK - URL basica', () => {
    const url = buildCTWAUrl('+573054169969', { campaignId: 'c1' });
    expect(url).toContain('https://wa.me/573054169969?');
    expect(url).toContain('utm_source=direct');
    expect(url).toContain('utm_medium=ctwa');
    expect(url).toContain('utm_campaign=c1');
  });

  test('OK - canal valido (facebook)', () => {
    const url = buildCTWAUrl('+573054169969', { campaignId: 'c1', channel: 'facebook' });
    expect(url).toContain('utm_source=facebook');
  });

  test('canal invalido -> direct', () => {
    const url = buildCTWAUrl('+573054169969', { campaignId: 'c1', channel: 'pinterest' });
    expect(url).toContain('utm_source=direct');
  });

  test('OK con message -> text= en URL', () => {
    const url = buildCTWAUrl('+573054169969', { campaignId: 'c1', message: 'Hola MIIA' });
    expect(url).toContain('text=Hola%20MIIA');
  });

  test('OK con source y medium custom', () => {
    const url = buildCTWAUrl('+573054169969', {
      campaignId: 'c1', source: 'custom_src', medium: 'custom_med',
    });
    expect(url).toContain('utm_source=custom_src');
    expect(url).toContain('utm_medium=custom_med');
  });

  test('phone con caracteres extranos -> sanitizado a numerico', () => {
    const url = buildCTWAUrl('+57 (305) 416-9969', { campaignId: 'c1' });
    expect(url).toContain('wa.me/573054169969');
  });
});

// ── createCampaign ────────────────────────────────────────────────────────────

describe('createCampaign', () => {
  test('uid null -> throw', async () => {
    await expect(createCampaign(null, { name: 'X' })).rejects.toThrow('uid_requerido');
  });
  test('payload null -> throw', async () => {
    await expect(createCampaign('u1', null)).rejects.toThrow('name_requerido');
  });
  test('sin name -> throw', async () => {
    await expect(createCampaign('u1', {})).rejects.toThrow('name_requerido');
  });

  test('OK con valores defaults', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    const r = await createCampaign('uid123456', { name: 'Camp X' });
    expect(r.channel).toBe('direct');
    expect(r.budget).toBe(0);
    expect(r.message).toBe('');
    expect(captures.campaignSets[0].payload.active).toBe(true);
  });

  test('OK con channel valido y budget', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const r = await createCampaign('uid123456', { name: 'X', channel: 'instagram', budget: 500 });
    expect(r.channel).toBe('instagram');
    expect(r.budget).toBe(500);
  });

  test('channel invalido -> direct', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const r = await createCampaign('uid123456', { name: 'X', channel: 'foo' });
    expect(r.channel).toBe('direct');
  });

  test('budget no numerico -> 0', async () => {
    const { db } = makeDb();
    __setFirestoreForTests(db);
    const r = await createCampaign('uid123456', { name: 'X', budget: 'mil' });
    expect(r.budget).toBe(0);
  });

  test('name largo -> truncado a 100', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    await createCampaign('uid123456', { name: 'x'.repeat(500) });
    expect(captures.campaignSets[0].payload.name.length).toBe(100);
  });

  test('message largo -> truncado a 200', async () => {
    const { db, captures } = makeDb();
    __setFirestoreForTests(db);
    await createCampaign('uid123456', { name: 'X', message: 'y'.repeat(1000) });
    expect(captures.campaignSets[0].payload.message.length).toBe(200);
  });
});

// ── setCampaignActive ─────────────────────────────────────────────────────────

describe('setCampaignActive', () => {
  test('uid null -> throw', async () => {
    await expect(setCampaignActive(null, 'c1', true)).rejects.toThrow('parametros_requeridos');
  });
  test('campaignId null -> throw', async () => {
    await expect(setCampaignActive('u1', null, true)).rejects.toThrow('parametros_requeridos');
  });

  test('OK - active true', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setCampaignActive('uid123456', 'cmp_1', true);
    expect(r.active).toBe(true);
    expect(captures.campaignSets[0].payload.active).toBe(true);
  });

  test('OK - pausada (false)', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await setCampaignActive('uid123456', 'cmp_1', false);
    expect(r.active).toBe(false);
  });
});

// ── recordClick ───────────────────────────────────────────────────────────────

describe('recordClick', () => {
  test('uid null -> throw', async () => {
    await expect(recordClick(null, { campaignId: 'c1' })).rejects.toThrow('uid_requerido');
  });
  test('payload null -> throw', async () => {
    await expect(recordClick('u1', null)).rejects.toThrow('campaignId_requerido');
  });
  test('sin campaignId -> throw', async () => {
    await expect(recordClick('u1', {})).rejects.toThrow('campaignId_requerido');
  });

  test('OK - campaign existe -> incrementa clicks', async () => {
    const { db, captures } = makeDb({
      campaigns: { 'cmp_1': { clicks: 5 } },
    });
    __setFirestoreForTests(db);
    const r = await recordClick('uid123456', { campaignId: 'cmp_1', leadPhone: '5491' });
    expect(r.ok).toBe(true);
    expect(r.clickId).toMatch(/^clk_/);
    // 1 set para click + 1 set para campaign update
    expect(captures.clickSets).toHaveLength(1);
    expect(captures.campaignSets[0].payload.clicks).toBe(6);
  });

  test('OK - campaign no existe -> no incrementa pero registra click', async () => {
    const { db, captures } = makeDb({ campaigns: {} });
    __setFirestoreForTests(db);
    const r = await recordClick('uid123456', { campaignId: 'cmp_X' });
    expect(r.ok).toBe(true);
    expect(captures.clickSets).toHaveLength(1);
    expect(captures.campaignSets).toHaveLength(0); // no incremento
  });

  test('OK - sin clicks counter previo -> arranca en 1', async () => {
    const { db, captures } = makeDb({
      campaigns: { 'cmp_1': {} },
    });
    __setFirestoreForTests(db);
    await recordClick('uid123456', { campaignId: 'cmp_1' });
    expect(captures.campaignSets[0].payload.clicks).toBe(1);
  });

  test('OK - con fbclid y gclid', async () => {
    const { db, captures } = makeDb({ campaigns: {} });
    __setFirestoreForTests(db);
    await recordClick('uid123456', { campaignId: 'cmp_1', fbclid: 'fb1', gclid: 'g1' });
    expect(captures.clickSets[0].payload.fbclid).toBe('fb1');
    expect(captures.clickSets[0].payload.gclid).toBe('g1');
  });

  test('OK - leadPhone null -> null guardado', async () => {
    const { db, captures } = makeDb({ campaigns: {} });
    __setFirestoreForTests(db);
    await recordClick('uid123456', { campaignId: 'cmp_1' });
    expect(captures.clickSets[0].payload.leadPhone).toBeNull();
    expect(captures.clickSets[0].payload.fbclid).toBeNull();
    expect(captures.clickSets[0].payload.gclid).toBeNull();
  });
});

// ── markClickConverted ────────────────────────────────────────────────────────

describe('markClickConverted', () => {
  test('uid null -> throw', async () => {
    await expect(markClickConverted(null, 'clk_1')).rejects.toThrow('parametros_requeridos');
  });
  test('clickId null -> throw', async () => {
    await expect(markClickConverted('u1', null)).rejects.toThrow('parametros_requeridos');
  });

  test('click no existe -> throw', async () => {
    const { db } = makeDb({ clicks: {} });
    __setFirestoreForTests(db);
    await expect(markClickConverted('uid123456', 'clk_1')).rejects.toThrow('click_no_encontrado');
  });

  test('click ya convertido -> throw', async () => {
    const { db } = makeDb({
      clicks: { 'clk_1': { converted: true, campaignId: 'cmp_1' } },
    });
    __setFirestoreForTests(db);
    await expect(markClickConverted('uid123456', 'clk_1')).rejects.toThrow('click_ya_convertido');
  });

  test('OK - convierte e incrementa conversions del campaign', async () => {
    const { db, captures } = makeDb({
      clicks: { 'clk_1': { converted: false, campaignId: 'cmp_1' } },
      campaigns: { 'cmp_1': { conversions: 2 } },
    });
    __setFirestoreForTests(db);
    const r = await markClickConverted('uid123456', 'clk_1');
    expect(r.campaignId).toBe('cmp_1');
    // captures.clickSets[0] = update click converted=true
    // captures.campaignSets[0] = update conversions=3
    expect(captures.campaignSets[0].payload.conversions).toBe(3);
  });

  test('OK - campaign no existe -> no incrementa pero marca click', async () => {
    const { db, captures } = makeDb({
      clicks: { 'clk_1': { converted: false, campaignId: 'cmp_X' } },
      campaigns: {},
    });
    __setFirestoreForTests(db);
    const r = await markClickConverted('uid123456', 'clk_1');
    expect(r.ok).toBe(true);
    expect(captures.campaignSets).toHaveLength(0); // no incremento
  });

  test('OK - click sin campaignId -> no incrementa', async () => {
    const { db, captures } = makeDb({
      clicks: { 'clk_1': { converted: false } },
    });
    __setFirestoreForTests(db);
    const r = await markClickConverted('uid123456', 'clk_1');
    expect(r.ok).toBe(true);
    expect(captures.campaignSets).toHaveLength(0);
  });

  test('OK - campaign existe sin conversions previo -> arranca en 1', async () => {
    const { db, captures } = makeDb({
      clicks: { 'clk_1': { converted: false, campaignId: 'cmp_1' } },
      campaigns: { 'cmp_1': {} },
    });
    __setFirestoreForTests(db);
    await markClickConverted('uid123456', 'clk_1');
    expect(captures.campaignSets[0].payload.conversions).toBe(1);
  });
});

// ── triggerGrowthLoop ─────────────────────────────────────────────────────────

describe('triggerGrowthLoop', () => {
  test('newOwnerUid null -> throw', async () => {
    await expect(triggerGrowthLoop(null)).rejects.toThrow('newOwnerUid_requerido');
  });

  test('OK con info completo', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await triggerGrowthLoop('newuid12345', {
      categoria: 'salud',
      zona: 'BOGOTA',
      contactReason: 'Onboarding B2B',
    });
    expect(r.triggerId).toMatch(/^gtr_/);
    expect(captures.triggerSets[0].payload.categoria).toBe('salud');
    expect(captures.triggerSets[0].payload.zona).toBe('bogota');
    expect(captures.triggerSets[0].payload.status).toBe('pending');
  });

  test('OK sin info -> defaults', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await triggerGrowthLoop('newuid12345');
    expect(captures.triggerSets[0].payload.categoria).toBeNull();
    expect(captures.triggerSets[0].payload.zona).toBeNull();
    expect(captures.triggerSets[0].payload.contactReason).toBeNull();
  });

  test('contactReason largo -> truncado a 300', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await triggerGrowthLoop('newuid12345', { contactReason: 'x'.repeat(1000) });
    expect(captures.triggerSets[0].payload.contactReason.length).toBe(300);
  });
});

// ── updateGrowthTrigger ───────────────────────────────────────────────────────

describe('updateGrowthTrigger', () => {
  test('triggerId null -> throw', async () => {
    await expect(updateGrowthTrigger(null, {})).rejects.toThrow('triggerId_requerido');
  });
  test('updates null -> throw', async () => {
    await expect(updateGrowthTrigger('gtr_1', null)).rejects.toThrow('updates_invalido');
  });
  test('updates no object -> throw', async () => {
    await expect(updateGrowthTrigger('gtr_1', 'string')).rejects.toThrow('updates_invalido');
  });

  test('OK con matchesFound, introductionsMade, status', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await updateGrowthTrigger('gtr_1', {
      matchesFound: 5,
      introductionsMade: 2,
      status: 'completed',
    });
    expect(r.ok).toBe(true);
    expect(captures.triggerSets[0].payload.matchesFound).toBe(5);
    expect(captures.triggerSets[0].payload.introductionsMade).toBe(2);
    expect(captures.triggerSets[0].payload.status).toBe('completed');
  });

  test('OK sin updates -> solo updatedAt', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateGrowthTrigger('gtr_1', {});
    expect(captures.triggerSets[0].payload.matchesFound).toBeUndefined();
    expect(captures.triggerSets[0].payload.introductionsMade).toBeUndefined();
    expect(captures.triggerSets[0].payload.status).toBeUndefined();
    expect(captures.triggerSets[0].payload.updatedAt).toBeDefined();
  });

  test('OK matchesFound no number -> no se setea', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateGrowthTrigger('gtr_1', { matchesFound: 'five' });
    expect(captures.triggerSets[0].payload.matchesFound).toBeUndefined();
  });

  test('OK introductionsMade no number -> no se setea', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateGrowthTrigger('gtr_1', { introductionsMade: 'two' });
    expect(captures.triggerSets[0].payload.introductionsMade).toBeUndefined();
  });
});
