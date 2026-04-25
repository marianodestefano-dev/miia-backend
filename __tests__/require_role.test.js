'use strict';

/**
 * Tests de require_role.js — C-406 Cimientos §3 C.7.
 *
 * Jest + mock firebase-admin (verifyIdToken + Firestore lookup).
 * Cubre 6 casos per carta §2(d):
 *   1. Token válido + role match → next() llamado
 *   2. Token válido + role mismatch → 403
 *   3. Token inválido → 401
 *   4. Header Authorization missing → 401
 *   5. Token expired → 401
 *   6. Admin bypasea requireOwnerOfResource
 *
 * Plus tests unitarios de helpers internos (_extractBearerToken).
 */

// Mock firebase-admin ANTES de require require_role
jest.mock('firebase-admin', () => {
  const mockVerifyIdToken = jest.fn();
  const mockFirestoreGet = jest.fn();
  return {
    app: jest.fn(() => ({ name: 'test-app' })),
    auth: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken })),
    firestore: jest.fn(() => ({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({ get: mockFirestoreGet })),
      })),
    })),
    __mockVerifyIdToken: mockVerifyIdToken,
    __mockFirestoreGet: mockFirestoreGet,
  };
});

const admin = require('firebase-admin');
const {
  requireAuth,
  requireRole,
  requireAdmin,
  requireOwner,
  requireOwnerOfResource,
  _extractBearerToken,
} = require('../core/require_role');

// Helper: armar req + res mock
function makeReqRes({ authHeader, params = {} } = {}) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
    params,
  };
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return { req, res };
}

beforeEach(() => {
  admin.__mockVerifyIdToken.mockReset();
  admin.__mockFirestoreGet.mockReset();
  // default firestore lookup → no encuentra usuario → role='user'
  admin.__mockFirestoreGet.mockResolvedValue({ exists: false });
  // Sin ADMIN_EMAILS por default
  delete process.env.ADMIN_EMAILS;
});

// ═══════════════════════════════════════════════════════════════
// §1 — _extractBearerToken helper
// ═══════════════════════════════════════════════════════════════

