'use strict';

const {
  recordBroadcastEvent, getBroadcastStats, getOwnerBroadcastSummary,
  EVENT_TYPES,
  __setFirestoreForTests,
} = require('../core/broadcast_analytics');

const UID = 'testUid1234567890';
const BC_ID = 'bc_abc123';
const PHONE = '+541155667788';
const NOW = new Date('2026-05-04T12:00:00.000Z').getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var innerDoc = {
    set: async function(data, setOpts) { if (throwSet) throw new Error('set error'); },
  };

  var coll = {
    doc: function() { return innerDoc; },
    where: function() {
      return {
        where: function() {
          return {
            get: async function() {
              if (throwGet) throw new Error('get error');
              return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'e' + i }); }); } };
            },
          };
        },
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'e' + i }); }); } };
        },
      };
    },
  };

  var uidDoc = { collection: function() { return coll; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('EVENT_TYPES constants', function() {
  test('tiene delivered read replied failed opted_out', function() {
    expect(EVENT_TYPES).toContain('delivered');
    expect(EVENT_TYPES).toContain('read');
    expect(EVENT_TYPES).toContain('replied');
    expect(EVENT_TYPES).toContain('failed');
    expect(EVENT_TYPES).toContain('opted_out');
  });
  test('frozen', function() { expect(function() { EVENT_TYPES[0] = 'x'; }).toThrow(); });
});

describe('recordBroadcastEvent', function() {
  test('lanza si uid undefined', async function() {
    await expect(recordBroadcastEvent(undefined, BC_ID, PHONE, 'delivered')).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async function() {
    await expect(recordBroadcastEvent(UID, undefined, PHONE, 'delivered')).rejects.toThrow('broadcastId requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(recordBroadcastEvent(UID, BC_ID, undefined, 'delivered')).rejects.toThrow('phone requerido');
  });
  test('lanza si eventType invalido', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordBroadcastEvent(UID, BC_ID, PHONE, 'abierto')).rejects.toThrow('invalido');
  });
  test('registra sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordBroadcastEvent(UID, BC_ID, PHONE, 'delivered')).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordBroadcastEvent(UID, BC_ID, PHONE, 'delivered')).rejects.toThrow('set error');
  });
});

describe('getBroadcastStats', function() {
  test('lanza si uid undefined', async function() {
    await expect(getBroadcastStats(undefined, BC_ID)).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async function() {
    await expect(getBroadcastStats(UID, undefined)).rejects.toThrow('broadcastId requerido');
  });
  test('retorna zeros si no hay eventos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getBroadcastStats(UID, BC_ID);
    expect(r.uniqueContacts).toBe(0);
    expect(r.deliveryRate).toBe(0);
    expect(r.readRate).toBe(0);
  });
  test('calcula stats correctamente', async function() {
    var docs = [
      { broadcastId: BC_ID, phone: '+1111', eventType: 'delivered', recordedAt: new Date(NOW).toISOString() },
      { broadcastId: BC_ID, phone: '+1111', eventType: 'read', recordedAt: new Date(NOW).toISOString() },
      { broadcastId: BC_ID, phone: '+2222', eventType: 'delivered', recordedAt: new Date(NOW).toISOString() },
    ];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    var r = await getBroadcastStats(UID, BC_ID);
    expect(r.counts.delivered).toBe(2);
    expect(r.counts.read).toBe(1);
    expect(r.uniqueContacts).toBe(2);
  });
  test('fail-open retorna zeros si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getBroadcastStats(UID, BC_ID);
    expect(r.deliveryRate).toBe(0);
  });
});

describe('getOwnerBroadcastSummary', function() {
  test('lanza si uid undefined', async function() {
    await expect(getOwnerBroadcastSummary(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna zeros si no hay eventos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getOwnerBroadcastSummary(UID, 30, NOW);
    expect(r.totalEvents).toBe(0);
    expect(r.broadcastCount).toBe(0);
  });
  test('fail-open retorna zeros si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getOwnerBroadcastSummary(UID, 30, NOW);
    expect(r.totalEvents).toBe(0);
  });
});
