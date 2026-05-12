'use strict';

/**
 * D.1-D.4 — Owner Dashboard Routes
 * D.1: GET /api/owner/summary
 * D.2: GET /api/owner/conversations
 * D.3: GET /api/owner/conversations/:phone
 * D.4: POST /api/owner/miia/pause|resume + GET /api/owner/miia/status
 */

const { getDailyMetrics } = require('../core/daily_metrics');
const { getEpisodicMemory } = require('../core/episodic_memory');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function _ownerDoc(uid) {
  return db().collection('owners').doc(uid);
}

module.exports = function createOwnerDashboardRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function(req, res, next) { next(); };
  const getWaConnected = (opts && opts.getWaConnected) || function() { return null; };

  // ── D.1 ──────────────────────────────────────────────────────────
  // GET /api/owner/summary
  router.get('/summary', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      const ownerDoc = await _ownerDoc(uid).get();
      const owner = ownerDoc.exists ? ownerDoc.data() : {};

      const todayMetrics = await getDailyMetrics(uid).catch(function() { return null; });

      // Count episodic memory contacts
      let memoryCount = 0;
      try {
        const memSnap = await _ownerDoc(uid).collection('episodic_memory').get();
        memoryCount = memSnap.size || 0;
      } catch (_) {}

      // Week metrics: try to aggregate last 7 days (best-effort)
      let weekMessages = 0, weekLeads = 0;
      const today = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(today.getTime() - i * 86400000);
        const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        const dm = await getDailyMetrics(uid, key).catch(function() { return null; });
        if (dm) {
          weekMessages += (dm.messages_received || 0) + (dm.messages_sent || 0);
          weekLeads += dm.leads_new || 0;
        }
      }
      const weekResponded = await getDailyMetrics(uid).then(function(d) { return d ? (d.leads_responded || 0) : 0; }).catch(function() { return 0; });
      const responseRate = weekLeads > 0 ? Math.round((weekResponded / weekLeads) * 100) : null;

      return res.json({
        uid: uid,
        phone: owner.phone || null,
        plan: owner.plan || 'free',
        wa_connected: getWaConnected(uid),
        stats_today: {
          messages: (todayMetrics && ((todayMetrics.messages_received || 0) + (todayMetrics.messages_sent || 0))) || 0,
          leads_new: (todayMetrics && todayMetrics.leads_new) || 0,
          gemini_calls: (todayMetrics && todayMetrics.gemini_calls) || 0,
        },
        stats_week: {
          messages: weekMessages,
          leads_new: weekLeads,
          response_rate: responseRate,
        },
        memory_contacts_count: memoryCount,
        f1_active: owner.f1_active || false,
        ludomiia_active: owner.ludomiia_active || false,
        last_backup: owner.last_backup || null,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── D.2 ──────────────────────────────────────────────────────────
  // GET /api/owner/conversations?limit=20&offset=0
  router.get('/conversations', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    try {
      const snap = await _ownerDoc(uid).collection('tenant_conversations')
        .orderBy('last_ts', 'desc')
        .limit(limit + offset)
        .get();

      const docs = snap.docs.slice(offset).map(function(doc) {
        const d = doc.data();
        return {
          phone: doc.id,
          name: d.name || doc.id,
          last_message_preview: (d.last_message || '').substring(0, 80),
          last_ts: d.last_ts || null,
          tag: d.tag || d.contact_type || 'unknown',
          unread_count: d.unread_count || 0,
        };
      });

      return res.json(docs);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── D.3 ──────────────────────────────────────────────────────────
  // GET /api/owner/conversations/:phone?limit=50
  router.get('/conversations/:phone', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const phone = req.params.phone;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    try {
      const convDoc = await _ownerDoc(uid).collection('tenant_conversations').doc(phone).get();
      if (!convDoc.exists) return res.status(404).json({ error: 'Conversacion no encontrada' });

      const convData = convDoc.data();
      const messages = (convData.messages || []).slice(-limit).map(function(m) {
        return {
          from: m.from || (m.fromMe ? 'MIIA' : phone),
          text: m.text || m.body || '',
          ts: m.ts || m.timestamp || null,
          fromMe: !!m.fromMe,
        };
      });

      const memory = await getEpisodicMemory(uid, phone).catch(function() { return null; });
      const memoryFacts = memory && memory.key_facts ? memory.key_facts.slice(-5) : [];

      return res.json({
        messages: messages,
        contact_info: {
          phone: phone,
          name: convData.name || phone,
          tag: convData.tag || 'unknown',
        },
        memory_facts: memoryFacts,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ── D.4 ──────────────────────────────────────────────────────────
  // POST /api/owner/miia/pause
  router.post('/miia/pause', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      await _ownerDoc(uid).set(
        { miia_paused: true, paused_at: new Date().toISOString(), paused_reason: req.body && req.body.reason || 'manual' },
        { merge: true }
      );
      console.log('[DASHBOARD] MIIA pausada uid=' + uid.substring(0, 8));
      return res.json({ ok: true, paused: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/owner/miia/resume
  router.post('/miia/resume', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      await _ownerDoc(uid).set(
        { miia_paused: false, paused_at: null, paused_reason: null },
        { merge: true }
      );
      console.log('[DASHBOARD] MIIA reanudada uid=' + uid.substring(0, 8));
      return res.json({ ok: true, paused: false });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/owner/miia/status
  router.get('/miia/status', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      const doc = await _ownerDoc(uid).get();
      const data = doc.exists ? doc.data() : {};
      return res.json({
        active: !data.miia_paused,
        paused_at: data.paused_at || null,
        paused_reason: data.paused_reason || null,
        wa_connected: getWaConnected(uid),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
