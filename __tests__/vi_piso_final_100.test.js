'use strict';
/**
 * vi_piso_final_100.test.js -- ramas residuales finales para 100% en pisos 5-6-7
 * agent_dashboard(line23), dashboard_aggregator(193-196), dashboard_summary(61-68),
 * enterprise_onboarding(13), network_messaging(26), social_listening(10),
 * social_media_manager(14), social_proof(10)
 */

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
        where: jest.fn().mockReturnThis(),
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
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
      }),
    };
  }
  function mkCol2() {
    return {
      doc: jest.fn().mockImplementation(function() { return mkDoc2(); }),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
    };
  }
  var fdb = { collection: jest.fn().mockImplementation(function() { return mkCol2(); }) };
  return { firestore: jest.fn().mockReturnValue(fdb), auth: jest.fn().mockReturnValue({}) };
});

// ================================================================
// agent_dashboard -- line 23: doc.data().permissions || []
// ================================================================
describe('FINAL agent_dashboard: permissions||[] right branch', function() {
  var ad = require('../core/agent_dashboard');

  test('getAgentPermissions: doc existe sin campo permissions -> || [] rama derecha', async function() {
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: function() { return {}; },
              }),
              set: jest.fn().mockResolvedValue({}),
            };
          },
        };
      },
    };
    ad.__setFirestoreForTests(db);
    var r = await ad.getAgentPermissions('uid1', '+57300');
    expect(Array.isArray(r)).toBe(true);
    expect(r).toHaveLength(0);
  });
});

// ================================================================
// dashboard_aggregator -- lines 193-196: funnel f.X || 0 right branches
// ================================================================
describe('FINAL dashboard_aggregator: funnel cero -> || 0 right branches', function() {
  var da = require('../core/dashboard_aggregator');

  test('buildDashboardText: todos los valores funnel=0 -> todos f.X||0 right branches', function() {
    var snap = {
      date: '2026-05-11', timeframe: 'week',
      sections: {
        leads: { funnel: { spam: 0, frio: 0, interesado: 0, caliente: 0, listo: 0 } },
      },
    };
    var r = da.buildDashboardText(snap);
    expect(r).toContain('Funnel');
  });

  test('buildDashboardText: overview con pendingFollowUps=0 (rama false linea 187)', function() {
    var snap = {
      date: '2026-05-11', timeframe: 'week',
      sections: {
        overview: {
          totalLeads: 5, newLeads: 2, conversionRate: 0.2,
          totalRevenue: 100, pendingPayments: 0,
          totalMessages: 20, avgResponseTime: 5,
          pendingFollowUps: 0,
        },
        leads: { funnel: { spam: 0, frio: 1, interesado: 0, caliente: 2, listo: 0 } },
      },
    };
    var r = da.buildDashboardText(snap);
    expect(r).toContain('Leads');
    expect(r).not.toContain('Follow-ups');
  });
});

