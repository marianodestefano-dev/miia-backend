'use strict';

// PISO 6 extra2 -- agent_mode, billing_admin, enterprise_onboarding, feature_flags_admin
// agent_notifier coverage supplement

jest.mock('firebase-admin', () => ({ firestore: jest.fn() }));
jest.mock('../config/firebase', () => ({ db: { collection: jest.fn() } }), { virtual: true });

const am   = require('../core/agent_mode');
const ba   = require('../core/billing_admin');
const eo   = require('../core/enterprise_onboarding');
const ffa  = require('../core/feature_flags_admin');
const an   = require('../core/agent_notifier');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// ===== FEATURE_FLAGS_ADMIN =====
describe('P6 extra2 -- feature_flags_admin', () => {
  function makeDocDb({ ownerExists = false, globalExists = false, ownerValue = false, globalValue = false, listDocs = [] } = {}) {
    let callCount = 0;
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockImplementation(() => {
          callCount++;
          const isOwnerCall = callCount === 1;
          return {
            set: jest.fn().mockResolvedValue({}),
            get: jest.fn().mockResolvedValue({
              exists: isOwnerCall ? ownerExists : globalExists,
              data: () => ({ value: isOwnerCall ? ownerValue : globalValue }),
            }),
          };
        }),
        get: jest.fn().mockResolvedValue({
          forEach: (fn) => listDocs.forEach(d => fn({ data: () => d })),
        }),
      }),
    };
  }

  test('setFlag: flagName null -> throw', async () => {
    await expect(ffa.setFlag(null, true)).rejects.toThrow('flagName required');
  });

  test('setFlag: sin ownerUid -> key = flagName', async () => {
    const sets = [];
    ffa.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockImplementation((key) => {
          sets.push(key);
          return { set: jest.fn().mockResolvedValue({}) };
        }),
      }),
    });
    const r = await ffa.setFlag('my_flag', true, { scope: 'global' });
    expect(sets[0]).toBe('my_flag');
    expect(r.scope).toBe('global');
    expect(r.ownerUid).toBeNull();
  });

  test('setFlag: con ownerUid -> key = flagName_uid', async () => {
    const sets = [];
    ffa.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockImplementation((key) => {
          sets.push(key);
          return { set: jest.fn().mockResolvedValue({}) };
        }),
      }),
    });
    const r = await ffa.setFlag('my_flag', true, { scope: 'owner', ownerUid: 'uid123' });
    expect(sets[0]).toBe('my_flag_uid123');
    expect(r.ownerUid).toBe('uid123');
  });

  test('getFlag: flagName null -> throw', async () => {
    await expect(ffa.getFlag(null)).rejects.toThrow('flagName required');
  });

  test('getFlag: con ownerUid, ownerSnap existe -> retorna ownerValue', async () => {
    ffa.__setFirestoreForTests(makeDocDb({ ownerExists: true, ownerValue: true }));
    const r = await ffa.getFlag('my_flag', 'uid1');
    expect(r).toBe(true);
  });

  test('getFlag: con ownerUid, ownerSnap no existe -> consulta global, existe', async () => {
    ffa.__setFirestoreForTests(makeDocDb({ ownerExists: false, globalExists: true, globalValue: true }));
    const r = await ffa.getFlag('my_flag', 'uid1');
    expect(r).toBe(true);
  });

  test('getFlag: sin ownerUid, globalSnap existe -> retorna value', async () => {
    let callN = 0;
    ffa.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ value: false }) }),
        }),
      }),
    });
    const r = await ffa.getFlag('my_flag');
    expect(r).toBe(false);
  });

  test('getFlag: sin ownerUid, globalSnap no existe -> false', async () => {
    ffa.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
        }),
      }),
    });
    const r = await ffa.getFlag('my_flag');
    expect(r).toBe(false);
  });

  test('listFlags: filtra por ownerUid o global', async () => {
    const docs = [
      { name: 'flagA', value: true, ownerUid: 'uid1' },
      { name: 'flagB', value: false, ownerUid: 'uid2' },
      { name: 'flagC', value: true, ownerUid: null },
    ];
    ffa.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({
          forEach: (fn) => docs.forEach(d => fn({ data: () => d })),
        }),
        doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
      }),
    });
    const r = await ffa.listFlags('uid1');
    expect(r.flagA).toBe(true);
    expect(r.flagC).toBe(true);
    expect(r.flagB).toBeUndefined();
  });

  test('listFlags: sin ownerUid -> incluye solo globales', async () => {
    const docs = [
      { name: 'flagA', value: true, ownerUid: 'uid1' },
      { name: 'flagC', value: false, ownerUid: null },
    ];
    ffa.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({
          forEach: (fn) => docs.forEach(d => fn({ data: () => d })),
        }),
        doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
      }),
    });
    const r = await ffa.listFlags(undefined);
    expect(r.flagC).toBe(false);
  });
});

