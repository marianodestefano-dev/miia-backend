'use strict';

/**
 * R15-C — Dashboard Summary route (Piso 2 P2.2)
 * GET /api/owner/dashboard-summary
 * Secciones: HOGAR (vivo del dia) | MI MIIA (estado) | CONEXIONES (servicios)
 */

const { isV2EligibleUid } = require('../core/voice_v2_loader');

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _ownerCol(uid) {
  return db().collection('owners').doc(uid);
}

async function _countPendingClassification(uid) {
  try {
    const snap = await db()
      .collection('users').doc(uid)
      .collection('contact_index')
      .where('awaitingClassification', '==', true)
      .get();
    return snap.size || 0;
  } catch (_) {
    return 0;
  }
}

async function _countActiveAlerts(uid) {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const snap = await _ownerCol(uid).collection('unknown_alerts').get();
    let count = 0;
    snap.forEach(function (doc) {
      const d = doc.data();
      if (d.fecha_ultima_alerta && d.fecha_ultima_alerta > cutoff) count++;
    });
    return count;
  } catch (_) {
    return 0;
  }
}

async function _getContextActivity(uid) {
  try {
    const snap = await _ownerCol(uid).collection('context_settings').get();
    const result = {};
    snap.forEach(function (doc) {
      result[doc.id] = { enabled: doc.data().enabled === true, updatedAt: doc.data().updatedAt || null };
    });
    return result;
  } catch (_) {
    return {};
  }
}

async function buildDashboardSummary(uid, opts) {
  const o = opts || /* istanbul ignore next */ {};
  const getWaConnected = o.getWaConnected || function () { return null; };
  const today = new Date().toISOString().slice(0, 10);

  // Owner doc
  const ownerSnap = await _ownerCol(uid).get();
  const ownerData = ownerSnap.exists ? ownerSnap.data() : {};

  // HOGAR
  let metricsToday = null;
  try {
    const mSnap = await _ownerCol(uid)
      .collection('daily_metrics').doc(today).get();
    metricsToday = mSnap.exists ? mSnap.data() : null;
  } catch (_) { /* non-critical */ }

  const pendingLeads = await _countPendingClassification(uid);
  const activeAlerts = await _countActiveAlerts(uid);
  const contextActivity = await _getContextActivity(uid);

  const hogar = {
    messages_today: metricsToday
      ? ((metricsToday.messages_received || 0) + (metricsToday.messages_sent || 0))
      : 0,
    leads_pending_classification: pendingLeads,
    active_alerts: activeAlerts,
    context_activity: contextActivity,
    date: today,
  };

  // MI MIIA
  const v2Active = isV2EligibleUid(uid);
  const miMiia = {
    v2_active: v2Active,
    dialect: ownerData.dialect || null,
    last_response_at: ownerData.last_miia_response || null,
    paused: ownerData.miia_paused === true,
    paused_at: ownerData.paused_at || null,
  };

  // CONEXIONES
  const conexiones = {
    whatsapp: {
      connected: getWaConnected(uid) === true,
      status: getWaConnected(uid) === true ? 'connected' : 'disconnected',
    },
    gmail: {
      connected: ownerData.gmail_connected === true,
    },
    calendar: {
      connected: ownerData.calendar_connected === true,
      last_sync: ownerData.calendar_last_sync || null,
    },
    railway: {
      status: 'not_checked',
    },
  };

  return {
    uid,
    generatedAt: new Date().toISOString(),
    hogar,
    mi_miia: miMiia,
    conexiones,
  };
}

module.exports = function createDashboardSummaryRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function (req, res, next) { next(); };
  const getWaConnected = (opts && opts.getWaConnected) || /* istanbul ignore next */ function () { return null; };

  // GET /api/owner/dashboard-summary
  router.get('/', requireAuth, async function (req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      const summary = await buildDashboardSummary(uid, { getWaConnected });
      return res.json(summary);
    } catch (e) {
      console.error('[DASHBOARD-SUMMARY] error uid=' + uid.slice(0, 8) + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
module.exports.buildDashboardSummary = buildDashboardSummary;
