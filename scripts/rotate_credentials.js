'use strict';

/**
 * CIMIENTOS C8 — Rotacion de credenciales Gemini/Firebase
 * Funciones de rotacion con AbortController (regla 6.18) y log estructurado.
 * NO ejecuta rotacion automaticamente — debe ser llamado explicitamente.
 */

const https = require('https');
const http = require('http');

const ROTATION_TIMEOUT_MS = 30000;

/**
 * Log estructurado de rotacion.
 * @param {string} service
 * @param {'OK'|'ERROR'} result
 * @param {string} [detail]
 */
function logRotation(service, result, detail) {
  var ts = new Date().toISOString();
  if (result === 'OK') {
    console.log('[ROTATE][' + service + '] OK -- ' + ts + (detail ? ' -- ' + detail : ''));
  } else {
    console.error('[ROTATE][' + service + '] ERROR -- ' + ts + (detail ? ' -- ' + detail : ''));
  }
}

/**
 * Hace una request HTTP/S con AbortController timeout.
 * @param {string} url
 * @param {Object} opts - {method, headers, body}
 * @returns {Promise<{status, body}>}
 */
function fetchWithTimeout(url, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    var controller = new AbortController();
    var timer = setTimeout(function() {
      controller.abort();
      reject(new Error('ROTATE fetch timeout ' + ROTATION_TIMEOUT_MS + 'ms'));
    }, ROTATION_TIMEOUT_MS);

    var parsedUrl = new URL(url);
    var lib = parsedUrl.protocol === 'https:' ? https : http;
    var reqOpts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };

    var req = lib.request(reqOpts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
    });

    req.on('error', function(err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        reject(new Error('ROTATE fetch aborted'));
      } else {
        reject(err);
      }
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();

    // Abortar si el controller fue abortado externamente
    controller.signal.addEventListener('abort', function() {
      req.destroy();
    });
  });
}

/**
 * Rota la API key de Gemini via Google AI Studio API.
 * @param {string} currentKey - Key actual
 * @param {string} projectId - GCP project ID
 * @returns {Promise<{ok: boolean, newKey?: string, error?: string}>}
 */
async function rotateGeminiKey(currentKey, projectId) {
  if (!currentKey) {
    logRotation('gemini', 'ERROR', 'currentKey vacia');
    return { ok: false, error: 'currentKey requerida' };
  }
  if (!projectId) {
    logRotation('gemini', 'ERROR', 'projectId vacio');
    return { ok: false, error: 'projectId requerido' };
  }

  try {
    // Llamada a la API de Google Cloud AI para crear nueva key
    var url = 'https://generativelanguage.googleapis.com/v1beta/projects/' + projectId + '/apiKeys?key=' + currentKey;
    var res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'miia-rotated-' + Date.now() }),
    });

    if (res.status !== 200 && res.status !== 201) {
      logRotation('gemini', 'ERROR', 'HTTP ' + res.status);
      return { ok: false, error: 'HTTP ' + res.status + ': ' + res.body.slice(0, 100) };
    }

    var data = JSON.parse(res.body);
    var newKey = data.keyString || data.key || null;
    if (!newKey) {
      logRotation('gemini', 'ERROR', 'respuesta sin keyString');
      return { ok: false, error: 'keyString ausente en respuesta' };
    }

    logRotation('gemini', 'OK', 'nueva key generada');
    return { ok: true, newKey: newKey };
  } catch (err) {
    logRotation('gemini', 'ERROR', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Rota el service account key de Firebase GCP.
 * @param {string} uid - UID del owner (identificador)
 * @param {string} serviceAccountEmail
 * @param {string} accessToken - OAuth2 token con permisos iam.serviceAccountKeys.create
 * @returns {Promise<{ok: boolean, keyId?: string, error?: string}>}
 */
async function rotateFirebaseServiceAccount(uid, serviceAccountEmail, accessToken) {
  if (!uid || !serviceAccountEmail || !accessToken) {
    logRotation('firebase-sa', 'ERROR', 'parametros incompletos uid=' + uid);
    return { ok: false, error: 'uid, serviceAccountEmail y accessToken requeridos' };
  }

  try {
    var projectId = serviceAccountEmail.split('@')[1].replace('.iam.gserviceaccount.com', '');
    var url = 'https://iam.googleapis.com/v1/projects/' + projectId + '/serviceAccounts/' + serviceAccountEmail + '/keys';
    var res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keyAlgorithm: 'KEY_ALG_RSA_2048' }),
    });

    if (res.status !== 200) {
      logRotation('firebase-sa', 'ERROR', 'HTTP ' + res.status + ' uid=' + uid);
      return { ok: false, error: 'HTTP ' + res.status };
    }

    var data = JSON.parse(res.body);
    var keyId = data.name ? data.name.split('/').pop() : null;
    logRotation('firebase-sa', 'OK', 'keyId=' + keyId + ' uid=' + uid);
    return { ok: true, keyId: keyId, privateKeyData: data.privateKeyData };
  } catch (err) {
    logRotation('firebase-sa', 'ERROR', err.message + ' uid=' + uid);
    return { ok: false, error: err.message };
  }
}

module.exports = { rotateGeminiKey, rotateFirebaseServiceAccount, logRotation, fetchWithTimeout };
