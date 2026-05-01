'use strict';

const {
  buildSurveyRecord,
  buildQuestion,
  buildResponseRecord,
  submitResponse,
  computeSurveyAggregates,
  applySurveyAggregates,
  classifyNps,
  buildFeedbackSummaryText,
  saveSurvey,
  getSurvey,
  saveResponse,
  listResponses,
  updateSurvey,
  SURVEY_TYPES,
  SURVEY_STATUSES,
  NPS_CATEGORIES,
  NPS_MIN,
  NPS_MAX,
  MAX_SURVEY_QUESTIONS,
  __setFirestoreForTests,
} = require('../core/feedback_engine');

function makeMockDb() {
  const stored = {};
  return {
    stored,
    db: {
      collection: () => ({
        doc: (uid) => ({
          collection: (subCol) => ({
            doc: (id) => ({
              set: async (data) => {
                if (!stored[uid]) stored[uid] = {};
                if (!stored[uid][subCol]) stored[uid][subCol] = {};
                stored[uid][subCol][id] = { ...data };
              },
              get: async () => {
                const subStore = stored[uid] && stored[uid][subCol];
                const rec = subStore && subStore[id];
                return { exists: !!rec, data: () => rec };
              },
            }),
            where: (field, op, val) => {
              const chain = { filters: [[field, op, val]] };
              chain.where = (f2, op2, v2) => { chain.filters.push([f2, op2, v2]); return chain; };
              chain.get = async () => {
                const all = Object.values((stored[uid] || {})[subCol] || {});
                const filtered = all.filter(r => chain.filters.every(([f, o, v]) => {
                  if (o === '==') return r[f] === v;
                  return true;
                }));
                return {
                  empty: filtered.length === 0,
                  forEach: (fn) => filtered.forEach(d => fn({ data: () => d })),
                };
              };
              return chain;
            },
            get: async () => {
              const all = Object.values((stored[uid] || {})[subCol] || {});
              return {
                empty: all.length === 0,
                forEach: (fn) => all.forEach(d => fn({ data: () => d })),
              };
            },
          }),
        }),
      }),
    },
  };
}

const UID = 'usr_feedback_test_001';

