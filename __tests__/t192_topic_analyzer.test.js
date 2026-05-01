'use strict';

const {
  detectTopicsInMessage, recordTopics, getTopTopics, getTopicsByPhone,
  TOPIC_KEYWORDS, TOPIC_LABELS, MIN_CONFIDENCE, MAX_TOPICS_PER_MESSAGE,
  DEFAULT_PERIOD_DAYS, MAX_TOP_TOPICS,
  __setFirestoreForTests,
} = require('../core/topic_analyzer');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NOW = new Date('2026-05-04T12:00:00.000Z').getTime();

function makeMockDb(opts) {
  opts = opts || {};
  var docs = opts.docs || [];
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;
  var innerColl = {
    doc: function() {
      return {
        set: async function(data) {
          if (throwSet) throw new Error('set error');
        },
      };
    },
    where: function() {
      return {
        where: function() {
          return {
            get: async function() {
              if (throwGet) throw new Error('get error');
              return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'doc' + i }); }); } };
            },
          };
        },
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { forEach: function(fn) { docs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'doc' + i }); }); } };
        },
      };
    },
  };
  var uidDoc = { collection: function() { return innerColl; } };
  return {
    collection: function() { return { doc: function() { return uidDoc; } }; },
  };
}

beforeEach(function() { __setFirestoreForTests(null); });
afterEach(function() { __setFirestoreForTests(null); });

describe('detectTopicsInMessage', function() {
  test('lanza si text no es string', function() {
    expect(function() { detectTopicsInMessage(null); }).toThrow('requerido');
  });
  test('retorna array vacio si no hay keywords', function() {
    const r = detectTopicsInMessage('texto sin sentido xkzqj');
    expect(r).toEqual([]);
  });
  test('detecta pricing por precio', function() {
    const r = detectTopicsInMessage('cuanto cuesta el producto');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].topic).toBe('pricing');
  });
  test('detecta appointment por turno', function() {
    const r = detectTopicsInMessage('quiero agendar un turno');
    const topics = r.map(function(t) { return t.topic; });
    expect(topics).toContain('appointment');
  });
  test('detecta greeting por hola', function() {
    const r = detectTopicsInMessage('hola como estas');
    const topics = r.map(function(t) { return t.topic; });
    expect(topics).toContain('greeting');
  });
  test('retorna max MAX_TOPICS_PER_MESSAGE topics', function() {
    const r = detectTopicsInMessage('precio hola horario delivery turno pago soporte ubicacion catalogo');
    expect(r.length).toBeLessThanOrEqual(MAX_TOPICS_PER_MESSAGE);
  });
  test('cada topic tiene label y confidence', function() {
    const r = detectTopicsInMessage('precio');
    expect(r[0]).toHaveProperty('label');
    expect(r[0]).toHaveProperty('confidence');
    expect(r[0].confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });
  test('detecta en ingles', function() {
    const r = detectTopicsInMessage('how much does it cost price');
    const topics = r.map(function(t) { return t.topic; });
    expect(topics).toContain('pricing');
  });
});

describe('TOPIC_KEYWORDS y TOPIC_LABELS constants', function() {
  test('TOPIC_KEYWORDS tiene pricing', function() { expect(TOPIC_KEYWORDS.pricing).toBeDefined(); });
  test('TOPIC_LABELS tiene label para cada keyword', function() {
    Object.keys(TOPIC_KEYWORDS).forEach(function(k) {
      expect(TOPIC_LABELS[k]).toBeDefined();
    });
  });
  test('DEFAULT_PERIOD_DAYS es 30', function() { expect(DEFAULT_PERIOD_DAYS).toBe(30); });
  test('MAX_TOP_TOPICS es 10', function() { expect(MAX_TOP_TOPICS).toBe(10); });
});

describe('recordTopics', function() {
  test('lanza si uid undefined', async function() {
    await expect(recordTopics(undefined, PHONE, 'hola')).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(recordTopics(UID, undefined, 'hola')).rejects.toThrow('phone requerido');
  });
  test('lanza si message undefined', async function() {
    await expect(recordTopics(UID, PHONE, undefined)).rejects.toThrow('message requerido');
  });
  test('retorna array vacio si no hay topics detectados', async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await recordTopics(UID, PHONE, 'xkzqjasdfghjkl');
    expect(r).toEqual([]);
  });
  test('guarda y retorna topics detectados', async function() {
    __setFirestoreForTests(makeMockDb());
    const r = await recordTopics(UID, PHONE, 'quiero saber el precio');
    expect(r.length).toBeGreaterThan(0);
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(recordTopics(UID, PHONE, 'precio')).rejects.toThrow('set error');
  });
});

describe('getTopTopics', function() {
  test('lanza si uid undefined', async function() {
    await expect(getTopTopics(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay datos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getTopTopics(UID, 30, NOW);
    expect(r).toEqual([]);
  });
  test('agrega conteos por topic', async function() {
    const docs = [
      { topics: ['pricing', 'greeting'], recordedAt: new Date(NOW).toISOString() },
      { topics: ['pricing'], recordedAt: new Date(NOW).toISOString() },
      { topics: ['appointment'], recordedAt: new Date(NOW).toISOString() },
    ];
    __setFirestoreForTests(makeMockDb({ docs: docs }));
    const r = await getTopTopics(UID, 30, NOW);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].topic).toBe('pricing');
    expect(r[0].count).toBe(2);
  });
  test('fail-open retorna array vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getTopTopics(UID, 30, NOW);
    expect(r).toEqual([]);
  });
});

describe('getTopicsByPhone', function() {
  test('lanza si uid undefined', async function() {
    await expect(getTopicsByPhone(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async function() {
    await expect(getTopicsByPhone(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna array vacio si no hay datos', async function() {
    __setFirestoreForTests(makeMockDb({ docs: [] }));
    const r = await getTopicsByPhone(UID, PHONE);
    expect(r).toEqual([]);
  });
  test('fail-open retorna array vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getTopicsByPhone(UID, PHONE);
    expect(r).toEqual([]);
  });
});
