'use strict';

const sr = require('../core/social_reader');
const {
  fetchInstagramMentions,
  fetchTwitterMentions,
  fetchTikTokMentions,
  saveMentions,
  syncAllMentions,
  analyzeSentiment,
  PLATFORM,
  SENTIMENT,
  __setFirestoreForTests,
  __setFetchForTests,
} = sr;

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeFetch(status, jsonBody) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(jsonBody !== undefined ? jsonBody : {}),
  });
}

function makeFetchFail(status) {
  return jest.fn().mockResolvedValue({ ok: false, status, json: jest.fn().mockResolvedValue({}) });
}

/**
 * makeDb: factory for Firestore mock supporting integrations + mentions docs.
 * platformCreds: map of platform -> {exists, data} for integrations docs
 * mentionDocs: map of docId -> {exists} for mentions docs
 */
function makeDb(platformCreds, mentionDocs) {
  const mockSet = jest.fn().mockResolvedValue({});
  const mentions = mentionDocs || {};
  const creds = platformCreds || {};

  const integrationDocFn = jest.fn((platform) => ({
    get: jest.fn().mockResolvedValue(creds[platform] || { exists: false, data: () => ({}) }),
  }));
  const mentionDocFn = jest.fn((docId) => ({
    get: jest.fn().mockResolvedValue(mentions[docId] || { exists: false }),
    set: mockSet,
  }));

  const subcollFn = jest.fn((subColName) => {
    if (subColName === 'integrations') return { doc: integrationDocFn };
    return { doc: mentionDocFn };
  });

  const ownerDoc = jest.fn(() => ({ collection: subcollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDoc })) };
  return { db, mockSet, integrationDocFn, mentionDocFn };
}

beforeEach(() => {
  __setFetchForTests(null);
  __setFirestoreForTests(null);
});

// ── analyzeSentiment ──────────────────────────────────────────────────────────

describe('analyzeSentiment', () => {
  test('null -> neutral', () => expect(analyzeSentiment(null)).toBe(SENTIMENT.NEUTRAL));
  test('no string -> neutral', () => expect(analyzeSentiment(123)).toBe(SENTIMENT.NEUTRAL));
  test('vacio -> neutral', () => expect(analyzeSentiment('')).toBe(SENTIMENT.NEUTRAL));
  test('positivo claro', () => expect(analyzeSentiment('Excelente producto, me encanta')).toBe(SENTIMENT.POSITIVE));
  test('negativo claro', () => expect(analyzeSentiment('Pesimo servicio, no recomiendo')).toBe(SENTIMENT.NEGATIVE));
  test('neutral sin keywords', () => expect(analyzeSentiment('Hoy llueve mucho')).toBe(SENTIMENT.NEUTRAL));
  test('empate -> neutral', () => expect(analyzeSentiment('Es genial pero malo')).toBe(SENTIMENT.NEUTRAL));
  test('case insensitive', () => expect(analyzeSentiment('EXCELENTE')).toBe(SENTIMENT.POSITIVE));
});

// ── fetchInstagramMentions ────────────────────────────────────────────────────

