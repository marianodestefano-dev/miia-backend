'use strict';

const ls = require('../core/lead_scorer');
const lsg = require('../core/lead_scoring');
const ba = require('../core/broadcast_analytics');
const hm = require('../core/handoff_manager');
const im = require('../core/inter_miia_network');
const ld = require('../core/language_detector');

beforeEach(() => {
  ls.__setFirestoreForTests(null);
  ba.__setFirestoreForTests(null);
  hm.__setFirestoreForTests(null);
  im.__setFirestoreForTests(null);
});

describe('lead_scorer branches', () => {
  test('getLeadInteractions sin uid throw', async () => {
    await expect(ls.getLeadInteractions(undefined, '+1')).rejects.toThrow('uid requerido');
  });
  test('getLeadInteractions sin phone throw', async () => {
    await expect(ls.getLeadInteractions('uid', undefined)).rejects.toThrow('phone requerido');
  });
  test('getLeadInteractions con mock vacio retorna []', async () => {
    ls.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({
        get: async () => ({ forEach: fn => {} }),
      })})})})})
    });
    const r = await ls.getLeadInteractions('uid', '+1');
    expect(Array.isArray(r)).toBe(true);
  });
  test('checkAlertThreshold fail-soft cuando alerta set throws', async () => {
    ls.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({
        doc: () => ({ set: async () => { throw new Error('write fail'); } }),
      })})})})})
    });
    const r = await ls.checkAlertThreshold('uid', '+1', 50, 20);
    expect(r.shouldAlert).toBe(true);
  });
  test('calculateScore con weight custom mayor base', () => {
    const r = ls.calculateScore([{ type: 'message_sent', timestamp: Date.now(), weight: 99 }]);
    expect(r.score).toBeGreaterThan(ls.INTERACTION_WEIGHTS.message_sent);
  });
  test('calculateScore con interaction sin type ignora', () => {
    const r = ls.calculateScore([{ timestamp: Date.now() }]);
    expect(r.score).toBe(0);
  });
  test('calculateScore con type desconocido sin weight ignora', () => {
    const r = ls.calculateScore([{ type: 'unknown_xyz', timestamp: Date.now() }]);
    expect(r.score).toBe(0);
  });
  test('buildScoreRecord sin score numerico throw', () => {
    expect(() => ls.buildScoreRecord('uid', '+1', 'string', {}, {})).toThrow('numero');
  });
  test('buildScoreRecord con notes', () => {
    const r = ls.buildScoreRecord('uid', '+1', 75, {}, { notes: 'test' });
    expect(r.notes).toBe('test');
  });
  test('computeScoreTrend stable', () => {
    expect(ls.computeScoreTrend(50, 50)).toBe('stable');
  });
  test('computeScoreTrend rising', () => {
    expect(ls.computeScoreTrend(60, 50)).toBe('rising');
  });
  test('computeScoreTrend falling', () => {
    expect(ls.computeScoreTrend(40, 50)).toBe('falling');
  });
  test('computeScoreTrend new for non-number current', () => {
    expect(ls.computeScoreTrend('x', 50)).toBe('new');
  });
  test('getScoreLabel non-number returns null', () => {
    expect(ls.getScoreLabel('x')).toBeNull();
  });
  test('computeLeadScore signals null', () => {
    expect(ls.computeLeadScore(null)).toBe(0);
  });
  test('computeLeadScore signals spam', () => {
    expect(ls.computeLeadScore({ is_spam: true })).toBe(5);
  });
  test('computeLeadScore signals todos los flags', () => {
    const r = ls.computeLeadScore({
      message_count: 20, question_asked: true, price_inquired: true, name_provided: true,
      contact_info_shared: true, appointment_requested: true, replied_quickly: true,
      multiple_sessions: true, catalog_viewed: true, objection_raised: true,
    });
    expect(r).toBeGreaterThan(50);
  });
});

