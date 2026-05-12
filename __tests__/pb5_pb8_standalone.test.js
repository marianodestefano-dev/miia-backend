'use strict';

const { cleanStaleConversations } = require('../core/stale_conversations');
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
