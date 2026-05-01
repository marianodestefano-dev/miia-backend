'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const EMAIL_STATUSES = Object.freeze(['draft', 'queued', 'sending', 'sent', 'failed', 'bounced', 'cancelled']);
const EMAIL_TYPES = Object.freeze([
  'transactional', 'promotional', 'reminder', 'follow_up',
  'welcome', 're_engagement', 'notification', 'custom',
]);
const EMAIL_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

const MAX_SUBJECT_LENGTH = 150;
const MAX_BODY_LENGTH = 50000;
const MAX_RECIPIENTS_PER_EMAIL = 500;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE_KB = 2048;
const MAX_TAGS = 10;

function isValidStatus(s) { return EMAIL_STATUSES.includes(s); }
function isValidType(t) { return EMAIL_TYPES.includes(t); }
function isValidPriority(p) { return EMAIL_PRIORITIES.includes(p); }

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function buildEmailId(uid, type) {
  const now = Date.now();
  return uid.slice(0, 8) + '_email_' + type.slice(0, 8) + '_' + now.toString(36);
}

function buildEmailRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const emailType = isValidType(data.type) ? data.type : 'custom';
  const emailId = data.emailId || buildEmailId(uid, emailType);
  const recipients = Array.isArray(data.recipients)
    ? data.recipients.filter(r => typeof r === 'string' && isValidEmail(r)).slice(0, MAX_RECIPIENTS_PER_EMAIL)
    : [];
  return {
    emailId,
    uid,
    type: emailType,
    status: isValidStatus(data.status) ? data.status : 'draft',
    priority: isValidPriority(data.priority) ? data.priority : 'normal',
    from: typeof data.from === 'string' && isValidEmail(data.from) ? data.from.trim() : null,
    fromName: typeof data.fromName === 'string' ? data.fromName.trim().slice(0, 100) : null,
    replyTo: typeof data.replyTo === 'string' && isValidEmail(data.replyTo) ? data.replyTo.trim() : null,
    subject: typeof data.subject === 'string' ? data.subject.trim().slice(0, MAX_SUBJECT_LENGTH) : '',
    bodyText: typeof data.bodyText === 'string' ? data.bodyText.slice(0, MAX_BODY_LENGTH) : '',
    bodyHtml: typeof data.bodyHtml === 'string' ? data.bodyHtml.slice(0, MAX_BODY_LENGTH) : '',
    recipients,
    recipientCount: recipients.length,
    tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string').slice(0, MAX_TAGS) : [],
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    scheduledAt: typeof data.scheduledAt === 'number' ? data.scheduledAt : null,
    sentAt: null,
    failedAt: null,
    openCount: 0,
    clickCount: 0,
    bounceCount: 0,
    unsubscribeCount: 0,
    externalId: null,
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function validateEmailData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return { valid: false, errors: ['data debe ser objeto'] };
  if (!data.subject || typeof data.subject !== 'string' || data.subject.trim().length === 0) {
    errors.push('subject es obligatorio');
  }
  if (data.subject && data.subject.length > MAX_SUBJECT_LENGTH) {
    errors.push('subject excede ' + MAX_SUBJECT_LENGTH + ' caracteres');
  }
  if (!data.bodyText && !data.bodyHtml) {
    errors.push('bodyText o bodyHtml es obligatorio');
  }
  if (data.from && !isValidEmail(data.from)) {
    errors.push('from no es email valido');
  }
  if (Array.isArray(data.recipients)) {
    const invalid = data.recipients.filter(r => !isValidEmail(r));
    if (invalid.length > 0) {
      errors.push('recipients invalidos: ' + invalid.slice(0, 3).join(', '));
    }
    if (data.recipients.length > MAX_RECIPIENTS_PER_EMAIL) {
      errors.push('recipients excede maximo (' + MAX_RECIPIENTS_PER_EMAIL + ')');
    }
  }
  return { valid: errors.length === 0, errors };
}

function addRecipients(email, newRecipients) {
  if (!Array.isArray(newRecipients)) throw new Error('newRecipients debe ser array');
  const valid = newRecipients.filter(r => typeof r === 'string' && isValidEmail(r));
  const existing = new Set(email.recipients);
  const combined = [...existing];
  for (const r of valid) {
    if (!existing.has(r)) combined.push(r);
  }
  if (combined.length > MAX_RECIPIENTS_PER_EMAIL) {
    throw new Error('Total recipients excede MAX_RECIPIENTS_PER_EMAIL (' + MAX_RECIPIENTS_PER_EMAIL + ')');
  }
  return { ...email, recipients: combined, recipientCount: combined.length, updatedAt: Date.now() };
}

function removeRecipient(email, recipientEmail) {
  const filtered = email.recipients.filter(r => r !== recipientEmail);
  return { ...email, recipients: filtered, recipientCount: filtered.length, updatedAt: Date.now() };
}

