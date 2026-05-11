'use strict';

/**
 * VI-BILLING-HTML -- tests assets/billing-integration.js
 * 100% branches: init / subscribe / cancelSubscription / renderBillingStatus.
 */

const BillingIntegration = require('../../miia-frontend/assets/billing-integration');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeOkResponse(data) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue(data),
  };
}

function makeErrResponse(data, status) {
  return {
    ok: false,
    status: status || 400,
    json: jest.fn().mockResolvedValue(data),
  };
}

beforeEach(function() {
  BillingIntegration._resetForTest();
});

// ── init ─────────────────────────────────────────────────────────────────────

describe('init', function() {
  test('I.1 sin opts: retorna {initialized:true} con defaults', function() {
    const result = BillingIntegration.init();
    expect(result).toEqual({ initialized: true });
  });

  test('I.2 con opts completos: inicializa correctamente', function() {
    const result = BillingIntegration.init({
      apiBase: 'https://api.example.com',
      getToken: function() { return Promise.resolve('tok'); },
      onRedirect: function(url) { return url; },
      fetch: jest.fn(),
    });
    expect(result).toEqual({ initialized: true });
  });
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('subscribe', function() {
  test('S.1 no inicializado: rechaza not_initialized', function() {
    return BillingIntegration.subscribe('miiadt').catch(function(e) {
      expect(e.message).toBe('not_initialized');
    });
  });

  test('S.2 sin producto: rechaza product_required', function() {
    BillingIntegration.init({ fetch: jest.fn() });
    return BillingIntegration.subscribe(null).catch(function(e) {
      expect(e.message).toBe('product_required');
    });
  });

  test('S.3 getToken devuelve vacio: rechaza no_token', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve(''); },
      fetch: jest.fn(),
    });
    return BillingIntegration.subscribe('miiadt').catch(function(e) {
      expect(e.message).toBe('no_token');
    });
  });

  test('S.4 fetch lanza excepcion: propaga error', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      fetch: jest.fn().mockRejectedValue(new Error('network_fail')),
    });
    return BillingIntegration.subscribe('miiadt').catch(function(e) {
      expect(e.message).toBe('network_fail');
    });
  });

  test('S.5 resp.ok=false: rechaza con error del body', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      fetch: jest.fn().mockResolvedValue(makeErrResponse({ error: 'subscribe_failed' })),
    });
    return BillingIntegration.subscribe('miiadt').catch(function(e) {
      expect(e.message).toBe('subscribe_failed');
    });
  });

  test('S.6 happy path con approvalUrl: llama onRedirect y retorna data', function() {
    var redirectCalled = null;
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      onRedirect: function(url) { redirectCalled = url; },
      fetch: jest.fn().mockResolvedValue(makeOkResponse({
        subscriptionId: 'SUB-123',
        approvalUrl: 'https://paypal.com/approve/SUB-123',
        status: 'APPROVAL_PENDING',
      })),
    });
    return BillingIntegration.subscribe('miiadt').then(function(data) {
      expect(data.subscriptionId).toBe('SUB-123');
      expect(data.approvalUrl).toBe('https://paypal.com/approve/SUB-123');
      expect(redirectCalled).toBe('https://paypal.com/approve/SUB-123');
    });
  });

  test('S.7 happy path sin approvalUrl: no llama onRedirect', function() {
    var redirectCalled = false;
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      onRedirect: function() { redirectCalled = true; },
      fetch: jest.fn().mockResolvedValue(makeOkResponse({
        subscriptionId: 'SUB-456',
        status: 'ACTIVE',
      })),
    });
    return BillingIntegration.subscribe('ludomiia').then(function(data) {
      expect(data.subscriptionId).toBe('SUB-456');
      expect(redirectCalled).toBe(false);
    });
  });
});

// ── cancelSubscription ────────────────────────────────────────────────────────

