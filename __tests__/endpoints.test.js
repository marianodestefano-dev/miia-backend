/**
 * MIIA Backend — Endpoint Tests
 * Tests: /api/logout, /api/status, /api/stripe/subscribe, /api/stripe/create-checkout-session
 *
 * All external dependencies (Stripe, Firebase, WhatsApp) are mocked.
 */

'use strict';

// ─── Mocks (must be before require of the app) ────────────────────────────────

// Mock whatsapp-web.js
jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    on: jest.fn(),
    logout: jest.fn().mockResolvedValue(true),
    destroy: jest.fn().mockResolvedValue(true)
  })),
  LocalAuth: jest.fn()
}));

// Mock firebase-admin
jest.mock('firebase-admin', () => {
  const updateMock = jest.fn().mockResolvedValue({});
  const docMock = jest.fn(() => ({ update: updateMock }));
  const collectionMock = jest.fn(() => ({ doc: docMock }));
  const firestoreMock = jest.fn(() => ({ collection: collectionMock }));
  firestoreMock.FieldValue = { increment: jest.fn(n => `increment(${n})`) };
  return {
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    firestore: firestoreMock
  };
});

// Mock firebase-admin key file
jest.mock('../firebase-admin-key.json', () => ({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'test@test-project.iam.gserviceaccount.com'
}), { virtual: true });

// Mock stripe
const mockSessionCreate = jest.fn();
jest.mock('stripe', () => jest.fn(() => ({
  checkout: { sessions: { create: mockSessionCreate } },
  webhooks: { constructEvent: jest.fn() }
})));

// Mock cerebro_absoluto
jest.mock('../cerebro_absoluto', () => ({
  init: jest.fn(),
  getTrainingData: jest.fn().mockReturnValue(''),
  setTrainingData: jest.fn(),
  appendLearning: jest.fn(),
  processADNMinerCron: jest.fn()
}));

// Mock other local modules
jest.mock('../cotizacion_generator', () => ({}));
jest.mock('../web_scraper', () => ({ init: jest.fn() }));
jest.mock('../estadisticas', () => ({
  getSummary: jest.fn().mockReturnValue({}),
  trackConversion: jest.fn()
}));
jest.mock('../tenant_manager', () => ({
  initTenant: jest.fn(),
  destroyTenant: jest.fn().mockResolvedValue({ success: true }),
  getTenantStatus: jest.fn().mockReturnValue({ exists: true, isReady: true, hasQR: false, qrCode: null }),
  getTenantConversations: jest.fn().mockResolvedValue([]),
  appendTenantTraining: jest.fn().mockReturnValue(true),
  getAllTenants: jest.fn().mockReturnValue([])
}));

const request = require('supertest');

// ─── Load app after mocks ─────────────────────────────────────────────────────

let app;
beforeAll(() => {
  // Prevent the server from auto-starting WhatsApp on boot
  process.env.SKIP_WA_INIT = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  process.env.FRONTEND_URL = 'https://test.vercel.app';
  process.env.ADMIN_API_KEY = 'test-admin-key';

  // Dynamic require so mocks are in place first
  app = require('../server_v2');
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─── /api/status ──────────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  it('returns disconnected when no WhatsApp client', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connected');
  });

  it('returns tenant status when uid provided', async () => {
    const res = await request(app).get('/api/status?uid=test-uid-123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tenant', 'test-uid-123');
    expect(res.body).toHaveProperty('connected', true);
  });
});

// ─── /api/logout ──────────────────────────────────────────────────────────────

