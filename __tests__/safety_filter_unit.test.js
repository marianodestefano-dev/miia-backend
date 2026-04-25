'use strict';

/**
 * Tests unit safety_filter — C-410.b Cimientos §3 C.10 / Mitigación C.
 *
 * Cobertura:
 *  §1 Luhn validation helper
 *  §2 classifyMessageSensitivity — 5 categorías × positive + negative
 *  §3 isSafetyFilterEnabledForUid + getCategoryConfig (Firestore mock)
 *  §4 shouldAlertOwner throttle 24h
 *  §5 recordSafetyIncident estructura completa
 *  §6 ensureBootstrap idempotente + lock + skip env flag
 *  §7 helpers _hashMessage / _redactPhone / addExclusionInternal
 *
 * Mock firebase-admin (NO red, NO IO real).
 */

// ─── Mock firebase-admin ANTES de require safety_filter ────────────────
jest.mock('firebase-admin', () => {
  const setMock = jest.fn().mockResolvedValue();
  const addMock = jest.fn();
  const getMock = jest.fn();

  const docRef = {
    set: setMock,
    get: getMock,
    collection: jest.fn(() => ({
      add: addMock,
      doc: jest.fn(() => docRef),
    })),
  };

  const colRef = {
    doc: jest.fn(() => docRef),
    add: addMock,
  };

  return {
    app: jest.fn(() => ({ name: 'test-app' })),
    firestore: jest.fn(() => ({
      collection: jest.fn(() => colRef),
    })),
    __mocks: { setMock, addMock, getMock },
  };
});

const admin = require('firebase-admin');
const sf = require('../core/safety_filter');
const consentRoutes = require('../routes/consent');

beforeEach(() => {
  Object.values(admin.__mocks).forEach((m) => m.mockReset && m.mockReset());
  admin.__mocks.setMock.mockResolvedValue();
  admin.__mocks.addMock.mockReset();
  sf._resetCaches();
  delete process.env.SAFETY_FILTER_SKIP_BOOTSTRAP;
});

// ════════════════════════════════════════════════════════════════════════
// §1 — Luhn validation
// ════════════════════════════════════════════════════════════════════════

