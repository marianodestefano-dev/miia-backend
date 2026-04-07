'use strict';

/**
 * WEB_SCRAPER.JS — Scraper semanal de la web y YouTube del negocio del owner
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FUNCIONES:
 *   1. Scrapear la web del negocio del owner → extraer texto/funcionalidades
 *   2. Scrapear el canal de YouTube → extraer videos con títulos y URLs
 *   3. Guardar todo en Firestore para que MIIA use en conversaciones con leads
 *   4. Cron semanal (cada 7 días)
 *
 * ALMACENAMIENTO Firestore:
 *   users/{uid}/businesses/{bizId}/web_scrape → { content, scrapedAt, url }
 *   users/{uid}/businesses/{bizId}/youtube_data → { videos[], scrapedAt, channelUrl }
 */

const SCRAPE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_YOUTUBE_VIDEOS = 20;
const MAX_WEB_CONTENT_LENGTH = 10000; // Máximo chars de contenido web a guardar

// Estado en memoria
let lastScrapeCheck = 0;
const SCRAPE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // Verificar cada 6 horas si hay que scrapear

// ═══════════════════════════════════════════════════════════════
// WEB SCRAPER — Usa Gemini para extraer contenido de una URL
// ═══════════════════════════════════════════════════════════════

/**
 * Scrapear la web del negocio usando Gemini con google_search
 * (No hacemos HTTP directo — usamos la capacidad de búsqueda de Gemini)
 *
 * @param {string} websiteUrl - URL del negocio (ej: "softwaremedilink.com")
 * @param {function} generateAIFn - async (prompt, opts) => string
 * @returns {Promise<{ content: string, features: string[], success: boolean }>}
 */
async function scrapeBusinessWebsite(websiteUrl, generateAIFn) {
  if (!websiteUrl) {
    console.warn('[WEB-SCRAPER] ⚠️ No hay URL de website configurada');
    return { content: '', features: [], success: false };
  }

  console.log(`[WEB-SCRAPER] 🌐 Scrapeando website: ${websiteUrl}`);

  try {
    const prompt = `Visita la página web ${websiteUrl} y extrae la información más importante para un vendedor que necesita conocer el producto a fondo.

Devuelve la información en este formato:

## RESUMEN DEL NEGOCIO
[1-2 párrafos describiendo qué hace el negocio]

## PRODUCTOS/SERVICIOS
[Lista de cada producto o servicio con una línea de descripción]

## FUNCIONALIDADES DESTACADAS
[Lista de features/funcionalidades principales con descripción breve]

## PLANES Y PRECIOS
[Si están disponibles en la web, lista de planes con precios]

## INTEGRACIONES
[Lista de integraciones con otros sistemas si las mencionan]

## PAÍSES/MERCADOS
[Países donde operan, teléfonos de contacto por país]

## DIFERENCIADORES
[Qué los hace únicos vs la competencia]

REGLAS:
- Solo información que esté en la web, NO inventes
- Sé conciso pero completo
- Si no encuentras alguna sección, omítela`;

    const content = await generateAIFn(prompt, { forceGoogleSearch: true });

    if (!content) {
      console.error('[WEB-SCRAPER] ❌ Gemini no devolvió contenido para el scrape');
      return { content: '', features: [], success: false };
    }

    // Extraer features como array para búsqueda rápida
    const features = [];
    const featureMatches = content.matchAll(/[-•]\s*\*?\*?([^*\n]+)\*?\*?/g);
    for (const match of featureMatches) {
      const feature = match[1].trim();
      if (feature.length > 5 && feature.length < 200) {
        features.push(feature);
      }
    }

    const trimmedContent = content.substring(0, MAX_WEB_CONTENT_LENGTH);
    console.log(`[WEB-SCRAPER] ✅ Website scrapeado: ${trimmedContent.length} chars, ${features.length} features detectadas`);

    return { content: trimmedContent, features, success: true };
  } catch (err) {
    console.error(`[WEB-SCRAPER] ❌ Error scrapeando ${websiteUrl}:`, err.message);
    return { content: '', features: [], success: false };
  }
}

// ═══════════════════════════════════════════════════════════════
// YOUTUBE SCRAPER — YouTube Data API v3
// ═══════════════════════════════════════════════════════════════

/**
 * Extraer ID del canal de YouTube desde varias formas de URL
 * @param {string} url - URL del canal
 * @returns {string|null} Channel ID o null
 */
