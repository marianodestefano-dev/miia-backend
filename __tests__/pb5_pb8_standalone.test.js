'use strict';

const { cleanStaleConversations, _toTimestamp } = require('../core/stale_conversations');
const dm = require('../core/daily_metrics');
const { generateWeeklySummary, isMondayMorningCOT } = require('../core/weekly_summary');
const { getFallbackMessage, shouldUseFallback, FALLBACK_MESSAGES } = require('../core/gemini_prompt_fallback');

describe('PB.5 cleanStaleConversations', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());
  const MS = 30 * 24 * 60 * 60 * 1000;

  test('3 convs, 1 stale: solo la stale se elimina', () => {
    const now = Date.now();
    const c = {
      a: { lastActivity: now - MS - 1 },
      b: { lastActivity: now - MS + 60000 },
      c: { lastActivity: now - 1000 },
    };
    expect(cleanStaleConversations(c)).toBe(1);
    expect(c.a).toBeUndefined();
    expect(c.b).toBeDefined();
    expect(c.c).toBeDefined();
  });

  test('vacio: 0 eliminados', () => {
    expect(cleanStaleConversations({})).toBe(0);
  });

  test('todas stale: todas eliminadas', () => {
    const old = Date.now() - (60 * 24 * 60 * 60 * 1000);
    const c = { a: { lastActivity: old }, b: { lastActivity: old } };
    expect(cleanStaleConversations(c)).toBe(2);
    expect(Object.keys(c)).toHaveLength(0);
  });

  test('olderThanDays=7: solo >7d se elimina', () => {
    const now = Date.now();
    const c = {
      fresh: { lastActivity: now - 5 * 24 * 60 * 60 * 1000 },
      old:   { lastActivity: now - 8 * 24 * 60 * 60 * 1000 },
    };
    expect(cleanStaleConversations(c, 7)).toBe(1);
    expect(c.fresh).toBeDefined();
    expect(c.old).toBeUndefined();
  });

  test('sin lastActivity ni updatedAt: se elimina (ts=0)', () => {
    const c = { orphan: { messages: [] } };
    expect(cleanStaleConversations(c)).toBe(1);
  });
});

