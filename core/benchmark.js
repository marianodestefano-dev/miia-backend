'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const BENCHMARK_METRICS = Object.freeze(['response_time_avg', 'conversion_rate', 'messages_per_day', 'lead_retention']);

async function recordMetrics(uid, metrics) {
  const entry = { id: randomUUID(), uid, metrics: { ...metrics }, recordedAt: new Date().toISOString() };
  await getDb().collection('benchmark_data').doc(entry.id).set(entry);
  return entry;
}

async function getSectorBenchmark(sector) {
  const snap = await getDb().collection('benchmark_data').where('metrics.sector', '==', sector).get();
  const values = { response_time_avg: [], conversion_rate: [], messages_per_day: [] };
  snap.forEach(doc => { const m = doc.data().metrics || {}; BENCHMARK_METRICS.forEach(k => { if (m[k] !== undefined && values[k]) values[k].push(m[k]); }); });
  const avg = key => values[key] && values[key].length > 0 ? values[key].reduce((a, b) => a + b, 0) / values[key].length : null;
  return { sector, response_time_avg: avg('response_time_avg'), conversion_rate: avg('conversion_rate'), messages_per_day: avg('messages_per_day'), dataPoints: snap.size || 0 };
}

async function compareOwnerToSector(uid, sector) {
  const ownerSnap = await getDb().collection('benchmark_data').where('uid', '==', uid).get();
  const benchmark = await getSectorBenchmark(sector);
  const ownerMetrics = {};
  ownerSnap.forEach(doc => { Object.assign(ownerMetrics, doc.data().metrics || {}); });
  const diff = {};
  BENCHMARK_METRICS.forEach(key => { if (ownerMetrics[key] !== undefined && benchmark[key] !== null) diff[key] = { owner: ownerMetrics[key], sector: benchmark[key], delta: ownerMetrics[key] - benchmark[key] }; });
  return { uid, sector, comparison: diff };
}

function getFederatedInsight(query) {
  return { query, insight: 'Federated learning insight stub', status: 'stub' };
}

module.exports = { __setFirestoreForTests, BENCHMARK_METRICS, recordMetrics, getSectorBenchmark, compareOwnerToSector, getFederatedInsight };