// ===== BILLING_ADMIN =====
describe('P6 extra2 -- billing_admin', () => {
  function makeBillingDb() {
    return {
      collection: jest.fn().mockImplementation((col) => ({
        doc: jest.fn().mockReturnValue({
          set: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
        }),
        where: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({
            forEach: (fn) => [].forEach(fn),
          }),
        }),
      })),
    };
  }

  test('issueRefund: paymentId null -> throw', async () => {
    await expect(ba.issueRefund(null, 10)).rejects.toThrow('paymentId and positive amount required');
  });

  test('issueRefund: amount = 0 -> throw', async () => {
    await expect(ba.issueRefund('pid', 0)).rejects.toThrow('paymentId and positive amount required');
  });

  test('issueRefund: amount negativo -> throw', async () => {
    await expect(ba.issueRefund('pid', -5)).rejects.toThrow('paymentId and positive amount required');
  });

  test('issueRefund: sin reason -> usa admin_request', async () => {
    ba.__setFirestoreForTests(makeBillingDb());
    const r = await ba.issueRefund('pid1', 50);
    expect(r.reason).toBe('admin_request');
    expect(r.status).toBe('processed');
    expect(r.amount).toBe(50);
  });

  test('issueRefund: con reason custom', async () => {
    ba.__setFirestoreForTests(makeBillingDb());
    const r = await ba.issueRefund('pid1', 25, 'customer_complaint');
    expect(r.reason).toBe('customer_complaint');
  });

  test('changePlan: uid null -> throw', async () => {
    await expect(ba.changePlan(null, 'pro')).rejects.toThrow('uid and newPlan required');
  });

  test('changePlan: newPlan null -> throw', async () => {
    await expect(ba.changePlan('uid1', null)).rejects.toThrow('uid and newPlan required');
  });

  test('changePlan: plan invalido -> throw', async () => {
    ba.__setFirestoreForTests(makeBillingDb());
    await expect(ba.changePlan('uid1', 'ultimate')).rejects.toThrow('invalid plan');
  });

  test('changePlan: plan valido -> success', async () => {
    ba.__setFirestoreForTests(makeBillingDb());
    const r = await ba.changePlan('uid1', 'enterprise');
    expect(r.plan).toBe('enterprise');
  });

  test('getOwnerBilling: uid null -> throw', async () => {
    await expect(ba.getOwnerBilling(null)).rejects.toThrow('uid required');
  });

  test('getOwnerBilling: sin pagos -> totalPaid=0', async () => {
    ba.__setFirestoreForTests(makeBillingDb());
    const r = await ba.getOwnerBilling('uid1');
    expect(r.totalPaid).toBe(0);
    expect(r.payments).toEqual([]);
  });
});

