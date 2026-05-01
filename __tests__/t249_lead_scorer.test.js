'use strict';

const {
  computeLeadScore, buildScoreRecord, computeScoreTrend,
  saveLeadScore, getLeadScore, scoreAndSaveLead, getAllLeadScores, buildScoreText, getScoreLabel,
  SCORE_LABELS, SCORING_SIGNALS, MAX_SCORE, MIN_SCORE,
  __setFirestoreForTests,
} = require('../core/lead_scorer');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('SCORE_LABELS tiene 5 categorias', () => { expect(Object.keys(SCORE_LABELS).length).toBe(5); });
  test('frozen SCORE_LABELS', () => { expect(() => { SCORE_LABELS.vip = {}; }).toThrow(); });
  test('SCORING_SIGNALS tiene 10 senales', () => { expect(SCORING_SIGNALS.length).toBe(10); });
  test('frozen SCORING_SIGNALS', () => { expect(() => { SCORING_SIGNALS.push('x'); }).toThrow(); });
  test('MAX_SCORE es 100', () => { expect(MAX_SCORE).toBe(100); });
  test('MIN_SCORE es 0', () => { expect(MIN_SCORE).toBe(0); });
});

describe('getScoreLabel', () => {
  test('score 0 es spam', () => { expect(getScoreLabel(0).label).toBe('Spam/Bot'); });
  test('score 5 es spam', () => { expect(getScoreLabel(5).label).toBe('Spam/Bot'); });
  test('score 15 es frio', () => { expect(getScoreLabel(15).label).toBe('Frío'); });
  test('score 50 es interesado', () => { expect(getScoreLabel(50).label).toBe('Interesado'); });
  test('score 70 es caliente', () => { expect(getScoreLabel(70).label).toBe('Caliente'); });
  test('score 90 es listo', () => { expect(getScoreLabel(90).label).toBe('Listo para cerrar'); });
  test('score 100 es listo', () => { expect(getScoreLabel(100).label).toBe('Listo para cerrar'); });
  test('score no numero retorna null', () => { expect(getScoreLabel('alto')).toBeNull(); });
});

describe('computeLeadScore', () => {
  test('null retorna 0', () => { expect(computeLeadScore(null)).toBe(0); });
  test('sin senales retorna score base 10', () => { expect(computeLeadScore({})).toBe(10); });
  test('spam/bot fuerza score 5', () => {
    expect(computeLeadScore({ is_spam: true, price_inquired: true })).toBe(5);
  });
  test('bot fuerza score 5', () => {
    expect(computeLeadScore({ is_bot: true })).toBe(5);
  });
  test('consulta de precio suma bastante', () => {
    const score = computeLeadScore({ price_inquired: true, message_count: 3 });
    expect(score).toBeGreaterThanOrEqual(40);
  });
  test('turno solicitado suma mas', () => {
    const score = computeLeadScore({ appointment_requested: true });
    expect(score).toBeGreaterThan(25);
  });
  test('objecion resta puntos', () => {
    const baseScore = computeLeadScore({ price_inquired: true });
    const withObjection = computeLeadScore({ price_inquired: true, objection_raised: true });
    expect(withObjection).toBeLessThan(baseScore);
  });
  test('perfil completo interesado', () => {
    const score = computeLeadScore({
      message_count: 7, question_asked: true, price_inquired: true,
      name_provided: true, replied_quickly: true,
    });
    expect(score).toBeGreaterThanOrEqual(60);
  });
  test('perfil listo para cerrar', () => {
    const score = computeLeadScore({
      message_count: 15, question_asked: true, price_inquired: true,
      name_provided: true, contact_info_shared: true, appointment_requested: true,
      replied_quickly: true, multiple_sessions: true, catalog_viewed: true,
    });
    expect(score).toBeGreaterThanOrEqual(86);
  });
  test('score se clampea entre 0 y 100', () => {
    const score = computeLeadScore({
      message_count: 20, question_asked: true, price_inquired: true,
      name_provided: true, contact_info_shared: true, appointment_requested: true,
      replied_quickly: true, multiple_sessions: true, catalog_viewed: true,
    });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe('buildScoreRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildScoreRecord(undefined, PHONE, 50, {})).toThrow('uid requerido');
  });
  test('lanza si phone undefined', () => {
    expect(() => buildScoreRecord(UID, undefined, 50, {})).toThrow('phone requerido');
  });
  test('lanza si score no es numero', () => {
    expect(() => buildScoreRecord(UID, PHONE, 'fifty', {})).toThrow('score debe ser numero');
  });
  test('construye record correctamente', () => {
    const r = buildScoreRecord(UID, PHONE, 75, { price_inquired: true });
    expect(r.uid).toBe(UID);
    expect(r.phone).toBe(PHONE);
    expect(r.score).toBe(75);
    expect(r.label).toBe('Caliente');
    expect(r.category).toBe('hot');
    expect(r.scoredAt).toBeDefined();
  });
  test('score fuera de rango se clampea', () => {
    const r = buildScoreRecord(UID, PHONE, 150, {});
    expect(r.score).toBe(100);
  });
  test('acepta previousScore en opts', () => {
    const r = buildScoreRecord(UID, PHONE, 70, {}, { previousScore: 40 });
    expect(r.previousScore).toBe(40);
  });
});

describe('computeScoreTrend', () => {
  test('sin score previo es new', () => { expect(computeScoreTrend(50, null)).toBe('new'); });
  test('mejora >10 es rising', () => { expect(computeScoreTrend(70, 50)).toBe('rising'); });
  test('caida >10 es falling', () => { expect(computeScoreTrend(30, 60)).toBe('falling'); });
  test('cambio pequeño es stable', () => { expect(computeScoreTrend(52, 50)).toBe('stable'); });
  test('sin cambio es stable', () => { expect(computeScoreTrend(50, 50)).toBe('stable'); });
});

describe('saveLeadScore', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveLeadScore(undefined, { phone: PHONE })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveLeadScore(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const record = buildScoreRecord(UID, PHONE, 55, {});
    const docId = await saveLeadScore(UID, record);
    expect(docId).toBeDefined();
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const record = buildScoreRecord(UID, PHONE, 55, {});
    await expect(saveLeadScore(UID, record)).rejects.toThrow('set error');
  });
});

