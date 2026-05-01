'use strict';

/**
 * T341 -- E2E Bloque 46
 * Pipeline: circuit_breaker -> feature_flags -> contact_enrichment
 */

const { CircuitBreaker, STATES } = require('../core/circuit_breaker');
const {
  getFlags, isEnabled, clearCache,
  __setFirestoreForTests: setFlagsDb,
} = require('../core/feature_flags');
const {
  buildEnrichmentRecord, computeContactSegment, buildEnrichmentText,
} = require('../core/contact_enrichment');

const UID = 'owner_bloque46_001';

function makeFlagsDb(overrides = null) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => overrides ? { exists: true, data: () => overrides } : { exists: false },
        set: async () => {},
      }),
    }),
  };
}

describe('T341 -- E2E Bloque 46: circuit_breaker + feature_flags + contact_enrichment', () => {

  beforeEach(() => clearCache());

  test('Paso 1 -- circuit breaker protege llamada exitosa', async () => {
    const cb = new CircuitBreaker({ name: 'gemini', failureThreshold: 3 });
    const result = await cb.execute(async () => ({ text: 'respuesta generada' }));
    expect(result.text).toBe('respuesta generada');
    expect(cb.state).toBe(STATES.CLOSED);
  });

  test('Paso 2 -- feature flags: ai_v2 disabled, mmc enabled (defaults)', async () => {
    setFlagsDb(makeFlagsDb(null));
    const flags = await getFlags(UID);
    expect(flags.ai_v2_enabled).toBe(false);
    expect(flags.mmc_enabled).toBe(true);
  });

  test('Paso 3 -- feature flags: override habilita ai_v2', async () => {
    setFlagsDb(makeFlagsDb({ ai_v2_enabled: true }));
    const enabled = await isEnabled(UID, 'ai_v2_enabled');
    expect(enabled).toBe(true);
  });

  test('Paso 4 -- contacto enriched con segmento vip', () => {
    const record = buildEnrichmentRecord(UID, '+5711112222', {
      email: 'ana@empresa.co',
      company: 'Tech SAS',
      city: 'Bogota',
    }, { segmentOpts: { isConverted: true, totalPurchases: 6 } });
    expect(record.segment).toBe('vip');
    expect(record.fields.email).toBe('ana@empresa.co');
  });

  test('Paso 5 -- buildEnrichmentText contiene datos del contacto', () => {
    const record = buildEnrichmentRecord(UID, '+5711112222', { company: 'ACME' },
      { segmentOpts: { isConverted: true, totalPurchases: 3 } });
    const text = buildEnrichmentText(record);
    expect(text).toContain('+5711112222');
    expect(text.length).toBeGreaterThan(10);
  });

  test('Paso 6 -- circuit breaker ciclo completo CLOSED->OPEN->HALF_OPEN->CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, successThreshold: 1, openTimeoutMs: 5000 });
    const fail = async () => { throw new Error('down'); };

    // CLOSED -> OPEN
    await expect(cb.execute(fail)).rejects.toThrow('down');
    await expect(cb.execute(fail)).rejects.toThrow('down');
    expect(cb.state).toBe(STATES.OPEN);

    // Simular timeout transcurrido
    cb._openedAt = Date.now() - 6000;

    // OPEN -> HALF_OPEN -> CLOSED (1 exito con successThreshold=1)
    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.state).toBe(STATES.CLOSED);
  });

  test('Pipeline completo -- circuit_breaker + feature_flags + enrichment', async () => {
    // A: Circuit breaker para llamada externa
    const cb = new CircuitBreaker({ name: 'external_api', failureThreshold: 5 });

    // B: Feature flags
    setFlagsDb(makeFlagsDb({ ai_v2_enabled: true, mmc_enabled: true }));
    const flags = await getFlags(UID);
    expect(flags.ai_v2_enabled).toBe(true);

    // C: Llamada protegida por circuit breaker
    const apiResult = await cb.execute(async () => ({
      contactData: { email: 'luis@empresa.co', company: 'Software SAS' }
    }));
    expect(apiResult.contactData.email).toBe('luis@empresa.co');
    expect(cb.state).toBe(STATES.CLOSED);

    // D: Enriquecer contacto con resultado
    const record = buildEnrichmentRecord(UID, '+5711119999', apiResult.contactData, {
      segmentOpts: { daysSinceLastActivity: 3 },
    });
    expect(record.segment).toBe('new');
    expect(record.fields.email).toBe('luis@empresa.co');

    // E: Generar texto de enriquecimiento
    const text = buildEnrichmentText(record);
    expect(text).toContain('+5711119999');
    expect(text).toContain('new');
  });
});
