'use strict';

/**
 * T239 - Tests E2E Bloque 9
 * Flujos combinando: trusted_contacts_registry, tenant_isolation_validator,
 * conversation_search_engine, onboarding_flow, catalog_manager.
 */

const {
  addTrustedContact, getTrustedContacts, verifyTrustedContact, initiateRecovery,
  buildVerificationMessage, buildRecoveryNotificationText,
  TRUST_LEVELS, CONTACT_ROLES, MAX_TRUSTED_CONTACTS,
  __setFirestoreForTests: setTrustedDb,
} = require('../core/trusted_contacts_registry');

const {
  containsCanaryMarker, auditPromptForLeaks, auditConversationsForLeaks,
  runCanaryTest, generateIsolationReport,
  CANARY_MARKER, ISOLATION_SEVERITY, VIOLATION_TYPES,
} = require('../core/tenant_isolation_validator');

const {
  searchContacts, searchMessages, searchAll,
  computeRelevance, normalizeText, buildSnippet,
  SEARCH_MODES, MAX_RESULTS, MIN_QUERY_LENGTH,
} = require('../core/conversation_search_engine');

const {
  startOnboarding, advancePhase, saveAnswer, calculateCertificationLevel,
  buildProgressSummary, buildDiscoveryQuestions,
  ONBOARDING_PHASES, CERTIFICATION_LEVELS,
  __setFirestoreForTests: setOnboardingDb,
} = require('../core/onboarding_flow');

const {
  addCatalogItem, getCatalogItems, buildCatalogSummaryText,
  searchCatalogByText, buildItemDetailText, formatPriceText,
  ITEM_CATEGORIES, ITEM_STATUSES,
  __setFirestoreForTests: setCatalogDb,
} = require('../core/catalog_manager');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const UID_B = 'tenantBUID9876543210FEDCBA';

function makeMockDb({ docs = {}, throwGet = false, throwSet = false, throwDelete = false } = {}) {
  const stored = { ...docs };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(stored).forEach(([id, data]) => fn({ id, data: () => data, exists: true })),
            };
          },
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              stored[id] = opts && opts.merge ? { ...(stored[id] || {}), ...data } : data;
            },
            get: async () => ({ exists: !!stored[id], id, data: () => stored[id] }),
            delete: async () => {
              if (throwDelete) throw new Error('delete error');
              delete stored[id];
            },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  setTrustedDb(null);
  setOnboardingDb(null);
  setCatalogDb(null);
});
afterEach(() => {
  setTrustedDb(null);
  setOnboardingDb(null);
  setCatalogDb(null);
});