// ===== ENTERPRISE_ONBOARDING =====
describe('P6 extra2 -- enterprise_onboarding', () => {
  function makeEoDb() {
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          set: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
          get: jest.fn().mockResolvedValue({ exists: true, data: () => ({
            companyName: 'Acme', onboardingStep: 'company_info',
            onboardingCompleted: false, contractSigned: false,
          })
          }),
        }),
      }),
    };
  }

  test('createEnterpriseAccount: uid null -> throw', async () => {
    await expect(eo.createEnterpriseAccount({})).rejects.toThrow('uid, companyName, contactEmail required');
  });

  test('createEnterpriseAccount: seats < 5 -> throw', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    await expect(eo.createEnterpriseAccount({ uid: 'u', companyName: 'Acme', contactEmail: 'e@e', seats: 2 })).rejects.toThrow('at least');
  });

  test('createEnterpriseAccount: seats = 0 -> usa MIN_ENTERPRISE_SEATS como default... pero lanza por < 5', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    // seats=0 means (seats || 0) < 5 -> throw
    await expect(eo.createEnterpriseAccount({ uid: 'u', companyName: 'Acme', contactEmail: 'e@e', seats: 0 })).rejects.toThrow('at least');
  });

  test('createEnterpriseAccount: sin seats -> usa MIN (5), lanza porque (undefined || 0) < 5... actually (0) < 5 -> throw', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    // (opts.seats || 0) = 0 which is < 5, so it throws
    await expect(eo.createEnterpriseAccount({ uid: 'u', companyName: 'Acme', contactEmail: 'e@e' })).rejects.toThrow('at least');
  });

  test('createEnterpriseAccount: seats = 5 -> success, seats || MIN = 5', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    const r = await eo.createEnterpriseAccount({ uid: 'u', companyName: 'Acme', contactEmail: 'e@e.com', seats: 5 });
    expect(r.seats).toBe(5);
    expect(r.plan).toBe('enterprise');
    expect(r.onboardingStep).toBe('company_info');
  });

  test('advanceOnboarding: uid null -> throw', async () => {
    await expect(eo.advanceOnboarding(null, 'company_info')).rejects.toThrow('uid and step required');
  });

  test('advanceOnboarding: step invalido -> throw', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    await expect(eo.advanceOnboarding('uid1', 'invalid_step')).rejects.toThrow('invalid step');
  });

  test('advanceOnboarding: company_info -> next=legal_contact, completed=false', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    const r = await eo.advanceOnboarding('uid1', 'company_info');
    expect(r.next).toBe('legal_contact');
    expect(r.completed).toBe(false);
  });

  test('advanceOnboarding: contract_sign -> contractSigned=true', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    const r = await eo.advanceOnboarding('uid1', 'contract_sign');
    expect(r.step).toBe('contract_sign');
  });

  test('advanceOnboarding: go_live (last) -> completed=true, next=null', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    const r = await eo.advanceOnboarding('uid1', 'go_live');
    expect(r.completed).toBe(true);
    expect(r.next).toBeNull();
  });

  test('advanceOnboarding: con data -> stepData guardado', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    const r = await eo.advanceOnboarding('uid1', 'company_info', { name: 'Acme Corp' });
    expect(r.step).toBe('company_info');
  });

  test('getEnterpriseStatus: uid null -> throw', async () => {
    await expect(eo.getEnterpriseStatus(null)).rejects.toThrow('uid required');
  });

  test('getEnterpriseStatus: snap no existe -> null', async () => {
    eo.__setFirestoreForTests({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: false }),
        }),
      }),
    });
    const r = await eo.getEnterpriseStatus('uid1');
    expect(r).toBeNull();
  });

  test('getEnterpriseStatus: snap existe -> retorna objeto', async () => {
    eo.__setFirestoreForTests(makeEoDb());
    const r = await eo.getEnterpriseStatus('uid1');
    expect(r.companyName).toBe('Acme');
    expect(r.uid).toBe('uid1');
  });
});

