'use strict';

const {
  sendHealthAlert,
  checkAndAlertDisconnect,
  checkAndAlertRateLimit,
  alertReconnected,
  buildAlertMessage,
  isValidAlertType,
  canSendAlert,
  clearAlertCooldown,
  ALERT_TYPES,
  DISCONNECT_THRESHOLD_MS,
  RATE_LIMIT_THRESHOLD_MS,
  ALERT_COOLDOWN_MS,
  _lastAlertTime,
  __setFirestoreForTests,
  __setSendAlertForTests,
} = require('../core/whatsapp_health_alerter');

const UID = 'owner_uid_pb3_test';

function makeDb(setFails = false) {
  const stored = {};
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (docId) => ({
            set: async (data) => {
              if (setFails) throw new Error('Firestore set failed');
              stored[docId] = data;
            },
          }),
        }),
      }),
    }),
    _stored: stored,
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  __setFirestoreForTests(makeDb());
  __setSendAlertForTests(null);
  delete _lastAlertTime[UID];
});
afterEach(() => {
  __setFirestoreForTests(null);
  __setSendAlertForTests(null);
  delete _lastAlertTime[UID];
  jest.restoreAllMocks();
});

describe('PB3 -- buildAlertMessage', () => {
  test('DISCONNECTED -> mensaje con minutos', () => {
    const msg = buildAlertMessage(ALERT_TYPES.DISCONNECTED, 15);
    expect(msg).toContain('15');
    expect(msg).toContain('desconectado');
  });
  test('RATE_LIMITED -> mensaje de rate limit', () => {
    const msg = buildAlertMessage(ALERT_TYPES.RATE_LIMITED, 0);
    expect(msg).toContain('rate limit');
  });
  test('RECONNECTED -> mensaje positivo', () => {
    const msg = buildAlertMessage(ALERT_TYPES.RECONNECTED, 0);
    expect(msg).toContain('reconectado');
  });
  test('tipo desconocido -> mensaje generico', () => {
    const msg = buildAlertMessage('other_type', 0);
    expect(msg).toContain('other_type');
  });
});

describe('PB3 -- isValidAlertType', () => {
  test('wa_disconnected -> true', () => { expect(isValidAlertType(ALERT_TYPES.DISCONNECTED)).toBe(true); });
  test('wa_rate_limited -> true', () => { expect(isValidAlertType(ALERT_TYPES.RATE_LIMITED)).toBe(true); });
  test('wa_reconnected -> true', () => { expect(isValidAlertType(ALERT_TYPES.RECONNECTED)).toBe(true); });
  test('tipo invalido -> false', () => { expect(isValidAlertType('invalid_type')).toBe(false); });
});

describe('PB3 -- canSendAlert y cooldown', () => {
  test('sin ultimo alerta -> puede enviar', () => {
    delete _lastAlertTime[UID];
    expect(canSendAlert(UID)).toBe(true);
  });
  test('alerta reciente (dentro cooldown) -> NO puede enviar', () => {
    _lastAlertTime[UID] = Date.now() - 1000; // 1 segundo atras
    expect(canSendAlert(UID)).toBe(false);
  });
  test('alerta vieja (fuera cooldown) -> puede enviar', () => {
    _lastAlertTime[UID] = Date.now() - ALERT_COOLDOWN_MS - 1000;
    expect(canSendAlert(UID)).toBe(true);
  });
  test('clearAlertCooldown -> permite enviar de nuevo', () => {
    _lastAlertTime[UID] = Date.now();
    clearAlertCooldown(UID);
    expect(canSendAlert(UID)).toBe(true);
  });
});

describe('PB3 -- sendHealthAlert', () => {
  test('uid null -> lanza error', async () => {
    await expect(sendHealthAlert(null, ALERT_TYPES.DISCONNECTED)).rejects.toThrow('uid requerido');
  });
  test('alertType invalido -> lanza error', async () => {
    await expect(sendHealthAlert(UID, 'invalid')).rejects.toThrow('alertType invalido');
  });
  test('alerta valida -> sent=true + firestore=true', async () => {
    const r = await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED, { elapsedMs: DISCONNECT_THRESHOLD_MS });
    expect(r.sent).toBe(true);
    expect(r.results.firestore).toBe(true);
  });
  test('cooldown activo -> sent=false reason=cooldown', async () => {
    _lastAlertTime[UID] = Date.now();
    const r = await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('cooldown');
  });
  test('customMessage en opts -> usa el custom', async () => {
    const r = await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED, { customMessage: 'custom msg test' });
    expect(r.message).toBe('custom msg test');
  });
  test('sendFn en opts -> llama a fn externa', async () => {
    const sendFn = jest.fn().mockResolvedValue({});
    const r = await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED, { sendFn });
    expect(sendFn).toHaveBeenCalledWith(UID, ALERT_TYPES.DISCONNECTED, expect.any(String), expect.any(Object));
    expect(r.results.external).toBe(true);
  });
  test('sendFn throws -> external=false pero sent=true (Firestore ok)', async () => {
    const sendFn = jest.fn().mockRejectedValue(new Error('wa fail'));
    const r = await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED, { sendFn });
    expect(r.sent).toBe(true);
    expect(r.results.external).toBe(false);
  });
  test('Firestore set fails -> firestore=false pero continua', async () => {
    __setFirestoreForTests(makeDb(true));
    const r = await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED);
    expect(r.sent).toBe(true);
    expect(r.results.firestore).toBe(false);
  });
});

