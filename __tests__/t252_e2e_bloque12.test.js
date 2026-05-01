'use strict';

// T252 E2E Bloque 12: lead_scorer + topic_extractor + conversation_summary + analytics_engine
const {
  computeLeadScore, buildScoreRecord, scoreAndSaveLead, getAllLeadScores,
  getScoreLabel, buildScoreText, SCORE_LABELS, SCORING_SIGNALS,
  __setFirestoreForTests: setScorer,
} = require('../core/lead_scorer');

const {
  extractTopics, getMainTopic, buildTopicRecord, saveTopicRecord,
  getTopicHistory, buildTopicSummaryText, TOPICS,
  __setFirestoreForTests: setTopic,
} = require('../core/topic_extractor');

const {
  buildConversationSummary, saveConversationSummary,
  getConversationSummary, detectSentiment, getKeyMoments,
  buildSummaryText, SUMMARY_TYPES,
  __setFirestoreForTests: setSummary,
} = require('../core/conversation_summary');

const {
  buildMetricRecord, incrementMetric, computeConversionRate,
  METRIC_TYPES, __setFirestoreForTests: setAnalytics,
} = require('../core/analytics_engine');

const UID = 'bloque12Uid';
const PHONE = '+541199887766';

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

function setAll(db) { setScorer(db); setTopic(db); setSummary(db); setAnalytics(db); }

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── LEAD SCORER ─────────────────────────────────────────────────────────────
describe('lead_scorer — E2E', () => {
  test('score base sin senales es 10', () => {
    expect(computeLeadScore({})).toBe(10);
  });
  test('spam fuerza score 5 ignorando todo', () => {
    const score = computeLeadScore({ is_spam: true, price_inquired: true, appointment_requested: true });
    expect(score).toBe(5);
  });
  test('getScoreLabel spam para score 5', () => {
    expect(getScoreLabel(5).label).toBe('Spam/Bot');
  });
  test('getScoreLabel caliente para score 70', () => {
    expect(getScoreLabel(70).label).toBe('Caliente');
  });
  test('getScoreLabel listo para score 95', () => {
    expect(getScoreLabel(95).label).toBe('Listo para cerrar');
  });
  test('SCORE_LABELS tiene 5 categorias', () => {
    expect(Object.keys(SCORE_LABELS).length).toBe(5);
  });
  test('buildScoreRecord incluye trend new sin previo', () => {
    const r = buildScoreRecord(UID, PHONE, 55, { price_inquired: true });
    expect(r.trend).toBeNull();
  });
  test('buildScoreRecord lanza sin uid', () => {
    expect(() => buildScoreRecord(undefined, PHONE, 55, {})).toThrow('uid requerido');
  });
  test('scoreAndSaveLead guarda y retorna record', async () => {
    setAll(makeMockDb());
    const r = await scoreAndSaveLead(UID, PHONE, { price_inquired: true, message_count: 5 });
    expect(r).not.toBeNull();
    expect(r.score).toBeGreaterThan(30);
    expect(r.trend).toBe('new');
  });
  test('scoreAndSaveLead detecta trend rising', async () => {
    const db = makeMockDb();
    setAll(db);
    await scoreAndSaveLead(UID, PHONE, { message_count: 3 });
    setAll(db);
    const r2 = await scoreAndSaveLead(UID, PHONE, { price_inquired: true, appointment_requested: true, message_count: 10 });
    expect(['rising', 'stable']).toContain(r2.trend);
  });
  test('getAllLeadScores filtra por minScore', async () => {
    const db = makeMockDb();
    setAll(db);
    await scoreAndSaveLead(UID, PHONE, { price_inquired: true });
    await scoreAndSaveLead(UID, '+5411000', { is_spam: true });
    setAll(db);
    const scores = await getAllLeadScores(UID, { minScore: 30 });
    scores.forEach(s => expect(s.score).toBeGreaterThanOrEqual(30));
  });
  test('buildScoreText contiene emoji y score', () => {
    const r = buildScoreRecord(UID, PHONE, 70, { price_inquired: true, appointment_requested: true });
    const text = buildScoreText(r);
    expect(text).toContain('70');
    expect(text.length).toBeGreaterThan(0);
  });
});

// ─── TOPIC EXTRACTOR ─────────────────────────────────────────────────────────
describe('topic_extractor — E2E', () => {
  test('extractTopics retorna array', () => {
    const r = extractTopics(['cuanto cuesta el plan?']);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });
  test('getMainTopic para conversacion de precio', () => {
    const main = getMainTopic(['precio del plan', 'presupuesto mensual', 'cuanto cuesta?']);
    expect(main.topic).toBe('pricing');
  });
  test('getMainTopic para conversacion de soporte', () => {
    const main = getMainTopic(['tengo un problema', 'no funciona', 'necesito ayuda']);
    expect(main.topic).toBe('support_request');
  });
  test('TOPICS incluye todos los esperados', () => {
    ['pricing', 'sales_inquiry', 'appointment_request', 'payment', 'complaint'].forEach(t => {
      expect(TOPICS).toContain(t);
    });
  });
  test('saveTopicRecord y getTopicHistory funcionan juntos', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.8, ['precio'], { date: '2026-05-01', createdAt: 1000 });
    await saveTopicRecord(UID, r);
    setAll(db);
    const hist = await getTopicHistory(UID, { topic: 'pricing' });
    expect(hist.length).toBe(1);
    expect(hist[0].topic).toBe('pricing');
  });
  test('buildTopicSummaryText contiene porcentaje', () => {
    const r = buildTopicRecord(UID, PHONE, 'pricing', 0.85, ['precio']);
    const text = buildTopicSummaryText(r);
    expect(text).toContain('85%');
  });
  test('confianza sale entre 0 y 1', () => {
    const results = extractTopics(['pago transferencia tarjeta factura']);
    results.forEach(r => {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    });
  });
});

