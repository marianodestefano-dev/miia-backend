'use strict';

const { CircuitBreaker, STATES, DEFAULTS } = require('../core/circuit_breaker');

const {
  getFlags, isEnabled, setFlags, clearCache,
  ALL_FLAGS, GLOBAL_DEFAULTS,
  __setFirestoreForTests: setFlagsDb,
} = require('../core/feature_flags');

const {
  computeContactSegment, buildEnrichmentRecord, buildEnrichmentText,
  isValidSegment, isValidTag,
  CONTACT_SEGMENTS, VALID_ENRICHMENT_FIELDS,
  MAX_TAGS_PER_CONTACT, MAX_NOTES_LENGTH,
} = require('../core/contact_enrichment');

const UID = 'uid_t340';

function makeFlagsDb(overrides = null) {
  return {
    collection: (col) => ({
      doc: (uid) => ({
        get: async () => overrides ? { exists: true, data: () => overrides } : { exists: false },
        set: async () => {},
      }),
    }),
  };
}

describe('T340 -- circuit_breaker + feature_flags + contact_enrichment (30 tests)', () => {

  // STATES / DEFAULTS
  test('STATES frozen contiene closed/open/half_open', () => {
    expect(() => { STATES.hacked = 'x'; }).toThrow();
    expect(STATES.CLOSED).toBe('closed');
    expect(STATES.OPEN).toBe('open');
    expect(STATES.HALF_OPEN).toBe('half_open');
  });

  test('DEFAULTS frozen: failureThreshold=5, successThreshold=2, openTimeoutMs=30000', () => {
    expect(() => { DEFAULTS.x = 1; }).toThrow();
    expect(DEFAULTS.failureThreshold).toBe(5);
    expect(DEFAULTS.successThreshold).toBe(2);
    expect(DEFAULTS.openTimeoutMs).toBe(30000);
  });

  // CircuitBreaker initial state
  test('CircuitBreaker: inicia en CLOSED', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.state).toBe(STATES.CLOSED);
    expect(cb.failureCount).toBe(0);
  });

  // execute
  test('CircuitBreaker.execute: fn no function lanza', async () => {
    const cb = new CircuitBreaker();
    await expect(cb.execute('not_a_fn')).rejects.toThrow('fn requerido');
  });

  test('CircuitBreaker.execute: llamada exitosa retorna resultado, sigue CLOSED', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.state).toBe(STATES.CLOSED);
  });

  test('CircuitBreaker.execute: N fallos -> OPEN, lanza CIRCUIT_OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const fail = async () => { throw new Error('external down'); };
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fail)).rejects.toThrow('external down');
    }
    expect(cb.state).toBe(STATES.OPEN);
    const err = await cb.execute(async () => 'x').catch(e => e);
    expect(err.code).toBe('CIRCUIT_OPEN');
  });

  test('CircuitBreaker.execute: OPEN sin timeout sigue lanzando CIRCUIT_OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, openTimeoutMs: 60000 });
    const fail = async () => { throw new Error('down'); };
    await expect(cb.execute(fail)).rejects.toThrow('down');
    await expect(cb.execute(fail)).rejects.toThrow('down');
    expect(cb.state).toBe(STATES.OPEN);
    const err = await cb.execute(async () => 'x', Date.now()).catch(e => e);
    expect(err.code).toBe('CIRCUIT_OPEN');
  });

  test('CircuitBreaker: OPEN + timeout -> HALF_OPEN, permite intento', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, openTimeoutMs: 5000, successThreshold: 1 });
    const fail = async () => { throw new Error('down'); };
    await expect(cb.execute(fail)).rejects.toThrow('down');
    await expect(cb.execute(fail)).rejects.toThrow('down');
    expect(cb.state).toBe(STATES.OPEN);
    // Simular que el timeout ya paso manipulando _openedAt
    cb._openedAt = Date.now() - 6000;
    const result = await cb.execute(async () => 'probe');
    expect(result).toBe('probe');
    expect(cb.state).toBe(STATES.CLOSED); // successThreshold=1: 1 exito cierra
  });

  test('CircuitBreaker: HALF_OPEN + exitos suficientes -> CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, successThreshold: 2, openTimeoutMs: 5000 });
    const fail = async () => { throw new Error('down'); };
    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.state).toBe(STATES.OPEN);
    // Simular timeout transcurrido
    cb._openedAt = Date.now() - 6000;
    await cb.execute(async () => 'ok1');
    expect(cb.state).toBe(STATES.HALF_OPEN);
    await cb.execute(async () => 'ok2');
    expect(cb.state).toBe(STATES.CLOSED);
  });

  test('CircuitBreaker.reset: vuelve a CLOSED limpio', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb._failureCount = 5;
    cb._state = STATES.OPEN;
    cb.reset();
    expect(cb.state).toBe(STATES.CLOSED);
    expect(cb.failureCount).toBe(0);
    const stats = cb.getStats();
    expect(stats.openedAt).toBeNull();
  });

  // feature_flags
  test('ALL_FLAGS frozen, contiene mmc_enabled y ai_v2_enabled', () => {
    expect(() => { ALL_FLAGS.push('hack'); }).toThrow();
    expect(ALL_FLAGS).toContain('mmc_enabled');
    expect(ALL_FLAGS).toContain('ai_v2_enabled');
  });

  test('GLOBAL_DEFAULTS frozen: ai_v2_enabled=false, mmc_enabled=true', () => {
    expect(() => { GLOBAL_DEFAULTS.x = true; }).toThrow();
    expect(GLOBAL_DEFAULTS.ai_v2_enabled).toBe(false);
    expect(GLOBAL_DEFAULTS.mmc_enabled).toBe(true);
    expect(GLOBAL_DEFAULTS.audit_trail_enabled).toBe(true);
  });

  test('getFlags: uid null lanza', async () => {
    await expect(getFlags(null)).rejects.toThrow('uid requerido');
  });

  test('getFlags: sin doc -> retorna GLOBAL_DEFAULTS', async () => {
    clearCache();
    setFlagsDb(makeFlagsDb(null));
    const flags = await getFlags(UID);
    expect(flags.mmc_enabled).toBe(true);
    expect(flags.ai_v2_enabled).toBe(false);
    clearCache();
  });

  test('getFlags: overrides de Firestore mergean con defaults', async () => {
    clearCache();
    setFlagsDb(makeFlagsDb({ ai_v2_enabled: true, tts_enabled: true }));
    const flags = await getFlags(UID);
    expect(flags.ai_v2_enabled).toBe(true);
    expect(flags.tts_enabled).toBe(true);
    expect(flags.mmc_enabled).toBe(true); // default, sin override
    clearCache();
  });

  test('getFlags: Firestore error -> retorna defaults', async () => {
    clearCache();
    setFlagsDb({ collection: () => { throw new Error('down'); } });
    const flags = await getFlags(UID);
    expect(flags.mmc_enabled).toBe(true);
    clearCache();
  });

  test('isEnabled: uid null lanza', async () => {
    await expect(isEnabled(null, 'mmc_enabled')).rejects.toThrow('uid requerido');
  });

  test('isEnabled: flag invalido lanza', async () => {
    await expect(isEnabled(UID, 'hack_flag')).rejects.toThrow('flag invalido');
  });

  test('isEnabled: flag enabled por override', async () => {
    clearCache();
    setFlagsDb(makeFlagsDb({ ai_v2_enabled: true }));
    const enabled = await isEnabled(UID, 'ai_v2_enabled');
    expect(enabled).toBe(true);
    clearCache();
  });

  test('setFlags: uid null lanza', async () => {
    await expect(setFlags(null, { mmc_enabled: false })).rejects.toThrow('uid requerido');
  });

  test('setFlags: flag invalido lanza', async () => {
    await expect(setFlags(UID, { hack_flag: true })).rejects.toThrow('flags invalidos');
  });

  // contact_enrichment
  test('CONTACT_SEGMENTS frozen, contiene vip/premium/regular', () => {
    expect(() => { CONTACT_SEGMENTS.push('ultra'); }).toThrow();
    expect(CONTACT_SEGMENTS).toContain('vip');
    expect(CONTACT_SEGMENTS).toContain('premium');
    expect(CONTACT_SEGMENTS).toContain('inactive');
  });

  test('VALID_ENRICHMENT_FIELDS frozen, contiene email/company/notes', () => {
    expect(() => { VALID_ENRICHMENT_FIELDS.push('hack'); }).toThrow();
    expect(VALID_ENRICHMENT_FIELDS).toContain('email');
    expect(VALID_ENRICHMENT_FIELDS).toContain('company');
    expect(VALID_ENRICHMENT_FIELDS).toContain('notes');
    expect(MAX_NOTES_LENGTH).toBe(500);
    expect(MAX_TAGS_PER_CONTACT).toBe(20);
  });

  test('isValidSegment: valid/invalid', () => {
    expect(isValidSegment('vip')).toBe(true);
    expect(isValidSegment('ultra')).toBe(false);
    expect(isValidSegment(null)).toBe(false);
  });

  test('isValidTag: valid (minusculas+numeros+_), invalid (mayusculas/espacios)', () => {
    expect(isValidTag('keyword_match')).toBe(true);
    expect(isValidTag('lead123')).toBe(true);
    expect(isValidTag('KeywordMatch')).toBe(false); // uppercase
    expect(isValidTag('tag con espacio')).toBe(false);
    expect(isValidTag('')).toBe(false);
    expect(isValidTag(null)).toBe(false);
  });

  test('computeContactSegment: vip (converted+totalPurchases>=5)', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 5 })).toBe('vip');
  });

  test('computeContactSegment: premium (converted+2), converted, inactive, cold, new, regular', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 2 })).toBe('premium');
    expect(computeContactSegment({ isConverted: true, totalPurchases: 1 })).toBe('converted');
    expect(computeContactSegment({ daysSinceLastActivity: 91 })).toBe('inactive');
    expect(computeContactSegment({ daysSinceLastActivity: 31 })).toBe('cold');
    expect(computeContactSegment({ daysSinceLastActivity: 5 })).toBe('new');
    expect(computeContactSegment({})).toBe('regular');
  });

  test('buildEnrichmentRecord: uid null lanza', () => {
    expect(() => buildEnrichmentRecord(null, '+5711112222', {})).toThrow('uid requerido');
  });

  test('buildEnrichmentRecord: phone null lanza', () => {
    expect(() => buildEnrichmentRecord(UID, null, {})).toThrow('phone requerido');
  });

  test('buildEnrichmentRecord: campo desconocido filtrado, notes truncadas', () => {
    const r = buildEnrichmentRecord(UID, '+5711112222', {
      email: 'test@co.com',
      hackField: 'evil',
      notes: 'n'.repeat(600),
    });
    expect(r.fields.email).toBe('test@co.com');
    expect(r.fields.hackField).toBeUndefined();
    expect(r.fields.notes.length).toBe(MAX_NOTES_LENGTH);
  });

  test('buildEnrichmentRecord: contiene recordId + segment + uid + phone', () => {
    const r = buildEnrichmentRecord(UID, '+5711112222', { company: 'ACME' });
    expect(typeof r.recordId).toBe('string');
    expect(r.uid).toBe(UID);
    expect(r.phone).toBe('+5711112222');
    expect(r.segment).toBeDefined();
    expect(Array.isArray(r.tags)).toBe(true);
  });

  test('buildEnrichmentText: retorna string con emoji y datos del segmento', () => {
    const r = buildEnrichmentRecord(UID, '+5711112222', { company: 'ACME', city: 'Bogota' },
      { segmentOpts: { isConverted: true, totalPurchases: 5 } });
    const text = buildEnrichmentText(r);
    expect(typeof text).toBe('string');
    expect(text).toContain('+5711112222');
    expect(text).toContain('vip');
  });
});
