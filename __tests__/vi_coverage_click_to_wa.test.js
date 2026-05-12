'use strict';

const {
  __setFirestoreForTests, buildWADeepLink, CAMPAIGN_SOURCES,
  generateLandingConfig, trackLandingVisit, generateWALink,
  recordConversion, getCampaignStats,
} = require('../core/click_to_wa');

const UID = 'testUid12345';
const CFG_ID = 'cfg-abc-123';

function makeDb({ configExists = true, configData = { clicks: 0, conversions: 0 }, ownerExists = true, ownerData = { phone: '+1234' }, landingDocs = [] } = {}) {
  const collMock = jest.fn().mockImplementation((name) => ({
    doc: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockResolvedValue({}),
      get: jest.fn().mockImplementation(() => {
        if (name === 'owners') return Promise.resolve({ exists: ownerExists, data: () => ownerData });
        if (name === 'landing_configs') return Promise.resolve({ exists: configExists, data: () => configData });
        return Promise.resolve({ exists: true, data: () => ({}) });
      }),
    })),
    where: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue({ forEach: (fn) => landingDocs.forEach(fn) }),
  }));
  return { collection: collMock };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  __setFirestoreForTests(null);
  jest.restoreAllMocks();
});

describe('buildWADeepLink', () => {
  test('phone truthy + prefilledMessage => link con ?text= (both truthy branches)', () => {
    const l = buildWADeepLink('+1 234 567', 'Hola');
    expect(l).toContain('wa.me/1234567');
    expect(l).toContain('?text=');
  });
  test('phone null => clean vacio (branch phone || falsy)', () => {
    const l = buildWADeepLink(null, null);
    expect(l).toBe('https://wa.me/');
  });
  test('sin prefilledMessage => sin ?text= (prefilledMessage falsy)', () => {
    expect(buildWADeepLink('+1234', null)).not.toContain('?text=');
  });
});

describe('generateLandingConfig', () => {
  test('opts null => defaults (opts || {} falsy branch)', async () => {
    __setFirestoreForTests(makeDb());
    const r = await generateLandingConfig(UID, null);
    expect(r.campaign).toBe('default');
    expect(r.source).toBe('organic');
    expect(r.adId).toBeNull();
  });
  test('opts sin campo => defaults (multiple || branches)', async () => {
    __setFirestoreForTests(makeDb());
    const r = await generateLandingConfig(UID, {});
    expect(r.campaign).toBe('default');
    expect(r.utm).toEqual({});
  });
  test('source invalida => throw', async () => {
    __setFirestoreForTests(makeDb());
    await expect(generateLandingConfig(UID, { source: 'invalid' })).rejects.toThrow('Invalid source');
  });
  test('opts completo => usa todos los valores (all truthy branches)', async () => {
    __setFirestoreForTests(makeDb());
    const r = await generateLandingConfig(UID, { source: 'meta_ads', campaign: 'camp1', adId: 'ad1', utm: { k: 1 } });
    expect(r.source).toBe('meta_ads');
    expect(r.campaign).toBe('camp1');
    expect(r.adId).toBe('ad1');
  });
});

describe('trackLandingVisit', () => {
  test('config no existe => throw (!doc.exists true)', async () => {
    __setFirestoreForTests(makeDb({ configExists: false }));
    await expect(trackLandingVisit(CFG_ID, {})).rejects.toThrow('Landing config not found');
  });
  test('visitorData null => ip null (visitorData || {} falsy)', async () => {
    __setFirestoreForTests(makeDb({ configData: { clicks: 3 } }));
    const r = await trackLandingVisit(CFG_ID, null);
    expect(r.ip).toBeNull();
  });
  test('visitorData sin ip => ip null (.ip || null falsy)', async () => {
    __setFirestoreForTests(makeDb({ configData: { clicks: 0 } }));
    const r = await trackLandingVisit(CFG_ID, {});
    expect(r.ip).toBeNull();
  });
  test('clicks undefined => (clicks||0)+1 = 1 (|| 0 falsy)', async () => {
    __setFirestoreForTests(makeDb({ configData: { clicks: undefined } }));
    const r = await trackLandingVisit(CFG_ID, { ip: '1.2.3.4' });
    expect(r.ip).toBe('1.2.3.4');
  });
});

describe('generateWALink', () => {
  test('config no existe => throw (if !doc.exists true)', async () => {
    __setFirestoreForTests(makeDb({ configExists: false }));
    await expect(generateWALink(UID, CFG_ID, 'hola')).rejects.toThrow('Config not found');
  });
  test('owner no existe => ownerData={} (ownerDoc.exists false branch)', async () => {
    __setFirestoreForTests(makeDb({ ownerExists: false, ownerData: null }));
    const r = await generateWALink(UID, CFG_ID, 'hola');
    expect(r.uid).toBe(UID);
  });
  test('ownerData con whatsapp_phone, sin phone (phone||whatsapp_phone branch)', async () => {
    __setFirestoreForTests(makeDb({ ownerData: { whatsapp_phone: '+9999' } }));
    const r = await generateWALink(UID, CFG_ID, 'msg');
    expect(r.waLink).toContain('9999');
  });
  test('sin phone ni whatsapp_phone => phone vacio (|| empty string)', async () => {
    __setFirestoreForTests(makeDb({ ownerData: {} }));
    const r = await generateWALink(UID, CFG_ID, null);
    expect(r.prefilledMessage).toBeNull();
  });
});

describe('recordConversion', () => {
  test('config no existe => throw (!doc.exists true)', async () => {
    __setFirestoreForTests(makeDb({ configExists: false }));
    await expect(recordConversion(CFG_ID)).rejects.toThrow('Config not found');
  });
  test('conversions existentes => incrementa (conversions truthy)', async () => {
    __setFirestoreForTests(makeDb({ configData: { conversions: 5 } }));
    const r = await recordConversion(CFG_ID);
    expect(r.conversions).toBe(6);
  });
  test('conversions undefined => 1 (|| 0 falsy branch)', async () => {
    __setFirestoreForTests(makeDb({ configData: { conversions: undefined } }));
    const r = await recordConversion(CFG_ID);
    expect(r.conversions).toBe(1);
  });
});

describe('getCampaignStats', () => {
  const makeDoc = (d) => ({ data: () => d });
  test('sin docs => conversionRate 0 (clicks>0 false)', async () => {
    __setFirestoreForTests(makeDb());
    const r = await getCampaignStats(UID);
    expect(r.conversionRate).toBe(0);
    expect(r.campaign).toBe('all');
  });
  test('campaign filter no match => excluye (if false branch)', async () => {
    __setFirestoreForTests(makeDb({ landingDocs: [makeDoc({ campaign: 'other', clicks: 10, conversions: 2 })] }));
    const r = await getCampaignStats(UID, 'meta_ads');
    expect(r.totalClicks).toBe(0);
  });
  test('campaign filter match => incluye (if true branch + clicks>0 truthy)', async () => {
    __setFirestoreForTests(makeDb({ landingDocs: [makeDoc({ campaign: 'meta_ads', clicks: 10, conversions: 2 })] }));
    const r = await getCampaignStats(UID, 'meta_ads');
    expect(r.conversionRate).toBeCloseTo(0.2);
  });
  test('clicks 0 en docs (|| 0 falsy branches)', async () => {
    __setFirestoreForTests(makeDb({ landingDocs: [makeDoc({ campaign: 'x' })] }));
    const r = await getCampaignStats(UID);
    expect(r.totalClicks).toBe(0);
  });
});
