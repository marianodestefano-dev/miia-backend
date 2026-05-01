'use strict';

/**
 * T339 -- E2E Bloque 45
 * Pipeline: language_detector -> dedup_filter -> log_sanitizer
 */

const {
  detectLanguage, detectAndSaveLanguage, getContactLanguage,
  DEFAULT_LANGUAGE, CONFIDENCE_THRESHOLD,
  __setFirestoreForTests: setLangDb,
} = require('../core/language_detector');

const { DedupFilter } = require('../core/dedup_filter');
const { sanitizeText, sanitizeObject, maskPhone } = require('../core/log_sanitizer');

const UID = 'owner_bloque45_001';
const PHONE_ES = '+5711112222';
const PHONE_EN = '+14155551234';

function makeLangDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (phone) => ({
            set: async (data) => {
              const key = `${col}/${uid}/${subCol}/${phone}`;
              store[key] = data;
            },
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${phone}`;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

describe('T339 -- E2E Bloque 45: language_detector + dedup_filter + log_sanitizer', () => {

  test('Paso 1 -- mensaje ingles detectado correctamente', () => {
    const r = detectLanguage('hello how are you please help me with price yes');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
  });

  test('Paso 2 -- mensaje duplicado bloqueado por dedup', () => {
    const filter = new DedupFilter({ windowMs: 60000 });
    const msg = 'quiero informacion del precio';
    const NOW = 1000000;
    const r1 = filter.check(PHONE_ES, msg, NOW);
    const r2 = filter.check(PHONE_ES, msg, NOW + 2000);
    expect(r1.isDuplicate).toBe(false);
    expect(r2.isDuplicate).toBe(true);
  });

  test('Paso 3 -- mensaje de MIIA no re-procesado (isSentByMiia)', () => {
    const filter = new DedupFilter({ windowMs: 60000 });
    filter.registerSent('msg_miia_001', 1000000);
    expect(filter.isSentByMiia('msg_miia_001', 1001000)).toBe(true);
    expect(filter.isSentByMiia('msg_lead_002', 1001000)).toBe(false);
  });

  test('Paso 4 -- log sanitizado (telefono enmascarado)', () => {
    const logEntry = `Mensaje recibido de ${PHONE_ES}: hola quiero info`;
    const sanitized = sanitizeText(logEntry);
    expect(sanitized).not.toContain('11112222');
  });

  test('Paso 5 -- saveContactLanguage + getContactLanguage round-trip', async () => {
    const db = makeLangDb();
    setLangDb(db);
    await detectAndSaveLanguage(UID, PHONE_ES, 'hola como estas buenas dias quiero precio ayuda');
    const lang = await getContactLanguage(UID, PHONE_ES);
    expect(lang).toBe('es');
  });

  test('Paso 6 -- portugues detectado con caracteres especiales', () => {
    const r = detectLanguage('ola como vai bom dia voce pode ajudar preco obrigado muito');
    expect(r.language).toBe('pt');
  });

  test('Pipeline completo -- detect + dedup + sanitize', async () => {
    const db = makeLangDb();
    setLangDb(db);

    // A: detectar idioma del lead
    const msg = 'hello how are you please help me with price';
    const detection = detectLanguage(msg);
    expect(detection.language).toBe('en');

    // B: dedup - primer mensaje pasa, segundo bloqueado
    const filter = new DedupFilter({ windowMs: 30000 });
    const NOW = Date.now();
    const first = filter.check(PHONE_EN, msg, NOW);
    const second = filter.check(PHONE_EN, msg, NOW + 1000);
    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);

    // C: sanitizar log de la actividad
    const logData = { phone: PHONE_EN, message: msg, language: detection.language };
    const safeLog = sanitizeObject(logData);
    expect(safeLog.phone).not.toContain('4155551234');
    expect(safeLog.language).toBe('en');

    // D: guardar idioma detectado
    const { saved } = await detectAndSaveLanguage(UID, PHONE_EN, msg);
    expect(saved).toBe(true);

    // E: recuperar idioma guardado
    const savedLang = await getContactLanguage(UID, PHONE_EN);
    expect(savedLang).toBe('en');
  });
});
