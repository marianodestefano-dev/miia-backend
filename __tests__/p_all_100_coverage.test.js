'use strict';
/**
 * p_all_100_coverage.test.js
 * Cubre ramas faltantes para 100%% en PISO 5, 6, 7.
 * Patron principal: getDb() || require('../config/firebase').db (rama derecha)
 * y ramas especificas por modulo.
 */

// ===== MOCKS FIREBASE (hoisted, self-contained) =====

jest.mock('../config/firebase', () => {
  function mkDoc() {
    return {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      set: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
          set: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        }),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
      }),
    };
  }
  function mkCol() {
    return {
      doc: jest.fn().mockImplementation(function() { return mkDoc(); }),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
    };
  }
  return { db: { collection: jest.fn().mockImplementation(function() { return mkCol(); }) } };
});

jest.mock('firebase-admin', () => {
  function mkDoc2() {
    return {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      set: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
          set: jest.fn().mockResolvedValue({}),
        }),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
      }),
    };
  }
  function mkCol2() {
    return {
      doc: jest.fn().mockImplementation(function() { return mkDoc2(); }),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
    };
  }
  var fdb = { collection: jest.fn().mockImplementation(function() { return mkCol2(); }) };
  return { firestore: jest.fn().mockReturnValue(fdb), auth: jest.fn().mockReturnValue({}) };
});

// ===== PISO 7: getDb() || firebase fallback branches =====

describe('P7 Firebase fallback -- addon_billing', function() {
  var ab = require('../core/addon_billing');
  beforeEach(function() { ab.__setFirestoreForTests(null); });

  test('createAddonCheckout usa firebase cuando _db=null', async function() {
    var r = await ab.createAddonCheckout('uid1', 'ludo_miia', 'paypal');
    expect(r).toMatchObject({ uid: 'uid1', addonId: 'ludo_miia' });
  });
});

describe('P7 Firebase fallback -- addon_cards', function() {
  var ac = require('../core/addon_cards');
  beforeEach(function() { ac.__setFirestoreForTests(null); });

  test('getOwnerAddons usa firebase cuando _db=null', async function() {
    var r = await ac.getOwnerAddons('uid1');
    expect(r).toHaveProperty('ludo_miia');
  });
});

