'use strict';

const DASHBOARD_SECTIONS = Object.freeze([
  'overview', 'leads', 'payments', 'conversations', 'broadcasts', 'follow_ups',
]);

const TIMEFRAMES = Object.freeze(['today', 'week', 'month', 'quarter']);

const SNAPSHOT_COLLECTION = 'dashboard_snapshots';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidSection(s) { return DASHBOARD_SECTIONS.includes(s); }
function isValidTimeframe(t) { return TIMEFRAMES.includes(t); }

function getTimeframeRange(timeframe, now) {
  const ts = now || Date.now();
  const msDay = 24 * 60 * 60 * 1000;
  const startOfDay = new Date(ts);
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  switch (timeframe) {
    case 'today':   return { from: dayStart, to: ts };
    case 'week':    return { from: dayStart - 6 * msDay, to: ts };
    case 'month':   return { from: dayStart - 29 * msDay, to: ts };
    case 'quarter': return { from: dayStart - 89 * msDay, to: ts };
    default:        return { from: dayStart, to: ts };
  }
}

function buildOverviewSection(opts = {}) {
  const {
    totalLeads = 0, newLeads = 0, convertedLeads = 0,
    totalRevenue = 0, pendingPayments = 0,
    totalMessages = 0, avgResponseTime = 0,
    pendingFollowUps = 0, broadcastsSent = 0,
  } = opts;
  const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) / 100 : 0;
  return {
    section: 'overview',
    totalLeads,
    newLeads,
    convertedLeads,
    conversionRate,
    totalRevenue,
    pendingPayments,
    totalMessages,
    avgResponseTime,
    pendingFollowUps,
    broadcastsSent,
  };
}

function buildLeadsFunnelData(scoredLeads) {
  if (!Array.isArray(scoredLeads) || scoredLeads.length === 0) {
    return { section: 'leads', total: 0, funnel: {}, topLeads: [] };
  }
  const funnel = { spam: 0, frio: 0, interesado: 0, caliente: 0, listo: 0 };
  for (const lead of scoredLeads) {
    const cat = lead.category || 'frio';
    if (cat === 'spam') funnel.spam++;
    else if (cat === 'cold') funnel.frio++;
    else if (cat === 'warm') funnel.interesado++;
    else if (cat === 'hot') funnel.caliente++;
    else if (cat === 'ready') funnel.listo++;
    else funnel.frio++;
  }
  const topLeads = scoredLeads
    .filter(l => l.category !== 'spam')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5)
    .map(l => ({ phone: l.phone, score: l.score, category: l.category }));
  return { section: 'leads', total: scoredLeads.length, funnel, topLeads };
}

function buildRevenueData(payments, timeframe) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return { section: 'payments', timeframe: timeframe || 'month', total: 0, byStatus: {}, byCurrency: {}, paymentCount: 0 };
  }
  const byStatus = {};
  const byCurrency = {};
  let total = 0;
  for (const p of payments) {
    const status = p.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + (p.amount || 0);
    if (p.status === 'confirmed') {
      const curr = p.currency || 'USD';
      byCurrency[curr] = (byCurrency[curr] || 0) + (p.amount || 0);
      total += p.amount || 0;
    }
  }
  return {
    section: 'payments',
    timeframe: timeframe || 'month',
    total: Math.round(total * 100) / 100,
    byStatus,
    byCurrency,
    paymentCount: payments.length,
  };
}

function buildConversationsSection(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return { section: 'conversations', total: 0, bySentiment: {}, topTopics: [] };
  }
  const bySentiment = {};
  const topicsCount = {};
  for (const c of conversations) {
    const sentiment = (c.sentiment && c.sentiment.label) || 'neutral';
    bySentiment[sentiment] = (bySentiment[sentiment] || 0) + 1;
    if (c.keyMoments) {
      for (const m of c.keyMoments) {
        topicsCount[m.type] = (topicsCount[m.type] || 0) + 1;
      }
    }
  }
  const topTopics = Object.entries(topicsCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
  return { section: 'conversations', total: conversations.length, bySentiment, topTopics };
}

function buildDashboardSnapshot(uid, sections, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!sections || typeof sections !== 'object') throw new Error('sections requerido');
  const timeframe = isValidTimeframe(opts.timeframe) ? opts.timeframe : 'month';
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const snapshotId = uid.slice(0, 8) + '_' + date + '_' + timeframe;
  return {
    snapshotId,
    uid,
    timeframe,
    date,
    sections,
    generatedAt: opts.generatedAt || Date.now(),
  };
}

async function saveDashboardSnapshot(uid, snapshot) {
  if (!uid) throw new Error('uid requerido');
  if (!snapshot || !snapshot.snapshotId) throw new Error('snapshot invalido');
  await db()
    .collection('owners').doc(uid)
    .collection(SNAPSHOT_COLLECTION).doc(snapshot.snapshotId)
    .set(snapshot, { merge: true });
  console.log('[DASHBOARD] Guardado uid=' + uid + ' snapshot=' + snapshot.snapshotId);
  return snapshot.snapshotId;
}

async function getLatestDashboardSnapshot(uid, timeframe) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(SNAPSHOT_COLLECTION)
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    let filtered = docs;
    if (timeframe && isValidTimeframe(timeframe)) {
      filtered = docs.filter(d => d.timeframe === timeframe);
    }
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
    return filtered[0];
  } catch (e) {
    console.error('[DASHBOARD] Error getLatestDashboardSnapshot: ' + e.message);
    return null;
  }
}

function buildDashboardText(snapshot) {
  if (!snapshot) return '';
  const lines = [
    '\u{1F4CA} *Dashboard MIIA* — ' + snapshot.date + ' (' + snapshot.timeframe + ')',
  ];
  const s = snapshot.sections || {};
  if (s.overview) {
    const o = s.overview;
    lines.push('');
    lines.push('\u{1F465} *Leads*: ' + o.totalLeads + ' total | ' + o.newLeads + ' nuevos | ' + Math.round(o.conversionRate * 100) + '% conv');
    lines.push('\u{1F4B0} *Revenue*: $' + (o.totalRevenue || 0) + ' | Pendiente: $' + (o.pendingPayments || 0));
    lines.push('\u{1F4AC} *Mensajes*: ' + o.totalMessages + ' | Resp avg: ' + Math.round(o.avgResponseTime || 0) + 's');
    if (o.pendingFollowUps > 0) lines.push('\u{1F4E8} *Follow-ups pendientes*: ' + o.pendingFollowUps);
  }
  if (s.leads && s.leads.funnel) {
    const f = s.leads.funnel;
    lines.push('');
    lines.push('\u{1F4C8} *Funnel*: ' +
      '\u{1F6AB}' + (f.spam || 0) + ' | ' +
      '\u2744\uFE0F' + (f.frio || 0) + ' | ' +
      '\u{1F7E1}' + (f.interesado || 0) + ' | ' +
      '\u{1F534}' + (f.caliente || 0) + ' | ' +
      '\u2705' + (f.listo || 0));
  }
  return lines.join('\n');
}

module.exports = {
  buildOverviewSection, buildLeadsFunnelData,
  buildRevenueData, buildConversationsSection,
  buildDashboardSnapshot, saveDashboardSnapshot,
  getLatestDashboardSnapshot, buildDashboardText,
  getTimeframeRange, isValidSection, isValidTimeframe,
  DASHBOARD_SECTIONS, TIMEFRAMES,
  __setFirestoreForTests,
};
