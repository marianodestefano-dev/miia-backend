// ════════════════════════════════════════════════════════════════════════════
// MIIA — Link Click Tracker
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Detecta qué links abre el owner para aprender sus intereses.
//
// FLUJO:
//   1. MIIA envía links con short-URL tracker (redirect via nuestro server)
//   2. Cuando owner clickea → registramos el click + categoría
//   3. Analizamos patrones: si el owner clickea 3+ veces la misma categoría
//      en la última semana → guardar como interés detectado
//   4. AL OTRO DÍA (no en el momento!) → pregunta proactiva:
//      "Noté que te interesa {tema}. ¿Querés que te mande novedades?"
//   5. Si owner dice sí → se guarda en owner_memory.intereses PARA SIEMPRE
//
// TÉCNICA DE TRACKING:
//   MIIA envía: "Mirá esto: https://miia.app/r/abc123"
//   El server redirecciona a la URL real y registra el click.
//   No requiere UTM ni nada del lado del owner — transparente.
//
// REGLA: NUNCA preguntar en el momento del click. SIEMPRE al otro día.
// REGLA: Mínimo 3 clicks en la misma categoría para considerar patrón.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');

let _firestore = null;
let _ownerUid = null;
let _ownerMemory = null;  // Referencia a owner_memory.js para guardar intereses

const PATTERN_THRESHOLD = 3;       // Mínimo clicks de misma categoría para detectar patrón
const PATTERN_WINDOW_DAYS = 7;     // Ventana de análisis (últimos 7 días)
const PROACTIVE_COOLDOWN_DAYS = 7; // No preguntar sobre el mismo tema por 7 días

/**
 * Inicializa el link tracker.
 * @param {string} ownerUid
 * @param {Object} firestore - admin.firestore()
 * @param {Object} ownerMemory - referencia a owner_memory.js
 */
function init(ownerUid, firestore, ownerMemory) {
  _ownerUid = ownerUid;
  _firestore = firestore;
  _ownerMemory = ownerMemory;
  console.log('[LINK-TRACKER] ✅ Inicializado — detección de intereses por clicks');
}

/**
 * Genera un short link trackeable para enviar al owner.
 * Guarda la URL original + categoría en Firestore.
 *
 * @param {string} originalUrl - URL real del contenido
 * @param {string} category - Categoría del contenido (tecnología, deportes, salud, etc.)
 * @param {string} title - Título corto del link
 * @param {string} [baseUrl] - Base URL del server (default: process.env.BASE_URL)
 * @returns {Promise<{shortUrl: string, trackId: string}>}
 */
async function createTrackedLink(originalUrl, category, title, baseUrl) {
  const trackId = crypto.randomBytes(6).toString('hex'); // 12 chars

  try {
    await _firestore.collection('users').doc(_ownerUid)
      .collection('tracked_links').doc(trackId).set({
        originalUrl,
        category: category.toLowerCase(),
        title,
        createdAt: new Date().toISOString(),
        clicked: false,
        clickedAt: null
      });

    const base = baseUrl || process.env.BASE_URL || 'https://miia-backend.up.railway.app';
    const shortUrl = `${base}/r/${_ownerUid}/${trackId}`;

    console.log(`[LINK-TRACKER] 🔗 Link creado: ${trackId} → ${category} (${title})`);
    return { shortUrl, trackId };
  } catch (e) {
    console.error(`[LINK-TRACKER] ❌ Error creando link: ${e.message}`);
    // Fallback: retornar URL original sin tracking
    return { shortUrl: originalUrl, trackId: null };
  }
}

/**
 * Registra un click en un link trackeado.
 * Llamado por el endpoint GET /r/:uid/:trackId
 *
 * @param {string} ownerUid
 * @param {string} trackId
 * @returns {Promise<{originalUrl: string}|null>}
 */
async function registerClick(ownerUid, trackId) {
  try {
    const docRef = _firestore.collection('users').doc(ownerUid)
      .collection('tracked_links').doc(trackId);

    const doc = await docRef.get();
    if (!doc.exists) {
      console.log(`[LINK-TRACKER] ⚠️ Link no encontrado: ${trackId}`);
      return null;
    }

    const data = doc.data();

    // Registrar click
    await docRef.update({
      clicked: true,
      clickedAt: new Date().toISOString()
    });

    console.log(`[LINK-TRACKER] 👆 Click detectado: ${data.category} — "${data.title}"`);

    // Registrar en historial de clicks (para análisis de patrones)
    await _firestore.collection('users').doc(ownerUid)
      .collection('link_clicks').add({
        trackId,
        category: data.category,
        title: data.title,
        originalUrl: data.originalUrl,
        clickedAt: new Date().toISOString()
      });

    return { originalUrl: data.originalUrl };
  } catch (e) {
    console.error(`[LINK-TRACKER] ❌ Error registrando click: ${e.message}`);
    return null;
  }
}

/**
 * Analiza patrones de clicks y detecta intereses.
 * Llamado por el briefing de noticias (8 AM).
 * Retorna categorías con 3+ clicks en los últimos 7 días
 * que NO han sido preguntadas recientemente.
 *
 * @returns {Promise<Array<{category: string, count: number, titles: string[]}>>}
 */
