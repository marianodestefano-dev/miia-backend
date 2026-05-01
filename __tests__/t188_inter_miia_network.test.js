'use strict';

const {
  sendReferral, updateReferralState, getSentReferrals, getReceivedReferrals,
  getNetworkPoints, recordNetworkEvent,
  NETWORK_EVENT_TYPES, NETWORK_STATES, REFERRAL_REWARD_POINTS,
  __setFirestoreForTests,
} = require('../core/inter_miia_network');

const FROM_UID = 'fromUid1234567890';
const TO_UID = 'toUid0987654321ab';
const PHONE = '+541155667788';

function makeMockDb({ referrals = [], throwSet = false } = {}) {
  const refMap = {};
  referrals.forEach((r, i) => { refMap['ref' + i] = r; });

  const refColl = {
    doc: (id) => ({
      set: async (data, opts) => {
        if (throwSet) throw new Error('set error');
        refMap[id] = Object.assign(refMap[id] || {}, data);
      },
    }),
    where: (field, op, val) => ({
      get: async () => {
        const filtered = Object.entries(refMap)
          .filter(([, r]) => r[field] === val)
          .map(([id, r]) => ({ id, data: () => r }));
        return { forEach: fn => filtered.forEach(fn) };
      },
    }),
  };

  const eventsMap = {};
  const eventsColl = {
    doc: (id) => ({
      set: async (data) => { if (throwSet) throw new Error('set error'); eventsMap[id] = data; },
    }),
  };

  return {
    collection: (name) => {
      if (name === 'inter_miia_referrals') return refColl;
      return eventsColl;
    },
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('NETWORK_EVENT_TYPES y constants', () => {
  test('incluye referral_sent y lead_transfer', () => {
    expect(NETWORK_EVENT_TYPES).toContain('referral_sent');
    expect(NETWORK_EVENT_TYPES).toContain('lead_transfer');
  });
  test('es frozen', () => {
    expect(() => { NETWORK_EVENT_TYPES.push('x'); }).toThrow();
  });
  test('NETWORK_STATES incluye pending y accepted', () => {
    expect(NETWORK_STATES).toContain('pending');
    expect(NETWORK_STATES).toContain('accepted');
  });
  test('REFERRAL_REWARD_POINTS es 10', () => {
    expect(REFERRAL_REWARD_POINTS).toBe(10);
  });
});

describe('sendReferral', () => {
  test('lanza si fromUid undefined', async () => {
    await expect(sendReferral(undefined, TO_UID, PHONE)).rejects.toThrow('fromUid requerido');
  });
  test('lanza si toUid undefined', async () => {
    await expect(sendReferral(FROM_UID, undefined, PHONE)).rejects.toThrow('toUid requerido');
  });
  test('lanza si leadPhone undefined', async () => {
    await expect(sendReferral(FROM_UID, TO_UID, undefined)).rejects.toThrow('leadPhone requerido');
  });
  test('lanza si fromUid == toUid', async () => {
    await expect(sendReferral(FROM_UID, FROM_UID, PHONE)).rejects.toThrow('no pueden ser iguales');
  });
  test('envia referido sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await sendReferral(FROM_UID, TO_UID, PHONE);
    expect(r.referralId).toBeDefined();
    expect(r.state).toBe('pending');
    expect(r.points).toBe(REFERRAL_REWARD_POINTS);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(sendReferral(FROM_UID, TO_UID, PHONE)).rejects.toThrow('set error');
  });
});

describe('updateReferralState', () => {
  test('lanza si referralId undefined', async () => {
    await expect(updateReferralState(undefined, 'accepted')).rejects.toThrow('referralId requerido');
  });
  test('lanza si state invalido', async () => {
    await expect(updateReferralState('ref1', 'estado_falso')).rejects.toThrow('state invalido');
  });
  test('actualiza sin error', async () => {
    __setFirestoreForTests(makeMockDb({ referrals: [{ referralId: 'ref1', state: 'pending' }] }));
    await expect(updateReferralState('ref1', 'accepted')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(updateReferralState('ref1', 'accepted')).rejects.toThrow('set error');
  });
});

describe('getSentReferrals y getReceivedReferrals', () => {
  test('lanza si uid undefined en getSent', async () => {
    await expect(getSentReferrals(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza si uid undefined en getReceived', async () => {
    await expect(getReceivedReferrals(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna referidos enviados', async () => {
    const referrals = [{ fromUid: FROM_UID, toUid: TO_UID, state: 'pending' }];
    __setFirestoreForTests(makeMockDb({ referrals }));
    const r = await getSentReferrals(FROM_UID);
    expect(r.length).toBe(1);
  });
  test('retorna referidos recibidos', async () => {
    const referrals = [{ fromUid: FROM_UID, toUid: TO_UID, state: 'accepted' }];
    __setFirestoreForTests(makeMockDb({ referrals }));
    const r = await getReceivedReferrals(TO_UID);
    expect(r.length).toBe(1);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ where: () => ({ get: async () => { throw new Error('err'); } }) }) });
    expect(await getSentReferrals(FROM_UID)).toEqual([]);
  });
});

describe('getNetworkPoints', () => {
  test('lanza si uid undefined', async () => {
    await expect(getNetworkPoints(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna zeros si sin referidos', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getNetworkPoints(FROM_UID);
    expect(r.totalPoints).toBe(0);
    expect(r.sentCount).toBe(0);
  });
  test('calcula puntos por referidos aceptados', async () => {
    const referrals = [
      { fromUid: FROM_UID, state: 'accepted' },
      { fromUid: FROM_UID, state: 'accepted' },
      { fromUid: FROM_UID, state: 'pending' },
    ];
    __setFirestoreForTests(makeMockDb({ referrals }));
    const r = await getNetworkPoints(FROM_UID);
    expect(r.acceptedCount).toBe(2);
    expect(r.totalPoints).toBe(2 * REFERRAL_REWARD_POINTS);
  });
});

describe('recordNetworkEvent', () => {
  test('lanza si fromUid undefined', async () => {
    await expect(recordNetworkEvent(undefined, TO_UID, 'referral_sent')).rejects.toThrow('fromUid requerido');
  });
  test('lanza si eventType invalido', async () => {
    await expect(recordNetworkEvent(FROM_UID, TO_UID, 'evento_falso')).rejects.toThrow('eventType invalido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordNetworkEvent(FROM_UID, TO_UID, 'referral_sent')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordNetworkEvent(FROM_UID, TO_UID, 'lead_transfer')).rejects.toThrow('set error');
  });
});
