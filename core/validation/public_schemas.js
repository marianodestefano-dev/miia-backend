/**
 * C-435 Iter 4 — Zod schemas + middleware para 5 endpoints públicos.
 *
 * Origen: CARTA_C-435 Wi→Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PLAN_PLANTA_BAJA_2026-04-27]
 *   "Wi, autoridad amplia para Planta Baja: bugs + pricing + alertas +
 *    seguridad in-line. Mariano DeStefano, 2026-04-27."
 * "Seguridad in-line" cubre Zod + validación endpoints publicos.
 *
 * 5 endpoints validados (criterio: expuestos a internet SIN auth Firebase):
 *   1. /api/paddle/webhook       — passthrough (formato variable Paddle)
 *   2. /api/mercadopago/webhook  — passthrough (formato variable MP)
 *   3. /api/instagram/webhook    — passthrough (formato Meta variable)
 *   4. /api/enterprise-lead      — strict  (form contacto público)
 *   5. /api/consent/adn          — strict  (consent owner público)
 *
 * Webhooks usan .passthrough() para no rechazar campos extra de versiones
 * nuevas del provider (§F C-435). Solo validan campos OBLIGATORIOS.
 */

'use strict';

const { z } = require('zod');

// ═════════════════════════════════════════════════════════════════════
// Schemas — Webhooks externos (passthrough permisivo §F C-435)
// ═════════════════════════════════════════════════════════════════════

/**
 * Paddle webhook — body es Buffer raw (express.raw), JSON.parse adentro.
 * Schema valida la estructura post-parse mínima.
 * Campos extra Paddle = OK (passthrough).
 */
const paddleWebhookSchema = z.object({
  event_type: z.string().min(1).max(100),
  data: z.unknown().optional(),
  occurred_at: z.string().optional(),
}).passthrough();

/**
 * MercadoPago webhook — JSON estándar.
 * Mínimo: type + (data.id si type=payment).
 */
const mercadopagoWebhookSchema = z.object({
  type: z.string().min(1).max(50).optional(),
  action: z.string().max(100).optional(),
  data: z.object({
    id: z.union([z.string(), z.number()]).optional(),
  }).passthrough().optional(),
  api_version: z.string().optional(),
  date_created: z.string().optional(),
  live_mode: z.boolean().optional(),
}).passthrough();

/**
 * Instagram webhook — formato Meta Graph.
 * object='instagram' + entry[] con messaging[].
 * Subscriber verification (GET) NO usa este schema (es query string).
 */
const instagramWebhookSchema = z.object({
  object: z.string().min(1).max(50).optional(),
  entry: z.array(z.unknown()).optional(),
}).passthrough();

// ═════════════════════════════════════════════════════════════════════
// Schemas — Forms públicos (strict — sin passthrough)
// ═════════════════════════════════════════════════════════════════════

/**
 * Enterprise lead form — input externo de leads enterprise.
 * Stripe-strict: name/email/phone obligatorios, resto opcional con caps.
 */
const enterpriseLeadSchema = z.object({
  name: z.string().trim().min(1, 'name vacío').max(200, 'name >200 chars'),
  email: z.string().trim().email('email inválido').max(200),
  phone: z.string().trim().min(6, 'phone <6 chars').max(30, 'phone >30 chars'),
  website: z.string().trim().max(500).optional().nullable().or(z.literal('')),
  team_size: z.string().trim().max(50).optional().nullable().or(z.literal('')),
  message: z.string().trim().max(5000).optional().nullable().or(z.literal('')),
}).strict();

/**
 * Consent ADN — owner firma consentimiento extracción ADN comercial.
 * uid es Firebase UID (~28 chars alphanum). accepted debe ser truthy.
 */
const consentAdnSchema = z.object({
  uid: z.string().trim().min(20, 'uid muy corto').max(128, 'uid muy largo'),
  email: z.string().trim().email('email inválido').max(200).optional().nullable().or(z.literal('')),
  accepted: z.union([z.literal(true), z.literal('true'), z.literal(1), z.literal('1')]),
  browser_ip: z.string().trim().max(50).optional().nullable().or(z.literal('')),
  user_agent: z.string().trim().max(500).optional().nullable().or(z.literal('')),
  screen: z.string().trim().max(50).optional().nullable().or(z.literal('')),
  language: z.string().trim().max(20).optional().nullable().or(z.literal('')),
  consent_text: z.string().trim().max(2000).optional().nullable().or(z.literal('')),
}).strict();

// ═════════════════════════════════════════════════════════════════════
// Middleware — wrapper validate(schema) para Express
// ═════════════════════════════════════════════════════════════════════

/**
 * Devuelve middleware Express que valida req.body contra schema.
 *
 * Si valida → reemplaza req.body por el output (parsed/coerced) y next().
 * Si falla  → 400 { error, details } sin exponer stack ni internals.
 *
 * Para webhooks con body raw (Buffer), parsea JSON adentro y mete el
 * resultado en req.parsedWebhookBody (no toca req.body original que el
 * handler de Paddle necesita para validar firma).
 */
function validate(schema, opts = {}) {
  const { source = 'body', target = 'body' } = opts;
  return function zodValidateMiddleware(req, res, next) {
    let raw;
    if (source === 'body_raw_json') {
      // Paddle: req.body es Buffer porque usa express.raw()
      try {
        raw = JSON.parse(req.body && req.body.toString ? req.body.toString() : '{}');
      } catch (e) {
        return res.status(400).json({
          error: 'Invalid JSON',
          details: 'Body could not be parsed as JSON',
        });
      }
    } else {
      raw = req[source];
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      }));
      return res.status(400).json({
        error: 'Validation failed',
        details: issues,
      });
    }
    if (target === 'body_parsed_extra') {
      req.parsedWebhookBody = result.data;
    } else {
      req[target] = result.data;
    }
    next();
  };
}

module.exports = {
  // schemas
  paddleWebhookSchema,
  mercadopagoWebhookSchema,
  instagramWebhookSchema,
  enterpriseLeadSchema,
  consentAdnSchema,
  // middleware
  validate,
};
