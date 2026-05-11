'use strict';
const em = require('../core/enterprise_manager');

function makeDb({ exists = true, ownerUids = ['uid1'], seats = 5, data = null } = {}) {
  const docData = data || { ownerUids, seats, name: 'Acme', billingCycle: 'monthly', status: 'trial' };
  const docRef = { set: jest.fn().mockResolvedValue({}), get: jest.fn().mockResolvedValue({ exists, data: () => docData }), update: jest.fn().mockResolvedValue({}) };
  const metricsSnap = { forEach: jest.fn(fn => [{ data: () => ({ messages: 10, leads: 2, conversions: 1 }) }, { data: () => ({}) }].forEach(fn)) };
  return {
    collection: jest.fn().mockImplementation((col) => {
      if (col === 'enterprise_metrics') return { where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(metricsSnap) };
      return { doc: jest.fn().mockReturnValue(docRef) };
    }),
  };
}

beforeEach(() => { em.__setFirestoreForTests(makeDb()); jest.clearAllMocks(); });

describe('createEnterprise', () => {
  test('sin opts → opts={} (branch opts||{})', async () => { await expect(em.createEnterprise('uid1')).rejects.toThrow('Enterprise name required'); });
  test('!opts.name → throw', async () => { await expect(em.createEnterprise('uid1', {})).rejects.toThrow('Enterprise name required'); });
  test('billingCycle inválido → throw', async () => { await expect(em.createEnterprise('uid1', { name: 'A', billingCycle: 'quarterly' })).rejects.toThrow('Invalid billing cycle'); });
  test('sin billingCycle → monthly (branch falsy)', async () => { const e = await em.createEnterprise('uid1', { name: 'A' }); expect(e.billingCycle).toBe('monthly'); });
  test('con billingCycle=annual → annual (branch truthy)', async () => { const e = await em.createEnterprise('uid1', { name: 'A', billingCycle: 'annual' }); expect(e.billingCycle).toBe('annual'); });
  test('sin seats → 5 (MAX_SEATS_DEFAULT)', async () => { const e = await em.createEnterprise('uid1', { name: 'A' }); expect(e.seats).toBe(5); });
  test('con seats → usa el dado', async () => { const e = await em.createEnterprise('uid1', { name: 'A', seats: 10 }); expect(e.seats).toBe(10); });
});

describe('addEnterpriseOwner', () => {
  test('enterprise not found → throw', async () => { em.__setFirestoreForTests(makeDb({ exists: false })); await expect(em.addEnterpriseOwner('e1', 'uid2')).rejects.toThrow('Enterprise not found'); });
  test('seats full → throw', async () => { em.__setFirestoreForTests(makeDb({ ownerUids: ['a','b','c','d','e'], seats: 5 })); await expect(em.addEnterpriseOwner('e1', 'uid6')).rejects.toThrow('seats full'); });
  test('uid ya en lista → dedup (filter uid===ownerUid true branch)', async () => { em.__setFirestoreForTests(makeDb({ ownerUids: ['uid1'], seats: 5 })); const r = await em.addEnterpriseOwner('e1', 'uid1'); expect(r.totalOwners).toBe(1); });
  test('uid nuevo → agrega (filter uid!==ownerUid false branch)', async () => { em.__setFirestoreForTests(makeDb({ ownerUids: ['uid1'], seats: 5 })); const r = await em.addEnterpriseOwner('e1', 'uid2'); expect(r.totalOwners).toBe(2); });
});

describe('getEnterpriseMetrics', () => {
  test('enterprise not found → throw', async () => { em.__setFirestoreForTests(makeDb({ exists: false })); await expect(em.getEnterpriseMetrics('e1')).rejects.toThrow('Enterprise not found'); });
  test('métricas con docs y docs sin campos → ||0 false branches', async () => {
    const r = await em.getEnterpriseMetrics('e1');
    expect(r.totalMessages).toBe(10); expect(r.totalLeads).toBe(2); expect(r.totalConversions).toBe(1);
  });
});

describe('updateBilling', () => {
  test('billingCycle inválido → throw', async () => { await expect(em.updateBilling('e1', { billingCycle: 'quarterly' })).rejects.toThrow('Invalid billing cycle'); });
  test('billingCycle válido → actualiza (truthy branch)', async () => { const r = await em.updateBilling('e1', { billingCycle: 'annual' }); expect(r.billingCycle).toBe('annual'); });
  test('sin billingCycle → no incluye (falsy branch)', async () => { const r = await em.updateBilling('e1', { seats: 10 }); expect(r.billingCycle).toBeUndefined(); });
  test('opts.billingCycle falsy → no throw (&&short-circuit)', async () => { const r = await em.updateBilling('e1', {}); expect(r.enterpriseId).toBe('e1'); });
  test('con seats → actualiza (truthy branch)', async () => { const r = await em.updateBilling('e1', { seats: 20 }); expect(r.seats).toBe(20); });
  test('sin seats → no incluye (falsy branch)', async () => { const r = await em.updateBilling('e1', {}); expect(r.seats).toBeUndefined(); });
});

describe('suspendEnterprise', () => {
  test('con reason → usa la dada', async () => { const r = await em.suspendEnterprise('e1', 'non_payment'); expect(r.status).toBe('suspended'); });
  test('sin reason → admin_action (branch reason falsy)', async () => { const r = await em.suspendEnterprise('e1'); expect(r.status).toBe('suspended'); });
});

describe('getEnterpriseSummary', () => {
  test('enterprise not found → throw', async () => { em.__setFirestoreForTests(makeDb({ exists: false })); await expect(em.getEnterpriseSummary('e1')).rejects.toThrow('Enterprise not found'); });
  test('ownerUids presente → usa length', async () => { em.__setFirestoreForTests(makeDb({ ownerUids: ['u1','u2'], seats: 5 })); const r = await em.getEnterpriseSummary('e1'); expect(r.activeOwners).toBe(2); });
  test('ownerUids falsy → [] (branch ownerUids||[])', async () => {
    em.__setFirestoreForTests(makeDb({ data: { name: 'A', seats: 5, billingCycle: 'monthly', status: 'trial' } }));
    const r = await em.getEnterpriseSummary('e1'); expect(r.activeOwners).toBe(0);
  });
});

describe('getDb fallback', () => {
  test('_db=null usa require firebase (branch _db falsy)', async () => {
    jest.resetModules();
    const fbDb = { collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }) }) };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const fm = require('../core/enterprise_manager');
    await fm.createEnterprise('uid1', { name: 'TestCo' });
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase'); jest.resetModules();
  });
});