// ================================================================
// dashboard_summary -- lines 61-68: todos los contactType branches
// ================================================================
describe('FINAL dashboard_summary: todos los contactType branches', function() {
  var ds = require('../core/dashboard_summary');
  afterEach(function() { ds.__setFirestoreForTests(null); });

  function makeDb(contactTypes, conversations) {
    return {
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
                          return { conversations: conversations, contactTypes: contactTypes };
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
  }

  test('contactType=lead -> t===lead (left branch ||) -> totalLeads++', async function() {
    var convs = { '+57300': [{ timestamp: Date.now() - 1000, text: 'hola' }] };
    var types = { '+57300': 'lead' };
    ds.__setFirestoreForTests(makeDb(types, convs));
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.totalLeads).toBe(1);
  });

  test('contactType=miia_lead -> || right branch -> totalLeads++', async function() {
    var convs = { '+57300': [{ timestamp: Date.now() - 1000, text: 'hola' }] };
    var types = { '+57300': 'miia_lead' };
    ds.__setFirestoreForTests(makeDb(types, convs));
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.totalLeads).toBe(1);
  });

  test('contactType=client -> else if true branch -> totalClients++', async function() {
    var convs = { '+57300': [{ timestamp: Date.now() - 1000, text: 'hola' }] };
    var types = { '+57300': 'client' };
    ds.__setFirestoreForTests(makeDb(types, convs));
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.totalClients).toBe(1);
    expect(r.totalLeads).toBe(0);
  });

  test('conversations[phone] no es array -> Array.isArray false -> msgs=[]', async function() {
    var convs = { '+57300': 'not_an_array' };
    var types = { '+57300': 'lead' };
    ds.__setFirestoreForTests(makeDb(types, convs));
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.recentMessageCount).toBe(0);
  });

  test('timestamp antiguo -> fuera de rango 7 dias -> no cuenta reciente', async function() {
    var oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    var convs = { '+57300': [{ timestamp: oldTs, text: 'viejo' }] };
    var types = { '+57300': 'lead' };
    ds.__setFirestoreForTests(makeDb(types, convs));
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.recentMessageCount).toBe(0);
  });

  test('timestamp no numerico -> typeof !== number -> no cuenta', async function() {
    var convs = { '+57300': [{ timestamp: 'cadena', text: 'hola' }] };
    var types = { '+57300': 'lead' };
    ds.__setFirestoreForTests(makeDb(types, convs));
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.recentMessageCount).toBe(0);
  });
});

// ================================================================
// enterprise_onboarding -- line 13: opts || {} right branch
// ================================================================
describe('FINAL enterprise_onboarding: opts||{} right branch', function() {
  var eo = require('../core/enterprise_onboarding');
  var mockDb = {
    collection: function() {
      return { doc: function() { return { set: jest.fn().mockResolvedValue({}) }; } };
    },
  };

  test('createEnterpriseAccount(null) -> opts||{} right branch -> throw', async function() {
    eo.__setFirestoreForTests(mockDb);
    await expect(eo.createEnterpriseAccount(null)).rejects.toThrow('uid, companyName, contactEmail required');
  });

  test('createEnterpriseAccount() sin args -> undefined -> opts||{} right branch', async function() {
    eo.__setFirestoreForTests(mockDb);
    await expect(eo.createEnterpriseAccount()).rejects.toThrow('uid, companyName, contactEmail required');
  });
});

// ================================================================
// network_messaging -- line 26: snap.exists=true branches
// ================================================================
describe('FINAL network_messaging: checkRateLimit snap.exists=true', function() {
  var nm = require('../core/network_messaging');
  afterEach(function() { nm.__setFirestoreForTests(null); });

  test('snap.exists=true + count=2 -> ternary true + count||0 left branch', async function() {
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: function() { return { count: 2 }; },
              }),
              set: jest.fn().mockResolvedValue({}),
            };
          },
        };
      },
    };
    nm.__setFirestoreForTests(db);
    var r = await nm.checkRateLimit('fromUid', 'toUid');
    expect(r.count).toBe(2);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(3);
  });

  test('snap.exists=true + sin campo count -> || 0 right branch', async function() {
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              get: jest.fn().mockResolvedValue({
                exists: true,
                data: function() { return {}; },
              }),
              set: jest.fn().mockResolvedValue({}),
            };
          },
        };
      },
    };
    nm.__setFirestoreForTests(db);
    var r = await nm.checkRateLimit('fromUid', 'toUid');
    expect(r.count).toBe(0);
    expect(r.allowed).toBe(true);
  });
});

// ================================================================
// social_listening -- line 10: opts || {} right branch
// ================================================================
describe('FINAL social_listening: registerMentionWebhook opts||{} right branch', function() {
  var sl = require('../core/social_listening');
  var mockDb = {
    collection: function() {
      return { doc: function() { return { set: jest.fn().mockResolvedValue({}) }; } };
    },
  };

  test('registerMentionWebhook(uid, null) -> opts||{} right -> throw', async function() {
    sl.__setFirestoreForTests(mockDb);
    await expect(sl.registerMentionWebhook('uid1', null)).rejects.toThrow('uid, platform, webhookUrl required');
  });

  test('registerMentionWebhook(uid) sin opts -> undefined -> right branch', async function() {
    sl.__setFirestoreForTests(mockDb);
    await expect(sl.registerMentionWebhook('uid1')).rejects.toThrow('uid, platform, webhookUrl required');
  });
});

