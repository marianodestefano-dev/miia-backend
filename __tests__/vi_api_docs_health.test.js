'use strict';

/**
 * VI-API-DOCS-HEALTH -- tests routes/health.js
 * 100% branches: _buildPublicResponse + _getVersion + endpoints HTTP.
 */

const express = require('express');
const request = require('supertest');
const { _buildPublicResponse, _getVersion } = require('../routes/health');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeApp(healthFn) {
  const createHealthRoutes = require('../routes/health');
  const app = express();
  app.use('/api', createHealthRoutes({
    getHealthStatus: healthFn,
    requireRole: function() { return function(req, res, next) { next(); }; },
  }));
  return app;
}

function healthBase(overrides) {
  return Object.assign({
    status: 'healthy',
    uptime: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastFullCheck: null,
    components: {
      firestore: { status: 'healthy', latencyMs: 10, lastCheck: null, failures: 0, latency: null },
      baileys: [{ uid: 'abc12345...', status: 'healthy', lastCheck: null, failures: 0, phone: '+573054169969' }],
      aiGateway: { status: 'healthy', latencyMs: 200, lastCheck: null, failures: 0, latency: null },
      messagesUpsert: { count10min: 5, count20min: 10, lastUpsertAt: null, status: 'healthy' },
    },
  }, overrides);
}

// ── _buildPublicResponse ──────────────────────────────────────────────────────

describe('_buildPublicResponse', function() {
  test('P.1 todo healthy: status=ok, whatsapp.connected=true, firestore.connected=true, gemini.available=true', function() {
    const r = _buildPublicResponse(healthBase());
    expect(r.status).toBe('ok');
    expect(r.whatsapp.connected).toBe(true);
    expect(r.whatsapp.uid).toBe('abc12345...');
    expect(r.whatsapp.phone).toBe('+573054169969');
    expect(r.firestore.connected).toBe(true);
    expect(r.gemini.available).toBe(true);
    expect(typeof r.uptime).toBe('number');
    expect(typeof r.version).toBe('string');
    expect(typeof r.timestamp).toBe('string');
  });

  test('P.2 firestore critical: status=degraded', function() {
    const h = healthBase({ status: 'critical' });
    h.components.firestore.status = 'critical';
    const r = _buildPublicResponse(h);
    expect(r.status).toBe('degraded');
    expect(r.firestore.connected).toBe(false);
  });

  test('P.3 baileys disconnected: status=degraded, whatsapp.connected=false', function() {
    const h = healthBase({ status: 'degraded' });
    h.components.baileys = [{ uid: 'abc...', status: 'disconnected', lastCheck: null, failures: 1 }];
    const r = _buildPublicResponse(h);
    expect(r.status).toBe('degraded');
    expect(r.whatsapp.connected).toBe(false);
  });

  test('P.4 todo down (wa+fs+ai fallan): status=down', function() {
    const h = healthBase({ status: 'critical' });
    h.components.firestore.status = 'critical';
    h.components.baileys = [{ uid: 'abc...', status: 'disconnected', failures: 3 }];
    h.components.aiGateway.status = 'critical';
    const r = _buildPublicResponse(h);
    expect(r.status).toBe('down');
    expect(r.whatsapp.connected).toBe(false);
    expect(r.firestore.connected).toBe(false);
    expect(r.gemini.available).toBe(false);
  });

  test('P.5 sin baileys en array: whatsapp.connected=false, uid=null, phone=null', function() {
    const h = healthBase();
    h.components.baileys = [];
    const r = _buildPublicResponse(h);
    expect(r.whatsapp.connected).toBe(false);
    expect(r.whatsapp.uid).toBeNull();
    expect(r.whatsapp.phone).toBeNull();
  });

  test('P.6 components.baileys no es array: no lanza', function() {
    const h = healthBase();
    h.components.baileys = null;
    expect(() => _buildPublicResponse(h)).not.toThrow();
    const r = _buildPublicResponse(h);
    expect(r.whatsapp.connected).toBe(false);
  });

  test('P.7 components undefined: no lanza, status degraded/down', function() {
    const h = { status: 'critical', uptime: 0, components: undefined };
    expect(() => _buildPublicResponse(h)).not.toThrow();
  });

  test('P.8 aiGateway status=unknown: gemini.available=true (no fallo confirmado)', function() {
    const h = healthBase();
    h.components.aiGateway.status = 'unknown';
    const r = _buildPublicResponse(h);
    expect(r.gemini.available).toBe(true);
  });

  test('P.9 baileys primer item sin phone: phone=null', function() {
    const h = healthBase();
    h.components.baileys = [{ uid: 'abc...', status: 'healthy', failures: 0 }];
    const r = _buildPublicResponse(h);
    expect(r.whatsapp.phone).toBeNull();
  });
});

// ── _getVersion ──────────────────────────────────────────────────────────────

describe('_getVersion', function() {
  test('V.1 retorna string con version del package.json', function() {
    const v = _getVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });
});

// ── GET /api/health (HTTP) ────────────────────────────────────────────────────

describe('GET /api/health', function() {
  test('H.1 healthy: 200 status=ok', async function() {
    const app = makeApp(() => healthBase());
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBeTruthy();
    expect(res.body.whatsapp).toBeDefined();
    expect(res.body.firestore).toBeDefined();
    expect(res.body.gemini).toBeDefined();
  });

  test('H.2 degraded: 207', async function() {
    const app = makeApp(() => healthBase({ status: 'degraded' }));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(207);
    expect(res.body.status).toBe('degraded');
  });

  test('H.3 todo down: 503 status=down', async function() {
    const h = healthBase({ status: 'critical' });
    h.components.firestore.status = 'critical';
    h.components.baileys = [{ uid: 'x', status: 'disconnected', failures: 3 }];
    h.components.aiGateway.status = 'critical';
    const app = makeApp(() => h);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
  });

  test('H.4 getHealthStatus lanza: 500', async function() {
    const app = makeApp(() => { throw new Error('exploto'); });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('down');
  });
});

// ── GET /api/health/detailed ──────────────────────────────────────────────────

describe('GET /api/health/detailed', function() {
  test('D.1 retorna el objeto completo de getHealthStatus', async function() {
    const full = healthBase();
    const app = makeApp(() => full);
    const res = await request(app).get('/api/health/detailed');
    expect(res.status).toBe(200);
    expect(res.body.components).toBeDefined();
    expect(res.body.uptime).toBe(42);
  });

  test('D.2 getHealthStatus lanza: 500', async function() {
    const app = makeApp(() => { throw new Error('db_fail'); });
    const res = await request(app).get('/api/health/detailed');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
  });
});
