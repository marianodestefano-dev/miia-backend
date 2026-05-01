'use strict';
const { Router } = require('express');
const metrics = require('../core/prometheus_metrics');

function createMetricsRoutes() {
  const router = Router();

  router.get("/metrics", (req, res) => {
    try {
      const body = metrics.formatPrometheus();
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.status(200).send(body);
    } catch (e) {
      console.error("[METRICS] Error generando metricas:", e.message);
      res.status(500).json({ error: "metrics_error" });
    }
  });

  return router;
}

module.exports = createMetricsRoutes;
