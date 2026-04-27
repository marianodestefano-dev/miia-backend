/**
 * Tests: C-435 Iter 4 Top 5 Zod — schemas + middleware para 5 endpoints públicos.
 *
 * Origen: CARTA_C-435 Wi→Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PLAN_PLANTA_BAJA_2026-04-27]
 *   "Wi, autoridad amplia para Planta Baja: bugs + pricing + alertas +
 *    seguridad in-line. Mariano DeStefano, 2026-04-27."
 * "Seguridad in-line" cubre Zod + validación endpoints públicos.
 *
 * 5 schemas validados (criterio §A C-435: expuestos a internet SIN auth Firebase):
 *   1. paddleWebhookSchema       — passthrough (§F C-435)
 *   2. mercadopagoWebhookSchema  — passthrough (§F C-435)
 *   3. instagramWebhookSchema    — passthrough (§F C-435)
 *   4. enterpriseLeadSchema      — strict (form contacto)
 *   5. consentAdnSchema          — strict (consent owner)
 */

'use strict';

const {
  paddleWebhookSchema,
  mercadopagoWebhookSchema,
  instagramWebhookSchema,
  enterpriseLeadSchema,
  consentAdnSchema,
  validate,
} = require('../core/validation/public_schemas');

// ════════════════════════════════════════════════════════════════════
// §A — paddleWebhookSchema (passthrough Stripe-like)
// ════════════════════════════════════════════════════════════════════