function extractYouTubeChannelId(url) {
  if (!url) return null;

  // Formato: /channel/UCxxxxxxxxx
  const channelMatch = url.match(/\/channel\/(UC[\w-]+)/);
  if (channelMatch) return channelMatch[1];

  // Formato: /@username
  const handleMatch = url.match(/\/@([\w.-]+)/);
  if (handleMatch) return `@${handleMatch[1]}`; // Devolver handle, resolver después

  // Formato: /c/customname o /user/username
  const customMatch = url.match(/\/(c|user)\/([\w.-]+)/);
  if (customMatch) return customMatch[2]; // Resolver después

  return null;
}

/**
 * Obtener videos del canal de YouTube usando la API
 * @param {string} channelIdentifier - Channel ID (UC...) o handle (@name)
 * @param {string} apiKey - YouTube Data API key (puede ser la de Gemini/Google)
 * @param {function} generateAIFn - Fallback: usar Gemini search si no hay API key
 * @returns {Promise<{ videos: object[], success: boolean }>}
 */
async function scrapeYouTubeChannel(channelIdentifier, apiKey, generateAIFn) {
  if (!channelIdentifier) {
    console.warn('[WEB-SCRAPER] ⚠️ No hay canal de YouTube configurado');
    return { videos: [], success: false };
  }

  console.log(`[WEB-SCRAPER] 📺 Scrapeando YouTube: ${channelIdentifier}`);

  // ESTRATEGIA 1: YouTube Data API (si hay key)
  if (apiKey) {
    try {
      const videos = await fetchYouTubeVideosViaAPI(channelIdentifier, apiKey);
      if (videos.length > 0) {
        console.log(`[WEB-SCRAPER] ✅ YouTube API: ${videos.length} videos encontrados`);
        return { videos, success: true };
      }
    } catch (err) {
      console.warn(`[WEB-SCRAPER] ⚠️ YouTube API falló, usando Gemini como fallback:`, err.message);
    }
  }

  // ESTRATEGIA 2: Gemini google_search como fallback
  if (generateAIFn) {
    try {
      const videos = await fetchYouTubeVideosViaGemini(channelIdentifier, generateAIFn);
      console.log(`[WEB-SCRAPER] ✅ YouTube (Gemini): ${videos.length} videos encontrados`);
      return { videos, success: videos.length > 0 };
    } catch (err) {
      console.error(`[WEB-SCRAPER] ❌ Gemini fallback para YouTube falló:`, err.message);
    }
  }

  return { videos: [], success: false };
}

/**
 * Fetch videos via YouTube Data API v3
 * @param {string} channelId
 * @param {string} apiKey
 * @returns {Promise<object[]>}
 */
async function fetchYouTubeVideosViaAPI(channelId, apiKey) {
  // Si es un handle (@name), primero resolver a channel ID
  let resolvedChannelId = channelId;

  if (channelId.startsWith('@') || !channelId.startsWith('UC')) {
    const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(channelId)}&key=${apiKey}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error(`YouTube search failed: ${searchRes.status}`);
    const searchData = await searchRes.json();
    if (searchData.items && searchData.items.length > 0) {
      resolvedChannelId = searchData.items[0].snippet.channelId;
    } else {
      throw new Error(`No channel found for: ${channelId}`);
    }
  }

  // Obtener videos del canal
  const videosUrl = `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${resolvedChannelId}&order=date&type=video&maxResults=${MAX_YOUTUBE_VIDEOS}&key=${apiKey}`;
  const videosRes = await fetch(videosUrl);
  if (!videosRes.ok) throw new Error(`YouTube videos fetch failed: ${videosRes.status}`);
  const videosData = await videosRes.json();

  return (videosData.items || []).map(item => ({
    title: item.snippet.title,
    description: (item.snippet.description || '').substring(0, 200),
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    publishedAt: item.snippet.publishedAt,
    thumbnail: item.snippet.thumbnails?.medium?.url || null,
  }));
}

/**
 * Fetch videos via Gemini google_search (fallback)
 * @param {string} channelIdentifier
 * @param {function} generateAIFn
 * @returns {Promise<object[]>}
 */
