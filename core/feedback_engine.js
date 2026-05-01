'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const SURVEY_TYPES = Object.freeze(['nps', 'csat', 'star_rating', 'yes_no', 'open_text', 'multi_choice', 'custom']);
const SURVEY_STATUSES = Object.freeze(['draft', 'active', 'paused', 'closed', 'archived']);
const RESPONSE_STATUSES = Object.freeze(['pending', 'submitted', 'processed', 'rejected']);
const NPS_CATEGORIES = Object.freeze({ promoter: 'promoter', passive: 'passive', detractor: 'detractor' });

const MAX_SURVEY_TITLE_LENGTH = 100;
const MAX_SURVEY_QUESTIONS = 20;
const MAX_OPTION_LENGTH = 200;
const MAX_OPEN_TEXT_LENGTH = 2000;
const NPS_MIN = 0;
const NPS_MAX = 10;
const STAR_MIN = 1;
const STAR_MAX = 5;
const CSAT_MIN = 1;
const CSAT_MAX = 5;

function isValidType(t) { return SURVEY_TYPES.includes(t); }
function isValidStatus(s) { return SURVEY_STATUSES.includes(s); }

function classifyNps(score) {
  if (typeof score !== 'number') return null;
  if (score >= 9) return NPS_CATEGORIES.promoter;
  if (score >= 7) return NPS_CATEGORIES.passive;
  return NPS_CATEGORIES.detractor;
}

function buildSurveyId(uid, type) {
  return uid.slice(0, 8) + '_surv_' + type.slice(0, 4) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 4);
}

function buildSurveyRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const type = isValidType(data.type) ? data.type : 'csat';
  const surveyId = data.surveyId || buildSurveyId(uid, type);
  return {
    surveyId,
    uid,
    type,
    title: typeof data.title === 'string' ? data.title.trim().slice(0, MAX_SURVEY_TITLE_LENGTH) : 'Encuesta',
    description: typeof data.description === 'string' ? data.description.trim().slice(0, 500) : '',
    status: isValidStatus(data.status) ? data.status : 'draft',
    questions: Array.isArray(data.questions)
      ? data.questions.slice(0, MAX_SURVEY_QUESTIONS).map((q, i) => buildQuestion(q, i))
      : [],
    triggerEvent: typeof data.triggerEvent === 'string' ? data.triggerEvent : null,
    targetAudience: typeof data.targetAudience === 'string' ? data.targetAudience : 'all',
    responseCount: 0,
    avgScore: null,
    npsScore: null,
    promoterCount: 0,
    passiveCount: 0,
    detractorCount: 0,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function buildQuestion(data, index) {
  data = data || {};
  return {
    questionIndex: index,
    text: typeof data.text === 'string' ? data.text.trim().slice(0, 300) : 'Pregunta ' + (index + 1),
    type: isValidType(data.type) ? data.type : 'csat',
    required: data.required !== false,
    options: Array.isArray(data.options)
      ? data.options.slice(0, 10).map(o => typeof o === 'string' ? o.slice(0, MAX_OPTION_LENGTH) : String(o))
      : [],
    minValue: typeof data.minValue === 'number' ? data.minValue : null,
    maxValue: typeof data.maxValue === 'number' ? data.maxValue : null,
  };
}

function buildResponseRecord(uid, surveyId, data) {
  data = data || {};
  const now = Date.now();
  const responseId = uid.slice(0, 8) + '_resp_' + surveyId.slice(0, 8) + '_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 4);
  return {
    responseId,
    uid,
    surveyId,
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone.trim() : null,
    contactName: typeof data.contactName === 'string' ? data.contactName.trim().slice(0, 100) : null,
    status: 'pending',
    answers: Array.isArray(data.answers) ? data.answers.slice(0, MAX_SURVEY_QUESTIONS) : [],
    score: typeof data.score === 'number' ? data.score : null,
    npsCategory: null,
    openText: typeof data.openText === 'string' ? data.openText.slice(0, MAX_OPEN_TEXT_LENGTH) : null,
    submittedAt: null,
    processedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function submitResponse(response, answers, opts) {
  opts = opts || {};
  const now = Date.now();
  const score = typeof opts.score === 'number' ? opts.score : null;
  const npsCategory = score !== null ? classifyNps(score) : null;
  const openText = typeof opts.openText === 'string' ? opts.openText.slice(0, MAX_OPEN_TEXT_LENGTH) : response.openText;
  return {
    ...response,
    status: 'submitted',
    answers: Array.isArray(answers) ? answers.slice(0, MAX_SURVEY_QUESTIONS) : response.answers,
    score,
    npsCategory,
    openText,
    submittedAt: now,
    updatedAt: now,
  };
}

function computeSurveyAggregates(responses) {
  if (!Array.isArray(responses) || responses.length === 0) {
    return { responseCount: 0, avgScore: null, npsScore: null, promoterCount: 0, passiveCount: 0, detractorCount: 0 };
  }
  const submitted = responses.filter(r => r.status === 'submitted');
  const withScore = submitted.filter(r => typeof r.score === 'number');
  const avgScore = withScore.length > 0
    ? Math.round(withScore.reduce((acc, r) => acc + r.score, 0) / withScore.length * 10) / 10
    : null;
  const promoters = submitted.filter(r => r.npsCategory === 'promoter').length;
  const passives = submitted.filter(r => r.npsCategory === 'passive').length;
  const detractors = submitted.filter(r => r.npsCategory === 'detractor').length;
  const npsTotal = promoters + passives + detractors;
  const npsScore = npsTotal > 0 ? Math.round((promoters - detractors) / npsTotal * 100) : null;
  return {
    responseCount: submitted.length,
    avgScore,
    npsScore,
    promoterCount: promoters,
    passiveCount: passives,
    detractorCount: detractors,
  };
}

function applySurveyAggregates(survey, aggregates) {
  return {
    ...survey,
    responseCount: aggregates.responseCount,
    avgScore: aggregates.avgScore,
    npsScore: aggregates.npsScore,
    promoterCount: aggregates.promoterCount,
    passiveCount: aggregates.passiveCount,
    detractorCount: aggregates.detractorCount,
    updatedAt: Date.now(),
  };
}

function buildFeedbackSummaryText(survey) {
  if (!survey) return 'Encuesta no encontrada.';
  const lines = [];
  const icons = { nps: '\u{1F4CA}', csat: '\u{2B50}', star_rating: '\u{1F31F}', yes_no: '\u{2714}\u{FE0F}', open_text: '\u{1F4AC}', custom: '\u{1F4DD}' };
  const icon = icons[survey.type] || '\u{1F4CB}';
  lines.push(icon + ' *Encuesta: ' + survey.title + '*');
  lines.push('Tipo: ' + survey.type + ' | Estado: ' + survey.status);
  lines.push('Respuestas: ' + survey.responseCount);
  if (survey.avgScore !== null) {
    lines.push('Score promedio: ' + survey.avgScore);
  }
  if (survey.npsScore !== null) {
    lines.push('NPS: ' + survey.npsScore);
    lines.push('Promotores: ' + survey.promoterCount + ' | Pasivos: ' + survey.passiveCount + ' | Detractores: ' + survey.detractorCount);
  }
  return lines.join('\n');
}

async function saveSurvey(uid, survey) {
  console.log('[FEEDBACK] Guardando encuesta uid=' + uid + ' id=' + survey.surveyId + ' type=' + survey.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('surveys').doc(survey.surveyId)
      .set(survey, { merge: false });
    return survey.surveyId;
  } catch (err) {
    console.error('[FEEDBACK] Error guardando encuesta:', err.message);
    throw err;
  }
}

async function getSurvey(uid, surveyId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('surveys').doc(surveyId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[FEEDBACK] Error obteniendo encuesta:', err.message);
    return null;
  }
}

async function saveResponse(uid, surveyId, response) {
  console.log('[FEEDBACK] Guardando respuesta id=' + response.responseId + ' survey=' + surveyId);
  try {
    await db().collection('owners').doc(uid)
      .collection('survey_responses').doc(response.responseId)
      .set(response, { merge: false });
    return response.responseId;
  } catch (err) {
    console.error('[FEEDBACK] Error guardando respuesta:', err.message);
    throw err;
  }
}

async function listResponses(uid, surveyId) {
  try {
    let q = db().collection('owners').doc(uid).collection('survey_responses')
      .where('surveyId', '==', surveyId);
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[FEEDBACK] Error listando respuestas:', err.message);
    return [];
  }
}

async function updateSurvey(uid, surveyId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('surveys').doc(surveyId)
      .set(update, { merge: true });
    return surveyId;
  } catch (err) {
    console.error('[FEEDBACK] Error actualizando encuesta:', err.message);
    throw err;
  }
}

module.exports = {
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
  RESPONSE_STATUSES,
  NPS_CATEGORIES,
  NPS_MIN,
  NPS_MAX,
  STAR_MIN,
  STAR_MAX,
  CSAT_MIN,
  CSAT_MAX,
  MAX_SURVEY_QUESTIONS,
  __setFirestoreForTests,
};
