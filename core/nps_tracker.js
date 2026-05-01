'use strict';

/**
 * MIIA — NPS Tracker (T194)
 * Seguimiento de Net Promoter Score por cohort de clientes.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const NPS_MIN = 0;
const NPS_MAX = 10;
const PROMOTER_MIN = 9;
const PASSIVE_MIN = 7;
const DEFAULT_COHORT = 'default';
const DEFAULT_PERIOD_DAYS = 90;

function classifyNPS(score) {
  if (typeof score !== 'number' || score < NPS_MIN || score > NPS_MAX) throw new Error('score debe ser numero entre 0 y 10');
  if (score >= PROMOTER_MIN) return 'promoter';
  if (score >= PASSIVE_MIN) return 'passive';
  return 'detractor';
}

function calculateNPSScore(promoters, passives, detractors) {
  const total = promoters + passives + detractors;
  if (total === 0) return 0;
  return Math.round(((promoters - detractors) / total) * 100);
}

async function recordNPSResponse(uid, phone, score, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (typeof score !== 'number' || score < NPS_MIN || score > NPS_MAX) throw new Error('score debe ser numero entre 0 y 10');
  opts = opts || {};
  const cohort = opts.cohort || DEFAULT_COHORT;
  const comment = opts.comment || null;
  const category = classifyNPS(score);
  const docId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  const data = {
    uid, phone, score, category, cohort,
    comment: comment ? comment.substring(0, 1000) : null,
    recordedAt: new Date().toISOString(),
  };
  try {
    await db().collection('nps_responses').doc(uid).collection('by_cohort').doc(cohort)
      .collection('responses').doc(docId).set(data);
    console.log('[NPS_TRACKER] uid=' + uid.substring(0, 8) + ' score=' + score + ' category=' + category + ' cohort=' + cohort);
  } catch (e) {
    console.error('[NPS_TRACKER] Error guardando NPS uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

async function getCohortNPS(uid, cohort, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const c = cohort || DEFAULT_COHORT;
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const fromDate = new Date(now - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const snap = await db().collection('nps_responses').doc(uid).collection('by_cohort').doc(c)
      .collection('responses').where('recordedAt', '>=', fromDate).get();
    let promoters = 0, passives = 0, detractors = 0;
    const responses = [];
    snap.forEach(doc => {
      const data = doc.data();
      responses.push(data);
      if (data.category === 'promoter') promoters++;
      else if (data.category === 'passive') passives++;
      else detractors++;
    });
    const npsScore = calculateNPSScore(promoters, passives, detractors);
    return {
      cohort: c,
      npsScore,
      promoters, passives, detractors,
      total: responses.length,
      periodDays: DEFAULT_PERIOD_DAYS,
    };
  } catch (e) {
    console.error('[NPS_TRACKER] Error leyendo cohort uid=' + uid.substring(0, 8) + ': ' + e.message);
    return { cohort: c, npsScore: 0, promoters: 0, passives: 0, detractors: 0, total: 0, periodDays: DEFAULT_PERIOD_DAYS };
  }
}

async function getAllCohortNPS(uid, cohorts) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(cohorts) || cohorts.length === 0) return [];
  const results = await Promise.all(cohorts.map(c => getCohortNPS(uid, c)));
  return results;
}

async function getNPSTrend(uid, cohort, nowMs) {
  if (!uid) throw new Error('uid requerido');
  const now = (typeof nowMs === 'number') ? nowMs : Date.now();
  const c = cohort || DEFAULT_COHORT;
  const current = await getCohortNPS(uid, c, now);
  const previous = await getCohortNPS(uid, c, now - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const change = current.npsScore - previous.npsScore;
  const trend = change > 5 ? 'improving' : change < -5 ? 'declining' : 'stable';
  return { current, previous, change, trend };
}

async function getDetractors(uid, cohort) {
  if (!uid) throw new Error('uid requerido');
  const c = cohort || DEFAULT_COHORT;
  try {
    const snap = await db().collection('nps_responses').doc(uid).collection('by_cohort').doc(c)
      .collection('responses').where('category', '==', 'detractor').get();
    const results = [];
    snap.forEach(doc => results.push(doc.data()));
    return results.sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
  } catch (e) {
    console.error('[NPS_TRACKER] Error leyendo detractors: ' + e.message);
    return [];
  }
}

module.exports = {
  classifyNPS,
  calculateNPSScore,
  recordNPSResponse,
  getCohortNPS,
  getAllCohortNPS,
  getNPSTrend,
  getDetractors,
  NPS_MIN, NPS_MAX, PROMOTER_MIN, PASSIVE_MIN,
  DEFAULT_COHORT, DEFAULT_PERIOD_DAYS,
  __setFirestoreForTests,
};
