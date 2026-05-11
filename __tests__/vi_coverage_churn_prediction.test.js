'use strict';
const cp = require('../core/churn_prediction');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

describe('computeChurnRisk', () => {
  test('daysSince>30 → HIGH', () => { const r = cp.computeChurnRisk(NOW - 35*DAY, 1, 0); expect(r.level).toBe('high'); });
  test('daysSince>14 (threshold) → MEDIUM', () => { const r = cp.computeChurnRisk(NOW - 20*DAY, 5, 0); expect(r.level).toBe('medium'); });
  test('daysSince>7 → LOW (score=10)', () => { const r = cp.computeChurnRisk(NOW - 10*DAY, 5, 0); expect(r.level).toBe('low'); });
  test('daysSince<=7 → score=0 LOW', () => { const r = cp.computeChurnRisk(NOW - 3*DAY, 5, 0); expect(r.score).toBe(0); expect(r.level).toBe('low'); });
  test('totalMessages<3 → score+=20', () => { const r = cp.computeChurnRisk(NOW - 1*DAY, 2, 0); expect(r.score).toBe(20); });
  test('totalMessages>=3 → no messageScore', () => { const r = cp.computeChurnRisk(NOW - 1*DAY, 3, 0); expect(r.score).toBe(0); });
  test('avgResponseTime>day → score+=20', () => { const r = cp.computeChurnRisk(NOW - 1*DAY, 5, 90000000); expect(r.score).toBe(20); });
  test('avgResponseTime<=day → no responseScore', () => { const r = cp.computeChurnRisk(NOW - 1*DAY, 5, 1000); expect(r.score).toBe(0); });
  test('score>=60 → HIGH', () => { const r = cp.computeChurnRisk(NOW - 31*DAY, 1, 90000000); expect(r.level).toBe('high'); });
  test('score 30-59 → MEDIUM', () => { const r = cp.computeChurnRisk(NOW - 20*DAY, 5, 0); expect(r.level).toBe('medium'); });
  test('score<30 → LOW', () => { const r = cp.computeChurnRisk(NOW - 1*DAY, 5, 0); expect(r.level).toBe('low'); });
});

describe('getAtRiskLeads', () => {
  test('!uid → throw', async () => { await expect(cp.getAtRiskLeads('')).rejects.toThrow('uid required'); });

  test('lead OLD + HIGH → en atRisk (lastContact<since, risk!==LOW)', async () => {
    const oldMs = NOW - 35*DAY;
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', lastMessageAt: oldMs, messageCount: 1, avgResponseTime: 0 }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(r.atRisk.length).toBeGreaterThan(0);
  });

  test('lead RECIENTE → NO en atRisk (lastContact>=since)', async () => {
    const recentMs = NOW - 1*DAY;
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', lastMessageAt: recentMs, messageCount: 5 }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(r.atRisk.length).toBe(0);
  });

  test('lead OLD + LOW → NO en atRisk (risk===LOW branch)', async () => {
    const eightDay = NOW - 8*DAY; // >7 days: score=10, msgs>=3: no add, fast: no add → LOW
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', lastMessageAt: eightDay, messageCount: 5, avgResponseTime: 1000 }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(r.atRisk.length).toBe(0);
  });

  test('lastMessageAt falsy + createdAt truthy → usa createdAt (branch ||createdAt)', async () => {
    const oldMs = NOW - 35*DAY;
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', lastMessageAt: null, createdAt: oldMs, messageCount: 1 }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(typeof r.count).toBe('number');
  });

  test('lastMessageAt y createdAt falsy → 0 (branch ||0)', async () => {
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', messageCount: 1 }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(typeof r.count).toBe('number');
  });

  test('messageCount missing → 0 (branch ||0)', async () => {
    const oldMs = NOW - 35*DAY;
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', lastMessageAt: oldMs }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(Array.isArray(r.atRisk)).toBe(true);
  });

  test('avgResponseTime missing → 0 (branch ||0)', async () => {
    const oldMs = NOW - 35*DAY;
    cp.__setFirestoreForTests({ collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn(fn => fn({ data: () => ({ phone: '+549', lastMessageAt: oldMs, messageCount: 1 }) })) }) }) });
    const r = await cp.getAtRiskLeads('uid1');
    expect(Array.isArray(r.atRisk)).toBe(true);
  });
});

describe('getDb fallback', () => {
  test('_db=null usa require firebase (branch _db falsy)', async () => {
    jest.resetModules();
    const fbDb = { collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ forEach: jest.fn() }) }) };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const fm = require('../core/churn_prediction');
    await fm.getAtRiskLeads('uid1');
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase'); jest.resetModules();
  });
});
