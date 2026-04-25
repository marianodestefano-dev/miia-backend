'use strict';

/**
 * Tests integration C-406.b Bloque 1b — 2026-04-25 mediodía-tarde.
 *
 * Migración 7 endpoints sin auth (NONE_visible inventory v2 Bloque 1b)
 * con auth role apropiada por endpoint:
 *   - /api/chat (POST) — rrAuth + rrOwnerOfResource('userId', 'body')
 *   - /api/tenant/init (POST) — rrAuth + rrOwnerOfResource('uid', 'body')
 *   - /api/stats (GET) — rrAuth + rrAdmin
 *   - /api/scraper/run (POST) — rrAuth + rrAdmin
 *   - /api/cerebro/mine-dna (POST) — rrAuth + rrAdmin
 *   - /api/cerebro/learn-helpcenter (POST) — rrAuth + rrAdmin
 *   - /api/cerebro/status (GET) — rrAuth + rrAdmin
 *
 * 24 cases:
 *   /api/chat: 401 sin auth, 403 user uid ajeno, 200 user uid match (4 cases)
 *   /api/tenant/init: 401 sin auth, 403 user uid ajeno, 200 user uid match,
 *     400 body sin uid (4 cases)
 *   /api/stats: 401 sin auth, 403 user role, 200 admin role (3 cases)
 *   /api/scraper/run: 401 sin auth, 403 user role, 200 admin role (3 cases)
 *   /api/cerebro/mine-dna: idem (3 cases)
 *   /api/cerebro/learn-helpcenter: idem (3 cases)
 *   /api/cerebro/status: idem (3 cases)
 *   admin bypass uid mismatch en chat/tenant/init: 1 case
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
const {
  requireAuth,
  requireAdmin,
  requireOwnerOfResource,
} = require('../core/require_role');

const UID_USER_A = 'user_a_uid';
const UID_USER_B = 'user_b_uid';
const UID_ADMIN = 'admin_uid';
const TOKEN_USER_A = 'token-user-a';
const TOKEN_USER_B = 'token-user-b';
const TOKEN_ADMIN = 'token-admin';

function setupAuth() {
  admin.__mocks.verifyIdToken.mockImplementation(async (tok) => {
    if (tok === TOKEN_USER_A) return { uid: UID_USER_A, email: 'a@test.com', role: 'user' };
    if (tok === TOKEN_USER_B) return { uid: UID_USER_B, email: 'b@test.com', role: 'user' };
    if (tok === TOKEN_ADMIN)  return { uid: UID_ADMIN, email: 'admin@test.com', role: 'admin' };
    const e = new Error('invalid'); e.code = 'auth/invalid-id-token'; throw e;
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());

  // /api/chat — rrAuth + rrOwnerOfResource('userId', 'body')
  app.post('/api/chat',
    requireAuth, requireOwnerOfResource('userId', 'body'),
    (req, res) => res.json({ ok: true, ep: 'chat', userId: req.body.userId })
  );

  // /api/tenant/init — rrAuth + rrOwnerOfResource('uid', 'body')
  app.post('/api/tenant/init',
    requireAuth, requireOwnerOfResource('uid', 'body'),
    (req, res) => res.json({ ok: true, ep: 'tenant-init', uid: req.body.uid })
  );

  // 5 endpoints rrAuth + rrAdmin
  app.get('/api/stats', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'stats' }));
  app.post('/api/scraper/run', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'scraper-run' }));
  app.post('/api/cerebro/mine-dna', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'mine-dna' }));
  app.post('/api/cerebro/learn-helpcenter', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'learn-helpcenter' }));
  app.get('/api/cerebro/status', requireAuth, requireAdmin, (req, res) => res.json({ ok: true, ep: 'status' }));

  return app;
}

beforeEach(() => {
  Object.values(admin.__mocks).forEach((m) => m.mockReset && m.mockReset());
  admin.__mocks.firestoreGet.mockResolvedValue({ exists: false });
  setupAuth();
  delete process.env.ADMIN_EMAILS;
});

// ════════════════════════════════════════════════════════════════════════
// /api/chat — rrAuth + rrOwnerOfResource('userId', 'body')
// ════════════════════════════════════════════════════════════════════════

describe('/api/chat — rrAuth + rrOwnerOfResource(userId, body)', () => {
  test('case 1 — sin Authorization → 401 missing_token', async () => {
    const res = await request(buildApp()).post('/api/chat').send({ userId: UID_USER_A, message: 'hola' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });

  test('case 2 — userId body ajeno (user role) → 403 forbidden_ownership', async () => {
    const res = await request(buildApp())
      .post('/api/chat')
      .set('Authorization', `Bearer ${TOKEN_USER_A}`)
      .send({ userId: UID_USER_B, message: 'hijack' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_ownership');
  });

  test('case 3 — userId body == self → 200', async () => {
    const res = await request(buildApp())
      .post('/api/chat')
      .set('Authorization', `Bearer ${TOKEN_USER_A}`)
      .send({ userId: UID_USER_A, message: 'hola legítimo' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(UID_USER_A);
  });

  test('case 4 — userId body ausente → 400 missing_param', async () => {
    const res = await request(buildApp())
      .post('/api/chat')
      .set('Authorization', `Bearer ${TOKEN_USER_A}`)
      .send({ message: 'sin userId' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_param');
    expect(res.body.source).toBe('body');
  });
});

// ════════════════════════════════════════════════════════════════════════
// /api/tenant/init — rrAuth + rrOwnerOfResource('uid', 'body')
// ════════════════════════════════════════════════════════════════════════

describe('/api/tenant/init — rrAuth + rrOwnerOfResource(uid, body)', () => {
  test('case 5 — sin Authorization → 401', async () => {
    const res = await request(buildApp()).post('/api/tenant/init').send({ uid: UID_USER_A });
    expect(res.status).toBe(401);
  });

  test('case 6 — uid body ajeno (user role) → 403 forbidden_ownership', async () => {
    const res = await request(buildApp())
      .post('/api/tenant/init')
      .set('Authorization', `Bearer ${TOKEN_USER_A}`)
      .send({ uid: UID_USER_B });
    expect(res.status).toBe(403);
  });

  test('case 7 — uid body == self → 200', async () => {
    const res = await request(buildApp())
      .post('/api/tenant/init')
      .set('Authorization', `Bearer ${TOKEN_USER_A}`)
      .send({ uid: UID_USER_A, geminiApiKey: 'fake' });
    expect(res.status).toBe(200);
  });

  test('case 8 — uid body ausente → 400 missing_param', async () => {
    const res = await request(buildApp())
      .post('/api/tenant/init')
      .set('Authorization', `Bearer ${TOKEN_USER_A}`)
      .send({ geminiApiKey: 'sin uid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_param');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5 endpoints rrAuth + rrAdmin (3 cases each)
// ════════════════════════════════════════════════════════════════════════

const ADMIN_ENDPOINTS = [
  { method: 'get',  path: '/api/stats' },
  { method: 'post', path: '/api/scraper/run' },
  { method: 'post', path: '/api/cerebro/mine-dna' },
  { method: 'post', path: '/api/cerebro/learn-helpcenter' },
  { method: 'get',  path: '/api/cerebro/status' },
];

describe('5 endpoints admin-only (rrAuth + rrAdmin)', () => {
  for (const ep of ADMIN_ENDPOINTS) {
    describe(`${ep.method.toUpperCase()} ${ep.path}`, () => {
      test('401 sin Authorization', async () => {
        const res = await request(buildApp())[ep.method](ep.path);
        expect(res.status).toBe(401);
      });

      test('403 user role', async () => {
        const res = await request(buildApp())[ep.method](ep.path).set('Authorization', `Bearer ${TOKEN_USER_A}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('forbidden');
      });

      test('200 admin role', async () => {
        const res = await request(buildApp())[ep.method](ep.path).set('Authorization', `Bearer ${TOKEN_ADMIN}`);
        expect(res.status).toBe(200);
      });
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// Admin bypass — rrOwnerOfResource permite admin con uid ajeno
// ════════════════════════════════════════════════════════════════════════

describe('Admin bypass rrOwnerOfResource', () => {
  test('case 24 — admin role bypasea uid ajeno en /api/tenant/init', async () => {
    const res = await request(buildApp())
      .post('/api/tenant/init')
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`)
      .send({ uid: UID_USER_A, geminiApiKey: 'admin can init for anyone' });
    expect(res.status).toBe(200);
  });
});
