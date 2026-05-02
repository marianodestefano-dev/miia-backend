'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const AI_MODELS = Object.freeze(['gemini-1.5-pro', 'miia-v1-finetuned', 'miia-v2-latam']);
const AB_TEST_METRICS = Object.freeze(['response_quality', 'latency_ms', 'conversion_rate']);

async function recordFineTuningData(uid, opts) {
  const { input, expectedOutput } = opts;
  const entry = { id: randomUUID(), uid, input, expectedOutput, approved: false, recordedAt: new Date().toISOString() };
  await getDb().collection('finetuning_data').doc(entry.id).set(entry);
  return entry;
}

async function getFineTuningDataset(sector) {
  const snap = await getDb().collection('finetuning_data').where('sector', '==', sector).get();
  const dataset = [];
  snap.forEach(doc => { const d = doc.data(); if (d.approved) dataset.push(d); });
  return { sector, count: dataset.length, dataset };
}

async function scheduleABTest(uid, opts) {
  const { modelA, modelB, metric } = opts;
  if (!AI_MODELS.includes(modelA)) throw new Error('Invalid modelA: ' + modelA);
  if (!AI_MODELS.includes(modelB)) throw new Error('Invalid modelB: ' + modelB);
  if (!AB_TEST_METRICS.includes(metric)) throw new Error('Invalid metric: ' + metric);
  const test = { id: randomUUID(), uid, modelA, modelB, metric, results: {}, status: 'scheduled', createdAt: new Date().toISOString() };
  await getDb().collection('ai_ab_tests').doc(test.id).set(test);
  return test;
}

async function recordABTestResult(testId, opts) {
  const { model, score, latency } = opts;
  const ref = getDb().collection('ai_ab_tests').doc(testId);
  const update = { ['results.' + model]: { score, latency, recordedAt: new Date().toISOString() }, status: 'running' };
  await ref.set(update, { merge: true });
  return { testId, model, score };
}

async function getRecommendedModel(uid) {
  const snap = await getDb().collection('ai_ab_tests').where('uid', '==', uid).get();
  const tests = [];
  snap.forEach(doc => tests.push(doc.data()));
  const completed = tests.filter(t => t.status === 'completed' && t.results);
  if (completed.length === 0) return { uid, recommendedModel: 'gemini-1.5-pro', reason: 'no_ab_data' };
  return { uid, recommendedModel: completed[0].modelB || 'gemini-1.5-pro', reason: 'ab_test_winner' };
}

module.exports = { __setFirestoreForTests, AI_MODELS, AB_TEST_METRICS,
  recordFineTuningData, getFineTuningDataset, scheduleABTest, recordABTestResult, getRecommendedModel };