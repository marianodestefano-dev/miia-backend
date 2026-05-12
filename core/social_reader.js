'use strict';

/**
 * R25 — core/social_reader.js (Piso 4 P4.4)
 * Lectura de menciones publicas via API: Instagram Graph, Twitter/X v2, TikTok Research.
 * Solo lectura (no posteo). Persiste menciones en owners/{uid}/mentions con dedup.
 * Complementa social_listening.js (que es webhook-based).
 */

const PLATFORM = Object.freeze({ INSTAGRAM: 'instagram', TWITTER: 'twitter', TIKTOK: 'tiktok' });

const SENTIMENT = Object.freeze({ POSITIVE: 'positive', NEUTRAL: 'neutral', NEGATIVE: 'negative' });

const POSITIVE_WORDS = ['excelente', 'genial', 'amo', 'me encanta', 'recomiendo', 'perfecto', 'gracias', 'top'];
const NEGATIVE_WORDS = ['malo', 'terrible', 'pesimo', 'no funciona', 'no recomiendo', 'decepcion', 'queja', 'reclamo'];

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

let _fetch = /* istanbul ignore next */ function () { return require('node-fetch')(...arguments); };
function __setFetchForTests(fn) { _fetch = fn; }

// ── Firestore refs ────────────────────────────────────────────────────────────
function _integrationDoc(uid, platform) {
  return db().collection('owners').doc(uid).collection('integrations').doc(platform);
}

function _mentionsCol(uid) {
  return db().collection('owners').doc(uid).collection('mentions');
}

// ── Credential helpers ────────────────────────────────────────────────────────
async function _getCreds(uid, platform) {
  const snap = await _integrationDoc(uid, platform).get();
  if (!snap.exists) throw new Error(platform + '_no_conectado');
  const data = snap.data();
  if (!data.access_token) throw new Error(platform + '_creds_incompletos');
  return data;
}

// ── Sentiment analysis ────────────────────────────────────────────────────────
/**
 * Clasifica el sentimiento de un texto.
 * @param {string} text
 * @returns {string}
 */
function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') return SENTIMENT.NEUTRAL;
  const lower = text.toLowerCase();
  let posCount = 0;
  let negCount = 0;
  for (const w of POSITIVE_WORDS) {
    if (lower.includes(w)) posCount++;
  }
  for (const w of NEGATIVE_WORDS) {
    if (lower.includes(w)) negCount++;
  }
  if (posCount > negCount) return SENTIMENT.POSITIVE;
  if (negCount > posCount) return SENTIMENT.NEGATIVE;
  return SENTIMENT.NEUTRAL;
}

// ── Instagram ─────────────────────────────────────────────────────────────────
/**
 * Lee menciones de Instagram (Business Account) via Graph API.
 * @param {string} uid
 * @param {{ limit }} opts
 * @returns {Array}
 */
async function fetchInstagramMentions(uid, opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit) || 25, 100);
  const creds = await _getCreds(uid, PLATFORM.INSTAGRAM);
  if (!creds.ig_user_id) throw new Error('instagram_user_id_requerido');
  const url = 'https://graph.facebook.com/v18.0/' + creds.ig_user_id +
    '/tags?fields=id,caption,media_type,timestamp,permalink&limit=' + limit +
    '&access_token=' + creds.access_token;
  const res = await _fetch(url);
  if (!res.ok) throw new Error('instagram_api_error:' + res.status);
  const data = await res.json();
  return (data.data || []).map(function (m) {
    return {
      platform: PLATFORM.INSTAGRAM,
      external_id: m.id,
      text: m.caption || '',
      type: m.media_type || 'image',
      url: m.permalink || null,
      timestamp: m.timestamp || null,
      sentiment: analyzeSentiment(m.caption || ''),
    };
  });
}

// ── Twitter/X ─────────────────────────────────────────────────────────────────
/**
 * Lee menciones de Twitter/X por user_id del owner.
 * @param {string} uid
 * @param {{ limit }} opts
 * @returns {Array}
 */
