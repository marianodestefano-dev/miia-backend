'use strict';

// Mock firebase-admin once for the entire file
jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

// Require all modules ONCE - no resetModules, so coverage accumulates correctly
const gm = require('../core/growth_metrics');
const gt = require('../core/growth_tools');
const im = require('../core/inter_miia');
const smm = require('../core/social_media_manager');
const sl = require('../core/social_listening');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// ===== GROWTH_METRICS extra =====
describe('P5 extra2 -- growth_metrics missing branches', () => {
  function makeCollectionRouter({ ownerData, leadsEmpty, leadsDocs, allDocs, returningDocs } = {}) {
    return {
      collection: jest.fn().mockImplementation((name) => {
        if (name === 'owners') {
          return {
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue({ exists: true, data: () => ownerData }),
            }),
          };
        }
        const whereResult = {
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue({ empty: leadsEmpty, docs: leadsDocs }),
            }),
          }),
          where: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ docs: returningDocs || [] }),
          }),
          get: jest.fn().mockResolvedValue({ docs: allDocs || [] }),
        };
        return { where: jest.fn().mockReturnValue(whereResult) };
      }),
    };
  }

  test('getActivationTime: owner con leads -> firstLeadAt y activationMs', async () => {
    gm.__setFirestoreForTests(makeCollectionRouter({
      ownerData: { createdAt: 1000 },
      leadsEmpty: false,
      leadsDocs: [{ data: () => ({ createdAt: 5000 }) }],
    }));
    const r = await gm.getActivationTime('uid1');
    expect(r.firstLeadAt).toBe(5000);
    expect(r.activationMs).toBe(4000);
  });

  test('getActivationTime: owner.createdAt nulo -> activationMs=0', async () => {
    gm.__setFirestoreForTests(makeCollectionRouter({
      ownerData: { createdAt: null },
      leadsEmpty: false,
      leadsDocs: [{ data: () => ({ createdAt: 5000 }) }],
    }));
    const r = await gm.getActivationTime('uid1');
    expect(r.activationMs).toBe(0);
  });

  test('getRetention30d: docs=undefined -> total=0, rate=0', async () => {
    gm.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({}),
          }),
          get: jest.fn().mockResolvedValue({}),
        }),
      }),
    });
    const r = await gm.getRetention30d('uid1');
    expect(r.total).toBe(0);
    expect(r.rate).toBe(0);
  });

  test('getGrowthSummary: success path -> retorna uid+activation+retention', async () => {
    gm.__setFirestoreForTests(makeCollectionRouter({
      ownerData: { createdAt: 1000 },
      leadsEmpty: true,
      leadsDocs: [],
      allDocs: [],
      returningDocs: [],
    }));
    const r = await gm.getGrowthSummary('uid1');
    expect(r.uid).toBe('uid1');
    expect(r.activation).toBeDefined();
    expect(r.retention).toBeDefined();
  });
});

