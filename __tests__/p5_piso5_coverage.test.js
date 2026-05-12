'use strict';

jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));

let nd, nm, gm, sp_mod, sl, smm, gt, im;

function makeDb({ exists = false, data = null, throwGet = false, throwSet = false, throwUpdate = false, docs = [] } = {}) {
  const docSnap = {
    exists,
    data: () => data,
  };
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: throwGet
          ? jest.fn().mockRejectedValue(new Error('get fail'))
          : jest.fn().mockResolvedValue(docSnap),
        set: throwSet
          ? jest.fn().mockRejectedValue(new Error('set fail'))
          : jest.fn().mockResolvedValue({}),
        update: throwUpdate
          ? jest.fn().mockRejectedValue(new Error('update fail'))
          : jest.fn().mockResolvedValue({}),
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({
            get: throwGet
              ? jest.fn().mockRejectedValue(new Error('get fail'))
              : jest.fn().mockResolvedValue(docSnap),
            set: throwSet
              ? jest.fn().mockRejectedValue(new Error('set fail'))
              : jest.fn().mockResolvedValue({}),
          }),
          add: jest.fn().mockResolvedValue({ id: 'new-id' }),
        }),
      }),
      where: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({ empty: docs.length === 0, docs: docs.map(d => ({ data: () => d })) }),
              }),
            }),
            get: jest.fn().mockResolvedValue({ docs: docs.map(d => ({ data: () => d })), forEach: fn => docs.forEach(d => fn({ data: () => d })) }),
          }),
          get: jest.fn().mockResolvedValue({ docs: docs.map(d => ({ data: () => d })), forEach: fn => docs.forEach(d => fn({ data: () => d })) }),
        }),
        get: jest.fn().mockResolvedValue({ docs: docs.map(d => ({ data: () => d })), forEach: fn => docs.forEach(d => fn({ data: () => d })) }),
      }),
      get: jest.fn().mockResolvedValue({ docs: docs.map(d => ({ data: () => d })), forEach: fn => docs.forEach(d => fn({ data: () => d })) }),
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
  nd = require('../core/network_directory');
  nm = require('../core/network_messaging');
  gm = require('../core/growth_metrics');
  sp_mod = require('../core/social_proof');
  sl = require('../core/social_listening');
  smm = require('../core/social_media_manager');
  gt = require('../core/growth_tools');
  im = require('../core/inter_miia');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  [nd, nm, gm, sp_mod, sl, smm, gt].forEach(m => { if (m && m.__setFirestoreForTests) m.__setFirestoreForTests(null); });
  jest.restoreAllMocks();
});

// ============== NETWORK DIRECTORY ==============
describe('P5 -- network_directory branches', () => {
  test('registerBusiness: uid/name/category faltante -> throw', async () => {
    nd.__setFirestoreForTests(makeDb());
    await expect(nd.registerBusiness(null, { name: 'X', category: 'salud' })).rejects.toThrow();
    await expect(nd.registerBusiness('uid1', { category: 'salud' })).rejects.toThrow();
  });

  test('registerBusiness: categoria invalida -> throw', async () => {
    nd.__setFirestoreForTests(makeDb());
    await expect(nd.registerBusiness('uid1', { name: 'Biz', category: 'invalida' })).rejects.toThrow('invalid category');
  });

  test('registerBusiness: valido con description/location/phone -> entry', async () => {
    nd.__setFirestoreForTests(makeDb());
    const r = await nd.registerBusiness('uid1', { name: 'Mi Clinica', category: 'salud', description: 'Desc', location: 'Bogota', phone: '+571234' });
    expect(r.name).toBe('Mi Clinica');
    expect(r.category).toBe('salud');
    expect(r.description).toBe('Desc');
    expect(r.visible).toBe(true);
  });

  test('registerBusiness: sin description/location/phone -> usa defaults', async () => {
    nd.__setFirestoreForTests(makeDb());
    const r = await nd.registerBusiness('uid1', { name: 'Resto', category: 'gastronomia' });
    expect(r.description).toBe('');
    expect(r.location).toBeNull();
    expect(r.phone).toBeNull();
  });

  test('searchDirectory: sin filtros -> todos los negocios visibles', async () => {
    const docs = [{ name: 'Clinica Salud', category: 'salud', description: 'salud' }, { name: 'Resto Pizza', category: 'gastronomia', description: 'comida' }];
    nd.__setFirestoreForTests(makeDb({ docs }));
    const r = await nd.searchDirectory(null, null);
    expect(r.length).toBe(2);
  });

  test('searchDirectory: con category filter -> filtra', async () => {
    const docs = [{ name: 'A', category: 'salud', description: '' }, { name: 'B', category: 'comercio', description: '' }];
    nd.__setFirestoreForTests(makeDb({ docs }));
    const r = await nd.searchDirectory(null, 'salud');
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('A');
  });

  test('searchDirectory: con query filter -> filtra por nombre/descripcion', async () => {
    const docs = [{ name: 'Clinica Norte', category: 'salud', description: 'atencion medica' }, { name: 'Resto', category: 'gastronomia', description: 'pizza' }];
    nd.__setFirestoreForTests(makeDb({ docs }));
    const r = await nd.searchDirectory('clinica', null);
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Clinica Norte');
  });

  test('recommendBusiness: uid/leadMessage faltante -> throw', async () => {
    nd.__setFirestoreForTests(makeDb());
    await expect(nd.recommendBusiness(null, 'busco medico')).rejects.toThrow();
    await expect(nd.recommendBusiness('uid1', null)).rejects.toThrow();
  });

  test('recommendBusiness: match por category -> retorna negocio', async () => {
    const docs = [{ uid: 'other', name: 'Clinica', category: 'salud' }, { uid: 'uid1', name: 'Propio', category: 'comercio' }];
    nd.__setFirestoreForTests(makeDb({ docs }));
    const r = await nd.recommendBusiness('uid1', 'necesito salud');
    expect(r).not.toBeNull();
    expect(r.name).toBe('Clinica');
  });

  test('recommendBusiness: sin match -> null', async () => {
    const docs = [{ uid: 'other', name: 'Panaderia', category: 'gastronomia' }];
    nd.__setFirestoreForTests(makeDb({ docs }));
    const r = await nd.recommendBusiness('uid1', 'busco electrodomesticos');
    expect(r).toBeNull();
  });
});

