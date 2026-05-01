'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const CAMPAIGN_STATUSES = Object.freeze(['draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled', 'failed']);
const CAMPAIGN_TYPES = Object.freeze(['broadcast', 'drip', 'trigger', 'reactivation', 'onboarding', 'promotional', 'custom']);
const CAMPAIGN_CHANNELS = Object.freeze(['whatsapp', 'email', 'sms', 'push', 'multi']);
const TRIGGER_EVENTS = Object.freeze([
  'signup', 'first_purchase', 'abandoned_cart', 'appointment_booked',
  'appointment_completed', 'payment_overdue', 'subscription_expiring',
  'loyalty_tier_up', 'inactivity_30d', 'custom',
]);

const MAX_AUDIENCE_SIZE = 10000;
const MAX_CAMPAIGN_NAME_LENGTH = 100;
const MAX_STEPS_PER_DRIP = 20;
const MIN_STEP_DELAY_MS = 60000; // 1 minuto minimo entre pasos

function isValidStatus(s) { return CAMPAIGN_STATUSES.includes(s); }
function isValidType(t) { return CAMPAIGN_TYPES.includes(t); }
function isValidChannel(c) { return CAMPAIGN_CHANNELS.includes(c); }
function isValidTrigger(e) { return TRIGGER_EVENTS.includes(e); }

function buildCampaignId(uid, type) {
  return uid.slice(0, 8) + '_camp_' + type.slice(0, 4) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 4);
}

function buildCampaignRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const type = isValidType(data.type) ? data.type : 'broadcast';
  const channel = isValidChannel(data.channel) ? data.channel : 'whatsapp';
  const campaignId = data.campaignId || buildCampaignId(uid, type);
  const scheduledAt = typeof data.scheduledAt === 'number' && data.scheduledAt > now
    ? data.scheduledAt : null;
  const status = scheduledAt ? 'scheduled' : 'draft';
  return {
    campaignId,
    uid,
    name: typeof data.name === 'string' ? data.name.trim().slice(0, MAX_CAMPAIGN_NAME_LENGTH) : 'Campana ' + type,
    type,
    channel,
    status,
    triggerEvent: isValidTrigger(data.triggerEvent) ? data.triggerEvent : null,
    templateId: data.templateId || null,
    templateVars: data.templateVars && typeof data.templateVars === 'object' ? { ...data.templateVars } : {},
    audienceSize: 0,
    sentCount: 0,
    deliveredCount: 0,
    openCount: 0,
    clickCount: 0,
    unsubscribeCount: 0,
    errorCount: 0,
    scheduledAt,
    startedAt: null,
    completedAt: null,
    pausedAt: null,
    steps: Array.isArray(data.steps) ? data.steps.slice(0, MAX_STEPS_PER_DRIP) : [],
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 10) : [],
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function buildDripStep(data, index) {
  data = data || {};
  const delayMs = typeof data.delayMs === 'number' && data.delayMs >= MIN_STEP_DELAY_MS
    ? data.delayMs : MIN_STEP_DELAY_MS;
  return {
    stepIndex: index,
    templateId: data.templateId || null,
    body: typeof data.body === 'string' ? data.body.slice(0, 4096) : '',
    subject: typeof data.subject === 'string' ? data.subject.slice(0, 150) : '',
    delayMs,
    condition: typeof data.condition === 'string' ? data.condition : null,
    sentCount: 0,
    openCount: 0,
  };
}

function buildCampaignWithDripSteps(uid, data, stepsData) {
  const campaign = buildCampaignRecord(uid, { ...data, type: 'drip' });
  const steps = Array.isArray(stepsData)
    ? stepsData.slice(0, MAX_STEPS_PER_DRIP).map((s, i) => buildDripStep(s, i))
    : [];
  return { ...campaign, steps };
}

function startCampaign(campaign, audienceSize) {
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    throw new Error('Solo se puede iniciar una campana en draft o scheduled');
  }
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new Error('No se puede iniciar una campana completada o cancelada');
  }
  const now = Date.now();
  const size = typeof audienceSize === 'number' && audienceSize > 0
    ? Math.min(audienceSize, MAX_AUDIENCE_SIZE) : 0;
  return {
    ...campaign,
    status: 'active',
    audienceSize: size,
    startedAt: now,
    updatedAt: now,
  };
}

function pauseCampaign(campaign) {
  if (campaign.status !== 'active') {
    throw new Error('Solo se puede pausar una campana activa');
  }
  const now = Date.now();
  return { ...campaign, status: 'paused', pausedAt: now, updatedAt: now };
}

function resumeCampaign(campaign) {
  if (campaign.status !== 'paused') {
    throw new Error('Solo se puede reanudar una campana pausada');
  }
  const now = Date.now();
  return { ...campaign, status: 'active', pausedAt: null, updatedAt: now };
}

function completeCampaign(campaign) {
  if (campaign.status !== 'active' && campaign.status !== 'paused') {
    throw new Error('Solo se puede completar una campana activa o pausada');
  }
  const now = Date.now();
  return { ...campaign, status: 'completed', completedAt: now, updatedAt: now };
}

function cancelCampaign(campaign) {
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new Error('No se puede cancelar una campana ya completada o cancelada');
  }
  const now = Date.now();
  return { ...campaign, status: 'cancelled', updatedAt: now };
}

