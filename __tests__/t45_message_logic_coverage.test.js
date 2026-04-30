'use strict';

/**
 * T45 — coverage tests message_logic.js (>95% statements target)
 *
 * Cubre las funciones puras de core/message_logic.js no testeadas por suites previas.
 * Tests escritos por Vi siguiendo R-Vi-1..5 (verificar exports + inputs vs arrays
 * de matching antes de escribir asserts).
 *
 * NO cubre processLearningTags / processAgendaTag (async + callbacks heavy mocking;
 * footnote para T46+).
 */

const ml = require('../core/message_logic');

// ═════════════════════════════════════════════════════════════════
// §A — normalizeText
// ═════════════════════════════════════════════════════════════════

describe('T45 §A — normalizeText', () => {
  test('lowercase + sin acentos + sin especiales', () => {
    expect(ml.normalizeText('Hólá Mündo!')).toBe('hola mundo');
  });
  test('input null/undefined/empty → string vacío', () => {
    expect(ml.normalizeText(null)).toBe('');
    expect(ml.normalizeText(undefined)).toBe('');
    expect(ml.normalizeText('')).toBe('');
  });
  test('trim de espacios alrededor', () => {
    expect(ml.normalizeText('  hola  ')).toBe('hola');
  });
});

// ═════════════════════════════════════════════════════════════════
// §B — detectMiiaTrigger
// ═════════════════════════════════════════════════════════════════

describe('T45 §B — detectMiiaTrigger', () => {
  test('mensaje vacío → no trigger', () => {
    const r = ml.detectMiiaTrigger('   ');
    expect(r.trigger).toBe(false);
    expect(r.match).toBe('empty');
  });

  test('"miia" exacto → trigger high', () => {
    const r = ml.detectMiiaTrigger('hola miia');
    expect(r.trigger).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.match).toBe('miia_exact');
  });

  test('"mia" al inicio (texto) → vocative high', () => {
    const r = ml.detectMiiaTrigger('mia ayudame con esto');
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('mia_vocative_text');
  });

  test('"hola mia" (texto, vocativo) → high', () => {
    const r = ml.detectMiiaTrigger('hola mia');
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('mia_vocative_text');
  });

  test('"mia" en frase corta texto → medium', () => {
    const r = ml.detectMiiaTrigger('quiero verte mia');
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('mia_short_text');
  });

  test('"mia" en frase larga texto → no trigger (posesivo)', () => {
    const r = ml.detectMiiaTrigger('esa cartera amarilla que vimos en la tienda es mia');
    expect(r.trigger).toBe(false);
    expect(r.match).toBe('mia_in_long_phrase');
  });

  test('audio "mia" vocativo corto → medium', () => {
    const r = ml.detectMiiaTrigger('mia ayudame', true);
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('audio_mia_vocative');
  });

  test('audio "mia" sin intent → no trigger', () => {
    const r = ml.detectMiiaTrigger('eso es mia', true);
    expect(r.trigger).toBe(false);
    expect(r.match).toBe('audio_mia_no_intent');
  });

  test('audio "mia" con imperativo + ?', () => {
    const r = ml.detectMiiaTrigger('mia podes ayudarme?', true);
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('audio_mia_vocative');
  });

  test('"ia" al inicio en frase corta → low trigger', () => {
    const r = ml.detectMiiaTrigger('ia escuchame');
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('ia_vocative_short');
  });

  test('"ia" en medio de frase → no trigger', () => {
    const r = ml.detectMiiaTrigger('busco una ia que me ayude con codigo java');
    expect(r.trigger).toBe(false);
    expect(r.match).toBe('ia_in_phrase');
  });

  test('texto sin trigger → no match', () => {
    const r = ml.detectMiiaTrigger('hola como estas');
    expect(r.trigger).toBe(false);
    expect(r.match).toBe('no_match');
  });
});

// ═════════════════════════════════════════════════════════════════
// §C — detectChauMiiaTrigger
// ═════════════════════════════════════════════════════════════════

