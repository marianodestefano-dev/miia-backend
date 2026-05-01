'use strict';

const {
  detectTopicsInMessage, recordTopics,
  TOPIC_KEYWORDS, TOPIC_LABELS, MIN_CONFIDENCE, MAX_TOPICS_PER_MESSAGE,
  __setFirestoreForTests: setTopicDb,
} = require('../core/topic_analyzer');

const {
  isUnusualHour, classifyAnomaly, recordAnomaly,
  ANOMALY_TYPES, SEVERITY,
  MAX_FAILED_LOGINS, MAX_EXPORTS_PER_HOUR,
  __setFirestoreForTests: setAnomalyDb,
} = require('../core/anomaly_detector');

const { validateSchema, validate, SUPPORTED_TYPES } = require('../core/schema_validator');

const UID = 'uid_t342';
const PHONE = '+5711112222';

function makeDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
          }),
          where: () => ({
            get: async () => ({ forEach: () => {} }),
          }),
        }),
      }),
    }),
  };
}

describe('T342 -- topic_analyzer + anomaly_detector + schema_validator (30 tests)', () => {

  // TOPIC_KEYWORDS / TOPIC_LABELS constants
  test('TOPIC_KEYWORDS frozen, contiene pricing/appointment/support', () => {
    expect(() => { TOPIC_KEYWORDS.hack = []; }).toThrow();
    expect(Array.isArray(TOPIC_KEYWORDS.pricing)).toBe(true);
    expect(Array.isArray(TOPIC_KEYWORDS.appointment)).toBe(true);
    expect(Array.isArray(TOPIC_KEYWORDS.support)).toBe(true);
  });

  test('TOPIC_LABELS frozen, MIN_CONFIDENCE=0.2, MAX_TOPICS_PER_MESSAGE=3', () => {
    expect(() => { TOPIC_LABELS.hack = 'x'; }).toThrow();
    expect(MIN_CONFIDENCE).toBe(0.2);
    expect(MAX_TOPICS_PER_MESSAGE).toBe(3);
  });

  // detectTopicsInMessage
  test('detectTopicsInMessage: null lanza', () => {
    expect(() => detectTopicsInMessage(null)).toThrow('text requerido');
  });

  test('detectTopicsInMessage: texto sin keywords -> []', () => {
    const r = detectTopicsInMessage('asdfg qwerty zxcvb');
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(0);
  });

  test('detectTopicsInMessage: texto de precio -> pricing detectado', () => {
    const r = detectTopicsInMessage('cuanto cuesta el precio de este producto');
    expect(r.some(t => t.topic === 'pricing')).toBe(true);
    const pricingTopic = r.find(t => t.topic === 'pricing');
    expect(pricingTopic.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  test('detectTopicsInMessage: texto de turno -> appointment detectado', () => {
    const r = detectTopicsInMessage('quiero agendar un turno cita para reservar');
    expect(r.some(t => t.topic === 'appointment')).toBe(true);
  });

  test('detectTopicsInMessage: texto de problema -> support detectado', () => {
    const r = detectTopicsInMessage('hay un problema falla error queja reclamo');
    expect(r.some(t => t.topic === 'support')).toBe(true);
  });

  test('detectTopicsInMessage: retorna max MAX_TOPICS_PER_MESSAGE topics', () => {
    const r = detectTopicsInMessage('precio turno problema envio pago hola horario donde informacion');
    expect(r.length).toBeLessThanOrEqual(MAX_TOPICS_PER_MESSAGE);
  });

  test('detectTopicsInMessage: cada topic tiene label y confidence', () => {
    const r = detectTopicsInMessage('cuanto cuesta precio tarifa presupuesto');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toHaveProperty('topic');
    expect(r[0]).toHaveProperty('label');
    expect(r[0]).toHaveProperty('confidence');
  });

  // recordTopics
  test('recordTopics: uid null lanza', async () => {
    await expect(recordTopics(null, PHONE, 'cuanto cuesta')).rejects.toThrow('uid requerido');
  });

  test('recordTopics: phone null lanza', async () => {
    await expect(recordTopics(UID, null, 'cuanto cuesta')).rejects.toThrow('phone requerido');
  });

  test('recordTopics: message null lanza', async () => {
    await expect(recordTopics(UID, PHONE, null)).rejects.toThrow('message requerido');
  });

  test('recordTopics: sin topics detectados -> [] (no escribe)', async () => {
    setTopicDb(makeDb());
    const r = await recordTopics(UID, PHONE, 'asdfg qwerty zxcvb');
    expect(r).toEqual([]);
  });

  // ANOMALY_TYPES / SEVERITY
  test('ANOMALY_TYPES frozen, contiene tipos criticos', () => {
    expect(() => { ANOMALY_TYPES.push('hack'); }).toThrow();
    expect(ANOMALY_TYPES).toContain('multiple_failed_logins');
    expect(ANOMALY_TYPES).toContain('api_key_multiple_rotations');
    expect(ANOMALY_TYPES).toContain('high_volume_export');
  });

  test('SEVERITY frozen, MAX_FAILED_LOGINS=5, MAX_EXPORTS_PER_HOUR=3', () => {
    expect(() => { SEVERITY.UBER = 'uber'; }).toThrow();
    expect(SEVERITY.CRITICAL).toBe('critical');
    expect(MAX_FAILED_LOGINS).toBe(5);
    expect(MAX_EXPORTS_PER_HOUR).toBe(3);
  });

  // isUnusualHour
  test('isUnusualHour: hora 0 (medianoche) -> true', () => {
    const midnight = new Date('2026-05-01T00:30:00Z').getTime();
    expect(isUnusualHour(midnight)).toBe(true);
  });

  test('isUnusualHour: hora 3 -> true, hora 6 -> false, hora 12 -> false', () => {
    const h3 = new Date('2026-05-01T03:00:00Z').getTime();
    const h6 = new Date('2026-05-01T06:00:00Z').getTime();
    const h12 = new Date('2026-05-01T12:00:00Z').getTime();
    expect(isUnusualHour(h3)).toBe(true);
    expect(isUnusualHour(h6)).toBe(false);
    expect(isUnusualHour(h12)).toBe(false);
  });

  // classifyAnomaly
  test('classifyAnomaly: type invalido lanza', () => {
    expect(() => classifyAnomaly('hack_type', {})).toThrow('type invalido');
  });

  test('classifyAnomaly: multiple_failed_logins -> HIGH', () => {
    const r = classifyAnomaly('multiple_failed_logins', { count: 5 });
    expect(r.severity).toBe(SEVERITY.HIGH);
    expect(r.type).toBe('multiple_failed_logins');
  });

  test('classifyAnomaly: multiple_failed_logins count>=10 -> CRITICAL', () => {
    const r = classifyAnomaly('multiple_failed_logins', { count: 10 });
    expect(r.severity).toBe(SEVERITY.CRITICAL);
  });

  test('classifyAnomaly: api_key_multiple_rotations -> CRITICAL', () => {
    const r = classifyAnomaly('api_key_multiple_rotations', {});
    expect(r.severity).toBe(SEVERITY.CRITICAL);
  });

  test('classifyAnomaly: new_device -> MEDIUM, unusual_hour -> LOW', () => {
    expect(classifyAnomaly('new_device', {}).severity).toBe(SEVERITY.MEDIUM);
    expect(classifyAnomaly('unusual_hour', {}).severity).toBe(SEVERITY.LOW);
  });

  test('recordAnomaly: uid null lanza', async () => {
    await expect(recordAnomaly(null, 'new_device', {})).rejects.toThrow('uid requerido');
  });

  test('recordAnomaly: exito retorna anomalyId + severity + timestamp', async () => {
    setAnomalyDb(makeDb());
    const r = await recordAnomaly(UID, 'new_device', { ip: '1.2.3.4' });
    expect(typeof r.anomalyId).toBe('string');
    expect(r.severity).toBe(SEVERITY.MEDIUM);
    expect(r.timestamp).toBeDefined();
  });

  // schema_validator
  test('SUPPORTED_TYPES frozen, contiene string/number/boolean/object/array/null', () => {
    expect(() => { SUPPORTED_TYPES.push('hack'); }).toThrow();
    expect(SUPPORTED_TYPES).toContain('string');
    expect(SUPPORTED_TYPES).toContain('number');
    expect(SUPPORTED_TYPES).toContain('array');
    expect(SUPPORTED_TYPES).toContain('null');
  });

  test('validate: objeto valido con schema -> {valid:true, errors:[]}', () => {
    const r = validate({ name: 'MIIA', age: 3 }, {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('validateSchema: tipo incorrecto -> error de tipo', () => {
    const errs = validateSchema(123, { type: 'string' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain('string');
  });

  test('validateSchema: string minLength/maxLength falla', () => {
    const errMin = validateSchema('ab', { type: 'string', minLength: 3 });
    expect(errMin.some(e => e.includes('minLength'))).toBe(true);
    const errMax = validateSchema('a'.repeat(10), { type: 'string', maxLength: 5 });
    expect(errMax.some(e => e.includes('maxLength'))).toBe(true);
  });

  test('validateSchema: string enum falla si valor no esta en lista', () => {
    const errs = validateSchema('zh', { type: 'string', enum: ['es', 'en', 'pt'] });
    expect(errs.some(e => e.includes('uno de'))).toBe(true);
  });

  test('validateSchema: number minimum/maximum falla', () => {
    const errMin = validateSchema(0, { type: 'number', minimum: 1 });
    expect(errMin.some(e => e.includes('minimo'))).toBe(true);
    const errMax = validateSchema(1001, { type: 'number', maximum: 1000 });
    expect(errMax.some(e => e.includes('maximo'))).toBe(true);
  });

  test('validateSchema: object campo required faltante -> error', () => {
    const errs = validateSchema({ timezone: 'UTC' }, {
      type: 'object',
      required: ['businessName'],
    });
    expect(errs.some(e => e.includes('businessName'))).toBe(true);
  });

  test('validateSchema: additionalProperties=false con campo extra -> error', () => {
    const errs = validateSchema({ name: 'MIIA', hackField: 'x' }, {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    expect(errs.some(e => e.includes('hackField'))).toBe(true);
  });
});
