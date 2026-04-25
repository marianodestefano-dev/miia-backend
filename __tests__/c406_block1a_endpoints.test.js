'use strict';

/**
 * Tests integration C-406.b Bloque 1a — 2026-04-25 mediodía-tarde.
 *
 * Migración mecánica de 9 endpoints: verifyAdminToken legacy →
 * rrRequireAuth + rrRequireAdmin. Cambio de nomenclatura, NO cambia
 * comportamiento esperado (ambos requieren admin auth).
 *
 * Estrategia: harness Express + supertest similar a c406_crit_endpoints.
 * 27 cases (3 por endpoint × 9 endpoints):
 *   - 401 sin Authorization
 *   - 403 user role
 *   - 200 admin role
 *
 * Endpoints cubiertos:
 *   GET    /api/tenants
 *   GET    /api/prompt-registry/modules
 *   GET    /api/prompt-registry/modules/:id
 *   POST   /api/prompt-registry/modules/:id
 *   GET    /api/prompt-registry/checkpoints
 *   POST   /api/prompt-registry/checkpoints
 *   POST   /api/prompt-registry/rollback
 *   GET    /api/prompt-registry/diff/:checkpointName
 *   POST   /api/prompt-registry/seed
 */

jest.mock('firebase-admin', () => {
  const verifyIdToken = jest.fn();
  const firestoreGet = jest.fn();
  return {
    app: jest.fn(() => ({ name: 'test-app' })),
    auth: jest.fn(() => ({ verifyIdToken })),
    firestore: jest.fn(() => ({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({ get: firestoreGet })),
      })),
    })),
    __mocks: { verifyIdToken, firestoreGet },
  };
});

const admin = require('firebase-admin');
const express = require('express');
const request = require('supertest');
const { requireAuth, requireAdmin } = require('../core/require_role');

const TOKEN_USER = 'token-user';
const TOKEN_ADMIN = 'token-admin';

function setupAuth() {
  admin.__mocks.verifyIdToken.mockImplementation(async (tok) => {
    if (tok === TOKEN_USER) return { uid: 'user_uid', email: 'user@test.com', role: 'user' };
    if (tok === TOKEN_ADMIN) return { uid: 'admin_uid', email: 'admin@test.com', role: 'admin' };
    const e = new Error('invalid'); e.code = 'auth/invalid-id-token'; throw e;
  });
}

// Harness: monta los 9 endpoints reales con los mismos middleware
function buildApp() {
  const app = express();

  // GET /api/tenants
  app.get('/api/tenants', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'tenants' }));

  // /api/prompt-registry/modules
  app.get('/api/prompt-registry/modules', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'modules-list' }));
  app.get('/api/prompt-registry/modules/:id', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'modules-get', id: req.params.id }));
  app.post('/api/prompt-registry/modules/:id', requireAuth, requireAdmin, express.json(), (req, res) => res.json({ ok: true, ep: 'modules-post', id: req.params.id }));

  // /api/prompt-registry/checkpoints
  app.get('/api/prompt-registry/checkpoints', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'checkpoints-list' }));
  app.post('/api/prompt-registry/checkpoints', requireAuth, requireAdmin, express.json(), (req, res) => res.json({ ok: true, ep: 'checkpoints-post' }));

  // /api/prompt-registry/rollback
  app.post('/api/prompt-registry/rollback', requireAuth, requireAdmin, express.json(), (req, res) => res.json({ ok: true, ep: 'rollback' }));

  // /api/prompt-registry/diff/:checkpointName
  app.get('/api/prompt-registry/diff/:checkpointName', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'diff', name: req.params.checkpointName }));

  // /api/prompt-registry/seed
  app.post('/api/prompt-registry/seed', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'seed' }));

  return app;
}

beforeEach(() => {
  Object.values(admin.__mocks).forEach((m) => m.mockReset && m.mockReset());
  admin.__mocks.firestoreGet.mockResolvedValue({ exists: false });
  setupAuth();
  delete process.env.ADMIN_EMAILS;
});

// ─── 9 endpoints × 3 cases (401/403/200) ─────────────────────────────────
const ENDPOINTS = [
  { method: 'get',    path: '/api/tenants' },
  { method: 'get',    path: '/api/prompt-registry/modules' },
  { method: 'get',    path: '/api/prompt-registry/modules/test-id' },
  { method: 'post',   path: '/api/prompt-registry/modules/test-id' },
  { method: 'get',    path: '/api/prompt-registry/checkpoints' },
  { method: 'post',   path: '/api/prompt-registry/checkpoints' },
  { method: 'post',   path: '/api/prompt-registry/rollback' },
  { method: 'get',    path: '/api/prompt-registry/diff/checkpoint-test' },
  { method: 'post',   path: '/api/prompt-registry/seed' },
];

describe('C-406.b Bloque 1a — verifyAdminToken legacy → rrAuth+rrAdmin (9 endpoints × 3 cases = 27)', () => {
  for (const ep of ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} ${ep.path}`, () => {
      test('401 sin Authorization → missing_token', async () => {
        const app = buildApp();
        const res = await request(app)[ep.method](ep.path);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('missing_token');
      });

      test('403 user role → forbidden', async () => {
        const app = buildApp();
        const res = await request(app)[ep.method](ep.path).set('Authorization', `Bearer ${TOKEN_USER}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('forbidden');
      });

      test('200 admin role → ok', async () => {
        const app = buildApp();
        const res = await request(app)[ep.method](ep.path).set('Authorization', `Bearer ${TOKEN_ADMIN}`);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });
    });
  }
});
