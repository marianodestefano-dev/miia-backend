'use strict';

// PISO 6 coverage -- agent_dashboard, agent_registry, enterprise_lead_flow,
//                    dashboard_summary, analytics_dashboard

jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
jest.mock('../config/firebase', () => ({ db: { collection: jest.fn() } }), { virtual: true });

const ad  = require('../core/agent_dashboard');
const ar  = require('../core/agent_registry');
const elf = require('../core/enterprise_lead_flow');
const ds  = require('../core/dashboard_summary');
const ana = require('../core/analytics_dashboard');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// ===== AGENT_DASHBOARD =====
describe('P6 -- agent_dashboard', () => {
  function makeAgentDb({ exists = true, perms = ['view_conversations', 'approve_actions'], decisionDocs = [] } = {}) {
    return {
      collection: jest.fn().mockImplementation(() => ({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists, data: () => ({ permissions: perms }) }),
          set: jest.fn().mockResolvedValue({}),
        }),
        where: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ forEach: (fn) => decisionDocs.forEach(d => fn({ data: () => d })) }),
          where: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ forEach: () => {} }) }),
        }),
      })),
    };
  }

  test('createAgentProfile: success con perms validas e invalidas mezcladas', async () => {
    ad.__setFirestoreForTests(makeAgentDb());
    const r = await ad.createAgentProfile('uid1', '+573001', { name: 'Juan', permissions: ['view_conversations', 'FAKE'] });
    expect(r.uid).toBe('uid1');
    expect(r.permissions).toContain('view_conversations');
    expect(r.permissions).not.toContain('FAKE');
  });

  test('createAgentProfile: sin opts -> defaults', async () => {
    ad.__setFirestoreForTests(makeAgentDb());
    const r = await ad.createAgentProfile('uid1', '+573001');
    expect(r.status).toBe('active');
  });

  test('getAgentPermissions: agente no existe -> throw', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ exists: false }));
    await expect(ad.getAgentPermissions('uid1', '+57')).rejects.toThrow('Agent not found');
  });

  test('getAgentPermissions: agente existe -> retorna perms', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ perms: ['reply', 'tag_leads'] }));
    const r = await ad.getAgentPermissions('uid1', '+57');
    expect(r).toContain('reply');
  });

  test('approveAction: decision invalida -> throw', async () => {
    ad.__setFirestoreForTests(makeAgentDb());
    await expect(ad.approveAction('uid1', '+57', 'act1', 'maybe')).rejects.toThrow('Invalid decision');
  });

  test('approveAction: sin approve_actions -> throw', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ perms: ['view_conversations'] }));
    await expect(ad.approveAction('uid1', '+57', 'act1', 'approved')).rejects.toThrow('lacks approve_actions');
  });

  test('approveAction: decision approved -> success', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ perms: ['approve_actions'] }));
    const r = await ad.approveAction('uid1', '+57', 'act1', 'approved');
    expect(r.decision).toBe('approved');
  });

  test('approveAction: decision rejected -> success', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ perms: ['approve_actions'] }));
    const r = await ad.approveAction('uid1', '+57', 'act1', 'rejected');
    expect(r.decision).toBe('rejected');
  });

  test('getConversationSummary: sin view_conversations -> throw', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ perms: ['reply'] }));
    await expect(ad.getConversationSummary('uid1', '+57', '+58')).rejects.toThrow('lacks view_conversations');
  });

  test('getConversationSummary: success', async () => {
    ad.__setFirestoreForTests(makeAgentDb({ perms: ['view_conversations'] }));
    const r = await ad.getConversationSummary('uid1', '+57', '+58');
    expect(r.messageCount).toBe(0);
  });

  test('updateAgentPermissions: perm invalida -> throw', async () => {
    ad.__setFirestoreForTests(makeAgentDb());
    await expect(ad.updateAgentPermissions('uid1', '+57', ['FAKE_PERM'])).rejects.toThrow('Invalid permissions');
  });

  test('updateAgentPermissions: success', async () => {
    ad.__setFirestoreForTests(makeAgentDb());
    const r = await ad.updateAgentPermissions('uid1', '+57', ['view_conversations', 'reply']);
    expect(r.permissions).toContain('view_conversations');
  });

  test('getAgentDashboardStats: cuenta approved y rejected', async () => {
    const decisions = [{ decision: 'approved' }, { decision: 'approved' }, { decision: 'rejected' }, { decision: 'other' }];
    ad.__setFirestoreForTests(makeAgentDb({ decisionDocs: decisions }));
    const r = await ad.getAgentDashboardStats('uid1', '+57');
    expect(r.actionsApproved).toBe(2);
    expect(r.actionsRejected).toBe(1);
    expect(r.totalDecisions).toBe(3);
  });
});