function recordSend(campaign, opts) {
  opts = opts || {};
  const sent = (campaign.sentCount || 0) + 1;
  const delivered = opts.delivered ? (campaign.deliveredCount || 0) + 1 : campaign.deliveredCount || 0;
  const errors = opts.error ? (campaign.errorCount || 0) + 1 : campaign.errorCount || 0;
  return {
    ...campaign,
    sentCount: sent,
    deliveredCount: delivered,
    errorCount: errors,
    updatedAt: Date.now(),
  };
}

function computeCampaignStats(campaign) {
  const audienceSize = campaign.audienceSize || 1;
  const sentRate = campaign.audienceSize > 0
    ? Math.round(campaign.sentCount / campaign.audienceSize * 100) : 0;
  const deliveryRate = campaign.sentCount > 0
    ? Math.round(campaign.deliveredCount / campaign.sentCount * 100) : 0;
  const openRate = campaign.deliveredCount > 0
    ? Math.round(campaign.openCount / campaign.deliveredCount * 100) : 0;
  const clickRate = campaign.openCount > 0
    ? Math.round(campaign.clickCount / campaign.openCount * 100) : 0;
  const errorRate = campaign.sentCount > 0
    ? Math.round(campaign.errorCount / campaign.sentCount * 100) : 0;
  return {
    audienceSize: campaign.audienceSize,
    sentCount: campaign.sentCount,
    deliveredCount: campaign.deliveredCount,
    openCount: campaign.openCount,
    clickCount: campaign.clickCount,
    unsubscribeCount: campaign.unsubscribeCount,
    errorCount: campaign.errorCount,
    sentRate,
    deliveryRate,
    openRate,
    clickRate,
    errorRate,
  };
}

function buildCampaignSummaryText(campaign) {
  if (!campaign) return 'Campana no encontrada.';
  const icons = {
    draft: '\u{1F4DD}', scheduled: '\u{1F4C5}', active: '\u{25B6}\u{FE0F}',
    paused: '\u{23F8}\u{FE0F}', completed: '\u{2705}', cancelled: '\u{274C}', failed: '\u{1F525}',
  };
  const icon = icons[campaign.status] || '\u{1F4E2}';
  const lines = [
    icon + ' *Campana: ' + campaign.name + '*',
    'Tipo: ' + campaign.type + ' | Canal: ' + campaign.channel,
    'Estado: ' + campaign.status,
  ];
  if (campaign.audienceSize > 0) {
    const stats = computeCampaignStats(campaign);
    lines.push('Audiencia: ' + campaign.audienceSize);
    lines.push('Enviados: ' + campaign.sentCount + ' (' + stats.sentRate + '%)');
    lines.push('Entregados: ' + campaign.deliveredCount + ' (' + stats.deliveryRate + '%)');
    if (campaign.openCount > 0) lines.push('Aperturas: ' + campaign.openCount + ' (' + stats.openRate + '%)');
    if (campaign.errorCount > 0) lines.push('Errores: ' + campaign.errorCount);
  }
  if (campaign.scheduledAt) {
    lines.push('Programada: ' + new Date(campaign.scheduledAt).toISOString().slice(0, 16));
  }
  if (campaign.steps.length > 0) {
    lines.push('Pasos drip: ' + campaign.steps.length);
  }
  return lines.join('\n');
}

async function saveCampaign(uid, campaign) {
  console.log('[CAMPAIGN] Guardando uid=' + uid + ' id=' + campaign.campaignId + ' type=' + campaign.type + ' status=' + campaign.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('campaigns').doc(campaign.campaignId)
      .set(campaign, { merge: false });
    return campaign.campaignId;
  } catch (err) {
    console.error('[CAMPAIGN] Error guardando campana:', err.message);
    throw err;
  }
}

async function getCampaign(uid, campaignId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('campaigns').doc(campaignId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[CAMPAIGN] Error obteniendo campana:', err.message);
    return null;
  }
}

async function updateCampaign(uid, campaignId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('campaigns').doc(campaignId)
      .set(update, { merge: true });
    return campaignId;
  } catch (err) {
    console.error('[CAMPAIGN] Error actualizando campana:', err.message);
    throw err;
  }
}

async function listCampaigns(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('campaigns');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    if (opts.type && isValidType(opts.type)) {
      q = q.where('type', '==', opts.type);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.channel && rec.channel !== opts.channel) return;
      results.push(rec);
    });
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, opts.limit || 50);
  } catch (err) {
    console.error('[CAMPAIGN] Error listando campanas:', err.message);
    return [];
  }
}

module.exports = {
  buildCampaignRecord,
  buildDripStep,
  buildCampaignWithDripSteps,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  completeCampaign,
  cancelCampaign,
  recordSend,
  computeCampaignStats,
  buildCampaignSummaryText,
  saveCampaign,
  getCampaign,
  updateCampaign,
  listCampaigns,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  CAMPAIGN_CHANNELS,
  TRIGGER_EVENTS,
  MAX_AUDIENCE_SIZE,
  MAX_STEPS_PER_DRIP,
  MIN_STEP_DELAY_MS,
  __setFirestoreForTests,
};
