'use strict';

/**
 * VI-BACKEND-COVERAGE: emoji_injector.js — 100% branches
 * Funciones puras, sin deps externas.
 */

const {
  injectTripleEmojis,
  injectInBubbleArray,
  inferPeakLevel,
  detectTrailingEmoji,
  countTrailingRepeats,
  TRIPLE_EMOJIS,
  HEXA_EMOJI,
} = require('../core/emoji_injector');

// ── inferPeakLevel ────────────────────────────────────────────────────────────

describe('inferPeakLevel', () => {
  test('null/undefined → none', () => {
    expect(inferPeakLevel(null)).toBe('none');
    expect(inferPeakLevel(undefined)).toBe('none');
    expect(inferPeakLevel('')).toBe('none');
  });

  test('Bienvenid@ → explosive', () => {
    expect(inferPeakLevel('¡Bienvenida al equipo!')).toBe('explosive');
    expect(inferPeakLevel('Bienvenido, ya estás adentro')).toBe('explosive');
    expect(inferPeakLevel('Cuenta confirmada')).toBe('explosive');
  });

  test('3+ exclamaciones → high', () => {
    expect(inferPeakLevel('Qué bueno!!!')).toBe('high');
    expect(inferPeakLevel('¡¡Genial!')).toBe('high');
  });

  test('vocales prolongadas (4+ seguidas con word boundary) → high', () => {
    expect(inferPeakLevel('aaaa increíble')).toBe('high');
    expect(inferPeakLevel('oooo que emocion')).toBe('high');
  });

  test('mayúsculas sostenidas → medium', () => {
    expect(inferPeakLevel('ESTO ES EXCELENTE')).toBe('medium');
  });

  test('texto normal → low', () => {
    expect(inferPeakLevel('hola cómo estás')).toBe('low');
    expect(inferPeakLevel('ok, entendido.')).toBe('low');
  });
});

// ── detectTrailingEmoji ───────────────────────────────────────────────────────

describe('detectTrailingEmoji', () => {
  test('texto vacío → null', () => {
    expect(detectTrailingEmoji('', TRIPLE_EMOJIS)).toBeNull();
    expect(detectTrailingEmoji(null, TRIPLE_EMOJIS)).toBeNull();
  });

  test('termina en emoji elegible → {emoji, position}', () => {
    const r = detectTrailingEmoji('Gracias 🤗', TRIPLE_EMOJIS);
    expect(r).not.toBeNull();
    expect(r.emoji).toBe('🤗');
  });

  test('termina en emoji no elegible → null', () => {
    expect(detectTrailingEmoji('Gracias 😎', TRIPLE_EMOJIS)).toBeNull();
  });

  test('detecta 👍 y 🙏', () => {
    expect(detectTrailingEmoji('Bien 👍', TRIPLE_EMOJIS).emoji).toBe('👍');
    expect(detectTrailingEmoji('Gracias 🙏', TRIPLE_EMOJIS).emoji).toBe('🙏');
  });

  test('whitespace al final ignorado', () => {
    const r = detectTrailingEmoji('Hola 🤗  ', TRIPLE_EMOJIS);
    expect(r).not.toBeNull();
    expect(r.emoji).toBe('🤗');
  });
});

// ── countTrailingRepeats ──────────────────────────────────────────────────────

describe('countTrailingRepeats', () => {
  test('texto o emoji vacío → 0', () => {
    expect(countTrailingRepeats('', '🤗')).toBe(0);
    expect(countTrailingRepeats(null, '🤗')).toBe(0);
    expect(countTrailingRepeats('Hola 🤗', '')).toBe(0);
    expect(countTrailingRepeats('Hola 🤗', null)).toBe(0);
  });

  test('1 repetición', () => {
    expect(countTrailingRepeats('Hola 🤗', '🤗')).toBe(1);
  });

  test('2 repeticiones', () => {
    expect(countTrailingRepeats('Hola 🤗🤗', '🤗')).toBe(2);
  });

  test('3 repeticiones', () => {
    expect(countTrailingRepeats('Hola 🤗🤗🤗', '🤗')).toBe(3);
  });

  test('no termina en emoji → 0', () => {
    expect(countTrailingRepeats('Hola mundo', '🤗')).toBe(0);
  });
});

// ── injectTripleEmojis ────────────────────────────────────────────────────────

