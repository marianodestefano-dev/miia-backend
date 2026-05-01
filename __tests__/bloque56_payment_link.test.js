const { generatePaymentLink, trackPaymentClick, markPaymentPaid, listPaymentLinks, buildWhatsAppMessage, __setFirestoreForTests } = require('../core/payment_link_manager');

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

describe('T361 - payment_link_manager', () => {
  test('generatePaymentLink creates link with correct fields', async () => {
    const link = await generatePaymentLink('uid1', { amount: 1000, currency: 'ARS' });
    expect(link.id).toBeDefined();
    expect(link.status).toBe('pending');
    expect(link.click_count).toBe(0);
    expect(link.url).toMatch(/^https/);
    expect(link.amount).toBe(1000);
  });

  test('generatePaymentLink throws if no uid', async () => {
    await expect(generatePaymentLink(null, { amount: 100, currency: 'ARS' })).rejects.toThrow('uid required');
  });

  test('generatePaymentLink throws if amount <= 0', async () => {
    await expect(generatePaymentLink('uid1', { amount: 0, currency: 'ARS' })).rejects.toThrow('amount must be positive');
  });

  test('trackPaymentClick increments click_count', async () => {
    const link = await generatePaymentLink('uid1', { amount: 500, currency: 'USD' });
    const updated = await trackPaymentClick(link.id);
    expect(updated.click_count).toBe(1);
    const updated2 = await trackPaymentClick(link.id);
    expect(updated2.click_count).toBe(2);
  });

  test('markPaymentPaid sets status to paid', async () => {
    const link = await generatePaymentLink('uid1', { amount: 200, currency: 'ARS' });
    const paid = await markPaymentPaid(link.id, { method: 'mercadopago' });
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).toBeDefined();
  });

  test('markPaymentPaid throws if already paid', async () => {
    const link = await generatePaymentLink('uid1', { amount: 300, currency: 'ARS' });
    await markPaymentPaid(link.id);
    await expect(markPaymentPaid(link.id)).rejects.toThrow('already_paid');
  });

  test('buildWhatsAppMessage formats message with amount and url', () => {
    const link = { url: 'https://pay.miia-app.com/p/abc', amount: 1500, currency: 'ARS' };
    const msg = buildWhatsAppMessage(link);
    expect(msg).toContain('1500');
    expect(msg).toContain('https://pay.miia-app.com/p/abc');
  });

  test('listPaymentLinks returns links for uid', async () => {
    await generatePaymentLink('uid2', { amount: 100, currency: 'ARS' });
    await generatePaymentLink('uid2', { amount: 200, currency: 'ARS' });
    const links = await listPaymentLinks('uid2');
    expect(links.length).toBe(2);
  });
});
