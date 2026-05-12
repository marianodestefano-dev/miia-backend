'use strict';

/**
 * VI-BACKEND-COVERAGE: referral_dashboard.js — 100% branches
 */

const { getReferralDashboard, __setFirestoreForTests } = require('../core/referral_dashboard');

function makeDb({ referrals = [], commissions = [] } = {}) {
  return {
    collection: (col) => ({
      where: () => ({
        get: () => Promise.resolve({
          forEach: (cb) => {
            const list = col === 'referrals' ? referrals : commissions;
            list.forEach(d => cb({ data: () => d }));
          },
        }),
      }),
    }),
  };
}

describe('getReferralDashboard', () => {
  test('uid faltante → throw', async () => {
    await expect(getReferralDashboard(null)).rejects.toThrow('uid required');
    await expect(getReferralDashboard('')).rejects.toThrow('uid required');
  });

  test('sin referrals ni commissions → totales en 0, nextPayout=null', async () => {
    __setFirestoreForTests(makeDb());
    const r = await getReferralDashboard('uid-1');
    expect(r.uid).toBe('uid-1');
    expect(r.network.totalReferrals).toBe(0);
    expect(r.network.totalClicks).toBe(0);
    expect(r.network.totalConversions).toBe(0);
    expect(r.commissions.pending).toBe(0);
    expect(r.commissions.paid).toBe(0);
    expect(r.nextPayoutEstimate).toBeNull();
  });

  test('referrals con clicks y conversions → suma correcta', async () => {
    __setFirestoreForTests(makeDb({
      referrals: [
        { clicks: 10, conversions: 2 },
        { clicks: 5, conversions: 1 },
        { conversions: 0 }, // sin clicks
      ],
    }));
    const r = await getReferralDashboard('uid-2');
    expect(r.network.totalReferrals).toBe(3);
    expect(r.network.totalClicks).toBe(15);
    expect(r.network.totalConversions).toBe(3);
  });

  test('commissions pending → pendingTotal > 0, nextPayoutEstimate no nulo', async () => {
    __setFirestoreForTests(makeDb({
      commissions: [
        { status: 'pending', commission: 10.5 },
        { status: 'pending', commission: 5.25 },
        { status: 'paid', commission: 20 },
      ],
    }));
    const r = await getReferralDashboard('uid-3');
    expect(r.commissions.pending).toBe(15.75);
    expect(r.commissions.paid).toBe(20);
    expect(r.commissions.count).toBe(3);
    expect(r.nextPayoutEstimate).not.toBeNull();
    expect(typeof r.nextPayoutEstimate).toBe('string');
  });

  test('referral sin campo clicks → usa 0', async () => {
    __setFirestoreForTests(makeDb({
      referrals: [{ conversions: 1 }], // sin clicks
    }));
    const r = await getReferralDashboard('uid-4');
    expect(r.network.totalClicks).toBe(0);
    expect(r.network.totalConversions).toBe(1);
  });
});

// ── getDb() firebase fallback ─────────────────────────────────────────────────

describe('getDb() fallback a config/firebase', () => {
  test('sin _db → usa config/firebase virtual', async () => {
    jest.resetModules();
    jest.doMock('../config/firebase', () => ({
      db: {
        collection: () => ({
          where: () => ({
            get: () => Promise.resolve({ forEach: () => {} }),
          }),
        }),
      },
    }), { virtual: true });
    const { getReferralDashboard: get } = require('../core/referral_dashboard');
    const r = await get('uid-fb');
    expect(r.uid).toBe('uid-fb');
    expect(r.network.totalReferrals).toBe(0);
    jest.dontMock('../config/firebase');
  });
});