// ============== NETWORK MESSAGING ==============
describe('P5 -- network_messaging branches', () => {
  test('getOptInStatus: uid faltante -> throw', async () => {
    nm.__setFirestoreForTests(makeDb());
    await expect(nm.getOptInStatus(null)).rejects.toThrow();
  });

  test('getOptInStatus: doc no existe -> optedIn=false', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: false }));
    const r = await nm.getOptInStatus('uid1');
    expect(r.optedIn).toBe(false);
  });

  test('getOptInStatus: doc existe sin networkOptIn -> optedIn=false', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: true, data: { networkOptIn: false } }));
    const r = await nm.getOptInStatus('uid1');
    expect(r.optedIn).toBe(false);
  });

  test('getOptInStatus: doc existe con networkOptIn=true -> optedIn=true', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: true, data: { networkOptIn: true } }));
    const r = await nm.getOptInStatus('uid1');
    expect(r.optedIn).toBe(true);
  });

  test('setOptIn: uid faltante -> throw', async () => {
    nm.__setFirestoreForTests(makeDb());
    await expect(nm.setOptIn(null, true)).rejects.toThrow();
  });

  test('setOptIn: valido -> actualiza', async () => {
    nm.__setFirestoreForTests(makeDb());
    const r = await nm.setOptIn('uid1', true);
    expect(r.optedIn).toBe(true);
  });

  test('checkRateLimit: doc no existe -> count=0, allowed=true', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: false }));
    const r = await nm.checkRateLimit('uid1', 'uid2');
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(0);
  });

  test('checkRateLimit: count >= 5 -> allowed=false', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: true, data: { count: 5 } }));
    const r = await nm.checkRateLimit('uid1', 'uid2');
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  test('sendNetworkMessage: params faltantes -> throw', async () => {
    nm.__setFirestoreForTests(makeDb());
    await expect(nm.sendNetworkMessage(null, 'uid2', 'hola')).rejects.toThrow();
  });

  test('sendNetworkMessage: destinatario no optedIn -> throw', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: false }));
    await expect(nm.sendNetworkMessage('uid1', 'uid2', 'hola')).rejects.toThrow('not opted in');
  });

  test('sendNetworkMessage: rate limit excedido -> throw', async () => {
    nm.__setFirestoreForTests(makeDb({ exists: true, data: { networkOptIn: true, count: 5 } }));
    await expect(nm.sendNetworkMessage('uid1', 'uid2', 'hola')).rejects.toThrow('rate limit');
  });
});