describe('T45 §C — detectChauMiiaTrigger', () => {
  test('"chau miia" exacto → trigger', () => {
    expect(ml.detectChauMiiaTrigger('chau miia').trigger).toBe(true);
  });
  test('"chao mia" exacto → trigger', () => {
    expect(ml.detectChauMiiaTrigger('chao mia').trigger).toBe(true);
  });
  test('"adios miia" → trigger', () => {
    expect(ml.detectChauMiiaTrigger('adios miia').trigger).toBe(true);
  });
  test('"nos vemos miia" → trigger', () => {
    expect(ml.detectChauMiiaTrigger('nos vemos miia').trigger).toBe(true);
  });
  test('"gracias mia" (despedida + nombre, frase corta) → trigger', () => {
    const r = ml.detectChauMiiaTrigger('gracias mia');
    expect(r.trigger).toBe(true);
    expect(r.match).toBe('despedida_con_nombre');
  });
  test('"hola miia" → no trigger (no despedida)', () => {
    expect(ml.detectChauMiiaTrigger('hola miia').trigger).toBe(false);
  });
  test('"chau" sin nombre → no trigger', () => {
    expect(ml.detectChauMiiaTrigger('chau').trigger).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════
// §D — maybeAddTypo
// ═════════════════════════════════════════════════════════════════

describe('T45 §D — maybeAddTypo', () => {
  test('texto corto (<10 chars) → sin typo', () => {
    const out = ml.maybeAddTypo('hola');
    expect(out).toBe('hola');
  });
  test('texto largo eventualmente puede tener typo (probabilidad ~2%)', () => {
    // Forzando Math.random a < 0.02 → typo aplicado
    const orig = Math.random;
    Math.random = () => 0.01;
    const out = ml.maybeAddTypo('texto largo de prueba para typo');
    expect(out).not.toBe('texto largo de prueba para typo');
    expect(out.length).toBe('texto largo de prueba para typo'.length);
    Math.random = orig;
  });
  test('texto largo con random > 0.02 → sin cambio', () => {
    const orig = Math.random;
    Math.random = () => 0.5;
    const out = ml.maybeAddTypo('texto largo de prueba sin typo');
    expect(out).toBe('texto largo de prueba sin typo');
    Math.random = orig;
  });
});

// ═════════════════════════════════════════════════════════════════
// §E — isPotentialBot
// ═════════════════════════════════════════════════════════════════

describe('T45 §E — isPotentialBot', () => {
  test('"soy un bot" → true', () => {
    expect(ml.isPotentialBot('soy un bot')).toBe(true);
  });
  test('"asistente virtual" → true', () => {
    expect(ml.isPotentialBot('Hola, soy el asistente virtual de la empresa.')).toBe(true);
  });
  test('"powered by" → true', () => {
    expect(ml.isPotentialBot('Powered by ChatBot Pro')).toBe(true);
  });
  test('texto humano normal → false', () => {
    expect(ml.isPotentialBot('hola, queria saber del plan')).toBe(false);
  });
  test('input null/empty → false', () => {
    expect(ml.isPotentialBot(null)).toBe(false);
    expect(ml.isPotentialBot('')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════
// §F — isWithinScheduleConfig
// ═════════════════════════════════════════════════════════════════

describe('T45 §F — isWithinScheduleConfig', () => {
  test('config null → siempre activo', () => {
    expect(ml.isWithinScheduleConfig(null)).toBe(true);
  });
  test('alwaysOn=true → siempre activo', () => {
    expect(ml.isWithinScheduleConfig({ alwaysOn: true })).toBe(true);
  });
  test('activeDays sin día actual → false', () => {
    // Día actual en COT
    const cfg = { activeDays: [], startTime: '00:00', endTime: '23:59' };
    expect(ml.isWithinScheduleConfig(cfg)).toBe(false);
  });
  test('startTime/endTime cubriendo todo el día → true', () => {
    const cfg = { activeDays: [0,1,2,3,4,5,6], startTime: '00:00', endTime: '23:59' };
    expect(ml.isWithinScheduleConfig(cfg)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════
// §G — getCountryFromPhone (T44 fix DO)
// ═════════════════════════════════════════════════════════════════

describe('T45 §G — getCountryFromPhone', () => {
  test.each([
    ['+573054169969', 'CO'],
    ['+5491164431700', 'AR'],
    ['+525512345678', 'MX'],
    ['+56987654321', 'CL'],
    ['+51987654321', 'PE'],
    ['+593991234567', 'EC'],
    ['+5511987654321', 'BR'],
    ['+447911123456', 'GB'],
    ['+61412345678', 'AU'],
    ['+18095551234', 'DO'],   // T44 fix
    ['+18295551234', 'DO'],   // T44 fix
    ['+18495551234', 'DO'],   // T44 fix
    ['+12025551234', 'US'],
    ['+34611123456', 'ES'],
    ['+99999999', 'CO'],      // default fallback
  ])('phone %s → cc %s', (phone, expected) => {
    expect(ml.getCountryFromPhone(phone)).toBe(expected);
  });
});

// ═════════════════════════════════════════════════════════════════
// §H — getTimezoneForCountry
// ═════════════════════════════════════════════════════════════════

describe('T45 §H — getTimezoneForCountry', () => {
  test.each([
    ['CO', 'America/Bogota'],
    ['AR', 'America/Argentina/Buenos_Aires'],
    ['MX', 'America/Mexico_City'],
    ['CL', 'America/Santiago'],
    ['PE', 'America/Lima'],
    ['EC', 'America/Guayaquil'],
    ['US', 'America/New_York'],
    ['ES', 'Europe/Madrid'],
    ['BR', 'America/Sao_Paulo'],
    ['GB', 'Europe/London'],
    ['AU', 'Australia/Sydney'],
    ['DO', 'America/Santo_Domingo'],   // T44 fix
    ['ZZ', 'America/Bogota'],          // fallback
  ])('country %s → tz %s', (country, expected) => {
    expect(ml.getTimezoneForCountry(country)).toBe(expected);
  });
});

// ═════════════════════════════════════════════════════════════════
// §I — getLangFromCountry (T40+T44)
// ═════════════════════════════════════════════════════════════════

describe('T45 §I — getLangFromCountry', () => {
  test('US → en/en_us', () => {
    const r = ml.getLangFromCountry('US');
    expect(r.lang).toBe('en');
    expect(r.dialect).toBe('en_us');
  });
  test('BR → pt/pt_br', () => {
    const r = ml.getLangFromCountry('BR');
    expect(r.lang).toBe('pt');
    expect(r.dialect).toBe('pt_br');
  });
  test('AR → es/es_ar tuteo=vos', () => {
    const r = ml.getLangFromCountry('AR');
    expect(r.lang).toBe('es');
    expect(r.tuteo).toBe('vos');
  });
  test('DO → es/es_do (T44 fix)', () => {
    const r = ml.getLangFromCountry('DO');
    expect(r.lang).toBe('es');
    expect(r.dialect).toBe('es_do');
  });
  test('ZZ desconocido → fallback es_co', () => {
    const r = ml.getLangFromCountry('ZZ');
    expect(r.lang).toBe('es');
    expect(r.dialect).toBe('es_co');
  });
});

// ═════════════════════════════════════════════════════════════════
// §J — buildLangInstruction
// ═════════════════════════════════════════════════════════════════

describe('T45 §J — buildLangInstruction', () => {
  test('lang=es → string vacío', () => {
    expect(ml.buildLangInstruction({ lang: 'es' })).toBe('');
  });
  test('lang=en → MANDATORY ENGLISH', () => {
    const out = ml.buildLangInstruction({ lang: 'en' });
    expect(out).toContain('MANDATORY LANGUAGE');
    expect(out).toContain('English');
  });
  test('lang=pt → IDIOMA OBRIGATORIO Portugues', () => {
    const out = ml.buildLangInstruction({ lang: 'pt' });
    expect(out).toContain('IDIOMA OBRIGATORIO');
    expect(out).toContain('Portugues');
  });
  test('langInfo null/undefined → string vacío', () => {
    expect(ml.buildLangInstruction(null)).toBe('');
    expect(ml.buildLangInstruction(undefined)).toBe('');
  });
  test('lang desconocido → string vacío', () => {
    expect(ml.buildLangInstruction({ lang: 'fr' })).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════
// §K — getCountryContext (T44 Capa B)
// ═════════════════════════════════════════════════════════════════

describe('T45 §K — getCountryContext (T44 Capa B)', () => {
  test('CO → ES sin prefix lang', () => {
    const ctx = ml.getCountryContext('573054169969');
    expect(ctx).toContain('COLOMBIA');
    expect(ctx).not.toMatch(/^MANDATORY|^IDIOMA/);
  });
  test('AR → ES + voseo', () => {
    const ctx = ml.getCountryContext('5491164431700');
    expect(ctx).toContain('ARGENTINA');
    expect(ctx).toContain('VOS');
  });
  test('BR → PT prefix + texto portugues', () => {
    const ctx = ml.getCountryContext('5511987654321');
    expect(ctx).toMatch(/^IDIOMA OBRIGATORIO/);
    expect(ctx).toContain('BRASIL');
    expect(ctx).toContain('VOCE');
  });
  test('US → EN prefix + texto ingles', () => {
    const ctx = ml.getCountryContext('14155551234');
    expect(ctx).toMatch(/^MANDATORY LANGUAGE/);
    expect(ctx).toContain('USA');
  });
  test('GB → EN prefix + currency GBP', () => {
    const ctx = ml.getCountryContext('447911123456');
    expect(ctx).toMatch(/^MANDATORY LANGUAGE/);
    expect(ctx).toContain('UK');
    expect(ctx).toContain('GBP');
  });
  test('AU → EN prefix + currency AUD', () => {
    const ctx = ml.getCountryContext('61412345678');
    expect(ctx).toMatch(/^MANDATORY LANGUAGE/);
    expect(ctx).toContain('AUSTRALIA');
    expect(ctx).toContain('AUD');
  });
  test('DO 1809 → ES (T44 fix legacy)', () => {
    const ctx = ml.getCountryContext('18091234567');
    expect(ctx).not.toMatch(/^MANDATORY/);
    expect(ctx).toContain('REPUBLICA_DOMINICANA');
  });
  test('MX → ES + IVA 16%', () => {
    const ctx = ml.getCountryContext('525512345678');
    expect(ctx).toContain('MEXICO');
    expect(ctx).toContain('IVA 16%');
  });
  test('ES → ES + EUR', () => {
    const ctx = ml.getCountryContext('34611123456');
    expect(ctx).toContain('ESPAÑA');
    expect(ctx).toContain('EUR');
  });
  test('CL → ES + CLP', () => {
    const ctx = ml.getCountryContext('56987654321');
    expect(ctx).toContain('CHILE');
    expect(ctx).toContain('CLP');
  });
  test('phone desconocido → INTERNACIONAL (countryCode 99 cae al default)', () => {
    const ctx = ml.getCountryContext('999999999999');
    expect(ctx).toContain('INTERNACIONAL');
  });
});

// ═════════════════════════════════════════════════════════════════
// §T — processLearningTags (cubre lines 477-680 aprox)
// ═════════════════════════════════════════════════════════════════

describe('T45 §T — processLearningTags', () => {
  function mkCtx(overrides = {}) {
    return {
      uid: 'uid_test',
      ownerUid: 'uid_test',
      role: 'owner',
      isOwner: true,
      contactName: 'Test',
      contactPhone: '+57123',
      ...overrides,
    };
  }
  function mkCallbacks() {
    return {
      saveBusinessLearning: jest.fn().mockResolvedValue(true),
      savePersonalLearning: jest.fn().mockResolvedValue(true),
      queueDubiousLearning: jest.fn().mockResolvedValue(true),
      createLearningApproval: jest.fn().mockResolvedValue({ key: 'ABC123', expiresAt: new Date() }),
      notifyOwner: jest.fn().mockResolvedValue(true),
      markApprovalApplied: jest.fn().mockResolvedValue(true),
    };
  }

  test('owner + APRENDIZAJE_NEGOCIO → guarda directo', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    const r = await ml.processLearningTags('hola [APRENDIZAJE_NEGOCIO:dato] resto', ctx, cb);
    expect(cb.saveBusinessLearning).toHaveBeenCalledWith('uid_test', 'dato', 'MIIA_AUTO_owner');
    expect(r.cleanMessage).not.toContain('APRENDIZAJE_NEGOCIO');
  });

  test('admin + GUARDAR_APRENDIZAJE legacy → trata como negocio', async () => {
    const ctx = mkCtx({ role: 'admin', isOwner: false });
    const cb = mkCallbacks();
    await ml.processLearningTags('[GUARDAR_APRENDIZAJE:dato_legacy]', ctx, cb);
    expect(cb.saveBusinessLearning).toHaveBeenCalledWith('uid_test', 'dato_legacy', 'MIIA_AUTO_admin');
  });

  test('agent con learningKeyValid → guarda directo + marca approval', async () => {
    const ctx = mkCtx({
      role: 'agent', isOwner: false, ownerUid: 'owner_uid',
      learningKeyValid: true, approvalDocRef: 'doc_ref',
    });
    const cb = mkCallbacks();
    await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:dato_agent]', ctx, cb);
    expect(cb.saveBusinessLearning).toHaveBeenCalledWith('owner_uid', 'dato_agent', 'MIIA_APPROVED_agent');
    expect(cb.markApprovalApplied).toHaveBeenCalledWith('doc_ref');
  });

  test('agent sin clave → solicita aprobación dinámica', async () => {
    const ctx = mkCtx({
      role: 'agent', isOwner: false, ownerUid: 'owner_uid', learningKeyValid: false,
    });
    const cb = mkCallbacks();
    const r = await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:cambio_propuesto]', ctx, cb);
    expect(cb.createLearningApproval).toHaveBeenCalled();
    expect(cb.notifyOwner).toHaveBeenCalled();
    expect(r.pendingQuestions.length).toBe(1);
  });

  test('lead con APRENDIZAJE_NEGOCIO → BLOQUEADO + notifyOwner', async () => {
    const ctx = mkCtx({ role: 'lead', isOwner: false });
    const cb = mkCallbacks();
    await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:intento_malicioso]', ctx, cb);
    expect(cb.saveBusinessLearning).not.toHaveBeenCalled();
    expect(cb.notifyOwner).toHaveBeenCalled();
  });

  test('owner + APRENDIZAJE_PERSONAL → guarda en personal', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    await ml.processLearningTags('[APRENDIZAJE_PERSONAL:gusto_personal]', ctx, cb);
    expect(cb.savePersonalLearning).toHaveBeenCalledWith('uid_test', 'gusto_personal', 'MIIA_AUTO_owner');
  });

  test('lead con APRENDIZAJE_PERSONAL → BLOQUEADO', async () => {
    const ctx = mkCtx({ role: 'lead', isOwner: false });
    const cb = mkCallbacks();
    await ml.processLearningTags('[APRENDIZAJE_PERSONAL:dato_lead]', ctx, cb);
    expect(cb.savePersonalLearning).not.toHaveBeenCalled();
  });

  test('APRENDIZAJE_DUDOSO → encola para aprobación', async () => {
    const ctx = mkCtx({ role: 'family', isOwner: false, ownerUid: 'owner_uid' });
    const cb = mkCallbacks();
    const r = await ml.processLearningTags('[APRENDIZAJE_DUDOSO:dato_dudoso]', ctx, cb);
    expect(cb.queueDubiousLearning).toHaveBeenCalledWith('owner_uid', 'uid_test', 'dato_dudoso');
    expect(r.pendingQuestions.length).toBe(1);
  });

  test('GUARDAR_NOTA con role owner → guarda como nota', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    await ml.processLearningTags('[GUARDAR_NOTA:nota_test]', ctx, cb);
    expect(cb.saveBusinessLearning).toHaveBeenCalledWith('uid_test', '[NOTA] nota_test', 'MIIA_NOTA_owner');
  });

  test('lead con GUARDAR_NOTA → BLOQUEADO', async () => {
    const ctx = mkCtx({ role: 'lead', isOwner: false });
    const cb = mkCallbacks();
    await ml.processLearningTags('[GUARDAR_NOTA:nota_malicia]', ctx, cb);
    expect(cb.saveBusinessLearning).not.toHaveBeenCalled();
  });

  test('mensaje sin tags → no callbacks', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    const r = await ml.processLearningTags('hola sin tags', ctx, cb);
    expect(cb.saveBusinessLearning).not.toHaveBeenCalled();
    expect(cb.savePersonalLearning).not.toHaveBeenCalled();
    expect(r.cleanMessage).toBe('hola sin tags');
    expect(r.pendingQuestions).toEqual([]);
  });

  test('error en saveBusinessLearning → log + continua', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    cb.saveBusinessLearning = jest.fn().mockRejectedValue(new Error('firestore down'));
    const r = await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:dato]', ctx, cb);
    // No throw — error logueado y se continua
    expect(r.cleanMessage).not.toContain('APRENDIZAJE_NEGOCIO');
  });

  test('agent sin createLearningApproval → fallback a queueDubiousLearning', async () => {
    const ctx = mkCtx({
      role: 'agent', isOwner: false, ownerUid: 'owner_uid', learningKeyValid: false,
    });
    const cb = mkCallbacks();
    delete cb.createLearningApproval;
    await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:fallback_test]', ctx, cb);
    expect(cb.queueDubiousLearning).toHaveBeenCalled();
  });

  test('agent learningKeyValid + saveBusinessLearning rechazado → log error sin throw', async () => {
    const ctx = mkCtx({ role: 'agent', isOwner: false, ownerUid: 'o', learningKeyValid: true });
    const cb = mkCallbacks();
    cb.saveBusinessLearning = jest.fn().mockRejectedValue(new Error('fs error'));
    const r = await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:dato]', ctx, cb);
    expect(r.cleanMessage).not.toContain('APRENDIZAJE');
  });

  test('agent sin clave + createLearningApproval rechazado → log error sin throw', async () => {
    const ctx = mkCtx({ role: 'agent', isOwner: false, ownerUid: 'o', learningKeyValid: false });
    const cb = mkCallbacks();
    cb.createLearningApproval = jest.fn().mockRejectedValue(new Error('approval err'));
    await ml.processLearningTags('[APRENDIZAJE_NEGOCIO:x]', ctx, cb);
    // No throw
  });

  test('savePersonalLearning rechazado → log error sin throw', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    cb.savePersonalLearning = jest.fn().mockRejectedValue(new Error('p err'));
    await ml.processLearningTags('[APRENDIZAJE_PERSONAL:x]', ctx, cb);
  });

  test('queueDubiousLearning rechazado en DUDOSO → log error sin throw', async () => {
    const ctx = mkCtx({ role: 'family', isOwner: false, ownerUid: 'o' });
    const cb = mkCallbacks();
    cb.queueDubiousLearning = jest.fn().mockRejectedValue(new Error('q err'));
    await ml.processLearningTags('[APRENDIZAJE_DUDOSO:x]', ctx, cb);
  });

  test('saveBusinessLearning para nota rechazado → log error sin throw', async () => {
    const ctx = mkCtx({ role: 'owner', isOwner: true });
    const cb = mkCallbacks();
    cb.saveBusinessLearning = jest.fn().mockRejectedValue(new Error('nota err'));
    await ml.processLearningTags('[GUARDAR_NOTA:x]', ctx, cb);
  });
});

// ═════════════════════════════════════════════════════════════════
// §U — processAgendaTag (lines 655-734)
// ═════════════════════════════════════════════════════════════════

describe('T45 §U — processAgendaTag', () => {
  test('mensaje sin tag → sin cambios', async () => {
    const saveEvent = jest.fn();
    const r = await ml.processAgendaTag('hola sin tag', { role: 'owner', uid: 'u' }, saveEvent, {}, null);
    expect(r).toBe('hola sin tag');
    expect(saveEvent).not.toHaveBeenCalled();
  });

  test('tag con phone valido + sin Calendar → guarda en Firestore', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const ctx = { role: 'owner', uid: 'u', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15T10:00|Reunion test|hint test|presencial|oficina]';
    const r = await ml.processAgendaTag(tag, ctx, saveEvent, {}, null);
    expect(saveEvent).toHaveBeenCalledTimes(1);
    expect(saveEvent.mock.calls[0][0]).toBe('u');
    expect(saveEvent.mock.calls[0][1].reason).toBe('Reunion test');
    expect(saveEvent.mock.calls[0][1].contactPhone).toBe('573054169969');
    expect(r).toBe('');
  });

  test('tag con contacto-nombre (no phone) en self-chat → resolvedPhone=self', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const ctx = { role: 'owner', uid: 'u', isSelfChat: true };
    const tag = '[AGENDAR_EVENTO:Mariano|2026-05-15|Cumple papa|hint]';
    await ml.processAgendaTag(tag, ctx, saveEvent, {}, null);
    expect(saveEvent.mock.calls[0][1].contactPhone).toBe('self');
  });

  test('agent role → targetUid = ownerUid', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const ctx = { role: 'agent', uid: 'agent_uid', ownerUid: 'owner_uid', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15T10:00|Test]';
    await ml.processAgendaTag(tag, ctx, saveEvent, {}, null);
    expect(saveEvent.mock.calls[0][0]).toBe('owner_uid');
  });

  test('Calendar disponible + fecha valida → llama createCalendarEvent', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const createCalendarEvent = jest.fn().mockResolvedValue({ eventId: 'cal123', meetLink: 'https://meet.example' });
    const getTimezone = jest.fn().mockResolvedValue('America/Bogota');
    const ctx = { role: 'owner', uid: 'u', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15T14:30|Reunion|hint|presencial|oficina]';
    await ml.processAgendaTag(tag, ctx, saveEvent, {}, { createCalendarEvent, getTimezone });
    expect(createCalendarEvent).toHaveBeenCalled();
    expect(saveEvent.mock.calls[0][1].calendarSynced).toBe(true);
    expect(saveEvent.mock.calls[0][1].meetLink).toBe('https://meet.example');
  });

  test('Calendar createEvent rechaza → calendarOk=false pero saveEvent igual corre', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const createCalendarEvent = jest.fn().mockRejectedValue(new Error('cal down'));
    const ctx = { role: 'owner', uid: 'u', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15T10:00|Test]';
    await ml.processAgendaTag(tag, ctx, saveEvent, {}, { createCalendarEvent });
    expect(saveEvent).toHaveBeenCalled();
    expect(saveEvent.mock.calls[0][1].calendarSynced).toBe(false);
  });

  test('saveEvent rechaza → log error sin throw', async () => {
    const saveEvent = jest.fn().mockRejectedValue(new Error('fs down'));
    const ctx = { role: 'owner', uid: 'u', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15T10:00|Test]';
    const r = await ml.processAgendaTag(tag, ctx, saveEvent, {}, null);
    expect(r).toBe(''); // tag igual se limpia
  });

  test('parts.length < 3 → ignora tag pero limpia', async () => {
    const saveEvent = jest.fn();
    const ctx = { role: 'owner', uid: 'u' };
    const tag = '[AGENDAR_EVENTO:solo|dos]';
    const r = await ml.processAgendaTag(tag, ctx, saveEvent, {}, null);
    expect(saveEvent).not.toHaveBeenCalled();
    expect(r).toBe('');
  });

  test('razon contiene "deporte" → searchBefore=true', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const ctx = { role: 'owner', uid: 'u', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15|Partido de futbol deporte]';
    await ml.processAgendaTag(tag, ctx, saveEvent, {}, null);
    expect(saveEvent.mock.calls[0][1].searchBefore).toBe(true);
  });

  test('leadNames resuelve contactName desde JID', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const ctx = { role: 'owner', uid: 'u' };
    const leadNames = { '573054169969@s.whatsapp.net': 'Juan Perez' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15|Test]';
    await ml.processAgendaTag(tag, ctx, saveEvent, leadNames, null);
    expect(saveEvent.mock.calls[0][1].contactName).toBe('Juan Perez');
  });

  test('eventMode=telefono → phoneNumber se setea', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const createCalendarEvent = jest.fn().mockResolvedValue({});
    const ctx = { role: 'owner', uid: 'u', basePhone: '573054169969' };
    const tag = '[AGENDAR_EVENTO:573054169969|2026-05-15T11:00|Llamada|hint|telefono|+5712345]';
    await ml.processAgendaTag(tag, ctx, saveEvent, {}, { createCalendarEvent });
    expect(createCalendarEvent.mock.calls[0][0].phoneNumber).toBe('+5712345');
  });
});

