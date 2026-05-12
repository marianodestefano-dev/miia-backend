'use strict';

/**
 * R17-A — dashboard_sections.js (Piso 2 P2.2 — 8 secciones restantes)
 * GET  /api/owner/contacts?q=texto
 * GET  /api/owner/business
 * PUT  /api/owner/business
 * GET  /api/owner/agenda/upcoming
 * GET  /api/owner/conversations?context=X&limit=20
 * GET  /api/owner/learning/status
 * GET  /api/owner/plan
 */

const VALID_CONTEXTS = ['leads', 'clientes', 'familia', 'equipo', 'selfchat'];
const DEFAULT_CONTACT_LIMIT = 50;
const DEFAULT_CONV_LIMIT = 20;
const MAX_CONV_LIMIT = 100;
const UPCOMING_DAYS = 7;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _ownerDoc(uid) {
  return db().collection('owners').doc(uid);
}

function _ownerCol(uid, col) {
  return db().collection('owners').doc(uid).collection(col);
}

// ── CONTACTOS ─────────────────────────────────────────────────────────────────
async function getContacts(uid, q) {
  const snap = await _ownerCol(uid, 'contacts').get();
  let contacts = [];
  snap.forEach(function (doc) {
    const d = doc.data();
    contacts.push({
      phone: doc.id,
      name: d.name || doc.id,
      contextType: d.contextType || 'lead',
      lastActivity: d.lastActivity || null,
      avatar: (d.name || doc.id).slice(0, 1).toUpperCase(),
    });
  });
  if (q) {
    const ql = q.toLowerCase();
    contacts = contacts.filter(function (c) {
      return c.name.toLowerCase().includes(ql) || c.phone.includes(ql);
    });
  }
  return contacts.slice(0, DEFAULT_CONTACT_LIMIT);
}

// ── NEGOCIOS ──────────────────────────────────────────────────────────────────
async function getBusiness(uid) {
  const snap = await _ownerDoc(uid).get();
  const d = snap.exists ? snap.data() : {};
  return {
    name: d.business_name || d.name || '',
    phone: d.phone || '',
    timezone: d.timezone || 'America/Bogota',
    horario: d.horario || null,
    activa: d.activa !== false,
    sedes: Array.isArray(d.sedes) ? d.sedes : [],
  };
}

async function updateBusiness(uid, payload) {
  const p = payload || /* istanbul ignore next */ {};
  const update = {};
  if (p.name) update.business_name = p.name;
  if (p.phone) update.phone = p.phone;
  if (p.timezone) update.timezone = p.timezone;
  if (p.horario !== undefined) update.horario = p.horario;
  if (Array.isArray(p.sedes)) update.sedes = p.sedes;
  if (!Object.keys(update).length) throw new Error('sin_campos_validos');
  update.updatedAt = new Date().toISOString();
  await _ownerDoc(uid).set(update, { merge: true });
  return { ok: true };
}

// ── AGENDA ────────────────────────────────────────────────────────────────────
async function getUpcomingEvents(uid) {
  const now = Date.now();
  const cutoff = now + UPCOMING_DAYS * 24 * 60 * 60 * 1000;
  const snap = await _ownerCol(uid, 'calendar_events')
    .where('startTs', '>=', now)
    .where('startTs', '<=', cutoff)
    .orderBy('startTs', 'asc')
    .get();
  const events = [];
  snap.forEach(function (doc) {
    const d = doc.data();
    events.push({
      id: doc.id,
      title: d.title || '',
      startTs: d.startTs,
      endTs: d.endTs || null,
      location: d.location || null,
      calendarId: d.calendarId || null,
    });
  });
  return events;
}