describe('cancelSubscription', function() {
  test('C.1 no inicializado: rechaza not_initialized', function() {
    return BillingIntegration.cancelSubscription('SUB-123').catch(function(e) {
      expect(e.message).toBe('not_initialized');
    });
  });

  test('C.2 sin subscriptionId: rechaza subscription_id_required', function() {
    BillingIntegration.init({ fetch: jest.fn() });
    return BillingIntegration.cancelSubscription(null).catch(function(e) {
      expect(e.message).toBe('subscription_id_required');
    });
  });

  test('C.3 getToken vacio: rechaza no_token', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve(''); },
      fetch: jest.fn(),
    });
    return BillingIntegration.cancelSubscription('SUB-123').catch(function(e) {
      expect(e.message).toBe('no_token');
    });
  });

  test('C.4 fetch lanza excepcion: propaga error', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      fetch: jest.fn().mockRejectedValue(new Error('net_err')),
    });
    return BillingIntegration.cancelSubscription('SUB-123').catch(function(e) {
      expect(e.message).toBe('net_err');
    });
  });

  test('C.5 resp.ok=false: rechaza con error del body', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      fetch: jest.fn().mockResolvedValue(makeErrResponse({ error: 'cancel_failed' })),
    });
    return BillingIntegration.cancelSubscription('SUB-123').catch(function(e) {
      expect(e.message).toBe('cancel_failed');
    });
  });

  test('C.6 happy path: retorna data', function() {
    BillingIntegration.init({
      getToken: function() { return Promise.resolve('tok'); },
      fetch: jest.fn().mockResolvedValue(makeOkResponse({ ok: true })),
    });
    return BillingIntegration.cancelSubscription('SUB-123', 'test reason').then(function(data) {
      expect(data.ok).toBe(true);
    });
  });
});

// ── renderBillingStatus ───────────────────────────────────────────────────────

describe('renderBillingStatus', function() {
  test('R.1 status active: label=Activo, isActive=true', function() {
    var r = BillingIntegration.renderBillingStatus({ payment_status: 'active', paypal_subscription_id: 'SUB-1' });
    expect(r.label).toBe('Activo');
    expect(r.color).toBe('#22c55e');
    expect(r.isActive).toBe(true);
    expect(r.isTrial).toBe(false);
    expect(r.isCancelled).toBe(false);
    expect(r.isPaymentFailed).toBe(false);
    expect(r.subscriptionId).toBe('SUB-1');
  });

  test('R.2 status cancelled: label=Cancelado, isCancelled=true', function() {
    var r = BillingIntegration.renderBillingStatus({ payment_status: 'cancelled', cancelled_at: '2026-01-01' });
    expect(r.label).toBe('Cancelado');
    expect(r.color).toBe('#ef4444');
    expect(r.isCancelled).toBe(true);
    expect(r.isActive).toBe(false);
    expect(r.cancelledAt).toBe('2026-01-01');
  });

  test('R.3 status payment_failed: label=Pago fallido, isPaymentFailed=true', function() {
    var r = BillingIntegration.renderBillingStatus({ payment_status: 'payment_failed' });
    expect(r.label).toBe('Pago fallido');
    expect(r.color).toBe('#f59e0b');
    expect(r.isPaymentFailed).toBe(true);
    expect(r.isActive).toBe(false);
  });

  test('R.4 status trial: label=Prueba gratuita, isTrial=true', function() {
    var r = BillingIntegration.renderBillingStatus({ payment_status: 'trial' });
    expect(r.label).toBe('Prueba gratuita');
    expect(r.color).toBe('#00E5FF');
    expect(r.isTrial).toBe(true);
  });

  test('R.5 sin data: default a trial', function() {
    var r = BillingIntegration.renderBillingStatus();
    expect(r.isTrial).toBe(true);
    expect(r.subscriptionId).toBeNull();
  });

  test('R.6 status desconocido: label=status raw, color gris', function() {
    var r = BillingIntegration.renderBillingStatus({ payment_status: 'suspended' });
    expect(r.label).toBe('suspended');
    expect(r.color).toBe('#a1a1a6');
    expect(r.isActive).toBe(false);
    expect(r.isTrial).toBe(false);
  });

  test('R.7 campos opcionales se propagan correctamente', function() {
    var r = BillingIntegration.renderBillingStatus({
      payment_status: 'active',
      paypal_subscription_id: 'SUB-999',
      activated_at: '2026-03-01',
      cancelled_at: '2026-04-01',
      plan_end_date: '2026-05-01',
    });
    expect(r.subscriptionId).toBe('SUB-999');
    expect(r.activatedAt).toBe('2026-03-01');
    expect(r.cancelledAt).toBe('2026-04-01');
    expect(r.planEndDate).toBe('2026-05-01');
  });
});
