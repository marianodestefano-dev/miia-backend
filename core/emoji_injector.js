/**
 * emoji_injector.js — Inyector conservador de triple emoji + hexa onboarding (C-386 A.3)
 *
 * Reglas (voice_seed §1.4 + §3.3):
 *
 * §1.4 "Mariano TRIPLICA emojis para enfatizar peak emocional":
 *   🤗🤗🤗 cierre cálido extremo
 *   🙏🙏🙏 súplica
 *   🥳🥳🥳🥳🥳🥳 celebración máxima onboarding (hexa, hasta 6x — Karolina)
 *   👍👍👍 ACK extra-positivo
 *
 *   "No abusa: la triple aparece ~15 veces en muestra de 150 contactos.
 *   Es PEAK, NO DEFAULT."
 *
 * §3.3 plantilla bienvenida post-pago:
 *   "🥳🥳🥳🥳🥳🥳" (hexa solo en onboarding cliente nuevo)
 *
 * Política conservadora (Vi C-386 A.3):
 *
 *   1. Solo triplica si EL TEXTO CANDIDATO YA contiene UN emoji elegible
 *      en posición de cierre (al final del último mensaje significativo).
 *
 *   2. Solo aplica si chatType ∈ {family, friend_argentino, friend_colombiano, ale_pareja}
 *      O si chatType === 'client' Y emotionalContext.isOnboardingPaga === true (hexa 🥳).
 *
 *   3. NUNCA triplica emojis con leads/follow_up_cold/medilink_team/owner_selfchat
 *      (preserva profesionalidad / formalidad).
 *
 *   4. NUNCA triplica un emoji que ya esté triplicado o más (idempotencia).
 *
 *   5. Hexa 🥳×6: SOLO si chatType === 'client' Y emotionalContext.isOnboardingPaga === true
 *      Y el texto YA contiene 🥳 al final O contiene "Bienvenid@" o "Cuenta confirmada".
 *
 *   6. Si emotionalContext.peakLevel === 'low' o 'none' → NO triplica nada (devuelve text intacto).
 *
 * Esta función NO genera emojis nuevos — solo amplifica los que la IA ya emitió.
 * Razón: si la IA no eligió un emoji, no es nuestra labor inyectarlo (cae fuera del DNA).
 */

'use strict';

// Emojis elegibles para triple según §1.4 (lista cerrada)
const TRIPLE_EMOJIS = ['🤗', '🙏', '👍'];
const HEXA_EMOJI = '🥳';

// chatTypes que permiten triple emoji
const ALLOW_TRIPLE = new Set([
  'family', 'friend_argentino', 'friend_colombiano', 'ale_pareja'
]);

// chatType + flag onboarding habilita hexa 🥳
const ALLOW_HEXA_CLIENT = 'client';

// Niveles peak — controlados por el caller (mode_detectors o heurística previa)
const PEAK_LEVELS = ['none', 'low', 'medium', 'high', 'explosive'];

/**
 * Detecta si el último char visible (ignorando whitespace) del texto es un emoji target.
 * @returns {{emoji: string, position: number}|null}
 */
function detectTrailingEmoji(text, candidates) {
  if (!text) return null;
  const trimmed = text.replace(/\s+$/, '');
  for (const e of candidates) {
    if (trimmed.endsWith(e)) {
      return { emoji: e, position: trimmed.length - e.length };
    }
  }
  return null;
}

/**
 * Cuenta cuántas veces seguidas aparece `emoji` en posición de cierre.
 */
function countTrailingRepeats(text, emoji) {
  if (!text || !emoji) return 0;
  const trimmed = text.replace(/\s+$/, '');
  let count = 0;
  let pos = trimmed.length;
  while (pos >= emoji.length && trimmed.slice(pos - emoji.length, pos) === emoji) {
    count++;
    pos -= emoji.length;
  }
  return count;
}

/**
 * Heurística para inferir peak level a partir del texto si el caller no lo provee.
 * - Múltiples !!! / ??? / vocales prolongadas (aaaa, iiii) → high
 * - MAYÚSCULAS sostenidas → high
 * - Onboarding keywords (Bienvenid@, Cuenta confirmada, ¡Listo!) → explosive
 * - Default → low
 */
function inferPeakLevel(text) {
  if (!text) return 'none';
  if (/Bienvenid[@oa]|Cuenta confirmada/i.test(text)) return 'explosive';
  if (/!{3,}|¡{2,}/.test(text)) return 'high';
  if (/\b[aeiou]{4,}\b/i.test(text)) return 'high'; // vocales prolongadas
  if (text.length > 0 && text.replace(/[^A-Z]/g, '').length / text.replace(/[^A-Za-z]/g, '').length > 0.5) return 'medium';
  return 'low';
}

/**
 * Aplica replace en la última ocurrencia (no en todas).
 */
function replaceLast(text, search, replacement) {
  const idx = text.lastIndexOf(search);
  if (idx === -1) return text;
  return text.slice(0, idx) + replacement + text.slice(idx + search.length);
}