describe('C-435 §A — paddleWebhookSchema (passthrough)', () => {
  test('A.1 — payload válido transaction.completed PASA', () => {
    const valid = {
      event_type: 'transaction.completed',
      occurred_at: '2026-04-27T22:00:00Z',
      data: { custom_data: { uid: 'abc', plan: 'monthly', type: 'subscription' } },
    };
    expect(paddleWebhookSchema.safeParse(valid).success).toBe(true);
  });

  test('A.2 — payload sin event_type FALLA', () => {
    const r = paddleWebhookSchema.safeParse({ data: {} });
    expect(r.success).toBe(false);
  });

  test('A.3 — event_type vacío FALLA (min 1)', () => {
    const r = paddleWebhookSchema.safeParse({ event_type: '', data: {} });
    expect(r.success).toBe(false);
  });

  test('A.4 — campos extra de Paddle PASAN (passthrough §F)', () => {
    const valid = {
      event_type: 'transaction.completed',
      data: {},
      // Campos hipotéticos versión nueva Paddle:
      paddle_version: '2',
      new_field_xyz: { foo: 'bar' },
      occurred_at: '2026-04-27T22:00:00Z',
    };
    const r = paddleWebhookSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data.paddle_version).toBe('2');
    expect(r.data.new_field_xyz).toEqual({ foo: 'bar' });
  });

  test('A.5 — event_type >100 chars FALLA', () => {
    const r = paddleWebhookSchema.safeParse({ event_type: 'x'.repeat(101) });
    expect(r.success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — mercadopagoWebhookSchema (passthrough)
// ════════════════════════════════════════════════════════════════════

describe('C-435 §B — mercadopagoWebhookSchema (passthrough)', () => {
  test('B.1 — payload payment válido PASA', () => {
    const valid = {
      type: 'payment',
      action: 'payment.created',
      data: { id: '1234567890' },
      api_version: 'v1',
      live_mode: true,
    };
    expect(mercadopagoWebhookSchema.safeParse(valid).success).toBe(true);
  });

  test('B.2 — data.id puede ser number o string (MP envía ambos)', () => {
    expect(mercadopagoWebhookSchema.safeParse({ type: 'payment', data: { id: 123 } }).success).toBe(true);
    expect(mercadopagoWebhookSchema.safeParse({ type: 'payment', data: { id: '123' } }).success).toBe(true);
  });

  test('B.3 — type wrong (number) FALLA', () => {
    expect(mercadopagoWebhookSchema.safeParse({ type: 999 }).success).toBe(false);
  });

  test('B.4 — campos extra MP PASAN (passthrough §F)', () => {
    const valid = {
      type: 'payment',
      data: { id: '1', extra_field: 'abc' },
      future_field_v2: { nested: true },
    };
    const r = mercadopagoWebhookSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data.future_field_v2).toEqual({ nested: true });
  });

  test('B.5 — empty payload PASA (todo opcional, ack-only)', () => {
    expect(mercadopagoWebhookSchema.safeParse({}).success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — instagramWebhookSchema (passthrough Meta)
// ════════════════════════════════════════════════════════════════════

describe('C-435 §C — instagramWebhookSchema (passthrough)', () => {
  test('C.1 — payload Meta estándar PASA', () => {
    const valid = {
      object: 'instagram',
      entry: [
        { id: '12345', time: 1700000000, messaging: [{ sender: { id: 'a' }, recipient: { id: 'b' } }] },
      ],
    };
    expect(instagramWebhookSchema.safeParse(valid).success).toBe(true);
  });

  test('C.2 — entry no-array FALLA', () => {
    expect(instagramWebhookSchema.safeParse({ object: 'instagram', entry: 'invalid' }).success).toBe(false);
  });

  test('C.3 — campos extra Meta PASAN (passthrough §F)', () => {
    const valid = {
      object: 'instagram',
      entry: [],
      future_meta_field: 'something',
    };
    const r = instagramWebhookSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data.future_meta_field).toBe('something');
  });

  test('C.4 — empty payload PASA (opt-in fields)', () => {
    expect(instagramWebhookSchema.safeParse({}).success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — enterpriseLeadSchema (strict)
// ════════════════════════════════════════════════════════════════════

describe('C-435 §D — enterpriseLeadSchema (strict)', () => {
  test('D.1 — payload completo válido PASA', () => {
    const valid = {
      name: 'Empresa SA',
      email: 'contacto@empresa.com',
      phone: '+541112345678',
      website: 'https://empresa.com',
      team_size: '10-50',
      message: 'Queremos probar MIIA',
    };
    expect(enterpriseLeadSchema.safeParse(valid).success).toBe(true);
  });

  test('D.2 — payload mínimo válido PASA (sólo obligatorios)', () => {
    const valid = { name: 'X', email: 'x@y.com', phone: '+5491100000000' };
    expect(enterpriseLeadSchema.safeParse(valid).success).toBe(true);
  });

  test('D.3 — name vacío FALLA', () => {
    const r = enterpriseLeadSchema.safeParse({ name: '', email: 'x@y.com', phone: '+541112345678' });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].path).toContain('name');
  });

  test('D.4 — email inválido FALLA', () => {
    const r = enterpriseLeadSchema.safeParse({ name: 'X', email: 'no-es-email', phone: '+541112345678' });
    expect(r.success).toBe(false);
  });

  test('D.5 — phone <6 chars FALLA', () => {
    const r = enterpriseLeadSchema.safeParse({ name: 'X', email: 'x@y.com', phone: '12' });
    expect(r.success).toBe(false);
  });

  test('D.6 — name >200 chars FALLA', () => {
    const r = enterpriseLeadSchema.safeParse({ name: 'X'.repeat(201), email: 'x@y.com', phone: '+541112345678' });
    expect(r.success).toBe(false);
  });

  test('D.7 — campo extra inyectado FALLA (strict, anti-mass-assignment)', () => {
    const r = enterpriseLeadSchema.safeParse({
      name: 'X', email: 'x@y.com', phone: '+541112345678',
      role: 'admin',  // intento de inyección
    });
    expect(r.success).toBe(false);
  });

  test('D.8 — message >5000 chars FALLA', () => {
    const r = enterpriseLeadSchema.safeParse({
      name: 'X', email: 'x@y.com', phone: '+541112345678',
      message: 'a'.repeat(5001),
    });
    expect(r.success).toBe(false);
  });

  test('D.9 — opcionales pueden venir vacíos PASA', () => {
    const valid = {
      name: 'X', email: 'x@y.com', phone: '+541112345678',
      website: '', team_size: '', message: '',
    };
    expect(enterpriseLeadSchema.safeParse(valid).success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// §E — consentAdnSchema (strict)
// ════════════════════════════════════════════════════════════════════

describe('C-435 §E — consentAdnSchema (strict)', () => {
  const validUid = 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // 28 chars

  test('E.1 — payload completo válido PASA', () => {
    const valid = {
      uid: validUid,
      email: 'mariano@miia-app.com',
      accepted: true,
      browser_ip: '1.2.3.4',
      user_agent: 'Mozilla/5.0',
      screen: '1920x1080',
      language: 'es-AR',
      consent_text: 'Autorizo la Extracción de ADN Comercial',
    };
    expect(consentAdnSchema.safeParse(valid).success).toBe(true);
  });

  test('E.2 — uid muy corto FALLA (<20 chars)', () => {
    const r = consentAdnSchema.safeParse({ uid: 'short', accepted: true });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].path).toContain('uid');
  });

  test('E.3 — uid muy largo FALLA (>128 chars)', () => {
    const r = consentAdnSchema.safeParse({ uid: 'a'.repeat(129), accepted: true });
    expect(r.success).toBe(false);
  });

  test('E.4 — accepted=false FALLA (debe ser truthy)', () => {
    const r = consentAdnSchema.safeParse({ uid: validUid, accepted: false });
    expect(r.success).toBe(false);
  });

  test('E.5 — accepted="true" string PASA (frontend a veces serializa)', () => {
    expect(consentAdnSchema.safeParse({ uid: validUid, accepted: 'true' }).success).toBe(true);
  });

  test('E.6 — sin uid FALLA', () => {
    const r = consentAdnSchema.safeParse({ accepted: true });
    expect(r.success).toBe(false);
  });

  test('E.7 — campo extra (consent_admin) FALLA strict', () => {
    const r = consentAdnSchema.safeParse({ uid: validUid, accepted: true, consent_admin: true });
    expect(r.success).toBe(false);
  });

  test('E.8 — email inválido FALLA', () => {
    const r = consentAdnSchema.safeParse({ uid: validUid, accepted: true, email: 'bad-email' });
    expect(r.success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// §F — middleware validate(schema)
// ════════════════════════════════════════════════════════════════════

describe('C-435 §F — middleware validate()', () => {
  function mockRes() {
    const r = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(obj) { this.body = obj; return this; },
    };
    return r;
  }

  test('F.1 — body válido → next() con req.body parseado', (done) => {
    const mw = validate(enterpriseLeadSchema);
    const req = { body: { name: 'X', email: 'x@y.com', phone: '+541112345678' } };
    const res = mockRes();
    mw(req, res, () => {
      expect(req.body.name).toBe('X');
      expect(res.statusCode).toBe(200); // no se tocó
      done();
    });
  });

  test('F.2 — body inválido → 400 + details (sin stack)', () => {
    const mw = validate(enterpriseLeadSchema);
    const req = { body: { name: '', email: 'bad', phone: '12' } };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
    // No debe exponer stack ni internals
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s*\(/);
  });

  test('F.3 — body raw JSON (Paddle) parseado correctamente con source=body_raw_json', (done) => {
    const mw = validate(paddleWebhookSchema, { source: 'body_raw_json', target: 'body_parsed_extra' });
    const buf = Buffer.from(JSON.stringify({ event_type: 'transaction.completed', data: {} }));
    const req = { body: buf };
    const res = mockRes();
    mw(req, res, () => {
      expect(req.parsedWebhookBody.event_type).toBe('transaction.completed');
      expect(Buffer.isBuffer(req.body)).toBe(true); // body original intacto
      done();
    });
  });

  test('F.4 — body raw JSON inválido → 400 Invalid JSON', () => {
    const mw = validate(paddleWebhookSchema, { source: 'body_raw_json' });
    const req = { body: Buffer.from('{invalid json') };
    const res = mockRes();
    mw(req, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Invalid JSON');
  });
});
