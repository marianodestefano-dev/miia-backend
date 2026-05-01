'use strict';

/**
 * T345 -- E2E Bloque 48
 * Pipeline: consent_manager -> tone_adapter -> api_errors
 */

const {
  setOwnerConsent, hasOwnerConsented,
  VALID_MODES,
  __setFirestoreForTests: setConsentDb,
} = require('../core/consent_manager');

const {
  applyTone, getDefaultTone, getToneProfile,
  saveTonePreference, getTonePreference,
  __setFirestoreForTests: setToneDb,
} = require('../core/tone_adapter');

const { sendApiError, ERROR_CODES, HTTP_STATUS } = require('../core/api_errors');

const UID = 'owner_bloque48_001';
const PHONE = '+5711112222';

function makeDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
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

describe('T345 -- E2E Bloque 48: consent_manager + tone_adapter + api_errors', () => {

  test('Paso 1 -- owner sin consent -> hasOwnerConsented=false', async () => {
    const db = makeDb();
    setConsentDb(db);
    const result = await hasOwnerConsented(UID);
    expect(result).toBe(false);
  });

  test('Paso 2 -- owner registra consent modo A -> hasOwnerConsented=true', async () => {
    const db = makeDb();
    setConsentDb(db);
    await setOwnerConsent(UID, { mode: 'A', acknowledgment: 'Acepto los terminos de MIIA' });
    const result = await hasOwnerConsented(UID);
    expect(result).toBe(true);
  });

  test('Paso 3 -- tone adaptado para lead (friendly)', () => {
    const tone = getDefaultTone('lead');
    expect(tone).toBe('friendly');
    const profile = getToneProfile(tone);
    expect(profile.greeting).toBeDefined();
  });

  test('Paso 4 -- mensaje con tono formal aplicado', () => {
    const msg = applyTone('El precio del plan es $99/mes', 'formal', { addGreeting: true, addClosing: true });
    expect(msg).toContain('Buenos dias'); // formal greeting
    expect(msg).toContain('$99/mes');
    expect(msg).toContain('disposicion'); // formal closing
  });

  test('Paso 5 -- API error 401 para acceso sin consent', () => {
    const res = makeMockRes();
    sendApiError(res, ERROR_CODES.UNAUTHORIZED, 'Owner no ha configurado consent', { requestId: 'req_001' });
    expect(res._status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(res._body.error).toBe('UNAUTHORIZED');
    expect(res._body.requestId).toBe('req_001');
  });

  test('Paso 6 -- saveTonePreference + getTonePreference round-trip', async () => {
    const db = makeDb();
    setToneDb(db);
    await saveTonePreference(UID, PHONE, 'formal');
    const pref = await getTonePreference(UID, PHONE, 'lead');
    expect(pref).toBe('formal');
  });

  test('Pipeline completo -- consent + tone + api_error', async () => {
    const db = makeDb();
    setConsentDb(db);
    setToneDb(db);

    // A: Verificar consent (nuevo owner, no consented)
    let consented = await hasOwnerConsented(UID);
    expect(consented).toBe(false);

    // B: Owner sin consent -> API error 403 (FORBIDDEN)
    const res1 = makeMockRes();
    sendApiError(res1, ERROR_CODES.FORBIDDEN, 'Se requiere configurar consent primero');
    expect(res1._status).toBe(403);

    // C: Owner configura consent modo B
    await setOwnerConsent(UID, { mode: 'B', acknowledgment: 'Entendido, modo B' });
    consented = await hasOwnerConsented(UID);
    expect(consented).toBe(true);

    // D: Adaptar tono para el lead
    const tone = getDefaultTone('lead');
    const reply = applyTone('Hola, te puedo ayudar con informacion sobre nuestros planes', tone, {});
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);

    // E: Guardar preferencia de tono del lead
    await saveTonePreference(UID, PHONE, 'friendly');
    const savedTone = await getTonePreference(UID, PHONE, 'lead');
    expect(savedTone).toBe('friendly');
  });
});
