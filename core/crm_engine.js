'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const PIPELINE_STAGES = Object.freeze([
  'lead', 'prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'churned',
]);

const CONTACT_SOURCES = Object.freeze([
  'whatsapp', 'referral', 'web', 'instagram', 'facebook', 'email', 'cold_call', 'event', 'manual', 'import', 'other',
]);

const ACTIVITY_TYPES = Object.freeze([
  'note', 'call', 'email', 'whatsapp', 'meeting', 'task', 'stage_change', 'tag_added', 'tag_removed',
  'follow_up_set', 'deal_created', 'deal_updated', 'custom',
]);

const CRM_STATUSES = Object.freeze(['active', 'inactive', 'archived', 'blocked']);

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_NOTES_LENGTH = 2000;
const MAX_CONTACTS_PER_QUERY = 500;
const SCORE_BASE = 10;

function isValidStage(s) { return PIPELINE_STAGES.includes(s); }
function isValidSource(s) { return CONTACT_SOURCES.includes(s); }
function isValidActivityType(t) { return ACTIVITY_TYPES.includes(t); }

function buildContactId(uid, phone) {
  const cleaned = String(phone).replace(/\D/g, '').slice(-10);
  return uid.slice(0, 8) + '_crm_' + cleaned;
}

function buildCrmContact(uid, data) {
  data = data || {};
  const now = Date.now();
  const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
  const contactId = data.contactId || buildContactId(uid, phone || now.toString(36));
  const stage = isValidStage(data.stage) ? data.stage : 'lead';
  const source = isValidSource(data.source) ? data.source : 'manual';
  const tags = Array.isArray(data.tags)
    ? data.tags.slice(0, MAX_TAGS).map(t => String(t).slice(0, MAX_TAG_LENGTH).toLowerCase().trim()).filter(Boolean)
    : [];

  return {
    contactId,
    uid,
    phone,
    name: typeof data.name === 'string' ? data.name.trim().slice(0, 100) : '',
    email: typeof data.email === 'string' ? data.email.trim().slice(0, 200) : '',
    company: typeof data.company === 'string' ? data.company.trim().slice(0, 100) : '',
    stage,
    source,
    status: CRM_STATUSES.includes(data.status) ? data.status : 'active',
    tags,
    notes: typeof data.notes === 'string' ? data.notes.slice(0, MAX_NOTES_LENGTH) : '',
    leadScore: typeof data.leadScore === 'number' ? Math.max(0, Math.min(100, data.leadScore)) : SCORE_BASE,
    dealValue: typeof data.dealValue === 'number' ? Math.max(0, data.dealValue) : 0,
    currency: typeof data.currency === 'string' ? data.currency.toUpperCase().slice(0, 3) : 'ARS',
    activityCount: typeof data.activityCount === 'number' ? Math.max(0, data.activityCount) : 0,
    lastActivityAt: typeof data.lastActivityAt === 'number' ? data.lastActivityAt : null,
    followUpAt: typeof data.followUpAt === 'number' ? data.followUpAt : null,
    stageChangedAt: now,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

const VALID_TRANSITIONS = {
  lead:        ['prospect', 'qualified', 'lost'],
  prospect:    ['qualified', 'proposal', 'lost'],
  qualified:   ['proposal', 'lost'],
  proposal:    ['negotiation', 'won', 'lost'],
  negotiation: ['won', 'lost'],
  won:         ['churned'],
  lost:        ['lead'],
  churned:     ['lead'],
};

function updatePipelineStage(contact, newStage) {
  if (!isValidStage(newStage)) throw new Error('invalid_stage: ' + newStage);
  const allowed = VALID_TRANSITIONS[contact.stage] || [];
  if (!allowed.includes(newStage)) {
    throw new Error('invalid_transition: ' + contact.stage + ' -> ' + newStage);
  }
  const now = Date.now();
  return { ...contact, stage: newStage, stageChangedAt: now, updatedAt: now };
}

function addTag(contact, tag) {
  if (typeof tag !== 'string' || !tag.trim()) throw new Error('invalid_tag');
  const normalized = tag.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
  if (contact.tags.includes(normalized)) return contact;
  if (contact.tags.length >= MAX_TAGS) throw new Error('max_tags_reached');
  return { ...contact, tags: [...contact.tags, normalized], updatedAt: Date.now() };
}

function removeTag(contact, tag) {
  const normalized = String(tag).trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
  return { ...contact, tags: contact.tags.filter(t => t !== normalized), updatedAt: Date.now() };
}

function setFollowUp(contact, followUpAt) {
  if (typeof followUpAt !== 'number' || followUpAt <= 0) throw new Error('invalid_follow_up_at');
  return { ...contact, followUpAt, updatedAt: Date.now() };
}

function clearFollowUp(contact) {
  return { ...contact, followUpAt: null, updatedAt: Date.now() };
}

function computeLeadScore(contact) {
  let score = SCORE_BASE;
  // Stage advancement
  const stageScores = { lead: 0, prospect: 10, qualified: 20, proposal: 35, negotiation: 45, won: 80, lost: 0, churned: 5 };
  score += stageScores[contact.stage] || 0;
  // Tags (each adds 2 pts, max 20)
  score += Math.min(20, contact.tags.length * 2);
  // Activity count (each adds 1 pt, max 20)
  score += Math.min(20, contact.activityCount);
  // Deal value brackets
  if (contact.dealValue >= 100000) score += 20;
  else if (contact.dealValue >= 10000) score += 10;
  else if (contact.dealValue >= 1000) score += 5;
  // Has email
  if (contact.email) score += 5;
  // Has company
  if (contact.company) score += 3;
  // Recent follow-up
  if (contact.followUpAt && contact.followUpAt > Date.now()) score += 5;
  return Math.max(0, Math.min(100, score));
}

function buildActivityId(uid, contactId) {
  const now = Date.now();
  return uid.slice(0, 6) + '_act_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5);
}

function buildActivityRecord(uid, contactId, data) {
  data = data || {};
  const now = Date.now();
  return {
    activityId: data.activityId || buildActivityId(uid, contactId),
    uid,
    contactId,
    type: isValidActivityType(data.type) ? data.type : 'note',
    body: typeof data.body === 'string' ? data.body.slice(0, 2000) : '',
    outcome: typeof data.outcome === 'string' ? data.outcome.slice(0, 200) : null,
    durationMs: typeof data.durationMs === 'number' ? Math.max(0, data.durationMs) : null,
    performedBy: typeof data.performedBy === 'string' ? data.performedBy.slice(0, 100) : 'system',
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
  };
}

function recordActivity(contact, activity) {
  const now = Date.now();
  return {
    ...contact,
    activityCount: contact.activityCount + 1,
    lastActivityAt: now,
    updatedAt: now,
  };
}

function buildFollowUpRecord(uid, contactId, data) {
  data = data || {};
  const now = Date.now();
  return {
    followUpId: uid.slice(0, 6) + '_fu_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5),
    uid,
    contactId,
    scheduledAt: typeof data.scheduledAt === 'number' ? data.scheduledAt : (now + 24 * 3600 * 1000),
    reason: typeof data.reason === 'string' ? data.reason.slice(0, 300) : '',
    channel: typeof data.channel === 'string' ? data.channel.slice(0, 50) : 'whatsapp',
    status: 'pending',
    completedAt: null,
    createdAt: now,
  };
}

function computeCrmStats(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return {
      total: 0, byStage: {}, wonCount: 0, lostCount: 0,
      conversionRate: 0, avgDealValue: 0, totalPipelineValue: 0, avgLeadScore: 0,
    };
  }
  const byStage = {};
  let wonCount = 0, lostCount = 0, totalDealValue = 0, wonDealValue = 0, totalScore = 0;
  for (const c of contacts) {
    byStage[c.stage] = (byStage[c.stage] || 0) + 1;
    if (c.stage === 'won') { wonCount++; wonDealValue += c.dealValue; }
    if (c.stage === 'lost') lostCount++;
    totalDealValue += c.dealValue;
    totalScore += c.leadScore;
  }
  const closedCount = wonCount + lostCount;
  const conversionRate = closedCount > 0 ? Math.round(wonCount / closedCount * 100 * 100) / 100 : 0;
  const avgDealValue = wonCount > 0 ? Math.round(wonDealValue / wonCount * 100) / 100 : 0;
  const avgLeadScore = Math.round(totalScore / contacts.length * 10) / 10;
  return {
    total: contacts.length,
    byStage,
    wonCount,
    lostCount,
    conversionRate,
    avgDealValue,
    totalPipelineValue: totalDealValue,
    avgLeadScore,
  };
}

function buildCrmSummaryText(contact) {
  if (!contact) return 'Contacto no encontrado.';
  const stageIcons = {
    lead: '\u{1F7E1}', prospect: '\u{1F7E0}', qualified: '\u{1F535}',
    proposal: '\u{1F4CB}', negotiation: '\u{1F91D}', won: '\u{2705}',
    lost: '\u{274C}', churned: '\u{1F504}',
  };
  const icon = stageIcons[contact.stage] || '\u{1F464}';
  const lines = [];
  lines.push(icon + ' *' + (contact.name || contact.phone) + '* — ' + contact.stage.toUpperCase());
  if (contact.company) lines.push('\u{1F3E2} ' + contact.company);
  if (contact.phone) lines.push('\u{1F4F1} ' + contact.phone);
  if (contact.email) lines.push('\u{1F4E7} ' + contact.email);
  lines.push('Score: ' + contact.leadScore + '/100 | Fuente: ' + contact.source);
  if (contact.dealValue > 0) lines.push('Deal: ' + contact.currency + ' ' + contact.dealValue.toLocaleString('es-AR'));
  if (contact.tags.length > 0) lines.push('Tags: ' + contact.tags.join(', '));
  if (contact.followUpAt) lines.push('Follow-up: ' + new Date(contact.followUpAt).toISOString().slice(0, 10));
  lines.push('Actividades: ' + contact.activityCount);
  return lines.join('\n');
}

// ─── Firestore CRUD ──────────────────────────────────────────────────────────

async function saveCrmContact(uid, contact) {
  console.log('[CRM] Guardando contacto uid=' + uid + ' contactId=' + contact.contactId + ' stage=' + contact.stage);
  try {
    await db().collection('owners').doc(uid)
      .collection('crm_contacts').doc(contact.contactId)
      .set(contact, { merge: false });
    return contact.contactId;
  } catch (err) {
    console.error('[CRM] Error guardando contacto:', err.message);
    throw err;
  }
}

async function getCrmContact(uid, contactId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('crm_contacts').doc(contactId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[CRM] Error obteniendo contacto:', err.message);
    return null;
  }
}

async function updateCrmContact(uid, contactId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('crm_contacts').doc(contactId)
      .set(update, { merge: true });
    return contactId;
  } catch (err) {
    console.error('[CRM] Error actualizando contacto:', err.message);
    throw err;
  }
}

