'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const CAMPAIGN_SOURCES = Object.freeze(['meta_ads', 'google_ads', 'organic', 'qr_code', 'email', 'referral']);

function buildWADeepLink(phone, prefilledMessage) {
  const clean = (phone || '').replace(/[+\s]/g, '');
  const text = prefilledMessage ? '?text=' + encodeURIComponent(prefilledMessage) : '';
  return 'https://wa.me/' + clean + text;
}

async function generateLandingConfig(uid, opts) {
  opts = opts || {};
  if (opts.source && !CAMPAIGN_SOURCES.includes(opts.source)) throw new Error('Invalid source: ' + opts.source);
  const config = { id: randomUUID(), uid, campaign: opts.campaign || 'default', adId: opts.adId || null, source: opts.source || 'organic', utm: opts.utm || {}, clicks: 0, conversions: 0, createdAt: new Date().toISOString() };
  await getDb().collection('landing_configs').doc(config.id).set(config);
  return config;
}

async function trackLandingVisit(configId, visitorData) {
  const ref = getDb().collection('landing_configs').doc(configId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Landing config not found: ' + configId);
  await ref.set({ clicks: (doc.data().clicks || 0) + 1, lastVisitAt: new Date().toISOString() }, { merge: true });
  const visit = { id: randomUUID(), configId, ip: (visitorData || {}).ip || null, visitedAt: new Date().toISOString() };
  await getDb().collection('landing_visits').doc(visit.id).set(visit);
  return visit;
}

async function generateWALink(uid, configId, prefilledMessage) {
  const doc = await getDb().collection('landing_configs').doc(configId).get();
  if (!doc.exists) throw new Error('Config not found: ' + configId);
  const ownerDoc = await getDb().collection('owners').doc(uid).get();
  const ownerData = ownerDoc.exists ? ownerDoc.data() : {};
  const phone = ownerData.phone || ownerData.whatsapp_phone || '';
  return { configId, uid, waLink: buildWADeepLink(phone, prefilledMessage), prefilledMessage: prefilledMessage || null };
}

async function recordConversion(configId) {
  const ref = getDb().collection('landing_configs').doc(configId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Config not found: ' + configId);
  const newCount = (doc.data().conversions || 0) + 1;
  await ref.set({ conversions: newCount, lastConversionAt: new Date().toISOString() }, { merge: true });
  return { configId, conversions: newCount };
}

async function getCampaignStats(uid, campaign) {
  const snap = await getDb().collection('landing_configs').where('uid', '==', uid).get();
  let clicks = 0, conversions = 0, configs = 0;
  snap.forEach(doc => { const d = doc.data(); if (!campaign || d.campaign === campaign) { clicks += d.clicks || 0; conversions += d.conversions || 0; configs++; } });
  return { uid, campaign: campaign || 'all', totalClicks: clicks, totalConversions: conversions, conversionRate: clicks > 0 ? conversions / clicks : 0, configs };
}

module.exports = { __setFirestoreForTests, CAMPAIGN_SOURCES,
  buildWADeepLink, generateLandingConfig, trackLandingVisit, generateWALink, recordConversion, getCampaignStats };