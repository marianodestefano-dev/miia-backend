'use strict';

/**
 * T343 -- E2E Bloque 47
 * Pipeline: topic_analyzer -> anomaly_detector -> schema_validator
 */

const {
  detectTopicsInMessage, recordTopics,
  MIN_CONFIDENCE,
  __setFirestoreForTests: setTopicDb,
} = require('../core/topic_analyzer');

const {
  classifyAnomaly, recordAnomaly, checkFailedLogins,
  SEVERITY, ANOMALY_TYPES,
  __setFirestoreForTests: setAnomalyDb,
} = require('../core/anomaly_detector');

const { validate } = require('../core/schema_validator');

const UID = 'owner_bloque47_001';
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
            get: async () => ({ exists: false }),
          }),
          where: () => ({
            get: async () => ({ forEach: () => {} }),
          }),
        }),
      }),
    }),
  };
}

describe('T343 -- E2E Bloque 47: topic_analyzer + anomaly_detector + schema_validator', () => {

  beforeEach(() => {
    const db = makeDb();
    setTopicDb(db);
    setAnomalyDb(db);
  });

  test('Paso 1 -- topic de precio detectado en mensaje del lead', () => {
    const topics = detectTopicsInMessage('cuanto cuesta el plan? necesito presupuesto y cotizacion');
    expect(topics.some(t => t.topic === 'pricing')).toBe(true);
    expect(topics[0].confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  test('Paso 2 -- anomalia new_device clasificada como MEDIUM', () => {
    const anomaly = classifyAnomaly('new_device', { deviceId: 'iPhone_XR' });
    expect(anomaly.severity).toBe(SEVERITY.MEDIUM);
    expect(anomaly.context.deviceId).toBe('iPhone_XR');
  });

  test('Paso 3 -- schema validation del payload de evento', () => {
    const eventSchema = {
      type: 'object',
      required: ['uid', 'type'],
      properties: {
        uid: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ANOMALY_TYPES },
        count: { type: 'number', minimum: 0 },
      },
    };
    const valid = validate({ uid: UID, type: 'new_device', count: 1 }, eventSchema);
    expect(valid.valid).toBe(true);

    const invalid = validate({ uid: UID, type: 'hack_type' }, eventSchema);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some(e => e.includes('uno de'))).toBe(true);
  });

  test('Paso 4 -- recordar topics del lead', async () => {
    const r = await recordTopics(UID, PHONE, 'quiero turno cita agendar disponibilidad horario');
    expect(r.some(t => t.topic === 'appointment')).toBe(true);
  });

  test('Paso 5 -- checkFailedLogins detecta anomalia cuando count >= MAX', async () => {
    const r = await checkFailedLogins(UID, 5);
    expect(r).not.toBeNull();
    expect(r.severity).toBe(SEVERITY.HIGH);
  });

  test('Paso 6 -- recordAnomaly para exportacion masiva', async () => {
    const r = await recordAnomaly(UID, 'high_volume_export', { rows: 5000, format: 'json' });
    expect(typeof r.anomalyId).toBe('string');
    expect(r.severity).toBe(SEVERITY.MEDIUM);
  });

  test('Pipeline completo -- topic + anomaly + schema', async () => {
    // A: Detectar topic en mensaje
    const msg = 'hola cuanto cuesta el precio del plan pro';
    const topics = detectTopicsInMessage(msg);
    expect(topics.length).toBeGreaterThan(0);

    // B: Validar schema del mensaje entrante
    const msgSchema = {
      type: 'object',
      required: ['phone', 'body'],
      properties: {
        phone: { type: 'string', minLength: 5 },
        body: { type: 'string', minLength: 1 },
        topics: { type: 'array' },
      },
    };
    const msgPayload = { phone: PHONE, body: msg, topics: topics.map(t => t.topic) };
    const schemaResult = validate(msgPayload, msgSchema);
    expect(schemaResult.valid).toBe(true);

    // C: Registrar anomalia si hubo muchos logins fallidos
    const loginAnomalyResult = await checkFailedLogins(UID, 3); // < 5, no anomalia
    expect(loginAnomalyResult).toBeNull();

    // D: 6 logins fallidos -> anomalia HIGH
    const highLoginAnomaly = await checkFailedLogins(UID, 6);
    expect(highLoginAnomaly.severity).toBe(SEVERITY.HIGH);

    // E: Registrar topics
    const recorded = await recordTopics(UID, PHONE, msg);
    expect(recorded.some(t => t.topic === 'pricing' || t.topic === 'greeting')).toBe(true);
  });
});
