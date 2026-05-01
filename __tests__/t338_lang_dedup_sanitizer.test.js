'use strict';

const {
  detectLanguage, detectAndSaveLanguage, getContactLanguage,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, CONFIDENCE_THRESHOLD,
  MIN_WORDS_FOR_DETECTION,
  __setFirestoreForTests: setLangDb,
} = require('../core/language_detector');

const { DedupFilter, hashMessage, DEFAULT_WINDOW_MS, DEFAULT_MAX_SIZE } = require('../core/dedup_filter');

const {
  maskPhone, maskEmail, truncateMessage,
  sanitizePhones, sanitizeEmails, sanitizeTokens, sanitizeCards,
  sanitizeText, sanitizeObject,
  PHONE_MASK_KEEP, DEFAULT_MAX_MESSAGE_LENGTH,
} = require('../core/log_sanitizer');

const UID = 'uid_t338';
const PHONE = '+5711112222';

function makeLangDb(langData = null) {
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
              const d = store[key] || langData;
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

describe('T338 -- language_detector + dedup_filter + log_sanitizer (28 tests)', () => {

  // SUPPORTED_LANGUAGES / constants
  test('SUPPORTED_LANGUAGES frozen contiene es/en/pt', () => {
    expect(() => { SUPPORTED_LANGUAGES.push('zh'); }).toThrow();
    expect(SUPPORTED_LANGUAGES).toContain('es');
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('pt');
  });

  test('DEFAULT_LANGUAGE = es, CONFIDENCE_THRESHOLD = 0.4, MIN_WORDS = 3', () => {
    expect(DEFAULT_LANGUAGE).toBe('es');
    expect(CONFIDENCE_THRESHOLD).toBe(0.4);
    expect(MIN_WORDS_FOR_DETECTION).toBe(3);
  });

  // detectLanguage
  test('detectLanguage: null lanza', () => {
    expect(() => detectLanguage(null)).toThrow('text requerido');
  });

  test('detectLanguage: texto muy corto (<3 palabras) -> es, confidence=0', () => {
    const r = detectLanguage('hola');
    expect(r.language).toBe('es');
    expect(r.confidence).toBe(0);
  });

  test('detectLanguage: espanol claro detectado', () => {
    const r = detectLanguage('hola como estas buenas dias quiero precio ayuda');
    expect(r.language).toBe('es');
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  test('detectLanguage: ingles claro detectado', () => {
    const r = detectLanguage('hello how are you good morning what price please help');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  test('detectLanguage: portugues con caracteres especiales', () => {
    const r = detectLanguage('ola como vai bom dia voce pode ajuda preco obrigado');
    expect(r.language).toBe('pt');
    expect(r.scores).toBeDefined();
  });

  test('detectLanguage: texto sin palabras reconocidas -> es default', () => {
    const r = detectLanguage('asdfg qwerty zxcvb uiop mnbvc');
    expect(r.language).toBe('es');
    expect(r.confidence).toBe(0);
  });

  // detectAndSaveLanguage
  test('detectAndSaveLanguage: uid null lanza', async () => {
    await expect(detectAndSaveLanguage(null, PHONE, 'hola como estas')).rejects.toThrow('uid requerido');
  });

  test('detectAndSaveLanguage: phone null lanza', async () => {
    await expect(detectAndSaveLanguage(UID, null, 'hola como estas')).rejects.toThrow('phone requerido');
  });

  test('detectAndSaveLanguage: message null lanza', async () => {
    await expect(detectAndSaveLanguage(UID, PHONE, null)).rejects.toThrow('message requerido');
  });

  test('detectAndSaveLanguage: espanol detectado -> saved=true', async () => {
    setLangDb(makeLangDb());
    const r = await detectAndSaveLanguage(UID, PHONE, 'hola como estas buenas dias quiero precio ayuda');
    expect(r.language).toBe('es');
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
    expect(r.saved).toBe(true);
  });

  // getContactLanguage
  test('getContactLanguage: uid null lanza', async () => {
    await expect(getContactLanguage(null, PHONE)).rejects.toThrow('uid requerido');
  });

  test('getContactLanguage: phone null lanza', async () => {
    await expect(getContactLanguage(UID, null)).rejects.toThrow('phone requerido');
  });

  test('getContactLanguage: sin doc -> DEFAULT_LANGUAGE', async () => {
    setLangDb(makeLangDb());
    const lang = await getContactLanguage(UID, PHONE);
    expect(lang).toBe(DEFAULT_LANGUAGE);
  });

  // DedupFilter constants
  test('DEFAULT_WINDOW_MS = 10 minutos, DEFAULT_MAX_SIZE = 10000', () => {
    expect(DEFAULT_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_MAX_SIZE).toBe(10000);
  });

  // DedupFilter.check
  test('DedupFilter.check: phone null lanza', () => {
    const f = new DedupFilter();
    expect(() => f.check(null, 'hola')).toThrow('phone requerido');
  });

  test('DedupFilter.check: text null lanza', () => {
    const f = new DedupFilter();
    expect(() => f.check(PHONE, null)).toThrow('text requerido');
  });

  test('DedupFilter.check: primer mensaje -> isDuplicate=false', () => {
    const f = new DedupFilter();
    const r = f.check(PHONE, 'hola mundo', 1000);
    expect(r.isDuplicate).toBe(false);
    expect(typeof r.hash).toBe('string');
  });

  test('DedupFilter.check: mismo mensaje inmediatamente -> isDuplicate=true', () => {
    const f = new DedupFilter();
    f.check(PHONE, 'hola mundo', 1000);
    const r = f.check(PHONE, 'hola mundo', 1500);
    expect(r.isDuplicate).toBe(true);
  });

  test('DedupFilter.check: ventana expirada -> isDuplicate=false', () => {
    const f = new DedupFilter({ windowMs: 5000 });
    f.check(PHONE, 'hola mundo', 1000);
    const r = f.check(PHONE, 'hola mundo', 7000);
    expect(r.isDuplicate).toBe(false);
  });

  test('DedupFilter.check: diferentes phones -> no duplicado', () => {
    const f = new DedupFilter();
    f.check('+5711111111', 'hola mundo', 1000);
    const r = f.check('+5722222222', 'hola mundo', 1500);
    expect(r.isDuplicate).toBe(false);
  });

  // DedupFilter.registerSent / isSentByMiia
  test('DedupFilter.registerSent: msgId null lanza', () => {
    const f = new DedupFilter();
    expect(() => f.registerSent(null)).toThrow('msgId requerido');
  });

  test('DedupFilter.registerSent + isSentByMiia: true dentro de ventana', () => {
    const f = new DedupFilter({ windowMs: 5000 });
    f.registerSent('msg_abc123', 1000);
    expect(f.isSentByMiia('msg_abc123', 2000)).toBe(true);
    expect(f.isSentByMiia('msg_abc123', 7000)).toBe(false);
  });

  test('DedupFilter.isSentByMiia: msgId no registrado -> false', () => {
    const f = new DedupFilter();
    expect(f.isSentByMiia('msg_desconocido')).toBe(false);
  });

  // log_sanitizer
  test('maskPhone: enmascara dejando 4 ultimos digitos', () => {
    const r = maskPhone('+57311222333');
    expect(r).toBe('****2333');
    expect(PHONE_MASK_KEEP).toBe(4);
  });

  test('maskEmail: enmascara email preservando dominio', () => {
    const r = maskEmail('mariano@gmail.com');
    expect(r).toContain('@gmail.com');
    expect(r).not.toContain('mariano');
  });

  test('truncateMessage: texto corto no trunca', () => {
    const r = truncateMessage('hola', 200);
    expect(r).toBe('hola');
  });

  test('truncateMessage: texto largo trunca con indicador', () => {
    const long = 'a'.repeat(250);
    const r = truncateMessage(long, 200);
    expect(r).toContain('truncado');
    expect(r.length).toBeLessThan(250);
  });

  test('sanitizeText: telefono enmascarado en texto', () => {
    const r = sanitizeText('Llamar a +573112223333 urgente');
    expect(r).not.toContain('573112223333');
  });

  test('sanitizeObject: objeto con phone/email sanitizado', () => {
    const obj = { phone: '+5733334444', email: 'user@domain.com', count: 5 };
    const r = sanitizeObject(obj);
    expect(r.phone).not.toContain('33334444');
    expect(r.email).not.toContain('user@');
    expect(r.count).toBe(5);
  });
});
