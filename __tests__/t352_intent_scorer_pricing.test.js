'use strict';

const {
  classifyIntent, classifyBatch,
  INTENTS, CONFIDENCE,
} = require('../core/intent_classifier');

const {
  computeLeadScore, buildScoreRecord, computeScoreTrend,
  getScoreLabel, SCORE_LABELS, SCORING_SIGNALS, MAX_SCORE, MIN_SCORE,
  saveLeadScore, getLeadScore,
  __setFirestoreForTests: setScorerDb,
} = require('../core/lead_scorer');

const {
  getPlanPrice, comparePlans, recommendPlan,
  isValidPlan, isValidCurrency, getCurrencyForCountry,
  invalidateCache, loadPricingFromFirestore,
  SUPPORTED_CURRENCIES, DEFAULT_PLANS, PLAN_NAMES, CACHE_TTL_MS,
  __setFirestoreForTests: setPricingDb,
} = require('../core/dynamic_pricing_engine');

const UID = 'uid_t352';
const PHONE = '+5713334444';

function makeScorerDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
          }),
          get: async () => {
            const prefix = `${col}/${uid}/${subCol}/`;
            const docs = Object.entries(store)
              .filter(([k]) => k.startsWith(prefix))
              .map(([, v]) => ({ data: () => v }));
            return { docs, forEach: (fn) => docs.forEach(fn) };
          },
        }),
      }),
    }),
  };
}

function makePricingDb(plans = {}) {
  const entries = Object.entries(plans);
  return {
    collection: () => ({
      get: async () => ({
        forEach: (fn) => entries.forEach(([id, data]) => fn({ id, data: () => data })),
      }),
      doc: (id) => ({
        set: async () => {},
      }),
    }),
  };
}

