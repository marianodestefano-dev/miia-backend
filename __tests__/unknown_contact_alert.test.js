'use strict';
/**
 * R15-B — unknown_contact_alert.test.js
 * 100% branch coverage: shouldSendAlert + markAlertSent
 */

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockDocExists = false;
let mockDocData = null;
let mockGetThrows = false;
let mockSetThrows = false;
let lastSetData = null;

const mockFs = {
  collection: () => ({
    doc: () => ({
      collection: () => ({
        doc: () => ({
          get: () => {
            if (mockGetThrows) return Promise.reject(new Error('GET-FAIL'));
            return Promise.resolve({ exists: mockDocExists, data: () => mockDocData });
          },
          set: (data, _opts) => {
            if (mockSetThrows) return Promise.reject(new Error('SET-FAIL'));
            lastSetData = data;
            return Promise.resolve();
          },
        }),
      }),
    }),
  }),
};

const { shouldSendAlert, markAlertSent, __setFirestoreForTests, COOLDOWN_MS } = require('../core/unknown_alert_cooldown');
__setFirestoreForTests(mockFs);

beforeEach(() => {
  mockDocExists = false;
  mockDocData = null;
  mockGetThrows = false;
  mockSetThrows = false;
  lastSetData = null;
});

// ── shouldSendAlert ───────────────────────────────────────────────────────────
describe('shouldSendAlert', () => {
  test('retorna false si uid vacio', async () => {
    expect(await shouldSendAlert('', '573001234567')).toBe(false);
  });

  test('retorna false si phone vacio', async () => {
    expect(await shouldSendAlert('uid-abc', '')).toBe(false);
  });

  test('retorna false si uid y phone ambos vacios', async () => {
    expect(await shouldSendAlert('', '')).toBe(false);
  });

  test('retorna true si documento no existe (primer contacto)', async () => {
    mockDocExists = false;
    expect(await shouldSendAlert('uid-abc', '573001234567')).toBe(true);
  });

  test('retorna true si fecha_ultima_alerta > 24h', async () => {
    mockDocExists = true;
    mockDocData = { fecha_ultima_alerta: Date.now() - COOLDOWN_MS - 1000 };
    expect(await shouldSendAlert('uid-abc', '573001234567')).toBe(true);
  });

  test('retorna false si fecha_ultima_alerta < 24h (en cooldown)', async () => {
    mockDocExists = true;
    mockDocData = { fecha_ultima_alerta: Date.now() - 1000 };
    expect(await shouldSendAlert('uid-abc', '573001234567')).toBe(false);
  });

  test('retorna false si fecha_ultima_alerta exactamente en el limite (igual COOLDOWN_MS)', async () => {
    mockDocExists = true;
    mockDocData = { fecha_ultima_alerta: Date.now() - COOLDOWN_MS };
    expect(await shouldSendAlert('uid-abc', '573001234567')).toBe(false);
  });

  test('retorna true si doc existe pero fecha_ultima_alerta es 0 (fallback default)', async () => {
    mockDocExists = true;
    mockDocData = {};
    expect(await shouldSendAlert('uid-abc', '573001234567')).toBe(true);
  });

  test('fail-open: retorna true si Firestore falla', async () => {
    mockGetThrows = true;
    expect(await shouldSendAlert('uid-abc', '573001234567')).toBe(true);
  });
});

// ── markAlertSent ─────────────────────────────────────────────────────────────
describe('markAlertSent', () => {
  test('no lanza si uid vacio (no-op)', async () => {
    await expect(markAlertSent('', '573001234567')).resolves.toBeUndefined();
  });

  test('no lanza si phone vacio (no-op)', async () => {
    await expect(markAlertSent('uid-abc', '')).resolves.toBeUndefined();
  });

  test('escribe fecha_ultima_alerta en Firestore', async () => {
    await markAlertSent('uid-abc', '573001234567');
    expect(lastSetData).not.toBeNull();
    expect(typeof lastSetData.fecha_ultima_alerta).toBe('number');
    expect(lastSetData.updatedAt).toBeTruthy();
  });

  test('no lanza si Firestore set falla (error silenciado con log)', async () => {
    mockSetThrows = true;
    await expect(markAlertSent('uid-abc', '573001234567')).resolves.toBeUndefined();
  });
});

// ── COOLDOWN_MS exportado ─────────────────────────────────────────────────────
describe('COOLDOWN_MS', () => {
  test('es 24 horas en ms', () => {
    expect(COOLDOWN_MS).toBe(86400000);
  });
});
