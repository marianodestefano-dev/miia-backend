'use strict';

/**
 * MMC — Detector heuristico de idioma + tonada regional (spec 13 v0.3
 * seccion "Idioma y tonada regional" + Q9 afinada).
 *
 * Default: español neutro. Tonadas v1.0: neutro, argentina, colombia, mexico.
 *
 * Heuristicas por dialecto (spec §"Heurísticas mínimas por dialecto"):
 *   argentina: voseo (vos sos, tenes, queres), che, bondi, laburo, re, posta
 *   colombia:  parcero, que mas pues, chevere, bacano, quiubo, hagale, listo
 *   mexico:    orale, guey/wey, chido, neta, ahorita, mande, no manches
 *   neutro:    ausencia de modismos locales
 *
 * Tambien detecta idiomaBase {es, pt, en} de forma minima para guardar
 * en episode.idiomaDetectado (extension multi-idioma queda fase G).
 */

const IDIOMAS_SOPORTADOS = Object.freeze(['es', 'pt', 'en']);
const TONADAS = Object.freeze({
  ARGENTINA: 'argentina',
  COLOMBIA: 'colombia',
  MEXICO: 'mexico',
  NEUTRO: 'neutro',
});

// Patrones por dialecto (case-insensitive, word boundaries donde aplique).
const DIALECT_PATTERNS = Object.freeze({
  argentina: [
    /\bvos\s+(sos|sabes|sabés|tenes|tenés|queres|querés|podes|podés|haces|hacés)\b/i,
    /\bche\b/i,
    /\bbondi\b/i,
    /\blaburo\b/i,
    /\bre\s+(bueno|copado|piola|jodido|caro|barato|posta)\b/i,
    /\bposta\b/i,
    /\bpibe\b/i,
    /\bquilombo\b/i,
  ],
  colombia: [
    /\bparcero\b/i,
    /\bparce\b/i,
    /\bqu[eé]\s+m[aá]s\s+pues\b/i,
    /\bch[eé]vere\b/i,
    /\bbacano\b/i,
    /\bquiubo\b/i,
    /\bh[aá]gale\b/i,
    /\bvaina\b/i,
    /\brumba\b/i,
  ],
  mexico: [
    /\b[oó]rale\b/i,
    /\b(g[uü]ey|wey)\b/i,
    /\bchido\b/i,
    /\bneta\b/i,
    /\bahorita\b/i,
    /\bmande\b/i,
    /\bno\s+manches\b/i,
    /\bch[aá]vo\b/i,
    /\bcuate\b/i,
  ],
});

// Patrones para idiomaBase minimo.
// PT: usa (?:^|\W) y (?:\W|$) en lugar de \b porque ê/ç no son \w en JS.
// EN: solo palabras inequivocamente inglesas (no 'for' / 'and' que pueden estar en strings ES tipo "FOR/MARLOR").
const LANGUAGE_PATTERNS = Object.freeze({
  pt: /(?:^|\W)(voc[êe]|obrigado|obrigada|tudo bem|tudo bom|n[ãa]o sei|por favor cara|beleza cara)(?:\W|$)/i,
  en: /\b(hello|thank you|how are you|good morning|good night|i am|you are|the cat|the dog)\b/i,
});

/**
 * Detecta idioma del texto. Default 'es'.
 * @param {string} text
 * @returns {string}
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'es';
  if (LANGUAGE_PATTERNS.pt.test(text)) return 'pt';
  if (LANGUAGE_PATTERNS.en.test(text)) return 'en';
  return 'es';
}

/**
 * Detecta tonada regional del texto. Retorna 'neutro' si no hay match.
 * @param {string} text
 * @returns {string}
 */
function detectTonada(text) {
  if (!text || typeof text !== 'string') return TONADAS.NEUTRO;
  const scores = { argentina: 0, colombia: 0, mexico: 0 };
  for (const [dialect, patterns] of Object.entries(DIALECT_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(text)) scores[dialect]++;
    }
  }
  // Sin matches -> neutro
  const max = Math.max(scores.argentina, scores.colombia, scores.mexico);
  if (max === 0) return TONADAS.NEUTRO;
  // Empate -> neutro (seguro)
  const winners = Object.entries(scores).filter(function (e) { return e[1] === max; });
  if (winners.length > 1) return TONADAS.NEUTRO;
  return winners[0][0];
}

/**
 * Analiza un episodio (array de mensajes) y retorna idioma + tonada dominantes.
 * @param {Array<{text?: string, body?: string}>} mensajes
 * @returns {{ idioma: string, tonada: string, scoreTonada: number }}
 */
function detectFromEpisode(mensajes) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    return { idioma: 'es', tonada: TONADAS.NEUTRO, scoreTonada: 0 };
  }
  const fullText = mensajes
    .map(function (m) { return (m && (m.text || m.body)) || ''; })
    .join(' ');
  const idioma = detectLanguage(fullText);
  const tonada = detectTonada(fullText);
  // scoreTonada: cantidad de matches del dialecto ganador
  let scoreTonada = 0;
  if (tonada !== TONADAS.NEUTRO) {
    for (const p of DIALECT_PATTERNS[tonada]) {
      if (p.test(fullText)) scoreTonada++;
    }
  }
  return { idioma, tonada, scoreTonada };
}

/**
 * Consolida tonada de los ultimos N episodios. Spec dice: mayoritaria
 * en >=7/10 episodios -> medium, >=9/10 -> high.
 * @param {Array<string>} tonadasEpisodios - array de tonadas (ej los ultimos 10)
 * @returns {{ tonada: string, confidence: 'low'|'medium'|'high' }}
 */
function consolidateTonadaConfidence(tonadasEpisodios) {
  if (!Array.isArray(tonadasEpisodios) || tonadasEpisodios.length === 0) {
    return { tonada: TONADAS.NEUTRO, confidence: 'low' };
  }
  const counts = {};
  for (const t of tonadasEpisodios) {
    counts[t] = (counts[t] || 0) + 1;
  }
  let bestTonada = TONADAS.NEUTRO;
  let bestCount = 0;
  for (const [tonada, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      bestTonada = tonada;
    }
  }
  const total = tonadasEpisodios.length;
  const ratio = bestCount / total;
  let confidence = 'low';
  if (bestTonada !== TONADAS.NEUTRO && total >= 10) {
    if (ratio >= 0.9) confidence = 'high';
    else if (ratio >= 0.7) confidence = 'medium';
  }
  return { tonada: bestTonada, confidence };
}

module.exports = {
  detectLanguage,
  detectTonada,
  detectFromEpisode,
  consolidateTonadaConfidence,
  IDIOMAS_SOPORTADOS,
  TONADAS,
  DIALECT_PATTERNS,
};
