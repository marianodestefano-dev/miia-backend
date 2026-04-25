'use strict';

/**
 * Tests endpoint Consent — C-410 Cimientos §3 C.10 / Mitigación B.
 *
 * Cubre POST /disclaimer-mode + GET/PUT/DELETE /exclusions/:phone.
 * Mock firebase-admin (auth verifyIdToken + Firestore CRUD) — NO red, NO IO.
 *
 * Casos:
 *  1. POST disclaimer-mode (mode=B, token owner válido) → 200 + set llamado
 *  2. POST disclaimer-mode mode inválido → 400 invalid_mode
 *  3. POST disclaimer-mode sin Authorization → 401 missing_token
 *  4. POST disclaimer-mode role=user → 403 forbidden (requireOwner)
 *  5. GET exclusions empty → 200 count=0
 *  6. PUT exclusions phone válido → 200 + set llamado
 *  7. PUT exclusions phone inválido → 400 invalid_phone
 *  8. DELETE exclusion existente → 200 + delete llamado
 *  9. DELETE exclusion no existente → 404 not_found
 * 10. Helper _normalizePhone (unit)
 */

// ─── Mock firebase-admin ANTES del require de routes/consent ────────────
jest.mock('firebase-admin', () => {
  const verifyIdToken = jest.fn();

  // Mock Firestore graph: collection().doc().[set/get/delete/collection().doc().*]
  const setMock = jest.fn().mockResolvedValue();
  const deleteMock = jest.fn().mockResolvedValue();
  const getMock = jest.fn(); // configurable per test
  const orderByGetMock = jest.fn();

  // Genera un docRef "vivo" cada vez que se llama (para no compartir estado)
  const makeDocRef = () => ({
    set: setMock,
    get: getMock,
    delete: deleteMock,
    // anidado: doc().collection('x').doc('y').set/get/delete
    collection: jest.fn(() => makeColRef()),
  });

  const makeColRef = () => ({
    doc: jest.fn(() => makeDocRef()),
    orderBy: jest.fn(() => ({ get: orderByGetMock })),
    get: orderByGetMock,
  });

  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(() => makeColRef()),
  }));

  return {
    app: jest.fn(() => ({ name: 'test-app' })),
    auth: jest.fn(() => ({ verifyIdToken })),
    firestore: firestoreFn,
    __mocks: { verifyIdToken, setMock, deleteMock, getMock, orderByGetMock },
  };
});

const admin = require('firebase-admin');
const express = require('express');
const request = require('supertest');

const createConsentRoutes = require('../routes/consent');
const { _normalizePhone, _VALID_MODES } = require('../routes/consent');

// ─── Helpers ────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/owner/consent', createConsentRoutes());
  return app;
}

const TOKEN_OWNER = 'token-owner';
const TOKEN_USER = 'token-user';
const UID_OWNER = 'owner_uid_123';

function setupOwnerToken() {
  admin.__mocks.verifyIdToken.mockImplementation(async (tok) => {
    if (tok === TOKEN_OWNER) return { uid: UID_OWNER, email: 'owner@test.com', role: 'owner' };
    if (tok === TOKEN_USER) return { uid: 'user_uid', email: 'user@test.com', role: 'user' };
    const err = new Error('invalid'); err.code = 'auth/invalid-id-token';
    throw err;
  });
}

beforeEach(() => {
  Object.values(admin.__mocks).forEach((m) => m.mockReset && m.mockReset());
  // defaults
  admin.__mocks.setMock.mockResolvedValue();
  admin.__mocks.deleteMock.mockResolvedValue();
  setupOwnerToken();
  delete process.env.ADMIN_EMAILS;
});

// ════════════════════════════════════════════════════════════════════════
// §1 — Helper unit
// ════════════════════════════════════════════════════════════════════════

describe('_normalizePhone', () => {
  test('acepta E.164 sin +', () => {
    expect(_normalizePhone('573054169969')).toBe('573054169969');
  });
  test('strip + y caracteres no numéricos', () => {
    expect(_normalizePhone('+57 305 416-9969')).toBe('573054169969');
  });
  test('rechaza string vacío', () => {
    expect(_normalizePhone('')).toBeNull();
  });
  test('rechaza demasiado corto', () => {
    expect(_normalizePhone('123')).toBeNull();
  });
  test('rechaza non-string', () => {
    expect(_normalizePhone(null)).toBeNull();
    expect(_normalizePhone(undefined)).toBeNull();
    expect(_normalizePhone(573054169969)).toBeNull();
  });
  test('rechaza si empieza con 0', () => {
    expect(_normalizePhone('0573054169969')).toBeNull();
  });
});

