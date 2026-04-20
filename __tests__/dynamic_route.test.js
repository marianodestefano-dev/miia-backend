'use strict';

/**
 * DYNAMIC ROUTE TESTS — clasificador FAMILY_CHAT
 *
 * Cubre las 10 reglas R1-R10 + sticky-model + detectEmotional + detectShortFactual
 * + guard R-07 (tier inválido → R10 default Sonnet).
 *
 * Firma: C-323 (Wi → Vi). Diseño: docs/DYNAMIC_ROUTE_DESIGN.md.
 */

const {
  routeFamilyChat,
  detectEmotional,
  detectShortFactual,
  ROUTE_VERSION,
  MODELS,
  STICKY_WINDOW_MS
} = require('../ai/dynamic_route');

const baseSignals = () => ({
  tier: 'T1',
  isBroadcastFirstTouch: false,
  isFirstTouch: false,
  isReturningAfterGap: false,
  isEmotional: false,
  isShortFactual: false,
  isOwnerPresence: false,
  historyDepth: 5,
  currentConversationModel: null,
  currentConversationStartedAt: null,
  now: Date.now()
});

// ═══════════════════════════════════════════════════════════════
// detectEmotional — 5 puntos, umbral ≥2
// ═══════════════════════════════════════════════════════════════

describe('detectEmotional', () => {
  test('keyword sola no alcanza (1 punto, umbral 2)', () => {
    expect(detectEmotional('estoy mal')).toBe(false);
  });
  test('keyword + emoji → true (2 puntos)', () => {
    expect(detectEmotional('estoy triste 😢')).toBe(true);
  });
  test('keyword + familia → true (2 puntos)', () => {
    expect(detectEmotional('mi mamá está preocupada')).toBe(true);
  });
  test('caps ratio >30% + keyword → true', () => {
    expect(detectEmotional('ESTOY MUY MAL NO AGUANTO')).toBe(true);
  });
  test('mensaje neutral sin señales → false', () => {
    expect(detectEmotional('pasame el link por favor')).toBe(false);
  });
  test('emoji emocional + puntuación intensa → true', () => {
    expect(detectEmotional('no puedo más!!!')).toBe(true);
  });
  test('string vacío → false sin crash', () => {
    expect(detectEmotional('')).toBe(false);
    expect(detectEmotional(null)).toBe(false);
    expect(detectEmotional(undefined)).toBe(false);
  });
  test('caso Wi del doc §1: "Hoy me fue re mal, estoy saturada" → true', () => {
    expect(detectEmotional('Hoy me fue re mal, estoy saturada')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// detectShortFactual
// ═══════════════════════════════════════════════════════════════

describe('detectShortFactual', () => {
  test('pregunta factual corta → true', () => {
    expect(detectShortFactual('a qué hora es la reunión?')).toBe(true);
  });
  test('pregunta factual corta con cuándo → true', () => {
    expect(detectShortFactual('cuándo llega?')).toBe(true);
  });
  test('mensaje largo (≥60 chars) → false', () => {
    expect(detectShortFactual('Necesito que me pases el link de la reunión de mañana temprano por favor')).toBe(false);
  });
  test('preguntas cortas no-emocionales → true', () => {
    expect(detectShortFactual('cómo andás?')).toBe(true);
    expect(detectShortFactual('y vos?')).toBe(true);
  });
  test('emocional aunque corto → false (emocional gana)', () => {
    expect(detectShortFactual('estoy triste 😢')).toBe(false);
  });
  test('afirmación factual corta → true', () => {
    expect(detectShortFactual('ok listo')).toBe(true);
  });
  test('caso Wi del doc §1: "Pasame el mail..." (57 chars factual) → true', () => {
    expect(detectShortFactual('Pasame el mail de soporte y el link de la página por favor')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Reglas R1-R10
// ═══════════════════════════════════════════════════════════════

describe('routeFamilyChat — reglas R1-R10', () => {
  test('R1 — broadcast first touch → Opus', () => {
    const s = { ...baseSignals(), isBroadcastFirstTouch: true, tier: 'T1' };
    const r = routeFamilyChat(s);
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R1_broadcast');
  });
  test('R1 gana sobre todo lo demás (incluso emocional T3)', () => {
    const s = { ...baseSignals(), isBroadcastFirstTouch: true, tier: 'T3', isEmotional: true };
    expect(routeFamilyChat(s).rule_matched).toBe('R1_broadcast');
  });
  test('R2 — emocional T1 → Opus', () => {
    const s = { ...baseSignals(), isEmotional: true, tier: 'T1' };
    const r = routeFamilyChat(s);
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R2_emotional_t1t2');
  });
  test('R2 — emocional T2 → Opus', () => {
    const s = { ...baseSignals(), isEmotional: true, tier: 'T2' };
    expect(routeFamilyChat(s).model).toBe(MODELS.OPUS);
  });
  test('R3 — emocional T3 → Sonnet (no Opus)', () => {
    const s = { ...baseSignals(), isEmotional: true, tier: 'T3' };
    const r = routeFamilyChat(s);
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R3_emotional_t3');
  });
  test('R4 — T1 first touch (fuera de broadcast) → Opus', () => {
    const s = { ...baseSignals(), isFirstTouch: true, tier: 'T1' };
    const r = routeFamilyChat(s);
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R4_t1_first');
  });
  test('R4 NO aplica a T2/T3 first_touch', () => {
    const sT2 = { ...baseSignals(), isFirstTouch: true, tier: 'T2' };
    expect(routeFamilyChat(sT2).rule_matched).toBe('R8_t2_default');
    const sT3 = { ...baseSignals(), isFirstTouch: true, tier: 'T3' };
    expect(routeFamilyChat(sT3).rule_matched).toBe('R9_t3_default');
  });
  test('R5 — T1 returning after gap → Sonnet', () => {
    const s = { ...baseSignals(), isReturningAfterGap: true, tier: 'T1' };
    const r = routeFamilyChat(s);
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.rule_matched).toBe('R5_t1_return');
  });
  test('R6 — short factual T1 → Haiku (no Sonnet T1 default)', () => {
    const s = { ...baseSignals(), isShortFactual: true, tier: 'T1' };
    const r = routeFamilyChat(s);
    expect(r.model).toBe(MODELS.HAIKU);
    expect(r.rule_matched).toBe('R6_short_factual');
  });
  test('R7 — T1 sin señales especiales → Sonnet', () => {
    const s = { ...baseSignals(), tier: 'T1' };
    expect(routeFamilyChat(s).rule_matched).toBe('R7_t1_default');
  });
  test('R8 — T2 sin señales especiales → Sonnet', () => {
    const s = { ...baseSignals(), tier: 'T2' };
    expect(routeFamilyChat(s).rule_matched).toBe('R8_t2_default');
  });
  test('R9 — T3 sin señales especiales → Haiku', () => {
    const s = { ...baseSignals(), tier: 'T3' };
    expect(routeFamilyChat(s).rule_matched).toBe('R9_t3_default');
  });
  test('R10 — tier null → Sonnet default (guard R-07 del doc)', () => {
    const s = { ...baseSignals(), tier: null };
    expect(routeFamilyChat(s).rule_matched).toBe('R10_default');
  });
  test('R10 — tier inválido "TX" → Sonnet default', () => {
    const s = { ...baseSignals(), tier: 'TX' };
    expect(routeFamilyChat(s).rule_matched).toBe('R10_default');
  });
});

// ═══════════════════════════════════════════════════════════════
// Sticky-model (Q1 C-323, ventana 6h)
// ═══════════════════════════════════════════════════════════════

describe('sticky-model 6h window', () => {
  test('conversación activa <6h respeta modelo previo', () => {
    const now = 1000000000;
    const s = {
      ...baseSignals(),
      tier: 'T1',
      currentConversationModel: MODELS.OPUS,
      currentConversationStartedAt: now - 2 * 60 * 60 * 1000, // 2h atrás
      now
    };
    const r = routeFamilyChat(s);
    expect(r.sticky_applied).toBe(true);
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.original_routed_model).toBe(MODELS.SONNET); // R7 habría elegido Sonnet
    expect(r.rule_matched).toBe('R7_t1_default');
  });
  test('conversación >6h re-evalúa (sticky expira)', () => {
    const now = 1000000000;
    const s = {
      ...baseSignals(),
      tier: 'T1',
      currentConversationModel: MODELS.OPUS,
      currentConversationStartedAt: now - 7 * 60 * 60 * 1000, // 7h atrás
      now
    };
    const r = routeFamilyChat(s);
    expect(r.sticky_applied).toBe(false);
    expect(r.model).toBe(MODELS.SONNET);
    expect(r.original_routed_model).toBe(null);
  });
  test('R1 broadcast OVERRIDE sticky (fuerza Opus aunque sticky=Haiku)', () => {
    const now = 1000000000;
    const s = {
      ...baseSignals(),
      isBroadcastFirstTouch: true,
      tier: 'T1',
      currentConversationModel: MODELS.HAIKU,
      currentConversationStartedAt: now - 1 * 60 * 60 * 1000,
      now
    };
    const r = routeFamilyChat(s);
    expect(r.sticky_applied).toBe(false);
    expect(r.model).toBe(MODELS.OPUS);
    expect(r.rule_matched).toBe('R1_broadcast');
  });
  test('R2 emocional OVERRIDE sticky Haiku → escala a Opus', () => {
    const now = 1000000000;
    const s = {
      ...baseSignals(),
      isEmotional: true,
      tier: 'T1',
      currentConversationModel: MODELS.HAIKU,
      currentConversationStartedAt: now - 30 * 60 * 1000,
      now
    };
    const r = routeFamilyChat(s);
    expect(r.sticky_applied).toBe(false);
    expect(r.model).toBe(MODELS.OPUS);
  });
  test('sticky Opus NO degrada a Haiku aunque turno actual sea short_factual', () => {
    const now = 1000000000;
    const s = {
      ...baseSignals(),
      isShortFactual: true,
      tier: 'T1',
      currentConversationModel: MODELS.OPUS,
      currentConversationStartedAt: now - 1 * 60 * 60 * 1000,
      now
    };
    const r = routeFamilyChat(s);
    expect(r.sticky_applied).toBe(true);
    expect(r.model).toBe(MODELS.OPUS); // no degrada
    expect(r.original_routed_model).toBe(MODELS.HAIKU); // lo que habría elegido
    expect(r.rule_matched).toBe('R6_short_factual');
  });
  test('sin currentConversationModel, sticky no aplica', () => {
    const s = { ...baseSignals(), tier: 'T1', currentConversationModel: null };
    const r = routeFamilyChat(s);
    expect(r.sticky_applied).toBe(false);
  });
  test('sticky justo en el límite (6h exactas) NO aplica', () => {
    const now = 1000000000;
    const s = {
      ...baseSignals(),
      tier: 'T1',
      currentConversationModel: MODELS.OPUS,
      currentConversationStartedAt: now - STICKY_WINDOW_MS, // exactamente 6h
      now
    };
    expect(routeFamilyChat(s).sticky_applied).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Invariantes
// ═══════════════════════════════════════════════════════════════

describe('invariantes', () => {
  test('ROUTE_VERSION tiene formato v1-YYYY-MM-DD', () => {
    expect(ROUTE_VERSION).toMatch(/^v\d+-\d{4}-\d{2}-\d{2}$/);
  });
  test('MODELS contiene las 3 slots', () => {
    expect(MODELS.OPUS).toBeTruthy();
    expect(MODELS.SONNET).toBeTruthy();
    expect(MODELS.HAIKU).toBeTruthy();
  });
  test('routeFamilyChat siempre devuelve un modelo válido (nunca undefined)', () => {
    const casos = [
      { ...baseSignals(), tier: null },
      { ...baseSignals(), tier: undefined },
      { ...baseSignals(), tier: 'T9' },
      baseSignals()
    ];
    casos.forEach(c => {
      const r = routeFamilyChat(c);
      expect(r.model).toBeTruthy();
      expect([MODELS.OPUS, MODELS.SONNET, MODELS.HAIKU]).toContain(r.model);
      expect(r.rule_matched).toMatch(/^R\d+_/);
    });
  });
  test('cada regla R1-R10 existe como rule_matched posible', () => {
    // Construye casos para cada regla y verifica
    const casos = [
      [{ ...baseSignals(), isBroadcastFirstTouch: true }, 'R1_broadcast'],
      [{ ...baseSignals(), isEmotional: true, tier: 'T1' }, 'R2_emotional_t1t2'],
      [{ ...baseSignals(), isEmotional: true, tier: 'T3' }, 'R3_emotional_t3'],
      [{ ...baseSignals(), isFirstTouch: true, tier: 'T1' }, 'R4_t1_first'],
      [{ ...baseSignals(), isReturningAfterGap: true, tier: 'T1' }, 'R5_t1_return'],
      [{ ...baseSignals(), isShortFactual: true, tier: 'T1' }, 'R6_short_factual'],
      [{ ...baseSignals(), tier: 'T1' }, 'R7_t1_default'],
      [{ ...baseSignals(), tier: 'T2' }, 'R8_t2_default'],
      [{ ...baseSignals(), tier: 'T3' }, 'R9_t3_default'],
      [{ ...baseSignals(), tier: null }, 'R10_default']
    ];
    casos.forEach(([s, expected]) => {
      expect(routeFamilyChat(s).rule_matched).toBe(expected);
    });
  });
});