// ================================================================
// social_media_manager -- line 14: pageId||null + accessToken ternary
// ================================================================
describe('FINAL social_media_manager: registerSocialAccount branches', function() {
  var smm = require('../core/social_media_manager');

  function makeDb() {
    return {
      collection: function() {
        return {
          doc: function() {
            return {
              set: jest.fn().mockResolvedValue({}),
              get: jest.fn().mockResolvedValue({ exists: false }),
            };
          },
          where: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: function() {} }),
        };
      },
    };
  }

  test('sin pageId y sin accessToken -> null right branches (line 14)', async function() {
    smm.__setFirestoreForTests(makeDb());
    var r = await smm.registerSocialAccount('uid1', 'instagram', {});
    expect(r.pageId).toBeNull();
    expect(r.accessToken).toBeNull();
  });

  test('con pageId y accessToken -> left/true branches (line 14)', async function() {
    smm.__setFirestoreForTests(makeDb());
    var r = await smm.registerSocialAccount('uid1', 'instagram', { pageId: 'pg1', accessToken: 'tok_secret' });
    expect(r.pageId).toBe('pg1');
    expect(r.accessToken).toBe('[REDACTED]');
  });

  test('plataforma invalida -> throw (linea 13 branch)', async function() {
    smm.__setFirestoreForTests(makeDb());
    await expect(smm.registerSocialAccount('uid1', 'MySpace', {})).rejects.toThrow('Unsupported platform');
  });
});

// ================================================================
// social_proof -- line 10: opts || {} right branch
// ================================================================
describe('FINAL social_proof: addTestimonial opts||{} right branch', function() {
  var sp = require('../core/social_proof');
  var mockDb = {
    collection: function() {
      return { doc: function() { return { set: jest.fn().mockResolvedValue({}) }; } };
    },
  };

  test('addTestimonial(uid, null) -> opts||{} right branch -> throw text required', async function() {
    sp.__setFirestoreForTests(mockDb);
    await expect(sp.addTestimonial('uid1', null)).rejects.toThrow('uid and text required');
  });

  test('addTestimonial(uid) sin opts -> undefined -> right branch', async function() {
    sp.__setFirestoreForTests(mockDb);
    await expect(sp.addTestimonial('uid1')).rejects.toThrow('uid and text required');
  });
});