function scheduleEmail(email, scheduledAt) {
  if (email.status !== 'draft') throw new Error('Solo emails en draft pueden programarse');
  if (typeof scheduledAt !== 'number' || scheduledAt <= Date.now()) {
    throw new Error('scheduledAt debe ser timestamp futuro');
  }
  return { ...email, status: 'queued', scheduledAt, updatedAt: Date.now() };
}

function buildEmailStats(email) {
  const total = email.recipientCount || 0;
  const openRate = total > 0 ? Math.round((email.openCount / total) * 100) : 0;
  const clickRate = total > 0 ? Math.round((email.clickCount / total) * 100) : 0;
  const bounceRate = total > 0 ? Math.round((email.bounceCount / total) * 100) : 0;
  return {
    total,
    openCount: email.openCount || 0,
    clickCount: email.clickCount || 0,
    bounceCount: email.bounceCount || 0,
    unsubscribeCount: email.unsubscribeCount || 0,
    openRate,
    clickRate,
    bounceRate,
  };
}

function buildEmailSummaryText(email) {
  if (!email) return 'Email no encontrado.';
  const parts = [];
  const icons = {
    draft: '\u{1F4DD}', queued: '\u{23F3}', sending: '\u{1F4E4}',
    sent: '\u{2705}', failed: '\u{274C}', bounced: '\u{26A0}\uFE0F', cancelled: '\u{1F6AB}',
  };
  const icon = icons[email.status] || '\u{1F4E7}';
  parts.push(icon + ' ' + (email.subject || '(sin asunto)').slice(0, 60));
  parts.push('Tipo: ' + email.type + ' | Estado: ' + email.status);
  parts.push('Destinatarios: ' + (email.recipientCount || 0));
  if (email.status === 'sent') {
    const stats = buildEmailStats(email);
    parts.push('Aperturas: ' + stats.openCount + ' (' + stats.openRate + '%) | Clicks: ' + stats.clickCount);
    if (stats.bounceCount > 0) parts.push('Rebotes: ' + stats.bounceCount);
  }
  if (email.scheduledAt) {
    parts.push('Programado: ' + new Date(email.scheduledAt).toISOString().slice(0, 16));
  }
  return parts.join('\n');
}

async function saveEmail(uid, email) {
  console.log('[EMAIL] Guardando email uid=' + uid + ' id=' + email.emailId + ' type=' + email.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('emails').doc(email.emailId)
      .set(email, { merge: false });
    return email.emailId;
  } catch (err) {
    console.error('[EMAIL] Error guardando email:', err.message);
    throw err;
  }
}

async function getEmail(uid, emailId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('emails').doc(emailId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[EMAIL] Error obteniendo email:', err.message);
    return null;
  }
}

async function updateEmailStatus(uid, emailId, status, extraFields) {
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  const now = Date.now();
  const update = { status, updatedAt: now, ...(extraFields || {}) };
  if (status === 'sent') update.sentAt = now;
  if (status === 'failed') update.failedAt = now;
  console.log('[EMAIL] Actualizando status uid=' + uid + ' id=' + emailId + ' -> ' + status);
  try {
    await db().collection('owners').doc(uid)
      .collection('emails').doc(emailId)
      .set(update, { merge: true });
    return emailId;
  } catch (err) {
    console.error('[EMAIL] Error actualizando status:', err.message);
    throw err;
  }
}

async function listEmails(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('emails');
    if (opts.status && isValidStatus(opts.status)) {
      q = q.where('status', '==', opts.status);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.type && rec.type !== opts.type) return;
      results.push(rec);
    });
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(0, opts.limit || 100);
  } catch (err) {
    console.error('[EMAIL] Error listando emails:', err.message);
    return [];
  }
}

async function updateEmailStats(uid, emailId, statsUpdate) {
  const allowed = ['openCount', 'clickCount', 'bounceCount', 'unsubscribeCount', 'externalId'];
  const update = { updatedAt: Date.now() };
  allowed.forEach(k => { if (statsUpdate[k] !== undefined) update[k] = statsUpdate[k]; });
  try {
    await db().collection('owners').doc(uid)
      .collection('emails').doc(emailId)
      .set(update, { merge: true });
    return emailId;
  } catch (err) {
    console.error('[EMAIL] Error actualizando stats:', err.message);
    throw err;
  }
}

module.exports = {
  buildEmailRecord,
  validateEmailData,
  addRecipients,
  removeRecipient,
  scheduleEmail,
  buildEmailStats,
  buildEmailSummaryText,
  saveEmail,
  getEmail,
  updateEmailStatus,
  listEmails,
  updateEmailStats,
  isValidEmail,
  EMAIL_STATUSES,
  EMAIL_TYPES,
  EMAIL_PRIORITIES,
  MAX_SUBJECT_LENGTH,
  MAX_BODY_LENGTH,
  MAX_RECIPIENTS_PER_EMAIL,
  __setFirestoreForTests,
};
