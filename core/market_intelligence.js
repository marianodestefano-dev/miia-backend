'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const INTELLIGENCE_TYPES = Object.freeze(['trend', 'competitor', 'demand', 'price']);
const DEMAND_LEVELS = Object.freeze(['low', 'medium', 'high', 'surge']);

async function recordTrend(sector, metric, value) {
  const entry = { id: randomUUID(), sector, metric, value, recordedAt: new Date().toISOString() };
  await getDb().collection('market_trends').doc(entry.id).set(entry);
  return entry;
}

async function getTrends(sector, opts) {
  opts = opts || {};
  const snap = await getDb().collection('market_trends').where('sector', '==', sector).get();
  const trends = [];
  snap.forEach(doc => trends.push(doc.data()));
  return { sector, trends, count: trends.length };
}

async function alertCompetitor(uid, opts) {
  const { competitorName, triggerType } = opts;
  const alert = { id: randomUUID(), uid, competitorName, triggerType, status: 'active', createdAt: new Date().toISOString() };
  await getDb().collection('competitor_alerts').doc(alert.id).set(alert);
  return alert;
}

function predictDemand(opts) {
  const { season, historicalAvg } = opts || {};
  const seasonMultipliers = { high: 1.4, low: 0.7, normal: 1.0 };
  const multiplier = seasonMultipliers[season] || 1.0;
  const base = historicalAvg || 100;
  const predicted = Math.round(base * multiplier);
  const level = predicted > base * 1.2 ? 'high' : predicted < base * 0.8 ? 'low' : 'medium';
  return { predicted, level, season: season || 'normal', confidence: 0.75 };
}

function getPriceRecommendation(opts) {
  const { demand, cost, competitorAvgPrice } = opts || {};
  const demandMultipliers = { low: 0.9, medium: 1.0, high: 1.15, surge: 1.3 };
  const base = competitorAvgPrice || (cost ? cost * 2 : 100);
  const mult = demandMultipliers[demand] || 1.0;
  const recommended = Math.round(base * mult);
  return { recommendedPrice: recommended, demand, rationale: 'demand_based_adjustment', confidence: 0.7 };
}

module.exports = { __setFirestoreForTests, INTELLIGENCE_TYPES, DEMAND_LEVELS,
  recordTrend, getTrends, alertCompetitor, predictDemand, getPriceRecommendation };