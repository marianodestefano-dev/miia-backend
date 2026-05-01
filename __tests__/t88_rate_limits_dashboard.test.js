'use strict';
/**
 * T88 — Rate limiter dashboard endpoint tests
 * Verifica getTenantDashboard() en rate_limiter.js.
 */

const rateLimiter = require('../core/rate_limiter');

const TEST_UID = 'testuid_t88_xxxxxxxxxxxxxxxxxxx';
const TEST_UID2 = 'testuid_t88_ooooooooooooooooooo';

beforeEach(() => {
  // Limpiar estado entre tests (accediendo a la funcion de reset si existe,
  // o simplemente usando UIDs unicos por test para evitar contaminacion)
});

// === Suite 1: getTenantDashboard exportada y estructura ===
describe('T88 getTenantDashboard — estructura basica', () => {
  test('getTenantDashboard esta exportada', () => {
    expect(typeof rateLimiter.getTenantDashboard).toBe('function');
  });

  test('retorna objeto con campos requeridos', () => {
    const d = rateLimiter.getTenantDashboard(TEST_UID);
    expect(d).toHaveProperty('uid_masked');
    expect(d).toHaveProperty('level');
    expect(d).toHaveProperty('contacts');
    expect(d).toHaveProperty('circuit_breakers');
    expect(d).toHaveProperty('generated_at');
  });

  test('uid_masked tiene formato primeros8...', () => {
    const d = rateLimiter.getTenantDashboard(TEST_UID);
    expect(d.uid_masked).toMatch(/^.{8}\.\.\.$/);
  });

  test('level tiene todos los campos', () => {
    const d = rateLimiter.getTenantDashboard(TEST_UID);
    const lev = d.level;
    expect(lev).toHaveProperty('name');
    expect(lev).toHaveProperty('emoji');
    expect(lev).toHaveProperty('count_24h');
    expect(lev).toHaveProperty('pct_24h');
    expect(lev).toHaveProperty('remaining_24h');
    expect(lev).toHaveProperty('daily_limit');
    expect(lev).toHaveProperty('allow_leads');
    expect(lev).toHaveProperty('allow_family');
  });

  test('contacts es un array', () => {
    const d = rateLimiter.getTenantDashboard(TEST_UID);
    expect(Array.isArray(d.contacts)).toBe(true);
  });

  test('generated_at es ISO string valido', () => {
    const d = rateLimiter.getTenantDashboard(TEST_UID);
    expect(() => new Date(d.generated_at)).not.toThrow();
    expect(new Date(d.generated_at).getFullYear()).toBeGreaterThan(2025);
  });
});

// === Suite 2: nivel inicial GREEN para tenant nuevo ===
describe('T88 getTenantDashboard — nivel inicial', () => {
  test('tenant nuevo tiene nivel GREEN', () => {
    const uid = 'brand_new_uid_t88_xxxxxxxxxx';
    const d = rateLimiter.getTenantDashboard(uid);
    expect(d.level.name).toBe('GREEN');
  });

  test('tenant nuevo tiene count_24h = 0', () => {
    const uid = 'brand_new_uid_t88_yyyyyyyyyy';
    const d = rateLimiter.getTenantDashboard(uid);
    expect(d.level.count_24h).toBe(0);
  });

  test('tenant nuevo tiene pct_24h = 0', () => {
    const uid = 'brand_new_uid_t88_zzzzzzzzzz';
    const d = rateLimiter.getTenantDashboard(uid);
    expect(d.level.pct_24h).toBe(0);
  });

  test('tenant nuevo tiene remaining = daily_limit', () => {
    const uid = 'brand_new_uid_t88_aaaaaaaaaa';
    const d = rateLimiter.getTenantDashboard(uid);
    expect(d.level.remaining_24h).toBe(d.level.daily_limit);
  });
});

// === Suite 3: conteo sube con recordOutgoing ===
describe('T88 getTenantDashboard — cuenta mensajes', () => {
  test('count_24h refleja mensajes registrados', () => {
    const uid = 'count_test_uid_t88_bbbbbbbbbb';
    rateLimiter.recordOutgoing(uid);
    rateLimiter.recordOutgoing(uid);
    rateLimiter.recordOutgoing(uid);
    const d = rateLimiter.getTenantDashboard(uid);
    expect(d.level.count_24h).toBe(3);
  });

  test('contacts vacio cuando no hay envios a contactos', () => {
    const uid = 'no_contacts_uid_t88_cccccccccc';
    const d = rateLimiter.getTenantDashboard(uid);
    expect(d.contacts).toHaveLength(0);
  });

  test('contacto aparece en dashboard cuando hay envios recientes', () => {
    const uid = 'contact_test_uid_t88_xxxxxxxxx';
    const phone = '573054169969';
    // Registrar envios al contacto
    rateLimiter.contactRecord(uid, phone);
    rateLimiter.contactRecord(uid, phone);
    const d = rateLimiter.getTenantDashboard(uid);
    const found = d.contacts.find(c => c.count_30s >= 2);
    expect(found).toBeDefined();
    expect(found.count_30s).toBe(2);
    expect(found.phone_masked).toMatch(/^\*\*\*/);
  });
});