// ============== GROWTH METRICS ==============
describe('P5 -- growth_metrics branches', () => {
  test('getActivationTime: uid faltante -> throw', async () => {
    gm.__setFirestoreForTests(makeDb());
    await expect(gm.getActivationTime(null)).rejects.toThrow();
  });

  test('getActivationTime: owner no existe -> null', async () => {
    gm.__setFirestoreForTests(makeDb({ exists: false }));
    const r = await gm.getActivationTime('uid1');
    expect(r).toBeNull();
  });

  test('getActivationTime: owner existe, sin leads -> firstLeadAt=null', async () => {
    const db = makeDb({ exists: true, data: { createdAt: Date.now() } });
    // La query de leads devuelve vacio
    db.collection.mockReturnValue({
      doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ createdAt: Date.now() }) }) }),
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }),
        }),
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }),
          }),
          get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
        }),
        get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
      }),
    });
    gm.__setFirestoreForTests(db);
    const r = await gm.getActivationTime('uid1');
    expect(r.firstLeadAt).toBeNull();
  });

  test('getRetention30d: uid faltante -> throw', async () => {
    gm.__setFirestoreForTests(makeDb());
    await expect(gm.getRetention30d(null)).rejects.toThrow();
  });

  test('getRetention30d: sin leads -> rate=0', async () => {
    const db = {
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ docs: [] }),
          where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ docs: [] }) }),
        }),
      }),
    };
    gm.__setFirestoreForTests(db);
    const r = await gm.getRetention30d('uid1');
    expect(r.total).toBe(0);
    expect(r.rate).toBe(0);
  });

  test('getRetention30d: con leads -> calcula rate', async () => {
    let callCount = 0;
    const db = {
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => ({
          get: jest.fn().mockImplementation(() => {
            callCount++;
            return Promise.resolve({ docs: callCount === 1 ? [1, 2, 3] : [1] });
          }),
          where: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ docs: [1] }),
          }),
        })),
      }),
    };
    gm.__setFirestoreForTests(db);
    const r = await gm.getRetention30d('uid1');
    expect(typeof r.rate).toBe('number');
  });

  test('getGrowthSummary: uid faltante -> throw', async () => {
    gm.__setFirestoreForTests(makeDb());
    await expect(gm.getGrowthSummary(null)).rejects.toThrow();
  });
});

// ============== SOCIAL PROOF ==============
describe('P5 -- social_proof branches', () => {
  test('addTestimonial: uid/text faltante -> throw', async () => {
    sp_mod.__setFirestoreForTests(makeDb());
    await expect(sp_mod.addTestimonial(null, { text: 'X' })).rejects.toThrow();
    await expect(sp_mod.addTestimonial('uid1', { })).rejects.toThrow();
  });

  test('addTestimonial: con todos los campos -> entry completo', async () => {
    sp_mod.__setFirestoreForTests(makeDb());
    const r = await sp_mod.addTestimonial('uid1', { authorName: 'Juan', text: 'Excelente servicio', rating: 5 });
    expect(r.authorName).toBe('Juan');
    expect(r.text).toBe('Excelente servicio');
    expect(r.active).toBe(true);
  });

  test('addTestimonial: sin authorName -> usa Anonimo', async () => {
    sp_mod.__setFirestoreForTests(makeDb());
    const r = await sp_mod.addTestimonial('uid1', { text: 'Bien' });
    expect(r.authorName).toBe('Anonimo');
  });

  test('getTopTestimonials: uid faltante -> throw', async () => {
    sp_mod.__setFirestoreForTests(makeDb());
    await expect(sp_mod.getTopTestimonials(null)).rejects.toThrow();
  });

  test('getTopTestimonials: sin limit -> usa 3', async () => {
    const docs = [
      { rating: 4, text: 'A', authorName: 'X', active: true },
      { rating: 5, text: 'B', authorName: 'Y', active: true },
      { rating: 3, text: 'C', authorName: 'Z', active: true },
    ];
    sp_mod.__setFirestoreForTests(makeDb({ docs }));
    const r = await sp_mod.getTopTestimonials('uid1');
    expect(r.length).toBeLessThanOrEqual(3);
    expect(r[0].rating).toBe(5);
  });

  test('syncGoogleReviews: uid/placeId faltante -> throw', async () => {
    sp_mod.__setFirestoreForTests(makeDb());
    await expect(sp_mod.syncGoogleReviews(null, 'place1')).rejects.toThrow();
    await expect(sp_mod.syncGoogleReviews('uid1', null)).rejects.toThrow();
  });

  test('syncGoogleReviews: valido -> stub', async () => {
    sp_mod.__setFirestoreForTests(makeDb());
    const r = await sp_mod.syncGoogleReviews('uid1', 'ChIJ123');
    expect(r.status).toBe('synced_stub');
    expect(r.placeId).toBe('ChIJ123');
  });

  test('buildSocialProofSnippet: vacio -> ""', () => {
    expect(sp_mod.buildSocialProofSnippet([])).toBe('');
    expect(sp_mod.buildSocialProofSnippet(null)).toBe('');
  });

  test('buildSocialProofSnippet: con testimonials -> snippet', () => {
    const r = sp_mod.buildSocialProofSnippet([{ text: 'Excelente', authorName: 'Juan', rating: 5 }]);
    expect(r).toContain('Excelente');
    expect(r).toContain('Juan');
  });
});

