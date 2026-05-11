'use strict';

/**
 * VI-BACKEND-COVERAGE: core/api_errors.js + ai/dynamic_route.js — 100% branches
 */

// ═════════════════════════════════════════════════════════════════════════════
// core/api_errors.js
// ═════════════════════════════════════════════════════════════════════════════

describe('api_errors — ERROR_CODES + HTTP_STATUS constants', () => {
  const { ERROR_CODES, HTTP_STATUS } = require('../core/api_errors');

  test('ERROR_CODES tiene todos los codes definidos', () => {
    expect(ERROR_CODES.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ERROR_CODES.FORBIDDEN).toBe('FORBIDDEN');
    expect(ERROR_CODES.NOT_FOUND).toBe('NOT_FOUND');
    expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ERROR_CODES.BAD_REQUEST).toBe('BAD_REQUEST');
    expect(ERROR_CODES.CONFLICT).toBe('CONFLICT');
  });

  test('HTTP_STATUS tiene los valores correctos', () => {
    expect(HTTP_STATUS.UNAUTHORIZED).toBe(401);
    expect(HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(HTTP_STATUS.INTERNAL_ERROR).toBe(500);
    expect(HTTP_STATUS.CONFLICT).toBe(409);
  });
});

describe('api_errors — sendApiError', () => {
  let sendApiError;

  function makeRes() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  beforeEach(() => {
    jest.resetModules();
    ({ sendApiError } = require('../core/api_errors'));
  });

  test('code en HTTP_STATUS → status correcto (branch HTTP_STATUS[code] truthy)', () => {
    const res = makeRes();
    sendApiError(res, 'UNAUTHORIZED', 'not logged in');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UNAUTHORIZED', message: 'not logged in' }));
  });

  test('code desconocido → status 500 (branch || 500)', () => {
    const res = makeRes();
    sendApiError(res, 'UNKNOWN_CODE', 'something weird');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('con requestId → incluido en body y log (branch if extra.requestId true)', () => {
    const res = makeRes();
    sendApiError(res, 'NOT_FOUND', 'not found', { requestId: 'req-123' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-123' }));
  });

  test('con details → incluido en body (branch if extra.details true)', () => {
    const res = makeRes();
    sendApiError(res, 'VALIDATION_ERROR', 'bad input', { details: { field: 'email' } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: 'email' } }));
  });

  test('sin extra → body solo tiene error+message (branch requestId false, details false)', () => {
    const res = makeRes();
    sendApiError(res, 'INTERNAL_ERROR', 'oops');
    expect(res.json).toHaveBeenCalledWith({ error: 'INTERNAL_ERROR', message: 'oops' });
    // No requestId, no details
    const callArg = res.json.mock.calls[0][0];
    expect(callArg.requestId).toBeUndefined();
    expect(callArg.details).toBeUndefined();
  });

  test('con requestId → ternario en log usa requestId (branch ternario true)', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();
    sendApiError(res, 'FORBIDDEN', 'access denied', { requestId: 'abc' });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('reqId=abc'));
    spy.mockRestore();
  });

  test('sin requestId → ternario en log omite reqId (branch ternario false)', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = makeRes();
    sendApiError(res, 'FORBIDDEN', 'access denied');
    expect(spy).toHaveBeenCalledWith(expect.not.stringContaining('reqId='));
    spy.mockRestore();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ai/dynamic_route.js
// ═════════════════════════════════════════════════════════════════════════════

const { detectEmotional, detectShortFactual, routeFamilyChat, MODELS, ROUTE_VERSION } = require('../ai/dynamic_route');

describe('detectEmotional — branches', () => {
  test('null body → false (branch !body)', () => {
    expect(detectEmotional(null)).toBe(false);
  });

  test('body no es string → false (branch typeof)', () => {
    expect(detectEmotional(42)).toBe(false);
  });

  test('sin señales emocionales → false (points < 2)', () => {
    expect(detectEmotional('hola como vas')).toBe(false);
  });

  test('2+ keywords emocionales → true (branch kwMatches.length >= 2)', () => {
    expect(detectEmotional('estoy triste y angustiado')).toBe(true);
  });

  test('1 keyword + emoji emocional → true (points = 2)', () => {
    // 'triste' = 1 kw, emoji crying = +1
    expect(detectEmotional('estoy triste 😢')).toBe(true);
  });

  test('body <= 10 chars → no verifica caps ratio (branch body.length > 10 false)', () => {
    // 'TRISTE' = 6 chars, sin keyword valida como tal, points < 2
    expect(detectEmotional('TRISTE')).toBe(false);
  });

  test('caps ratio > 0.3 en mensaje largo → incrementa points', () => {
    // 'SOY TAN TAN TRISTE!!!' — caps altas + keyword + puntuación intensa
    const msg = 'SOY TAN TAN TRISTE!!!';
    expect(detectEmotional(msg)).toBe(true);
  });

  test('puntuación intensa (!!! al final) → points++', () => {
    // keyword + puntuación = 2 points
    expect(detectEmotional('me siento mal!!!')).toBe(true);
  });

  test('FAMILY_WORDS → points++', () => {
    // 'mamá' = +1 family, + 'triste' = +1 kw → 2 points → true
    expect(detectEmotional('mi mamá triste')).toBe(true);
  });

  test('solo family word sin más señales → false (points = 1)', () => {
    expect(detectEmotional('hola mamá')).toBe(false);
  });

  test('emoji emocional ❤️ detectado', () => {
    // ❤️ + keyword
    expect(detectEmotional('te quiero mamá ❤️')).toBe(true);
  });
});

describe('detectShortFactual — branches', () => {
  test('null body → false (branch !body)', () => {
    expect(detectShortFactual(null)).toBe(false);
  });

  test('body no es string → false (branch typeof)', () => {
    expect(detectShortFactual(99)).toBe(false);
  });

  test('trimmed >= 60 chars → false (branch trimmed.length >= 60)', () => {
    const long = 'a'.repeat(60);
    expect(detectShortFactual(long)).toBe(false);
  });

  test('corto + emocional → false (branch detectEmotional true → false)', () => {
    expect(detectShortFactual('triste mal!!!')).toBe(false);
  });

  test('corto + no emocional → true (branch detectEmotional false → true)', () => {
    expect(detectShortFactual('hola')).toBe(true);
  });

  test('exactamente 59 chars no emocionales → true', () => {
    const s = 'abcde '.repeat(9) + 'abc'; // 59 chars
    expect(detectShortFactual(s.substring(0, 59))).toBe(true);
  });
});

describe('routeFamilyChat — R1 a R10', () => {
  test('R1 — broadcast first touch → OPUS', () => {
    const r = routeFamilyChat({ isBroadcastFirstTouch: true });
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R1_broadcast');
    expect(r.sticky_applied).toBe(false);
  });

  test('R2 — emocional T1 → OPUS', () => {
    const r = routeFamilyChat({ isEmotional: true, tier: 'T1' });
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R2_emotional_t1t2');
  });

  test('R2 — emocional T2 → OPUS', () => {
    const r = routeFamilyChat({ isEmotional: true, tier: 'T2' });
    expect(r.rule_matched).toBe('R2_emotional_t1t2');
  });

  test('R3 — emocional T3 → SONNET', () => {
    const r = routeFamilyChat({ isEmotional: true, tier: 'T3' });
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R3_emotional_t3');
  });

  test('R4 — T1 first touch fuera broadcast → OPUS', () => {
    const r = routeFamilyChat({ tier: 'T1', isFirstTouch: true });
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R4_t1_first');
  });

  test('R5 — T1 reencuentro >7d → SONNET', () => {
    const r = routeFamilyChat({ tier: 'T1', isReturningAfterGap: true });
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R5_t1_return');
  });

  test('R6 — short factual → HAIKU', () => {
    const r = routeFamilyChat({ isShortFactual: true });
    expect(r.model).toBe(MODELS.HAIKU);
    expect(r.rule_matched).toBe('R6_short_factual');
  });

  test('R7 — T1 default → SONNET', () => {
    const r = routeFamilyChat({ tier: 'T1' });
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R7_t1_default');
  });

  test('R8 — T2 default → SONNET', () => {
    const r = routeFamilyChat({ tier: 'T2' });
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R8_t2_default');
  });

  test('R9 — T3 default → HAIKU', () => {
    const r = routeFamilyChat({ tier: 'T3' });
    expect(r.model).toBe(MODELS.HAIKU);
    expect(r.rule_matched).toBe('R9_t3_default');
  });

  test('R10 — tier null/invalido → SONNET (branch default)', () => {
    const r = routeFamilyChat({ tier: null });
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R10_default');
  });

  test('signals.now inyectado → usa ese timestamp (branch signals.now ?? Date.now())', () => {
    const fixedNow = 1000000;
    const r = routeFamilyChat({ tier: 'T2', now: fixedNow });
    expect(r.rule_matched).toBe('R8_t2_default');
  });
});

describe('routeFamilyChat — sticky-model branches', () => {
  const baseNow = Date.now();

  test('sticky eligible + no force opus + stickyRank >= recommended → sticky applied', () => {
    // R7 da SONNET, sticky es OPUS → OPUS >= SONNET → sticky aplicado
    const r = routeFamilyChat({
      tier: 'T1',
      now: baseNow,
      currentConversationModel: MODELS.OPUS,
      currentConversationStartedAt: baseNow - 1000, // 1s ago, dentro de 6h
    });
    expect(r.sticky_applied).toBe(true);
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.original_routed_model).toBe(MODELS.SONNET);
  });

  test('sticky eligible + stickyRank < recommendedRank → NO sticky, escalar', () => {
    // R2 da OPUS, sticky es HAIKU → HAIKU < OPUS → escalar a OPUS
    const r = routeFamilyChat({
      isEmotional: true,
      tier: 'T1',
      now: baseNow,
      currentConversationModel: MODELS.HAIKU,
      currentConversationStartedAt: baseNow - 1000,
    });
    // R2 es force opus → sticky NO aplica (forceOpusRules includes R2)
    expect(r.sticky_applied).toBe(false);
    expect(r.model).toBe(MODELS.OPUS);
  });

  test('sticky eligible + forceOpusRules (R1) → sticky ignorado', () => {
    const r = routeFamilyChat({
      isBroadcastFirstTouch: true,
      now: baseNow,
      currentConversationModel: MODELS.HAIKU,
      currentConversationStartedAt: baseNow - 1000,
    });
    expect(r.sticky_applied).toBe(false);
    expect(r.model).toBe(MODELS.OPUS);
  });

  test('sticky window expirada (> 6h) → stickyEligible false → no sticky', () => {
    const r = routeFamilyChat({
      tier: 'T1',
      now: baseNow,
      currentConversationModel: MODELS.OPUS,
      currentConversationStartedAt: baseNow - 7 * 60 * 60 * 1000, // 7h ago
    });
    expect(r.sticky_applied).toBe(false);
  });

  test('sin currentConversationModel → stickyEligible false (branch false)', () => {
    const r = routeFamilyChat({
      tier: 'T1',
      now: baseNow,
      currentConversationStartedAt: baseNow - 1000,
      // no currentConversationModel
    });
    expect(r.sticky_applied).toBe(false);
  });

  test('sin currentConversationStartedAt → stickyEligible false', () => {
    const r = routeFamilyChat({
      tier: 'T1',
      now: baseNow,
      currentConversationModel: MODELS.SONNET,
      // no currentConversationStartedAt
    });
    expect(r.sticky_applied).toBe(false);
  });

  test('sticky = SONNET, recommended = HAIKU → sticky >= recommended → sticky aplicado', () => {
    // R9 da HAIKU para T3, sticky SONNET → SONNET > HAIKU → sticky
    const r = routeFamilyChat({
      tier: 'T3',
      now: baseNow,
      currentConversationModel: MODELS.SONNET,
      currentConversationStartedAt: baseNow - 1000,
    });
    expect(r.sticky_applied).toBe(true);
    expect(r.model).toBe(MODELS.SONNET);
  });

  test('sticky = HAIKU, recommended = SONNET → sticky < recommended → escalar a SONNET', () => {
    // R8 da SONNET para T2, sticky HAIKU → HAIKU < SONNET → escalar
    const r = routeFamilyChat({
      tier: 'T2',
      now: baseNow,
      currentConversationModel: MODELS.HAIKU,
      currentConversationStartedAt: baseNow - 1000,
    });
    expect(r.sticky_applied).toBe(false);
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.original_routed_model).toBeNull();
  });

  test('unknown sticky model → tierRank ?? 1 (Sonnet rank default)', () => {
    // Sticky model desconocido → rank = 1 (Sonnet equiv)
    const r = routeFamilyChat({
      tier: 'T3', // R9 → HAIKU rank=0, sticky rank=1 → sticky>=recommended → apply
      now: baseNow,
      currentConversationModel: 'unknown-model',
      currentConversationStartedAt: baseNow - 1000,
    });
    expect(r.sticky_applied).toBe(true);
    expect(r.model).toBe('unknown-model');
  });
});

describe('ROUTE_VERSION exported', () => {
  test('ROUTE_VERSION tiene valor esperado', () => {
    expect(ROUTE_VERSION).toBe('v1-2026-04-20');
  });
});
