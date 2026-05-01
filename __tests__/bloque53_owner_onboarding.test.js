const { STEPS, getOnboardingState, advanceStep, isOnboardingComplete, getWelcomeMessage, __setFirestoreForTests } = require('../core/owner_onboarding');

function makeDb() {
  const store = {};
  function makeDoc(p) {
    return {
      get: async () => { const d = store[p]; return { exists: !!d, data: () => d }; },
      set: async (data, opts) => {
        if (opts && opts.merge) store[p] = Object.assign({}, store[p] || {}, data);
        else store[p] = Object.assign({}, data);
      },
      collection: (sub) => makeCol(p + '/' + sub),
    };
  }
  function makeCol(p) {
    return {
      doc: (id) => makeDoc(p + '/' + id),
      where: (f, op, v) => ({
        where: (f2, op2, v2) => ({
          get: async () => {
            const prefix = p + '/';
            const docs = Object.entries(store)
              .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v && d[f2] === v2)
              .map(([, d]) => ({ data: () => d }));
            return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
          }
        }),
        get: async () => {
          const prefix = p + '/';
          const docs = Object.entries(store)
            .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v)
            .map(([, d]) => ({ data: () => d }));
          return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
        }
      }),
    };
  }
  return { collection: (col) => makeCol(col) };
}

let db;
beforeEach(() => { db = makeDb(); __setFirestoreForTests(db); });
afterAll(() => { __setFirestoreForTests(null); });

describe('T355 - owner_onboarding', () => {
  test('STEPS array is frozen with 5 steps', () => {
    expect(STEPS.length).toBe(5);
    expect(STEPS[0]).toBe('phone_verify');
    expect(STEPS[4]).toBe('test_message');
    expect(Object.isFrozen(STEPS)).toBe(true);
  });

  test('getOnboardingState returns initial state for new owner', async () => {
    const state = await getOnboardingState('uid1');
    expect(state.step).toBe('phone_verify');
    expect(state.completed).toBe(false);
    expect(state.completedSteps).toHaveLength(0);
    expect(state.pendingSteps).toHaveLength(5);
  });

  test('advanceStep advances to next step', async () => {
    await advanceStep('uid1', 'phone_verify', { verified: true });
    const state = await getOnboardingState('uid1');
    expect(state.step).toBe('business_name');
    expect(state.completedSteps).toContain('phone_verify');
  });

  test('advanceStep throws for invalid step', async () => {
    await expect(advanceStep('uid1', 'invalid_step')).rejects.toThrow('invalid step');
  });

  test('isOnboardingComplete returns true after all steps', async () => {
    for (const step of STEPS) {
      await advanceStep('uid2', step, {});
    }
    const done = await isOnboardingComplete('uid2');
    expect(done).toBe(true);
  });

  test('isOnboardingComplete returns false for partial', async () => {
    await advanceStep('uid3', 'phone_verify');
    const done = await isOnboardingComplete('uid3');
    expect(done).toBe(false);
  });

  test('getWelcomeMessage returns personalized message', async () => {
    await advanceStep('uid4', 'business_name', { name: 'Panaderia Lopez' });
    const msg = await getWelcomeMessage('uid4');
    expect(msg).toContain('Panaderia Lopez');
  });

  test('getWelcomeMessage returns generic if no business_name', async () => {
    const msg = await getWelcomeMessage('uid_new');
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });
});
