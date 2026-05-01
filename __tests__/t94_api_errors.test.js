'use strict';

/**
 * T94 — Structured error responses: tests para core/api_errors.js
 * Verifica que sendApiError produce el formato correcto para cada codigo.
 */

const { ERROR_CODES, HTTP_STATUS, sendApiError } = require('../core/api_errors');

function makeMockRes() {
  const body = {};
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(b) { this._body = b; return this; },
  };
  return res;
}

describe('ERROR_CODES', () => {
  test('contiene todos los codigos requeridos', () => {
    expect(ERROR_CODES.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ERROR_CODES.FORBIDDEN).toBe('FORBIDDEN');
    expect(ERROR_CODES.NOT_FOUND).toBe('NOT_FOUND');
    expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
  });

  test('ERROR_CODES esta frozen (inmutable)', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });
});

describe('HTTP_STATUS', () => {
  test('UNAUTHORIZED -> 401', () => expect(HTTP_STATUS.UNAUTHORIZED).toBe(401));
  test('FORBIDDEN -> 403', () => expect(HTTP_STATUS.FORBIDDEN).toBe(403));
  test('NOT_FOUND -> 404', () => expect(HTTP_STATUS.NOT_FOUND).toBe(404));
  test('RATE_LIMITED -> 429', () => expect(HTTP_STATUS.RATE_LIMITED).toBe(429));
  test('INTERNAL_ERROR -> 500', () => expect(HTTP_STATUS.INTERNAL_ERROR).toBe(500));
  test('VALIDATION_ERROR -> 400', () => expect(HTTP_STATUS.VALIDATION_ERROR).toBe(400));
});

describe('sendApiError', () => {
  test('UNAUTHORIZED produce 401 con error + message', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.UNAUTHORIZED, 'Token invalido');
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('UNAUTHORIZED');
    expect(res._body.message).toBe('Token invalido');
  });

  test('FORBIDDEN produce 403', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.FORBIDDEN, 'Sin acceso');
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('FORBIDDEN');
  });

  test('NOT_FOUND produce 404', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.NOT_FOUND, 'Recurso no encontrado');
    expect(res._status).toBe(404);
    expect(res._body.error).toBe('NOT_FOUND');
  });

  test('RATE_LIMITED produce 429', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.RATE_LIMITED, 'Limite alcanzado');
    expect(res._status).toBe(429);
    expect(res._body.error).toBe('RATE_LIMITED');
  });

  test('INTERNAL_ERROR produce 500', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.INTERNAL_ERROR, 'Error interno');
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('INTERNAL_ERROR');
  });

  test('VALIDATION_ERROR produce 400', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.VALIDATION_ERROR, 'Campo requerido');
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('VALIDATION_ERROR');
  });

  test('incluye requestId si se pasa en extra', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.NOT_FOUND, 'No encontrado', { requestId: 'req-abc-123' });
    expect(res._body.requestId).toBe('req-abc-123');
  });

  test('incluye details si se pasa en extra', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.FORBIDDEN, 'Sin acceso', { details: { requiredRole: ['owner'] } });
    expect(res._body.details).toBeDefined();
    expect(res._body.details.requiredRole).toEqual(['owner']);
  });

  test('codigo desconocido produce 500 por default', () => {
    const res = makeMockRes();
    sendApiError(res, 'UNKNOWN_CODE', 'Error desconocido');
    expect(res._status).toBe(500);
  });

  test('message se convierte a string aunque se pase numero', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.INTERNAL_ERROR, 42);
    expect(typeof res._body.message).toBe('string');
    expect(res._body.message).toBe('42');
  });
});