// ============== SOCIAL LISTENING ==============
describe('P5 -- social_listening branches', () => {
  test('registerMentionWebhook: uid/platform/webhookUrl faltante -> throw', async () => {
    sl.__setFirestoreForTests(makeDb());
    await expect(sl.registerMentionWebhook(null, { platform: 'twitter', webhookUrl: 'http://x' })).rejects.toThrow();
  });

  test('registerMentionWebhook: plataforma invalida -> throw', async () => {
    sl.__setFirestoreForTests(makeDb());
    await expect(sl.registerMentionWebhook('uid1', { platform: 'myspace', webhookUrl: 'http://x' })).rejects.toThrow('invalid platform');
  });

  test('registerMentionWebhook: valido con keywords -> config', async () => {
    sl.__setFirestoreForTests(makeDb());
    const r = await sl.registerMentionWebhook('uid1', { platform: 'twitter', webhookUrl: 'http://hook', keywords: ['miia', 'clinic'] });
    expect(r.platform).toBe('twitter');
    expect(r.keywords).toEqual(['miia', 'clinic']);
    expect(r.active).toBe(true);
  });

  test('registerMentionWebhook: sin keywords -> []', async () => {
    sl.__setFirestoreForTests(makeDb());
    const r = await sl.registerMentionWebhook('uid1', { platform: 'instagram', webhookUrl: 'http://hook' });
    expect(r.keywords).toEqual([]);
  });

  test('processMention: uid/mention faltante -> throw', async () => {
    sl.__setFirestoreForTests(makeDb());
    await expect(sl.processMention(null, { text: 'hola' })).rejects.toThrow();
    await expect(sl.processMention('uid1', null)).rejects.toThrow();
  });

  test('processMention: con mention completo -> record', async () => {
    sl.__setFirestoreForTests(makeDb());
    const r = await sl.processMention('uid1', { platform: 'facebook', author: 'User1', text: 'Muy buena clinica!', sentiment: 'positive' });
    expect(r.platform).toBe('facebook');
    expect(r.sentiment).toBe('positive');
  });

  test('getMentionStats: uid faltante -> throw', async () => {
    sl.__setFirestoreForTests(makeDb());
    await expect(sl.getMentionStats(null)).rejects.toThrow();
  });

  test('getMentionStats: sin menciones -> stats vacios', async () => {
    sl.__setFirestoreForTests(makeDb({ docs: [] }));
    const r = await sl.getMentionStats('uid1');
    expect(r.total).toBe(0);
  });

  test('getMentionStats: con menciones -> cuenta por plataforma', async () => {
    const docs = [
      { platform: 'twitter', sentiment: 'positive' },
      { platform: 'twitter', sentiment: 'negative' },
      { platform: 'instagram', sentiment: 'neutral' },
    ];
    sl.__setFirestoreForTests(makeDb({ docs }));
    const r = await sl.getMentionStats('uid1');
    expect(r.total).toBe(3);
  });
});

