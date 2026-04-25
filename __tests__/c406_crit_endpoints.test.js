'use strict';

/**
 * Tests integration C-406.b.crit endpoints — 2026-04-25 mediodía-tarde.
 *
 * Cierra 3 vulnerabilidades CRÍTICAS Bloque 1b:
 *   - GET  /api/conversations  (cross-owner read)
 *   - POST /api/cerebro/learn   (inyección training global)
 *   - POST /api/train           (inyección training tenant)
 *
 * Estrategia: NO importa server.js completo (5000+ líneas, demasiados side
 * effects). Usa Express app harness con los mismos middleware aplicados
 * para validar que rrRequireAuth + rrRequireOwnerOfResource('uid', 'query')
 * y rrRequireAuth + rrRequireAdmin actúan como esperado en los handlers.
 *
 * 12 cases:
 *   §1 /api/conversations:
 *     1. sin Authorization → 401 missing_token
 *     2. token inválido → 401 invalid_token
 *     3. uid query == self uid → 200
 *     4. uid query ajeno (no admin) → 403 forbidden_ownership
 *     5. uid query ajeno + role admin → 200 (bypass)
 *     6. uid query ausente → 400 missing_param
 *   §2 /api/cerebro/learn:
 *     7. sin Authorization → 401
 *     8. user role → 403 forbidden
 *     9. admin role → 200
 *   §3 /api/train:
 *    10. sin Authorization → 401
 *    11. user role → 403
 *    12. admin role → 200
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

// ─── Tokens y UIDs de prueba ─────────────────────────────────────────────
const UID_USER = 'user_uid_123';
const UID_ADMIN = 'admin_uid_456';
const TOKEN_USER = 'token-user-valid';
const TOKEN_ADMIN = 'token-admin-valid';

function setupAuth() {
  admin.__mocks.verifyIdToken.mockImplementation(async (tok) => {
    if (tok === TOKEN_USER) return { uid: UID_USER, email: 'user@test.com', role: 'user' };
    if (tok === TOKEN_ADMIN) return { uid: UID_ADMIN, email: 'admin@test.com', role: 'admin' };
    const e = new Error('invalid'); e.code = 'auth/invalid-id-token'; throw e;
  });
}

// ─── Harness app que monta los handlers reales con los mismos middlewares ─
function buildApp() {
  const app = express();

  // GET /api/conversations — handler stub (responde 200 si pasa middleware)
  app.get(
    '/api/conversations',
    requireAuth,
    requireOwnerOfResource('uid', 'query'),
    (req, res) => res.json({ ok: true, uid: req.query.uid })
  );

  // POST /api/cerebro/learn — handler stub
  app.post(
    '/api/cerebro/learn',
    requireAuth,
    requireAdmin,
    express.json(),
    (req, res) => res.json({ ok: true, learned: req.body.text || '' })
  );

  // POST /api/train — handler stub
  app.post(
    '/api/train',
    requireAuth,
    requireAdmin,
    express.json(),
    (req, res) => res.json({ ok: true, trained: req.body.message || '' })
  );

  return app;
}

beforeEach(() => {
  Object.values(admin.__mocks).forEach((m) => m.mockReset && m.mockReset());
  admin.__mocks.firestoreGet.mockResolvedValue({ exists: false });
  setupAuth();
  delete process.env.ADMIN_EMAILS;
});

// ════════════════════════════════════════════════════════════════════════
// §1 — /api/conversations (rrRequireAuth + rrRequireOwnerOfResource('uid', 'query'))
// ════════════════════════════════════════════════════════════════════════

describe('§1 /api/conversations', () => {
  test('case 1 — sin Authorization → 401 missing_token', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/conversations?uid=any');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });

  test('case 2 — token inválido → 401 invalid_token', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/conversations?uid=any')
      .set('Authorization', 'Bearer fake-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  test('case 3 — uid query == self uid → 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/conversations?uid=${UID_USER}`)
      .set('Authorization', `Bearer ${TOKEN_USER}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.uid).toBe(UID_USER);
  });

  test('case 4 — uid query ajeno (user role) → 403 forbidden_ownership', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/conversations?uid=other_user')
      .set('Authorization', `Bearer ${TOKEN_USER}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_ownership');
    expect(res.body.message).toContain('query.uid=other_user');
  });

  test('case 5 — uid query ajeno + role admin → 200 (bypass)', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/conversations?uid=cualquier_otro_uid')
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe('cualquier_otro_uid');
  });

  test('case 6 — uid query ausente → 400 missing_param', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${TOKEN_USER}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_param');
    expect(res.body.source).toBe('query');
    expect(res.body.paramName).toBe('uid');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 — /api/cerebro/learn (rrRequireAuth + rrRequireAdmin)
// ════════════════════════════════════════════════════════════════════════

describe('§2 /api/cerebro/learn', () => {
  test('case 7 — sin Authorization → 401 missing_token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/cerebro/learn')
      .send({ text: 'algo' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });

  test('case 8 — user role → 403 forbidden', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/cerebro/learn')
      .set('Authorization', `Bearer ${TOKEN_USER}`)
      .send({ text: 'inyección maliciosa' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.required).toContain('admin');
  });

  test('case 9 — admin role → 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/cerebro/learn')
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`)
      .send({ text: 'conocimiento legítimo' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.learned).toBe('conocimiento legítimo');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 — /api/train (rrRequireAuth + rrRequireAdmin)
// ════════════════════════════════════════════════════════════════════════

describe('§3 /api/train', () => {
  test('case 10 — sin Authorization → 401 missing_token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/train')
      .send({ message: 'cualquier cosa' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });

  test('case 11 — user role → 403 forbidden', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/train')
      .set('Authorization', `Bearer ${TOKEN_USER}`)
      .send({ message: 'training malicioso' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  test('case 12 — admin role → 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/train')
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`)
      .send({ message: 'APRENDE: regla de negocio' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
