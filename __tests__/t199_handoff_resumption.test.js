'use strict';

const {
  buildResumptionMessage, scheduleResumption, executeResumption,
  getPendingResumptions, cancelResumption, shouldMiiaResume,
  RESUMPTION_REASONS, DEFAULT_RESUMPTION_MESSAGE_ES, DEFAULT_RESUMPTION_MESSAGE_EN,
  __setFirestoreForTests,
} = require('../core/handoff_resumption');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const TICKET_ID = 'ticket123';
const NOW = new Date('2026-05-04T12:00:00.000Z').getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var doc = opts.doc || null;
  var queryDocs = opts.queryDocs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;

  var innerDoc = {
    set: async function(data, setOpts) { if (throwSet) throw new Error('set error'); },
    get: async function() {
      if (throwGet) throw new Error('get error');
      return { exists: !!doc, data: function() { return doc; } };
    },
  };

  var innerColl = {
    doc: function() { return innerDoc; },
    where: function() {
      return {
        where: function() {
          return {
            get: async function() {
              if (throwGet) throw new Error('get error');
              return { forEach: function(fn) { queryDocs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'r' + i }); }); } };
            },
          };
        },
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { forEach: function(fn) { queryDocs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'r' + i }); }); } };
        },
      };
    },
  };

  var uidDoc = { collection: function() { return innerColl; } };
  return { collection: function() { return { doc: function() { return uidDoc; } }; } };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('RESUMPTION_REASONS y constants', function() {
  test('tiene ticket_resolved y timeout', function() {
    expect(RESUMPTION_REASONS).toContain('ticket_resolved');
    expect(RESUMPTION_REASONS).toContain('timeout');
  });
  test('frozen', function() { expect(function() { RESUMPTION_REASONS[0] = 'x'; }).toThrow(); });
  test('DEFAULT_RESUMPTION_MESSAGE_ES definido', function() { expect(DEFAULT_RESUMPTION_MESSAGE_ES.length).toBeGreaterThan(0); });
});

describe('buildResumptionMessage', function() {
  test('retorna mensaje en espanol por default', function() {
    expect(buildResumptionMessage()).toBe(DEFAULT_RESUMPTION_MESSAGE_ES);
    expect(buildResumptionMessage('es')).toBe(DEFAULT_RESUMPTION_MESSAGE_ES);
  });
  test('retorna mensaje en ingles', function() {
    expect(buildResumptionMessage('en')).toBe(DEFAULT_RESUMPTION_MESSAGE_EN);
  });
  test('incluye nombre del agente si se provee', function() {
    var r = buildResumptionMessage('es', 'Juan');
    expect(r).toContain('Juan');
  });
  test('customMessage tiene prioridad', function() {
    var r = buildResumptionMessage('es', null, 'Mensaje custom');
    expect(r).toBe('Mensaje custom');
  });
  test('customMessage vacio usa default', function() {
    var r = buildResumptionMessage('es', null, '   ');
    expect(r).toBe(DEFAULT_RESUMPTION_MESSAGE_ES);
  });
});

describe('scheduleResumption', function() {
  test('lanza si uid undefined', async function() {
    await expect(scheduleResumption(undefined, PHONE, TICKET_ID)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(scheduleResumption(UID, undefined, TICKET_ID)).rejects.toThrow('phone requerido');
  });
  test('lanza si ticketId undefined', async function() {
    await expect(scheduleResumption(UID, PHONE, undefined)).rejects.toThrow('ticketId requerido');
  });
  test('lanza si reason invalido', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(scheduleResumption(UID, PHONE, TICKET_ID, { reason: 'motivo_raro' })).rejects.toThrow('invalido');
  });
  test('retorna docId y resumeAt', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await scheduleResumption(UID, PHONE, TICKET_ID);
    expect(r.docId).toBeDefined();
    expect(r.resumeAt).toBeDefined();
    expect(r.reason).toBe('ticket_resolved');
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(scheduleResumption(UID, PHONE, TICKET_ID)).rejects.toThrow('set error');
  });
});

describe('executeResumption', function() {
  test('lanza si uid undefined', async function() {
    await expect(executeResumption(undefined, 'doc1')).rejects.toThrow('uid requerido');
  });
  test('lanza si docId undefined', async function() {
    await expect(executeResumption(UID, undefined)).rejects.toThrow('docId requerido');
  });
  test('retorna executed false si doc no existe', async function() {
    __setFirestoreForTests(makeMockDb({ doc: null }));
    var r = await executeResumption(UID, 'doc1');
    expect(r.executed).toBe(false);
    expect(r.reason).toBe('not_found');
  });
  test('ejecuta correctamente si doc existe', async function() {
    var docData = { phone: PHONE, ticketId: TICKET_ID, language: 'es', agentName: null, customMessage: null, state: 'scheduled' };
    __setFirestoreForTests(makeMockDb({ doc: docData }));
    var r = await executeResumption(UID, 'doc1');
    expect(r.executed).toBe(true);
    expect(r.message).toBeDefined();
    expect(r.phone).toBe(PHONE);
  });
});

describe('getPendingResumptions', function() {
  test('lanza si uid undefined', async function() {
    await expect(getPendingResumptions(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay pendientes', async function() {
    __setFirestoreForTests(makeMockDb({ queryDocs: [] }));
    var r = await getPendingResumptions(UID, NOW);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await getPendingResumptions(UID, NOW);
    expect(r).toEqual([]);
  });
});

describe('cancelResumption', function() {
  test('lanza si uid undefined', async function() {
    await expect(cancelResumption(undefined, 'doc1')).rejects.toThrow('uid requerido');
  });
  test('lanza si docId undefined', async function() {
    await expect(cancelResumption(UID, undefined)).rejects.toThrow('docId requerido');
  });
  test('retorna cancelled true', async function() {
    __setFirestoreForTests(makeMockDb());
    var r = await cancelResumption(UID, 'doc1');
    expect(r.cancelled).toBe(true);
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(cancelResumption(UID, 'doc1')).rejects.toThrow('set error');
  });
});

describe('shouldMiiaResume', function() {
  test('lanza si uid undefined', async function() {
    await expect(shouldMiiaResume(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna true si no hay resumpciones pendientes', async function() {
    __setFirestoreForTests(makeMockDb({ queryDocs: [] }));
    var r = await shouldMiiaResume(UID, PHONE);
    expect(r).toBe(true);
  });
  test('fail-open retorna true si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    var r = await shouldMiiaResume(UID, PHONE);
    expect(r).toBe(true);
  });
});