describe('_VALID_MODES', () => {
  test('contiene exactamente A, B, C', () => {
    expect(_VALID_MODES).toEqual(['A', 'B', 'C']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 — POST /disclaimer-mode
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/owner/consent/disclaimer-mode', () => {
  test('case 1 — mode válido (B) + owner token → 200 + Firestore set llamado', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner/consent/disclaimer-mode')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`)
      .send({ mode: 'B', acknowledgment: 'Entiendo y acepto' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mode).toBe('B');
    expect(res.body.modeDescription).toMatch(/firmar/);
    expect(res.body.acknowledgment).toBe('Entiendo y acepto');
    expect(res.body.updatedBy).toBe(UID_OWNER);
    expect(admin.__mocks.setMock).toHaveBeenCalled();
  });

  test('case 2 — mode inválido (X) → 400 invalid_mode', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner/consent/disclaimer-mode')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`)
      .send({ mode: 'X' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_mode');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('case 3 — sin Authorization → 401 missing_token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner/consent/disclaimer-mode')
      .send({ mode: 'A' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('case 4 — role=user → 403 forbidden (requireOwner)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner/consent/disclaimer-mode')
      .set('Authorization', `Bearer ${TOKEN_USER}`)
      .send({ mode: 'A' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('case 4b — token inválido → 401 invalid_token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner/consent/disclaimer-mode')
      .set('Authorization', 'Bearer fake-token')
      .send({ mode: 'A' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  test('case 4c — los 3 modos válidos persisten descripciones distintas', async () => {
    for (const mode of ['A', 'B', 'C']) {
      const app = buildApp();
      const res = await request(app)
        .post('/api/owner/consent/disclaimer-mode')
        .set('Authorization', `Bearer ${TOKEN_OWNER}`)
        .send({ mode });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe(mode);
      expect(res.body.modeDescription).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 — GET /exclusions
// ════════════════════════════════════════════════════════════════════════

describe('GET /api/owner/consent/exclusions', () => {
  test('case 5 — empty list → 200 count=0', async () => {
    admin.__mocks.orderByGetMock.mockResolvedValueOnce({
      docs: [],
    });

    const app = buildApp();
    const res = await request(app)
      .get('/api/owner/consent/exclusions')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.exclusions).toEqual([]);
  });

  test('case 5b — con 2 exclusiones → 200 count=2 + phones expuestos', async () => {
    admin.__mocks.orderByGetMock.mockResolvedValueOnce({
      docs: [
        { id: '573054169969', data: () => ({ excluded: true, reason: 'opt_out', source: 'self_service', addedAt: '2026-04-25T10:00:00Z' }) },
        { id: '573163937365', data: () => ({ excluded: true, reason: 'doctor_paciente', source: 'support', addedAt: '2026-04-25T11:00:00Z' }) },
      ],
    });

    const app = buildApp();
    const res = await request(app)
      .get('/api/owner/consent/exclusions')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.exclusions[0].phone).toBe('573054169969');
    expect(res.body.exclusions[1].phone).toBe('573163937365');
  });

  test('case 5c — sin auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/owner/consent/exclusions');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §4 — PUT /exclusions/:phone
// ════════════════════════════════════════════════════════════════════════

describe('PUT /api/owner/consent/exclusions/:phone', () => {
  test('case 6 — phone válido → 200 + Firestore set llamado', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/owner/consent/exclusions/573054169969')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`)
      .send({ reason: 'medico paciente', source: 'self_service' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.phone).toBe('573054169969');
    expect(res.body.reason).toBe('medico paciente');
    expect(admin.__mocks.setMock).toHaveBeenCalled();
  });

  test('case 7 — phone inválido (3 dígitos) → 400 invalid_phone', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/owner/consent/exclusions/123')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`)
      .send({ reason: 'opt_out' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('case 7b — phone con + y formato → normaliza y guarda', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/owner/consent/exclusions/' + encodeURIComponent('573054169969'))
      .set('Authorization', `Bearer ${TOKEN_OWNER}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('573054169969');
    expect(res.body.reason).toBe('opt_out'); // default
    expect(res.body.source).toBe('self_service'); // default
  });
});

// ════════════════════════════════════════════════════════════════════════
// §5 — DELETE /exclusions/:phone
// ════════════════════════════════════════════════════════════════════════

describe('DELETE /api/owner/consent/exclusions/:phone', () => {
  test('case 8 — exclusión existente → 200 + delete llamado', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({ exists: true, data: () => ({ excluded: true }) });

    const app = buildApp();
    const res = await request(app)
      .delete('/api/owner/consent/exclusions/573054169969')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.restored).toBe(true);
    expect(admin.__mocks.deleteMock).toHaveBeenCalled();
  });

  test('case 9 — exclusión no existente → 404 not_found', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({ exists: false });

    const app = buildApp();
    const res = await request(app)
      .delete('/api/owner/consent/exclusions/573054169969')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(admin.__mocks.deleteMock).not.toHaveBeenCalled();
  });

  test('case 9b — phone inválido en DELETE → 400 invalid_phone', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/api/owner/consent/exclusions/abc')
      .set('Authorization', `Bearer ${TOKEN_OWNER}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
  });

  test('case 9c — DELETE sin auth → 401', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/owner/consent/exclusions/573054169969');
    expect(res.status).toBe(401);
  });
});