describe('PB.6 daily_metrics', () => {
  let mockSet, mockGet, mockDoc;
  beforeEach(() => {
    mockSet = jest.fn().mockResolvedValue(undefined);
    mockGet = jest.fn();
    mockDoc = jest.fn().mockReturnValue({ set: mockSet, get: mockGet });
    const mc = jest.fn().mockReturnValue({ doc: mockDoc });
    const md = jest.fn().mockReturnValue({ collection: mc });
    const mo = jest.fn().mockReturnValue({ doc: md });
    dm.__setFirestoreForTests({ collection: mo });
    dm.__setAdminForTests({ firestore: { FieldValue: { increment: (n) => ({ __op: 'inc', n }) } } });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { dm.__setFirestoreForTests(null); dm.__setAdminForTests(null); jest.restoreAllMocks(); });

  test('incrementMetric valid → set con merge:true', async () => {
    const ok = await dm.incrementMetric('u1', 'messages_received');
    expect(ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ messages_received: { __op: 'inc', n: 1 } }),
      { merge: true }
    );
  });

  test('incrementMetric campo invalido → false', async () => {
    expect(await dm.incrementMetric('u1', 'bad_field')).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });

  test('incrementMetric uid null → false', async () => {
    expect(await dm.incrementMetric(null, 'messages_sent')).toBe(false);
  });

  test('incrementMetric amount=3', async () => {
    await dm.incrementMetric('u1', 'gemini_calls', 3);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ gemini_calls: { __op: 'inc', n: 3 } }),
      { merge: true }
    );
  });

  test('getDailyMetrics doc existe', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ messages_received: 5 }) });
    expect(await dm.getDailyMetrics('u1', '2026-05-12')).toEqual({ messages_received: 5 });
  });

  test('getDailyMetrics doc no existe → null', async () => {
    mockGet.mockResolvedValue({ exists: false });
    expect(await dm.getDailyMetrics('u1', '2026-05-12')).toBeNull();
  });

  test('getTodayDateKey formato YYYY-MM-DD', () => {
    expect(dm.getTodayDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('VALID_FIELDS tiene 7 campos', () => {
    expect(dm.VALID_FIELDS).toHaveLength(7);
  });
});

describe('PB.7 weekly_summary', () => {
  test('metrics array → totales correctos', () => {
    const m = [
      { messages_received: 10, messages_sent: 8, leads_new: 2, leads_responded: 1, gemini_errors: 0, wa_reconnects: 0 },
      { messages_received: 5,  messages_sent: 4, leads_new: 1, leads_responded: 1, gemini_errors: 0, wa_reconnects: 0 },
    ];
    const { text, totals } = generateWeeklySummary(m);
    expect(totals.messages_received).toBe(15);
    expect(totals.leads_new).toBe(3);
    expect(text).toContain('15');
    expect(text).toContain('Resumen semanal');
  });

  test('array vacio → sin actividad', () => {
    expect(generateWeeklySummary([]).text).toContain('Sin actividad');
  });

  test('null → sin actividad', () => {
    expect(generateWeeklySummary(null).text).toContain('Sin actividad');
  });

  test('gemini_errors > 0 → aparece en texto', () => {
    expect(generateWeeklySummary([{ gemini_errors: 5 }]).text).toContain('Errores IA: 5');
  });

  test('gemini_errors = 0 → no aparece', () => {
    expect(generateWeeklySummary([{ gemini_errors: 0 }]).text).not.toContain('Errores IA');
  });

  test('isMondayMorningCOT: lunes 9am COT → true', () => {
    expect(isMondayMorningCOT(new Date('2026-05-11T14:00:00Z'))).toBe(true);
  });

  test('isMondayMorningCOT: martes → false', () => {
    expect(isMondayMorningCOT(new Date('2026-05-12T14:00:00Z'))).toBe(false);
  });

  test('isMondayMorningCOT: lunes 8am COT → false', () => {
    expect(isMondayMorningCOT(new Date('2026-05-11T13:00:00Z'))).toBe(false);
  });
});

describe('PB.8 gemini_prompt_fallback', () => {
  test('chatType lead → mensaje lead', () => {
    expect(getFallbackMessage('lead')).toBe(FALLBACK_MESSAGES.lead);
  });
  test('chatType client', () => {
    expect(getFallbackMessage('client')).toBe(FALLBACK_MESSAGES.client);
  });
  test('chatType desconocido → default', () => {
    expect(getFallbackMessage('unknown')).toBe(FALLBACK_MESSAGES.default);
  });
  test('chatType miia_lead', () => {
    expect(getFallbackMessage('miia_lead')).toBe(FALLBACK_MESSAGES.miia_lead);
  });
  test('shouldUseFallback timeout → true', () => {
    expect(shouldUseFallback(new Error('Gemini timeout after 45s'))).toBe(true);
  });
  test('shouldUseFallback 503 → true', () => {
    expect(shouldUseFallback(new Error('Gemini API error: 503'))).toBe(true);
  });
  test('shouldUseFallback 429 → true', () => {
    expect(shouldUseFallback(new Error('Gemini API error: 429'))).toBe(true);
  });
  test('shouldUseFallback ECONNREFUSED → false', () => {
    expect(shouldUseFallback(new Error('ECONNREFUSED'))).toBe(false);
  });
  test('shouldUseFallback null → false', () => {
    expect(shouldUseFallback(null)).toBe(false);
  });
  test('FALLBACK_MESSAGES >= 4 tipos', () => {
    expect(Object.keys(FALLBACK_MESSAGES).length).toBeGreaterThanOrEqual(4);
  });
});

// ── COV: branch gaps PB.5-PB.8 ───────────────────────────────────────────────

describe('PB.5 stale_conversations branch gaps', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('_toTimestamp: Date object (instanceof Date branch)', () => {
    // Use updatedAt as a Date object so _toTimestamp hits the instanceof Date branch
    const now = Date.now();
    const dateObj = new Date(now - 60 * 24 * 60 * 60 * 1000); // 60 days ago → stale
    const c = { x: { updatedAt: dateObj } };
    expect(cleanStaleConversations(c)).toBe(1);
  });

  test('_toTimestamp: string date (truthy string branch)', () => {
    // lastActivity as ISO string
    const now = Date.now();
    const recentStr = new Date(now - 1000).toISOString(); // 1s ago → not stale
    const oldStr = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40d ago → stale
    const c = { fresh: { lastActivity: recentStr }, stale: { lastActivity: oldStr } };
    expect(cleanStaleConversations(c)).toBe(1);
    expect(c.stale).toBeUndefined();
    expect(c.fresh).toBeDefined();
  });

  test('_toTimestamp: null lastActivity (falsy → 0 branch)', () => {
    // Explicit null lastActivity and no updatedAt
    const c = { x: { lastActivity: null, updatedAt: null } };
    // null || null || 0 → _toTimestamp(0) = 0 → ts < cutoff → removed
    expect(cleanStaleConversations(c)).toBe(1);
  });
});

