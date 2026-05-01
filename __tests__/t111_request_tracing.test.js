'use strict';
const { generateRequestId, requestTracingMiddleware, getRequestId, createRequestLogger } = require('../core/request_tracing');

describe('generateRequestId', () => {
  test('retorna string que empieza con req_', () => {
    const id = generateRequestId();
    expect(typeof id).toBe('string');
    expect(id.startsWith('req_')).toBe(true);
  });
  test('cada llamada genera un ID unico', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });
  test('longitud razonable (< 64 chars)', () => {
    const id = generateRequestId();
    expect(id.length).toBeLessThan(64);
  });
});

describe('requestTracingMiddleware', () => {
  function makeMockReq(headers = {}) {
    return { headers, path: '/test', method: 'GET', requestId: undefined };
  }
  function makeMockRes() {
    const headers = {};
    return {
      setHeader: (k, v) => { headers[k] = v; },
      _headers: headers,
    };
  }

  test('asigna req.requestId si no viene en header', () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const next = jest.fn();
    requestTracingMiddleware()(req, res, next);
    expect(req.requestId).toBeDefined();
    expect(req.requestId.startsWith('req_')).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  test('respeta X-Request-ID del cliente si viene', () => {
    const req = makeMockReq({ 'x-request-id': 'client_trace_abc' });
    const res = makeMockRes();
    const next = jest.fn();
    requestTracingMiddleware()(req, res, next);
    expect(req.requestId).toBe('client_trace_abc');
  });

  test('ignora X-Request-ID demasiado largo (>= 64 chars)', () => {
    const longId = 'x'.repeat(64);
    const req = makeMockReq({ 'x-request-id': longId });
    const res = makeMockRes();
    const next = jest.fn();
    requestTracingMiddleware()(req, res, next);
    expect(req.requestId).not.toBe(longId);
    expect(req.requestId.startsWith('req_')).toBe(true);
  });

  test('setea X-Request-ID en response header', () => {
    const req = makeMockReq();
    const res = makeMockRes();
    requestTracingMiddleware()(req, res, jest.fn());
    expect(res._headers['X-Request-ID']).toBe(req.requestId);
  });
});

describe('getRequestId', () => {
  test('retorna requestId de req si existe', () => {
    expect(getRequestId({ requestId: 'req_abc' })).toBe('req_abc');
  });
  test('retorna x-request-id de headers si requestId no existe', () => {
    expect(getRequestId({ headers: { 'x-request-id': 'h_123' } })).toBe('h_123');
  });
  test('retorna no-request-id si req es null', () => {
    expect(getRequestId(null)).toBe('no-request-id');
  });
  test('retorna no-request-id si req no tiene id', () => {
    expect(getRequestId({})).toBe('no-request-id');
  });
});

describe('createRequestLogger', () => {
  test('retorna objeto con log/warn/error y requestId', () => {
    const logger = createRequestLogger('req_test_123');
    expect(logger.requestId).toBe('req_test_123');
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
  test('funciones de log son llamables sin error', () => {
    const logger = createRequestLogger('req_abc');
    expect(() => logger.log('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });
});