describe('P7 Firebase fallback -- addon_router', function() {
  var ar = require('../core/addon_router');
  beforeEach(function() { ar.__setFirestoreForTests(null); });

  test('getRoutingHistory usa firebase cuando _db=null', async function() {
    var r = await ar.getRoutingHistory('uid1');
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('P7 Firebase fallback -- addon_sso', function() {
  var as_ = require('../core/addon_sso');
  beforeEach(function() { as_.__setFirestoreForTests(null); });

  test('revokeSSOToken usa firebase cuando _db=null (empty snap -> throw)', async function() {
    await expect(as_.revokeSSOToken('fake_token')).rejects.toThrow('Token not found');
  });
});

describe('P7 Firebase fallback -- addon_webhooks', function() {
  var aw = require('../core/addon_webhooks');
  beforeEach(function() { aw.__setFirestoreForTests(null); });

  test('registerWebhook usa firebase cuando _db=null', async function() {
    var r = await aw.registerWebhook('uid1', 'ludo_miia', 'https://h.test', []);
    expect(r).toMatchObject({ uid: 'uid1', addonId: 'ludo_miia' });
  });
});

describe('P7 Firebase fallback -- games_subscription', function() {
  var gs = require('../core/games_subscription');
  beforeEach(function() { gs.__setFirestoreForTests(null); });

  test('createSubscription usa firebase cuando _db=null', async function() {
    var r = await gs.createSubscription('uid1', 'BASIC');
    expect(r).toMatchObject({ uid: 'uid1', plan: 'basic' });
  });
});

describe('P7 Firebase fallback -- ludomiia_host', function() {
  var lh = require('../core/ludomiia_host');
  beforeEach(function() { lh.__setFirestoreForTests(null); });

  test('activateLudoMIIA usa firebase cuando _db=null', async function() {
    var r = await lh.activateLudoMIIA('uid1', {});
    expect(r).toMatchObject({ uid: 'uid1' });
  });
});

// ===== PISO 6: getDb() || firebase fallback branches =====

describe('P6 Firebase fallback -- agent_dashboard', function() {
  var ad = require('../core/agent_dashboard');
  beforeEach(function() { ad.__setFirestoreForTests(null); });

  test('createAgentProfile usa firebase cuando _db=null', async function() {
    var r = await ad.createAgentProfile('uid1', '+57300', {});
    expect(r).toMatchObject({ uid: 'uid1', agentPhone: '+57300' });
  });
});

describe('P6 Firebase fallback -- agent_registry', function() {
  var areg = require('../core/agent_registry');
  beforeEach(function() { areg.__setFirestoreForTests(null); });

  test('generateAgentInviteLink usa firebase cuando _db=null', async function() {
    var r = await areg.generateAgentInviteLink('uid1', {});
    expect(r).toHaveProperty('token');
    expect(r).toHaveProperty('inviteUrl');
  });
});

describe('P6 Firebase fallback -- agent_mode getDb + rama threshold||0', function() {
  var am = require('../core/agent_mode');
  beforeEach(function() { am.__setFirestoreForTests(null); });

  test('setAutonomyLevel usa firebase cuando _db=null', async function() {
    var r = await am.setAutonomyLevel('uid1', 'low');
    expect(r).toMatchObject({ uid: 'uid1', level: 'low' });
  });

  test('decideAction: AUTONOMY_THRESHOLDS[none]=0 -> || 0 rama (linea 29)', async function() {
    // Inject db que devuelve agent_autonomy_level='none' y agent_enabled=true
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: function() { return { agent_autonomy_level: 'none', agent_enabled: true }; },
              }),
              set: jest.fn().mockResolvedValue({}),
            };
          },
        };
      },
    };
    am.__setFirestoreForTests(db);
    // AUTONOMY_THRESHOLDS['none'] = 0 (falsy) -> || 0 right branch
    var r = await am.decideAction('uid1', 'mensaje normal', { confidence: 0.8 });
    expect(r.decision).toBe('respond');
  });

  test('decideAction: context=null -> confidence=0.5 (rama ternario false)', async function() {
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: function() { return { agent_autonomy_level: 'low', agent_enabled: true }; },
              }),
            };
          },
        };
      },
    };
    am.__setFirestoreForTests(db);
    // context=null -> confidence = 0.5, threshold=0.3 -> 0.5 >= 0.3 -> respond
    var r = await am.decideAction('uid1', 'hola', null);
    expect(r.decision).toBe('respond');
  });
});

describe('P6 Firebase fallback -- billing_admin', function() {
  var ba = require('../core/billing_admin');
  beforeEach(function() { ba.__setFirestoreForTests(null); });

  test('changePlan usa firebase cuando _db=null', async function() {
    var r = await ba.changePlan('uid1', 'pro');
    expect(r).toMatchObject({ uid: 'uid1', plan: 'pro' });
  });
});

describe('P6 Firebase fallback -- enterprise_lead_flow', function() {
  var elf = require('../core/enterprise_lead_flow');
  beforeEach(function() { elf.__setFirestoreForTests(null); });

  test('captureEnterpriseLead usa firebase cuando _db=null', async function() {
    var r = await elf.captureEnterpriseLead('ent1', { name: 'Test', email: 'a@b.com' });
    expect(r).toHaveProperty('id');
  });
});

describe('P6 Firebase fallback -- enterprise_onboarding', function() {
  var eo = require('../core/enterprise_onboarding');
  beforeEach(function() { eo.__setFirestoreForTests(null); });

  test('createEnterpriseAccount usa firebase cuando _db=null', async function() {
    var r = await eo.createEnterpriseAccount({ uid: 'uid1', companyName: 'TestCo', contactEmail: 'a@b.com', seats: 10 });
    expect(r).toMatchObject({ id: 'uid1', companyName: 'TestCo' });
  });
});