async function saveActivity(uid, activity) {
  console.log('[CRM] Guardando actividad id=' + activity.activityId + ' tipo=' + activity.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('crm_activities').doc(activity.activityId)
      .set(activity, { merge: false });
    return activity.activityId;
  } catch (err) {
    console.error('[CRM] Error guardando actividad:', err.message);
    throw err;
  }
}

async function listContactsByStage(uid, stage) {
  try {
    const ref = db().collection('owners').doc(uid).collection('crm_contacts');
    const snap = stage
      ? await ref.where('stage', '==', stage).get()
      : await ref.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results.slice(0, MAX_CONTACTS_PER_QUERY);
  } catch (err) {
    console.error('[CRM] Error listando contactos:', err.message);
    return [];
  }
}

async function listActivitiesByContact(uid, contactId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('crm_activities').where('contactId', '==', contactId).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[CRM] Error listando actividades:', err.message);
    return [];
  }
}

module.exports = {
  buildCrmContact,
  updatePipelineStage,
  addTag,
  removeTag,
  setFollowUp,
  clearFollowUp,
  computeLeadScore,
  buildActivityRecord,
  recordActivity,
  buildFollowUpRecord,
  computeCrmStats,
  buildCrmSummaryText,
  saveCrmContact,
  getCrmContact,
  updateCrmContact,
  saveActivity,
  listContactsByStage,
  listActivitiesByContact,
  PIPELINE_STAGES,
  CONTACT_SOURCES,
  ACTIVITY_TYPES,
  CRM_STATUSES,
  MAX_TAGS,
  __setFirestoreForTests,
};
