'use strict';

/**
 * T233 - Tests E2E Bloque 8
 * Flujos combinando: role_middleware, security_otp_manager, contact_spam_detector,
 * dynamic_pricing_engine, privacy_report_builder.
 */

const { requireRole, requirePermission, requireMinRole, buildRoleContext, hasPermission, ROLES } = require('../core/role_middleware');
const { createOTP, verifyOTP, buildOTPMessage, isOTPExpired, CRITICAL_ACTIONS } = require('../core/security_otp_manager');
const { analyzeContact, detectKeywords, detectRapidFire, buildSpamAlertMessage, SPAM_KEYWORDS } = require('../core/contact_spam_detector');
const { getPlanPrice, recommendPlan, comparePlans, getCurrencyForCountry, DEFAULT_PLANS, PLAN_NAMES } = require('../core/dynamic_pricing_engine');
const { buildPrivacyReport, buildGDPRExportPackage, requestErasure, isValidCategory, ERASURE_CATEGORIES } = require('../core/privacy_report_builder');

const { __setFirestoreForTests: setOTPDb } = require('../core/security_otp_manager');
const { __setFirestoreForTests: setSpamDb } = require('../core/contact_spam_detector');
const { __setFirestoreForTests: setPricingDb } = require('../core/dynamic_pricing_engine');
const { __setFirestoreForTests: setPrivacyDb } = require('../core/privacy_report_builder');
const { invalidateCache } = require('../core/dynamic_pricing_engine');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb() {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: async () => {}, get: async () => ({ exists: false, data: () => null }) }),
          where: () => ({ get: async () => ({ forEach: () => {} }) }),
          get: async () => ({ forEach: () => {} }),
        }),
      }),
      get: async () => ({ forEach: () => {} }),
    }),
  };
}

beforeEach(() => {
  setOTPDb(null);
  setSpamDb(null);
  setPricingDb(null);
  setPrivacyDb(null);
  invalidateCache();
});
afterEach(() => {
  setOTPDb(null);
  setSpamDb(null);
  setPricingDb(null);
  setPrivacyDb(null);
  invalidateCache();
});

describe('E2E: Flujo roles y permisos', () => {
  test('jerarquia de roles correcta', () => {
    const checkAdmin = requireMinRole('owner');
    expect(checkAdmin({ uid: UID, role: 'founder' }).allowed).toBe(true);
    expect(checkAdmin({ uid: UID, role: 'agent' }).allowed).toBe(false);
    expect(checkAdmin({ uid: UID, role: 'readonly' }).allowed).toBe(false);
  });

  test('permisos granulares por rol', () => {
    expect(hasPermission('founder', 'admin_global')).toBe(true);
    expect(hasPermission('owner', 'admin_global')).toBe(false);
    expect(hasPermission('agent', 'read_conversations')).toBe(true);
    expect(hasPermission('agent', 'manage_config')).toBe(false);
  });

  test('requirePermission export_data bloquea agent', () => {
    const check = requirePermission('export_data');
    expect(check({ uid: UID, role: 'owner' }).allowed).toBe(true);
    expect(check({ uid: UID, role: 'agent' }).allowed).toBe(false);
  });

  test('ROLES cubre todos los tipos de usuario', () => {
    ['owner', 'agent', 'founder', 'readonly', 'api_client'].forEach(r => {
      expect(ROLES).toContain(r);
    });
  });

  test('buildRoleContext genera contexto correcto', () => {
    const ctx = buildRoleContext(UID, 'agent', { agentId: 'ag1', tenantUid: 'tenant1' });
    expect(ctx.role).toBe('agent');
    expect(ctx.agentId).toBe('ag1');
    expect(ctx.tenantUid).toBe('tenant1');
  });
});

describe('E2E: Flujo OTP accion critica', () => {
  test('CRITICAL_ACTIONS cubre las acciones mas peligrosas', () => {
    ['delete_account', 'api_key_rotate', 'disconnect_whatsapp'].forEach(a => {
      expect(CRITICAL_ACTIONS).toContain(a);
    });
  });

  test('OTP creado expira despues del TTL', () => {
    const past = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect(isOTPExpired({ expiresAt: past })).toBe(true);
  });

  test('OTP no expirado con tiempo futuro', () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(isOTPExpired({ expiresAt: future })).toBe(false);
  });

  test('mensaje OTP es informativo', () => {
    const msg = buildOTPMessage('123456', 'delete_account', new Date(Date.now() + 60000).toISOString());
    expect(msg).toContain('123456');
    expect(msg).toContain('delete_account');
    expect(msg.toLowerCase()).toContain('no compartir');
  });

  test('crear y verificar OTP flujo completo', async () => {
    let stored = {};
    const mockDb = {
      collection: () => ({ doc: () => ({ collection: () => ({ doc: (id) => ({
        set: async (data) => { stored[id] = data; },
        get: async () => ({ exists: !!stored[id], data: () => stored[id] }),
      })})})}),
    };
    setOTPDb(mockDb);
    const created = await createOTP(UID, 'api_key_rotate', { _forceCode: '654321' });
    expect(created.code).toBe('654321');

    const verified = await verifyOTP(UID, created.otpId, '654321');
    expect(verified.valid).toBe(true);
    expect(verified.action).toBe('api_key_rotate');
  });
});

