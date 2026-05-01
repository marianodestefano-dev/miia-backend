'use strict';

const {
  getOwnerConsent, setOwnerConsent, hasOwnerConsented,
  VALID_MODES,
  __setFirestoreForTests: setConsentDb,
} = require('../core/consent_manager');

const { ERROR_CODES, HTTP_STATUS, sendApiError } = require('../core/api_errors');

const {
  getDefaultTone, isValidTone, getToneProfile, applyTone,
  saveTonePreference, getTonePreference,
  TONE_PROFILES, CONTACT_TYPE_TONES, DEFAULT_TONE,
  __setFirestoreForTests: setToneDb,
} = require('../core/tone_adapter');

const UID = 'uid_t344';
const PHONE = '+5711112222';

function makeConsentDb(consentData = null) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key] || consentData;
              return { exists: !!d, data: () => d };
            },
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
          }),
        }),
      }),
    }),
  };
}

function makeMockRes() {
  const r = { _status: null, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

describe('T344 -- consent_manager + api_errors + tone_adapter (28 tests)', () => {

  // VALID_MODES
  test('VALID_MODES es array con A/B/C', () => {
    expect(Array.isArray(VALID_MODES)).toBe(true);
    expect(VALID_MODES).toContain('A');
    expect(VALID_MODES).toContain('B');
    expect(VALID_MODES).toContain('C');
    expect(VALID_MODES.length).toBe(3);
  });

  // getOwnerConsent
  test('getOwnerConsent: uid null lanza', async () => {
    await expect(getOwnerConsent(null)).rejects.toThrow('uid requerido');
  });

  test('getOwnerConsent: no doc -> null', async () => {
    setConsentDb(makeConsentDb(null));
    const r = await getOwnerConsent(UID);
    expect(r).toBeNull();
  });

  test('getOwnerConsent: doc existe -> retorna data con mode', async () => {
    setConsentDb(makeConsentDb({ mode: 'B', updatedAt: '2026-05-01T00:00:00Z' }));
    const r = await getOwnerConsent(UID);
    expect(r.mode).toBe('B');
  });

  // setOwnerConsent
  test('setOwnerConsent: uid null lanza', async () => {
    await expect(setOwnerConsent(null, { mode: 'A' })).rejects.toThrow('uid requerido');
  });

  test('setOwnerConsent: mode invalido lanza', async () => {
    setConsentDb(makeConsentDb());
    await expect(setOwnerConsent(UID, { mode: 'X' })).rejects.toThrow('mode invalido');
  });

  test('setOwnerConsent: mode valido retorna success=true + payload', async () => {
    setConsentDb(makeConsentDb());
    const r = await setOwnerConsent(UID, { mode: 'A', acknowledgment: 'Acepto los terminos' });
    expect(r.success).toBe(true);
    expect(r.mode).toBe('A');
    expect(r.updatedAt).toBeDefined();
  });

  // hasOwnerConsented
  test('hasOwnerConsented: uid null -> false (no lanza)', async () => {
    const r = await hasOwnerConsented(null);
    expect(r).toBe(false);
  });

  test('hasOwnerConsented: no doc -> false', async () => {
    setConsentDb(makeConsentDb(null));
    const r = await hasOwnerConsented(UID);
    expect(r).toBe(false);
  });

  test('hasOwnerConsented: doc con mode valido -> true', async () => {
    setConsentDb(makeConsentDb({ mode: 'C' }));
    const r = await hasOwnerConsented(UID);
    expect(r).toBe(true);
  });

  test('hasOwnerConsented: Firestore error -> true (falla cerrada)', async () => {
    setConsentDb({ collection: () => { throw new Error('down'); } });
    const r = await hasOwnerConsented(UID);
    expect(r).toBe(true);
  });

  // ERROR_CODES / HTTP_STATUS
  test('ERROR_CODES frozen, contiene todos los codigos estandar', () => {
    expect(() => { ERROR_CODES.HACK = 'HACK'; }).toThrow();
    expect(ERROR_CODES.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ERROR_CODES.FORBIDDEN).toBe('FORBIDDEN');
    expect(ERROR_CODES.NOT_FOUND).toBe('NOT_FOUND');
    expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
  });

  test('HTTP_STATUS frozen: UNAUTHORIZED=401, NOT_FOUND=404, RATE_LIMITED=429, INTERNAL=500', () => {
    expect(() => { HTTP_STATUS.hack = 999; }).toThrow();
    expect(HTTP_STATUS.UNAUTHORIZED).toBe(401);
    expect(HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(HTTP_STATUS.INTERNAL_ERROR).toBe(500);
    expect(HTTP_STATUS.VALIDATION_ERROR).toBe(400);
    expect(HTTP_STATUS.CONFLICT).toBe(409);
  });

  // sendApiError
  test('sendApiError: UNAUTHORIZED -> status 401 con body correcto', () => {
    const res = makeMockRes();
    sendApiError(res, 'UNAUTHORIZED', 'Token invalido');
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('UNAUTHORIZED');
    expect(res._body.message).toBe('Token invalido');
  });

  test('sendApiError: NOT_FOUND -> status 404', () => {
    const res = makeMockRes();
    sendApiError(res, 'NOT_FOUND', 'Recurso no encontrado');
    expect(res._status).toBe(404);
    expect(res._body.error).toBe('NOT_FOUND');
  });

  test('sendApiError: VALIDATION_ERROR -> status 400', () => {
    const res = makeMockRes();
    sendApiError(res, 'VALIDATION_ERROR', 'Campo invalido');
    expect(res._status).toBe(400);
  });

  test('sendApiError: extra.requestId incluido en body', () => {
    const res = makeMockRes();
    sendApiError(res, 'INTERNAL_ERROR', 'Error inesperado', { requestId: 'req_abc123' });
    expect(res._body.requestId).toBe('req_abc123');
  });

  test('sendApiError: extra.details incluido en body', () => {
    const res = makeMockRes();
    sendApiError(res, 'VALIDATION_ERROR', 'Campos invalidos', { details: { fields: ['email'] } });
    expect(res._body.details).toBeDefined();
    expect(res._body.details.fields).toContain('email');
  });

  // tone_adapter
  test('TONE_PROFILES frozen, contiene formal/friendly/casual/professional/warm', () => {
    expect(() => { TONE_PROFILES.hack = {}; }).toThrow();
    expect(TONE_PROFILES.formal).toBeDefined();
    expect(TONE_PROFILES.friendly).toBeDefined();
    expect(TONE_PROFILES.warm).toBeDefined();
  });

  test('CONTACT_TYPE_TONES frozen: vip=warm, lead=friendly, enterprise=formal', () => {
    expect(() => { CONTACT_TYPE_TONES.hack = 'x'; }).toThrow();
    expect(CONTACT_TYPE_TONES.vip).toBe('warm');
    expect(CONTACT_TYPE_TONES.lead).toBe('friendly');
    expect(CONTACT_TYPE_TONES.enterprise).toBe('formal');
    expect(DEFAULT_TONE).toBe('friendly');
  });

  test('getDefaultTone: lead->friendly, vip->warm, enterprise->formal', () => {
    expect(getDefaultTone('lead')).toBe('friendly');
    expect(getDefaultTone('vip')).toBe('warm');
    expect(getDefaultTone('enterprise')).toBe('formal');
  });

  test('getDefaultTone: tipo desconocido -> DEFAULT_TONE', () => {
    expect(getDefaultTone('unknown_type')).toBe(DEFAULT_TONE);
  });

  test('isValidTone: valid/invalid', () => {
    expect(isValidTone('friendly')).toBe(true);
    expect(isValidTone('formal')).toBe(true);
    expect(isValidTone('ultra_aggressive')).toBe(false);
    expect(isValidTone(null)).toBe(false);
  });

  test('getToneProfile: friendly -> profile con greeting/closing/style/emojiLevel', () => {
    const p = getToneProfile('friendly');
    expect(p.greeting).toBeDefined();
    expect(p.closing).toBeDefined();
    expect(typeof p.emojiLevel).toBe('number');
  });

  test('applyTone: message null lanza', () => {
    expect(() => applyTone(null, 'friendly')).toThrow('message requerido');
  });

  test('applyTone: addGreeting=true -> greeting + mensaje', () => {
    const r = applyTone('el precio es $100', 'friendly', { addGreeting: true });
    expect(r).toContain('Hola');
    expect(r).toContain('$100');
  });

  test('applyTone: addClosing=true -> mensaje + closing', () => {
    const r = applyTone('el precio es $100', 'formal', { addClosing: true });
    expect(r).toContain('$100');
    expect(r).toContain('disposicion');
  });

  test('saveTonePreference: uid null lanza', async () => {
    await expect(saveTonePreference(null, PHONE, 'friendly')).rejects.toThrow('uid requerido');
  });

  test('getTonePreference: uid null lanza', async () => {
    await expect(getTonePreference(null, PHONE, 'lead')).rejects.toThrow('uid requerido');
  });
});