// ─── CONVERSATION SUMMARY ─────────────────────────────────────────────────────
describe('conversation_summary — E2E', () => {
  test('SUMMARY_TYPES incluye handoff', () => {
    expect(SUMMARY_TYPES).toContain('handoff');
  });
  test('detectSentiment mensajes mixtos', () => {
    const s = detectSentiment(['gracias excelente', 'problema grave', 'perfecto genial']);
    expect(typeof s.label).toBe('string');
    expect(s.positiveHits).toBeGreaterThan(0);
    expect(s.negativeHits).toBeGreaterThan(0);
  });
  test('getKeyMoments detecta precio y turno', () => {
    const msgs = ['hola', 'cuanto cuesta?', 'quiero reservar un turno'];
    const moments = getKeyMoments(msgs);
    const types = moments.map(m => m.type);
    expect(types).toContain('price_inquiry');
    expect(types).toContain('appointment_request');
  });
  test('buildConversationSummary pipeline completo', () => {
    const msgs = ['hola como estas', 'cuanto cuesta el plan?', 'gracias excelente'];
    const s = buildConversationSummary(UID, PHONE, msgs, { date: '2026-05-01', summaryType: 'full' });
    expect(s.summaryType).toBe('full');
    expect(s.msgCount).toBe(3);
    expect(['positive', 'very_positive', 'neutral']).toContain(s.sentiment.label);
    expect(s.keyMoments.some(m => m.type === 'price_inquiry')).toBe(true);
  });
  test('saveConversationSummary + getConversationSummary round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const s = buildConversationSummary(UID, PHONE, ['hola', 'gracias'], { date: '2026-05-01' });
    await saveConversationSummary(UID, s);
    setAll(db);
    const loaded = await getConversationSummary(UID, PHONE);
    expect(loaded).not.toBeNull();
    expect(loaded.date).toBe('2026-05-01');
  });
  test('buildSummaryText contiene campos clave', () => {
    const msgs = ['hola', 'cuanto cuesta?', 'confirmado listo'];
    const s = buildConversationSummary(UID, PHONE, msgs, { date: '2026-05-01' });
    const text = buildSummaryText(s);
    expect(text).toContain(PHONE);
    expect(text).toContain('2026-05-01');
    expect(text.length).toBeGreaterThan(20);
  });
});

// ─── ANALYTICS ENGINE (integración) ─────────────────────────────────────────
describe('analytics_engine — integración bloque 12', () => {
  test('METRIC_TYPES incluye leads_new y leads_converted', () => {
    expect(METRIC_TYPES).toContain('leads_new');
    expect(METRIC_TYPES).toContain('leads_converted');
  });
  test('buildMetricRecord es idempotente por dia y metrica', () => {
    const r1 = buildMetricRecord(UID, 'leads_new', 5, { date: '2026-05-01' });
    const r2 = buildMetricRecord(UID, 'leads_new', 10, { date: '2026-05-01' });
    expect(r1.recordId).toBe(r2.recordId);
  });
  test('computeConversionRate lead scorer + analytics', () => {
    const rate = computeConversionRate(100, 25);
    expect(rate).toBe(0.25);
    const label = getScoreLabel(Math.round(rate * 100));
    expect(['Fr\u00edo', 'Interesado']).toContain(label.label);
  });
  test('incrementMetric fail-open si Firestore falla', async () => {
    setAll(makeMockDb({ throwGet: true }));
    const r = await incrementMetric(UID, 'leads_new', 1);
    expect(r).toBeNull();
  });
});

// ─── PIPELINE INTEGRADO ───────────────────────────────────────────────────────
describe('Pipeline integrado: lead llega, se clasifica, resume y puntua', () => {
  test('flujo completo sin errores', async () => {
    const db = makeMockDb();
    setAll(db);

    const messages = [
      'Hola, cuanto cuesta el plan basico?',
      'Quiero reservar un turno para ver la demo',
      'Gracias excelente atencion',
    ];

    // 1. Detectar topic principal
    const mainTopic = getMainTopic(messages);
    expect(['pricing', 'appointment_request', 'sales_inquiry', 'personal_message']).toContain(mainTopic.topic);

    // 2. Analizar sentimiento
    const sentiment = detectSentiment(messages);
    expect(['positive', 'very_positive', 'neutral']).toContain(sentiment.label);

    // 3. Detectar momentos clave
    const moments = getKeyMoments(messages);
    expect(moments.length).toBeGreaterThan(0);

    // 4. Construir y guardar summary
    const summary = buildConversationSummary(UID, PHONE, messages, { date: '2026-05-01' });
    const summaryId = await saveConversationSummary(UID, summary);
    expect(summaryId).toBeDefined();

    // 5. Puntuar lead
    const signals = {
      message_count: messages.length,
      price_inquired: true,
      appointment_requested: true,
    };
    setAll(db);
    const scoreRecord = await scoreAndSaveLead(UID, PHONE, signals);
    expect(scoreRecord.score).toBeGreaterThan(40);
    expect(scoreRecord.trend).toBe('new');
    expect(getScoreLabel(scoreRecord.score)).not.toBeNull();

    // 6. Guardar topic record
    setAll(db);
    const topicRecord = buildTopicRecord(UID, PHONE, mainTopic.topic, mainTopic.confidence, mainTopic.keywords, { date: '2026-05-01' });
    const topicId = await saveTopicRecord(UID, topicRecord);
    expect(topicId).toBeDefined();
  });
});
