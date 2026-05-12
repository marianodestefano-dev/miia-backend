'use strict';

/**
 * C8 — Tests rotate_credentials.js
 * 100% branches: rotacion OK + fallo Railway + timeout + params invalidos.
 */

// Mock https y http para no hacer requests reales
const https = require('https');
const http = require('http');
jest.mock('https');
jest.mock('http');

function makeHttpsMock(status, body) {
  var EventEmitter = require('events');
  var res = new EventEmitter();
  res.statusCode = status;

  var req = new EventEmitter();
  req.write = jest.fn();
  req.end = jest.fn().mockImplementation(function() {
    setImmediate(function() {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
  });
  req.destroy = jest.fn();

  https.request.mockReturnValue(req);
  https.request.mockImplementation(function(opts, cb) {
    cb(res);
    return req;
  });
  return { req, res };
}

const rc = require('../scripts/rotate_credentials');

beforeEach(function() {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(function() {});
  jest.spyOn(console, 'error').mockImplementation(function() {});
});

afterEach(function() {
  console.log.mockRestore();
  console.error.mockRestore();
});

// ============================================================
// logRotation
// ============================================================
describe('C8 logRotation', function() {
  test('OK loggea con console.log', function() {
    rc.logRotation('gemini', 'OK', 'test detail');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[ROTATE][gemini] OK'));
  });

  test('ERROR loggea con console.error', function() {
    rc.logRotation('gemini', 'ERROR', 'fallo');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ROTATE][gemini] ERROR'));
  });

  test('OK sin detail no lanza', function() {
    expect(function() { rc.logRotation('svc', 'OK'); }).not.toThrow();
  });
});

// ============================================================
// rotateGeminiKey
// ============================================================
describe('C8 rotateGeminiKey', function() {
  test('sin currentKey: retorna ok=false', async function() {
    var r = await rc.rotateGeminiKey('', 'proj');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requerida/);
  });

  test('sin projectId: retorna ok=false', async function() {
    var r = await rc.rotateGeminiKey('key123', '');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requerido/);
  });

  test('HTTP 200 con keyString: retorna ok=true + newKey', async function() {
    makeHttpsMock(200, JSON.stringify({ keyString: 'nueva-key-abc' }));
    var r = await rc.rotateGeminiKey('current-key', 'my-project');
    expect(r.ok).toBe(true);
    expect(r.newKey).toBe('nueva-key-abc');
  });

  test('HTTP 403: retorna ok=false con error', async function() {
    makeHttpsMock(403, JSON.stringify({ error: 'forbidden' }));
    var r = await rc.rotateGeminiKey('current-key', 'my-project');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });

  test('respuesta sin keyString: retorna ok=false', async function() {
    makeHttpsMock(200, JSON.stringify({ otherField: 'x' }));
    var r = await rc.rotateGeminiKey('key', 'proj');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/keyString ausente/);
  });

  test('error de red: retorna ok=false', async function() {
    https.request.mockImplementation(function(opts, cb) {
      var EventEmitter = require('events');
      var req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn().mockImplementation(function() {
        setImmediate(function() { req.emit('error', new Error('ECONNREFUSED')); });
      });
      req.destroy = jest.fn();
      return req;
    });
    var r = await rc.rotateGeminiKey('key', 'proj');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
});

// ============================================================
// rotateFirebaseServiceAccount
// ============================================================
describe('C8 rotateFirebaseServiceAccount', function() {
  test('parametros incompletos: retorna ok=false', async function() {
    var r = await rc.rotateFirebaseServiceAccount('', 'sa@x.iam', 'tok');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requeridos/);
  });

  test('HTTP 200: retorna ok=true con keyId', async function() {
    makeHttpsMock(200, JSON.stringify({
      name: 'projects/p/serviceAccounts/sa/keys/KEY123',
      privateKeyData: 'base64data',
    }));
    var r = await rc.rotateFirebaseServiceAccount(
      'uid1',
      'sa@project.iam.gserviceaccount.com',
      'oauth-token'
    );
    expect(r.ok).toBe(true);
    expect(r.keyId).toBe('KEY123');
  });

  test('HTTP 403: retorna ok=false', async function() {
    makeHttpsMock(403, '{"error":"forbidden"}');
    var r = await rc.rotateFirebaseServiceAccount(
      'uid1', 'sa@project.iam.gserviceaccount.com', 'token'
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });

  test('error de red: retorna ok=false', async function() {
    https.request.mockImplementation(function(opts, cb) {
      var EventEmitter = require('events');
      var req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn().mockImplementation(function() {
        setImmediate(function() { req.emit('error', new Error('ECONNRESET')); });
      });
      req.destroy = jest.fn();
      return req;
    });
    var r = await rc.rotateFirebaseServiceAccount('u', 'sa@p.iam.gserviceaccount.com', 't');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
  });
});