// ============== SOCIAL MEDIA MANAGER ==============
describe('P5 -- social_media_manager branches', () => {
  test('registerSocialAccount: plataforma invalida -> throw', async () => {
    smm.__setFirestoreForTests(makeDb());
    await expect(smm.registerSocialAccount('uid1', 'myspace', {})).rejects.toThrow('Unsupported platform');
  });

  test('registerSocialAccount: valido con accessToken -> [REDACTED]', async () => {
    smm.__setFirestoreForTests(makeDb());
    const r = await smm.registerSocialAccount('uid1', 'instagram', { accessToken: 'secret', pageId: 'p1' });
    expect(r.platform).toBe('instagram');
    expect(r.accessToken).toBe('[REDACTED]');
  });

  test('registerSocialAccount: sin accessToken -> null', async () => {
    smm.__setFirestoreForTests(makeDb());
    const r = await smm.registerSocialAccount('uid1', 'facebook', { pageId: 'p1' });
    expect(r.accessToken).toBeNull();
  });

  test('receiveDM: plataforma invalida -> throw', async () => {
    smm.__setFirestoreForTests(makeDb());
    await expect(smm.receiveDM('uid1', 'snapchat', { senderId: 's1', message: 'hi' })).rejects.toThrow();
  });

  test('receiveDM: valido -> dm creado', async () => {
    smm.__setFirestoreForTests(makeDb());
    const r = await smm.receiveDM('uid1', 'twitter', { senderId: 'user123', message: 'hola' });
    expect(r.status).toBe('received');
    expect(r.senderId).toBe('user123');
  });

  test('replyToDM: valido -> replied', async () => {
    smm.__setFirestoreForTests(makeDb());
    const r = await smm.replyToDM('uid1', 'dm123', 'Hola! Te respondo...');
    expect(r.status).toBe('replied');
    expect(r.dmId).toBe('dm123');
  });

  test('schedulePost: plataforma invalida -> throw', async () => {
    smm.__setFirestoreForTests(makeDb());
    await expect(smm.schedulePost('uid1', 'myspace', { content: 'X', scheduledAt: new Date().toISOString() })).rejects.toThrow();
  });

  test('schedulePost: valido con mediaUrl -> post creado', async () => {
    smm.__setFirestoreForTests(makeDb());
    const r = await smm.schedulePost('uid1', 'instagram', { content: 'Post de prueba', mediaUrl: 'http://img.jpg', scheduledAt: new Date().toISOString() });
    expect(r.status).toBe('scheduled');
    expect(r.mediaUrl).toBe('http://img.jpg');
  });

  test('schedulePost: sin mediaUrl -> null', async () => {
    smm.__setFirestoreForTests(makeDb());
    const r = await smm.schedulePost('uid1', 'facebook', { content: 'X', scheduledAt: new Date().toISOString() });
    expect(r.mediaUrl).toBeNull();
  });
});

// ============== GROWTH TOOLS extra branches ==============
describe('P5 -- growth_tools branches sin cubrir (85-86, 137)', () => {
  function makeGtDb({ getExists = true, getData = null, throwGet = false, throwSet = false } = {}) {
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({
              get: throwGet
                ? jest.fn().mockRejectedValue(new Error('get fail'))
                : jest.fn().mockResolvedValue({ exists: getExists, data: () => getData }),
              set: throwSet
                ? jest.fn().mockRejectedValue(new Error('set fail'))
                : jest.fn().mockResolvedValue({}),
            }),
          }),
          get: jest.fn().mockResolvedValue({ exists: getExists, data: () => getData }),
          set: throwSet
            ? jest.fn().mockRejectedValue(new Error('set fail'))
            : jest.fn().mockResolvedValue({}),
        }),
      }),
    };
  }

  test('applyReferralCode: Firestore.get lanza -> catch (lines 85-86)', async () => {
    gt.__setFirestoreForTests(makeGtDb({ throwGet: true }));
    const r = await gt.applyReferralCode('uid1', 'CODE123', '+5491111');
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('error');
    expect(console.error).toHaveBeenCalled();
  });

  test('addLoyaltyPoints: con reason -> usa reason (line 137)', async () => {
    gt.__setFirestoreForTests(makeGtDb({ getExists: true, getData: { points: 10 } }));
    const r = await gt.addLoyaltyPoints('uid1', '+5491111', 50, 'compra especial');
    expect(r.newTotal).toBe(60);
    expect(r.added).toBe(50);
  });

  test('addLoyaltyPoints: sin reason -> usa "purchase" (line 137 branch false)', async () => {
    gt.__setFirestoreForTests(makeGtDb({ getExists: false }));
    const r = await gt.addLoyaltyPoints('uid1', '+5491111', 30);
    expect(r.newTotal).toBe(30);
  });
});

