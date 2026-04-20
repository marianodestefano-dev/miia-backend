'use strict';

/**
 * DYNAMIC ROUTE — FAMILY_CHAT v1
 *
 * Decide qué modelo Claude usar para cada turno FAMILY_CHAT según señales
 * del runtime. Determinístico (if/else versionado), cero latencia, cero costo.
 *
 * Diseño completo: docs/DYNAMIC_ROUTE_DESIGN.md (Fase A de C-321).
 * Firma: C-323 (Wi → Vi, 2026-04-20 noche tardía).
 *
 * Estado: módulo standalone. NO integrado al flow real hasta firma post-BLIND.
 * ai_gateway.js sigue intacto.
 *
 * Slots de modelo parametrizables vía env para permitir benchmark con
 * Opus 4.6 (config actual) o 4.7 (latest público) sin cambiar código.
 */

// ═══════════════════════════════════════════════════════════════════
// MODELOS (slots parametrizables)
// ═══════════════════════════════════════════════════════════════════

const MODELS = {
  OPUS: process.env.DYNAMIC_ROUTE_OPUS || 'claude-opus-4-6',
  SONNET: process.env.DYNAMIC_ROUTE_SONNET || 'claude-sonnet-4-6',
  HAIKU: process.env.DYNAMIC_ROUTE_HAIKU || 'claude-haiku-4-5'
};

const ROUTE_VERSION = 'v1-2026-04-20';

// Sticky-model window: misma conversación si gap <6h entre turnos (Q1 C-323).
const STICKY_WINDOW_MS = 6 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════
// DETECTOR EMOCIONAL (determinístico, 5 puntos, umbral ≥2)
// ═══════════════════════════════════════════════════════════════════

const EMOTIONAL_KEYWORDS = /\b(triste|mal|saturad[ao]|angustiad[ao]|preocupad[ao]|no puedo m[aá]s|no aguanto|extra[ñn]o|te necesito|perd[oó]n|miedo|sol[ao]|ansios[ao]|llor|muri[oó]|falleci[oó]|deprimid[ao]|feliz de|gracias por todo|re contenta?|emocionad[ao])\b/i;

const EMOTIONAL_EMOJIS = /[\u{1F622}\u{1F62D}\u{1F614}\u{1F97A}\u{2764}\u{1F494}\u{1F64F}\u{1F630}\u{1F61E}\u{1F62A}\u{1F499}]/u;

// Lookbehind/lookahead manual: \b falla alrededor de chars no-ASCII como "á".
const FAMILY_WORDS = /(?<![\wáéíóúñÁÉÍÓÚÑ])(mam[áa]|pap[áa]|hij[ao]|pareja|esposo|esposa|novi[ao]|abuel[ao]|herman[ao])(?![\wáéíóúñÁÉÍÓÚÑ])/i;

function detectEmotional(body) {
  if (!body || typeof body !== 'string') return false;
  let points = 0;
  // Keywords: contar matches múltiples (2+ keywords emocionales = 2 puntos directo)
  const kwGlobal = new RegExp(EMOTIONAL_KEYWORDS.source, 'gi');
  const kwMatches = body.match(kwGlobal);
  if (kwMatches) points += Math.min(kwMatches.length, 2);
  if (EMOTIONAL_EMOJIS.test(body)) points++;
  // Caps ratio solo si mensaje tiene longitud mínima (evita falsos positivos en "OK" o "SÍ")
  if (body.length > 10) {
    const caps = body.match(/[A-ZÁÉÍÓÚÑ]/g);
    if (caps && caps.length / body.length > 0.3) points++;
  }
  // Puntuación intensa al final: !!!, ???, ...!
  if (/([!?.]){2,}$/.test(body.trim())) points++;
  if (FAMILY_WORDS.test(body)) points++;
  return points >= 2;
}