// ===== GROWTH_TOOLS extra =====
describe('P5 extra2 -- growth_tools missing branches', () => {
  function makeNestedDb({ getExists = false, getData = null, setThrows = false, getThrows = false } = {}) {
    const docMock = {
      get: getThrows ? jest.fn().mockRejectedValue(new Error('get fail')) : jest.fn().mockResolvedValue({ exists: getExists, data: () => getData }),
      set: setThrows ? jest.fn().mockRejectedValue(new Error('set fail')) : jest.fn().mockResolvedValue({}),
    };
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: docMock.get,
          set: docMock.set,
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({ get: docMock.get, set: docMock.set }),
          }),
        }),
      }),
    };
  }

  test('generateReferralCode: success -> code y referralUrl', async () => {
    gt.__setFirestoreForTests(makeNestedDb());
    const r = await gt.generateReferralCode('uid123', '+573001234567');
    expect(r.code).toBeDefined();
    expect(r.referralUrl).toContain('miia.app/ref/');
  });

  test('generateReferralCode: set lanza -> re-lanza', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ setThrows: true }));
    await expect(gt.generateReferralCode('uid1', '+1234')).rejects.toThrow('set fail');
    expect(console.error).toHaveBeenCalled();
  });

  test('applyReferralCode: codigo no existe -> applied=false', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: false }));
    const r = await gt.applyReferralCode('uid1', 'CODE1', '+1234');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('codigo no encontrado');
  });

  test('applyReferralCode: codigo inactivo -> applied=false', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: true, getData: { active: false } }));
    const r = await gt.applyReferralCode('uid1', 'CODE1', '+1234');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('codigo inactivo');
  });

  test('applyReferralCode: activo -> applied=true', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: true, getData: { active: true, phone: '+1', usedCount: 0 } }));
    const r = await gt.applyReferralCode('uid1', 'CODE1', '+1234');
    expect(r.applied).toBe(true);
    expect(r.reward).toBe(10);
  });

  test('applyReferralCode: get lanza -> applied=false con reason', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getThrows: true }));
    const r = await gt.applyReferralCode('uid1', 'CODE1', '+1234');
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('error:');
  });

  test('addLoyaltyPoints: nuevo contacto -> suma desde 0', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: false }));
    const r = await gt.addLoyaltyPoints('uid1', '+1234', 50, 'compra');
    expect(r.newTotal).toBe(50);
    expect(r.added).toBe(50);
  });

  test('addLoyaltyPoints: contacto existente -> acumula', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: true, getData: { points: 100 } }));
    const r = await gt.addLoyaltyPoints('uid1', '+1234', 50);
    expect(r.newTotal).toBe(150);
  });

  test('addLoyaltyPoints: supera MAX -> cappea en 10000', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: true, getData: { points: 9990 } }));
    const r = await gt.addLoyaltyPoints('uid1', '+1234', 100);
    expect(r.newTotal).toBe(10000);
  });

  test('addLoyaltyPoints: set lanza -> re-lanza', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: false, setThrows: true }));
    await expect(gt.addLoyaltyPoints('uid1', '+1234', 10)).rejects.toThrow('set fail');
  });

  test('getLoyaltyPoints: snap existe -> retorna points', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: true, getData: { points: 250 } }));
    const r = await gt.getLoyaltyPoints('uid1', '+1234');
    expect(r).toBe(250);
  });

  test('getLoyaltyPoints: snap no existe -> 0', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getExists: false }));
    const r = await gt.getLoyaltyPoints('uid1', '+1234');
    expect(r).toBe(0);
  });

  test('getLoyaltyPoints: get lanza -> 0', async () => {
    gt.__setFirestoreForTests(makeNestedDb({ getThrows: true }));
    const r = await gt.getLoyaltyPoints('uid1', '+1234');
    expect(r).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  test('getInactiveContacts: lastContactAt null -> filtrado', () => {
    const contacts = [
      { phone: '+1', lastContactAt: null },
      { phone: '+2', lastContactAt: new Date(Date.now() - 35 * 86400000).toISOString() },
      { phone: '+3', lastContactAt: new Date(Date.now() - 10 * 86400000).toISOString() },
    ];
    const r = gt.getInactiveContacts(contacts);
    expect(r.length).toBe(1);
    expect(r[0].phone).toBe('+2');
  });

  test('getInactiveContacts: daysThreshold custom', () => {
    const contacts = [{ phone: '+1', lastContactAt: new Date(Date.now() - 10 * 86400000).toISOString() }];
    const r = gt.getInactiveContacts(contacts, 5);
    expect(r.length).toBe(1);
  });
});