describe('T352 -- intent_classifier + lead_scorer + dynamic_pricing_engine (32 tests)', () => {

  // ── INTENT CLASSIFIER ────────────────────────────────────────────────────────

  test('INTENTS frozen, contiene los 7 intents esperados', () => {
    expect(() => { INTENTS.push('hack'); }).toThrow();
    expect(INTENTS).toContain('booking');
    expect(INTENTS).toContain('price');
    expect(INTENTS).toContain('complaint');
    expect(INTENTS).toContain('info');
    expect(INTENTS).toContain('greeting');
    expect(INTENTS).toContain('farewell');
    expect(INTENTS).toContain('unknown');
    expect(INTENTS.length).toBe(7);
  });

  test('CONFIDENCE frozen con HIGH=0.9, MEDIUM=0.7, LOW=0.5', () => {
    expect(() => { CONFIDENCE.hack = 1; }).toThrow();
    expect(CONFIDENCE.HIGH).toBe(0.9);
    expect(CONFIDENCE.MEDIUM).toBe(0.7);
    expect(CONFIDENCE.LOW).toBe(0.5);
  });

  test('classifyIntent: null -> { intent: unknown, confidence: 0 }', () => {
    const r = classifyIntent(null);
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(0);
    expect(r.signals).toEqual([]);
  });

  test('classifyIntent: "hola" -> greeting, confidence HIGH', () => {
    const r = classifyIntent('hola');
    expect(r.intent).toBe('greeting');
    expect(r.confidence).toBe(CONFIDENCE.HIGH);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  test('classifyIntent: "quiero reservar un turno" -> booking', () => {
    const r = classifyIntent('quiero reservar un turno');
    expect(r.intent).toBe('booking');
    expect(r.confidence).toBe(CONFIDENCE.HIGH);
  });

  test('classifyIntent: "cuanto cuesta el servicio" -> price', () => {
    const r = classifyIntent('cuanto cuesta el servicio');
    expect(r.intent).toBe('price');
  });

  test('classifyIntent: "queja por mal servicio" -> complaint (prioridad sobre otros)', () => {
    const r = classifyIntent('queja por mal servicio, tambien cuanto cuesta?');
    expect(r.intent).toBe('complaint');
    expect(r.confidence).toBe(CONFIDENCE.MEDIUM); // multiple matches
  });

  test('classifyIntent: texto sin patron -> unknown, confidence LOW', () => {
    const r = classifyIntent('xyzabc 12345');
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBe(CONFIDENCE.LOW);
  });

  test('classifyBatch: array vacio -> { dominant: unknown, results: [] }', () => {
    const r = classifyBatch([]);
    expect(r.dominant).toBe('unknown');
    expect(r.results).toEqual([]);
  });

  test('classifyBatch: mayoria greeting -> dominant=greeting', () => {
    const r = classifyBatch(['hola', 'hola buenas', 'cuanto cuesta']);
    expect(r.dominant).toBe('greeting');
    expect(r.results.length).toBe(3);
  });

  // ── LEAD SCORER ─────────────────────────────────────────────────────────────

  test('SCORE_LABELS frozen, contiene spam/cold/warm/hot/ready', () => {
    expect(() => { SCORE_LABELS.hack = {}; }).toThrow();
    expect(SCORE_LABELS.spam).toBeDefined();
    expect(SCORE_LABELS.cold).toBeDefined();
    expect(SCORE_LABELS.warm).toBeDefined();
    expect(SCORE_LABELS.hot).toBeDefined();
    expect(SCORE_LABELS.ready).toBeDefined();
  });

  test('SCORING_SIGNALS frozen, contiene 10 señales esperadas', () => {
    expect(() => { SCORING_SIGNALS.hack = 'x'; }).toThrow();
    expect(SCORING_SIGNALS).toContain('message_count');
    expect(SCORING_SIGNALS).toContain('price_inquired');
    expect(SCORING_SIGNALS).toContain('appointment_requested');
    expect(SCORING_SIGNALS.length).toBe(10);
  });

  test('MAX_SCORE=100, MIN_SCORE=0', () => {
    expect(MAX_SCORE).toBe(100);
    expect(MIN_SCORE).toBe(0);
  });

  test('getScoreLabel: 0=spam, 20=cold, 50=warm, 75=hot, 90=ready', () => {
    expect(getScoreLabel(0).label).toBe('Spam/Bot');
    expect(getScoreLabel(20).label).toBe('Frío');
    expect(getScoreLabel(50).label).toBe('Interesado');
    expect(getScoreLabel(75).label).toBe('Caliente');
    expect(getScoreLabel(90).label).toBe('Listo para cerrar');
  });

  test('getScoreLabel: non-number -> null', () => {
    expect(getScoreLabel('abc')).toBeNull();
    expect(getScoreLabel(null)).toBeNull();
  });

  test('computeLeadScore: sin señales -> 10 (base)', () => {
    expect(computeLeadScore({})).toBe(10);
  });

  test('computeLeadScore: price_inquired + appointment_requested -> 50', () => {
    const score = computeLeadScore({ price_inquired: true, appointment_requested: true });
    expect(score).toBe(50); // 10 + 20 + 20
  });

  test('computeLeadScore: is_spam -> override a 5', () => {
    const score = computeLeadScore({ is_spam: true, appointment_requested: true });
    expect(score).toBe(5);
  });

  test('computeLeadScore: objection_raised resta 10', () => {
    const score = computeLeadScore({ objection_raised: true });
    expect(score).toBe(0); // 10 - 10 = 0 (clamped at 0)
  });

  test('buildScoreRecord: uid null lanza', () => {
    expect(() => buildScoreRecord(null, PHONE, 50, {}, {})).toThrow('uid requerido');
  });

  test('buildScoreRecord: phone null lanza', () => {
    expect(() => buildScoreRecord(UID, null, 50, {}, {})).toThrow('phone requerido');
  });

  test('buildScoreRecord: score valido retorna record completo', () => {
    const rec = buildScoreRecord(UID, PHONE, 75, { price_inquired: true }, {});
    expect(rec.uid).toBe(UID);
    expect(rec.phone).toBe(PHONE);
    expect(rec.score).toBe(75);
    expect(rec.label).toBe('Caliente');
    expect(rec.category).toBe('hot');
    expect(rec.scoredAt).toBeDefined();
  });

  test('computeScoreTrend: previousScore no-numero -> new', () => {
    expect(computeScoreTrend(50, undefined)).toBe('new');
    expect(computeScoreTrend(50, null)).toBe('new');
  });

  test('computeScoreTrend: diff > 10 -> rising, < -10 -> falling, else stable', () => {
    expect(computeScoreTrend(80, 60)).toBe('rising');
    expect(computeScoreTrend(40, 60)).toBe('falling');
    expect(computeScoreTrend(60, 55)).toBe('stable');
  });

  // ── DYNAMIC PRICING ENGINE ───────────────────────────────────────────────────

  test('SUPPORTED_CURRENCIES frozen, contiene USD/ARS/COP/MXN/CLP/PEN/BRL', () => {
    expect(() => { SUPPORTED_CURRENCIES.push('X'); }).toThrow();
    expect(SUPPORTED_CURRENCIES).toContain('USD');
    expect(SUPPORTED_CURRENCIES).toContain('ARS');
    expect(SUPPORTED_CURRENCIES).toContain('COP');
    expect(SUPPORTED_CURRENCIES.length).toBe(7);
  });

  test('PLAN_NAMES frozen, contiene free/starter/pro/enterprise', () => {
    expect(() => { PLAN_NAMES.push('x'); }).toThrow();
    expect(PLAN_NAMES).toContain('free');
    expect(PLAN_NAMES).toContain('starter');
    expect(PLAN_NAMES).toContain('pro');
    expect(PLAN_NAMES).toContain('enterprise');
    expect(PLAN_NAMES.length).toBe(4);
  });

  test('DEFAULT_PLANS frozen, free.priceUSD=0, enterprise.priceUSD=149', () => {
    expect(() => { DEFAULT_PLANS.hack = {}; }).toThrow();
    expect(DEFAULT_PLANS.free.priceUSD).toBe(0);
    expect(DEFAULT_PLANS.starter.priceUSD).toBe(19);
    expect(DEFAULT_PLANS.pro.priceUSD).toBe(49);
    expect(DEFAULT_PLANS.enterprise.priceUSD).toBe(149);
  });

  test('isValidPlan: free=true, hack=false', () => {
    expect(isValidPlan('free')).toBe(true);
    expect(isValidPlan('pro')).toBe(true);
    expect(isValidPlan('hack')).toBe(false);
    expect(isValidPlan(null)).toBe(false);
  });

  test('isValidCurrency: USD=true, XYZ=false', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('ARS')).toBe(true);
    expect(isValidCurrency('XYZ')).toBe(false);
  });

  test('getCurrencyForCountry: AR=ARS, CO=COP, US=USD, DEFAULT=USD', () => {
    expect(getCurrencyForCountry('AR')).toBe('ARS');
    expect(getCurrencyForCountry('CO')).toBe('COP');
    expect(getCurrencyForCountry('US')).toBe('USD');
    expect(getCurrencyForCountry('ZZ')).toBe('USD'); // fallback DEFAULT
  });

  test('comparePlans: starter vs pro -> upgradeRecommended=true, priceDiffUSD=30', () => {
    const r = comparePlans('starter', 'pro');
    expect(r.upgradeRecommended).toBe(true);
    expect(r.priceDiffUSD).toBe(30); // 49 - 19
    expect(r.messagesDiff).toBeGreaterThan(0);
  });

  test('comparePlans: plan invalido -> null', () => {
    expect(comparePlans('free', 'invalid_plan')).toBeNull();
    expect(comparePlans('invalid_plan', 'pro')).toBeNull();
  });

  test('recommendPlan: null -> free', () => {
    expect(recommendPlan(null)).toBe('free');
    expect(recommendPlan({ avgMessagesPerDay: 0, totalContacts: 0 })).toBe('free');
  });

  test('recommendPlan: daily 600 -> pro, daily 6000 -> enterprise', () => {
    expect(recommendPlan({ avgMessagesPerDay: 600, totalContacts: 100 })).toBe('pro');
    expect(recommendPlan({ avgMessagesPerDay: 6000, totalContacts: 100 })).toBe('enterprise');
  });

  test('getPlanPrice: plan invalido lanza', async () => {
    invalidateCache();
    setPricingDb(makePricingDb({}));
    await expect(getPlanPrice('invalid_plan', 'AR')).rejects.toThrow('plan invalido');
  });

  test('getPlanPrice: free, AR -> priceUSD=0, currency=ARS', async () => {
    invalidateCache();
    setPricingDb(makePricingDb({})); // empty -> falls back to DEFAULT_PLANS
    const result = await getPlanPrice('free', 'AR');
    expect(result.plan).toBe('free');
    expect(result.priceUSD).toBe(0);
    expect(result.currency).toBe('ARS');
  });
});