describe('fetchInstagramMentions', () => {
  test('no conectado -> throw', async () => {
    const { db } = makeDb({ instagram: { exists: false, data: () => ({}) } });
    __setFirestoreForTests(db);
    await expect(fetchInstagramMentions('uid123456')).rejects.toThrow('instagram_no_conectado');
  });

  test('sin access_token -> throw', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({}) } });
    __setFirestoreForTests(db);
    await expect(fetchInstagramMentions('uid123456')).rejects.toThrow('instagram_creds_incompletos');
  });

  test('sin ig_user_id -> throw', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    await expect(fetchInstagramMentions('uid123456')).rejects.toThrow('instagram_user_id_requerido');
  });

  test('API error -> throw', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({ access_token: 'tok', ig_user_id: 'igid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(401));
    await expect(fetchInstagramMentions('uid123456')).rejects.toThrow('instagram_api_error:401');
  });

  test('OK - lista menciones con sentiment', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({ access_token: 'tok', ig_user_id: 'igid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {
      data: [
        { id: 'm1', caption: 'Excelente!', media_type: 'IMAGE', timestamp: '2026-05-10', permalink: 'https://...' },
      ],
    }));
    const mentions = await fetchInstagramMentions('uid123456');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].platform).toBe('instagram');
    expect(mentions[0].sentiment).toBe('positive');
  });

  test('OK - data vacio -> []', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({ access_token: 'tok', ig_user_id: 'igid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const mentions = await fetchInstagramMentions('uid123456');
    expect(mentions).toEqual([]);
  });

  test('OK - mencion sin caption ni media_type ni timestamp -> defaults', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({ access_token: 'tok', ig_user_id: 'igid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { data: [{ id: 'm2' }] }));
    const mentions = await fetchInstagramMentions('uid123456');
    expect(mentions[0].text).toBe('');
    expect(mentions[0].type).toBe('image');
    expect(mentions[0].url).toBeNull();
    expect(mentions[0].timestamp).toBeNull();
  });

  test('limit > 100 -> capped a 100', async () => {
    const { db } = makeDb({ instagram: { exists: true, data: () => ({ access_token: 'tok', ig_user_id: 'igid' }) } });
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, { data: [] });
    __setFetchForTests(fetchMock);
    await fetchInstagramMentions('uid123456', { limit: 500 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('limit=100');
  });
});

// ── fetchTwitterMentions ──────────────────────────────────────────────────────

describe('fetchTwitterMentions', () => {
  test('no conectado -> throw', async () => {
    const { db } = makeDb({ twitter: { exists: false, data: () => ({}) } });
    __setFirestoreForTests(db);
    await expect(fetchTwitterMentions('uid123456')).rejects.toThrow('twitter_no_conectado');
  });

  test('sin user_id -> throw', async () => {
    const { db } = makeDb({ twitter: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    await expect(fetchTwitterMentions('uid123456')).rejects.toThrow('twitter_user_id_requerido');
  });

  test('API error -> throw', async () => {
    const { db } = makeDb({ twitter: { exists: true, data: () => ({ access_token: 'tok', user_id: 'twid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(429));
    await expect(fetchTwitterMentions('uid123456')).rejects.toThrow('twitter_api_error:429');
  });

  test('OK - lista tweets', async () => {
    const { db } = makeDb({ twitter: { exists: true, data: () => ({ access_token: 'tok', user_id: 'twid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {
      data: [{ id: 't1', text: 'Genial', author_id: 'a1', created_at: '2026-05-10', public_metrics: { likes: 5 } }],
    }));
    const mentions = await fetchTwitterMentions('uid123456');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].sentiment).toBe('positive');
    expect(mentions[0].metrics).toEqual({ likes: 5 });
  });

  test('OK - data vacio -> []', async () => {
    const { db } = makeDb({ twitter: { exists: true, data: () => ({ access_token: 'tok', user_id: 'twid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const mentions = await fetchTwitterMentions('uid123456');
    expect(mentions).toEqual([]);
  });

  test('tweet sin text/author_id/created_at/public_metrics -> defaults', async () => {
    const { db } = makeDb({ twitter: { exists: true, data: () => ({ access_token: 'tok', user_id: 'twid' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { data: [{ id: 't2' }] }));
    const mentions = await fetchTwitterMentions('uid123456');
    expect(mentions[0].text).toBe('');
    expect(mentions[0].author_id).toBeNull();
    expect(mentions[0].timestamp).toBeNull();
    expect(mentions[0].metrics).toBeNull();
  });

  test('limit > 100 -> capped a 100', async () => {
    const { db } = makeDb({ twitter: { exists: true, data: () => ({ access_token: 'tok', user_id: 'twid' }) } });
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, { data: [] });
    __setFetchForTests(fetchMock);
    await fetchTwitterMentions('uid123456', { limit: 500 });
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('max_results=100');
  });
});

// ── fetchTikTokMentions ───────────────────────────────────────────────────────

describe('fetchTikTokMentions', () => {
  test('hashtag null -> throw', async () => {
    await expect(fetchTikTokMentions('uid1')).rejects.toThrow('hashtag_requerido');
  });

  test('no conectado -> throw', async () => {
    const { db } = makeDb({ tiktok: { exists: false, data: () => ({}) } });
    __setFirestoreForTests(db);
    await expect(fetchTikTokMentions('uid123456', { hashtag: 'miia' })).rejects.toThrow('tiktok_no_conectado');
  });

  test('API error -> throw', async () => {
    const { db } = makeDb({ tiktok: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(503));
    await expect(fetchTikTokMentions('uid123456', { hashtag: 'miia' })).rejects.toThrow('tiktok_api_error:503');
  });

  test('OK - lista videos', async () => {
    const { db } = makeDb({ tiktok: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {
      data: { videos: [{ id: 'v1', video_description: 'Amo MIIA', create_time: 1716000000, view_count: 100, like_count: 50 }] },
    }));
    const mentions = await fetchTikTokMentions('uid123456', { hashtag: 'miia' });
    expect(mentions).toHaveLength(1);
    expect(mentions[0].sentiment).toBe('positive');
    expect(mentions[0].metrics.views).toBe(100);
  });

  test('OK - data vacio -> []', async () => {
    const { db } = makeDb({ tiktok: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, {}));
    const mentions = await fetchTikTokMentions('uid123456', { hashtag: 'miia' });
    expect(mentions).toEqual([]);
  });

  test('OK - data sin videos -> []', async () => {
    const { db } = makeDb({ tiktok: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { data: {} }));
    const mentions = await fetchTikTokMentions('uid123456', { hashtag: 'miia' });
    expect(mentions).toEqual([]);
  });

  test('video sin description ni create_time ni metrics -> defaults', async () => {
    const { db } = makeDb({ tiktok: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { data: { videos: [{ id: 'v2' }] } }));
    const mentions = await fetchTikTokMentions('uid123456', { hashtag: 'miia' });
    expect(mentions[0].text).toBe('');
    expect(mentions[0].timestamp).toBeNull();
    expect(mentions[0].metrics).toEqual({ views: 0, likes: 0 });
  });

  test('limit > 50 -> capped a 50', async () => {
    const { db } = makeDb({ tiktok: { exists: true, data: () => ({ access_token: 'tok' }) } });
    __setFirestoreForTests(db);
    const fetchMock = makeFetch(200, { data: { videos: [] } });
    __setFetchForTests(fetchMock);
    await fetchTikTokMentions('uid123456', { hashtag: 'miia', limit: 200 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_count).toBe(50);
  });
});

// ── saveMentions ──────────────────────────────────────────────────────────────

describe('saveMentions', () => {
  test('uid null -> throw', async () => {
    await expect(saveMentions(null, [])).rejects.toThrow('uid_requerido');
  });
  test('mentions no array -> throw', async () => {
    await expect(saveMentions('uid1', null)).rejects.toThrow('mentions_invalido');
  });

  test('mencion sin external_id -> duplicate', async () => {
    const { db } = makeDb({}, {});
    __setFirestoreForTests(db);
    const r = await saveMentions('uid123456', [{ platform: 'instagram', text: 'X' }]);
    expect(r.saved).toBe(0);
    expect(r.duplicates).toBe(1);
  });

  test('mencion sin platform -> duplicate', async () => {
    const { db } = makeDb({}, {});
    __setFirestoreForTests(db);
    const r = await saveMentions('uid123456', [{ external_id: 'x1', text: 'X' }]);
    expect(r.saved).toBe(0);
    expect(r.duplicates).toBe(1);
  });

  test('mencion nueva -> saved', async () => {
    const { db } = makeDb({}, { 'instagram_m1': { exists: false } });
    __setFirestoreForTests(db);
    const r = await saveMentions('uid123456', [{ platform: 'instagram', external_id: 'm1', text: 'hi' }]);
    expect(r.saved).toBe(1);
    expect(r.duplicates).toBe(0);
  });

  test('mencion ya existe -> duplicate', async () => {
    const { db } = makeDb({}, { 'instagram_m1': { exists: true } });
    __setFirestoreForTests(db);
    const r = await saveMentions('uid123456', [{ platform: 'instagram', external_id: 'm1', text: 'hi' }]);
    expect(r.saved).toBe(0);
    expect(r.duplicates).toBe(1);
  });

  test('mezcla nuevas y duplicadas', async () => {
    const { db } = makeDb({}, { 'instagram_m1': { exists: true }, 'twitter_t1': { exists: false } });
    __setFirestoreForTests(db);
    const r = await saveMentions('uid123456', [
      { platform: 'instagram', external_id: 'm1' },
      { platform: 'twitter', external_id: 't1' },
      { external_id: 'no_platform' },
    ]);
    expect(r.saved).toBe(1);
    expect(r.duplicates).toBe(2);
  });
});

// ── syncAllMentions ───────────────────────────────────────────────────────────

describe('syncAllMentions', () => {
  test('uid null -> throw', async () => {
    await expect(syncAllMentions(null)).rejects.toThrow('uid_requerido');
  });

  test('todas las plataformas fallan -> errors registrados', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetchFail(500));
    const r = await syncAllMentions('uid123456', { hashtag: 'miia' });
    expect(r.total).toBe(0);
    expect(r.byPlatform.instagram.error).toBeDefined();
    expect(r.byPlatform.twitter.error).toBeDefined();
    expect(r.byPlatform.tiktok.error).toBeDefined();
  });

  test('una plataforma OK, otras fallan', async () => {
    const creds = {
      instagram: { exists: true, data: () => ({ access_token: 'tok', ig_user_id: 'igid' }) },
      twitter: { exists: false, data: () => ({}) },
      tiktok: { exists: false, data: () => ({}) },
    };
    const { db } = makeDb(creds, {});
    __setFirestoreForTests(db);
    __setFetchForTests(makeFetch(200, { data: [{ id: 'm1', caption: 'hi' }] }));
    const r = await syncAllMentions('uid123456', { hashtag: 'miia' });
    expect(r.total).toBeGreaterThan(0);
    expect(r.byPlatform.instagram.saved).toBe(1);
    expect(r.byPlatform.twitter.error).toBeDefined();
  });
});
