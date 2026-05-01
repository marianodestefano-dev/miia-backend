const { UPSELL_SIGNALS, detectUpsellOpportunity, buildUpsellPrompt, logUpsellTrigger, __setFirestoreForTests } = require('../core/product_upsell');

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

beforeEach(() => { __setFirestoreForTests(makeDb()); });
afterAll(() => { __setFirestoreForTests(null); });

describe('T357 - product_upsell', () => {
  test('UPSELL_SIGNALS is frozen array with signals', () => {
    expect(Object.isFrozen(UPSELL_SIGNALS)).toBe(true);
    expect(UPSELL_SIGNALS.length).toBeGreaterThan(3);
    expect(UPSELL_SIGNALS).toContain('quiero mas');
    expect(UPSELL_SIGNALS).toContain('complemento');
  });

  test('detectUpsellOpportunity detects signal in message', () => {
    const catalog = [{ name: "Pack Extra", price: 200 }];
    const result = detectUpsellOpportunity("quiero mas informacion", catalog);
    expect(result.triggered).toBe(true);
    expect(result.suggestedProducts).toHaveLength(1);
  });

  test('detectUpsellOpportunity returns false for normal message', () => {
    const result = detectUpsellOpportunity("Cual es el precio?", []);
    expect(result.triggered).toBe(false);
    expect(result.suggestedProducts).toHaveLength(0);
  });

  test('detectUpsellOpportunity handles empty message', () => {
    const result = detectUpsellOpportunity("", []);
    expect(result.triggered).toBe(false);
  });

  test('buildUpsellPrompt generates prompt with product list', () => {
    const products = [{ name: "Pack Pro", price: 500 }, { name: "Pack Basic", price: 200 }];
    const prompt = buildUpsellPrompt(products);
    expect(prompt).toContain("Pack Pro");
    expect(prompt).toContain("Pack Basic");
    expect(prompt).toContain("500");
  });

  test('buildUpsellPrompt returns empty string for empty list', () => {
    expect(buildUpsellPrompt([])).toBe("");
    expect(buildUpsellPrompt(null)).toBe("");
  });

  test('logUpsellTrigger stores trigger in Firestore', async () => {
    await expect(logUpsellTrigger('uid1', '+5491234', ['prod1'])).resolves.toBeUndefined();
  });

  test('detectUpsellOpportunity limits suggestions to 3', () => {
    const catalog = Array.from({length: 10}, (_, i) => ({ name: "P" + i }));
    const result = detectUpsellOpportunity("quiero mas", catalog);
    expect(result.triggered).toBe(true);
    expect(result.suggestedProducts.length).toBeLessThanOrEqual(3);
  });
});
