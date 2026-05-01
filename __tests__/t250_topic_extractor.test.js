'use strict';

const {
  extractTopics, getMainTopic,
  buildTopicRecord, saveTopicRecord,
  getLatestTopic, getTopicHistory,
  buildTopicSummaryText,
  isValidTopic, normalizeText,
  TOPICS, TOPIC_KEYWORDS,
  MAX_MESSAGES_TO_ANALYZE, MIN_CONFIDENCE,
  __setFirestoreForTests,
} = require('../core/topic_extractor');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: () => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d.phone === PHONE);
              return {
                empty: entries.length === 0,
                forEach: fn => entries.forEach(d => fn({ data: () => d })),
              };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('TOPICS tiene 11', () => { expect(TOPICS.length).toBe(11); });
  test('frozen TOPICS', () => { expect(() => { TOPICS.push('x'); }).toThrow(); });
  test('TOPIC_KEYWORDS tiene entradas para cada topic excepto unknown', () => {
    const topicsWithKw = TOPICS.filter(t => t !== 'unknown');
    topicsWithKw.forEach(t => { expect(TOPIC_KEYWORDS[t]).toBeDefined(); });
  });
  test('MAX_MESSAGES_TO_ANALYZE es 5', () => { expect(MAX_MESSAGES_TO_ANALYZE).toBe(5); });
  test('MIN_CONFIDENCE es 0.1', () => { expect(MIN_CONFIDENCE).toBe(0.1); });
});

describe('isValidTopic / normalizeText', () => {
  test('sales_inquiry es valido', () => { expect(isValidTopic('sales_inquiry')).toBe(true); });
  test('unknown es valido', () => { expect(isValidTopic('unknown')).toBe(true); });
  test('bad_topic no es valido', () => { expect(isValidTopic('bad_topic')).toBe(false); });
  test('normalizeText minusculas y sin tildes', () => {
    expect(normalizeText('Informaci\u00f3n')).toBe('informacion');
  });
  test('normalizeText null retorna vacio', () => { expect(normalizeText(null)).toBe(''); });
  test('normalizeText numero retorna vacio', () => { expect(normalizeText(42)).toBe(''); });
});

describe('extractTopics', () => {
  test('array vacio retorna unknown', () => {
    const r = extractTopics([]);
    expect(r[0].topic).toBe('unknown');
  });
  test('null retorna unknown', () => {
    const r = extractTopics(null);
    expect(r[0].topic).toBe('unknown');
  });
  test('mensaje sobre precio detecta pricing', () => {
    const r = extractTopics(['Hola, cuanto cuesta el plan?']);
    const pricing = r.find(t => t.topic === 'pricing');
    expect(pricing).toBeDefined();
    expect(pricing.confidence).toBeGreaterThan(0);
  });
  test('mensaje sobre turno detecta appointment_request', () => {
    const r = extractTopics(['Quiero reservar un turno para manana']);
    const apt = r.find(t => t.topic === 'appointment_request');
    expect(apt).toBeDefined();
  });
  test('mensaje de compra detecta sales_inquiry', () => {
    const r = extractTopics(['Quiero comprar el producto']);
    const sales = r.find(t => t.topic === 'sales_inquiry');
    expect(sales).toBeDefined();
  });
  test('mensaje de soporte detecta support_request', () => {
    const r = extractTopics(['Tengo un problema, no funciona el sistema']);
    const sup = r.find(t => t.topic === 'support_request');
    expect(sup).toBeDefined();
  });
  test('mensaje sin keywords retorna unknown', () => {
    const r = extractTopics(['asdfgh zxcvbn']);
    expect(r[0].topic).toBe('unknown');
  });
  test('acepta mensajes como objetos con campo text', () => {
    const r = extractTopics([{ text: 'cuanto cuesta?' }]);
    const pricing = r.find(t => t.topic === 'pricing');
    expect(pricing).toBeDefined();
  });
  test('acepta mensajes como objetos con campo message', () => {
    const r = extractTopics([{ message: 'quiero comprar' }]);
    const sales = r.find(t => t.topic === 'sales_inquiry');
    expect(sales).toBeDefined();
  });
  test('resultados ordenados por confidence desc', () => {
    const r = extractTopics(['cuanto cuesta comprar?', 'precio del producto', 'quiero adquirir']);
    if (r.length > 1) {
      expect(r[0].confidence).toBeGreaterThanOrEqual(r[1].confidence);
    }
  });
  test('confidence entre 0 y 1', () => {
    const r = extractTopics(['precio del plan mensual']);
    r.forEach(item => {
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    });
  });
  test('keywords incluidas en resultado', () => {
    const r = extractTopics(['cuanto cuesta el precio?']);
    const pricing = r.find(t => t.topic === 'pricing');
    expect(pricing.keywords.length).toBeGreaterThan(0);
  });
  test('usa solo ultimos MAX_MESSAGES_TO_ANALYZE mensajes', () => {
    const msgs = [
      'zzz zzz', 'zzz zzz', 'zzz zzz', 'zzz zzz', 'zzz zzz',
      'cuanto cuesta el precio del plan?',
    ];
    const r = extractTopics(msgs);
    const pricing = r.find(t => t.topic === 'pricing');
    expect(pricing).toBeDefined();
  });
});