function detectShortFactual(body) {
  if (!body || typeof body !== 'string') return false;
  const trimmed = body.trim();
  if (trimmed.length >= 60) return false;
  // Emocional gana sobre factual corto (matiz siempre prioritario sobre brevedad)
  if (detectEmotional(trimmed)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// CLASIFICADOR PRINCIPAL — 10 reglas top-down
// ═══════════════════════════════════════════════════════════════════

/**
 * Decide modelo para FAMILY_CHAT según señales.
 *
 * @param {Object} signals
 * @param {'T1'|'T2'|'T3'|null} signals.tier - Tanda del contacto (contact_index.tanda).
 * @param {boolean} signals.isBroadcastFirstTouch - Loop T-G + primer touch histórico.
 * @param {boolean} signals.isFirstTouch - Sin historial previo (fuera de broadcast).
 * @param {boolean} signals.isReturningAfterGap - Último turno >7 días.
 * @param {boolean} signals.isEmotional - detectEmotional(body) aplicado.
 * @param {boolean} signals.isShortFactual - detectShortFactual(body) aplicado.
 * @param {number} [signals.historyDepth] - Turnos previos con ese contacto.
 * @param {string|null} [signals.currentConversationModel] - Modelo en uso en conversación activa.
 * @param {number|null} [signals.currentConversationStartedAt] - Timestamp (ms) inicio de conversación activa.
 * @param {number} [signals.now] - Timestamp (ms) actual (inyectable para tests).
 * @returns {{model: string, rule_matched: string, sticky_applied: boolean, original_routed_model: string|null}}
 */
function routeFamilyChat(signals) {
  const now = signals.now ?? Date.now();

  const regularDecision = applyRules(signals);

  // Sticky-model: si hay conversación activa (<6h), respetar modelo previo
  // salvo que R1 (broadcast) o R2 (emocional T1/T2) disparen, que fuerzan Opus.
  const stickyEligible =
    signals.currentConversationModel &&
    signals.currentConversationStartedAt &&
    (now - signals.currentConversationStartedAt) < STICKY_WINDOW_MS;

  const forceOpusRules = new Set(['R1_broadcast', 'R2_emotional_t1t2']);

  if (stickyEligible && !forceOpusRules.has(regularDecision.rule_matched)) {
    // Solo aplicar sticky si el modelo sticky NO es peor que el recomendado.
    // "Peor" aquí = usar Haiku cuando la regla pide Sonnet+. Evita que un turno
    // emocional se degrade a Haiku por sticky previo.
    const tierRank = { [MODELS.HAIKU]: 0, [MODELS.SONNET]: 1, [MODELS.OPUS]: 2 };
    const stickyRank = tierRank[signals.currentConversationModel] ?? 1;
    const recommendedRank = tierRank[regularDecision.model] ?? 1;

    if (stickyRank >= recommendedRank) {
      return {
        model: signals.currentConversationModel,
        rule_matched: regularDecision.rule_matched,
        sticky_applied: true,
        original_routed_model: regularDecision.model
      };
    }
    // Si el sticky es peor que lo recomendado (ej: sticky=Haiku y ahora emocional T1),
    // escalar al recomendado. Voz coherente importa más que costo en momentos fuertes.
  }

  return {
    model: regularDecision.model,
    rule_matched: regularDecision.rule_matched,
    sticky_applied: false,
    original_routed_model: null
  };
}

function applyRules(signals) {
  // R1 — broadcast T-G primer touch
  if (signals.isBroadcastFirstTouch) {
    return { model: MODELS.OPUS, rule_matched: 'R1_broadcast' };
  }
  // R2 — emocional T1/T2
  if (signals.isEmotional && (signals.tier === 'T1' || signals.tier === 'T2')) {
    return { model: MODELS.OPUS, rule_matched: 'R2_emotional_t1t2' };
  }
  // R3 — emocional T3
  if (signals.isEmotional && signals.tier === 'T3') {
    return { model: MODELS.SONNET, rule_matched: 'R3_emotional_t3' };
  }
  // R4 — T1 first touch fuera de broadcast
  if (signals.tier === 'T1' && signals.isFirstTouch) {
    return { model: MODELS.OPUS, rule_matched: 'R4_t1_first' };
  }
  // R5 — T1 reencuentro >7 días
  if (signals.tier === 'T1' && signals.isReturningAfterGap) {
    return { model: MODELS.SONNET, rule_matched: 'R5_t1_return' };
  }
  // R6 — short factual cualquier tier
  if (signals.isShortFactual) {
    return { model: MODELS.HAIKU, rule_matched: 'R6_short_factual' };
  }
  // R7/R8/R9 — tier defaults
  if (signals.tier === 'T1') return { model: MODELS.SONNET, rule_matched: 'R7_t1_default' };
  if (signals.tier === 'T2') return { model: MODELS.SONNET, rule_matched: 'R8_t2_default' };
  if (signals.tier === 'T3') return { model: MODELS.HAIKU, rule_matched: 'R9_t3_default' };
  // R10 — tier inválido/null → Sonnet seguro (guard R-07 del doc)
  return { model: MODELS.SONNET, rule_matched: 'R10_default' };
}

module.exports = {
  routeFamilyChat,
  detectEmotional,
  detectShortFactual,
  ROUTE_VERSION,
  MODELS,
  STICKY_WINDOW_MS
};
