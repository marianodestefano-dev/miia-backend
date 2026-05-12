'use strict';

/**
 * R13-A — Privacy routes (Piso 1 GDPR-lite)
 * GET  /api/privacy/my-data?uid=X         -> resumen de datos del owner
 * POST /api/privacy/request-deletion      -> flag para borrado async
 */

const { buildPrivacyReport, __setFirestoreForTests } = require('../core/privacy_report');

let _db = null;
function db() {
  /* istanbul ignore next */
  if (!_db) _db = require('firebase-admin').firestore();
  return _db;
}

function __setDbForTests(fs) {
  _db = fs;
  /* istanbul ignore next */
  if (typeof __setFirestoreForTests === 'function') __setFirestoreForTests(fs);
}

module.exports = function createPrivacyRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function (req, res, next) { next(); };

  // GET /api/privacy/my-data
  router.get('/my-data', requireAuth, async function (req, res) {
    const uid = req.query && req.query.uid;
    if (!uid) return res.status(400).json({ error: 'uid_required' });

    try {
      const report = await buildPrivacyReport(uid);
      const dateRange = report.oldestConversationDate
        ? { from: report.oldestConversationDate, to: report.generatedAt }
        : null;
      return res.json({
        uid,
        totalConversations: report.conversationsCount || 0,
        dateRange,
        requestedAt: report.generatedAt,
        trainingDataSize: report.trainingDataSize || 0,
        personalBrainSize: report.personalBrainSize || 0,
        contactTypesCount: report.contactTypesCount || 0,
        staleCacheCount: report.staleCacheCount || 0,
      });
    } catch (e) {
      console.error('[PRIVACY] my-data error uid=' + uid + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/privacy/request-deletion
  router.post('/request-deletion', requireAuth, async function (req, res) {
    const body = req.body || /* istanbul ignore next */ {};
    const uid = body.uid;
    if (!uid) return res.status(400).json({ error: 'uid_required' });

    const requestedAt = new Date().toISOString();
    console.log('[PRIVACY] Solicitud de borrado uid=' + uid + ' at=' + requestedAt);

    try {
      await db().collection('owners').doc(uid)
        .collection('deletion_requests').add({
          uid,
          requestedAt,
          status: 'pending',
          createdAt: Date.now(),
        });
      return res.json({ ok: true, uid, requestedAt, status: 'pending' });
    } catch (e) {
      console.error('[PRIVACY] request-deletion error uid=' + uid + ':', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setDbForTests = __setDbForTests;