describe('E2E: Flujo deteccion spam', () => {
  test('keywords clasicos del spam detectados', () => {
    const spamText = 'Ganaste gratis inversion garantizada forex criptomoneda';
    const kws = detectKeywords(spamText);
    expect(kws.length).toBeGreaterThanOrEqual(4);
  });

  test('texto limpio no activa detector', () => {
    expect(detectKeywords('Hola quiero saber el precio de sus servicios')).toEqual([]);
  });

  test('rafaga de mensajes detectada', () => {
    const now = Date.now();
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      text: 'hola',
      timestamp: new Date(now - i * 2000).toISOString(),
    }));
    expect(detectRapidFire(msgs)).toBe(true);
  });

  test('analisis completo de contacto spam', () => {
    const now = Date.now();
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      text: 'ganaste gratis',
      timestamp: new Date(now - i * 2000).toISOString(),
    }));
    const r = analyzeContact(PHONE, msgs);
    expect(r.isSpam).toBe(true);
    expect(r.severity).toBe('high');
    expect(r.signals.length).toBeGreaterThan(1);
  });

  test('buildSpamAlertMessage menciona ALERTA para severity high', () => {
    const analysis = { severity: 'high', reasons: ['Rafaga', 'Keywords'] };
    expect(buildSpamAlertMessage(PHONE, analysis)).toContain('ALERTA');
  });
});

describe('E2E: Flujo pricing y planes', () => {
  test('recomendacion de plan segun uso', () => {
    expect(recommendPlan({ avgMessagesPerDay: 10, totalContacts: 30 })).toBe('free');
    expect(recommendPlan({ avgMessagesPerDay: 200, totalContacts: 300 })).toBe('starter');
    expect(recommendPlan({ avgMessagesPerDay: 3000, totalContacts: 3000 })).toBe('pro');
    expect(recommendPlan({ avgMessagesPerDay: 20000, totalContacts: 20000 })).toBe('enterprise');
  });

  test('currency correcta por pais LatAm', () => {
    expect(getCurrencyForCountry('AR')).toBe('ARS');
    expect(getCurrencyForCountry('CO')).toBe('COP');
    expect(getCurrencyForCountry('MX')).toBe('MXN');
    expect(getCurrencyForCountry('CL')).toBe('CLP');
    expect(getCurrencyForCountry('PE')).toBe('PEN');
    expect(getCurrencyForCountry('BR')).toBe('BRL');
  });

  test('precios de planes en orden correcto', () => {
    expect(DEFAULT_PLANS.free.priceUSD).toBe(0);
    PLAN_NAMES.slice(1).reduce((prev, curr) => {
      expect(DEFAULT_PLANS[curr].priceUSD).toBeGreaterThan(DEFAULT_PLANS[prev].priceUSD);
      return curr;
    }, PLAN_NAMES[0]);
  });

  test('getPlanPrice retorna estructura correcta', async () => {
    setPricingDb(makeMockDb());
    const r = await getPlanPrice('pro', 'AR');
    expect(r.plan).toBe('pro');
    expect(r.currency).toBe('ARS');
    expect(r.features.messagesPerDay).toBeGreaterThan(0);
  });

  test('comparePlans muestra diferencias', () => {
    const diff = comparePlans('starter', 'pro');
    expect(diff.priceDiffUSD).toBeGreaterThan(0);
    expect(diff.upgradeRecommended).toBe(true);
    expect(diff.messagesDiff).toBeGreaterThan(0);
  });
});

describe('E2E: Flujo privacidad y GDPR', () => {
  test('buildPrivacyReport incluye todas las secciones', async () => {
    setPrivacyDb(makeMockDb());
    const r = await buildPrivacyReport(UID);
    expect(r.conversations).toBeDefined();
    expect(r.contacts).toBeDefined();
    expect(r.memory).toBeDefined();
    expect(r.uid).toBe(UID);
  });

  test('requestErasure acepta todas las categorias', async () => {
    setPrivacyDb(makeMockDb());
    for (const cat of ['conversations', 'contacts', 'memory', 'all']) {
      const r = await requestErasure(UID, cat);
      expect(r.requestId).toMatch(/^erasure_/);
      expect(r.record.status).toBe('pending');
    }
  });

  test('buildGDPRExportPackage estructura completa', () => {
    const pkg = buildGDPRExportPackage(UID, { conversations: { count: 5 } }, [{ phone: PHONE }]);
    expect(pkg.subject).toBe(UID);
    expect(pkg.legalBasis).toBe('legitimate_interest');
    expect(pkg.rightsAvailable).toContain('acceso');
    expect(pkg.rightsAvailable).toContain('supresion');
    expect(pkg.contactDpo).toBeDefined();
  });

  test('ERASURE_CATEGORIES incluye all para borrado total', () => {
    expect(ERASURE_CATEGORIES).toContain('all');
    expect(isValidCategory('all')).toBe(true);
    expect(isValidCategory('todas')).toBe(false);
  });
});

describe('E2E: Seguridad integrada OTP + roles', () => {
  test('solo owner puede ejecutar accion critica', () => {
    const canExport = requirePermission('export_data');
    expect(canExport({ uid: UID, role: 'owner' }).allowed).toBe(true);
    expect(canExport({ uid: UID, role: 'agent' }).allowed).toBe(false);
    expect(canExport({ uid: UID, role: 'readonly' }).allowed).toBe(false);
  });

  test('founder bypasa restricciones de owner', () => {
    const requireOwner = requireRole(['owner']);
    const requireAtLeastOwner = requireMinRole('owner');
    expect(requireOwner({ uid: UID, role: 'founder' }).allowed).toBe(false);
    expect(requireAtLeastOwner({ uid: UID, role: 'founder' }).allowed).toBe(true);
  });
});
