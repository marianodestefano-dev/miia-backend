'use strict';

/**
 * Tests: T32 — Instagram webhook HMAC SHA256 signature validation.
 *
 * Origen: T22 audit identifico GAP B (riesgo MEDIO-ALTO): Instagram
 * webhook permitia inyeccion de mensajes fake + consumo AI adversarial.
 * Wi firmo T32 mail [169] [ACK-T28-T31+N4-VI] — "Implementar Top 1
 * mejora T22 webhook security audit".
 *
 * §A — Tests estaticos sobre source server.js: HMAC validation presente,
 *      raw body bypass para /api/instagram/webhook, V2-ALERT logging.
 * §B — Tests runtime: HMAC compute logica con secrets sintetico.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — Verificacion estatica del fix T32 en source server.js
// ════════════════════════════════════════════════════════════════════

describe('T32 §A — Instagram webhook HMAC en source server.js', () => {
  test('A.1 — comentario T32-FIX presente (trazabilidad)', () => {
    expect(SERVER_SOURCE).toMatch(/T32-FIX/);
  });

  test('A.2 — bypass express.json para Instagram webhook (raw body)', () => {
    // El bypass del json middleware debe excluir Instagram webhook como Paddle
    const idx = SERVER_SOURCE.indexOf('Instagram webhook tambien necesita raw body');
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_SOURCE.slice(idx, idx + 400);
    expect(block).toMatch(/req\.path === ['"]\/api\/instagram\/webhook['"]/);
    expect(block).toMatch(/express\.raw\(\{ type: ['"]application\/json['"]/);
  });

  test('A.3 — HMAC verify en POST /api/instagram/webhook', () => {
    // Buscar el bloque del handler
    const idx = SERVER_SOURCE.indexOf("app.post('/api/instagram/webhook'");
    expect(idx).toBeGreaterThan(0);
    const block = SERVER_SOURCE.slice(idx, idx + 3000);
    expect(block).toMatch(/x-hub-signature-256/);
    expect(block).toMatch(/INSTAGRAM_APP_SECRET|META_APP_SECRET/);
    expect(block).toMatch(/createHmac\(['"]sha256['"]/);
    expect(block).toMatch(/timingSafeEqual/);
  });

  test('A.4 — return 401 si signature ausente o invalida', () => {
    const idx = SERVER_SOURCE.indexOf("app.post('/api/instagram/webhook'");
    const block = SERVER_SOURCE.slice(idx, idx + 3000);
    // 2+ ocurrencias de res.status(401).send('Invalid signature')
    const matches = block.match(/res\.status\(401\)\.send\(['"]Invalid signature['"]\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('A.5 — V2-ALERT structured log para HMAC fail', () => {
    expect(SERVER_SOURCE).toMatch(/V2-ALERT.*WEBHOOK-HMAC-FAIL|WEBHOOK-HMAC-FAIL.*V2-ALERT/);
  });

  test('A.6 — Zod schema validation persiste post-HMAC', () => {
    const idx = SERVER_SOURCE.indexOf("app.post('/api/instagram/webhook'");
    const block = SERVER_SOURCE.slice(idx, idx + 3000);
    expect(block).toMatch(/instagramWebhookSchema\.safeParse/);
  });

  test('A.7 — Parse JSON manual post-HMAC (raw body Buffer)', () => {
    const idx = SERVER_SOURCE.indexOf("app.post('/api/instagram/webhook'");
    const block = SERVER_SOURCE.slice(idx, idx + 3000);
    expect(block).toMatch(/JSON\.parse\(req\.body\.toString\(['"]utf8['"]\)\)/);
  });

  test('A.8 — fallback graceful si APP_SECRET no configurado (legacy mode)', () => {
    const idx = SERVER_SOURCE.indexOf("app.post('/api/instagram/webhook'");
    const block = SERVER_SOURCE.slice(idx, idx + 3000);
    // El fallback debe loguear warning y continuar sin verificar HMAC
    expect(block).toMatch(/INSTAGRAM_APP_SECRET no configurado/);
    expect(block).toMatch(/HMAC verify SKIPPED/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: HMAC compute logica
// ════════════════════════════════════════════════════════════════════

describe('T32 §B — HMAC compute con secret sintetico', () => {
  const SECRET = 'test-app-secret-T32';

  function computeSignature(body, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  function verifySignature(body, secret, providedSig) {
    if (!providedSig || !providedSig.startsWith('sha256=')) return false;
    const expected = computeSignature(body, secret);
    try {
      return crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expected));
    } catch (_) {
      return false;
    }
  }

  test('B.1 — HMAC valido reproduce signature', () => {
    const body = Buffer.from('{"object":"instagram","entry":[]}', 'utf8');
    const sig = computeSignature(body, SECRET);
    expect(verifySignature(body, SECRET, sig)).toBe(true);
  });

  test('B.2 — HMAC con body distinto → invalido', () => {
    const body1 = Buffer.from('{"a":1}', 'utf8');
    const body2 = Buffer.from('{"a":2}', 'utf8');
    const sig1 = computeSignature(body1, SECRET);
    expect(verifySignature(body2, SECRET, sig1)).toBe(false);
  });

  test('B.3 — HMAC con secret distinto → invalido', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const sigBadSecret = computeSignature(body, 'wrong-secret');
    expect(verifySignature(body, SECRET, sigBadSecret)).toBe(false);
  });

  test('B.4 — signature sin prefix sha256= → invalido', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const sig = computeSignature(body, SECRET).replace('sha256=', '');
    expect(verifySignature(body, SECRET, sig)).toBe(false);
  });

  test('B.5 — signature undefined/null → invalido (no throw)', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(() => verifySignature(body, SECRET, undefined)).not.toThrow();
    expect(verifySignature(body, SECRET, undefined)).toBe(false);
    expect(verifySignature(body, SECRET, null)).toBe(false);
  });

  test('B.6 — signature length distinto al expected → invalido (no throw)', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    // sha256= + 64 hex chars vs un string mas corto/largo
    expect(() => verifySignature(body, SECRET, 'sha256=abc123')).not.toThrow();
    expect(verifySignature(body, SECRET, 'sha256=abc123')).toBe(false);
  });

  test('B.7 — body grande (1KB JSON) HMAC sigue valido', () => {
    const big = JSON.stringify({ data: 'x'.repeat(1000) });
    const body = Buffer.from(big, 'utf8');
    const sig = computeSignature(body, SECRET);
    expect(verifySignature(body, SECRET, sig)).toBe(true);
  });
});