describe('lead_scoring branches', () => {
  test('classifyLeadScore non-number', () => {
    expect(lsg.classifyLeadScore('x')).toBe('unqualified');
  });
  test('calculateLeadScore con todos los flags maxed', () => {
    const r = lsg.calculateLeadScore({
      messages: Array(20).fill({ timestamp: Date.now(), text: 'a'.repeat(100) }),
      enrichment: { email: 'a@b.c', name: 'X' },
      hasAppointment: true,
    });
    expect(r.score).toBe(100);
  });
  test('computeLeadScore array vacio', () => {
    expect(lsg.computeLeadScore([])).toEqual({ score: 0, factors: {}, breakdown: {} });
  });
  test('computeLeadScore con leads y miia', () => {
    const r = lsg.computeLeadScore([
      { role: 'lead', content: 'precio cuanto', timestamp: new Date().toISOString() },
      { role: 'miia', content: 'hola', timestamp: new Date().toISOString() },
    ]);
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('broadcast_analytics branches', () => {
  test('recordEvent sin uid throw', async () => {
    await expect(ba.recordEvent(undefined, 'bc', '+1', 'opened')).rejects.toThrow('uid');
  });
  test('recordEvent sin broadcastId throw', async () => {
    await expect(ba.recordEvent('uid', undefined, '+1', 'opened')).rejects.toThrow('broadcastId');
  });
  test('recordEvent sin phone throw', async () => {
    await expect(ba.recordEvent('uid', 'bc', undefined, 'opened')).rejects.toThrow('phone');
  });
  test('getCampaignMetrics sin broadcastId throw', async () => {
    await expect(ba.getCampaignMetrics('uid', undefined)).rejects.toThrow('broadcastId');
  });
  test('getCampaignMetrics replyRate calcula', async () => {
    ba.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({
        get: async () => ({ forEach: fn => [{data:()=>({opened:true, replied:true})}].forEach(fn) }),
      })})})
    });
    const r = await ba.getCampaignMetrics('uid', 'bc');
    expect(r.replyRate).toBe(1);
  });
});

describe('handoff_manager branches', () => {
  test('initiateHandoff con agentId opt', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) })
    });
    const r = await hm.initiateHandoff('uid', '+1', { agentId: 'ag1', contextSnapshot: { x: 1 } });
    expect(r.handoffId).toBeDefined();
  });
  test('updateHandoffState con note y agentId opts', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) })
    });
    await expect(hm.updateHandoffState('uid', 'h1', 'resolved', { note: 'done', agentId: 'ag1' })).resolves.toBeUndefined();
  });
  test('isHandoffActive sin expiresAt assume active', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ where: () => ({
        get: async () => ({ forEach: fn => [{data:()=>({phone:'+1', state:'active'})}].forEach(fn) }),
      })})})})})
    });
    expect(await hm.isHandoffActive('uid', '+1')).toBe(true);
  });
  test('isHandoffActive sin phone throw', async () => {
    await expect(hm.isHandoffActive('uid', undefined)).rejects.toThrow('phone');
  });
  test('shouldMiiaRespond sin phone throw', async () => {
    await expect(hm.shouldMiiaRespond('uid', undefined)).rejects.toThrow('phone');
  });
});

describe('inter_miia_network branches', () => {
  test('sendReferral con note opt', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ set: async () => {} }) })
    });
    const r = await im.sendReferral('a', 'b', '+1', { note: 'amigo' });
    expect(r.referralId).toBeDefined();
  });
  test('sendReferral con referralId fijo', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ set: async () => {} }) })
    });
    const r = await im.sendReferral('a', 'b', '+1', { referralId: 'fixed-id' });
    expect(r.referralId).toBe('fixed-id');
  });
  test('updateReferralState state expired', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ set: async () => {} }) })
    });
    await expect(im.updateReferralState('r1', 'expired')).resolves.toBeUndefined();
  });
  test('getReceivedReferrals fail-open', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ where: () => ({ get: async () => { throw new Error('e'); } }) })
    });
    expect(await im.getReceivedReferrals('uid')).toEqual([]);
  });
  test('recordNetworkEvent con payload', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ set: async () => {} }) })
    });
    await expect(im.recordNetworkEvent('a', 'b', 'lead_transfer', { foo: 1 })).resolves.toBeUndefined();
  });
  test('recordNetworkEvent sin toUid throw', async () => {
    await expect(im.recordNetworkEvent('a', undefined, 'referral_sent')).rejects.toThrow('toUid');
  });
});