// ===== AGENT_REGISTRY =====
describe('P6 -- agent_registry', () => {
  function makeInviteDb({ empty = false, inviteData = null, docExists = true } = {}) {
    return {
      collection: jest.fn().mockImplementation(() => ({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: docExists, data: () => inviteData }),
          set: jest.fn().mockResolvedValue({}),
        }),
        where: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            empty,
            forEach: (fn) => { if (!empty && inviteData) fn({ data: () => inviteData }); },
          }),
        }),
      })),
    };
  }

  test('generateAgentInviteLink: success con role custom', async () => {
    ar.__setFirestoreForTests(makeInviteDb());
    const r = await ar.generateAgentInviteLink('uid1', { role: 'supervisor', permissions: ['reply'] });
    expect(r.inviteUrl).toContain('join/');
    expect(r.role).toBe('supervisor');
    expect(r.status).toBe('pending');
  });

  test('generateAgentInviteLink: sin opts -> defaults', async () => {
    ar.__setFirestoreForTests(makeInviteDb());
    const r = await ar.generateAgentInviteLink('uid1');
    expect(r.role).toBe('agent');
    expect(r.permissions).toContain('view_conversations');
  });

  test('acceptAgentInvite: token invalido -> throw', async () => {
    ar.__setFirestoreForTests(makeInviteDb({ empty: true }));
    await expect(ar.acceptAgentInvite('badtoken', '+57')).rejects.toThrow('Invalid invite token');
  });

  test('acceptAgentInvite: invite no pending -> throw', async () => {
    ar.__setFirestoreForTests(makeInviteDb({
      inviteData: { id: 'i1', uid: 'uid1', status: 'accepted', expiresAt: new Date(Date.now() + 999999).toISOString() },
    }));
    await expect(ar.acceptAgentInvite('tok', '+57')).rejects.toThrow('Invite is accepted');
  });

  test('acceptAgentInvite: invite expirado -> throw', async () => {
    ar.__setFirestoreForTests(makeInviteDb({
      inviteData: { id: 'i1', uid: 'uid1', status: 'pending', expiresAt: new Date(Date.now() - 9999999).toISOString() },
    }));
    await expect(ar.acceptAgentInvite('tok', '+57')).rejects.toThrow('expired');
  });

  test('acceptAgentInvite: success', async () => {
    ar.__setFirestoreForTests(makeInviteDb({
      inviteData: { id: 'i1', uid: 'uid1', status: 'pending', expiresAt: new Date(Date.now() + 9999999).toISOString(), permissions: ['reply'] },
    }));
    const r = await ar.acceptAgentInvite('tok', '+57');
    expect(r.status).toBe('accepted');
  });

  test('revokeAgentInvite: invite no encontrado -> throw', async () => {
    ar.__setFirestoreForTests(makeInviteDb({ docExists: false }));
    await expect(ar.revokeAgentInvite('uid1', 'inv1')).rejects.toThrow('Invite not found');
  });

  test('revokeAgentInvite: uid no autorizado -> throw', async () => {
    ar.__setFirestoreForTests(makeInviteDb({ inviteData: { id: 'inv1', uid: 'otherUid' } }));
    await expect(ar.revokeAgentInvite('uid1', 'inv1')).rejects.toThrow('Unauthorized');
  });

  test('revokeAgentInvite: success', async () => {
    ar.__setFirestoreForTests(makeInviteDb({ inviteData: { id: 'inv1', uid: 'uid1' } }));
    const r = await ar.revokeAgentInvite('uid1', 'inv1');
    expect(r.status).toBe('revoked');
  });

  test('listAgents: retorna array', async () => {
    const agents = [{ uid: 'uid1', agentPhone: '+57' }];
    ar.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ forEach: (fn) => agents.forEach(d => fn({ data: () => d })) }),
        }),
        doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
      }),
    });
    const r = await ar.listAgents('uid1');
    expect(r.length).toBe(1);
  });

  test('removeAgent: success', async () => {
    ar.__setFirestoreForTests(makeInviteDb());
    const r = await ar.removeAgent('uid1', '+57');
    expect(r.status).toBe('inactive');
  });
});

