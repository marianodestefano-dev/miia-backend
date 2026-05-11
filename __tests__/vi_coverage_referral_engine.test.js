'use strict';

/**
 * VI-BACKEND-COVERAGE: core/referral_engine.js + core/referral_natural.js — 100% branches
 */

const re = require('../core/referral_engine');
const rn = require('../core/referral_natural');

// ── Helpers ───────────────────────────────────────────────────────

function makeReDb({ snapEmpty = false, clicks = 0 } = {}) {
  const docRef = {
    set: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };
  const snap = {
    empty: snapEmpty,
    docs: snapEmpty ? [] : [{ ref: docRef, data: jest.fn().mockReturnValue({ clicks }) }],
    forEach: jest.fn(fn => snapEmpty ? null : fn({ data: () => ({ code: 'abc123', uid: 'uid1', clicks: 2, conversions: 0 }) }),),
  };
  return {
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue(docRef),
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue(snap),
    }),
  };
}

beforeEach(() => {
  re.__setFirestoreForTests(makeReDb());
  rn.__setFirestoreForTests(makeReDb());
  jest.clearAllMocks();
});

// ── referral_engine: createInvite ─────────────────────────────────

describe('referral_engine.createInvite', () => {
  test('!uid → throw', async () => {
    await expect(re.createInvite('')).rejects.toThrow('uid required');
  });

  test('con utm_campaign → link contiene utm_campaign (branch truthy)', async () => {
    const r = await re.createInvite('uid1', { utm_campaign: 'summer' });
    expect(r.link).toContain('utm_campaign=summer');
  });

  test('sin utm_campaign → link sin utm_campaign (branch falsy)', async () => {
    const r = await re.createInvite('uid1', {});
    expect(r.link).not.toContain('utm_campaign');
  });

  test('sin opts → usa {} por defecto (branch opts = opts || {})', async () => {
    const r = await re.createInvite('uid1');
    expect(r.code).toBeDefined();
  });
});

// ── referral_engine: trackClick ───────────────────────────────────

describe('referral_engine.trackClick', () => {
  test('snap vacío → null (branch snap.empty)', async () => {
    re.__setFirestoreForTests(makeReDb({ snapEmpty: true }));
    expect(await re.trackClick('nonexistent')).toBeNull();
  });

  test('snap encontrado con clicks>0 → incrementa (branch clicks truthy)', async () => {
    re.__setFirestoreForTests(makeReDb({ clicks: 3 }));
    const r = await re.trackClick('abc123');
    expect(r).toEqual({ code: 'abc123', clicked: true });
  });

  test('snap encontrado con clicks=0 → clicks || 0 false branch', async () => {
    re.__setFirestoreForTests(makeReDb({ clicks: 0 }));
    const r = await re.trackClick('abc123');
    expect(r).toEqual({ code: 'abc123', clicked: true });
  });
});

// ── referral_engine: getReferralNetwork ───────────────────────────

describe('referral_engine.getReferralNetwork', () => {
  test('!uid → throw', async () => {
    await expect(re.getReferralNetwork('')).rejects.toThrow('uid required');
  });

  test('uid válido → retorna network', async () => {
    const r = await re.getReferralNetwork('uid1');
    expect(r).toHaveProperty('nodes');
    expect(r).toHaveProperty('edges');
  });
});

// ── referral_natural: detectInterestSignal ────────────────────────

describe('referral_natural.detectInterestSignal', () => {
  test('null/undefined → interested=false (branch message falsy)', () => {
    const r = rn.detectInterestSignal(null);
    expect(r.interested).toBe(false);
    expect(r.signals).toEqual([]);
  });

  test('sin señal → interested=false', () => {
    expect(rn.detectInterestSignal('hola buenos dias').interested).toBe(false);
  });

  test('con señal → interested=true', () => {
    const r = rn.detectInterestSignal('me interesa saber más');
    expect(r.interested).toBe(true);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  test('múltiples señales → confidence 1 (branch Math.min(1,...) cap)', () => {
    const r = rn.detectInterestSignal('me interesa, donde puedo, cuanto cuesta, como funciona, quiero saber');
    expect(r.confidence).toBe(1);
  });
});

// ── referral_natural: queueLead ───────────────────────────────────

describe('referral_natural.queueLead', () => {
  test('con context y sourceMessage → usa ambos (branch opts.context truthy, opts.sourceMessage truthy)', async () => {
    const r = await rn.queueLead('+54911', 'uid1', { context: 'web', sourceMessage: 'Hola quiero info' });
    expect(r.context).toBe('web');
    expect(r.sourceConversation).toBe('Hola quiero info');
  });

  test('sin context ni sourceMessage → null (branch falsy)', async () => {
    const r = await rn.queueLead('+54912', 'uid1', {});
    expect(r.context).toBeNull();
    expect(r.sourceConversation).toBeNull();
  });

  test('sin opts → usa {} (branch opts = opts || {})', async () => {
    const r = await rn.queueLead('+54913', 'uid1');
    expect(r.status).toBe('queued');
  });
});

// ── referral_natural: getOutreachCapacity ─────────────────────────

describe('referral_natural.getOutreachCapacity', () => {
  test('doc.exists=true → usa count del doc (branch doc.exists true)', async () => {
    const docSnap = { exists: true, data: () => ({ count: 2 }) };
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(docSnap) }),
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.getOutreachCapacity('uid1', '2024-01-01');
    expect(r.count).toBe(2);
    expect(r.available).toBe(1);
  });

  test('doc.exists=false → count=0 (branch doc.exists false)', async () => {
    const docSnap = { exists: false };
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(docSnap) }),
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.getOutreachCapacity('uid1', '2024-01-01');
    expect(r.count).toBe(0);
    expect(r.available).toBe(3);
  });

  test('doc.exists=true + count=0 → count || 0 false branch', async () => {
    const docSnap = { exists: true, data: () => ({ count: 0 }) };
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(docSnap) }),
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.getOutreachCapacity('uid1', '2024-01-01');
    expect(r.count).toBe(0);
    expect(r.available).toBe(3);
  });

  test('sin date → usa fecha actual (branch date falsy)', async () => {
    const docSnap = { exists: false };
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(docSnap) }),
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.getOutreachCapacity('uid1');
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── referral_natural: incrementOutreachCount ──────────────────────