describe('PB3 -- checkAndAlertDisconnect', () => {
  test('lastSeenMs null -> retorna null (sin alerta)', async () => {
    const r = await checkAndAlertDisconnect(UID, null);
    expect(r).toBeNull();
  });
  test('elapsed < threshold -> retorna null (sin alerta)', async () => {
    const now = Date.now();
    const lastSeen = now - DISCONNECT_THRESHOLD_MS + 5000; // 5s antes del threshold
    const r = await checkAndAlertDisconnect(UID, lastSeen, now);
    expect(r).toBeNull();
  });
  test('elapsed >= threshold -> envia alerta DISCONNECTED', async () => {
    const now = Date.now();
    const lastSeen = now - DISCONNECT_THRESHOLD_MS - 1000; // 1s despues del threshold
    const r = await checkAndAlertDisconnect(UID, lastSeen, now);
    expect(r).not.toBeNull();
    expect(r.sent).toBe(true);
    expect(r.alertType).toBe(ALERT_TYPES.DISCONNECTED);
  });
});

describe('PB3 -- checkAndAlertRateLimit', () => {
  test('rateLimitedSinceMs null -> retorna null', async () => {
    const r = await checkAndAlertRateLimit(UID, null);
    expect(r).toBeNull();
  });
  test('elapsed < threshold -> retorna null', async () => {
    const now = Date.now();
    const since = now - RATE_LIMIT_THRESHOLD_MS + 1000;
    const r = await checkAndAlertRateLimit(UID, since, now);
    expect(r).toBeNull();
  });
  test('elapsed >= threshold -> envia alerta RATE_LIMITED', async () => {
    const now = Date.now();
    const since = now - RATE_LIMIT_THRESHOLD_MS - 1000;
    const r = await checkAndAlertRateLimit(UID, since, now);
    expect(r).not.toBeNull();
    expect(r.alertType).toBe(ALERT_TYPES.RATE_LIMITED);
  });
});

describe('PB3 -- alertReconnected', () => {
  test('uid null -> lanza error', async () => {
    await expect(alertReconnected(null)).rejects.toThrow('uid requerido');
  });
  test('uid valido -> envia RECONNECTED + limpia cooldown', async () => {
    _lastAlertTime[UID] = Date.now(); // simula cooldown activo
    const r = await alertReconnected(UID);
    expect(r.sent).toBe(true);
    expect(r.alertType).toBe(ALERT_TYPES.RECONNECTED);
    // cooldown limpiado = puede enviar de nuevo inmediatamente
    // (aunque ahora hay nuevo timestamp, el de la alerta de reconnect)
    expect(r.results.firestore).toBe(true);
  });
});

describe('PB3 -- __setSendAlertForTests global injected fn', () => {
  test('fn inyectada globalmente -> se llama en sendHealthAlert', async () => {
    const globalFn = jest.fn().mockResolvedValue({});
    __setSendAlertForTests(globalFn);
    await sendHealthAlert(UID, ALERT_TYPES.DISCONNECTED);
    expect(globalFn).toHaveBeenCalled();
  });
});

describe('PB3 -- constantes', () => {
  test('DISCONNECT_THRESHOLD_MS = 10 min', () => { expect(DISCONNECT_THRESHOLD_MS).toBe(10 * 60 * 1000); });
  test('RATE_LIMIT_THRESHOLD_MS = 5 min', () => { expect(RATE_LIMIT_THRESHOLD_MS).toBe(5 * 60 * 1000); });
  test('ALERT_COOLDOWN_MS = 30 min', () => { expect(ALERT_COOLDOWN_MS).toBe(30 * 60 * 1000); });
  test('ALERT_TYPES tiene 3 tipos', () => { expect(Object.keys(ALERT_TYPES).length).toBe(3); });
});