// ===== ENTERPRISE_LEAD_FLOW =====
describe('P6 -- enterprise_lead_flow', () => {
  function makeElfDb({ docExists = true, snapDocs = [] } = {}) {
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: docExists, data: () => ({}) }),
          set: jest.fn().mockResolvedValue({}),
        }),
        where: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            size: snapDocs.length,
            forEach: (fn) => snapDocs.forEach(d => fn({ data: () => d })),
          }),
        }),
      }),
    };
  }

  test('captureEnterpriseLead: success con name', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    const r = await elf.captureEnterpriseLead('ent1', { phone: '+57300', name: 'Sofia' });
    expect(r.stage).toBe('captured');
    expect(r.source).toBe('organic');
    expect(r.name).toBe('Sofia');
  });

  test('captureEnterpriseLead: sin name -> null, source custom', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    const r = await elf.captureEnterpriseLead('ent1', { phone: '+57300', source: 'referral' });
    expect(r.name).toBeNull();
    expect(r.source).toBe('referral');
  });

  test('qualifyLead: score invalido >100 -> throw', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    await expect(elf.qualifyLead('ent1', 'lead1', 150)).rejects.toThrow('Score must be 0-100');
  });

  test('qualifyLead: score invalido <0 -> throw', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    await expect(elf.qualifyLead('ent1', 'lead1', -5)).rejects.toThrow('Score must be 0-100');
  });

  test('qualifyLead: score string -> throw', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    await expect(elf.qualifyLead('ent1', 'lead1', 'alto')).rejects.toThrow('Score must be 0-100');
  });

  test('qualifyLead: score = QUALIFY_THRESHOLD -> qualified', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    const r = await elf.qualifyLead('ent1', 'lead1', 60);
    expect(r.stage).toBe('qualified');
    expect(r.qualified).toBe(true);
  });

  test('qualifyLead: score < QUALIFY_THRESHOLD -> captured', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    const r = await elf.qualifyLead('ent1', 'lead1', 30);
    expect(r.stage).toBe('captured');
    expect(r.qualified).toBe(false);
  });

  test('assignLeadToOwner: lead no encontrado -> throw', async () => {
    elf.__setFirestoreForTests(makeElfDb({ docExists: false }));
    await expect(elf.assignLeadToOwner('ent1', 'lead1', 'uid1')).rejects.toThrow('Lead not found');
  });

  test('assignLeadToOwner: success', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    const r = await elf.assignLeadToOwner('ent1', 'lead1', 'uid1');
    expect(r.stage).toBe('assigned');
    expect(r.assignedTo).toBe('uid1');
  });

  test('updateLeadStage: stage invalido -> throw', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    await expect(elf.updateLeadStage('ent1', 'lead1', 'eliminated')).rejects.toThrow('Invalid stage');
  });

  test('updateLeadStage: success', async () => {
    elf.__setFirestoreForTests(makeElfDb());
    const r = await elf.updateLeadStage('ent1', 'lead1', 'converted');
    expect(r.stage).toBe('converted');
  });

  test('getEnterpriseLeadFunnel: cuenta stages + unknown ignorado', async () => {
    const docs = [{ stage: 'captured' }, { stage: 'qualified' }, { stage: 'captured' }, { stage: 'unknown_stage' }];
    elf.__setFirestoreForTests(makeElfDb({ snapDocs: docs }));
    const r = await elf.getEnterpriseLeadFunnel('ent1');
    expect(r.funnel.captured).toBe(2);
    expect(r.funnel.qualified).toBe(1);
    expect(r.total).toBe(4);
  });

  test('getAssignedLeads: filtra por ownerUid', async () => {
    const docs = [{ assignedTo: 'uid1' }, { assignedTo: 'uid2' }, { assignedTo: 'uid1' }];
    elf.__setFirestoreForTests(makeElfDb({ snapDocs: docs }));
    const r = await elf.getAssignedLeads('ent1', 'uid1');
    expect(r.length).toBe(2);
  });
});