/**
 * injectTripleEmojis — punto de entrada principal.
 *
 * @param {string} text — mensaje candidato (post-IA, pre-envío)
 * @param {string} chatType — chatType V2 resuelto
 * @param {object} [emotionalContext]
 * @param {('none'|'low'|'medium'|'high'|'explosive')} [emotionalContext.peakLevel]
 * @param {boolean} [emotionalContext.isOnboardingPaga] — habilita hexa 🥳 con client
 * @param {boolean} [emotionalContext.skipInjection] — bypass total (debug / testing)
 * @returns {{text: string, applied: boolean, kind: 'none'|'triple'|'hexa', emoji: string|null, reason: string}}
 */
function injectTripleEmojis(text, chatType, emotionalContext = {}) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', applied: false, kind: 'none', emoji: null, reason: 'empty_input' };
  }

  if (emotionalContext.skipInjection) {
    return { text, applied: false, kind: 'none', emoji: null, reason: 'skip_requested' };
  }

  // Determinar peak level (caller > inferencia)
  const peak = emotionalContext.peakLevel || inferPeakLevel(text);
  if (peak === 'none' || peak === 'low') {
    return { text, applied: false, kind: 'none', emoji: null, reason: `peak=${peak}_too_low` };
  }

  // CASO 1: HEXA 🥳 — onboarding cliente post-pago
  if (chatType === ALLOW_HEXA_CLIENT && emotionalContext.isOnboardingPaga === true) {
    const trailingHexa = detectTrailingEmoji(text, [HEXA_EMOJI]);
    const hasOnboardingKw = /Bienvenid[@oa]|Cuenta confirmada/i.test(text);

    if (trailingHexa) {
      // Ya termina en 🥳 — amplificar a hexa si no lo está ya
      const repeats = countTrailingRepeats(text, HEXA_EMOJI);
      if (repeats >= 6) {
        return { text, applied: false, kind: 'hexa', emoji: HEXA_EMOJI, reason: 'already_hexa' };
      }
      const additional = HEXA_EMOJI.repeat(6 - repeats);
      return {
        text: text + additional,
        applied: true,
        kind: 'hexa',
        emoji: HEXA_EMOJI,
        reason: `hexa_amplified_from_${repeats}_to_6`
      };
    }

    if (hasOnboardingKw) {
      // No tiene 🥳 al cierre pero es onboarding clarísimo → agregar línea final con hexa
      return {
        text: text.replace(/\s*$/, '') + '\n\n' + HEXA_EMOJI.repeat(6),
        applied: true,
        kind: 'hexa',
        emoji: HEXA_EMOJI,
        reason: 'hexa_appended_onboarding_kw'
      };
    }

    // chatType client + onboarding pero sin trigger detectable → no inyecta
    return { text, applied: false, kind: 'none', emoji: null, reason: 'client_onboarding_no_trigger' };
  }

  // CASO 2: TRIPLE 🤗🤗🤗 / 🙏🙏🙏 / 👍👍👍 — solo en chatTypes afectivos
  if (!ALLOW_TRIPLE.has(chatType)) {
    return { text, applied: false, kind: 'none', emoji: null, reason: `chattype_${chatType}_not_allowed` };
  }

  // Detectar emoji elegible en posición de cierre
  const trailing = detectTrailingEmoji(text, TRIPLE_EMOJIS);
  if (!trailing) {
    return { text, applied: false, kind: 'none', emoji: null, reason: 'no_trailing_target_emoji' };
  }

  const repeats = countTrailingRepeats(text, trailing.emoji);
  if (repeats >= 3) {
    return { text, applied: false, kind: 'triple', emoji: trailing.emoji, reason: 'already_triple_or_more' };
  }

  // Peak medium permite triplicar 🤗 solo si chatType es muy afectivo (family/ale)
  if (peak === 'medium' && !(chatType === 'family' || chatType === 'ale_pareja')) {
    return { text, applied: false, kind: 'none', emoji: trailing.emoji, reason: 'peak_medium_friend_no_triple' };
  }

  // Triplica añadiendo (3 - repeats) instancias adicionales del emoji al final
  const additional = trailing.emoji.repeat(3 - repeats);
  return {
    text: text + additional,
    applied: true,
    kind: 'triple',
    emoji: trailing.emoji,
    reason: `triple_amplified_from_${repeats}_to_3_peak_${peak}_chattype_${chatType}`
  };
}

/**
 * Versión por-burbuja: aplica injectTripleEmojis a cada parte del array, devolviendo
 * el array transformado. Solo amplifica la ÚLTIMA burbuja (es el cierre real del mensaje).
 *
 * @param {string[]} parts — burbujas ya splitteadas
 * @param {string} chatType
 * @param {object} [emotionalContext]
 * @returns {{parts: string[], applied: boolean, details: object|null}}
 */
function injectInBubbleArray(parts, chatType, emotionalContext = {}) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { parts: parts || [], applied: false, details: null };
  }
  const lastIdx = parts.length - 1;
  const result = injectTripleEmojis(parts[lastIdx], chatType, emotionalContext);
  if (!result.applied) {
    return { parts, applied: false, details: result };
  }
  const newParts = parts.slice();
  newParts[lastIdx] = result.text;
  return { parts: newParts, applied: true, details: result };
}

module.exports = {
  injectTripleEmojis,
  injectInBubbleArray,
  inferPeakLevel,
  TRIPLE_EMOJIS,
  HEXA_EMOJI,
  ALLOW_TRIPLE,
  // helpers
  detectTrailingEmoji,
  countTrailingRepeats
};
