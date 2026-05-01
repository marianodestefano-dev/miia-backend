'use strict';

/**
 * MIIA - Catalog Translator (T178)
 * Traduce automaticamente el catalogo al idioma del lead.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

let _translateClient = null;
function __setTranslateClientForTests(fn) { _translateClient = fn; }

const SUPPORTED_LANGUAGES = Object.freeze(['es', 'en', 'pt', 'fr', 'de', 'it']);
const DEFAULT_LANGUAGE = 'es';
const TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const TRANSLATABLE_FIELDS = Object.freeze(['name', 'description', 'category']);
const MAX_ITEMS_PER_REQUEST = 50;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;


/**
 * Traduce un array de textos al idioma destino via Google Translate API.
 * @param {string[]} texts
 * @param {string} targetLanguage
 * @returns {Promise<string[]>}
 */
async function translateTexts(texts, targetLanguage) {
  if (!Array.isArray(texts)) throw new Error('texts debe ser array');
  if (!targetLanguage) throw new Error('targetLanguage requerido');
  if (!SUPPORTED_LANGUAGES.includes(targetLanguage)) throw new Error('idioma no soportado: ' + targetLanguage);

  if (texts.length === 0) return [];

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    console.error('[CATALOG_TRANS] GOOGLE_TRANSLATE_API_KEY no configurada');
    return texts;
  }

  const caller = _translateClient || _defaultTranslate;
  const results = [];

  for (let i = 0; i < texts.length; i += MAX_ITEMS_PER_REQUEST) {
    const chunk = texts.slice(i, i + MAX_ITEMS_PER_REQUEST);
    let timer;
    try {
      const abortCtrl = new AbortController();
      timer = setTimeout(() => abortCtrl.abort(), 10000);
      const translated = await caller(chunk, targetLanguage, apiKey, abortCtrl.signal);
      results.push(...translated);
    } catch (e) {
      console.error('[CATALOG_TRANS] Error traduciendo chunk: ' + e.message);
      results.push(...chunk);
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

async function _defaultTranslate(texts, targetLang, apiKey, signal) {
  const url = TRANSLATE_ENDPOINT + '?key=' + apiKey;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target: targetLang, format: 'text' }),
    signal,
  });
  const data = await resp.json();
  if (!data.data || !data.data.translations) throw new Error('respuesta invalida de Google Translate');
  return data.data.translations.map(t => t.translatedText);
}


/**
 * Traduce un item del catalogo al idioma destino.
 * @param {object} item - {name, description, category, ...}
 * @param {string} targetLanguage
 * @returns {Promise<object>} item traducido (no muta el original)
 */
async function translateCatalogItem(item, targetLanguage) {
  if (!item || typeof item !== 'object') throw new Error('item requerido');
  if (!targetLanguage) throw new Error('targetLanguage requerido');
  if (!SUPPORTED_LANGUAGES.includes(targetLanguage)) throw new Error('idioma no soportado: ' + targetLanguage);

  if (targetLanguage === DEFAULT_LANGUAGE) return { ...item };

  const fieldsToTranslate = TRANSLATABLE_FIELDS.filter(f => item[f] && typeof item[f] === 'string');
  if (fieldsToTranslate.length === 0) return { ...item };

  const texts = fieldsToTranslate.map(f => item[f]);
  const translated = await translateTexts(texts, targetLanguage);

  const result = { ...item };
  fieldsToTranslate.forEach((f, idx) => {
    result[f] = translated[idx] || item[f];
  });
  result._translatedTo = targetLanguage;
  return result;
}

/**
 * Traduce el catalogo completo del owner al idioma destino.
 * Usa cache en Firestore para evitar re-traducir.
 * @param {string} uid
 * @param {string} targetLanguage
 * @returns {Promise<object[]>} items traducidos
 */
async function translateCatalog(uid, targetLanguage) {
  if (!uid) throw new Error('uid requerido');
  if (!targetLanguage) throw new Error('targetLanguage requerido');
  if (!SUPPORTED_LANGUAGES.includes(targetLanguage)) throw new Error('idioma no soportado: ' + targetLanguage);

  const cached = await _getCachedTranslation(uid, targetLanguage);
  if (cached) return cached;

  const items = await _getCatalogItems(uid);
  if (items.length === 0) return [];

  const translated = [];
  for (const item of items) {
    try {
      const t = await translateCatalogItem(item, targetLanguage);
      translated.push(t);
    } catch (e) {
      console.error('[CATALOG_TRANS] Error traduciendo item ' + (item.id || '') + ': ' + e.message);
      translated.push({ ...item });
    }
  }

  await _saveCachedTranslation(uid, targetLanguage, translated).catch(e => {
    console.error('[CATALOG_TRANS] Error guardando cache: ' + e.message);
  });

  return translated;
}

async function _getCatalogItems(uid) {
  try {
    const snap = await db().collection('tenants').doc(uid).collection('catalog').get();
    const items = [];
    snap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
    return items;
  } catch (e) {
    console.error('[CATALOG_TRANS] Error leyendo catalogo: ' + e.message);
    return [];
  }
}

async function _getCachedTranslation(uid, language) {
  try {
    const snap = await db()
      .collection('catalog_translations').doc(uid + '_' + language)
      .get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data.cachedAt) return null;
    const age = Date.now() - new Date(data.cachedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data.items || null;
  } catch (e) {
    return null;
  }
}

async function _saveCachedTranslation(uid, language, items) {
  await db()
    .collection('catalog_translations')
    .doc(uid + '_' + language)
    .set({ uid, language, items, cachedAt: new Date().toISOString() });
}

/**
 * Invalida el cache de traduccion del owner (ej: cuando actualiza su catalogo).
 * @param {string} uid
 * @param {string} [language] - si no se especifica, invalida todos
 */
async function invalidateTranslationCache(uid, language) {
  if (!uid) throw new Error('uid requerido');
  if (language) {
    await db().collection('catalog_translations').doc(uid + '_' + language).set({ uid, language, items: null, cachedAt: null });
  } else {
    for (const lang of SUPPORTED_LANGUAGES) {
      await db().collection('catalog_translations').doc(uid + '_' + lang).set({ uid, language: lang, items: null, cachedAt: null }).catch(() => {});
    }
  }
  console.log('[CATALOG_TRANS] cache invalidado uid=' + uid.substring(0, 8));
}

module.exports = {
  translateTexts, translateCatalogItem, translateCatalog,
  invalidateTranslationCache,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, TRANSLATABLE_FIELDS,
  MAX_ITEMS_PER_REQUEST, CACHE_TTL_MS,
  __setFirestoreForTests, __setTranslateClientForTests,
};