describe('injectTripleEmojis', () => {
  test('texto vacío o no-string → return empty', () => {
    expect(injectTripleEmojis('', 'family').applied).toBe(false);
    expect(injectTripleEmojis(null, 'family').text).toBe('');
    expect(injectTripleEmojis(42, 'family').applied).toBe(false);
  });

  test('skipInjection → bypass total', () => {
    const r = injectTripleEmojis('Hola 🤗', 'family', { skipInjection: true });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('skip_requested');
    expect(r.text).toBe('Hola 🤗');
  });

  test('peak none → too_low (caller provee peak)', () => {
    const r = injectTripleEmojis('Hola 🤗', 'family', { peakLevel: 'none' });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('too_low');
  });

  test('peak low → too_low', () => {
    const r = injectTripleEmojis('hola cómo estás 🤗', 'family'); // inferPeakLevel → low
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('peak=low_too_low');
  });

  test('HEXA: chatType=client + onboardingPaga + 🥳 al final (no hexa aún) → amplifica a 6', () => {
    const r = injectTripleEmojis('Bienvenido 🥳', 'client', { peakLevel: 'explosive', isOnboardingPaga: true });
    expect(r.applied).toBe(true);
    expect(r.kind).toBe('hexa');
    expect(r.text.endsWith('🥳🥳🥳🥳🥳🥳')).toBe(true);
  });

  test('HEXA: ya tiene 6×🥳 → no amplifica', () => {
    const r = injectTripleEmojis('Bienvenido ' + '🥳'.repeat(6), 'client', { peakLevel: 'explosive', isOnboardingPaga: true });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('already_hexa');
  });

  test('HEXA: sin 🥳 pero con keyword onboarding → append hexa', () => {
    const r = injectTripleEmojis('¡Bienvenida al equipo!', 'client', { peakLevel: 'explosive', isOnboardingPaga: true });
    expect(r.applied).toBe(true);
    expect(r.kind).toBe('hexa');
    expect(r.text).toContain('🥳🥳🥳🥳🥳🥳');
    expect(r.reason).toBe('hexa_appended_onboarding_kw');
  });

  test('HEXA: client + onboarding pero sin trigger → no_trigger', () => {
    const r = injectTripleEmojis('Todo bien por aquí!', 'client', { peakLevel: 'explosive', isOnboardingPaga: true });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('client_onboarding_no_trigger');
  });

  test('chatType no permitido → not_allowed', () => {
    const r = injectTripleEmojis('Buena suerte! 🤗', 'lead', { peakLevel: 'high' });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('not_allowed');
  });

  test('chatType permitido pero sin emoji elegible al final → no_trailing', () => {
    const r = injectTripleEmojis('Buena suerte!', 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('no_trailing_target_emoji');
  });

  test('ya triple (3×🤗) → already_triple', () => {
    const r = injectTripleEmojis('Gracias 🤗🤗🤗', 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('already_triple_or_more');
  });

  test('peak medium + friend_argentino (no family/ale_pareja) → no_triple', () => {
    const r = injectTripleEmojis('Gracias 🤗', 'friend_argentino', { peakLevel: 'medium' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('peak_medium_friend_no_triple');
  });

  test('peak medium + family → triple', () => {
    const r = injectTripleEmojis('Gracias 🤗', 'family', { peakLevel: 'medium' });
    expect(r.applied).toBe(true);
    expect(r.text).toBe('Gracias 🤗🤗🤗');
  });

  test('peak medium + ale_pareja → triple', () => {
    const r = injectTripleEmojis('Te quiero 🤗', 'ale_pareja', { peakLevel: 'medium' });
    expect(r.applied).toBe(true);
    expect(r.kind).toBe('triple');
  });

  test('1 emoji al final + peak high + family → triplica', () => {
    const r = injectTripleEmojis('Qué bueno!!! 🙏', 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(true);
    expect(r.kind).toBe('triple');
    expect(r.emoji).toBe('🙏');
    expect(r.text.endsWith('🙏🙏🙏')).toBe(true);
  });

  test('2 emojis al final → agrega 1 más para completar triple', () => {
    const r = injectTripleEmojis('Gracias 🤗🤗', 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(true);
    expect(r.text.endsWith('🤗🤗🤗')).toBe(true);
  });

  test('peak inferido desde texto (!!!)', () => {
    const r = injectTripleEmojis('Qué emoción!!! 👍', 'family');
    expect(r.applied).toBe(true);
    expect(r.kind).toBe('triple');
  });
});

// ── injectInBubbleArray ───────────────────────────────────────────────────────

describe('injectInBubbleArray', () => {
  test('no es array o vacío → return parts sin cambio', () => {
    const r1 = injectInBubbleArray(null, 'family');
    expect(r1.applied).toBe(false);
    expect(r1.parts).toEqual([]);

    const r2 = injectInBubbleArray([], 'family');
    expect(r2.applied).toBe(false);
    expect(r2.parts).toEqual([]);
  });

  test('no se aplica en última burbuja → parts sin cambio', () => {
    const parts = ['Parte uno.', 'Parte dos sin emoji.'];
    const r = injectInBubbleArray(parts, 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(false);
    expect(r.parts).toBe(parts);
  });

  test('se aplica en última burbuja → parts[last] modificado', () => {
    const parts = ['Primera parte.', 'Gracias!!! 🤗'];
    const r = injectInBubbleArray(parts, 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(true);
    expect(r.parts[0]).toBe('Primera parte.');
    expect(r.parts[1]).toContain('🤗🤗🤗');
  });

  test('array de 1 elemento → modifica ese único elemento', () => {
    const parts = ['Increíble!!! 🙏'];
    const r = injectInBubbleArray(parts, 'family', { peakLevel: 'high' });
    expect(r.applied).toBe(true);
    expect(r.parts[0]).toContain('🙏🙏🙏');
  });
});
