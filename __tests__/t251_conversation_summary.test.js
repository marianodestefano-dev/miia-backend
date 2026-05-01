'use strict';

const {
  buildConversationSummary, saveConversationSummary,
  getConversationSummary, getSummaryHistory,
  detectSentiment, getKeyMoments,
  buildSummaryText, isValidSummaryType, isValidSentiment,
  SUMMARY_TYPES, SENTIMENT_LABELS,
  MAX_MESSAGES_FOR_SUMMARY,
  __setFirestoreForTests,
} = require('../core/conversation_summary');

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
  test('SUMMARY_TYPES tiene 4', () => { expect(SUMMARY_TYPES.length).toBe(4); });
  test('frozen SUMMARY_TYPES', () => { expect(() => { SUMMARY_TYPES.push('x'); }).toThrow(); });
  test('SENTIMENT_LABELS tiene 5', () => { expect(SENTIMENT_LABELS.length).toBe(5); });
  test('frozen SENTIMENT_LABELS', () => { expect(() => { SENTIMENT_LABELS.push('x'); }).toThrow(); });
  test('MAX_MESSAGES_FOR_SUMMARY es 20', () => { expect(MAX_MESSAGES_FOR_SUMMARY).toBe(20); });
});

describe('isValidSummaryType / isValidSentiment', () => {
  test('quick es valido', () => { expect(isValidSummaryType('quick')).toBe(true); });
  test('handoff es valido', () => { expect(isValidSummaryType('handoff')).toBe(true); });
  test('unknown_type no es valido', () => { expect(isValidSummaryType('unknown_type')).toBe(false); });
  test('positive es sentimiento valido', () => { expect(isValidSentiment('positive')).toBe(true); });
  test('bad_sentiment no es valido', () => { expect(isValidSentiment('bad_sentiment')).toBe(false); });
});

describe('detectSentiment', () => {
  test('array vacio retorna neutral', () => {
    const s = detectSentiment([]);
    expect(s.label).toBe('neutral');
    expect(s.score).toBe(0);
  });
  test('null retorna neutral', () => {
    const s = detectSentiment(null);
    expect(s.label).toBe('neutral');
  });
  test('mensajes positivos retornan positive/very_positive', () => {
    const s = detectSentiment(['gracias excelente', 'perfecto genial', 'todo bien satisfecho']);
    expect(['positive', 'very_positive']).toContain(s.label);
    expect(s.positiveHits).toBeGreaterThan(0);
  });
  test('mensajes negativos retornan negative/very_negative', () => {
    const s = detectSentiment(['problema grave', 'terrible servicio', 'muy molesto', 'decepcionado']);
    expect(['negative', 'very_negative']).toContain(s.label);
    expect(s.negativeHits).toBeGreaterThan(0);
  });
  test('sin palabras clave retorna neutral', () => {
    const s = detectSentiment(['hola', 'como estas', 'que tal']);
    expect(s.label).toBe('neutral');
    expect(s.positiveHits).toBe(0);
    expect(s.negativeHits).toBe(0);
  });
  test('score entre -1 y 1', () => {
    const s = detectSentiment(['gracias excelente maravilloso']);
    expect(s.score).toBeGreaterThanOrEqual(-1);
    expect(s.score).toBeLessThanOrEqual(1);
  });
  test('acepta mensajes como objetos', () => {
    const s = detectSentiment([{ text: 'gracias excelente' }]);
    expect(s.positiveHits).toBeGreaterThan(0);
  });
});

describe('getKeyMoments', () => {
  test('array vacio retorna vacio', () => {
    expect(getKeyMoments([])).toEqual([]);
  });
  test('null retorna vacio', () => {
    expect(getKeyMoments(null)).toEqual([]);
  });
  test('siempre detecta first_contact', () => {
    const moments = getKeyMoments(['hola']);
    expect(moments.some(m => m.type === 'first_contact')).toBe(true);
  });
  test('detecta price_inquiry', () => {
    const moments = getKeyMoments(['hola', 'cuanto cuesta el plan?']);
    expect(moments.some(m => m.type === 'price_inquiry')).toBe(true);
  });
  test('detecta appointment_request', () => {
    const moments = getKeyMoments(['hola', 'quiero reservar un turno']);
    expect(moments.some(m => m.type === 'appointment_request')).toBe(true);
  });
  test('detecta objection', () => {
    const moments = getKeyMoments(['hola', 'muy caro para mi']);
    expect(moments.some(m => m.type === 'objection')).toBe(true);
  });
  test('detecta close_attempt', () => {
    const moments = getKeyMoments(['hola', 'listo confirmado hacemos trato']);
    expect(moments.some(m => m.type === 'close_attempt')).toBe(true);
  });
  test('cada momento tiene index y snippet', () => {
    const moments = getKeyMoments(['hola como estas']);
    moments.forEach(m => {
      expect(typeof m.index).toBe('number');
      expect(typeof m.snippet).toBe('string');
    });
  });
  test('no duplica momentos del mismo indice y tipo', () => {
    const moments = getKeyMoments(['precio costo valor']);
    const priceInquiries = moments.filter(m => m.type === 'price_inquiry');
    expect(priceInquiries.length).toBe(1);
  });
});

