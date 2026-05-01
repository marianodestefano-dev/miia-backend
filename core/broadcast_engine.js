'use strict';

/**
 * MIIA - Broadcast Engine (T242)
 * P3.4 ROADMAP: motor de broadcast y campañas masivas a contactos.
 * Envio programado con rate limiting, filtros por tags, estadisticas.
 */

const BROADCAST_STATUSES = Object.freeze([
  'draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed',
]);

const AUDIENCE_FILTERS = Object.freeze([
  'all', 'leads', 'clients', 'tagged', 'inactive', 'custom',
]);

const MAX_BATCH_SIZE = 50;
const MAX_BROADCASTS_PER_DAY = 3;
const MIN_INTERVAL_MS = 30 * 1000;
const DEFAULT_BATCH_DELAY_MS = 2000;
const BROADCAST_COLLECTION = 'broadcasts';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidStatus(status) {
  return BROADCAST_STATUSES.includes(status);
}

function isValidAudienceFilter(filter) {
  return AUDIENCE_FILTERS.includes(filter);
}

function buildBroadcastRecord(uid, messageTemplate, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!messageTemplate || typeof messageTemplate !== 'string') throw new Error('messageTemplate requerido');
  if (messageTemplate.trim().length === 0) throw new Error('messageTemplate no puede estar vacio');
  var audienceFilter = (opts && opts.audienceFilter && isValidAudienceFilter(opts.audienceFilter))
    ? opts.audienceFilter : 'all';
  var broadcastId = 'bcast_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  return {
    broadcastId,
    uid,
    messageTemplate: messageTemplate.trim(),
    audienceFilter,
    tags: (opts && Array.isArray(opts.tags)) ? opts.tags : [],
    scheduledFor: (opts && opts.scheduledFor) ? opts.scheduledFor : null,
    batchSize: (opts && opts.batchSize) ? Math.min(opts.batchSize, MAX_BATCH_SIZE) : MAX_BATCH_SIZE,
    batchDelayMs: (opts && opts.batchDelayMs) ? opts.batchDelayMs : DEFAULT_BATCH_DELAY_MS,
    status: 'draft',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    stats: {
      total: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    },
    name: (opts && opts.name) ? String(opts.name) : 'Broadcast ' + new Date().toLocaleDateString('es'),
  };
}

async function saveBroadcast(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.broadcastId) throw new Error('record invalido');
  await db().collection('tenants').doc(uid).collection(BROADCAST_COLLECTION).doc(record.broadcastId).set(record);
  console.log('[BROADCAST] Guardado uid=' + uid + ' id=' + record.broadcastId + ' filter=' + record.audienceFilter);
  return record.broadcastId;
}

async function updateBroadcastStatus(uid, broadcastId, status, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  if (!isValidStatus(status)) throw new Error('status invalido: ' + status);
  var update = { status, updatedAt: new Date().toISOString() };
  if (status === 'running') update.startedAt = new Date().toISOString();
  if (status === 'completed' || status === 'cancelled' || status === 'failed') {
    update.completedAt = new Date().toISOString();
  }
  if (opts && opts.stats) {
    update.stats = opts.stats;
  }
  await db().collection('tenants').doc(uid).collection(BROADCAST_COLLECTION).doc(broadcastId).set(update, { merge: true });
  console.log('[BROADCAST] Status actualizado uid=' + uid + ' id=' + broadcastId + ' status=' + status);
}

async function getBroadcast(uid, broadcastId) {
  if (!uid) throw new Error('uid requerido');
  if (!broadcastId) throw new Error('broadcastId requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(BROADCAST_COLLECTION).doc(broadcastId).get();
    if (!snap || !snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[BROADCAST] Error leyendo broadcast: ' + e.message);
    return null;
  }
}

async function getBroadcasts(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  try {
    var snap = await db().collection('tenants').doc(uid).collection(BROADCAST_COLLECTION).get();
    var broadcasts = [];
    snap.forEach(function(doc) { broadcasts.push(doc.data()); });
    if (opts && opts.status) {
      broadcasts = broadcasts.filter(function(b) { return b.status === opts.status; });
    }
    broadcasts.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    return broadcasts.slice(0, opts && opts.limit ? opts.limit : 50);
  } catch (e) {
    console.error('[BROADCAST] Error leyendo broadcasts: ' + e.message);
    return [];
  }
}

async function countTodayBroadcasts(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    var today = new Date().toISOString().slice(0, 10);
    var broadcasts = await getBroadcasts(uid, { limit: 100 });
    return broadcasts.filter(function(b) {
      return (b.createdAt || '').startsWith(today) && b.status !== 'draft' && b.status !== 'cancelled';
    }).length;
  } catch (e) {
    return 0;
  }
}

function filterAudience(contacts, filter, tags) {
  if (!Array.isArray(contacts)) return [];
  if (filter === 'all') return contacts;
  if (filter === 'leads') return contacts.filter(function(c) { return c.type === 'lead' || c.contactType === 'lead'; });
  if (filter === 'clients') return contacts.filter(function(c) { return c.type === 'client' || c.contactType === 'client'; });
  if (filter === 'inactive') {
    var cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return contacts.filter(function(c) { return !c.lastMessageAt || c.lastMessageAt < cutoff; });
  }
  if (filter === 'tagged' && Array.isArray(tags) && tags.length > 0) {
    return contacts.filter(function(c) {
      return Array.isArray(c.tags) && tags.some(function(t) { return c.tags.includes(t); });
    });
  }
  return contacts;
}

function buildBatches(contacts, batchSize) {
  if (!Array.isArray(contacts) || contacts.length === 0) return [];
  var size = batchSize || MAX_BATCH_SIZE;
  var batches = [];
  for (var i = 0; i < contacts.length; i += size) {
    batches.push(contacts.slice(i, i + size));
  }
  return batches;
}

function personalizeMessage(template, contact) {
  if (!template) return '';
  var name = contact.name || contact.phone || 'Cliente';
  return template
    .replace(/\{nombre\}/gi, name)
    .replace(/\{phone\}/gi, contact.phone || '')
    .replace(/\{negocio\}/gi, contact.businessName || '');
}

function buildBroadcastSummaryText(record) {
  if (!record) return '';
  var stats = record.stats || {};
  var lines = [
    '📢 *Broadcast: ' + (record.name || record.broadcastId) + '*',
    'Estado: ' + record.status,
    'Audiencia: ' + record.audienceFilter,
    'Total: ' + (stats.total || 0) + ' | Enviados: ' + (stats.sent || 0) +
      ' | Fallidos: ' + (stats.failed || 0) + ' | Saltados: ' + (stats.skipped || 0),
  ];
  if (record.completedAt) lines.push('Completado: ' + new Date(record.completedAt).toLocaleString('es'));
  return lines.join('\n');
}

module.exports = {
  buildBroadcastRecord,
  saveBroadcast,
  updateBroadcastStatus,
  getBroadcast,
  getBroadcasts,
  countTodayBroadcasts,
  filterAudience,
  buildBatches,
  personalizeMessage,
  buildBroadcastSummaryText,
  isValidStatus,
  isValidAudienceFilter,
  BROADCAST_STATUSES,
  AUDIENCE_FILTERS,
  MAX_BATCH_SIZE,
  MAX_BROADCASTS_PER_DAY,
  MIN_INTERVAL_MS,
  DEFAULT_BATCH_DELAY_MS,
  BROADCAST_COLLECTION,
  __setFirestoreForTests,
};