// ============== INTER MIIA (pure functions) ==============
describe('P5 -- inter_miia pure functions', () => {
  test('detectInterMiiaCommand: texto null -> isInterMiia=false', () => {
    expect(im.detectInterMiiaCommand(null).isInterMiia).toBe(false);
    expect(im.detectInterMiiaCommand('').isInterMiia).toBe(false);
  });

  test('detectInterMiiaCommand: patron decile -> detecta AGENDAR', () => {
    const r = im.detectInterMiiaCommand('decile a la MIIA de Ale que me agende una reunion el viernes');
    expect(r.isInterMiia).toBe(true);
    expect(r.action).toBe('AGENDAR');
    expect(r.targetName).toBe('ale');
  });

  test('detectInterMiiaCommand: pedile -> detecta RECORDAR', () => {
    const r = im.detectInterMiiaCommand('pedile a la miia de Juan que le mandes un recordatorio de pagar');
    expect(r.isInterMiia).toBe(true);
    expect(r.action).toBe('RECORDAR');
  });

  test('detectInterMiiaCommand: preguntale -> detecta PREGUNTAR', () => {
    const r = im.detectInterMiiaCommand('preguntale a la MIIA de Maria si puede reunirse manana?');
    expect(r.isInterMiia).toBe(true);
    expect(r.action).toBe('PREGUNTAR');
  });

  test('detectInterMiiaCommand: avisale sin accion especifica -> MENSAJE', () => {
    const r = im.detectInterMiiaCommand('avisale a la MIIA de Pedro que lo saluda Mariano');
    expect(r.isInterMiia).toBe(true);
    expect(r.action).toBe('MENSAJE');
  });

  test('detectInterMiiaCommand: texto sin patron -> isInterMiia=false', () => {
    expect(im.detectInterMiiaCommand('hola como estas').isInterMiia).toBe(false);
  });

  test('detectIncomingInterMiia: sin tag -> isInterMiia=false', () => {
    const r = im.detectIncomingInterMiia('Hola, te escribo de parte de Mariano');
    expect(r.isInterMiia).toBe(false);
  });

  test('detectIncomingInterMiia: con tag valido -> detecta', () => {
    const tagData = JSON.stringify({ from: 'Mariano', fromUid: 'uid1', detail: 'agenda reunion' });
    const msg = 'Hola! Te escribe la MIIA de Mariano.\n\n[MIIA_INTER]:AGENDAR:' + tagData;
    const r = im.detectIncomingInterMiia(msg);
    expect(r.isInterMiia).toBe(true);
    expect(r.action).toBe('AGENDAR');
  });

  test('sendInterMiia: rate limit excedido -> success=false', async () => {
    // Simular rate limit haciendo 6 llamadas rapidas al mismo uid
    const uid = 'uid_rate_limit_test_' + Date.now();
    const mockSend = jest.fn().mockResolvedValue({});
    const mockAI = jest.fn().mockResolvedValue('mensaje generado');
    const params = { ownerUid: uid, ownerName: 'Test', ownerPhone: '+1', targetPhone: '+2', targetName: 'Juan', action: 'MENSAJE', detail: 'hola', safeSendMessage: mockSend, generateAIContent: mockAI, admin: { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ add: jest.fn().mockResolvedValue({}) }) }) }) }) } };

    // Hacer 5 envios exitosos primero (para agotar el rate limit)
    for (let i = 0; i < 5; i++) {
      await im.sendInterMiia({ ...params });
    }
    // El 6to deberia ser rechazado
    const r = await im.sendInterMiia({ ...params });
    expect(r.success).toBe(false);
  });

  test('sendInterMiia: generateAIContent lanza -> usa fallback message', async () => {
    const mockSend = jest.fn().mockResolvedValue({});
    const uid = 'uid_ai_fail_' + Date.now();
    const r = await im.sendInterMiia({
      ownerUid: uid, ownerName: 'Mariano', ownerPhone: '+1', targetPhone: '+2', targetName: 'Ale',
      action: 'MENSAJE', detail: 'hola',
      safeSendMessage: mockSend,
      generateAIContent: async () => { throw new Error('AI down'); },
      admin: { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ add: jest.fn().mockResolvedValue({}) }) }) }) }) },
    });
    expect(r.success).toBe(true);
    expect(mockSend).toHaveBeenCalled();
  });

  test('sendInterMiia: safeSendMessage lanza -> success=false', async () => {
    const uid = 'uid_send_fail_' + Date.now();
    const r = await im.sendInterMiia({
      ownerUid: uid, ownerName: 'Mariano', ownerPhone: '+1', targetPhone: '+2', targetName: 'Ale',
      action: 'MENSAJE', detail: 'hola',
      safeSendMessage: async () => { throw new Error('WA down'); },
      generateAIContent: async () => 'mensaje ok',
      admin: { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ add: jest.fn().mockResolvedValue({}) }) }) }) }) },
    });
    expect(r.success).toBe(false);
  });
});