async function detectInterestPatterns() {
  if (!_firestore || !_ownerUid) return [];

  try {
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - PATTERN_WINDOW_DAYS);

    const snap = await _firestore.collection('users').doc(_ownerUid)
      .collection('link_clicks')
      .where('clickedAt', '>=', windowStart.toISOString())
      .get();

    if (snap.empty) return [];

    // Agrupar por categoría
    const categories = {};
    snap.forEach(doc => {
      const data = doc.data();
      const cat = data.category;
      if (!categories[cat]) categories[cat] = { count: 0, titles: [] };
      categories[cat].count++;
      if (!categories[cat].titles.includes(data.title)) {
        categories[cat].titles.push(data.title);
      }
    });

    // Filtrar: solo categorías con 3+ clicks
    const patterns = [];
    for (const [category, data] of Object.entries(categories)) {
      if (data.count >= PATTERN_THRESHOLD) {
        // ¿Ya preguntamos sobre este tema recientemente?
        const alreadyAsked = await wasRecentlyAsked(category);
        if (!alreadyAsked) {
          patterns.push({ category, count: data.count, titles: data.titles.slice(0, 5) });
        }
      }
    }

    if (patterns.length > 0) {
      console.log(`[LINK-TRACKER] 🎯 Patrones detectados: ${patterns.map(p => `${p.category}(${p.count})`).join(', ')}`);
    }

    return patterns;
  } catch (e) {
    console.error(`[LINK-TRACKER] ❌ Error analizando patrones: ${e.message}`);
    return [];
  }
}

/**
 * Verifica si ya preguntamos al owner sobre este tema recientemente.
 */
async function wasRecentlyAsked(category) {
  try {
    const cooldownStart = new Date();
    cooldownStart.setDate(cooldownStart.getDate() - PROACTIVE_COOLDOWN_DAYS);

    const snap = await _firestore.collection('users').doc(_ownerUid)
      .collection('interest_questions')
      .where('category', '==', category)
      .where('askedAt', '>=', cooldownStart.toISOString())
      .limit(1)
      .get();

    return !snap.empty;
  } catch (e) {
    return false; // En caso de error, preguntar igual
  }
}

/**
 * Marca que preguntamos al owner sobre un interés.
 * Para no repetir la pregunta en 7 días.
 */
async function markAsAsked(category) {
  try {
    await _firestore.collection('users').doc(_ownerUid)
      .collection('interest_questions').add({
        category,
        askedAt: new Date().toISOString()
      });
  } catch (e) {
    console.error(`[LINK-TRACKER] ❌ Error marcando pregunta: ${e.message}`);
  }
}

/**
 * Genera la pregunta proactiva para el owner.
 * Se envía AL OTRO DÍA del patrón detectado (en el briefing de noticias 8 AM).
 *
 * @param {Object} pattern - { category, count, titles }
 * @returns {string} Mensaje para enviar al owner
 */
function buildProactiveQuestion(pattern) {
  const catLabels = {
    tecnologia: 'tecnología',
    tecnología: 'tecnología',
    deportes: 'deportes',
    salud: 'salud',
    finanzas: 'finanzas',
    entretenimiento: 'entretenimiento',
    ciencia: 'ciencia',
    politica: 'política',
    musica: 'música',
    cocina: 'cocina',
    viajes: 'viajes',
    moda: 'moda',
    autos: 'autos',
    gaming: 'gaming'
  };

  const label = catLabels[pattern.category] || pattern.category;
  const examples = pattern.titles.slice(0, 3).map(t => `"${t}"`).join(', ');

  return `🧠 Noté que últimamente te interesa *${label}* (viste ${examples}). ¿Querés que te mande novedades sobre eso? 🔒 Si decís sí, queda guardado para siempre.`;
}

/**
 * Genera un set de links trackeados para enviar al owner.
 * Usado por el briefing de noticias para enviar 5 links con resúmenes cortos.
 *
 * @param {Array<{url: string, category: string, title: string, summary: string}>} articles
 * @returns {Promise<string>} Mensaje formateado con links trackeados
 */
async function buildTrackedNewsMessage(articles) {
  if (!articles || articles.length === 0) return null;

  let msg = '📰 *Noticias de hoy:*\n\n';

  for (const article of articles.slice(0, 5)) {
    const { shortUrl } = await createTrackedLink(article.url, article.category, article.title);
    msg += `▸ *${article.title}*\n  ${article.summary}\n  ${shortUrl}\n\n`;
  }

  return msg;
}

/**
 * Health check.
 */
function healthCheck() {
  return {
    initialized: !!_firestore,
    ownerUid: _ownerUid || null,
    patternThreshold: PATTERN_THRESHOLD,
    windowDays: PATTERN_WINDOW_DAYS,
    cooldownDays: PROACTIVE_COOLDOWN_DAYS
  };
}

module.exports = {
  init,
  createTrackedLink,
  registerClick,
  detectInterestPatterns,
  markAsAsked,
  buildProactiveQuestion,
  buildTrackedNewsMessage,
  healthCheck
};
