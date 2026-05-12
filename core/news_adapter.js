'use strict';

/**
 * R18-B — news_adapter.js (Piso 4 P4.4 - IDEA #009)
 * Adapter de noticias para data_fetcher: RSS oficial por pais + YouTube Data API v3.
 * Uso: registerAdapter('noticias', newsAdapter, { oficial: rssAdapter, cacheTTL: 10min })
 */

const { XMLParser } = require('fast-xml-parser');

const MAX_ARTICLES = 5;
const MAX_YT_RESULTS = 5;
const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const DEFAULT_PAIS = 'colombia';
const CACHE_TTL_NEWS = 10 * 60 * 1000; // 10 min

// RSS feeds por pais (portales oficiales)
const RSS_FEEDS = Object.freeze({
  colombia: [
    'https://www.eltiempo.com/rss/portada.xml',
    'https://www.semana.com/rss/noticias.xml',
  ],
  argentina: [
    'https://www.clarin.com/rss/lo-ultimo/',
    'https://www.lanacion.com.ar/arc/outboundfeeds/rss/',
  ],
  mexico: [
    'https://www.eluniversal.com.mx/rss.xml',
    'https://www.reforma.com/rss/portada.xml',
  ],
  chile: [
    'https://www.latercera.com/feed/',
  ],
});

// YouTube channel IDs por pais (noticieros oficiales)
const YT_CHANNELS = Object.freeze({
  colombia: ['UCzRvrdXSNUoEGNQ1k6f2E7Q', 'UCHLlDJbVFW9L_s5IYS7u5ow'],
  argentina: ['UCBs16grILb1ByFedKnsMEhQ', 'UCGjzBBVVbF0oJjHvGPLCG9g'],
  mexico: ['UCMX7pJP4RJqMnJK5qj5u7lA', 'UCpZ_eVpZqzJMuLT8F5uL_rw'],
  chile: ['UC4Gn_9wPoxT4Yrq3Y6MCLtg'],
});

let _fetch = /* istanbul ignore next */ function () { return require('node-fetch')(...arguments); };
function __setFetchForTests(fn) { _fetch = fn; }

function _parseRSSItems(xml) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const rawItems = (parsed.rss && parsed.rss.channel && parsed.rss.channel.item) || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];
  return items.slice(0, MAX_ARTICLES).map(function (item) {
    return {
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || null,
      description: (item.description || '').slice(0, 300),
      source: 'rss',
    };
  });
}

/**
 * Intenta obtener artículos RSS del primer feed disponible del pais.
 * @param {{ pais }} params
 * @param {AbortSignal} signal
 * @returns {Promise<Array|null>}
 */
async function rssAdapter(params, signal) {
  const p = params || {};
  const pais = (p.pais || DEFAULT_PAIS).toLowerCase();
  const feeds = RSS_FEEDS[pais];
  if (!feeds || feeds.length === 0) return null;

  for (const feedUrl of feeds) {
    try {
      const res = await _fetch(feedUrl, { signal });
      if (!res.ok) continue;
      const xml = await res.text();
      const articles = _parseRSSItems(xml);
      if (articles.length > 0) return articles;
    } catch (_) { /* continuar con siguiente feed */ }
  }
  return null;
}

/**
 * Obtiene videos recientes de canales noticieros del pais via YouTube Data API v3.
 * @param {{ pais, apiKey }} params
 * @param {AbortSignal} signal
 * @returns {Promise<Array|null>}
 */
async function youtubeAdapter(params, signal) {
  const p = params || {};
  const pais = (p.pais || DEFAULT_PAIS).toLowerCase();
  const apiKey = p.apiKey || process.env.YOUTUBE_API_KEY || null;
  if (!apiKey) return null;

  const channelIds = YT_CHANNELS[pais];
  if (!channelIds || channelIds.length === 0) return null;

  const results = [];
  for (const channelId of channelIds.slice(0, 2)) {
    try {
      const url = YT_SEARCH_URL
        + '?part=snippet&channelId=' + channelId
        + '&type=video&videoDuration=short&eventType=completed'
        + '&maxResults=' + MAX_YT_RESULTS
        + '&key=' + apiKey;
      const res = await _fetch(url, { signal });
      if (!res.ok) continue;
      const json = await res.json();
      const items = (json.items || []).map(function (item) {
        return {
          title: (item.snippet && item.snippet.title) || '',
          link: 'https://www.youtube.com/watch?v=' + (item.id && item.id.videoId),
          publishedAt: (item.snippet && item.snippet.publishedAt) || null,
          channelTitle: (item.snippet && item.snippet.channelTitle) || '',
          source: 'youtube',
        };
      });
      results.push.apply(results, items);
    } catch (_) { /* continuar con siguiente canal */ }
  }
  return results.length > 0 ? results.slice(0, MAX_YT_RESULTS) : null;
}

/**
 * Adapter principal (privado): RSS → YouTube en cascada.
 * Se registra como adapterFn en data_fetcher topic 'noticias'.
 * @param {{ pais, apiKey }} params
 * @param {AbortSignal} signal
 * @returns {Promise<Array|null>}
 */
async function newsAdapter(params, signal) {
  const rss = await rssAdapter(params, signal);
  if (rss) return rss;
  return youtubeAdapter(params, signal);
}

module.exports = {
  newsAdapter,
  rssAdapter,
  youtubeAdapter,
  RSS_FEEDS,
  YT_CHANNELS,
  MAX_ARTICLES,
  MAX_YT_RESULTS,
  CACHE_TTL_NEWS,
  DEFAULT_PAIS,
  __setFetchForTests,
};