describe('getLeadScore', () => {
  test('lanza si uid undefined', async () => {
    await expect(getLeadScore(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getLeadScore(UID, PHONE)).toBeNull();
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getLeadScore(UID, PHONE)).toBeNull();
  });
});

describe('scoreAndSaveLead', () => {
  test('lanza si uid undefined', async () => {
    await expect(scoreAndSaveLead(undefined, PHONE, {})).rejects.toThrow('uid requerido');
  });
  test('calcula y guarda score completo', async () => {
    __setFirestoreForTests(makeMockDb());
    const r = await scoreAndSaveLead(UID, PHONE, { price_inquired: true, message_count: 5 });
    expect(r.score).toBeGreaterThan(30);
    expect(r.label).toBeDefined();
    expect(r.trend).toBe('new');
  });
  test('detecta trend rising si score sube', async () => {
    const docId = PHONE.replace(/\D/g,'').slice(-10);
    const stored = { [docId]: { phone: PHONE, score: 20, label: 'Frío', category: 'cold' } };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await scoreAndSaveLead(UID, PHONE, { price_inquired: true, appointment_requested: true, message_count: 10 });
    expect(r.trend).toBe('rising');
  });
});

describe('getAllLeadScores', () => {
  test('lanza si uid undefined', async () => {
    await expect(getAllLeadScores(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna vacio si no hay scores', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getAllLeadScores(UID)).toEqual([]);
  });
  test('filtra por minScore', async () => {
    const stored = {
      'p1': { phone: '+541', score: 80, category: 'hot' },
      'p2': { phone: '+542', score: 25, category: 'cold' },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getAllLeadScores(UID, { minScore: 50 });
    expect(r.length).toBe(1);
    expect(r[0].score).toBe(80);
  });
  test('filtra por category', async () => {
    const stored = {
      'p1': { phone: '+541', score: 90, category: 'ready' },
      'p2': { phone: '+542', score: 40, category: 'warm' },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getAllLeadScores(UID, { category: 'ready' });
    expect(r.length).toBe(1);
    expect(r[0].category).toBe('ready');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getAllLeadScores(UID)).toEqual([]);
  });
});

describe('buildScoreText', () => {
  test('retorna vacio si null', () => { expect(buildScoreText(null)).toBe(''); });
  test('incluye score y label', () => {
    const record = buildScoreRecord(UID, PHONE, 75, { price_inquired: true });
    record.trend = 'rising';
    const text = buildScoreText(record);
    expect(text).toContain('75');
    expect(text).toContain('Caliente');
    expect(text).toContain('rising');
    expect(text).toContain('price_inquired');
  });
  test('sin senales activas no menciona Señales', () => {
    const record = buildScoreRecord(UID, PHONE, 10, { question_asked: false });
    const text = buildScoreText(record);
    expect(text).not.toContain('question_asked');
  });
});