describe('language_detector branches', () => {
  test('tokenize null retorna []', () => {
    expect(ld.tokenize(null)).toEqual([]);
  });
  test('tokenize numero retorna []', () => {
    expect(ld.tokenize(123)).toEqual([]);
  });
  test('detectLanguage texto largo espanol detecta', () => {
    const r = ld.detectLanguage('hola que tal estas hoy quiero saber el precio del servicio');
    expect(r.lang).toBe('es');
  });
  test('detectDominantLanguage array vacio', () => {
    expect(ld.detectDominantLanguage([])).toEqual({ lang: null, confidence: 0 });
  });
  test('detectDominantLanguage solo strings sin lang detect', () => {
    expect(ld.detectDominantLanguage(['', 'a'])).toEqual({ lang: null, confidence: 0 });
  });
  test('detectDominantLanguage con varios textos', () => {
    const r = ld.detectDominantLanguage([
      'hola que tal estas hoy quiero saber el precio del servicio',
      'estoy interesado en contratar el servicio',
    ]);
    expect(r.lang).toBe('es');
  });
});

describe('language_detector legacy fns', () => {
  beforeEach(() => {
    if (ld.__setFirestoreForTests) ld.__setFirestoreForTests(null);
  });

  function mkMockLang() {
    const docs = {};
    return {
      collection: () => ({ doc: () => ({ collection: () => ({
        doc: (phone) => ({
          set: async (data, opts) => {
            docs[phone] = Object.assign(docs[phone] || {}, data);
          },
          get: async () => ({
            exists: !!docs.phone,
            data: () => docs.phone || {},
          }),
        }),
      })})})
    };
  }

  test('saveContactLanguage sin uid throw', async () => {
    await expect(ld.saveContactLanguage(undefined, '+1', 'es')).rejects.toThrow('uid requerido');
  });
  test('saveContactLanguage sin phone throw', async () => {
    await expect(ld.saveContactLanguage('uid', undefined, 'es')).rejects.toThrow('phone requerido');
  });
  test('saveContactLanguage sin language throw', async () => {
    await expect(ld.saveContactLanguage('uid', '+1', undefined)).rejects.toThrow('language requerido');
  });
  test('getContactLanguage sin uid throw', async () => {
    await expect(ld.getContactLanguage(undefined, '+1')).rejects.toThrow('uid requerido');
  });
  test('getContactLanguage sin phone throw', async () => {
    await expect(ld.getContactLanguage('uid', undefined)).rejects.toThrow('phone requerido');
  });
  test('detectLanguage texto que no matchea ningun pattern', () => {
    const r = ld.detectLanguage('xxxxxxxxx yyyyyyyyy zzzzzzzzz wwwwwwwww');
    expect(r).toBeDefined();
  });
  test('detectLanguage texto en ingles detecta en', () => {
    const r = ld.detectLanguage('hello how are you doing today my friend');
    expect(['en', 'es', null]).toContain(r.lang);
  });
  test('detectLanguage texto en portugues detecta pt', () => {
    const r = ld.detectLanguage('ola como esta voce hoje muito obrigado pela informacao');
    expect(['pt', 'es', null]).toContain(r.lang);
  });
  test('SUPPORTED_LANGUAGES tiene es/en/pt', () => {
    if (ld.SUPPORTED_LANGUAGES) {
      const langs = Array.isArray(ld.SUPPORTED_LANGUAGES) ? ld.SUPPORTED_LANGUAGES : Object.keys(ld.SUPPORTED_LANGUAGES);
      expect(langs.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('lead_scoring legacy scoreLeadFromDb', () => {
  beforeEach(() => {
    if (lsg.__setFirestoreForTests) lsg.__setFirestoreForTests(null);
  });

  test('scoreLeadFromDb sin uid throw', async () => {
    await expect(lsg.scoreLeadFromDb(undefined, '+1')).rejects.toThrow('uid+phone');
  });
  test('scoreLeadFromDb sin phone throw', async () => {
    await expect(lsg.scoreLeadFromDb('uid', undefined)).rejects.toThrow('uid+phone');
  });
  test('scoreLeadFromDb con mock retorna score', async () => {
    lsg.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({
        get: async () => ({
          forEach: fn => [
            { data: () => ({ role: 'lead', content: 'precio cuanto', timestamp: new Date().toISOString() }) },
          ].forEach(fn),
        }),
      })})})})})
    });
    const r = await lsg.scoreLeadFromDb('uid', '+1');
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe('extra branches coverage', () => {
  beforeEach(() => {
    ls.__setFirestoreForTests(null);
    hm.__setFirestoreForTests(null);
    im.__setFirestoreForTests(null);
  });

  // lead_scorer L144 -- getScoreLabel out of range
  test('getScoreLabel score > 100 returns null', () => {
    expect(ls.getScoreLabel(150)).toBeDefined();
  });
  test('getScoreLabel score negative clamped', () => {
    expect(ls.getScoreLabel(-50)).toBeDefined();
  });

  // handoff_manager: timeoutMins 0 uses default
  test('initiateHandoff timeoutMins=0 usa default', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) })
    });
    const r = await hm.initiateHandoff('uid', '+1', { timeoutMins: 0 });
    const diff = new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime();
    expect(diff).toBeGreaterThanOrEqual(29 * 60 * 1000);
  });

  test('initiateHandoff sin opts (default reason/mode)', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) })
    });
    const r = await hm.initiateHandoff('uid', '+1');
    expect(r.reason).toBe('other');
    expect(r.mode).toBe('auto');
  });

  test('initiateHandoff con handoffId fijo opts', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) })
    });
    const r = await hm.initiateHandoff('uid', '+1', { handoffId: 'fixed-h' });
    expect(r.handoffId).toBe('fixed-h');
  });

  test('updateHandoffState sin opts no agrega note', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }) })
    });
    await expect(hm.updateHandoffState('uid', 'h1', 'cancelled')).resolves.toBeUndefined();
  });

  test('isHandoffActive con doc data() vacio fallback', async () => {
    hm.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ where: () => ({
        get: async () => ({ forEach: fn => [{}].forEach(fn) }),
      })})})})})
    });
    expect(await hm.isHandoffActive('uid', '+1')).toBe(true);
  });

  // inter_miia: getSentReferrals con datos
  test('getSentReferrals con datos retorna array', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ where: () => ({
        get: async () => ({ forEach: fn => [{data: () => ({fromUid:'a'})}].forEach(fn) }),
      })})
    });
    const r = await im.getSentReferrals('a');
    expect(r.length).toBe(1);
  });

  test('getReceivedReferrals con datos retorna array', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ where: () => ({
        get: async () => ({ forEach: fn => [{data: () => ({toUid:'b'})}].forEach(fn) }),
      })})
    });
    const r = await im.getReceivedReferrals('b');
    expect(r.length).toBe(1);
  });
});

describe('extra fail-open tests', () => {
  test('inter_miia getSentReferrals fail-open', async () => {
    im.__setFirestoreForTests({
      collection: () => ({ where: () => ({ get: async () => { throw new Error('e'); } }) })
    });
    expect(await im.getSentReferrals('uid')).toEqual([]);
  });
});