describe('PB.6 daily_metrics error branch', () => {
  afterEach(() => { const dm2 = require('../core/daily_metrics'); dm2.__setFirestoreForTests(null); dm2.__setAdminForTests(null); jest.restoreAllMocks(); });

  test('incrementMetric Firestore throws → false', async () => {
    const dm2 = require('../core/daily_metrics');
    const mockSet = jest.fn().mockRejectedValue(new Error('Firestore down'));
    const mockDoc = jest.fn().mockReturnValue({ set: mockSet });
    const mc = jest.fn().mockReturnValue({ doc: mockDoc });
    const md = jest.fn().mockReturnValue({ collection: mc });
    const mo = jest.fn().mockReturnValue({ doc: md });
    dm2.__setFirestoreForTests({ collection: mo });
    dm2.__setAdminForTests({ firestore: { FieldValue: { increment: (n) => n } } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await dm2.incrementMetric('u1', 'messages_received');
    expect(result).toBe(false);
  });
});

describe('PB.7 weekly_summary wa_reconnects branch', () => {
  test('wa_reconnects > 0 → aparece en texto', () => {
    const { text } = generateWeeklySummary([{ wa_reconnects: 3 }]);
    expect(text).toContain('Reconexiones WA: 3');
  });

  test('isMondayMorningCOT: domingo 23:59 UTC → lunes 18:59 COT → false', () => {
    // Sunday 23:59 UTC → COT = 18:59, still Sunday (cotDay=0) → false
    expect(isMondayMorningCOT(new Date('2026-05-10T23:59:00Z'))).toBe(false);
  });

  test('isMondayMorningCOT: lunes 03:00 UTC → lunes -2 COT (domingo 22:00 COT) → false', () => {
    // Monday 03:00 UTC → cotHour = 3-5 = -2 → +24=22, cotDay = (1-1+7)%7 = 0 (Sunday) → false
    expect(isMondayMorningCOT(new Date('2026-05-11T03:00:00Z'))).toBe(false);
  });
});

describe('PB.8 shouldUseFallback: string error branch', () => {
  test('error es string con timeout → true', () => {
    // error.message is undefined when error is a plain string
    expect(shouldUseFallback('timeout exceeded')).toBe(true);
  });

  test('error es string sin keyword → false', () => {
    expect(shouldUseFallback('ECONNRESET')).toBe(false);
  });

  test('getFallbackMessage: follow_up_cold', () => {
    const { getFallbackMessage: gfm, FALLBACK_MESSAGES: fm } = require('../core/gemini_prompt_fallback');
    expect(gfm('follow_up_cold')).toBe(fm.follow_up_cold);
  });
});


describe('PB.5 _toTimestamp: falsy branch (line 13)', () => {
  test('_toTimestamp(null) => 0 (falsy branch)', () => {
    expect(_toTimestamp(null)).toBe(0);
  });
  test('_toTimestamp(undefined) => 0 (falsy branch)', () => {
    expect(_toTimestamp(undefined)).toBe(0);
  });
  test('_toTimestamp(false) => 0 (falsy branch)', () => {
    expect(_toTimestamp(false)).toBe(0);
  });
});

describe('PB.6 getDailyMetrics branch gaps', () => {
  let mockGet;
  beforeEach(() => {
    const dm3 = require('../core/daily_metrics');
    mockGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ messages_received: 1 }) });
    const mockDoc2 = jest.fn().mockReturnValue({ set: jest.fn(), get: mockGet });
    const mc2 = jest.fn().mockReturnValue({ doc: mockDoc2 });
    const md2 = jest.fn().mockReturnValue({ collection: mc2 });
    const mo2 = jest.fn().mockReturnValue({ doc: md2 });
    dm3.__setFirestoreForTests({ collection: mo2 });
    dm3.__setAdminForTests({ firestore: { FieldValue: { increment: (n) => n } } });
  });
  afterEach(() => {
    const dm3 = require('../core/daily_metrics');
    dm3.__setFirestoreForTests(null);
    dm3.__setAdminForTests(null);
  });

  test('getDailyMetrics uid null => null', async () => {
    const dm3 = require('../core/daily_metrics');
    expect(await dm3.getDailyMetrics(null)).toBeNull();
  });

  test('getDailyMetrics sin dateKey => usa hoy', async () => {
    const dm3 = require('../core/daily_metrics');
    const result = await dm3.getDailyMetrics('u1'); // no dateKey
    expect(result).not.toBeNull();
  });
});

describe('PB.7 isMondayMorningCOT sin argumento', () => {
  test('isMondayMorningCOT() sin argumento => no lanza error', () => {
    // Calls with no arg => uses new Date() internally
    expect(typeof isMondayMorningCOT()).toBe('boolean');
  });
});


describe('PB.5 stale_conversations: null entry branch (line 26)', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('conversations[phone] = null => data defaults to {} => ts=0 => stale', () => {
    // conversations[phone] || {} hits the falsy branch
    const c = { orphan: null };
    expect(cleanStaleConversations(c)).toBe(1);
    expect(c.orphan).toBeUndefined();
  });
});


describe('PB.6 getTodayDateKey con argumento (branch line 27)', () => {
  test('getTodayDateKey con fecha especifica => formato correcto', () => {
    const dm4 = require('../core/daily_metrics');
    // Pass specific date: 2026-01-15
    const specific = new Date('2026-01-15T12:00:00Z').getTime();
    const key = dm4.getTodayDateKey(specific);
    expect(key).toBe('2026-01-15');
  });
});