// ===== DASHBOARD_SUMMARY =====
describe('P6 -- dashboard_summary', () => {
  function makeDsDb({ exists = true, data = null, throws = false } = {}) {
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({
              get: throws
                ? jest.fn().mockRejectedValue(new Error('fs fail'))
                : jest.fn().mockResolvedValue({ exists, data: () => data }),
            }),
          }),
        }),
      }),
    };
  }

  test('buildDashboardSummary: uid null -> throw', async () => {
    await expect(ds.buildDashboardSummary(null)).rejects.toThrow('uid requerido');
  });

  test('buildDashboardSummary: uid numero -> throw', async () => {
    await expect(ds.buildDashboardSummary(123)).rejects.toThrow('uid requerido');
  });

  test('buildDashboardSummary: snap no existe -> zeros', async () => {
    ds.__setFirestoreForTests(makeDsDb({ exists: false }));
    const r = await ds.buildDashboardSummary('uid1');
    expect(r.totalConversations).toBe(0);
    expect(r.uid).toBe('uid1');
  });

  test('buildDashboardSummary: snap existe pero data nulo -> zeros', async () => {
    ds.__setFirestoreForTests(makeDsDb({ exists: true, data: {} }));
    const r = await ds.buildDashboardSummary('uid1');
    expect(r.totalConversations).toBe(0);
  });

  test('buildDashboardSummary: con leads, clients, miia_lead, mensajes recientes', async () => {
    const nowMs = Date.now();
    const data = {
      conversations: {
        '+5730011': [{ timestamp: nowMs - 1000 }, { timestamp: nowMs - 500 }],
        '+5730022': [{ timestamp: nowMs - 9999999999 }],
      },
      contactTypes: { '+5730011': 'lead', '+5730022': 'client', '+5730033': 'miia_lead' },
    };
    ds.__setFirestoreForTests(makeDsDb({ data }));
    const r = await ds.buildDashboardSummary('uid1', nowMs);
    expect(r.totalConversations).toBe(2);
    expect(r.totalLeads).toBe(2);
    expect(r.totalClients).toBe(1);
    expect(r.recentMessageCount).toBe(2);
    expect(r.topContacts.length).toBeGreaterThan(0);
    expect(r.totalContacts).toBe(3);
  });

  test('buildDashboardSummary: firestore lanza -> warn y retorna parcial', async () => {
    ds.__setFirestoreForTests(makeDsDb({ throws: true }));
    const r = await ds.buildDashboardSummary('uid1');
    expect(r.uid).toBe('uid1');
    expect(r.totalConversations).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });
});