describe('P6 Firebase fallback -- feature_flags_admin', function() {
  var ffa = require('../core/feature_flags_admin');
  beforeEach(function() { ffa.__setFirestoreForTests(null); });

  test('setFlag usa firebase cuando _db=null', async function() {
    var r = await ffa.setFlag('my_flag', true);
    expect(r).toMatchObject({ name: 'my_flag', value: true });
  });
});

describe('P6 Firebase fallback -- growth_metrics', function() {
  var gm = require('../core/growth_metrics');
  beforeEach(function() { gm.__setFirestoreForTests(null); });

  test('getGrowthSummary usa firebase cuando _db=null', async function() {
    var r = await gm.getGrowthSummary('uid1');
    expect(r).toHaveProperty('uid');
  });
});

describe('P6 Firebase fallback -- social_listening', function() {
  var sl = require('../core/social_listening');
  beforeEach(function() { sl.__setFirestoreForTests(null); });

  test('getMentionStats usa firebase cuando _db=null', async function() {
    var r = await sl.getMentionStats('uid1');
    expect(r).toHaveProperty('uid');
  });
});

describe('P6 Firebase fallback -- social_media_manager', function() {
  var smm = require('../core/social_media_manager');
  beforeEach(function() { smm.__setFirestoreForTests(null); });

  test('getScheduledPosts usa firebase cuando _db=null', async function() {
    var r = await smm.getScheduledPosts('uid1', 'instagram');
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('P6 Firebase fallback -- social_proof', function() {
  var sp = require('../core/social_proof');
  beforeEach(function() { sp.__setFirestoreForTests(null); });

  test('syncGoogleReviews usa firebase cuando _db=null', async function() {
    var r = await sp.syncGoogleReviews('uid1', 'ChIJ_place_id');
    expect(r).toHaveProperty('reviewCount');
  });

  test('buildSocialProofSnippet: rating=0 -> || 5 rama', function() {
    // t.rating = 0 (falsy) -> || 5 right branch (linea 52)
    var r = sp.buildSocialProofSnippet([{ text: 'Excelente', authorName: 'Juan', rating: 0 }]);
    expect(r).toContain('(5/5)');
  });
});

// ===== PISO 5: Firebase fallback + ramas especificas =====

describe('P5 Firebase fallback -- dashboard_aggregator', function() {
  var da = require('../core/dashboard_aggregator');
  beforeEach(function() { da.__setFirestoreForTests(null); });

  test('getLatestDashboardSnapshot usa firebase cuando _db=null', async function() {
    var r = await da.getLatestDashboardSnapshot('uid1');
    expect(r).toBeNull(); // empty snap -> filtered=[] -> return null
  });

  test('buildLeadsFunnelData: score=0 (falsy) -> || 0 rama (linea 72)', function() {
    // score=0 is falsy -> (b.score || 0) - (a.score || 0) right branch
    var leads = [
      { phone: '+1', category: 'hot', score: 0 },
      { phone: '+2', category: 'warm', score: 0 },
    ];
    var r = da.buildLeadsFunnelData(leads);
    expect(r.section).toBe('leads');
    expect(r.topLeads.length).toBeLessThanOrEqual(2);
  });

  test('getLatestDashboardSnapshot: generatedAt=0 -> || 0 rama (linea 167)', async function() {
    // Injectar db con docs sin generatedAt (undefined -> || 0)
    var docs = [
      { timeframe: 'week', date: '2026-05-10' }, // sin generatedAt
      { timeframe: 'week', date: '2026-05-09', generatedAt: 1000 },
    ];
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              collection: function() {
                return {
                  get: jest.fn().mockResolvedValue({
                    forEach: function(cb) { docs.forEach(function(d) { cb({ data: function() { return d; } }); }); },
                  }),
                };
              },
            };
          },
        };
      },
    };
    da.__setFirestoreForTests(db);
    var r = await da.getLatestDashboardSnapshot('uid1', 'week');
    // Should return the one with generatedAt=1000 (sorted desc)
    expect(r).toBeDefined();
  });

  test('buildDashboardText: sections=null -> || {} rama (linea 180)', function() {
    // snapshot.sections=null -> || {} right branch
    var snap = { date: '2026-05-11', timeframe: 'week', sections: null };
    var r = da.buildDashboardText(snap);
    expect(typeof r).toBe('string');
    expect(r).toContain('Dashboard MIIA');
  });

  test('buildDashboardText: con overview completo y pendingFollowUps>0 (linea 181-187)', function() {
    var snap = {
      date: '2026-05-11',
      timeframe: 'week',
      sections: {
        overview: {
          totalLeads: 10, newLeads: 3, conversionRate: 0.3,
          totalRevenue: 500, pendingPayments: 50,
          totalMessages: 100, avgResponseTime: 30,
          pendingFollowUps: 5, // > 0 -> rama true (linea 187)
        },
        leads: {
          funnel: { spam: 1, frio: 2, interesado: 3, caliente: 1, listo: 0 },
        },
      },
    };
    var r = da.buildDashboardText(snap);
    expect(r).toContain('Leads');
    expect(r).toContain('Follow-ups');
    expect(r).toContain('Funnel');
  });
});

