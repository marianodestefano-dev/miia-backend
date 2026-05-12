"use strict";

// t205: reescrito para usar la API real de broadcast_analytics.js
// La API 'recordBroadcastEvent / getBroadcastStats / getOwnerBroadcastSummary / EVENT_TYPES'
// era para una version futura que no existe. t170 cubre la API original.
// Este archivo complementa t170 con casos extra de cobertura.

const {
  recordSent, recordEvent, getCampaignMetrics, getAllCampaignsSummary,
  VALID_EVENTS,
  __setFirestoreForTests,
} = require('../core/broadcast_analytics');

const UID = 'testUid1234567890';
const BC_ID = 'bc_abc123';
const PHONE = '+541155667788';

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  return {
    collection: function() {
      return {
        doc: function() {
          return {
            collection: function() {
              return {
                doc: function() {
                  return {
                    set: async function() { if (throwSet) throw new Error('set error'); },
                  };
                },
                get: async function() {
                  if (throwGet) throw new Error('get error');
                  return {
                    forEach: function(fn) {
                      docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'e' + i }); });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('VALID_EVENTS constants', function() {
  test('tiene opened y replied', function() {
    expect(VALID_EVENTS).toContain('opened');
    expect(VALID_EVENTS).toContain('replied');
  });
  test('frozen', function() { expect(function() { VALID_EVENTS[0] = 'x'; }).toThrow(); });
});

describe('recordEvent extra branches', function() {
  test('lanza si uid undefined', async function() {
    await expect(recordEvent(undefined, BC_ID, PHONE, 'opened')).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async function() {
    await expect(recordEvent(UID, undefined, PHONE, 'opened')).rejects.toThrow('broadcastId requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(recordEvent(UID, BC_ID, undefined, 'opened')).rejects.toThrow('phone requerido');
  });
  test('lanza si eventType invalido', async function() {
    await expect(recordEvent(UID, BC_ID, PHONE, 'abierto')).rejects.toThrow('invalido');
  });
  test('registra opened sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(recordEvent(UID, BC_ID, PHONE, 'opened')).resolves.toBeUndefined();
  });
  test('propaga error Firestore en set', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordEvent(UID, BC_ID, PHONE, 'replied')).rejects.toThrow('set error');
  });
});

describe('getCampaignMetrics extra branches', function() {
  test('lanza si uid undefined', async function() {
    await expect(getCampaignMetrics(undefined, BC_ID)).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async function() {
    await expect(getCampaignMetrics(UID, undefined)).rejects.toThrow('broadcastId requerido');
  });
  test('retorna zeros si no hay eventos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getCampaignMetrics(UID, BC_ID);
    expect(r.sent).toBe(0);
    expect(r.openRate).toBe(0);
    expect(r.replyRate).toBe(0);
  });
  test('calcula rates correctamente con docs', async function() {
    var docs = [
      { opened: true, replied: false },
      { opened: true, replied: true },
      { opened: false, replied: false },
    ];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    var r = await getCampaignMetrics(UID, BC_ID);
    expect(r.sent).toBe(3);
    expect(r.opened).toBe(2);
    expect(r.replied).toBe(1);
  });
});

describe('getAllCampaignsSummary extra branches', function() {
  test('lanza si uid undefined', async function() {
    await expect(getAllCampaignsSummary(undefined, [])).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastIds no es array', async function() {
    await expect(getAllCampaignsSummary(UID, 'invalid')).rejects.toThrow('broadcastIds debe ser array');
  });
  test('retorna array vacio si broadcastIds vacio', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await getAllCampaignsSummary(UID, []);
    expect(r).toEqual([]);
  });
  test('retorna metricas por cada id', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    var r = await getAllCampaignsSummary(UID, ['bc1', 'bc2']);
    expect(r.length).toBe(2);
    expect(r[0].broadcastId).toBe('bc1');
    expect(r[1].broadcastId).toBe('bc2');
  });
});
