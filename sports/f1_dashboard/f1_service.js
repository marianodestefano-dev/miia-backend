'use strict';

/**
 * MiiaF1 — Servicio Railway separado (F1.16)
 * Puerto: F1_SERVICE_PORT (default 3001)
 * Corre el live scraper + expone endpoints de estado.
 */

const express = require('express');
const { start, stop, getState } = require('./live_scraper');
const { getLiveCache } = require('./live_cache');

const PORT = process.env.F1_SERVICE_PORT || 3001;
const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  const s = getState();
  res.json({ status: 'ok', scraper: s, ts: new Date().toISOString() });
});

// Estado del scraper
app.get('/state', (req, res) => res.json(getState()));

// Posiciones live
app.get('/positions', async (req, res) => {
  try {
    const cache = getLiveCache();
    const [positions, raceStatus] = await Promise.all([
      cache.getAllPositions(),
      cache.getRaceStatus(),
    ]);
    res.json({ positions, raceStatus, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Posicion de un driver especifico
app.get('/driver/:number', async (req, res) => {
  try {
    const cache = getLiveCache();
    const data = await cache.getDriverPosition(req.params.number);
    if (!data) return res.status(404).json({ error: 'Driver no encontrado en cache' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar servidor y scraper
const server = app.listen(PORT, () => {
  console.log('[F1-SERVICE] Servidor en puerto ' + PORT);
  start({
    onCritical: (msg) => console.error('[F1-SERVICE] CRITICAL: ' + msg),
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[F1-SERVICE] SIGTERM — parando scraper y cerrando server');
  stop();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  stop();
  server.close(() => process.exit(0));
});

module.exports = { app, server };