// ================================================================
// analytics_dashboard -- branches residuales
// line 88: d.value || 0 right branch
// line 110: period==='quarter' branch
// line 134: engagementRate count>0 branch (getDashboard)
// line 167: compareMetrics branches
// ================================================================
describe('FINAL analytics_dashboard: branches residuales', function() {
  var analytics = require('../core/analytics_dashboard');
  afterEach(function() { analytics.__setFirestoreForTests(null); });

  function makeDbWithDocs(docs) {
    // Simula db().collection().doc().collection().where().where().get()
    // Para getMetricSummary usa: db().collection('analytics').doc(uid)
    //   .collection('events').where(...).where(...).get()
    var fakeSnap = {
      forEach: function(cb) {
        docs.forEach(function(d) {
          cb({ data: function() { return d; } });
        });
      },
    };
    var innerCol = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue(fakeSnap),
    };
    var docObj = {
      collection: jest.fn().mockReturnValue(innerCol),
      get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      set: jest.fn().mockResolvedValue({}),
    };
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue(docObj),
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(fakeSnap),
      }),
    };
  }

  test('getMetricSummary: doc con value=0 -> d.value||0 right branch (line 88)', async function() {
    // d.value = 0 (falsy) -> 0 || 0 = 0 -> right branch de ||
    var db = makeDbWithDocs([{ value: 0, metricType: 'messages_received', recordedAt: new Date().toISOString() }]);
    analytics.__setFirestoreForTests(db);
    var r = await analytics.getMetricSummary('uid1', 'messages_received', 'week');
    expect(r.total).toBe(0); // d.value=0, 0||0=0
    expect(r.count).toBe(1); // 1 doc procesado
  });

  test('getMetricSummary: period=quarter -> _periodToMs quarter branch (line 110)', async function() {
    // period='quarter' -> _periodToMs('quarter') -> if(quarter) return 90*DAY -> branch cubierto
    analytics.__setFirestoreForTests(makeDbWithDocs([]));
    var r = await analytics.getMetricSummary('uid1', 'messages_received', 'quarter');
    expect(r.period).toBe('quarter');
  });

  test('getDashboard: count>0 -> engagementRate ternary true branch (line 134)', async function() {
    // getDashboard llama getMetricSummary para cada metrica
    // Con docs que tienen value=1 -> count>0 -> engagementRate = sent.count/received.count
    var db = makeDbWithDocs([{ value: 1, metricType: 'messages_received', recordedAt: new Date().toISOString() }]);
    analytics.__setFirestoreForTests(db);
    var r = await analytics.getDashboard('uid1', 'week');
    expect(r).toHaveProperty('summary');
    expect(r.summary).toHaveProperty('engagementRate');
  });

  test('compareMetrics: valid period -> prd=period (ternary true branch, line 167)', async function() {
    // period='day' -> period && PERIOD_TYPES.includes('day') = true -> prd='day'
    analytics.__setFirestoreForTests(makeDbWithDocs([]));
    var r = await analytics.compareMetrics('uid1', 'messages_received', 'day');
    expect(r).toHaveProperty('current');
    expect(r).toHaveProperty('previous');
    expect(r.current.period).toBe('day');
  });

  test('compareMetrics: period invalido -> DEFAULT_PERIOD (ternary false branch)', async function() {
    // period='unknown' -> 'unknown' && PERIOD_TYPES.includes('unknown') = false -> DEFAULT_PERIOD
    analytics.__setFirestoreForTests(makeDbWithDocs([]));
    var r = await analytics.compareMetrics('uid1', 'messages_received', 'unknown');
    expect(r.current.period).toBe('week'); // DEFAULT_PERIOD
  });

  test('compareMetrics: previous.total>0 -> changePercent Math.round (ternary true, line 177)', async function() {
    // Provide docs para current period con value=5, previous period con value=3
    // current.total=5, previous.total=3 -> previous.total>0 -> Math.round branch
    var callCount = 0;
    var db = {
      collection: function() {
        return {
          doc: function() {
            return {
              collection: function() {
                return {
                  where: jest.fn().mockReturnThis(),
                  get: jest.fn().mockImplementation(function() {
                    callCount++;
                    // First call (current period): return doc with value=5
                    // Second call (previous period): return doc with value=3
                    var val = callCount <= 1 ? 5 : 3;
                    return Promise.resolve({
                      forEach: function(cb) {
                        cb({ data: function() { return { value: val }; } });
                      },
                    });
                  }),
                };
              },
              get: jest.fn().mockResolvedValue({ exists: false }),
              set: jest.fn().mockResolvedValue({}),
            };
          },
        };
      },
    };
    analytics.__setFirestoreForTests(db);
    var r = await analytics.compareMetrics('uid1', 'messages_received', 'week');
    expect(r).toHaveProperty('changePercent');
    // previous.total=3>0 -> changePercent = Math.round((5-3)/3 * 100 * 10) / 10 = 66.7
  });
});

