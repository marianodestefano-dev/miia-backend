'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const EMAIL_TEMPLATE_CATEGORIES = Object.freeze(['promotional', 'transactional', 'newsletter', 'follow_up', 'onboarding']);
const CAMPAIGN_STATUS = Object.freeze(['draft', 'scheduled', 'sending', 'completed', 'paused']);

async function createCampaign(uid, opts) {
  const { name, subject, body, targetSegment } = opts;
  const campaign = { id: randomUUID(), uid, name, subject, body, targetSegment: targetSegment || 'all', status: 'draft', sentCount: 0, openCount: 0, createdAt: new Date().toISOString() };
  await getDb().collection('email_campaigns').doc(campaign.id).set(campaign);
  return campaign;
}

async function createEmailTemplate(uid, opts) {
  const { name, content, variables, category } = opts;
  if (!EMAIL_TEMPLATE_CATEGORIES.includes(category)) throw new Error('Invalid category: ' + category);
  const template = { id: randomUUID(), uid, name, content, variables: variables || [], category, useCount: 0, createdAt: new Date().toISOString() };
  await getDb().collection('email_templates').doc(template.id).set(template);
  return template;
}

function renderEmailTemplate(content, vars) {
  let rendered = content;
  Object.entries(vars || {}).forEach(([k, v]) => { rendered = rendered.replace(new RegExp('\\{' + k + '\\}', 'g'), v); });
  return rendered;
}

async function scheduleEmailWACampaign(uid, opts) {
  const { emailCampaignId, waMessage, sendAtISO } = opts;
  const coord = { id: randomUUID(), uid, emailCampaignId, waMessage, sendAtISO, status: 'scheduled', createdAt: new Date().toISOString() };
  await getDb().collection('coordinated_campaigns').doc(coord.id).set(coord);
  return coord;
}

async function getCampaignStats(uid, campaignId) {
  const doc = await getDb().collection('email_campaigns').doc(campaignId).get();
  if (!doc.exists) throw new Error('Campaign not found: ' + campaignId);
  const d = doc.data();
  const openRate = d.sentCount > 0 ? d.openCount / d.sentCount : 0;
  return { campaignId, name: d.name, sentCount: d.sentCount, openCount: d.openCount, openRate };
}

module.exports = { __setFirestoreForTests, EMAIL_TEMPLATE_CATEGORIES, CAMPAIGN_STATUS,
  createCampaign, createEmailTemplate, renderEmailTemplate, scheduleEmailWACampaign, getCampaignStats };