// ─────────────────────────────────────────────
describe('E2E: Flujo contactos de confianza', () => {
  test('estructura correcta de constantes', () => {
    expect(TRUST_LEVELS).toContain('primary');
    expect(TRUST_LEVELS).toContain('emergency');
    expect(CONTACT_ROLES).toContain('family');
    expect(CONTACT_ROLES).toContain('it_admin');
    expect(MAX_TRUSTED_CONTACTS).toBe(5);
  });

  test('agregar y verificar contacto de confianza', async () => {
    setTrustedDb(makeMockDb());
    const r = await addTrustedContact(UID, PHONE, { name: 'Ana', role: 'family', trustLevel: 'primary', canInitiateRecovery: true });
    expect(r.record.phone).toBe(PHONE);
    expect(r.record.verified).toBe(false);
    expect(r.record.canInitiateRecovery).toBe(true);
  });

  test('recovery falla si contacto no verificado', async () => {
    const docId = PHONE.replace(/\D/g, '').slice(-10);
    setTrustedDb(makeMockDb({ docs: { [docId]: { phone: PHONE, id: docId, verified: false, canInitiateRecovery: true } } }));
    await expect(initiateRecovery(UID, PHONE)).rejects.toThrow('no verificado');
  });

  test('recovery exitoso con contacto valido', async () => {
    const docId = PHONE.replace(/\D/g, '').slice(-10);
    setTrustedDb(makeMockDb({ docs: { [docId]: { phone: PHONE, id: docId, verified: true, canInitiateRecovery: true } } }));
    const r = await initiateRecovery(UID, PHONE);
    expect(r.recoveryId).toMatch(/^rec_/);
    expect(r.record.status).toBe('pending');
  });

  test('mensajes de verificacion y recovery contienen informacion clave', () => {
    const verifMsg = buildVerificationMessage(PHONE, UID);
    const recovMsg = buildRecoveryNotificationText({ name: 'Ana', phone: PHONE });
    expect(verifMsg).toContain('MIIA');
    expect(verifMsg).toContain('SI');
    expect(recovMsg).toContain('Ana');
    expect(recovMsg).toContain('CONFIRMAR');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo aislamiento tenant', () => {
  const CLEAN = 'Eres un asistente de ventas. Ayuda con productos.';
  const CANARY_IN = 'Prompt con UNICORNIO_FUCSIA_42 filtrado.';

  test('prompt limpio pasa auditoria', () => {
    const r = auditPromptForLeaks(CLEAN, UID);
    expect(r.isClean).toBe(true);
    expect(r.severity).toBe('OK');
  });

  test('canary en prompt detectado como CRITICAL', () => {
    const r = auditPromptForLeaks(CANARY_IN, UID);
    expect(r.isClean).toBe(false);
    expect(r.violations[0].type).toBe('canary_leak');
    expect(r.severity).toBe(ISOLATION_SEVERITY);
  });

  test('test canary cross-tenant pasa si limpio', () => {
    const r = runCanaryTest(UID, CLEAN);
    expect(r.passed).toBe(true);
    expect(r.canaryFoundInOwnerB).toBe(false);
  });

  test('test canary cross-tenant falla si contaminado', () => {
    const r = runCanaryTest(UID, CANARY_IN);
    expect(r.passed).toBe(false);
    expect(r.severity).toBe('CRITICAL');
  });

  test('auditoria de conversaciones detecta uid_mismatch', () => {
    const convs = [
      { uid: UID, text: 'Hola' },
      { uid: UID_B, text: 'Soy owner B' },
    ];
    const r = auditConversationsForLeaks(convs, UID);
    expect(r.isClean).toBe(false);
    expect(r.violations.some(v => v.type === 'uid_mismatch')).toBe(true);
  });

  test('reporte de aislamiento sin violaciones es ISOLATED', () => {
    const audits = [
      { violations: [] },
      { violations: [] },
    ];
    const r = generateIsolationReport(UID, audits);
    expect(r.overallStatus).toBe('ISOLATED');
    expect(r.hasCanaryLeak).toBe(false);
  });

  test('VIOLATION_TYPES cubre los 4 tipos criticos', () => {
    ['canary_leak', 'uid_mismatch', 'cross_tenant_data', 'prompt_injection'].forEach(t => {
      expect(VIOLATION_TYPES).toContain(t);
    });
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo busqueda semantica', () => {
  const contacts = [
    { phone: '+541155667788', name: 'Juan Perez', email: 'juan@test.com', tags: ['lead', 'vip'] },
    { phone: '+541155668899', name: 'Maria Lopez', email: 'maria@test.com', tags: ['client'] },
    { phone: '+541155669900', name: 'Carlos Gomez', email: 'carlos@test.com', notes: 'quiere precio especial' },
  ];
  const messages = [
    { text: 'Hola quiero saber el precio del producto', phone: '+54111' },
    { text: 'Buenos dias tengo una consulta sobre envios', phone: '+54222' },
    { text: 'Gracias por la info sobre precios', phone: '+54333' },
  ];

  test('normalizeText elimina acentos y minusculas', () => {
    expect(normalizeText('Martín López')).toBe('martin lopez');
    expect(normalizeText('HOLA!!!')).toBe('hola');
    expect(normalizeText(null)).toBe('');
  });

  test('computeRelevance: exacto=1, startsWith=0.9, contains=0.7', () => {
    expect(computeRelevance('hola', 'hola')).toBe(1);
    expect(computeRelevance('mar', 'martin')).toBe(0.9);
    expect(computeRelevance('ana', 'susana perez')).toBe(0.7);
  });

  test('searchContacts encuentra por nombre', () => {
    const r = searchContacts(contacts, 'juan');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].contact.name).toBe('Juan Perez');
    expect(r.mode).toBe('contacts');
  });

  test('searchMessages encuentra por contenido', () => {
    const r = searchMessages(messages, 'precio');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.mode).toBe('conversations');
    expect(r.results[0].snippet).toBeDefined();
  });

  test('searchAll combina contactos y mensajes', () => {
    const r = searchAll(contacts, messages, 'precio');
    expect(r.mode).toBe('all');
    expect(r.contacts).toBeDefined();
    expect(r.conversations).toBeDefined();
    expect(r.totalResults).toBeGreaterThan(0);
  });

  test('SEARCH_MODES cubre los 3 modos', () => {
    expect(SEARCH_MODES).toContain('contacts');
    expect(SEARCH_MODES).toContain('conversations');
    expect(SEARCH_MODES).toContain('all');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo onboarding adaptativo', () => {
  test('ONBOARDING_PHASES tiene 6 fases', () => {
    expect(ONBOARDING_PHASES.length).toBe(6);
    expect(ONBOARDING_PHASES[0]).toBe('discovery');
    expect(ONBOARDING_PHASES[ONBOARDING_PHASES.length - 1]).toBe('passive_learning');
  });

  test('CERTIFICATION_LEVELS tiene 4 niveles', () => {
    expect(CERTIFICATION_LEVELS).toContain('bronze');
    expect(CERTIFICATION_LEVELS).toContain('diamond');
    expect(CERTIFICATION_LEVELS.length).toBe(4);
  });

  test('calcular nivel bronze con 1 fase', () => {
    const answers = { q1: 'a', q2: 'b', q3: 'c' };
    const completedPhases = ['discovery'];
    expect(calculateCertificationLevel(answers, completedPhases)).toBe('bronze');
  });

  test('calcular nivel diamond con todas las fases y 10+ respuestas', () => {
    const answers = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['q' + i, 'a']));
    const completedPhases = [...ONBOARDING_PHASES];
    expect(calculateCertificationLevel(answers, completedPhases)).toBe('diamond');
  });

  test('startOnboarding crea estado inicial', async () => {
    setOnboardingDb(makeMockDb());
    const r = await startOnboarding(UID, { sector: 'food' });
    expect(r.uid).toBe(UID);
    expect(r.currentPhase).toBe('discovery');
    expect(r.completedPhases).toEqual([]);
  });

  test('buildDiscoveryQuestions retorna preguntas para sector food', () => {
    const qs = buildDiscoveryQuestions('food');
    expect(Array.isArray(qs)).toBe(true);
    expect(qs.length).toBeGreaterThan(3);
    expect(qs.some(q => q.question.toLowerCase().includes('entrega') || q.question.toLowerCase().includes('delivery') || q.id.toLowerCase().includes('delivery'))).toBe(true);
  });

  test('buildProgressSummary retorna null si state null', () => {
    expect(buildProgressSummary(null)).toBeNull();
  });

  test('buildProgressSummary calcula progreso correcto', () => {
    const state = {
      currentPhase: 'adaptive_questions',
      completedPhases: ['discovery', 'material_load'],
      answers: { q1: 'x' },
      startedAt: new Date().toISOString(),
    };
    const summary = buildProgressSummary(state);
    expect(summary.completedPhases).toBe(2);
    expect(summary.totalPhases).toBe(ONBOARDING_PHASES.length);
    expect(summary.progress).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────
describe('E2E: Flujo catalogo conversacional', () => {
  test('ITEM_CATEGORIES y ITEM_STATUSES completos y congelados', () => {
    expect(ITEM_CATEGORIES).toContain('product');
    expect(ITEM_CATEGORIES).toContain('subscription');
    expect(() => { ITEM_CATEGORIES.push('x'); }).toThrow();
    expect(ITEM_STATUSES).toContain('active');
    expect(ITEM_STATUSES).toContain('discontinued');
  });

  test('agregar y listar items del catalogo', async () => {
    setCatalogDb(makeMockDb());
    await addCatalogItem(UID, 'Plan Basico', { price: 0, currency: 'USD', category: 'subscription' });
    await addCatalogItem(UID, 'Plan Pro', { price: 49, currency: 'USD', category: 'subscription' });
    const items = await getCatalogItems(UID);
    expect(items.length).toBe(2);
  });

  test('busqueda de catalogo por texto', () => {
    const items = [
      { name: 'Empanada de Carne', status: 'active', tags: ['comida'] },
      { name: 'Pizza Muzzarella', status: 'active', tags: ['comida'] },
      { name: 'Coca Cola', status: 'inactive', tags: ['bebida'] },
    ];
    const r = searchCatalogByText(items, 'pizza');
    expect(r.length).toBe(1);
    expect(r[0].name).toContain('Pizza');
  });

  test('resumen del catalogo menciona items activos', () => {
    const items = [
      { name: 'Producto A', status: 'active', price: 100, currency: 'USD' },
      { name: 'Producto B', status: 'active', price: 200, currency: 'USD' },
      { name: 'Oculto', status: 'inactive', price: 50, currency: 'USD' },
    ];
    const text = buildCatalogSummaryText(items);
    expect(text).toContain('Producto A');
    expect(text).toContain('Producto B');
    expect(text).not.toContain('Oculto');
    expect(text).toContain('2');
  });

  test('formatPriceText formatea correctamente', () => {
    expect(formatPriceText({ price: null })).toBe('Precio a consultar');
    expect(formatPriceText({ price: 0 })).toBe('Gratis');
    expect(formatPriceText({ price: 1000, currency: 'ARS' })).toContain('ARS');
  });

  test('buildItemDetailText incluye toda la info relevante', () => {
    const item = { name: 'Plan Diamond', price: 149, currency: 'USD', status: 'active', tags: ['premium', 'enterprise'], stock: 10 };
    const text = buildItemDetailText(item);
    expect(text).toContain('Plan Diamond');
    expect(text).toContain('USD');
    expect(text).toContain('premium');
    expect(text).toContain('10');
  });
});

// ─────────────────────────────────────────────
describe('E2E: Seguridad integrada — aislamiento + catalogo + busqueda', () => {
  test('canary no contamina busqueda de catalogo', () => {
    const maliciousItems = [
      { name: 'Producto UNICORNIO_FUCSIA_42', status: 'active', tags: [] },
      { name: 'Plan Normal', status: 'active', tags: [] },
    ];
    // Si se busca el canary en el catalogo, puede encontrarse — eso es OK (no es cross-tenant)
    // Lo importante es que auditPromptForLeaks detecte si aparece en prompts
    const r = searchCatalogByText(maliciousItems, 'Plan');
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('Plan Normal');
  });

  test('busqueda no revela datos si query muy corta', () => {
    const contacts = [{ phone: '+54111', name: 'Ana Test', tags: [] }];
    expect(() => searchContacts(contacts, 'a')).toThrow('al menos');
  });

  test('flujo completo: contacto confianza + recovery + auditoria prompt', async () => {
    // 1. Setup contacto confianza verificado
    const docId = PHONE.replace(/\D/g, '').slice(-10);
    setTrustedDb(makeMockDb({ docs: { [docId]: { phone: PHONE, id: docId, verified: true, canInitiateRecovery: true } } }));
    const rec = await initiateRecovery(UID, PHONE);
    expect(rec.recoveryId).toMatch(/^rec_/);

    // 2. Auditar que el prompt de recovery no tenga leak de canary
    const recoveryPrompt = 'Recovery iniciado por ' + PHONE + ' para uid ' + UID.slice(0, 8);
    const audit = auditPromptForLeaks(recoveryPrompt, UID);
    expect(audit.isClean).toBe(true);

    // 3. Verificar que canary test pasa (prompt limpio)
    const canaryResult = runCanaryTest(UID, recoveryPrompt);
    expect(canaryResult.passed).toBe(true);
  });
});
