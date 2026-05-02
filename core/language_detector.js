'use strict';

/**
 * MIIA - Language Detector (T177)
 * Detecta idioma del lead y permite que MIIA responda en ese idioma.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const SUPPORTED_LANGUAGES = Object.freeze(['es', 'en', 'pt', 'fr', 'de', 'it']);
const DEFAULT_LANGUAGE = 'es';
const CONFIDENCE_THRESHOLD = 0.4;
const MIN_WORDS_FOR_DETECTION = 3;

const LANGUAGE_PATTERNS = Object.freeze({
  es: {
    words: ['hola','gracias','por','favor','como','estas','buenas','dias','tardes','noches','quiero','necesito','puedo','tiene','precio','cuanto','cuando','donde','ayuda','bien','mal','si','no','que','hay','para'],
    chars: [],
  },
  en: {
    words: ['hello','hi','thanks','please','how','are','you','good','morning','evening','want','need','can','have','price','when','where','help','yes','no','what','there','for','the','is'],
    chars: [],
  },
  pt: {
    words: ['ola','obrigado','bom','dia','tarde','noite','quero','preciso','posso','tem','preco','quanto','quando','onde','ajuda','sim','voce'],
    chars: ['ã', 'õ', 'ç'],
  },
  fr: {
    words: ['bonjour','merci','comment','allez','bonne','journee','veux','besoin','puis','avez','prix','combien','quand','aide','oui','non','quoi','pour','le','la','est'],
    chars: ['é', 'è', 'ê', 'à', 'â', 'ç'],
  },
  de: {
    words: ['hallo','danke','bitte','wie','geht','guten','morgen','abend','brauche','kann','haben','preis','wieviel','wann','wo','hilfe','ja','nein','was'],
    chars: ['ä', 'ö', 'ü', 'ß'],
  },
  it: {
    words: ['ciao','grazie','per','favore','come','stai','buongiorno','sera','voglio','bisogno','posso','avete','prezzo','quanto','quando','dove','aiuto','si','no','cosa'],
    chars: ['à', 'è', 'ì', 'ò', 'ù'],
  },
});

function detectLanguage(text) {
  if (!text || typeof text !== 'string') return { lang: null, language: null, confidence: 0, scores: {} };

  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);

  if (words.length < MIN_WORDS_FOR_DETECTION) {
    return { lang: null, language: DEFAULT_LANGUAGE, confidence: 0, scores: {} };
  }

  const scores = { es: 0, en: 0, pt: 0 };

  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    let score = 0;
    for (const word of patterns.words) {
      if (words.includes(word)) score += 1;
      else if (lower.includes(' ' + word + ' ')) score += 0.5;
    }
    for (const ch of patterns.chars) {
      if (lower.includes(ch)) score += 2;
    }
    scores[lang] = Math.round(score * 10) / 10;
  }

  const __anyScore = Object.values(scores).some(v => v > 0);
  if (!__anyScore) {
    return { lang: null, language: DEFAULT_LANGUAGE, confidence: 0, scores: {} };
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topLang = sorted[0][0];
  const topScore = sorted[0][1];
  const totalScore = sorted.reduce((s, [, v]) => s + v, 0);
  const confidence = Math.min(topScore / Math.max(totalScore, 1), 1);

  if (confidence < CONFIDENCE_THRESHOLD) {
    return { lang: DEFAULT_LANGUAGE, language: DEFAULT_LANGUAGE, confidence, scores: Object.fromEntries(sorted) };
  }

  return {
    lang: topLang,
    language: topLang,
    confidence: Math.round(confidence * 100) / 100,
    scores: Object.fromEntries(sorted),
  };
}

async function saveContactLanguage(uid, phone, language) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!language) throw new Error('language requerido');
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new Error('idioma no soportado: ' + language);

  try {
    await db()
      .collection('tenants').doc(uid)
      .collection('contact_languages').doc(phone)
      .set({ uid, phone, language, updatedAt: new Date().toISOString() }, { merge: true });
    console.log('[LANG] idioma guardado uid=' + uid.substring(0, 8) + ' lang=' + language);
  } catch (e) {
    console.error('[LANG] Error guardando idioma: ' + e.message);
    throw e;
  }
}

async function getContactLanguage(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db()
      .collection('tenants').doc(uid)
      .collection('contact_languages').doc(phone)
      .get();
    if (!snap.exists) return DEFAULT_LANGUAGE;
    return snap.data().language || DEFAULT_LANGUAGE;
  } catch (e) {
    console.error('[LANG] Error leyendo idioma: ' + e.message);
    return DEFAULT_LANGUAGE;
  }
}

async function detectAndSaveLanguage(uid, phone, message) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!message || typeof message !== 'string') throw new Error('message requerido');

  const { language, confidence } = detectLanguage(message);
  let saved = false;

  if (confidence >= CONFIDENCE_THRESHOLD && SUPPORTED_LANGUAGES.includes(language)) {
    try {
      await saveContactLanguage(uid, phone, language);
      saved = true;
    } catch (e) {
      console.error('[LANG] Error guardando idioma detectado: ' + e.message);
    }
  }

  return { language, confidence, saved };
}

async function getResponseLanguage(uid, phone, currentMessage) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');

  if (currentMessage) {
    const { language, confidence } = detectLanguage(currentMessage);
    if (confidence >= CONFIDENCE_THRESHOLD) return language;
  }

  return getContactLanguage(uid, phone);
}

// T129 helpers
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const noAccent = lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const tokens = noAccent.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  return tokens;
}

function detectDominantLanguage(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return { lang: null, confidence: 0 };
  const counts = {};
  for (const t of texts) {
    const r = detectLanguage(t);
    if (r && r.lang) counts[r.lang] = (counts[r.lang] || 0) + 1;
  }
  const langs = Object.keys(counts);
  if (langs.length === 0) return { lang: null, confidence: 0 };
  let best = langs[0];
  for (const l of langs) if (counts[l] > counts[best]) best = l;
  const total = langs.reduce((s, l) => s + counts[l], 0);
  return { lang: best, confidence: counts[best] / total };
}

const SUPPORTED_LANGS = SUPPORTED_LANGUAGES || ['es', 'en', 'pt'];


module.exports = {
  detectLanguage, saveContactLanguage, getContactLanguage,
  tokenize, detectDominantLanguage, SUPPORTED_LANGS,
  detectAndSaveLanguage, getResponseLanguage,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE,
  CONFIDENCE_THRESHOLD, MIN_WORDS_FOR_DETECTION,
  __setFirestoreForTests,
};