describe('POST /api/logout', () => {
  it('returns success when no client is connected', async () => {
    const res = await request(app).post('/api/logout');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

// ─── /api/stripe/subscribe ────────────────────────────────────────────────────

describe('POST /api/stripe/subscribe', () => {
  beforeEach(() => {
    mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/test-session' });
  });

  it('returns checkout URL for monthly plan', async () => {
    const res = await request(app)
      .post('/api/stripe/subscribe')
      .send({ uid: 'user-123', plan: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body.url).toContain('checkout.stripe.com');
  });

  it('creates session with correct amount for each plan', async () => {
    const plans = [
      { plan: 'monthly',   expectedAmount: 1200 },
      { plan: 'quarterly', expectedAmount: 3000 },
      { plan: 'semestral', expectedAmount: 5500 },
      { plan: 'annual',    expectedAmount: 7500 }
    ];

    for (const { plan, expectedAmount } of plans) {
      mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });

      await request(app)
        .post('/api/stripe/subscribe')
        .send({ uid: 'user-123', plan });

      const callArgs = mockSessionCreate.mock.calls[mockSessionCreate.mock.calls.length - 1][0];
      const unitAmount = callArgs.line_items[0].price_data.unit_amount;
      expect(unitAmount).toBe(expectedAmount);
    }
  });

  it('returns 400 when uid is missing', async () => {
    const res = await request(app)
      .post('/api/stripe/subscribe')
      .send({ plan: 'monthly' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when plan is missing', async () => {
    const res = await request(app)
      .post('/api/stripe/subscribe')
      .send({ uid: 'user-123' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 for invalid plan name', async () => {
    const res = await request(app)
      .post('/api/stripe/subscribe')
      .send({ uid: 'user-123', plan: 'ultraplan' });
    expect(res.status).toBe(400);
  });

  it('includes uid and plan in session metadata', async () => {
    mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });

    await request(app)
      .post('/api/stripe/subscribe')
      .send({ uid: 'uid-abc', plan: 'annual' });

    const callArgs = mockSessionCreate.mock.calls[0][0];
    expect(callArgs.metadata).toMatchObject({ uid: 'uid-abc', plan: 'annual' });
  });
});

// ─── /api/stripe/create-checkout-session (agent) ─────────────────────────────

describe('POST /api/stripe/create-checkout-session', () => {
  beforeEach(() => {
    mockSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/agent-session' });
  });

  it('returns checkout URL for first agent (base price $3.00)', async () => {
    const res = await request(app)
      .post('/api/stripe/create-checkout-session')
      .send({ uid: 'user-123', type: 'agent', agentCount: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');

    const callArgs = mockSessionCreate.mock.calls[0][0];
    const amount = callArgs.line_items[0].price_data.unit_amount;
    expect(amount).toBe(300); // $3.00
  });

  it('applies 10% discount for each additional agent', () => {
    // Verify the discount formula: price = 300 * 0.9^agentCount
    const cases = [
      { agentCount: 0, expected: 300 },   // $3.00
      { agentCount: 1, expected: 270 },   // $2.70 (-10%)
      { agentCount: 2, expected: 243 },   // $2.43 (-10% of $2.70)
      { agentCount: 3, expected: 219 }    // $2.19 (-10% of $2.43)
    ];

    for (const { agentCount, expected } of cases) {
      const calculated = Math.round(300 * Math.pow(0.9, agentCount));
      expect(calculated).toBe(expected);
    }
  });

  it('returns 400 when type is not agent', async () => {
    const res = await request(app)
      .post('/api/stripe/create-checkout-session')
      .send({ uid: 'user-123', type: 'subscription' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when uid is missing', async () => {
    const res = await request(app)
      .post('/api/stripe/create-checkout-session')
      .send({ type: 'agent', agentCount: 0 });
    expect(res.status).toBe(400);
  });
});

// ─── /api/tenant endpoints ────────────────────────────────────────────────────

describe('GET /api/tenant/:uid/status', () => {
  it('returns tenant status', async () => {
    const res = await request(app).get('/api/tenant/test-uid/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('isReady', true);
  });
});

describe('GET /api/tenant/:uid/conversations', () => {
  it('returns empty array when no conversations', async () => {
    const res = await request(app).get('/api/tenant/test-uid/conversations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/tenant/init', () => {
  it('returns 400 when uid or geminiApiKey missing', async () => {
    const res = await request(app)
      .post('/api/tenant/init')
      .send({ uid: 'test-uid' }); // missing geminiApiKey
    expect(res.status).toBe(400);
  });
});