// ================================================================
// dashboard_aggregator -- line 167: all 4 || 0 branches
// ================================================================
describe('FINAL dashboard_aggregator: getLatestDashboardSnapshot sort branches', function() {
  var da = require('../core/dashboard_aggregator');
  afterEach(function() { da.__setFirestoreForTests(null); });

  function makeDbWithDocs(docs) {
    return {
      collection: function() {
        return {
          doc: function() {
            return {
              collection: function() {
                return {
                  get: jest.fn().mockResolvedValue({
                    forEach: function(cb) {
                      docs.forEach(function(d) {
                        cb({ data: function() { return d; } });
                      });
                    },
                  }),
                };
              },
            };
          },
        };
      },
    };
  }

  test('sort: doc1 generatedAt=1000, doc2 generatedAt=undefined -> left+right branches', async function() {
    // a=doc2(undefined), b=doc1(1000): b.gen||0 -> left(1000), a.gen||0 -> right(0)
    var docs = [
      { timeframe: 'week', date: '2026-05-09', generatedAt: 1000 },
      { timeframe: 'week', date: '2026-05-10' },
    ];
    da.__setFirestoreForTests(makeDbWithDocs(docs));
    var r = await da.getLatestDashboardSnapshot('uid1', 'week');
    expect(r).toBeDefined();
    expect(r.generatedAt).toBe(1000);
  });

  test('sort: doc1 generatedAt=1000, doc2 generatedAt=0 -> left(a)+right(b) branches', async function() {
    // a=doc1(1000), b=doc2(0): b.gen||0 -> right(0 falsy), a.gen||0 -> left(1000)
    var docs = [
      { timeframe: 'week', date: '2026-05-09', generatedAt: 1000 },
      { timeframe: 'week', date: '2026-05-10', generatedAt: 0 },
    ];
    da.__setFirestoreForTests(makeDbWithDocs(docs));
    var r = await da.getLatestDashboardSnapshot('uid1', 'week');
    expect(r).toBeDefined();
    expect(r.generatedAt).toBe(1000);
  });
});

// ================================================================
// dashboard_summary -- line 61: else if false branch (contactType unknown)
// ================================================================
describe('FINAL dashboard_summary: else if false branch (unknown contactType)', function() {
  var ds = require('../core/dashboard_summary');
  afterEach(function() { ds.__setFirestoreForTests(null); });

  test('contactType=unknown -> neither if nor else-if -> else if false branch', async function() {
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
                            conversations: { '+57300': [] },
                            contactTypes: { '+57300': 'family' },
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
    // t='family' -> t!=='lead' && t!=='miia_lead' -> if false
    //            -> t!=='client' -> else if false -> neither branch taken
    var r = await ds.buildDashboardSummary('uid1');
    expect(r.totalLeads).toBe(0);
    expect(r.totalClients).toBe(0);
    expect(r.totalContacts).toBe(1);
  });
});

// ================================================================
// analytics_dashboard -- _periodToMs: default branch (line 111)
// if (period === 'quarter') FALSE -> return 7 * DAY
// Via public API unreachable (guard normalises period before call).
// Covered via exported __periodToMsForTests.
// ================================================================
describe('FINAL analytics_dashboard: _periodToMs default branch direct', function() {
  var analytics = require('../core/analytics_dashboard');

  test('_periodToMs("unknown") -> if(quarter) FALSE -> return 7*DAY', function() {
    var DAY = 24 * 60 * 60 * 1000;
    expect(analytics.__periodToMsForTests('unknown_period')).toBe(7 * DAY);
  });

  test('_periodToMs("day") -> if(day) TRUE branch', function() {
    var DAY = 24 * 60 * 60 * 1000;
    expect(analytics.__periodToMsForTests('day')).toBe(DAY);
  });

  test('_periodToMs("month") -> if(month) TRUE branch', function() {
    var DAY = 24 * 60 * 60 * 1000;
    expect(analytics.__periodToMsForTests('month')).toBe(30 * DAY);
  });
});

// ================================================================
// admin_dashboard -- line 6: _db || require(firebase).db right branch
// All existing tests call __setFirestoreForTests first.
// This test calls getAllTenants() without setting _db -> triggers right branch.
// ================================================================
describe('FINAL admin_dashboard: getDb() right branch (line 6)', function() {
  var adm = require('../core/admin_dashboard');

  beforeEach(function() {
    adm.__setFirestoreForTests(null); // reset to null -> forces right branch
  });

  afterEach(function() {
    adm.__setFirestoreForTests(null);
  });

  test('getAllTenants() with _db=null -> _db||firebase.db right branch', async function() {
    // firebase mock at top of file provides { db: { collection: ... } }
    var r = await adm.getAllTenants();
    expect(Array.isArray(r)).toBe(true);
  });
});

