'use strict';

const {
  analyzeContact, buildSpamAlertMessage,
  detectKeywords, detectRapidFire, detectIdenticalContent,
  computeSimilarity, isValidSignal,
  SPAM_SIGNALS, SPAM_KEYWORDS,
  ALERT_COOLDOWN_MS, RAPID_FIRE_THRESHOLD, SIMILARITY_THRESHOLD,
  __setFirestoreForTests: setSpamDb,
} = require('../core/contact_spam_detector');

const {
  getPeriodKey, isValidMetric,
  calculateConversionRate, calculateRetentionRate,
  recordGrowthEvent, getGrowthPeriod,
  GROWTH_METRICS, PERIOD_TYPES, DEFAULT_PERIOD,
  __setFirestoreForTests: setGrowthDb,
} = require('../core/growth_tracker');

const {
  buildDispatchRecord, buildDispatchResult, shouldRetry, computeBackoffMs,
  DISPATCH_STATUSES, MAX_RETRY_ATTEMPTS, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS,
} = require('../core/webhook_dispatcher');

const UID = 'uid_t346';
const PHONE = '+5711112222';

function makeDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

describe('T346 -- contact_spam_detector + growth_tracker + webhook_dispatcher (30 tests)', () => {

  // SPAM_SIGNALS / SPAM_KEYWORDS
  test('SPAM_SIGNALS frozen, contiene tipos criticos', () => {
    expect(() => { SPAM_SIGNALS.push('hack'); }).toThrow();
    expect(SPAM_SIGNALS).toContain('repeated_messages');
    expect(SPAM_SIGNALS).toContain('rapid_fire');
    expect(SPAM_SIGNALS).toContain('keyword_match');
  });

  test('SPAM_KEYWORDS frozen, ALERT_COOLDOWN_MS=24h, RAPID_FIRE_THRESHOLD=10, SIMILARITY=0.90', () => {
    expect(() => { SPAM_KEYWORDS.push('hack'); }).toThrow();
    expect(ALERT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(RAPID_FIRE_THRESHOLD).toBe(10);
    expect(SIMILARITY_THRESHOLD).toBe(0.90);
  });

  // isValidSignal
  test('isValidSignal: valid/invalid', () => {
    expect(isValidSignal('rapid_fire')).toBe(true);
    expect(isValidSignal('hack_signal')).toBe(false);
  });

  // detectKeywords
  test('detectKeywords: null/empty -> []', () => {
    expect(detectKeywords(null)).toEqual([]);
    expect(detectKeywords('')).toEqual([]);
  });

  test('detectKeywords: texto sin keywords -> []', () => {
    expect(detectKeywords('hola como estas quiero informacion')).toEqual([]);
  });

  test('detectKeywords: texto con keywords spam -> detectados', () => {
    const r = detectKeywords('ganaste un premio gratis hoy');
    expect(r).toContain('ganaste');
    expect(r).toContain('premio');
    expect(r).toContain('gratis');
  });

  // detectRapidFire
  test('detectRapidFire: array vacio -> false', () => {
    expect(detectRapidFire([])).toBe(false);
  });

  test('detectRapidFire: < RAPID_FIRE_THRESHOLD mensajes -> false', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      text: 'msg', timestamp: new Date(Date.now() - i * 1000).toISOString()
    }));
    expect(detectRapidFire(msgs)).toBe(false);
  });

  // computeSimilarity
  test('computeSimilarity: mismo string -> 1', () => {
    expect(computeSimilarity('hola mundo', 'hola mundo')).toBe(1);
  });

  test('computeSimilarity: vacio/null -> 0', () => {
    expect(computeSimilarity(null, 'texto')).toBe(0);
    expect(computeSimilarity('', 'texto')).toBe(0);
  });

  // detectIdenticalContent
  test('detectIdenticalContent: < 2 mensajes -> false', () => {
    expect(detectIdenticalContent([{ text: 'hola' }])).toBe(false);
  });

  test('detectIdenticalContent: mensajes distintos -> false', () => {
    const msgs = [{ text: 'hola' }, { text: 'comprar algo' }, { text: 'precio?' }];
    expect(detectIdenticalContent(msgs)).toBe(false);
  });

  test('detectIdenticalContent: mensajes identicos -> true', () => {
    const msgs = [{ text: 'PROMO ESPECIAL' }, { text: 'PROMO ESPECIAL' }, { text: 'PROMO ESPECIAL' }];
    expect(detectIdenticalContent(msgs)).toBe(true);
  });

  // analyzeContact
  test('analyzeContact: phone null lanza', () => {
    expect(() => analyzeContact(null, [], {})).toThrow('phone requerido');
  });

  test('analyzeContact: sin flags -> severity low, signals puede estar vacio', () => {
    const r = analyzeContact(PHONE, [], {});
    expect(r).toHaveProperty('severity');
    expect(r).toHaveProperty('signals');
    expect(r.severity).toBe('low');
  });

  test('analyzeContact: texto con keywords -> signals incluye keyword_match', () => {
    const msgs = [{ text: 'ganaste un premio gratis click aqui urgente', timestamp: new Date().toISOString() }];
    const r = analyzeContact(PHONE, msgs, {});
    expect(r.signals).toContain('keyword_match');
  });

  // buildSpamAlertMessage
  test('buildSpamAlertMessage: retorna string con phone y razones', () => {
    const analysis = { severity: 'high', reasons: ['Mensajes identicos', 'Keyword spam'] };
    const msg = buildSpamAlertMessage(PHONE, analysis);
    expect(msg).toContain(PHONE);
    expect(msg).toContain('ALERTA');
    expect(msg).toContain('Mensajes identicos');
  });

  // GROWTH_METRICS / PERIOD_TYPES
  test('GROWTH_METRICS frozen, contiene new_leads/converted_leads/messages_total', () => {
    expect(() => { GROWTH_METRICS.push('hack'); }).toThrow();
    expect(GROWTH_METRICS).toContain('new_leads');
    expect(GROWTH_METRICS).toContain('converted_leads');
    expect(GROWTH_METRICS).toContain('messages_total');
    expect(DEFAULT_PERIOD).toBe('weekly');
  });

  test('PERIOD_TYPES frozen: daily/weekly/monthly', () => {
    expect(() => { PERIOD_TYPES.push('yearly'); }).toThrow();
    expect(PERIOD_TYPES).toContain('daily');
    expect(PERIOD_TYPES).toContain('weekly');
    expect(PERIOD_TYPES).toContain('monthly');
  });

  test('isValidMetric: valid/invalid', () => {
    expect(isValidMetric('new_leads')).toBe(true);
    expect(isValidMetric('hack_metric')).toBe(false);
  });

  test('getPeriodKey: periodType invalido lanza, daily -> YYYY-MM-DD, monthly -> YYYY-MM', () => {
    expect(() => getPeriodKey('yearly')).toThrow('periodType invalido');
    const daily = getPeriodKey('daily', '2026-05-01T12:00:00Z');
    expect(daily).toBe('2026-05-01');
    const monthly = getPeriodKey('monthly', '2026-05-01T12:00:00Z');
    expect(monthly).toBe('2026-05');
  });

  test('calculateConversionRate: 0 leads -> 0, 100 leads 25 converted -> 25.0', () => {
    expect(calculateConversionRate(0, 0)).toBe(0);
    expect(calculateConversionRate(100, 25)).toBe(25.0);
  });

  test('calculateConversionRate: newLeads invalido lanza', () => {
    expect(() => calculateConversionRate(-1, 0)).toThrow('newLeads invalido');
    expect(() => calculateConversionRate('abc', 0)).toThrow('newLeads invalido');
  });

  test('calculateRetentionRate: totalContacts<=0 lanza, 100/75 -> 75.0', () => {
    expect(() => calculateRetentionRate(0, 0)).toThrow('totalContacts invalido');
    expect(calculateRetentionRate(100, 75)).toBe(75.0);
  });

  test('recordGrowthEvent: uid null lanza, metric invalida lanza', async () => {
    await expect(recordGrowthEvent(null, 'new_leads')).rejects.toThrow('uid requerido');
    await expect(recordGrowthEvent(UID, 'hack_metric')).rejects.toThrow('metric invalida');
  });

  test('getGrowthPeriod: uid null lanza, no doc -> {period, metrics:{}}', async () => {
    await expect(getGrowthPeriod(null)).rejects.toThrow('uid requerido');
    setGrowthDb(makeDb());
    const r = await getGrowthPeriod(UID, 'daily', '2026-05-01');
    expect(r.metrics).toBeDefined();
  });

  // webhook_dispatcher
  test('DISPATCH_STATUSES frozen, MAX_RETRY_ATTEMPTS=3, INITIAL_BACKOFF_MS=1000', () => {
    expect(() => { DISPATCH_STATUSES.push('hack'); }).toThrow();
    expect(DISPATCH_STATUSES).toContain('pending');
    expect(DISPATCH_STATUSES).toContain('success');
    expect(DISPATCH_STATUSES).toContain('failed');
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
    expect(INITIAL_BACKOFF_MS).toBe(1000);
  });

  test('computeBackoffMs: attempt 0=1000, 1=2000, 2=4000, capped at MAX_BACKOFF_MS', () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(10)).toBe(MAX_BACKOFF_MS); // capped
  });

  test('buildDispatchRecord: genera dispatchId, status=pending, attempts=0', () => {
    const r = buildDispatchRecord('int_001', 'evt_abc123', {
      webhookUrl: 'https://example.com/hook',
      payload: { event: 'lead.created' },
    });
    expect(r.dispatchId).toContain('int_001');
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);
    expect(r.maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(r.webhookUrl).toBe('https://example.com/hook');
    expect(r.payload.event).toBe('lead.created');
  });

  test('buildDispatchResult: ok=true con statusCode/body, ok=false con errorMsg', () => {
    const ok = buildDispatchResult(true, 200, '{"status":"ok"}', null);
    expect(ok.ok).toBe(true);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('{"status":"ok"}');

    const fail = buildDispatchResult(false, null, null, 'Connection refused');
    expect(fail.ok).toBe(false);
    expect(fail.errorMsg).toBe('Connection refused');
  });

  test('shouldRetry: null->false, success->false, exhausted->false, attempts<max->true', () => {
    expect(shouldRetry(null)).toBe(false);
    expect(shouldRetry({ status: 'success', attempts: 0, maxAttempts: 3 })).toBe(false);
    expect(shouldRetry({ status: 'exhausted', attempts: 3, maxAttempts: 3 })).toBe(false);
    expect(shouldRetry({ status: 'failed', attempts: 2, maxAttempts: 3 })).toBe(true);
    expect(shouldRetry({ status: 'pending', attempts: 0, maxAttempts: 3 })).toBe(true);
  });
});
