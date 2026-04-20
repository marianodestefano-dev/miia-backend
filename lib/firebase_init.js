'use strict';

/**
 * Inicializador común de Firebase Admin para scripts backend.
 *
 * Prioridad de credenciales:
 *   1. firebase-admin-key.json (dev local)
 *   2. FIREBASE_SERVICE_ACCOUNT (JSON string env var)
 *   3. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (individuales)
 *
 * Fix operativo (C-302 → G.1):
 * Railway CLI en Windows envuelve FIREBASE_PRIVATE_KEY con comillas literales
 * (doble o simple). Sin `slice(1,-1)` previo al replace `\\n → \n`, el PEM
 * queda malformado → `DECODER routines::unsupported` en gRPC auth.
 *
 * IDEMPOTENTE: si `admin.apps.length > 0` retorna true sin re-inicializar.
 *
 * @param {Object} [opts]
 * @param {string} [opts.backendRoot] — ruta absoluta al root del backend (para buscar
 *   firebase-admin-key.json). Default: dirname(__dirname) — asume este archivo en /lib.
 * @returns {boolean} true si quedó inicializado, false si no había credencial.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function initFirebase({ backendRoot } = {}) {
  if (admin.apps.length) return true;

  const root = backendRoot || path.join(__dirname, '..');
  const keyPath = path.join(root, 'firebase-admin-key.json');
  let credential = null;

  if (fs.existsSync(keyPath)) {
    credential = admin.credential.cert(require(keyPath));
    console.log('[FIREBASE] ✅ Inicializado con firebase-admin-key.json');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const rawJSON = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n');
    const sa = JSON.parse(rawJSON);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    credential = admin.credential.cert(sa);
    console.log('[FIREBASE] ✅ Inicializado con FIREBASE_SERVICE_ACCOUNT env');
  } else if (process.env.FIREBASE_PROJECT_ID) {
    let pk = process.env.FIREBASE_PRIVATE_KEY || '';
    if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
      pk = pk.slice(1, -1);
    }
    pk = pk.replace(/\\n/g, '\n');
    const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').replace(/^"|"$/g, '');
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail,
      privateKey: pk,
    });
    console.log(`[FIREBASE] ✅ Inicializado con vars individuales (projectId=${process.env.FIREBASE_PROJECT_ID})`);
  }

  if (!credential) {
    console.warn('[FIREBASE] ❌ No se encontró credencial');
    return false;
  }

  admin.initializeApp({ credential });
  return true;
}

module.exports = { initFirebase };
