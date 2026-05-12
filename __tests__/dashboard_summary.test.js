'use strict';
/**
 * R15-C — dashboard_summary.test.js
 * 100% branch coverage: buildDashboardSummary + HTTP route
 */

const express = require('express');

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockOwnerExists = false;
let mockOwnerData = {};
let mockMetricsExists = false;
let mockMetricsData = {};
let mockContactIndexSnap = { size: 0, forEach: () => {} };
let mockAlertsSnap = { forEach: () => {} };
let mockContextSnap = { forEach: () => {} };
let mockOwnerGetThrows = false;
let mockMetricsGetThrows = false;
let mockContactIndexThrows = false;
let mockAlertsGetThrows = false;
let mockContextGetThrows = false;

// simulate 1-where query result
let _pendingCount = 0;
let _alertDocs = [];
let _contextDocs = [];

const mockFs = {
  collection: (colName) => ({
    doc: (docId) => ({
      get: () => {
        if (colName === 'owners') {
          if (mockOwnerGetThrows) return Promise.reject(new Error('OWNER-FAIL'));
          return Promise.resolve({ exists: mockOwnerExists, data: () => mockOwnerData });
        }
        if (colName === 'users') {
          // not used at top level in this module
        }
        return Promise.resolve({ exists: false, data: () => ({}) });
      },
      collection: (subCol) => ({
        doc: (subDocId) => ({
          get: () => {
            if (subCol === 'daily_metrics') {
              if (mockMetricsGetThrows) return Promise.reject(new Error('METRICS-FAIL'));
              return Promise.resolve({ exists: mockMetricsExists, data: () => mockMetricsData });
            }
            return Promise.resolve({ exists: false, data: () => ({}) });
          },
        }),
        where: () => ({
          get: () => {
            if (mockContactIndexThrows) return Promise.reject(new Error('CONTACT-FAIL'));
            const docs = Array.from({ length: _pendingCount });
            return Promise.resolve({ size: _pendingCount, forEach: () => {} });
          },
        }),
        get: () => {
          if (subCol === 'unknown_alerts') {
            if (mockAlertsGetThrows) return Promise.reject(new Error('ALERTS-FAIL'));
            return Promise.resolve({ forEach: (fn) => _alertDocs.forEach(fn) });
          }
          if (subCol === 'context_settings') {
            if (mockContextGetThrows) return Promise.reject(new Error('CONTEXT-FAIL'));
            return Promise.resolve({ forEach: (fn) => _contextDocs.forEach(fn) });
          }
          return Promise.resolve({ forEach: () => {} });
        },
      }),
    }),
  }),
};

const createRoutes = require('../routes/dashboard_summary');
const { buildDashboardSummary, __setFirestoreForTests } = require('../routes/dashboard_summary');
__setFirestoreForTests(mockFs);

function buildApp(waConnected) {
  const app = express();
  app.use(express.json());
  const router = createRoutes({
    requireAuth: function (req, res, next) {
      req.user = { uid: 'uid-test-1' };
      next();
    },
    getWaConnected: () => waConnected,
  });
  app.use('/', router);
  return app;
}

function buildAppNoAuth() {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes({}));
  return app;
}

const request = require('supertest');

beforeEach(() => {
  mockOwnerExists = false;
  mockOwnerData = {};
  mockMetricsExists = false;
  mockMetricsData = {};
  mockOwnerGetThrows = false;
  mockMetricsGetThrows = false;
  mockContactIndexThrows = false;
  mockAlertsGetThrows = false;
  mockContextGetThrows = false;
  _pendingCount = 0;
  _alertDocs = [];
  _contextDocs = [];
});

// ── HTTP route ────────────────────────────────────────────────────────────────
describe('GET / — HTTP endpoint', () => {
  test('401 si no hay usuario autenticado', async () => {
    const r = await request(buildAppNoAuth()).get('/');
    expect(r.status).toBe(401);
  });

  test('200 retorna summary con owner no existente', async () => {
    mockOwnerExists = false;
    const r = await request(buildApp(true)).get('/');
    expect(r.status).toBe(200);
    expect(r.body.uid).toBe('uid-test-1');
    expect(r.body.hogar).toBeDefined();
    expect(r.body.mi_miia).toBeDefined();
    expect(r.body.conexiones).toBeDefined();
  });

  test('500 si buildDashboardSummary lanza', async () => {
    mockOwnerGetThrows = true;
    const r = await request(buildApp(false)).get('/');
    expect(r.status).toBe(500);
  });
});

