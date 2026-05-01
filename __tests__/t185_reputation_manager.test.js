'use strict';

const {
  saveReview, getReputationSummary, getRecentReviews,
  buildReviewRequestMessage, parseRatingFromText,
  REVIEW_SOURCES, MIN_RATING, MAX_RATING, MAX_REVIEW_LENGTH,
  DEFAULT_REQUEST_MESSAGE_ES, DEFAULT_REQUEST_MESSAGE_EN,
  __setFirestoreForTests,
} = require('../core/reputation_manager');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ reviews = [], throwSet = false } = {}) {
  const reviewDocs = reviews.map((r, i) => ({ id: 'rev' + i, data: () => r }));
  const allColl = {
    doc: () => ({ set: async (d) => { if (throwSet) throw new Error('set error'); } }),
    get: async () => ({ forEach: fn => reviewDocs.forEach(fn) }),
  };
  const uidDoc = { collection: () => allColl };
  return { collection: () => ({ doc: () => uidDoc }) };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('constants', () => {
  test('MIN_RATING es 1 y MAX_RATING es 5', () => {
    expect(MIN_RATING).toBe(1);
    expect(MAX_RATING).toBe(5);
  });
  test('REVIEW_SOURCES es frozen', () => {
    expect(() => { REVIEW_SOURCES.push('x'); }).toThrow();
  });
  test('REVIEW_SOURCES incluye whatsapp y google', () => {
    expect(REVIEW_SOURCES).toContain('whatsapp');
    expect(REVIEW_SOURCES).toContain('google');
  });
  test('MAX_REVIEW_LENGTH es 1000', () => {
    expect(MAX_REVIEW_LENGTH).toBe(1000);
  });
});

describe('saveReview', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveReview(undefined, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si review undefined', async () => {
    await expect(saveReview(UID, null)).rejects.toThrow('review requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(saveReview(UID, { rating: 4 })).rejects.toThrow('phone requerido');
  });
  test('lanza si rating no es numero', async () => {
    await expect(saveReview(UID, { phone: PHONE, rating: 'bueno' })).rejects.toThrow('debe ser numero');
  });
  test('lanza si rating fuera de rango', async () => {
    await expect(saveReview(UID, { phone: PHONE, rating: 6 })).rejects.toThrow('entre 1 y 5');
    await expect(saveReview(UID, { phone: PHONE, rating: 0 })).rejects.toThrow('entre 1 y 5');
  });
  test('guarda review sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await saveReview(UID, { phone: PHONE, rating: 5, text: 'Excelente!' });
    expect(r.reviewId).toBeDefined();
  });
  test('trunca texto largo', async () => {
    __setFirestoreForTests(makeMockDb());
    const longText = 'A'.repeat(2000);
    const r = await saveReview(UID, { phone: PHONE, rating: 3, text: longText });
    expect(r.reviewId).toBeDefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(saveReview(UID, { phone: PHONE, rating: 4 })).rejects.toThrow('set error');
  });
});

describe('getReputationSummary', () => {
  test('lanza si uid undefined', async () => {
    await expect(getReputationSummary(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna zeros si sin reviews', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await getReputationSummary(UID);
    expect(r.totalReviews).toBe(0);
    expect(r.averageRating).toBe(0);
    expect(r.trend).toBe('neutral');
  });
  test('calcula promedio correctamente', async () => {
    const reviews = [{ rating: 5 }, { rating: 4 }, { rating: 3 }];
    __setFirestoreForTests(makeMockDb({ reviews }));
    const r = await getReputationSummary(UID);
    expect(r.totalReviews).toBe(3);
    expect(r.averageRating).toBe(4);
    expect(r.trend).toBe('positive');
  });
  test('trend negativo cuando hay muchos 1-2', async () => {
    const reviews = [{ rating: 1 }, { rating: 2 }, { rating: 1 }];
    __setFirestoreForTests(makeMockDb({ reviews }));
    const r = await getReputationSummary(UID);
    expect(r.trend).toBe('negative');
  });
  test('fail-open retorna defaults si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { throw new Error('err'); } }) }) }) });
    const r = await getReputationSummary(UID);
    expect(r.totalReviews).toBe(0);
  });
});

describe('getRecentReviews', () => {
  test('lanza si uid undefined', async () => {
    await expect(getRecentReviews(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna reviews ordenadas por fecha', async () => {
    const reviews = [
      { rating: 5, reviewedAt: '2026-05-01T10:00:00Z' },
      { rating: 3, reviewedAt: '2026-05-04T10:00:00Z' },
    ];
    __setFirestoreForTests(makeMockDb({ reviews }));
    const r = await getRecentReviews(UID);
    expect(r[0].rating).toBe(3);
  });
  test('retorna array vacio si sin reviews', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getRecentReviews(UID)).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests({ collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { throw new Error('err'); } }) }) }) });
    expect(await getRecentReviews(UID)).toEqual([]);
  });
});

describe('buildReviewRequestMessage', () => {
  test('retorna mensaje en espanol por default', () => {
    expect(buildReviewRequestMessage()).toBe(DEFAULT_REQUEST_MESSAGE_ES);
  });
  test('retorna mensaje en ingles', () => {
    expect(buildReviewRequestMessage('en')).toBe(DEFAULT_REQUEST_MESSAGE_EN);
  });
  test('retorna mensaje custom si se provee', () => {
    expect(buildReviewRequestMessage('es', 'Mensaje custom')).toBe('Mensaje custom');
  });
});

describe('parseRatingFromText', () => {
  test('retorna null si texto undefined', () => {
    expect(parseRatingFromText(null)).toBeNull();
  });
  test('parsea numero del 1 al 5', () => {
    expect(parseRatingFromText('Le doy un 5!')).toBe(5);
    expect(parseRatingFromText('Mi nota es 3 de 5')).toBe(3);
  });
  test('retorna null si no hay numero valido', () => {
    expect(parseRatingFromText('sin numero aqui')).toBeNull();
  });
  test('retorna null para texto sin ningun digito 1-5', () => {
    expect(parseRatingFromText('perfecto excelente')).toBeNull();
  });
});