// ===== INTER_MIIA extra =====
describe('P5 extra2 -- inter_miia missing branches', () => {
  test('sendInterMiia: Firestore log lanza -> success=true + warn', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    const mockAI = jest.fn().mockResolvedValue('Mensaje generado');
    const admin = {
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({
              add: jest.fn().mockRejectedValue(new Error('firestore fail')),
            }),
          }),
        }),
      }),
    };
    const r = await im.sendInterMiia({
      ownerUid: 'uid_extra2_log_fail_' + Date.now(),
      ownerName: 'Juan', ownerPhone: '+1@s.whatsapp.net',
      targetPhone: '+2@s.whatsapp.net', targetName: 'Maria',
      action: 'MENSAJE', detail: 'hola',
      safeSendMessage: mockSend, generateAIContent: mockAI, admin,
    });
    expect(r.success).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  test('detectIncomingInterMiia: JSON.parse falla -> data.detail=string', () => {
    const INTER_MIIA_TAG = im.INTER_MIIA_TAG;
    const invalidJson = 'texto sin json';
    const text = 'mensaje ' + INTER_MIIA_TAG + ':MENSAJE:' + invalidJson;
    const r = im.detectIncomingInterMiia(text);
    expect(r.isInterMiia).toBe(true);
    expect(r.data.detail).toBe(invalidJson);
  });

  test('processIncomingInterMiia: AGENDAR -> notif con agende', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    await im.processIncomingInterMiia({
      safeSendMessage: mockSend, ownerPhone: '+1@s', action: 'AGENDAR',
      data: { from: 'Pedro' }, cleanMessage: 'reunion manana', senderPhone: '+2@s',
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][1]).toContain('agende');
  });

  test('processIncomingInterMiia: RECORDAR -> notif con Recordatorio', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    await im.processIncomingInterMiia({
      safeSendMessage: mockSend, ownerPhone: '+1@s', action: 'RECORDAR',
      data: { from: 'Ana' }, cleanMessage: 'pagar factura', senderPhone: '+2@s',
    });
    expect(mockSend.mock.calls[0][1]).toContain('Recordatorio');
  });

  test('processIncomingInterMiia: PREGUNTAR -> notif con Pregunta', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    await im.processIncomingInterMiia({
      safeSendMessage: mockSend, ownerPhone: '+1@s', action: 'PREGUNTAR',
      data: { from: 'Carlos' }, cleanMessage: 'disponibilidad?', senderPhone: '+2@s',
    });
    expect(mockSend.mock.calls[0][1]).toContain('Pregunta');
  });

  test('processIncomingInterMiia: MENSAJE default -> notif con Mensaje', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    await im.processIncomingInterMiia({
      safeSendMessage: mockSend, ownerPhone: '+1@s', action: 'MENSAJE',
      data: { from: 'Luis' }, cleanMessage: 'hola', senderPhone: '+2@s',
    });
    expect(mockSend.mock.calls[0][1]).toContain('Mensaje');
  });

  test('processIncomingInterMiia: data.from nulo -> usa alguien', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    await im.processIncomingInterMiia({
      safeSendMessage: mockSend, ownerPhone: '+1@s', action: 'MENSAJE',
      data: {}, cleanMessage: 'hola', senderPhone: '+2@s',
    });
    expect(mockSend.mock.calls[0][1]).toContain('alguien');
  });

  test('findContactByName: encontrado en familyContacts', async () => {
    const admin = { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }) }) }) }) };
    const r = await im.findContactByName(admin, 'uid1', 'Juan', { '573001234567': { name: 'Juan' } }, {});
    expect(r.name).toBe('Juan');
  });

  test('findContactByName: encontrado en teamContacts', async () => {
    const admin = { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }) }) }) }) };
    const r = await im.findContactByName(admin, 'uid1', 'Maria', {}, { '573009876543': { name: 'Maria' } });
    expect(r.name).toBe('Maria');
  });

  test('findContactByName: encontrado en Firestore contact_index', async () => {
    const admin = { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ get: jest.fn().mockResolvedValue({ docs: [{ id: '573001', data: () => ({ name: 'Roberto' }) }] }) }) }) }) }) };
    const r = await im.findContactByName(admin, 'uid1', 'Roberto', {}, {});
    expect(r.name).toBe('Roberto');
  });

  test('findContactByName: no encontrado -> null', async () => {
    const admin = { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ get: jest.fn().mockResolvedValue({ docs: [] }) }) }) }) }) };
    const r = await im.findContactByName(admin, 'uid1', 'Desconocido', {}, {});
    expect(r).toBeNull();
  });

  test('findContactByName: Firestore lanza -> null', async () => {
    const admin = { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ get: jest.fn().mockRejectedValue(new Error('fail')) }) }) }) }) };
    const r = await im.findContactByName(admin, 'uid1', 'Alguien', {}, {});
    expect(r).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