// ── buildDashboardSummary ─────────────────────────────────────────────────────
describe('buildDashboardSummary', () => {
  test('hogar: messages_today=0 si metrics no existen', async () => {
    mockOwnerExists = false;
    mockMetricsExists = false;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.messages_today).toBe(0);
  });

  test('hogar: messages_today suma received+sent si metrics existen', async () => {
    mockOwnerExists = false;
    mockMetricsExists = true;
    mockMetricsData = { messages_received: 5, messages_sent: 3 };
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.messages_today).toBe(8);
  });

  test('hogar: messages_today=0 si metrics existen pero sin campos', async () => {
    mockOwnerExists = false;
    mockMetricsExists = true;
    mockMetricsData = {};
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.messages_today).toBe(0);
  });

  test('hogar: metrics error es no-critico, retorna 0', async () => {
    mockMetricsGetThrows = true;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.messages_today).toBe(0);
  });

  test('hogar: leads_pending_classification usa contactIndex size', async () => {
    _pendingCount = 7;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.leads_pending_classification).toBe(7);
  });

  test('hogar: contactIndex error retorna 0', async () => {
    mockContactIndexThrows = true;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.leads_pending_classification).toBe(0);
  });

  test('hogar: active_alerts cuenta alertas dentro de 24h', async () => {
    _alertDocs = [
      { data: () => ({ fecha_ultima_alerta: Date.now() - 1000 }) },
      { data: () => ({ fecha_ultima_alerta: Date.now() - 100000 }) },
      { data: () => ({ fecha_ultima_alerta: Date.now() - 90000000 }) },
    ];
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.active_alerts).toBe(2);
  });

  test('hogar: alerta sin fecha_ultima_alerta no cuenta', async () => {
    _alertDocs = [
      { data: () => ({}) },
    ];
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.active_alerts).toBe(0);
  });

  test('hogar: active_alerts error retorna 0', async () => {
    mockAlertsGetThrows = true;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.active_alerts).toBe(0);
  });

  test('hogar: context_activity retorna toggles', async () => {
    _contextDocs = [
      { id: 'leads', data: () => ({ enabled: true, updatedAt: '2026-05-12T00:00:00Z' }) },
      { id: 'selfchat', data: () => ({ enabled: false, updatedAt: null }) },
    ];
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.context_activity.leads.enabled).toBe(true);
    expect(s.hogar.context_activity.selfchat.enabled).toBe(false);
    expect(s.hogar.context_activity.selfchat.updatedAt).toBeNull();
  });

  test('hogar: context_settings error retorna {}', async () => {
    mockContextGetThrows = true;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.hogar.context_activity).toEqual({});
  });

  test('mi_miia: v2_active true para uid elegible CENTER', async () => {
    const s = await buildDashboardSummary('A5pMESWlfmPWCoCPRbwy85EzUzy2', {});
    expect(s.mi_miia.v2_active).toBe(true);
  });

  test('mi_miia: v2_active false para uid random', async () => {
    const s = await buildDashboardSummary('uid-random-xyz', {});
    expect(s.mi_miia.v2_active).toBe(false);
  });

  test('mi_miia: dialect y last_response desde ownerData', async () => {
    mockOwnerExists = true;
    mockOwnerData = { dialect: 'rioplatense', last_miia_response: '2026-05-12T10:00:00Z', miia_paused: false };
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.mi_miia.dialect).toBe('rioplatense');
    expect(s.mi_miia.last_response_at).toBe('2026-05-12T10:00:00Z');
    expect(s.mi_miia.paused).toBe(false);
  });

  test('mi_miia: paused=true si miia_paused', async () => {
    mockOwnerExists = true;
    mockOwnerData = { miia_paused: true, paused_at: '2026-05-11T00:00:00Z' };
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.mi_miia.paused).toBe(true);
    expect(s.mi_miia.paused_at).toBe('2026-05-11T00:00:00Z');
  });

  test('mi_miia: dialect null si no esta en owner', async () => {
    mockOwnerExists = false;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.mi_miia.dialect).toBeNull();
    expect(s.mi_miia.last_response_at).toBeNull();
    expect(s.mi_miia.paused_at).toBeNull();
  });

  test('conexiones: whatsapp connected=true si getWaConnected retorna true', async () => {
    const s = await buildDashboardSummary('uid-abc', { getWaConnected: () => true });
    expect(s.conexiones.whatsapp.connected).toBe(true);
    expect(s.conexiones.whatsapp.status).toBe('connected');
  });

  test('conexiones: whatsapp connected=false si getWaConnected retorna false', async () => {
    const s = await buildDashboardSummary('uid-abc', { getWaConnected: () => false });
    expect(s.conexiones.whatsapp.connected).toBe(false);
    expect(s.conexiones.whatsapp.status).toBe('disconnected');
  });

  test('conexiones: whatsapp disconnected si getWaConnected retorna null (default)', async () => {
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.conexiones.whatsapp.connected).toBe(false);
    expect(s.conexiones.whatsapp.status).toBe('disconnected');
  });

  test('conexiones: gmail y calendar desde ownerData', async () => {
    mockOwnerExists = true;
    mockOwnerData = {
      gmail_connected: true,
      calendar_connected: true,
      calendar_last_sync: '2026-05-12T09:00:00Z',
    };
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.conexiones.gmail.connected).toBe(true);
    expect(s.conexiones.calendar.connected).toBe(true);
    expect(s.conexiones.calendar.last_sync).toBe('2026-05-12T09:00:00Z');
  });

  test('conexiones: gmail false y calendar null si no estan en owner', async () => {
    mockOwnerExists = false;
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.conexiones.gmail.connected).toBe(false);
    expect(s.conexiones.calendar.connected).toBe(false);
    expect(s.conexiones.calendar.last_sync).toBeNull();
  });

  test('conexiones: railway siempre not_checked', async () => {
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.conexiones.railway.status).toBe('not_checked');
  });

  test('retorna generatedAt en ISO format', async () => {
    const s = await buildDashboardSummary('uid-abc', {});
    expect(s.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.hogar.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
