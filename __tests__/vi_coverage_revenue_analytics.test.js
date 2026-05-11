'use strict';

const ra = require('../core/revenue_analytics');

function makeDb({ mrrDocs = [], subsDocs = [], paymentDocs = [] } = {}) {
  const mrrSnap = { forEach: jest.fn(fn => mrrDocs.forEach(fn)) };
  const allSubsSnap = { docs: subsDocs };
  let subsGetCount = 0;
  const subsChain = {
    where: jest.fn().mockReturnThis(),
    get: jest.fn().mockImplementation(() => {
      subsGetCount++;
      return subsGetCount === 1 ? Promise.resolve(mrrSnap) : Promise.resolve(allSubsSnap);
    }),
  };
  const paymentsSnap = { forEach: jest.fn(fn => paymentDocs.forEach(fn)) };
  const paymentsChain = { where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(paymentsSnap) };
  return { collection: jest.fn().mockImplementation(n => n === 'payments' ? paymentsChain : subsChain) };
}

beforeEach(() => ra.__setFirestoreForTests(makeDb()));
afterEach(() => jest.clearAllMocks());

describe('getMRR', () => {
  test('!uid => throw (branch !uid truthy)', async () => {
    await expect(ra.getMRR('')).rejects.toThrow('uid required');
  });
  test('docs con monthlyAmount => suma (branch || 0 false)', async () => {
    ra.__setFirestoreForTests(makeDb({ mrrDocs: [{ data: () => ({ monthlyAmount: 50 }) }] }));
    const r = await ra.getMRR('uid1');
    expect(r.mrr).toBe(50);
  });
  test('docs sin monthlyAmount => 0 (branch || 0 true)', async () => {
    ra.__setFirestoreForTests(makeDb({ mrrDocs: [{ data: () => ({}) }] }));
    const r = await ra.getMRR('uid1');
    expect(r.mrr).toBe(0);
  });
});

describe('getRevenueSummary', () => {
  test('!uid => throw (branch !uid truthy)', async () => {
    await expect(ra.getRevenueSummary('')).rejects.toThrow('uid required');
  });
  test('totalSubs>0 + activeSubs>0 + amount => todos los branches main', async () => {
    const subsDocs = [
      { data: () => ({ status: 'active' }) },
      { data: () => ({ status: 'cancelled' }) },
    ];
    const paymentDocs = [{ data: () => ({ amount: 100 }) }];
    ra.__setFirestoreForTests(makeDb({ subsDocs, paymentDocs }));
    const r = await ra.getRevenueSummary('uid1');
    expect(r.churnRate).toBe(50);
    expect(r.ltv).toBeGreaterThan(0);
    expect(r.activeSubscriptions).toBe(1);
  });
  test('totalSubs=0 => churnRate=0 (branch totalSubs>0 false)', async () => {
    ra.__setFirestoreForTests(makeDb({ subsDocs: [] }));
    const r = await ra.getRevenueSummary('uid1');
    expect(r.churnRate).toBe(0);
  });
  test('activeSubs=0 => ltv=0 (branch activeSubs>0 false)', async () => {
    const subsDocs = [{ data: () => ({ status: 'cancelled' }) }];
    ra.__setFirestoreForTests(makeDb({ subsDocs }));
    const r = await ra.getRevenueSummary('uid1');
    expect(r.ltv).toBe(0);
  });
  test('allSubs.docs=null => totalSubs=0 (branch docs falsy ternary + || [])', async () => {
    const db = makeDb();
    // Override allSubs to return docs: null
    let subsGetCount = 0;
    const mrrSnap = { forEach: jest.fn() };
    const allSubsSnap = { docs: null };
    const subsChain = {
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockImplementation(() => {
        subsGetCount++;
        return subsGetCount === 1 ? Promise.resolve(mrrSnap) : Promise.resolve(allSubsSnap);
      }),
    };
    const paymentsChain = { where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn() }) };
    ra.__setFirestoreForTests({ collection: jest.fn().mockImplementation(n => n === 'payments' ? paymentsChain : subsChain) });
    const r = await ra.getRevenueSummary('uid1');
    expect(r.churnRate).toBe(0);
    expect(r.ltv).toBe(0);
  });
  test('payment sin amount => 0 (branch amount || 0 false)', async () => {
    const subsDocs = [{ data: () => ({ status: 'active' }) }];
    const paymentDocs = [{ data: () => ({}) }];
    ra.__setFirestoreForTests(makeDb({ subsDocs, paymentDocs }));
    const r = await ra.getRevenueSummary('uid1');
    expect(r.ltv).toBe(0);
  });
});

describe('getDb fallback', () => {
  test('_db=null => usa firebase (branch _db falsy)', async () => {
    jest.resetModules();
    const fbDb = makeDb({ mrrDocs: [{ data: () => ({ monthlyAmount: 10 }) }] });
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const freshRa = require('../core/revenue_analytics');
    const r = await freshRa.getMRR('uid1');
    expect(r.mrr).toBe(10);
    jest.dontMock('../config/firebase');
    jest.resetModules();
  });
});
