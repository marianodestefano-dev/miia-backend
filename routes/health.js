'use strict';

/**
 * HEALTH ROUTES — Endpoints de monitoreo y estado del sistema
 *
 * GET /api/health          → Estado general del sistema
 * GET /api/health/detailed → Estado detallado (solo admin)
 */

const express = require('express');
const router = express.Router();

module.exports = function createHealthRoutes({ getHealthStatus, requireRole }) {

  // GET /api/health — Estado público (uptime, status general)
  router.get('/health', (req, res) => {
    try {
      const health = getHealthStatus();
      const statusCode = health.status === 'critical' ? 503 : health.status === 'degraded' ? 207 : 200;
      res.status(statusCode).json({
        status: health.status,
        uptime: health.uptime,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[HEALTH-ROUTE] ❌ Error: ${e.message}`);
      res.status(500).json({ status: 'error', error: e.message });
    }
  });

  // GET /api/health/detailed — Estado detallado (solo admin/owner autenticado)
  router.get('/health/detailed', requireRole('admin', 'owner'), (req, res) => {
    try {
      const health = getHealthStatus();
      res.json(health);
    } catch (e) {
      console.error(`[HEALTH-ROUTE] ❌ Error detallado: ${e.message}`);
      res.status(500).json({ status: 'error', error: e.message });
    }
  });

  return router;
};