async function fetchTwitterMentions(uid, opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit) || 25, 100);
  const creds = await _getCreds(uid, PLATFORM.TWITTER);
  if (!creds.user_id) throw new Error('twitter_user_id_requerido');
  const url = 'https://api.twitter.com/2/users/' + creds.user_id +
    '/mentions?max_results=' + limit + '&tweet.fields=created_at,author_id,public_metrics';
  const res = await _fetch(url, {
    headers: { Authorization: 'Bearer ' + creds.access_token },
  });
  if (!res.ok) throw new Error('twitter_api_error:' + res.status);
  const data = await res.json();
  return (data.data || []).map(function (t) {
    return {
      platform: PLATFORM.TWITTER,
      external_id: t.id,
      text: t.text || '',
      author_id: t.author_id || null,
      timestamp: t.created_at || null,
      metrics: t.public_metrics || null,
      sentiment: analyzeSentiment(t.text || ''),
    };
  });
}

// ── TikTok ────────────────────────────────────────────────────────────────────
/**
 * Lee videos TikTok por hashtag.
 * @param {string} uid
 * @param {{ hashtag, limit }} opts
 * @returns {Array}
 */
async function fetchTikTokMentions(uid, opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit) || 20, 50);
  if (!o.hashtag) throw new Error('hashtag_requerido');
  const creds = await _getCreds(uid, PLATFORM.TIKTOK);
  const url = 'https://open.tiktokapis.com/v2/research/video/query/' +
    '?fields=id,video_description,create_time,view_count,like_count';
  const body = {
    query: { and: [{ operation: 'IN', field_name: 'hashtag_name', field_values: [o.hashtag] }] },
    max_count: limit,
  };
  const res = await _fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + creds.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('tiktok_api_error:' + res.status);
  const data = await res.json();
  const videos = (data.data && data.data.videos) || [];
  return videos.map(function (v) {
    return {
      platform: PLATFORM.TIKTOK,
      external_id: v.id,
      text: v.video_description || '',
      timestamp: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
      metrics: { views: v.view_count || 0, likes: v.like_count || 0 },
      sentiment: analyzeSentiment(v.video_description || ''),
    };
  });
}

// ── Storage ───────────────────────────────────────────────────────────────────
/**
 * Persiste menciones en Firestore con dedup por external_id.
 * @param {string} uid
 * @param {Array} mentions
 * @returns {{ saved, duplicates }}
 */
async function saveMentions(uid, mentions) {
  if (!uid) throw new Error('uid_requerido');
  if (!Array.isArray(mentions)) throw new Error('mentions_invalido');
  let saved = 0;
  let duplicates = 0;
  for (const m of mentions) {
    if (!m.external_id || !m.platform) {
      duplicates++;
      continue;
    }
    const docId = m.platform + '_' + m.external_id;
    const ref = _mentionsCol(uid).doc(docId);
    const snap = await ref.get();
    if (snap.exists) {
      duplicates++;
      continue;
    }
    await ref.set({ ...m, savedAt: new Date().toISOString() });
    saved++;
  }
  console.log('[SOCIAL_READER] uid=' + uid.slice(0, 8) + ' saved=' + saved + ' dup=' + duplicates);
  return { saved, duplicates };
}

/**
 * Pipeline completo: lee de las 3 plataformas conectadas y guarda menciones.
 * @param {string} uid
 * @param {{ hashtag }} opts - hashtag requerido para TikTok
 * @returns {{ total, byPlatform }}
 */
async function syncAllMentions(uid, opts) {
  const o = opts || {};
  if (!uid) throw new Error('uid_requerido');
  const platforms = [PLATFORM.INSTAGRAM, PLATFORM.TWITTER, PLATFORM.TIKTOK];
  const byPlatform = {};
  let total = 0;
  for (const p of platforms) {
    try {
      let mentions;
      if (p === PLATFORM.INSTAGRAM) mentions = await fetchInstagramMentions(uid);
      else if (p === PLATFORM.TWITTER) mentions = await fetchTwitterMentions(uid);
      else mentions = await fetchTikTokMentions(uid, { hashtag: o.hashtag });
      const result = await saveMentions(uid, mentions);
      byPlatform[p] = { saved: result.saved, duplicates: result.duplicates };
      total += result.saved;
    } catch (e) {
      byPlatform[p] = { error: e.message };
    }
  }
  return { total, byPlatform };
}

module.exports = {
  fetchInstagramMentions,
  fetchTwitterMentions,
  fetchTikTokMentions,
  saveMentions,
  syncAllMentions,
  analyzeSentiment,
  PLATFORM,
  SENTIMENT,
  POSITIVE_WORDS,
  NEGATIVE_WORDS,
  __setFirestoreForTests,
  __setFetchForTests,
};
