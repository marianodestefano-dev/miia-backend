'use strict';

const {
  scheduleBroadcast, getDueBroadcasts, markBroadcastSent,
  cancelBroadcast, getBroadcastHistory,
  BROADCAST_STATES, MAX_RECIPIENTS_PER_BROADCAST, MIN_SCHEDULE_AHEAD_MINS,
  __setFirestoreForTests,
} = require('../core/broadcast_scheduler');

const UID = 'testUid1234567890';
const NOW = new Date('2026-05-04T12:00:00.000Z').getTime();
const FUTURE = new Date(NOW + 10 * 60 * 1000).toISOString();

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
              return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'b' + i }); }); } };
            },
          };
        },
      };
    },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'b' + i }); }); } };
    },
  };

  var uidDoc = { collection: function() { return coll; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('BROADCAST_STATES y constants', function() {
  test('tiene draft scheduled sent cancelled', function() {
    expect(BROADCAST_STATES).toContain('draft');
    expect(BROADCAST_STATES).toContain('scheduled');
    expect(BROADCAST_STATES).toContain('sent');
    expect(BROADCAST_STATES).toContain('cancelled');
  });
  test('frozen', function() { expect(function() { BROADCAST_STATES[0] = 'x'; }).toThrow(); });
  test('MAX_RECIPIENTS_PER_BROADCAST es 1000', function() { expect(MAX_RECIPIENTS_PER_BROADCAST).toBe(1000); });
});

describe('scheduleBroadcast', function() {
  test('lanza si uid undefined', async function() {
    await expect(scheduleBroadcast(undefined, { message: 'hola', recipients: ['+1111'] })).rejects.toThrow('uid requerido');
  });
  test('lanza si message undefined', async function() {
    await expect(scheduleBroadcast(UID, { recipients: ['+1111'] })).rejects.toThrow('message requerido');
  });
  test('lanza si recipients vacio', async function() {
    await expect(scheduleBroadcast(UID, { message: 'hola', recipients: [] })).rejects.toThrow('no vacio');
  });
  test('lanza si recipients supera maximo', async function() {
    var big = Array.from({ length: 1001 }, function(_, i) { return '+' + (1000000 + i); });
    await expect(scheduleBroadcast(UID, { message: 'hola', recipients: big })).rejects.toThrow('maximo');
  });
  test('lanza si sendAt muy pronto', async function() {
    var soon = new Date(Date.now() + 1000).toISOString();
    await expect(scheduleBroadcast(UID, { message: 'hola', recipients: ['+1111'], sendAt: soon })).rejects.toThrow('minutos');
  });
  test('programa correctamente con sendAt futuro', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await scheduleBroadcast(UID, { message: 'hola', recipients: ['+1111', '+2222'], sendAt: FUTURE });
    expect(r.broadcastId).toBeDefined();
    expect(r.state).toBe('scheduled');
    expect(r.recipientCount).toBe(2);
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(scheduleBroadcast(UID, { message: 'hola', recipients: ['+1111'], sendAt: FUTURE })).rejects.toThrow('set error');
  });
});

describe('getDueBroadcasts', function() {
  test('lanza si uid undefined', async function() {
    await expect(getDueBroadcasts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay due', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getDueBroadcasts(UID, NOW);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getDueBroadcasts(UID, NOW);
    expect(r).toEqual([]);
  });
});

describe('markBroadcastSent', function() {
  test('lanza si uid undefined', async function() {
    await expect(markBroadcastSent(undefined, 'bc1')).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async function() {
    await expect(markBroadcastSent(UID, undefined)).rejects.toThrow('broadcastId requerido');
  });
  test('marca sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(markBroadcastSent(UID, 'bc1')).resolves.toBeUndefined();
  });
});

describe('cancelBroadcast', function() {
  test('lanza si uid undefined', async function() {
    await expect(cancelBroadcast(undefined, 'bc1')).rejects.toThrow('uid requerido');
  });
  test('retorna cancelled true', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await cancelBroadcast(UID, 'bc1');
    expect(r.cancelled).toBe(true);
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(cancelBroadcast(UID, 'bc1')).rejects.toThrow('set error');
  });
});

describe('getBroadcastHistory', function() {
  test('lanza si uid undefined', async function() {
    await expect(getBroadcastHistory(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay historial', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getBroadcastHistory(UID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getBroadcastHistory(UID);
    expect(r).toEqual([]);
  });
});