// ===== ANALYTICS_DASHBOARD =====
describe('P6 -- analytics_dashboard', () => {
  function makeAnaDb({ throwSet = false, throwGet = false, docs = [] } = {}) {
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({
              set: throwSet ? jest.fn().mockRejectedValue(new Error('set fail')) : jest.fn().mockResolvedValue({}),
            }),
            where: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                get: throwGet
                  ? jest.fn().mockRejectedValue(new Error('get fail'))
                  : jest.fn().mockResolvedValue({ forEach: (fn) => docs.forEach(d => fn({ data: () => d })) }),
              }),
            }),
          }),
        }),
      }),
    };
  }

  test('recordMetric: uid null -> throw', async () => {
    await expect(ana.recordMetric(null, 'messages_received')).rejects.toThrow('uid requerido');
  });
  test('recordMetric: metricType null -> throw', async () => {
    await expect(ana.recordMetric('uid1', null)).rejects.toThrow('metricType requerido');
  });
  test('recordMetric: type invalido -> throw', async () => {
    await expect(ana.recordMetric('uid1', 'fake_metric')).rejects.toThrow('metricType invalido');
  });
  test('recordMetric: success sin value -> usa 1', async () => {
    ana.__setFirestoreForTests(makeAnaDb());
    await expect(ana.recordMetric('uid1', 'messages_received')).resolves.toBeUndefined();
  });
  test('recordMetric: success con value y meta', async () => {
    ana.__setFirestoreForTests(makeAnaDb());
    await expect(ana.recordMetric('uid1', 'response_time_ms', 250, { source: 'ws' })).resolves.toBeUndefined();
  });
  test('recordMetric: firestore lanza -> re-lanza', async () => {
    ana.__setFirestoreForTests(makeAnaDb({ throwSet: true }));
    await expect(ana.recordMetric('uid1', 'new_leads', 1)).rejects.toThrow('set fail');
  });

  test('getMetricSummary: uid null -> throw', async () => {
    await expect(ana.getMetricSummary(null, 'new_leads')).rejects.toThrow('uid requerido');
  });
  test('getMetricSummary: metricType null -> throw', async () => {
    await expect(ana.getMetricSummary('uid1', null)).rejects.toThrow('metricType requerido');
  });
  test('getMetricSummary: type invalido -> throw', async () => {
    await expect(ana.getMetricSummary('uid1', 'fake')).rejects.toThrow('metricType invalido');
  });
  test('getMetricSummary: period invalido -> usa DEFAULT week', async () => {
    ana.__setFirestoreForTests(makeAnaDb());
    const r = await ana.getMetricSummary('uid1', 'new_leads', 'bimonthly');
    expect(r.period).toBe('week');
  });
  test('getMetricSummary: day period', async () => {
    ana.__setFirestoreForTests(makeAnaDb());
    const r = await ana.getMetricSummary('uid1', 'new_leads', 'day');
    expect(r.period).toBe('day');
  });
  test('getMetricSummary: quarter period', async () => {
    ana.__setFirestoreForTests(makeAnaDb());
    const r = await ana.getMetricSummary('uid1', 'new_leads', 'quarter');
    expect(r.period).toBe('quarter');
  });
  test('getMetricSummary: success con docs', async () => {
    ana.__setFirestoreForTests(makeAnaDb({ docs: [{ value: 3 }, { value: 7 }] }));
    const r = await ana.getMetricSummary('uid1', 'new_leads', 'day');
    expect(r.total).toBe(10);
    expect(r.average).toBe(5);
  });
  test('getMetricSummary: sin docs -> average=0', async () => {
    ana.__setFirestoreForTests(makeAnaDb({ docs: [] }));
    const r = await ana.getMetricSummary('uid1', 'new_leads', 'week');
    expect(r.average).toBe(0);
  });
  test('getMetricSummary: fail-open retorna zeros', async () => {
    ana.__setFirestoreForTests(makeAnaDb({ throwGet: true }));
    const r = await ana.getMetricSummary('uid1', 'new_leads', 'week');
    expect(r.total).toBe(0);
  });

  test('getDashboard: uid null -> throw', async () => {
    await expect(ana.getDashboard(null)).rejects.toThrow('uid requerido');
  });
  test('getDashboard: period invalido -> usa DEFAULT', async () => {
    ana.__setFirestoreForTests(makeAnaDb());
    const r = await ana.getDashboard('uid1', 'unknown');
    expect(r.period).toBe('week');
  });
  test('getDashboard: success con month', async () => {
    ana.__setFirestoreForTests(makeAnaDb({ docs: [] }));
    const r = await ana.getDashboard('uid1', 'month');
    expect(r.period).toBe('month');
    expect(r.summary.newLeads).toBe(0);
  });

  test('compareMetrics: uid null -> throw', async () => {
    await expect(ana.compareMetrics(null, 'new_leads')).rejects.toThrow('uid requerido');
  });
  test('compareMetrics: metricType null -> throw', async () => {
    await expect(ana.compareMetrics('uid1', null)).rejects.toThrow('metricType requerido');
  });
  test('compareMetrics: type invalido -> throw', async () => {
    await expect(ana.compareMetrics('uid1', 'nope')).rejects.toThrow('metricType invalido');
  });
  test('compareMetrics: previous=0 y current>0 -> changePercent=100', async () => {
    let call = 0;
    ana.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                get: jest.fn().mockImplementation(() => {
                  call++;
                  const docs = call === 1 ? [{ value: 5 }] : [];
                  return Promise.resolve({ forEach: (fn) => docs.forEach(d => fn({ data: () => d })) });
                }),
              }),
            }),
            doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
          }),
        }),
      }),
    });
    const r = await ana.compareMetrics('uid1', 'new_leads', 'week');
    expect(r.changePercent).toBe(100);
  });
  test('compareMetrics: previous>0 -> calcula %', async () => {
    let call = 0;
    ana.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                get: jest.fn().mockImplementation(() => {
                  call++;
                  const docs = call === 1 ? [{ value: 15 }] : [{ value: 10 }];
                  return Promise.resolve({ forEach: (fn) => docs.forEach(d => fn({ data: () => d })) });
                }),
              }),
            }),
            doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
          }),
        }),
      }),
    });
    const r = await ana.compareMetrics('uid1', 'new_leads', 'week');
    expect(r.change).toBe(5);
    expect(r.changePercent).toBe(50);
  });
  test('compareMetrics: ambos=0 -> changePercent=0', async () => {
    ana.__setFirestoreForTests(makeAnaDb({ docs: [] }));
    const r = await ana.compareMetrics('uid1', 'new_leads', 'week');
    expect(r.changePercent).toBe(0);
  });
});