describe('P5 Firebase fallback -- dashboard_summary', function() {
  var ds = require('../core/dashboard_summary');
  beforeEach(function() { ds.__setFirestoreForTests(null); });

  test('buildDashboardSummary usa firebase cuando _db=null', async function() {
    // _db=null -> db() uses admin.firestore() mock
    // snap.exists=false -> data={} -> conversations={} contactTypes={}
    var r = await ds.buildDashboardSummary('uid1');
    expect(r).toHaveProperty('totalConversations');
  });

  test('buildDashboardSummary: contactType=miia_lead -> || operator right (linea 61)', async function() {
    // buildDashboardSummary usa collection('users').doc(uid).collection('miia_persistent').doc('tenant_conversations').get()
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              collection: function() {
                return {
                  doc: function() {
                    return {
                      get: jest.fn().mockResolvedValue({
                        exists: true,
                        data: function() {
                          return {
                            conversations: { '+57300': [{ timestamp: Date.now() - 1000, text: 'hola' }] },
                            contactTypes: { '+57300': 'miia_lead' },
                          };
                        },
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    ds.__setFirestoreForTests(db);
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.totalLeads).toBe(1); // miia_lead counts as lead -> || right branch linea 60
  });
});

describe('P5 Firebase fallback -- growth_tools', function() {
  var gt = require('../core/growth_tools');
  beforeEach(function() { gt.__setFirestoreForTests(null); });

  test('createReferralCode usa firebase cuando _db=null', async function() {
    var r = await gt.generateReferralCode('uid1', '+57300');
    expect(r).toHaveProperty('code');
  });
});

describe('P5 Firebase fallback -- network_messaging', function() {
  var nm = require('../core/network_messaging');

  test('sendNetworkMessage happy path -> ramas 36-41 (lineas uncovered)', async function() {
    var db = {
      collection: function(col) {
        return {
          doc: function() {
            return {
              get: jest.fn().mockResolvedValue(
                col === 'owners'
                  ? { exists: true, data: function() { return { networkOptIn: true }; } }
                  : { exists: false, data: function() { return {}; } }
              ),
              set: jest.fn().mockResolvedValue({}),
              update: jest.fn().mockResolvedValue({}),
            };
          },
        };
      },
    };
    nm.__setFirestoreForTests(db);
    var r = await nm.sendNetworkMessage('fromUid', 'toUid', 'Hola equipo!');
    expect(r).toHaveProperty('id');
    expect(r.fromUid).toBe('fromUid');
  });

  test('getDb() fallback: setOptIn usa firebase cuando _db=null', async function() {
    nm.__setFirestoreForTests(null);
    var r = await nm.setOptIn('uid1', true);
    expect(r).toMatchObject({ uid: 'uid1', optedIn: true });
  });
});

describe('P5 Firebase fallback -- analytics_dashboard', function() {
  var analytics = require('../core/analytics_dashboard');
  beforeEach(function() { analytics.__setFirestoreForTests(null); });

  test('getMetricSummary usa firebase cuando _db=null', async function() {
    var r = await analytics.getMetricSummary('uid1', 'messages_received', 'week');
    expect(r).toHaveProperty('total');
  });
});