describe('referral_natural.incrementOutreachCount', () => {
  test('doc.exists=true + count>0 → current count (branch doc.exists true)', async () => {
    const docSnap = { exists: true, data: () => ({ count: 1 }) };
    const ref = { get: jest.fn().mockResolvedValue(docSnap), set: jest.fn().mockResolvedValue({}) };
    const db = {
      collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue(ref) }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.incrementOutreachCount('uid1', '2024-01-01');
    expect(r.count).toBe(2);
  });

  test('doc.exists=true + count=0 → count || 0 false branch', async () => {
    const docSnap = { exists: true, data: () => ({ count: 0 }) };
    const ref = { get: jest.fn().mockResolvedValue(docSnap), set: jest.fn().mockResolvedValue({}) };
    const db = {
      collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue(ref) }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.incrementOutreachCount('uid1', '2024-01-01');
    expect(r.count).toBe(1);
  });

  test('doc.exists=false → current=0 (branch doc.exists false)', async () => {
    const docSnap = { exists: false };
    const ref = { get: jest.fn().mockResolvedValue(docSnap), set: jest.fn().mockResolvedValue({}) };
    const db = {
      collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue(ref) }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.incrementOutreachCount('uid1');
    expect(r.count).toBe(1);
  });
});

// ── referral_natural: processNextLead ────────────────────────────

describe('referral_natural.processNextLead', () => {
  test('límite diario alcanzado → reason=daily_limit_reached (branch !ok)', async () => {
    // capacity.count = 3, available = 0
    const capDoc = { exists: true, data: () => ({ count: 3 }) };
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(capDoc) }),
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ forEach: jest.fn() }),
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.processNextLead('uid1');
    expect(r.reason).toBe('daily_limit_reached');
  });

  test('cola vacía → reason=queue_empty (branch !nextLead)', async () => {
    const capDoc = { exists: false }; // available = 3 → ok=true
    const queueSnap = { forEach: jest.fn() }; // no docs
    let callIdx = 0;
    const db = {
      collection: jest.fn().mockImplementation((col) => {
        if (col === 'miia_outreach_capacity') return {
          doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(capDoc) }),
        };
        return {
          where: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue(queueSnap),
          doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
        };
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.processNextLead('uid1');
    expect(r.reason).toBe('queue_empty');
  });

  test('lead encontrado → reason=ok y actualiza status (cubre false branch con doc no-queued)', async () => {
    const capDoc = { exists: false }; // available=3
    const pendingDoc = { id: 'lead0', data: () => ({ status: 'outreach_pending' }) };
    const queuedDoc = { id: 'lead1', data: () => ({ status: 'queued', fromPhone: '+549' }) };
    // forEach with 2 docs: first non-queued (false branch), second queued (true branch)
    const queueSnap = { forEach: jest.fn(fn => { fn(pendingDoc); fn(queuedDoc); }) };
    const queueSetRef = { set: jest.fn().mockResolvedValue({}) };
    const db = {
      collection: jest.fn().mockImplementation((col) => {
        if (col === 'miia_outreach_capacity') return {
          doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(capDoc) }),
        };
        return {
          where: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue(queueSnap),
          doc: jest.fn().mockReturnValue(queueSetRef),
        };
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.processNextLead('uid1');
    expect(r.reason).toBe('ok');
    expect(r.leadToContact).not.toBeNull();
  });
});

// ── referral_natural: markLeadConverted ──────────────────────────

describe('referral_natural.markLeadConverted', () => {
  test('marca lead como converted y retorna status', async () => {
    const setFn = jest.fn().mockResolvedValue({});
    const db = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: setFn }),
      }),
    };
    rn.__setFirestoreForTests(db);
    const r = await rn.markLeadConverted('lead-id-123');
    expect(r.leadId).toBe('lead-id-123');
    expect(r.status).toBe('converted');
    expect(setFn).toHaveBeenCalled();
  });
});

// ── getDb fallback: referral_engine ────────────────────────────────

describe('referral_engine getDb fallback — _db=null usa firebase directo', () => {
  test('branch _db falsy → require(../config/firebase).db', async () => {
    jest.resetModules();
    const mockSet = jest.fn().mockResolvedValue({});
    const mockUpdate = jest.fn().mockResolvedValue({});
    const fbDb = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: mockSet, update: mockUpdate }),
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: jest.fn() }),
      }),
    };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const freshRe = require('../core/referral_engine');
    await freshRe.createInvite('uid1');
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase');
    jest.resetModules();
  });
});

// ── getDb fallback: referral_natural ───────────────────────────────

describe('referral_natural getDb fallback — _db=null usa firebase directo', () => {
  test('branch _db falsy → require(../config/firebase).db', async () => {
    jest.resetModules();
    const mockSet = jest.fn().mockResolvedValue({});
    const fbDb = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({ set: mockSet }),
      }),
    };
    jest.doMock('../config/firebase', () => ({ db: fbDb }), { virtual: true });
    const freshRn = require('../core/referral_natural');
    await freshRn.markLeadConverted('lead-123');
    expect(fbDb.collection).toHaveBeenCalled();
    jest.dontMock('../config/firebase');
    jest.resetModules();
  });
});