describe('getMainTopic', () => {
  test('retorna topic con mayor confidence', () => {
    const main = getMainTopic(['precio del plan', 'cuanto cuesta?', 'presupuesto?']);
    expect(main.topic).toBe('pricing');
    expect(main.confidence).toBeGreaterThan(0);
  });
  test('array vacio retorna unknown', () => {
    const main = getMainTopic([]);
    expect(main.topic).toBe('unknown');
  });
  test('tiene campo keywords', () => {
    const main = getMainTopic(['quiero comprar el catalogo']);
    expect(Array.isArray(main.keywords)).toBe(true);
  });
});

describe('buildTopicRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildTopicRecord(undefined, PHONE, 'pricing', 0.8, [])).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildTopicRecord(UID, undefined, 'pricing', 0.8, [])).toThrow('phone requerido');
  });
  test('lanza si topic invalido', () => {
    expect(() => buildTopicRecord(UID, PHONE, 'bad_topic', 0.8, [])).toThrow('topic invalido');
  });
  test('lanza si confidence no es numero', () => {
    expect(() => buildTopicRecord(UID, PHONE, 'pricing', 'alta', [])).toThrow('confidence debe ser numero');
  });
  test('construye record correctamente', () => {
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.75, ['precio'], { date: '2026-05-01' });
    expect(r.uid).toBe(UID);
    expect(r.phone).toBe(PHONE);
    expect(r.topic).toBe('pricing');
    expect(r.confidence).toBe(0.75);
    expect(r.keywords).toContain('precio');
    expect(r.recordId).toContain('2026-05-01');
  });
  test('confidence se clampea entre 0 y 1', () => {
    const r = buildTopicRecord(UID, PHONE, 'unknown', 1.5, []);
    expect(r.confidence).toBe(1);
    const r2 = buildTopicRecord(UID, PHONE, 'unknown', -0.5, []);
    expect(r2.confidence).toBe(0);
  });
  test('keywords default a array vacio si no es array', () => {
    const r = buildTopicRecord(UID, PHONE, 'unknown', 0.5, null);
    expect(Array.isArray(r.keywords)).toBe(true);
  });
});

describe('saveTopicRecord', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveTopicRecord(undefined, { recordId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveTopicRecord(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.8, ['precio']);
    const id = await saveTopicRecord(UID, r);
    expect(id).toBe(r.recordId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.8, []);
    await expect(saveTopicRecord(UID, r)).rejects.toThrow('set error');
  });
});

describe('getLatestTopic', () => {
  test('lanza si uid undefined', async () => {
    await expect(getLatestTopic(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getLatestTopic(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getLatestTopic(UID, PHONE)).toBeNull();
  });
  test('retorna record mas reciente', async () => {
    const r1 = buildTopicRecord(UID, PHONE, 'pricing', 0.8, [], { date: '2026-05-01', createdAt: 1000 });
    const r2 = buildTopicRecord(UID, PHONE, 'sales_inquiry', 0.6, [], { date: '2026-05-02', createdAt: 2000 });
    __setFirestoreForTests(makeMockDb({ stored: { [r1.recordId]: r1, [r2.recordId]: r2 } }));
    const latest = await getLatestTopic(UID, PHONE);
    expect(latest.topic).toBe('sales_inquiry');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getLatestTopic(UID, PHONE)).toBeNull();
  });
});

describe('getTopicHistory', () => {
  test('lanza si uid undefined', async () => {
    await expect(getTopicHistory(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay registros', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getTopicHistory(UID)).toEqual([]);
  });
  test('filtra por topic', async () => {
    const r1 = buildTopicRecord(UID, PHONE, 'pricing', 0.8, [], { date: '2026-05-01', createdAt: 1000 });
    const r2 = buildTopicRecord(UID, '+5411999', 'sales_inquiry', 0.6, [], { date: '2026-05-01', createdAt: 2000 });
    __setFirestoreForTests(makeMockDb({ stored: { [r1.recordId]: r1, [r2.recordId]: r2 } }));
    const hist = await getTopicHistory(UID, { topic: 'pricing' });
    expect(hist.length).toBe(1);
    expect(hist[0].topic).toBe('pricing');
  });
  test('respeta limit', async () => {
    const stored = {};
    for (let i = 0; i < 5; i++) {
      const r = buildTopicRecord(UID, '+5411' + i, 'unknown', 0.5, [], { date: '2026-05-0' + (i+1), createdAt: i });
      stored[r.recordId] = r;
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    const hist = await getTopicHistory(UID, { limit: 3 });
    expect(hist.length).toBe(3);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getTopicHistory(UID)).toEqual([]);
  });
});

describe('buildTopicSummaryText', () => {
  test('retorna vacio si null', () => { expect(buildTopicSummaryText(null)).toBe(''); });
  test('incluye topic y confidence', () => {
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.75, ['precio']);
    const text = buildTopicSummaryText(r);
    expect(text).toContain('pricing');
    expect(text).toContain('75%');
  });
  test('incluye keywords si hay', () => {
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.8, ['precio', 'costo']);
    const text = buildTopicSummaryText(r);
    expect(text).toContain('precio');
    expect(text).toContain('costo');
  });
  test('sin keywords no menciona Palabras clave', () => {
    const r = buildTopicRecord(UID, PHONE, 'unknown', 1.0, []);
    const text = buildTopicSummaryText(r);
    expect(text).not.toContain('Palabras clave');
  });
  test('incluye emoji pricing', () => {
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.9, []);
    const text = buildTopicSummaryText(r);
    expect(text).toContain('\u{1F4B0}');
  });
  test('appointment_request tiene emoji correcto', () => {
    const r = buildTopicRecord(UID, PHONE, 'appointment_request', 0.9, []);
    const text = buildTopicSummaryText(r);
    expect(text).toContain('\u{1F4C5}');
  });
});