async function fetchYouTubeVideosViaGemini(channelIdentifier, generateAIFn) {
  const prompt = `Busca el canal de YouTube "${channelIdentifier}" y lista sus últimos 15 videos.

Por cada video devuelve JSON:
[
  {
    "title": "Título del video",
    "url": "https://www.youtube.com/watch?v=XXXXX",
    "description": "Descripción breve (1 línea)"
  }
]

Solo devuelve el JSON array, nada más.`;

  const response = await generateAIFn(prompt, { forceGoogleSearch: true });
  if (!response) return [];

  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    const parsed = JSON.parse(jsonStr.trim());
    return Array.isArray(parsed) ? parsed.map(v => ({
      title: v.title || '',
      description: v.description || '',
      url: v.url || '',
      publishedAt: null,
      thumbnail: null,
    })) : [];
  } catch (e) {
    console.error(`[WEB-SCRAPER] ❌ Error parseando YouTube Gemini response:`, e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// CRON — Verificar si hay que scrapear
// ═══════════════════════════════════════════════════════════════

/**
 * Ejecutar scrape semanal si es necesario
 * Llamado por el polling del integrity_engine o por setInterval
 *
 * @param {object} opts
 * @param {string} opts.ownerUid
 * @param {object[]} opts.businesses - Array de negocios del owner
 * @param {function} opts.generateAIFn
 * @param {function} opts.saveToFirestoreFn - async (collection, docId, data) => void
 * @param {function} opts.loadFromFirestoreFn - async (collection, docId) => data
 * @param {string} opts.youtubeApiKey - YouTube API key (optional)
 */
async function runWeeklyScrape(opts) {
  const now = Date.now();

  // No chequear más seguido que cada 6 horas
  if (now - lastScrapeCheck < SCRAPE_CHECK_INTERVAL) return;
  lastScrapeCheck = now;

  const { ownerUid, businesses, generateAIFn, saveToFirestoreFn, loadFromFirestoreFn, youtubeApiKey } = opts;

  if (!businesses || businesses.length === 0) {
    return;
  }

  for (const biz of businesses) {
    const bizId = biz.id || 'default';

    try {
      // Verificar cuándo fue el último scrape
      const existing = await loadFromFirestoreFn(
        `users/${ownerUid}/businesses/${bizId}`, 'web_scrape'
      ).catch(() => null);

      const lastScrapedAt = existing?.scrapedAt?.toMillis?.() || existing?.scrapedAt || 0;

      if (now - lastScrapedAt < SCRAPE_INTERVAL_MS) {
        console.log(`[WEB-SCRAPER] ⏭️ ${biz.name || bizId}: último scrape hace ${Math.round((now - lastScrapedAt) / (1000 * 60 * 60))}h, siguiente en ${Math.round((SCRAPE_INTERVAL_MS - (now - lastScrapedAt)) / (1000 * 60 * 60))}h`);
        continue;
      }

      console.log(`[WEB-SCRAPER] 🔄 Ejecutando scrape semanal para ${biz.name || bizId}...`);

      // Scrape web
      if (biz.website) {
        const webResult = await scrapeBusinessWebsite(biz.website, generateAIFn);
        if (webResult.success) {
          await saveToFirestoreFn(`users/${ownerUid}/businesses/${bizId}`, 'web_scrape', {
            content: webResult.content,
            features: webResult.features,
            url: biz.website,
            scrapedAt: new Date(),
          });
          console.log(`[WEB-SCRAPER] ✅ Web scrape guardado para ${biz.name}`);
        }
      }

      // Scrape YouTube
      const youtubeUrl = biz.youtubeChannel || biz.youtube_channel;
      if (youtubeUrl) {
        const channelId = extractYouTubeChannelId(youtubeUrl);
        const ytResult = await scrapeYouTubeChannel(channelId, youtubeApiKey, generateAIFn);
        if (ytResult.success) {
          await saveToFirestoreFn(`users/${ownerUid}/businesses/${bizId}`, 'youtube_data', {
            videos: ytResult.videos,
            channelUrl: youtubeUrl,
            scrapedAt: new Date(),
          });
          console.log(`[WEB-SCRAPER] ✅ YouTube scrape guardado para ${biz.name}: ${ytResult.videos.length} videos`);
        }
      }

    } catch (err) {
      console.error(`[WEB-SCRAPER] ❌ Error en scrape semanal de ${biz.name || bizId}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Scrapers
  scrapeBusinessWebsite,
  scrapeYouTubeChannel,
  extractYouTubeChannelId,

  // Cron
  runWeeklyScrape,

  // Constantes
  SCRAPE_INTERVAL_MS,
  MAX_WEB_CONTENT_LENGTH,
  MAX_YOUTUBE_VIDEOS,
};
