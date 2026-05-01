'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

async function getMessageStats(uid, range = {}) {
  if (!uid) throw new Error('uid required');
  const from = range.from || 0;
  const to = range.to || Date.now();
  const snap = await getDb().collection('conversations').doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const allMessages = [];
  Object.values(data.contacts || {}).forEach(contact => {
    (contact.messages || []).forEach(m => { if (m.timestamp >= from && m.timestamp <= to) allMessages.push(m); });
  });
  const sent = allMessages.filter(m => m.role === 'miia').length;
  const received = allMessages.filter(m => m.role === 'lead').length;
  const byDay = {};
  allMessages.forEach(m => { const d = new Date(m.timestamp).toISOString().split('T')[0]; byDay[d] = (byDay[d] || 0) + 1; });
  return { total: allMessages.length, sent, received, byDay };
}

async function getLeadFunnel(uid, range = {}) {
  if (!uid) throw new Error('uid required');
  const from = range.from || 0;
  const to = range.to || Date.now();
  const snap = await getDb().collection('leads').where('uid', '==', uid).get();
  const leads = [];
  snap.forEach(doc => leads.push(doc.data()));
  const filtered = leads.filter(l => l.createdAt >= from && l.createdAt <= to);
  return {
    new: filtered.length,
    contacted: filtered.filter(l => l.status !== 'new').length,
    converted: filtered.filter(l => l.status === 'converted').length,
    lost: filtered.filter(l => l.status === 'lost').length,
  };
}

async function getTopContacts(uid, limit = 10) {
  if (!uid) throw new Error('uid required');
  const snap = await getDb().collection('conversations').doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const contacts = Object.entries(data.contacts || {}).map(([phone, contact]) => ({
    phone, messageCount: (contact.messages || []).length,
  }));
  contacts.sort((a, b) => b.messageCount - a.messageCount);
  return contacts.slice(0, limit);
}

function exportAnalyticsCSV(uid, stats) {
  if (!uid || !stats) throw new Error('uid and stats required');
  const rows = ['date,total'];
  Object.entries(stats.byDay || {}).sort().forEach(([date, total]) => rows.push(date + ',' + total));
  return rows.join('\n');
}

async function getRetentionRate(uid) {
  if (!uid) throw new Error('uid required');
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const snap = await getDb().collection('leads').where('uid', '==', uid).get();
  const leads = [];
  snap.forEach(doc => leads.push(doc.data()));
  if (leads.length === 0) return 0;
  const active = leads.filter(l => (l.lastSeen || 0) >= thirtyDaysAgo);
  return Math.round((active.length / leads.length) * 100);
}

module.exports = { getMessageStats, getLeadFunnel, getTopContacts, exportAnalyticsCSV, getRetentionRate, __setFirestoreForTests };
