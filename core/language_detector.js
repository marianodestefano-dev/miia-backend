'use strict';

/**
 * MIIA — Language Detector (T129)
 * Detecta idioma de un mensaje (es/en/pt) con score de confianza.
 * Usa diccionarios de tokens frecuentes por idioma.
 */

const LANG_TOKENS = Object.freeze({
  es: new Set([
    'hola','buenos','gracias','por','que','como','para','con','una','los',
    'las','del','este','esta','esto','quiero','puedo','tiene','tengo','hacer',
    'donde','cuando','cuanto','cual','todo','algo','bien','muy','tambien','pero',
    'si','no','ya','mas','hay','ser','estar','tener','me','te','le','se','su',
    'mi','tu','el','ella','nosotros','ellos','vamos','favor','necesito','informacion',
  ]),
  en: new Set([
    'hello','hi','thanks','thank','you','the','and','for','with','that',
    'this','what','how','when','where','which','have','has','can','could',
    'would','should','will','want','need','good','great','please','more','also',
    'but','yes','no','already','there','some','any','get','got','i','we','they',
    'my','your','our','it','is','are','was','were','do','does','did','be','been',
  ]),
  pt: new Set([
    'ola','bom','dia','tarde','noite','obrigado','obrigada','por','que','como',
    'para','com','uma','os','as','do','da','este','esta','isso','quero','posso',
    'tem','tenho','fazer','onde','quando','quanto','qual','tudo','algo','bem',
    'muito','tambem','mas','sim','nao','ja','mais','ha','voce','eu','nos','eles',
    'meu','seu','nosso','preciso','informacao','favor',
  ]),
});

const SUPPORTED_LANGS = Object.freeze(Object.keys(LANG_TOKENS));
const MIN_TOKENS_FOR_DETECTION = 2;

/**
 * Tokeniza un texto en palabras lowercase normalizadas.
 */
function tokenize(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

/**
 * Detecta el idioma de un texto.
 * @param {string} text
 * @returns {{ lang: string|null, confidence: number, scores: object }}
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { lang: null, confidence: 0, scores: {} };
  }

  const tokens = tokenize(text);
  if (tokens.length < MIN_TOKENS_FOR_DETECTION) {
    return { lang: null, confidence: 0, scores: {} };
  }

  const scores = {};
  for (const [lang, dict] of Object.entries(LANG_TOKENS)) {
    const matches = tokens.filter(t => dict.has(t)).length;
    scores[lang] = matches / tokens.length;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topLang, topScore] = sorted[0];
  const [, secondScore] = sorted[1] || [null, 0];

  if (topScore === 0) {
    return { lang: null, confidence: 0, scores };
  }

  // Confianza: diferencia entre el mejor y el segundo
  const confidence = Math.min(1, topScore + (topScore - secondScore));
  return { lang: topLang, confidence: parseFloat(confidence.toFixed(3)), scores };
}

/**
 * Detecta idioma de múltiples textos y retorna el dominante.
 */
function detectDominantLanguage(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return { lang: null, confidence: 0 };
  const counts = {};
  for (const t of texts) {
    const { lang } = detectLanguage(t);
    if (lang) counts[lang] = (counts[lang] || 0) + 1;
  }
  if (Object.keys(counts).length === 0) return { lang: null, confidence: 0 };
  const [dominant] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const confidence = counts[dominant] / texts.length;
  return { lang: dominant, confidence: parseFloat(confidence.toFixed(3)) };
}

module.exports = { detectLanguage, detectDominantLanguage, tokenize, LANG_TOKENS, SUPPORTED_LANGS };