// ═════════════════════════════════════════════════════════════════
// §L — isFollowUpBlocked
// ═════════════════════════════════════════════════════════════════

describe('T45 §L — isFollowUpBlocked', () => {
  test('retorna string o null (cualquier phone)', () => {
    const r = ml.isFollowUpBlocked('+573054169969');
    // Resultado depende del día/hora actual — solo verifico tipo
    expect(r === null || typeof r === 'string').toBe(true);
  });
  test('phone US (festivo 01-01) puede o no estar bloqueado por día actual', () => {
    const r = ml.isFollowUpBlocked('+12025551234');
    expect(r === null || typeof r === 'string').toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════
// §M — calcBusinessDaysMs
// ═════════════════════════════════════════════════════════════════

describe('T45 §M — calcBusinessDaysMs', () => {
  test('1 día hábil para CO → ms positivo', () => {
    const ms = ml.calcBusinessDaysMs(1, '+573054169969');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10 * 24 * 60 * 60 * 1000); // <10 días
  });
  test('3 días hábiles > 1 día hábil', () => {
    const ms1 = ml.calcBusinessDaysMs(1, '+573054169969');
    const ms3 = ml.calcBusinessDaysMs(3, '+573054169969');
    expect(ms3).toBeGreaterThan(ms1);
  });
});

// ═════════════════════════════════════════════════════════════════
// §N — detectNegativeSentiment
// ═════════════════════════════════════════════════════════════════

describe('T45 §N — detectNegativeSentiment', () => {
  test('insulto "idiota" → type=insulto', () => {
    const r = ml.detectNegativeSentiment('eres un idiota');
    expect(r.type).toBe('insulto');
    expect(typeof r.response).toBe('string');
  });
  test('queja "no funciona" → type=queja', () => {
    const r = ml.detectNegativeSentiment('esto no funciona para nada');
    expect(r.type).toBe('queja');
    expect(typeof r.response).toBe('string');
  });
  test('texto neutral → null', () => {
    const r = ml.detectNegativeSentiment('hola, quiero info');
    expect(r.type).toBeNull();
    expect(r.response).toBeNull();
  });
  test('input null/empty → null', () => {
    expect(ml.detectNegativeSentiment(null).type).toBeNull();
    expect(ml.detectNegativeSentiment('').type).toBeNull();
  });
  test('insulto + queja → tipo insulto (insulto se chequea primero)', () => {
    const r = ml.detectNegativeSentiment('eres un idiota y esto no funciona');
    expect(r.type).toBe('insulto');
  });
});

// ═════════════════════════════════════════════════════════════════
// §O — isOptOut
// ═════════════════════════════════════════════════════════════════

describe('T45 §O — isOptOut', () => {
  test('"baja" → true', () => {
    expect(ml.isOptOut('quiero la baja')).toBe(true);
  });
  test('"no me interesa" → true', () => {
    expect(ml.isOptOut('no me interesa eso')).toBe(true);
  });
  test('"unsubscribe" → true', () => {
    expect(ml.isOptOut('Please unsubscribe me')).toBe(true);
  });
  test('texto neutral → false', () => {
    expect(ml.isOptOut('hola buenos dias')).toBe(false);
  });
  test('input null/empty → false', () => {
    expect(ml.isOptOut(null)).toBe(false);
    expect(ml.isOptOut('')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════
// §P — splitMessage
// ═════════════════════════════════════════════════════════════════

describe('T45 §P — splitMessage', () => {
  test('mensaje sin [MSG_SPLIT] → null', () => {
    expect(ml.splitMessage('hola mundo')).toBeNull();
  });
  test('mensaje con un split → 2 partes', () => {
    const out = ml.splitMessage('parte 1[MSG_SPLIT]parte 2');
    expect(out).toEqual(['parte 1', 'parte 2']);
  });
  test('mensaje con dos splits → 3 partes', () => {
    const out = ml.splitMessage('a[MSG_SPLIT]b[MSG_SPLIT]c');
    expect(out).toEqual(['a', 'b', 'c']);
  });
  test('partes vacías se filtran', () => {
    const out = ml.splitMessage('a[MSG_SPLIT]   [MSG_SPLIT]b');
    expect(out).toEqual(['a', 'b']);
  });
});

// ═════════════════════════════════════════════════════════════════
// §Q — cleanResidualTags
// ═════════════════════════════════════════════════════════════════

describe('T45 §Q — cleanResidualTags', () => {
  test('elimina [GENERAR_COTIZACION_PDF:...]', () => {
    const out = ml.cleanResidualTags('hola [GENERAR_COTIZACION_PDF:abc] mundo');
    expect(out).toBe('hola  mundo');
  });
  test('elimina [GENERAR_COTIZACION:...]', () => {
    const out = ml.cleanResidualTags('hola [GENERAR_COTIZACION:abc] mundo');
    expect(out).toBe('hola  mundo');
  });
  test('elimina [LEAD_QUIERE_COMPRAR]', () => {
    const out = ml.cleanResidualTags('quiero [LEAD_QUIERE_COMPRAR] comprar');
    expect(out).toBe('quiero  comprar');
  });
  test('elimina tag inventado por IA (universal stripper)', () => {
    const out = ml.cleanResidualTags('hola [TAG_INVENTADO:foo] mundo');
    expect(out).toBe('hola  mundo');
  });
  test('elimina [APRENDIZAJE_NEGOCIO:...]', () => {
    const out = ml.cleanResidualTags('[APRENDIZAJE_NEGOCIO:dato] resto');
    expect(out).toBe('resto');
  });
  test('texto sin tags → preservado', () => {
    expect(ml.cleanResidualTags('hola mundo')).toBe('hola mundo');
  });
});

// ═════════════════════════════════════════════════════════════════
// §R — processSubscriptionTag
// ═════════════════════════════════════════════════════════════════

describe('T45 §R — processSubscriptionTag', () => {
  test('mensaje sin tag → sin cambios', () => {
    const state = {};
    const out = ml.processSubscriptionTag('hola', '+57123', state);
    expect(out).toBe('hola');
    expect(state['+57123']).toBeUndefined();
  });
  test('mensaje con tag → marca interesado y limpia tag', () => {
    const state = {};
    const out = ml.processSubscriptionTag('hola [LEAD_QUIERE_COMPRAR] resto', '+57123', state);
    expect(out).toBe('hola  resto');
    expect(state['+57123']).toBeDefined();
    expect(state['+57123'].estado).toBe('asked');
  });
  test('phone con estado existente !== none → no sobrescribe', () => {
    const state = { '+57123': { estado: 'pending', data: { x: 1 } } };
    ml.processSubscriptionTag('[LEAD_QUIERE_COMPRAR]', '+57123', state);
    expect(state['+57123'].estado).toBe('pending');
  });
});

// ═════════════════════════════════════════════════════════════════
// §S — Constantes exportadas
// ═════════════════════════════════════════════════════════════════

describe('T45 §S — Constantes exportadas', () => {
  test('MIIA_CIERRE incluye triggers', () => {
    expect(ml.MIIA_CIERRE).toContain('HOLA MIIA');
    expect(ml.MIIA_CIERRE).toContain('CHAU MIIA');
  });
  test('HOLIDAYS_BY_COUNTRY tiene CO/AR/MX', () => {
    expect(ml.HOLIDAYS_BY_COUNTRY.CO.length).toBeGreaterThan(0);
    expect(ml.HOLIDAYS_BY_COUNTRY.AR.length).toBeGreaterThan(0);
    expect(ml.HOLIDAYS_BY_COUNTRY.MX.length).toBeGreaterThan(0);
  });
  test('INSULT_KEYWORDS array no vacío', () => {
    expect(Array.isArray(ml.INSULT_KEYWORDS)).toBe(true);
    expect(ml.INSULT_KEYWORDS.length).toBeGreaterThan(0);
  });
  test('OPT_OUT_KEYWORDS array no vacío', () => {
    expect(Array.isArray(ml.OPT_OUT_KEYWORDS)).toBe(true);
    expect(ml.OPT_OUT_KEYWORDS.length).toBeGreaterThan(0);
  });
  test('MSG_SUSCRIPCION es string no vacío', () => {
    expect(typeof ml.MSG_SUSCRIPCION).toBe('string');
    expect(ml.MSG_SUSCRIPCION.length).toBeGreaterThan(20);
  });
});