describe('§1 _passesLuhn', () => {
  test('Visa válida (4532015112830366)', () => {
    expect(sf._passesLuhn('4532015112830366')).toBe(true);
  });
  test('Mastercard válida (5425233430109903)', () => {
    expect(sf._passesLuhn('5425233430109903')).toBe(true);
  });
  test('AmEx válida (374245455400126)', () => {
    expect(sf._passesLuhn('374245455400126')).toBe(true);
  });
  test('rechaza secuencia inválida (1234567890123456)', () => {
    expect(sf._passesLuhn('1234567890123456')).toBe(false);
  });
  test('rechaza muy corto', () => {
    expect(sf._passesLuhn('123')).toBe(false);
  });
  test('rechaza muy largo (>19)', () => {
    expect(sf._passesLuhn('12345678901234567890')).toBe(false);
  });
  test('rechaza null/empty', () => {
    expect(sf._passesLuhn(null)).toBe(false);
    expect(sf._passesLuhn('')).toBe(false);
    expect(sf._passesLuhn(undefined)).toBe(false);
  });
  test('acepta espacios y guiones', () => {
    expect(sf._passesLuhn('4532-0151-1283-0366')).toBe(true);
    expect(sf._passesLuhn('4532 0151 1283 0366')).toBe(true);
  });
  test('rechaza EAN-13 barcode (no es tarjeta)', () => {
    // EAN-13 con checksum válido propio pero no Luhn
    expect(sf._passesLuhn('0123456789012')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 — classifyMessageSensitivity (5 categorías)
// ════════════════════════════════════════════════════════════════════════

describe('§2 classifyMessageSensitivity', () => {
  describe('Salud', () => {
    test('match diagnóstico', () => {
      const r = sf.classifyMessageSensitivity('Necesito un diagnóstico médico urgente');
      expect(r?.category).toBe('salud');
      expect(r?.severity).toBe('ALTA');
    });
    test('match psicólogo (con tilde)', () => {
      const r = sf.classifyMessageSensitivity('Voy al psicólogo el viernes');
      expect(r?.category).toBe('salud');
    });
    test('match psicóloga (variante femenina)', () => {
      const r = sf.classifyMessageSensitivity('Mi psicóloga me dijo');
      expect(r?.category).toBe('salud');
    });
    test('match medicación', () => {
      const r = sf.classifyMessageSensitivity('Necesito tomar la medicación a tiempo');
      expect(r?.category).toBe('salud');
    });
    test('NO matchea texto sin palabras clave', () => {
      const r = sf.classifyMessageSensitivity('Hola, ¿cómo va el negocio?');
      expect(r).toBeNull();
    });
    test('NO matchea "diaño" (no es palabra trigger)', () => {
      const r = sf.classifyMessageSensitivity('día normal');
      expect(r).toBeNull();
    });
  });

  describe('Finanzas', () => {
    test('match keyword "número de tarjeta"', () => {
      const r = sf.classifyMessageSensitivity('Mi número de tarjeta es 4532...');
      expect(r?.category).toBe('finanzas');
    });
    test('match CVV', () => {
      const r = sf.classifyMessageSensitivity('CVV 123');
      expect(r?.category).toBe('finanzas');
    });
    test('match IBAN', () => {
      const r = sf.classifyMessageSensitivity('Mi IBAN es ES12...');
      expect(r?.category).toBe('finanzas');
    });
    test('match keyword tarjeta + Visa Luhn-válida', () => {
      const r = sf.classifyMessageSensitivity('Mi tarjeta es 4532015112830366');
      expect(r?.category).toBe('finanzas');
      expect(r?.regexMatch).toBe('card_kw_plus_luhn');
    });
    test('NO match secuencia 16 dígitos sin keyword (tracking limpio)', () => {
      const r = sf.classifyMessageSensitivity('Llegó el envío 1234567890123456');
      expect(r).toBeNull();
    });
    test('NO match IMEI sin keyword tarjeta/cuenta', () => {
      // IMEIs cumplen Luhn por diseño, pero sin keyword "tarjeta/cuenta" cerca → no dispara
      const r = sf.classifyMessageSensitivity('IMEI 358240051111110');
      expect(r).toBeNull();
    });
    test('NO match keyword "tarjeta" + número NO-Luhn (false positive evitado)', () => {
      const r = sf.classifyMessageSensitivity('Mi tarjeta de cliente es 1234567890123456');
      expect(r).toBeNull(); // keyword presente pero Luhn fail
    });
  });

  describe('Judicial', () => {
    test('match abogado → MEDIA severidad', () => {
      const r = sf.classifyMessageSensitivity('Estoy hablando con mi abogado');
      expect(r?.category).toBe('judicial');
      expect(r?.severity).toBe('MEDIA');
    });
    test('match juicio → MEDIA', () => {
      const r = sf.classifyMessageSensitivity('Tengo un juicio el lunes');
      expect(r?.category).toBe('judicial');
    });
    test('match violencia ESCALA a ALTA + regexMatch=violence_subpattern', () => {
      const r = sf.classifyMessageSensitivity('Es un caso de violencia familiar, abogado');
      expect(r?.category).toBe('judicial');
      expect(r?.severity).toBe('ALTA');
      expect(r?.regexMatch).toBe('violence_subpattern');
    });
    test('match amenaza + denuncia → ALTA', () => {
      const r = sf.classifyMessageSensitivity('Hay una amenaza, voy a hacer denuncia');
      expect(r?.severity).toBe('ALTA');
    });
    test('NO match "abogadito" (boundary \\b correcto)', () => {
      // \babogado\b NO matchea "abogadito" porque después de "abogado" no hay boundary
      const r = sf.classifyMessageSensitivity('Mi abogadito amigo');
      expect(r).toBeNull();
    });
  });

  describe('Menores', () => {
    test('match "menor de edad"', () => {
      const r = sf.classifyMessageSensitivity('Es menor de edad, no puede firmar');
      expect(r?.category).toBe('menores');
    });
    test('match "mi hijo de 10 años"', () => {
      const r = sf.classifyMessageSensitivity('Mi hijo de 10 años va al colegio');
      expect(r?.category).toBe('menores');
    });
    test('NO match "mi hijo trabaja conmigo" (sin edad)', () => {
      const r = sf.classifyMessageSensitivity('Mi hijo trabaja conmigo en el negocio');
      expect(r).toBeNull();
    });
  });

  describe('Credenciales', () => {
    test('match "password: secret123"', () => {
      const r = sf.classifyMessageSensitivity('Mi password: secret123abc');
      expect(r?.category).toBe('credenciales');
    });
    test('match "api_key=AKIA..."', () => {
      const r = sf.classifyMessageSensitivity('api_key=AKIAIOSFODNN7EXAMPLE');
      expect(r?.category).toBe('credenciales');
    });
    test('match AWS key explícita', () => {
      const r = sf.classifyMessageSensitivity('Mi key AKIAIOSFODNN7EXAMPLE');
      expect(r?.category).toBe('credenciales');
      expect(r?.regexMatch).toBe('api_key_pattern');
    });
    test('match Stripe sk_test_', () => {
      const r = sf.classifyMessageSensitivity('Token sk_test_abcdefghijklmnopqrstuvwxyz123');
      expect(r?.category).toBe('credenciales');
    });
    test('NO match "tengo la clave del baño"', () => {
      const r = sf.classifyMessageSensitivity('Tengo la clave');
      expect(r).toBeNull(); // necesita {6,} chars siguiendo a "clave"
    });
  });

  describe('Sin sensibilidad', () => {
    test('mensaje comercial limpio NO matchea', () => {
      const r = sf.classifyMessageSensitivity('Hola, vi tu publicidad de MIIA, me interesa probar');
      expect(r).toBeNull();
    });
    test('mensaje vacío retorna null', () => {
      expect(sf.classifyMessageSensitivity('')).toBeNull();
      expect(sf.classifyMessageSensitivity(null)).toBeNull();
      expect(sf.classifyMessageSensitivity(undefined)).toBeNull();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 — Config access (Firestore mock)
// ════════════════════════════════════════════════════════════════════════

describe('§3 isSafetyFilterEnabledForUid + getCategoryConfig', () => {
  test('isSafetyFilterEnabledForUid true cuando config.enabled=true', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ safety_filter_config: { enabled: true, categories: {} } }),
    });
    expect(await sf.isSafetyFilterEnabledForUid('uid_test')).toBe(true);
  });

  test('isSafetyFilterEnabledForUid false cuando owner no existe', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({ exists: false });
    expect(await sf.isSafetyFilterEnabledForUid('uid_unknown')).toBe(false);
  });

  test('isSafetyFilterEnabledForUid false cuando enabled missing', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({}),
    });
    expect(await sf.isSafetyFilterEnabledForUid('uid_no_config')).toBe(false);
  });

  test('getCategoryConfig retorna config existente', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        safety_filter_config: {
          enabled: true,
          categories: { salud: { enabled: true, action: 'log_warn' } },
        },
      }),
    });
    const cfg = await sf.getCategoryConfig('uid_x', 'salud');
    expect(cfg.enabled).toBe(true);
    expect(cfg.action).toBe('log_warn');
  });

  test('getCategoryConfig retorna disabled para categoría desconocida', async () => {
    const cfg = await sf.getCategoryConfig('uid_x', 'inventada');
    expect(cfg).toEqual({ enabled: false, action: 'disabled' });
  });

  test('cache TTL: segunda lectura usa cache (no llama Firestore otra vez)', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ safety_filter_config: { enabled: true, categories: {} } }),
    });
    await sf.isSafetyFilterEnabledForUid('uid_cache');
    await sf.isSafetyFilterEnabledForUid('uid_cache');
    expect(admin.__mocks.getMock).toHaveBeenCalledTimes(1);
  });

  test('Firestore error → fail-safe false', async () => {
    admin.__mocks.getMock.mockRejectedValueOnce(new Error('firestore down'));
    expect(await sf.isSafetyFilterEnabledForUid('uid_err')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §4 — Throttle anti-spam alert 24h
// ════════════════════════════════════════════════════════════════════════

describe('§4 shouldAlertOwner throttle', () => {
  test('primer call retorna true', () => {
    expect(sf.shouldAlertOwner('uid_a', '+57305', 'salud')).toBe(true);
  });

  test('segundo call para misma combinación retorna false', () => {
    sf.shouldAlertOwner('uid_a', '+57305', 'salud');
    expect(sf.shouldAlertOwner('uid_a', '+57305', 'salud')).toBe(false);
  });

  test('combinación distinta (otra category) retorna true', () => {
    sf.shouldAlertOwner('uid_a', '+57305', 'salud');
    expect(sf.shouldAlertOwner('uid_a', '+57305', 'finanzas')).toBe(true);
  });

  test('combinación distinta (otro phone) retorna true', () => {
    sf.shouldAlertOwner('uid_a', '+57305', 'salud');
    expect(sf.shouldAlertOwner('uid_a', '+57316', 'salud')).toBe(true);
  });

  test('resetAlertThrottle libera la dedup', () => {
    sf.shouldAlertOwner('uid_a', '+57305', 'salud');
    expect(sf.shouldAlertOwner('uid_a', '+57305', 'salud')).toBe(false);
    sf.resetAlertThrottle('uid_a', '+57305', 'salud');
    expect(sf.shouldAlertOwner('uid_a', '+57305', 'salud')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §5 — recordSafetyIncident estructura completa
// ════════════════════════════════════════════════════════════════════════

describe('§5 recordSafetyIncident', () => {
  test('crea doc con estructura completa + retorna incidentId', async () => {
    admin.__mocks.addMock.mockResolvedValueOnce({ id: 'inc_test_123' });
    const id = await sf.recordSafetyIncident(
      'uid_x',
      '+573054169969',
      { category: 'salud', regexMatch: 'diagnóstico', severity: 'ALTA' },
      'Necesito un diagnóstico para mi madre',
      'log_warn',
      'Lead Anónimo'
    );
    expect(id).toBe('inc_test_123');
    expect(admin.__mocks.addMock).toHaveBeenCalledTimes(1);
    const docArg = admin.__mocks.addMock.mock.calls[0][0];
    expect(docArg.phoneE164).toBe('+573054169969');
    expect(docArg.phoneRedacted).toBe('+57***9969');
    expect(docArg.contactName).toBe('Lead Anónimo');
    expect(docArg.category).toBe('salud');
    expect(docArg.action).toBe('log_warn');
    expect(docArg.messagePreview.length).toBeLessThanOrEqual(80);
    expect(docArg.messageHash).toMatch(/^[a-f0-9]{8}$/);
    expect(docArg.filterVersion).toBe(sf.FILTER_VERSION);
    expect(docArg.ownerActionTaken).toBeNull();
  });

  test('Firestore error → retorna null sin abortar', async () => {
    admin.__mocks.addMock.mockRejectedValueOnce(new Error('write failed'));
    const id = await sf.recordSafetyIncident(
      'uid_x', '+57305', { category: 'salud' }, 'msg', 'log_warn', 'X'
    );
    expect(id).toBeNull();
  });

  test('cap messagePreview a 80 chars', async () => {
    admin.__mocks.addMock.mockResolvedValueOnce({ id: 'inc_capped' });
    const longMsg = 'a'.repeat(500);
    await sf.recordSafetyIncident('uid_x', '+57305', { category: 'salud' }, longMsg, 'log_warn', 'X');
    const docArg = admin.__mocks.addMock.mock.calls[0][0];
    expect(docArg.messagePreview).toHaveLength(80);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §6 — ensureBootstrap idempotente + lock + skip
// ════════════════════════════════════════════════════════════════════════

describe('§6 ensureBootstrap', () => {
  test('aplica config si owner CENTER existe sin config', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({}),
    });
    const result = await sf.ensureBootstrap();
    expect(result.applied).toBe(true);
    expect(admin.__mocks.setMock).toHaveBeenCalledTimes(1);
    const setArg = admin.__mocks.setMock.mock.calls[0][0];
    expect(setArg.safety_filter_config).toEqual(sf.DEFAULT_CENTER_CONFIG);
    expect(setArg.safety_filter_bootstrap_at).toBeDefined();
  });

  test('skip si owner CENTER no existe', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({ exists: false });
    const result = await sf.ensureBootstrap();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_owner_doc');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('skip si lock=true', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ safety_filter_bootstrap_locked: true }),
    });
    const result = await sf.ensureBootstrap();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('locked');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('skip si ya configurado (no sobrescribe)', async () => {
    admin.__mocks.getMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ safety_filter_config: { enabled: true, categories: {} } }),
    });
    const result = await sf.ensureBootstrap();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already_configured');
    expect(admin.__mocks.setMock).not.toHaveBeenCalled();
  });

  test('skip si SAFETY_FILTER_SKIP_BOOTSTRAP=1', async () => {
    process.env.SAFETY_FILTER_SKIP_BOOTSTRAP = '1';
    const result = await sf.ensureBootstrap();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('env_flag');
    expect(admin.__mocks.getMock).not.toHaveBeenCalled();
    delete process.env.SAFETY_FILTER_SKIP_BOOTSTRAP;
  });

  test('Firestore error → skip con error info', async () => {
    admin.__mocks.getMock.mockRejectedValueOnce(new Error('firestore err'));
    const result = await sf.ensureBootstrap();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('error');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §7 — Helpers _hashMessage / _redactPhone + addExclusionInternal
// ════════════════════════════════════════════════════════════════════════

describe('§7 helpers', () => {
  test('_hashMessage retorna 8 hex chars', () => {
    const h = sf._hashMessage('hola mundo');
    expect(h).toMatch(/^[a-f0-9]{8}$/);
  });

  test('_hashMessage es determinista', () => {
    expect(sf._hashMessage('test')).toBe(sf._hashMessage('test'));
  });

  test('_redactPhone E.164 → +cc***last4', () => {
    expect(sf._redactPhone('+573054169969')).toBe('+57***9969');
    expect(sf._redactPhone('+5491164431700')).toBe('+54***1700');
  });

  test('_redactPhone fallback con phone vacío', () => {
    expect(sf._redactPhone('')).toBe('+***');
    expect(sf._redactPhone(null)).toBe('+***');
  });

  test('addExclusionInternal valida uid', async () => {
    const r = await consentRoutes.addExclusionInternal(null, '+57305', {});
    expect(r.error).toBe('invalid_uid');
  });

  test('addExclusionInternal valida phone', async () => {
    const r = await consentRoutes.addExclusionInternal('uid', '123', {});
    expect(r.error).toBe('invalid_phone');
  });

  test('addExclusionInternal escribe a Firestore con defaults', async () => {
    admin.__mocks.setMock.mockResolvedValueOnce();
    const r = await consentRoutes.addExclusionInternal('uid_x', '+573054169969', {});
    expect(r.success).toBe(true);
    expect(r.phone).toBe('573054169969');
    expect(r.reason).toBe('sensitive_data_auto');
  });

  test('addExclusionInternal incluye category + incidentId si provistos', async () => {
    admin.__mocks.setMock.mockResolvedValueOnce();
    await consentRoutes.addExclusionInternal('uid_x', '+573054169969', {
      reason: 'opt_out_manual',
      category: 'salud',
      incidentId: 'inc_abc123',
    });
    const docArg = admin.__mocks.setMock.mock.calls[0][0];
    expect(docArg.reason).toBe('opt_out_manual');
    expect(docArg.category).toBe('salud');
    expect(docArg.incidentId).toBe('inc_abc123');
    expect(docArg.addedBy).toBe('system');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §7b — sendOwnerSafetyAlert + buildOwnerAlertText
// ════════════════════════════════════════════════════════════════════════

describe('§7b sendOwnerSafetyAlert + buildOwnerAlertText', () => {
  const sampleClassif = { category: 'salud', severity: 'ALTA', regexMatch: 'diagnóstico' };

  test('buildOwnerAlertText block: incluye nombre + phone redactado + categoría + restaurar', () => {
    const text = sf.buildOwnerAlertText('+573054169969', sampleClassif, 'block', 'Juan');
    expect(text).toContain('🛑');
    expect(text).toContain('Juan');
    expect(text).toContain('+57***9969');
    expect(text).toContain('salud');
    expect(text).toContain('restaurá');
    expect(text).not.toContain('+573054169969'); // raw phone NO debe aparecer
  });

  test('buildOwnerAlertText log_warn: incluye warning + sin pausa', () => {
    const text = sf.buildOwnerAlertText('+573054169969', sampleClassif, 'log_warn', 'Juan');
    expect(text).toContain('⚠️');
    expect(text).toContain('NO incorporó');
    expect(text).not.toContain('🛑');
  });

  test('buildOwnerAlertText log_only fallback (defensivo)', () => {
    const text = sf.buildOwnerAlertText('+573054169969', sampleClassif, 'log_only', 'Juan');
    expect(text).toContain('log_only');
  });

  test('buildOwnerAlertText con contactName null → "anónimo"', () => {
    const text = sf.buildOwnerAlertText('+573054169969', sampleClassif, 'block', null);
    expect(text).toContain('anónimo');
  });

  test('sendOwnerSafetyAlert sin sendFn → no_send_fn', async () => {
    const r = await sf.sendOwnerSafetyAlert({ uid: 'x', ownerSelfJid: 'jid', contactPhoneE164: '+57305', classification: sampleClassif, action: 'block', contactName: 'X', incidentId: null, sendFn: null });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('no_send_fn');
  });

  test('sendOwnerSafetyAlert log_only no manda → log_only_no_alert', async () => {
    const sendFn = jest.fn();
    const r = await sf.sendOwnerSafetyAlert({ uid: 'x', ownerSelfJid: 'jid', contactPhoneE164: '+57305', classification: sampleClassif, action: 'log_only', contactName: 'X', incidentId: null, sendFn });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('log_only_no_alert');
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('sendOwnerSafetyAlert sin ownerSelfJid → no_owner_jid', async () => {
    const sendFn = jest.fn();
    const r = await sf.sendOwnerSafetyAlert({ uid: 'x', ownerSelfJid: '', contactPhoneE164: '+57305', classification: sampleClassif, action: 'block', contactName: 'X', incidentId: null, sendFn });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('no_owner_jid');
  });

  test('sendOwnerSafetyAlert block llama sendFn con texto correcto', async () => {
    const sendFn = jest.fn().mockResolvedValue();
    const r = await sf.sendOwnerSafetyAlert({
      uid: 'uid_abc',
      ownerSelfJid: '573054169969@s.whatsapp.net',
      contactPhoneE164: '+573163937365',
      classification: sampleClassif,
      action: 'block',
      contactName: 'Lead Test',
      incidentId: null,
      sendFn,
    });
    expect(r.sent).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('uid_abc', '573054169969@s.whatsapp.net', expect.stringContaining('Lead Test'));
  });

  test('sendOwnerSafetyAlert sendFn error → captura sin abortar', async () => {
    const sendFn = jest.fn().mockRejectedValue(new Error('whatsapp down'));
    const r = await sf.sendOwnerSafetyAlert({
      uid: 'uid_x',
      ownerSelfJid: 'jid',
      contactPhoneE164: '+57305',
      classification: sampleClassif,
      action: 'block',
      contactName: 'X',
      incidentId: null,
      sendFn,
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('send_error');
  });

  test('sendOwnerSafetyAlert con incidentId actualiza ownerNotifiedAt', async () => {
    admin.__mocks.setMock.mockResolvedValueOnce();
    const sendFn = jest.fn().mockResolvedValue();
    await sf.sendOwnerSafetyAlert({
      uid: 'uid_x',
      ownerSelfJid: 'jid',
      contactPhoneE164: '+57305',
      classification: sampleClassif,
      action: 'block',
      contactName: 'X',
      incidentId: 'inc_test_456',
      sendFn,
    });
    expect(admin.__mocks.setMock).toHaveBeenCalled();
    const setArg = admin.__mocks.setMock.mock.calls[0][0];
    expect(setArg.ownerNotifiedAt).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════
// §8 — DEFAULT_CENTER_CONFIG inmutable + estructura
// ════════════════════════════════════════════════════════════════════════

describe('§8 DEFAULT_CENTER_CONFIG', () => {
  test('contiene las 5 categorías esperadas', () => {
    const cats = Object.keys(sf.DEFAULT_CENTER_CONFIG.categories);
    expect(cats).toEqual(expect.arrayContaining(sf.CATEGORIES));
    expect(cats).toHaveLength(5);
  });

  test('salud=log_warn (vertical-agnóstico CENTER, corrección Mariano)', () => {
    expect(sf.DEFAULT_CENTER_CONFIG.categories.salud.action).toBe('log_warn');
  });

  test('finanzas=block + menores=block + credenciales=block', () => {
    expect(sf.DEFAULT_CENTER_CONFIG.categories.finanzas.action).toBe('block');
    expect(sf.DEFAULT_CENTER_CONFIG.categories.menores.action).toBe('block');
    expect(sf.DEFAULT_CENTER_CONFIG.categories.credenciales.action).toBe('block');
  });

  test('judicial=log_warn (sub-detección violencia escalará a block dinámicamente)', () => {
    expect(sf.DEFAULT_CENTER_CONFIG.categories.judicial.action).toBe('log_warn');
  });

  test('inmutable (Object.freeze)', () => {
    expect(() => {
      sf.DEFAULT_CENTER_CONFIG.enabled = false;
    }).toThrow();
  });

  test('VALID_ACTIONS contiene los 4 valores esperados', () => {
    expect(sf.VALID_ACTIONS).toEqual(['block', 'log_warn', 'log_only', 'disabled']);
  });

  test('MIIA_CENTER_UID es el UID esperado', () => {
    expect(sf.MIIA_CENTER_UID).toBe('A5pMESWlfmPWCoCPRbwy85EzUzy2');
  });
});