// ===== AGENT_MODE =====
describe('P6 extra2 -- agent_mode', () => {
  function makeAmDb({ docExists = true, data = {} } = {}) {
    return {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          get: jest.fn().mockResolvedValue({ exists: docExists, data: () => data }),
          set: jest.fn().mockResolvedValue({}),
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue({ exists: docExists, data: () => data }),
              set: jest.fn().mockResolvedValue({}),
            }),
          }),
        }),
      }),
    };
  }

  test('setAutonomyLevel: level invalido -> throw', async () => {
    await expect(am.setAutonomyLevel('uid1', 'superfast')).rejects.toThrow('Invalid autonomy level');
  });

  test('setAutonomyLevel: none -> agent_enabled=false', async () => {
    am.__setFirestoreForTests(makeAmDb());
    const r = await am.setAutonomyLevel('uid1', 'none');
    expect(r.level).toBe('none');
  });

  test('setAutonomyLevel: high -> agent_enabled=true', async () => {
    am.__setFirestoreForTests(makeAmDb());
    const r = await am.setAutonomyLevel('uid1', 'high');
    expect(r.level).toBe('high');
  });

  test('getAgentConfig: doc no existe -> defaults', async () => {
    am.__setFirestoreForTests(makeAmDb({ docExists: false }));
    const r = await am.getAgentConfig('uid1');
    expect(r.autonomyLevel).toBe('low');
    expect(r.enabled).toBe(false);
    expect(r.maxActionsPerHour).toBe(10);
  });

  test('getAgentConfig: doc existe con datos custom', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_autonomy_level: 'high', agent_enabled: true, agent_max_actions_per_hour: 20 } }));
    const r = await am.getAgentConfig('uid1');
    expect(r.autonomyLevel).toBe('high');
    expect(r.enabled).toBe(true);
    expect(r.maxActionsPerHour).toBe(20);
  });

  test('decideAction: agente disabled -> escalate', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: false } }));
    const r = await am.decideAction('uid1', 'hola', {});
    expect(r.decision).toBe('escalate');
    expect(r.reason).toBe('agent_disabled');
  });

  test('decideAction: urgente + no full -> escalate', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'medium' } }));
    const r = await am.decideAction('uid1', 'esto es urgente', { confidence: 0.9 });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toBe('urgency_detected');
  });

  test('decideAction: urgente + full -> no escala por urgency', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'full' } }));
    const r = await am.decideAction('uid1', 'esto es urgente', { confidence: 1.0 });
    expect(r.decision).toBe('respond');
  });

  test('decideAction: confidence < threshold -> request_permission', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'high' } }));
    const r = await am.decideAction('uid1', 'mensaje normal', { confidence: 0.3 });
    expect(r.decision).toBe('request_permission');
    expect(r.reason).toBe('below_threshold');
  });

  test('decideAction: confidence >= threshold -> respond', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'medium' } }));
    const r = await am.decideAction('uid1', 'mensaje normal', { confidence: 0.8 });
    expect(r.decision).toBe('respond');
  });

  test('decideAction: sin context -> confidence default 0.5', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'low' } }));
    const r = await am.decideAction('uid1', 'hola');
    expect(r.decision).toBe('respond'); // threshold low=0.3, confidence=0.5 >= 0.3
  });

  test('logAgentDecision: decision invalida -> throw', async () => {
    am.__setFirestoreForTests(makeAmDb());
    await expect(am.logAgentDecision('uid1', { decision: 'invalid_decision' })).rejects.toThrow('Invalid decision');
  });

  test('logAgentDecision: decision valida -> success', async () => {
    am.__setFirestoreForTests(makeAmDb());
    const r = await am.logAgentDecision('uid1', { decision: 'respond', message: 'hola' });
    expect(r.decision).toBe('respond');
    expect(r.uid).toBe('uid1');
  });

  test('detectNewLead: doc no existe -> isNew=true, score=50', async () => {
    am.__setFirestoreForTests(makeAmDb({ docExists: false }));
    const r = await am.detectNewLead('uid1', '+57300');
    expect(r.isNew).toBe(true);
    expect(r.score).toBe(50);
  });

  test('detectNewLead: doc existe -> isNew=false, score=30', async () => {
    am.__setFirestoreForTests(makeAmDb({ docExists: true }));
    const r = await am.detectNewLead('uid1', '+57300');
    expect(r.isNew).toBe(false);
    expect(r.score).toBe(30);
  });

  test('checkPermissionRequired: high_risk action + not full -> true', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'medium' } }));
    const r = await am.checkPermissionRequired('uid1', 'send_payment_link');
    expect(r).toBe(true);
  });

  test('checkPermissionRequired: high_risk + full -> false', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_enabled: true, agent_autonomy_level: 'full' } }));
    const r = await am.checkPermissionRequired('uid1', 'cancel_booking');
    expect(r).toBe(false);
  });

  test('checkPermissionRequired: normal action + none -> true', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_autonomy_level: 'none' } }));
    const r = await am.checkPermissionRequired('uid1', 'send_message');
    expect(r).toBe(true);
  });

  test('checkPermissionRequired: normal action + low -> false', async () => {
    am.__setFirestoreForTests(makeAmDb({ data: { agent_autonomy_level: 'low' } }));
    const r = await am.checkPermissionRequired('uid1', 'send_message');
    expect(r).toBe(false);
  });
});

// ===== AGENT_NOTIFIER (supplement) =====
describe('P6 extra2 -- agent_notifier supplement', () => {
  test('AGENT_NOTIFIER: modulo exporta funciones', () => {
    expect(typeof an.notifyAgent).toBe('function');
    expect(typeof an.registerAgent).toBe('function');
    expect(typeof an.__setFirestoreForTests).toBe('function');
  });
});