// ── CONVERSACIONES ────────────────────────────────────────────────────────────
async function getConversations(uid, opts) {
  const o = opts || /* istanbul ignore next */ {};
  const lim = Math.min(parseInt(o.limit) || DEFAULT_CONV_LIMIT, MAX_CONV_LIMIT);
  let query = _ownerCol(uid, 'conversations')
    .orderBy('lastMessageTs', 'desc')
    .limit(lim);
  if (o.context) query = query.where('contextType', '==', o.context);
  const snap = await query.get();
  const convs = [];
  snap.forEach(function (doc) {
    const d = doc.data();
    convs.push({
      phone: doc.id,
      name: d.name || doc.id,
      contextType: d.contextType || 'lead',
      lastMessage: d.lastMessage || '',
      lastMessageTs: d.lastMessageTs || null,
      unread: d.unread || 0,
    });
  });
  return convs;
}

// ── APRENDIZAJE ───────────────────────────────────────────────────────────────
async function getLearningStatus(uid) {
  let gamification = null;
  try {
    const gSnap = await _ownerCol(uid, 'gamification').doc('status').get();
    gamification = gSnap.exists ? gSnap.data() : null;
  } catch (_) { /* non-critical */ }

  let pendingApprovals = 0;
  try {
    const pSnap = await _ownerCol(uid, 'training_data')
      .where('pending_approval', '==', true).get();
    pendingApprovals = pSnap.size || 0;
  } catch (_) { /* non-critical */ }

  return {
    gamification_nivel: gamification ? (gamification.nivel || null) : null,
    gamification_score: gamification ? (gamification.score || 0) : 0,
    gamification_logros: gamification ? (gamification.logros || []) : [],
    pending_approvals: pendingApprovals,
  };
}

// ── PLAN ──────────────────────────────────────────────────────────────────────
async function getPlan(uid) {
  const snap = await _ownerDoc(uid).get();
  const d = snap.exists ? snap.data() : {};
  return {
    plan_name: d.plan_name || 'free',
    plan_price: d.plan_price || 0,
    plan_currency: d.plan_currency || 'USD',
    plan_renewal_date: d.plan_renewal_date || null,
    plan_active: d.plan_active !== false,
  };
}

// ── EXPRESS ROUTER ────────────────────────────────────────────────────────────
module.exports = function createDashboardSectionsRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || /* istanbul ignore next */ function (req, res, next) { next(); };

  router.get('/contacts', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    try {
      const contacts = await getContacts(uid, req.query.q || '');
      return res.json({ contacts, total: contacts.length });
    } catch (e) {
      console.error('[DASHBOARD-SECTIONS] contacts error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/business', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    try {
      return res.json(await getBusiness(uid));
    } catch (e) {
      console.error('[DASHBOARD-SECTIONS] business GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  router.put('/business', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    try {
      const result = await updateBusiness(uid, req.body || /* istanbul ignore next */ {});
      return res.json(result);
    } catch (e) {
      if (e.message === 'sin_campos_validos') return res.status(400).json({ error: e.message });
      console.error('[DASHBOARD-SECTIONS] business PUT error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/agenda/upcoming', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    try {
      const events = await getUpcomingEvents(uid);
      return res.json({ events });
    } catch (e) {
      console.error('[DASHBOARD-SECTIONS] agenda error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/conversations', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    const context = req.query.context;
    if (context && !VALID_CONTEXTS.includes(context)) {
      return res.status(400).json({ error: 'context invalido. Validos: ' + VALID_CONTEXTS.join(', ') });
    }
    try {
      const convs = await getConversations(uid, { context, limit: req.query.limit });
      return res.json({ conversations: convs });
    } catch (e) {
      console.error('[DASHBOARD-SECTIONS] conversations error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/learning/status', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    try {
      return res.json(await getLearningStatus(uid));
    } catch (e) /* istanbul ignore next */ {
      console.error('[DASHBOARD-SECTIONS] learning error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/plan', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });
    try {
      return res.json(await getPlan(uid));
    } catch (e) {
      console.error('[DASHBOARD-SECTIONS] plan error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
module.exports.getContacts = getContacts;
module.exports.getBusiness = getBusiness;
module.exports.updateBusiness = updateBusiness;
module.exports.getUpcomingEvents = getUpcomingEvents;
module.exports.getConversations = getConversations;
module.exports.getLearningStatus = getLearningStatus;
module.exports.getPlan = getPlan;
module.exports.VALID_CONTEXTS = VALID_CONTEXTS;