describe('buildConversationSummary', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildConversationSummary(undefined, PHONE, [])).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildConversationSummary(UID, undefined, [])).toThrow('phone requerido');
  });
  test('lanza si messages no es array', () => {
    expect(() => buildConversationSummary(UID, PHONE, 'hola')).toThrow('messages debe ser array');
  });
  test('construye summary correctamente', () => {
    const msgs = ['hola', 'cuanto cuesta?', 'gracias excelente'];
    const s = buildConversationSummary(UID, PHONE, msgs, { date: '2026-05-01' });
    expect(s.uid).toBe(UID);
    expect(s.phone).toBe(PHONE);
    expect(s.msgCount).toBe(3);
    expect(s.summaryType).toBe('quick');
    expect(s.recordId).toContain('2026-05-01');
    expect(s.sentiment).toBeDefined();
    expect(s.keyMoments).toBeDefined();
  });
  test('summaryType invalido cae a quick', () => {
    const s = buildConversationSummary(UID, PHONE, [], { summaryType: 'invalid' });
    expect(s.summaryType).toBe('quick');
  });
  test('summaryType handoff es valido', () => {
    const s = buildConversationSummary(UID, PHONE, [], { summaryType: 'handoff' });
    expect(s.summaryType).toBe('handoff');
  });
  test('recordId incluye summaryType', () => {
    const s = buildConversationSummary(UID, PHONE, [], { summaryType: 'daily', date: '2026-05-01' });
    expect(s.recordId).toContain('daily');
  });
  test('lastMessageSnippet presente', () => {
    const msgs = ['hola', 'cuanto cuesta?'];
    const s = buildConversationSummary(UID, PHONE, msgs);
    expect(typeof s.lastMessageSnippet).toBe('string');
  });
  test('msgs vacio: sentiment neutral, keyMoments vacio', () => {
    const s = buildConversationSummary(UID, PHONE, []);
    expect(s.sentiment.label).toBe('neutral');
    expect(s.keyMoments).toEqual([]);
  });
});

describe('saveConversationSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveConversationSummary(undefined, { recordId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveConversationSummary(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const s = buildConversationSummary(UID, PHONE, ['hola']);
    const id = await saveConversationSummary(UID, s);
    expect(id).toBe(s.recordId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const s = buildConversationSummary(UID, PHONE, []);
    await expect(saveConversationSummary(UID, s)).rejects.toThrow('set error');
  });
});

describe('getConversationSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getConversationSummary(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(getConversationSummary(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getConversationSummary(UID, PHONE)).toBeNull();
  });
  test('retorna el mas reciente', async () => {
    const s1 = buildConversationSummary(UID, PHONE, ['hola'], { date: '2026-05-01', createdAt: 1000 });
    const s2 = buildConversationSummary(UID, PHONE, ['adios'], { date: '2026-05-02', createdAt: 2000 });
    __setFirestoreForTests(makeMockDb({ stored: { [s1.recordId]: s1, [s2.recordId]: s2 } }));
    const latest = await getConversationSummary(UID, PHONE);
    expect(latest.date).toBe('2026-05-02');
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getConversationSummary(UID, PHONE)).toBeNull();
  });
});

describe('getSummaryHistory', () => {
  test('lanza si uid undefined', async () => {
    await expect(getSummaryHistory(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay registros', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getSummaryHistory(UID)).toEqual([]);
  });
  test('filtra por phone', async () => {
    const s1 = buildConversationSummary(UID, PHONE, [], { date: '2026-05-01', createdAt: 1 });
    const s2 = buildConversationSummary(UID, '+5411999', [], { date: '2026-05-01', createdAt: 2 });
    __setFirestoreForTests(makeMockDb({ stored: { [s1.recordId]: s1, [s2.recordId]: s2 } }));
    const hist = await getSummaryHistory(UID, { phone: PHONE });
    expect(hist.length).toBe(1);
    expect(hist[0].phone).toBe(PHONE);
  });
  test('respeta limit', async () => {
    const stored = {};
    for (let i = 0; i < 5; i++) {
      const s = buildConversationSummary(UID, '+5411' + i, [], { date: '2026-05-01', createdAt: i });
      stored[s.recordId] = s;
    }
    __setFirestoreForTests(makeMockDb({ stored }));
    const hist = await getSummaryHistory(UID, { limit: 3 });
    expect(hist.length).toBe(3);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getSummaryHistory(UID)).toEqual([]);
  });
});

describe('buildSummaryText', () => {
  test('retorna vacio si null', () => { expect(buildSummaryText(null)).toBe(''); });
  test('incluye phone y msgCount', () => {
    const s = buildConversationSummary(UID, PHONE, ['hola', 'adios'], { date: '2026-05-01' });
    const text = buildSummaryText(s);
    expect(text).toContain(PHONE);
    expect(text).toContain('2');
  });
  test('incluye sentimiento', () => {
    const s = buildConversationSummary(UID, PHONE, [], { date: '2026-05-01' });
    const text = buildSummaryText(s);
    expect(text).toContain('neutral');
  });
  test('incluye fecha', () => {
    const s = buildConversationSummary(UID, PHONE, [], { date: '2026-05-01' });
    const text = buildSummaryText(s);
    expect(text).toContain('2026-05-01');
  });
  test('incluye momentos clave si hay', () => {
    const msgs = ['hola', 'cuanto cuesta el plan?'];
    const s = buildConversationSummary(UID, PHONE, msgs, { date: '2026-05-01' });
    const text = buildSummaryText(s);
    expect(text).toContain('price_inquiry');
  });
});