describe('T286 — feedback_engine', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockDb();
    __setFirestoreForTests(mock.db);
  });

  // ─── Constantes ───────────────────────────────────────────────────────────

  describe('Constantes exportadas', () => {
    test('SURVEY_TYPES es frozen con todos los tipos', () => {
      expect(Object.isFrozen(SURVEY_TYPES)).toBe(true);
      expect(SURVEY_TYPES).toContain('nps');
      expect(SURVEY_TYPES).toContain('csat');
      expect(SURVEY_TYPES).toContain('star_rating');
      expect(SURVEY_TYPES).toContain('open_text');
    });

    test('SURVEY_STATUSES es frozen', () => {
      expect(Object.isFrozen(SURVEY_STATUSES)).toBe(true);
      expect(SURVEY_STATUSES).toContain('draft');
      expect(SURVEY_STATUSES).toContain('active');
      expect(SURVEY_STATUSES).toContain('closed');
    });

    test('NPS_CATEGORIES tiene los 3 valores correctos', () => {
      expect(NPS_CATEGORIES.promoter).toBe('promoter');
      expect(NPS_CATEGORIES.passive).toBe('passive');
      expect(NPS_CATEGORIES.detractor).toBe('detractor');
    });

    test('NPS_MIN=0, NPS_MAX=10, MAX_SURVEY_QUESTIONS=20', () => {
      expect(NPS_MIN).toBe(0);
      expect(NPS_MAX).toBe(10);
      expect(MAX_SURVEY_QUESTIONS).toBe(20);
    });
  });

  // ─── classifyNps ──────────────────────────────────────────────────────────

  describe('classifyNps', () => {
    test('9-10 = promoter', () => {
      expect(classifyNps(9)).toBe('promoter');
      expect(classifyNps(10)).toBe('promoter');
    });

    test('7-8 = passive', () => {
      expect(classifyNps(7)).toBe('passive');
      expect(classifyNps(8)).toBe('passive');
    });

    test('0-6 = detractor', () => {
      expect(classifyNps(0)).toBe('detractor');
      expect(classifyNps(5)).toBe('detractor');
      expect(classifyNps(6)).toBe('detractor');
    });

    test('no numero retorna null', () => {
      expect(classifyNps('alto')).toBeNull();
      expect(classifyNps(null)).toBeNull();
    });
  });

  // ─── buildSurveyRecord ────────────────────────────────────────────────────

  describe('buildSurveyRecord', () => {
    test('construye encuesta NPS con defaults', () => {
      const s = buildSurveyRecord(UID, {
        type: 'nps',
        title: 'Encuesta NPS Post-Turno',
        triggerEvent: 'appointment_completed',
      });

      expect(s.uid).toBe(UID);
      expect(s.type).toBe('nps');
      expect(s.title).toBe('Encuesta NPS Post-Turno');
      expect(s.status).toBe('draft');
      expect(s.triggerEvent).toBe('appointment_completed');
      expect(s.responseCount).toBe(0);
      expect(s.avgScore).toBeNull();
      expect(s.npsScore).toBeNull();
    });

    test('type invalido cae a csat', () => {
      const s = buildSurveyRecord(UID, { type: 'telepathy' });
      expect(s.type).toBe('csat');
    });

    test('status invalido cae a draft', () => {
      const s = buildSurveyRecord(UID, { status: 'zombie' });
      expect(s.status).toBe('draft');
    });

    test('title truncado a MAX length', () => {
      const s = buildSurveyRecord(UID, { title: 'x'.repeat(200) });
      expect(s.title.length).toBe(100);
    });

    test('surveyId unico por llamada', () => {
      const s1 = buildSurveyRecord(UID, {});
      const s2 = buildSurveyRecord(UID, {});
      expect(s1.surveyId).not.toBe(s2.surveyId);
    });

    test('preguntas se construyen correctamente', () => {
      const s = buildSurveyRecord(UID, {
        type: 'multi_choice',
        questions: [
          { text: 'Como evaluarias el servicio?', type: 'star_rating' },
          { text: 'Que mejoraras?', type: 'open_text' },
        ],
      });
      expect(s.questions.length).toBe(2);
      expect(s.questions[0].questionIndex).toBe(0);
      expect(s.questions[1].questionIndex).toBe(1);
    });

    test('limita preguntas a MAX_SURVEY_QUESTIONS', () => {
      const questions = Array.from({ length: 25 }, (_, i) => ({ text: 'Q' + i }));
      const s = buildSurveyRecord(UID, { questions });
      expect(s.questions.length).toBe(MAX_SURVEY_QUESTIONS);
    });
  });

  // ─── buildQuestion ────────────────────────────────────────────────────────

  describe('buildQuestion', () => {
    test('construye pregunta con opciones', () => {
      const q = buildQuestion({
        text: 'Cual es tu deporte favorito?',
        type: 'multi_choice',
        options: ['Futbol', 'Basquet', 'Tennis'],
        required: true,
      }, 0);

      expect(q.questionIndex).toBe(0);
      expect(q.text).toBe('Cual es tu deporte favorito?');
      expect(q.options.length).toBe(3);
      expect(q.required).toBe(true);
    });

    test('sin texto usa default', () => {
      const q = buildQuestion({}, 3);
      expect(q.text).toBe('Pregunta 4');
    });

    test('limita opciones a 10', () => {
      const opts = Array.from({ length: 15 }, (_, i) => 'Opcion ' + i);
      const q = buildQuestion({ options: opts }, 0);
      expect(q.options.length).toBe(10);
    });
  });

  // ─── buildResponseRecord / submitResponse ─────────────────────────────────

  describe('buildResponseRecord y submitResponse', () => {
    test('construye respuesta pendiente', () => {
      const survey = buildSurveyRecord(UID, { type: 'nps' });
      const resp = buildResponseRecord(UID, survey.surveyId, {
        contactPhone: '+541155551234',
        contactName: 'Maria Garcia',
      });

      expect(resp.uid).toBe(UID);
      expect(resp.surveyId).toBe(survey.surveyId);
      expect(resp.status).toBe('pending');
      expect(resp.contactPhone).toBe('+541155551234');
      expect(resp.score).toBeNull();
      expect(resp.npsCategory).toBeNull();
    });

    test('submitResponse con score NPS calcula npsCategory', () => {
      const survey = buildSurveyRecord(UID, { type: 'nps' });
      const resp = buildResponseRecord(UID, survey.surveyId, { contactPhone: '+541155551234' });
      const submitted = submitResponse(resp, [], { score: 9, openText: 'Excelente servicio!' });

      expect(submitted.status).toBe('submitted');
      expect(submitted.score).toBe(9);
      expect(submitted.npsCategory).toBe('promoter');
      expect(submitted.openText).toBe('Excelente servicio!');
      expect(submitted.submittedAt).toBeGreaterThan(0);
    });

    test('submitResponse con score 5 = detractor', () => {
      const survey = buildSurveyRecord(UID, { type: 'nps' });
      const resp = buildResponseRecord(UID, survey.surveyId, {});
      const submitted = submitResponse(resp, [], { score: 5 });
      expect(submitted.npsCategory).toBe('detractor');
    });

    test('submitResponse con score 7 = passive', () => {
      const survey = buildSurveyRecord(UID, { type: 'nps' });
      const resp = buildResponseRecord(UID, survey.surveyId, {});
      const submitted = submitResponse(resp, [], { score: 7 });
      expect(submitted.npsCategory).toBe('passive');
    });

    test('submitResponse con answers', () => {
      const survey = buildSurveyRecord(UID, { type: 'multi_choice' });
      const resp = buildResponseRecord(UID, survey.surveyId, {});
      const answers = [{ questionIndex: 0, answer: 'Si' }, { questionIndex: 1, answer: '4' }];
      const submitted = submitResponse(resp, answers, {});
      expect(submitted.answers.length).toBe(2);
      expect(submitted.answers[0].answer).toBe('Si');
    });

    test('responseId es unico', () => {
      const survey = buildSurveyRecord(UID, {});
      const r1 = buildResponseRecord(UID, survey.surveyId, {});
      const r2 = buildResponseRecord(UID, survey.surveyId, {});
      expect(r1.responseId).not.toBe(r2.responseId);
    });
  });

  // ─── computeSurveyAggregates / applySurveyAggregates ─────────────────────

  describe('computeSurveyAggregates', () => {
    test('NPS score: 60% promotores, 20% pasivos, 20% detractores = NPS 40', () => {
      const survey = buildSurveyRecord(UID, { type: 'nps' });
      const responses = [];
      // 6 promotores (score 9)
      for (let i = 0; i < 6; i++) {
        const r = buildResponseRecord(UID, survey.surveyId, {});
        responses.push(submitResponse(r, [], { score: 9 }));
      }
      // 2 pasivos (score 7)
      for (let i = 0; i < 2; i++) {
        const r = buildResponseRecord(UID, survey.surveyId, {});
        responses.push(submitResponse(r, [], { score: 7 }));
      }
      // 2 detractores (score 4)
      for (let i = 0; i < 2; i++) {
        const r = buildResponseRecord(UID, survey.surveyId, {});
        responses.push(submitResponse(r, [], { score: 4 }));
      }

      const agg = computeSurveyAggregates(responses);
      expect(agg.responseCount).toBe(10);
      expect(agg.promoterCount).toBe(6);
      expect(agg.passiveCount).toBe(2);
      expect(agg.detractorCount).toBe(2);
      // NPS = (6-2)/10 * 100 = 40
      expect(agg.npsScore).toBe(40);
      expect(agg.avgScore).toBeCloseTo(7.8, 0); // (6*9 + 2*7 + 2*4)/10 = 7.8
    });

    test('sin respuestas retorna ceros', () => {
      const agg = computeSurveyAggregates([]);
      expect(agg.responseCount).toBe(0);
      expect(agg.avgScore).toBeNull();
      expect(agg.npsScore).toBeNull();
    });

    test('solo respuestas pending no cuentan', () => {
      const survey = buildSurveyRecord(UID, {});
      const pending = buildResponseRecord(UID, survey.surveyId, {});
      const agg = computeSurveyAggregates([pending]);
      expect(agg.responseCount).toBe(0);
    });

    test('applySurveyAggregates actualiza survey con aggregates', () => {
      const survey = buildSurveyRecord(UID, { type: 'nps' });
      const agg = { responseCount: 5, avgScore: 8.2, npsScore: 60, promoterCount: 4, passiveCount: 1, detractorCount: 0 };
      const updated = applySurveyAggregates(survey, agg);
      expect(updated.responseCount).toBe(5);
      expect(updated.avgScore).toBe(8.2);
      expect(updated.npsScore).toBe(60);
      expect(updated.promoterCount).toBe(4);
    });
  });

  // ─── buildFeedbackSummaryText ─────────────────────────────────────────────

  describe('buildFeedbackSummaryText', () => {
    test('genera texto con titulo, tipo, respuestas y NPS', () => {
      let survey = buildSurveyRecord(UID, { type: 'nps', title: 'NPS Post-Turno', status: 'active' });
      survey = applySurveyAggregates(survey, {
        responseCount: 50,
        avgScore: 8.5,
        npsScore: 65,
        promoterCount: 38,
        passiveCount: 7,
        detractorCount: 5,
      });
      const text = buildFeedbackSummaryText(survey);
      expect(text).toContain('NPS Post-Turno');
      expect(text).toContain('nps');
      expect(text).toContain('active');
      expect(text).toContain('50');
      expect(text).toContain('NPS: 65');
      expect(text).toContain('Promotores: 38');
    });

    test('retorna mensaje si survey es null', () => {
      expect(buildFeedbackSummaryText(null)).toBe('Encuesta no encontrada.');
    });
  });

  // ─── Firestore CRUD ───────────────────────────────────────────────────────

  describe('Operaciones Firestore', () => {
    test('saveSurvey + getSurvey funciona', async () => {
      const s = buildSurveyRecord(UID, { type: 'csat', title: 'CSAT Test' });
      await saveSurvey(UID, s);
      const retrieved = await getSurvey(UID, s.surveyId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.title).toBe('CSAT Test');
    });

    test('getSurvey retorna null si no existe', async () => {
      const result = await getSurvey(UID, 'survey_inexistente');
      expect(result).toBeNull();
    });

    test('saveResponse + listResponses funciona', async () => {
      const s = buildSurveyRecord(UID, { type: 'nps' });
      await saveSurvey(UID, s);
      const r1 = buildResponseRecord(UID, s.surveyId, { contactPhone: '+1' });
      const r2 = buildResponseRecord(UID, s.surveyId, { contactPhone: '+2' });
      await saveResponse(UID, s.surveyId, r1);
      await saveResponse(UID, s.surveyId, r2);
      const list = await listResponses(UID, s.surveyId);
      expect(list.length).toBe(2);
    });

    test('listResponses retorna array vacio si no hay', async () => {
      const result = await listResponses(UID, 'survey_sin_respuestas');
      expect(result).toEqual([]);
    });

    test('updateSurvey hace merge', async () => {
      const s = buildSurveyRecord(UID, { type: 'csat' });
      await saveSurvey(UID, s);
      await updateSurvey(UID, s.surveyId, { status: 'active', responseCount: 10 });
      const retrieved = await getSurvey(UID, s.surveyId);
      expect(retrieved.status).toBe('active');
      expect(retrieved.responseCount).toBe(10);
    });
  });
});
