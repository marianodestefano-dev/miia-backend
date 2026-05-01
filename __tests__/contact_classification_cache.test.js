'use strict';

/**
 * Tests para lib/contact_classification_cache.js
 * Cierra bug §6.19 CLAUDE.md — cache contactTypes TTL 30 días
 * Ref: C-434 §A (inline TMH) → T79 extracción módulo
 */

const {
  TTL_DAYS,
  TTL_MS,
  isContactTypeStale,
  recordContactTypeFresh,
  purgeStaleContactTypes,
} = require('../lib/contact_classification_cache');

const PHONE = '573163937365@s.whatsapp.net';
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────
// TTL constants
// ──────────────────────────────────────────────
describe('TTL constants', () => {
  test('TTL_DAYS es 30', () => {
    expect(TTL_DAYS).toBe(30);
  });

  test('TTL_MS equivale a 30 días en ms', () => {
    expect(TTL_MS).toBe(30 * DAY_MS);
  });
});

// ──────────────────────────────────────────────
// isContactTypeStale
// ──────────────────────────────────────────────
describe('isContactTypeStale', () => {
  test('ctx null → stale', () => {
    expect(isContactTypeStale(null, PHONE)).toBe(true);
  });

  test('ctx sin contactTypesMeta → stale', () => {
    expect(isContactTypeStale({}, PHONE)).toBe(true);
  });

  test('contactTypesMeta vacío (sin entry para phone) → stale', () => {
    expect(isContactTypeStale({ contactTypesMeta: {} }, PHONE)).toBe(true);
  });

  test('timestamp undefined → stale (entry legacy)', () => {
    expect(isContactTypeStale({ contactTypesMeta: { [PHONE]: undefined } }, PHONE)).toBe(true);
  });

  test('timestamp string (tipo incorrecto) → stale', () => {
    expect(isContactTypeStale({ contactTypesMeta: { [PHONE]: '2026-01-01' } }, PHONE)).toBe(true);
  });

  test('timestamp reciente (1 hora atrás) → fresh', () => {
    const ctx = { contactTypesMeta: { [PHONE]: NOW - 60 * 60 * 1000 } };
    expect(isContactTypeStale(ctx, PHONE)).toBe(false);
  });

  test('timestamp exactamente en TTL_MS → stale (boundary)', () => {
    const ctx = { contactTypesMeta: { [PHONE]: NOW - TTL_MS } };
    expect(isContactTypeStale(ctx, PHONE)).toBe(true);
  });

  test('timestamp 29 días atrás → fresh', () => {
    const ctx = { contactTypesMeta: { [PHONE]: NOW - 29 * DAY_MS } };
    expect(isContactTypeStale(ctx, PHONE)).toBe(false);
  });

  test('timestamp 31 días atrás → stale (expirado)', () => {
    const ctx = { contactTypesMeta: { [PHONE]: NOW - 31 * DAY_MS } };
    expect(isContactTypeStale(ctx, PHONE)).toBe(true);
  });

  test('phone diferente en meta → stale para el phone pedido', () => {
    const ctx = { contactTypesMeta: { 'otro@s.whatsapp.net': NOW } };
    expect(isContactTypeStale(ctx, PHONE)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// recordContactTypeFresh
// ──────────────────────────────────────────────
describe('recordContactTypeFresh', () => {
  test('ctx null → no lanza excepción', () => {
    expect(() => recordContactTypeFresh(null, PHONE)).not.toThrow();
  });

  test('inicializa contactTypesMeta si no existe', () => {
    const ctx = {};
    recordContactTypeFresh(ctx, PHONE);
    expect(ctx.contactTypesMeta).toBeDefined();
    expect(typeof ctx.contactTypesMeta[PHONE]).toBe('number');
  });

  test('timestamp seteado es reciente (< 1s)', () => {
    const ctx = {};
    const before = Date.now();
    recordContactTypeFresh(ctx, PHONE);
    const after = Date.now();
    expect(ctx.contactTypesMeta[PHONE]).toBeGreaterThanOrEqual(before);
    expect(ctx.contactTypesMeta[PHONE]).toBeLessThanOrEqual(after);
  });

  test('sobreescribe timestamp viejo', () => {
    const ctx = { contactTypesMeta: { [PHONE]: NOW - 31 * DAY_MS } };
    recordContactTypeFresh(ctx, PHONE);
    expect(isContactTypeStale(ctx, PHONE)).toBe(false);
  });

  test('no altera otros phones en meta', () => {
    const OTHER = 'otro@s.whatsapp.net';
    const ctx = { contactTypesMeta: { [OTHER]: NOW - 5 * DAY_MS } };
    recordContactTypeFresh(ctx, PHONE);
    expect(ctx.contactTypesMeta[OTHER]).toBe(NOW - 5 * DAY_MS);
  });
});

// ──────────────────────────────────────────────
// purgeStaleContactTypes
// ──────────────────────────────────────────────
describe('purgeStaleContactTypes', () => {
  test('ctx null → retorna 0', () => {
    expect(purgeStaleContactTypes(null)).toBe(0);
  });

  test('sin contactTypesMeta → retorna 0', () => {
    expect(purgeStaleContactTypes({})).toBe(0);
  });

  test('todos fresh → retorna 0 y no elimina', () => {
    const ctx = {
      contactTypesMeta: {
        [PHONE]: NOW - 1 * DAY_MS,
        'otro@s.whatsapp.net': NOW - 5 * DAY_MS,
      },
    };
    expect(purgeStaleContactTypes(ctx)).toBe(0);
    expect(Object.keys(ctx.contactTypesMeta)).toHaveLength(2);
  });

  test('1 stale + 1 fresh → elimina solo el stale', () => {
    const STALE = 'stale@s.whatsapp.net';
    const FRESH = 'fresh@s.whatsapp.net';
    const ctx = {
      contactTypesMeta: {
        [STALE]: NOW - 31 * DAY_MS,
        [FRESH]: NOW - 1 * DAY_MS,
      },
    };
    expect(purgeStaleContactTypes(ctx)).toBe(1);
    expect(ctx.contactTypesMeta[STALE]).toBeUndefined();
    expect(ctx.contactTypesMeta[FRESH]).toBeDefined();
  });

  test('entry sin timestamp (legacy) → se purga', () => {
    const ctx = { contactTypesMeta: { [PHONE]: undefined } };
    expect(purgeStaleContactTypes(ctx)).toBe(1);
    expect(ctx.contactTypesMeta[PHONE]).toBeUndefined();
  });

  test('purge no toca ctx.contactTypes (solo meta)', () => {
    const ctx = {
      contactTypes: { [PHONE]: 'lead' },
      contactTypesMeta: { [PHONE]: NOW - 31 * DAY_MS },
    };
    purgeStaleContactTypes(ctx);
    expect(ctx.contactTypes[PHONE]).toBe('lead'); // intacto
    expect(ctx.contactTypesMeta[PHONE]).toBeUndefined(); // purgado
  });
});

// ──────────────────────────────────────────────
// Integración flujo §6.19 — prevención bot loops
// ──────────────────────────────────────────────
describe('Integración §6.19 — prevención bot loops (PASO 7 handleTenantMessage)', () => {
  test('entry legacy (sin meta) → fuerza re-classify → bloqueo precautorio puede aplicar', () => {
    const ctx = {
      contactTypes: { [PHONE]: 'lead' },
      // sin contactTypesMeta → migration legacy
    };
    let contactType = ctx.contactTypes[PHONE];
    if (contactType && isContactTypeStale(ctx, PHONE)) contactType = null;
    expect(contactType).toBeNull();
  });

  test('entry reciente → NO re-classify (flujo normal)', () => {
    const ctx = {
      contactTypes: { [PHONE]: 'lead' },
      contactTypesMeta: { [PHONE]: NOW - 1000 },
    };
    let contactType = ctx.contactTypes[PHONE];
    if (contactType && isContactTypeStale(ctx, PHONE)) contactType = null;
    expect(contactType).toBe('lead');
  });

  test('entry expirada (+31d) → fuerza re-classify', () => {
    const ctx = {
      contactTypes: { [PHONE]: 'lead' },
      contactTypesMeta: { [PHONE]: NOW - 31 * DAY_MS },
    };
    let contactType = ctx.contactTypes[PHONE];
    if (contactType && isContactTypeStale(ctx, PHONE)) contactType = null;
    expect(contactType).toBeNull();
  });

  test('después de clasificar con recordContactTypeFresh → entry ya no es stale', () => {
    const ctx = {};
    recordContactTypeFresh(ctx, PHONE);
    expect(isContactTypeStale(ctx, PHONE)).toBe(false);
  });
});