describe('_extractBearerToken', () => {
  test('extrae token válido', () => {
    const req = { headers: { authorization: 'Bearer abc123' } };
    expect(_extractBearerToken(req)).toBe('abc123');
  });

  test('retorna null si header missing', () => {
    expect(_extractBearerToken({ headers: {} })).toBeNull();
  });

  test('retorna null si header no empieza con Bearer', () => {
    const req = { headers: { authorization: 'Basic xyz' } };
    expect(_extractBearerToken(req)).toBeNull();
  });

  test('retorna null si Bearer + empty', () => {
    const req = { headers: { authorization: 'Bearer ' } };
    expect(_extractBearerToken(req)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// §2 — requireAuth middleware
// ═══════════════════════════════════════════════════════════════

describe('requireAuth', () => {
  test('token válido → inyecta req.user y llama next()', async () => {
    admin.__mockVerifyIdToken.mockResolvedValue({
      uid: 'user123',
      email: 'user@test.com',
    });
    const { req, res } = makeReqRes({ authHeader: 'Bearer valid-token' });
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user.uid).toBe('user123');
    expect(req.user.email).toBe('user@test.com');
    expect(req.user.role).toBe('user'); // default porque no hay Firestore doc
  });

  test('token expirado → 401', async () => {
    admin.__mockVerifyIdToken.mockRejectedValue({
      code: 'auth/id-token-expired',
      message: 'Token expired',
    });
    const { req, res } = makeReqRes({ authHeader: 'Bearer expired-token' });
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('invalid_token');
  });

  test('header Authorization missing → 401', async () => {
    const { req, res } = makeReqRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('missing_token');
  });

  test('email en ADMIN_EMAILS → role=admin bypass', async () => {
    process.env.ADMIN_EMAILS = 'admin@miia.com,hola@miia-app.com';
    admin.__mockVerifyIdToken.mockResolvedValue({
      uid: 'admin_uid',
      email: 'admin@miia.com',
    });
    const { req, res } = makeReqRes({ authHeader: 'Bearer admin-token' });
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('admin');
    expect(req.user.isAdmin).toBe(true);
  });

  test('custom claim role en token → usa directo', async () => {
    admin.__mockVerifyIdToken.mockResolvedValue({
      uid: 'owner_uid',
      email: 'owner@test.com',
      role: 'owner',
    });
    const { req, res } = makeReqRes({ authHeader: 'Bearer owner-token' });
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(req.user.role).toBe('owner');
    expect(req.user.isAdmin).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// §3 — requireRole middleware factory
// ═══════════════════════════════════════════════════════════════

describe('requireRole', () => {
  test('role match (string) → next()', () => {
    const middleware = requireRole('admin');
    const req = { user: { uid: 'x', role: 'admin' } };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  test('role match (array) → next()', () => {
    const middleware = requireRole(['admin', 'owner']);
    const req = { user: { uid: 'x', role: 'owner' } };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('role mismatch → 403', () => {
    const middleware = requireRole('admin');
    const req = { user: { uid: 'x', role: 'user' } };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('forbidden');
  });

  test('req.user missing (requireAuth no corrió) → 401', () => {
    const middleware = requireRole('admin');
    const req = {};
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('not_authenticated');
  });
});

// ═══════════════════════════════════════════════════════════════
// §4 — requireOwnerOfResource middleware factory
// ═══════════════════════════════════════════════════════════════

describe('requireOwnerOfResource', () => {
  test('user.uid coincide con req.params.uid → next()', () => {
    const middleware = requireOwnerOfResource('uid');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      params: { uid: 'user123' },
    };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('user.uid distinto a req.params.uid → 403', () => {
    const middleware = requireOwnerOfResource('uid');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      params: { uid: 'other_user' },
    };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('forbidden_ownership');
  });

  test('admin bypasea ownership check aunque uid no coincida', () => {
    const middleware = requireOwnerOfResource('uid');
    const req = {
      user: { uid: 'admin_uid', role: 'admin', isAdmin: true },
      params: { uid: 'some_other_user' },
    };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('req.params[paramName] missing → 400', () => {
    const middleware = requireOwnerOfResource('uid');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      params: {},
    };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('missing_param');
  });

  test('req.user missing → 401', () => {
    const middleware = requireOwnerOfResource('uid');
    const req = { params: { uid: 'x' } };
    const { res } = makeReqRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(res._status).toBe(401);
  });

  // ═══ C-406.b.crit Pieza D — source param extensión ═══

  test('C-406.b.crit — source="query" lee de req.query', () => {
    const middleware = requireOwnerOfResource('uid', 'query');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      query: { uid: 'user123' },
      params: {},
    };
    const { res } = makeReqRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('C-406.b.crit — source="query" rechaza uid ajeno con 403', () => {
    const middleware = requireOwnerOfResource('uid', 'query');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      query: { uid: 'other_user' },
      params: {},
    };
    const { res } = makeReqRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body.message).toContain('query.uid=other_user');
  });

  test('C-406.b.crit — source="body" lee de req.body', () => {
    const middleware = requireOwnerOfResource('uid', 'body');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      body: { uid: 'user123', other: 'data' },
      params: {},
    };
    const { res } = makeReqRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('C-406.b.crit — source inválido throws al construir factory', () => {
    expect(() => requireOwnerOfResource('uid', 'cookies')).toThrow(/source inválido/);
  });

  test('C-406.b.crit — backwards compat: sin source default "params"', () => {
    // Mismo signature que C-406 original — 5 endpoints ya migrados NO requieren cambios
    const middleware = requireOwnerOfResource('uid');
    const req = {
      user: { uid: 'user123', role: 'user', isAdmin: false },
      params: { uid: 'user123' },
    };
    const { res } = makeReqRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('C-406.b.crit — admin bypasea source="query" igual que params', () => {
    const middleware = requireOwnerOfResource('uid', 'query');
    const req = {
      user: { uid: 'admin_uid', role: 'admin', isAdmin: true },
      query: { uid: 'some_other_user' },
    };
    const { res } = makeReqRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// §5 — Atajos requireAdmin y requireOwner
// ═══════════════════════════════════════════════════════════════

describe('requireAdmin y requireOwner atajos', () => {
  test('requireAdmin acepta role=admin', () => {
    const req = { user: { uid: 'x', role: 'admin' } };
    const { res } = makeReqRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('requireAdmin rechaza role=owner con 403', () => {
    const req = { user: { uid: 'x', role: 'owner' } };
    const { res } = makeReqRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res._status).toBe(403);
  });

  test('requireOwner acepta role=owner', () => {
    const req = { user: { uid: 'x', role: 'owner' } };
    const { res } = makeReqRes();
    const next = jest.fn();
    requireOwner(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('requireOwner acepta role=admin (admin siempre tiene acceso)', () => {
    const req = { user: { uid: 'x', role: 'admin' } };
    const { res } = makeReqRes();
    const next = jest.fn();
    requireOwner(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('requireOwner rechaza role=user con 403', () => {
    const req = { user: { uid: 'x', role: 'user' } };
    const { res } = makeReqRes();
    const next = jest.fn();
    requireOwner(req, res, next);
    expect(res._status).toBe(403);
  });
});
