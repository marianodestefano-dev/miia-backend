'use strict';

/**
 * HEALTH ROUTES — Endpoints de monitoreo y estado del sistema
 *
 * GET /api/health          → Estado publico simplificado (sin auth — Railway keep-alive)
 * GET /api/health/detailed → Estado detallado completo (solo admin/owner)
 */

const express = require('express');

let _pkg = null;
function _getVersion() {
  if (!_pkg) {
    try { _pkg = require('../package.json'); } catch (_) { _pkg = { version: 'unknown' }; }
  }
  return _pkg.version || 'unknown';
}

/**
 * Transforma el resultado de getHealthStatus() al formato publico simplificado.
 * status: 'ok' | 'degraded' | 'down'
 */
function _buildPublicResponse(health) {
  const components = health.components || {};

  // whatsapp: tomar el primer tenant baileys
  const baileysArr = Array.isArray(components.baileys) ? components.baileys : [];
  const firstBaileys = baileysArr[0] || null;
  const waConnected = baileysArr.some(b => b.status === 'healthy');

  // firestore
  const fsStatus = components.firestore ? components.firestore.status : 'unknown';
  const fsConnected = fsStatus === 'healthy';

  // gemini / ai gateway
  const aiStatus = components.aiGateway ? components.aiGateway.status : 'unknown';
  const geminiAvailable = aiStatus === 'healthy' || aiStatus === 'unknown';

  // status publico: ok / degraded / down
  const allDown = !waConnected && !fsConnected && !geminiAvailable;
  const anyIssue = health.status === 'critical' || health.status === 'degraded' ||
                   !fsConnected || !waConnected;
  let publicStatus;
  if (allDown) {
    publicStatus = 'down';
  } else if (anyIssue) {
    publicStatus = 'degraded';
  } else {
    publicStatus = 'ok';
  }

  return {
    status:    publicStatus,
    version:   _getVersion(),
    uptime:    health.uptime,
    timestamp: new Date().toISOString(),
    whatsapp: {
      connected: waConnected,
      uid:   firstBaileys ? firstBaileys.uid   : null,
      phone: firstBaileys ? (firstBaileys.phone || null) : null,
    },
    firestore: {
      connected: fsConnected,
    },
    gemini: {
      available: geminiAvailable,
    },
  };
}

module.exports = function createHealthRoutes({ getHealthStatus, requireRole }) {
  const router = express.Router();

  // GET /api/health — Estado publico (Railway keep-alive, sin auth)
  router.get('/health', (req, res) => {
    try {
      const health = getHealthStatus();
      const pub = _buildPublicResponse(health);
      const httpCode = pub.status === 'down' ? 503 : pub.status === 'degraded' ? 207 : 200;
      res.status(httpCode).json(pub);
    } catch (e) {
      console.error(`[HEALTH-ROUTE] Error: ${e.message}`);
      res.status(500).json({ status: 'down', error: e.message });
    }
  });

  // GET /api/health/detailed — Estado completo (solo admin/owner autenticado)
  router.get('/health/detailed', requireRole('admin', 'owner'), (req, res) => {
    try {
      const health = getHealthStatus();
      res.json(health);
    } catch (e) {
      console.error(`[HEALTH-ROUTE] Error detallado: ${e.message}`);
      res.status(500).json({ status: 'error', error: e.message });
    }
  });

  return router;
};

// Exponer para tests
module.exports._buildPublicResponse = _buildPublicResponse;
module.exports._getVersion = _getVersion;
