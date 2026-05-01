const { BOOKING_STATUSES, createBooking, confirmBooking, cancelBooking, listBookings, getAvailableSlots, __setFirestoreForTests } = require('../core/booking_manager');

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

describe('T359 - booking_manager', () => {
  test('BOOKING_STATUSES frozen with correct values', () => {
    expect(Object.isFrozen(BOOKING_STATUSES)).toBe(true);
    expect(BOOKING_STATUSES.PENDING).toBe('pending');
    expect(BOOKING_STATUSES.CONFIRMED).toBe('confirmed');
    expect(BOOKING_STATUSES.CANCELLED).toBe('cancelled');
  });

  test('createBooking creates booking with correct fields', async () => {
    const b = await createBooking('uid1', { phone: '+541234', date: '2026-06-01', service: 'Corte' });
    expect(b.id).toBeDefined();
    expect(b.status).toBe('pending');
    expect(b.service).toBe('Corte');
    expect(b.createdAt).toBeDefined();
  });

  test('createBooking throws if missing required fields', async () => {
    await expect(createBooking(null, { phone: '+1', date: '2026-01-01', service: 'X' })).rejects.toThrow('uid required');
    await expect(createBooking('uid1', { date: '2026-01-01', service: 'X' })).rejects.toThrow('phone required');
    await expect(createBooking('uid1', { phone: '+1', service: 'X' })).rejects.toThrow('date required');
    await expect(createBooking('uid1', { phone: '+1', date: '2026-01-01' })).rejects.toThrow('service required');
  });

  test('confirmBooking changes status to confirmed', async () => {
    const b = await createBooking('uid1', { phone: '+1', date: '2026-06-01', service: 'Corte' });
    const confirmed = await confirmBooking('uid1', b.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).toBeDefined();
  });

  test('cancelBooking changes status to cancelled', async () => {
    const b = await createBooking('uid1', { phone: '+1', date: '2026-06-02', service: 'Tintura' });
    const cancelled = await cancelBooking('uid1', b.id, 'No puedo ir');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('No puedo ir');
  });

  test('listBookings returns bookings for uid', async () => {
    await createBooking('uid2', { phone: '+1', date: '2026-06-01', service: 'S1' });
    await createBooking('uid2', { phone: '+2', date: '2026-06-02', service: 'S2' });
    const bookings = await listBookings('uid2');
    expect(bookings.length).toBe(2);
  });

  test('getAvailableSlots returns slot list for date', async () => {
    const slots = await getAvailableSlots('uid1', '2026-06-01');
    expect(Array.isArray(slots)).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
  });

  test('confirmBooking throws if booking not found', async () => {
    await expect(confirmBooking('uid1', 'nonexistent-id')).rejects.toThrow('booking_not_found');
  });
});