// ===== SOCIAL_MEDIA_MANAGER extra =====
describe('P5 extra2 -- social_media_manager missing branches', () => {
  function makeSnapWith(docs) {
    return { forEach: (fn) => docs.forEach(d => fn({ data: () => d })) };
  }

  test('getScheduledPosts: sin platform -> retorna todos', async () => {
    const docs = [{ uid: 'u1', platform: 'instagram' }, { uid: 'u1', platform: 'twitter' }];
    smm.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(makeSnapWith(docs)) }) }) });
    const r = await smm.getScheduledPosts('u1');
    expect(r.length).toBe(2);
  });

  test('getScheduledPosts: con platform -> filtra', async () => {
    const docs = [{ uid: 'u1', platform: 'instagram' }, { uid: 'u1', platform: 'twitter' }];
    smm.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(makeSnapWith(docs)) }) }) });
    const r = await smm.getScheduledPosts('u1', 'instagram');
    expect(r.length).toBe(1);
    expect(r[0].platform).toBe('instagram');
  });

  test('getInboxDMs: sin platform -> retorna todos', async () => {
    const docs = [{ uid: 'u1', platform: 'instagram' }, { uid: 'u1', platform: 'facebook' }];
    smm.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(makeSnapWith(docs)) }) }) });
    const r = await smm.getInboxDMs('u1');
    expect(r.length).toBe(2);
  });

  test('getInboxDMs: con platform -> filtra', async () => {
    const docs = [{ uid: 'u1', platform: 'instagram' }, { uid: 'u1', platform: 'facebook' }];
    smm.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(makeSnapWith(docs)) }) }) });
    const r = await smm.getInboxDMs('u1', 'facebook');
    expect(r.length).toBe(1);
    expect(r[0].platform).toBe('facebook');
  });
});

// ===== SOCIAL_LISTENING extra =====
describe('P5 extra2 -- social_listening missing branches', () => {
  function makeForEachDb(docs) {
    return { collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ forEach: (fn) => docs.forEach(d => fn({ data: () => d })) }) }) }) };
  }

  test('getMentionStats: sentiment desconocido no incrementa bySentiment', async () => {
    sl.__setFirestoreForTests(makeForEachDb([
      { platform: 'instagram', sentiment: 'positive' },
      { platform: 'twitter', sentiment: 'unknown_type' },
    ]));
    const r = await sl.getMentionStats('uid1');
    expect(r.total).toBe(2);
    expect(r.bySentiment.positive).toBe(1);
    expect(r.bySentiment.neutral).toBe(0);
  });

  test('getMentionStats: sentiment negative incrementa', async () => {
    sl.__setFirestoreForTests(makeForEachDb([{ platform: 'twitter', sentiment: 'negative' }]));
    const r = await sl.getMentionStats('uid1');
    expect(r.bySentiment.negative).toBe(1);
  });

  test('processMention: campos nulos -> usa defaults', async () => {
    sl.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }) }) });
    const r = await sl.processMention('uid1', {});
    expect(r.platform).toBe('unknown');
    expect(r.author).toBe('anonymous');
    expect(r.text).toBe('');
    expect(r.sentiment).toBe('neutral');
  });

  test('getMentionStats: byPlatform mismo platform x2 -> incrementa a 2', async () => {
    sl.__setFirestoreForTests(makeForEachDb([
      { platform: 'tiktok', sentiment: 'neutral' },
      { platform: 'tiktok', sentiment: 'neutral' },
    ]));
    const r = await sl.getMentionStats('uid1');
    expect(r.byPlatform.tiktok).toBe(2);
  });
});
