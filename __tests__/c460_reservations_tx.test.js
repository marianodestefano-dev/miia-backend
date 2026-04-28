/**
 * Tests: C-460-RESERVATIONS-TX — atomic updateReservation +
 * updateReceivedReservation via Firestore runTransaction.
 *
 * Origen: C-456 audit ITEM B.1 hallazgo BAJA-MEDIA. APROBADO Wi
 * autoridad delegada 2026-04-28.
 *
 * Bug previo:
 *   updateReservation: read doc.get -> validate -> doc.update sin tx.
 *     Race window: 2 updates concurrentes (ej: owner confirma + cron
 *     auto-cancela timeout) -> last-write-wins, 1 cambio se pierde.
 *
 * Fix: read + check status pre-condition + update DENTRO de tx atomico.
 *   State machine forward-only:
 *     pending -> confirmed | cancelled | completed
 *     confirmed -> completed | cancelled
 *     cancelled / completed -> terminal (no transitions)
 *
 * Cross-link: C-457 verify-otp + C-448 forgetme + C-450 distill lock.
 */

'use strict';

const path = require('path');
const fsNode = require('fs');

// Cargar el modulo bajo test sin require firebase-admin real (mock).
// Usamos jest.mock para reemplazar admin con stub minimal.
jest.mock('firebase-admin', () => {
  const mockFs = {
    _store: new Map(),
    _resetStore() { this._store.clear(); },
    _ref(p) {
      const self = this;
      return {
        path: p,
        async get() {
          const data = self._store.get(p);
          return { exists: data !== undefined, data: () => data };
        },
        async update(patch) {
          const cur = self._store.get(p) || {};
          self._store.set(p, { ...cur, ...JSON.parse(JSON.stringify(patch)) });
        },
        async set(d, opts) {
          if (opts && opts.merge) {
            const cur = self._store.get(p) || {};
            self._store.set(p, { ...cur, ...JSON.parse(JSON.stringify(d)) });
          } else {
            self._store.set(p, JSON.parse(JSON.stringify(d)));
          }
        },
      };
    },
    collection(name) {
      const self = this;
      return {
        doc(id) {
          const p = `${name}/${id}`;
          const ref = self._ref(p);
          ref.collection = (sub) => ({
            doc(id2) {
              return self._ref(`${p}/${sub}/${id2}`);
            },
          });
          return ref;
        },
      };
    },
    async runTransaction(cb) {
      const self = this;
      const tx = {
        async get(ref) { return ref.get(); },
        update(ref, data) {
          const cur = self._store.get(ref.path) || {};
          self._store.set(ref.path, { ...cur, ...JSON.parse(JSON.stringify(data)) });
        },
      };
      return cb(tx);
    },
  };
  const fakeAdmin = {
    firestore: () => mockFs,
    apps: [{ name: 'test' }],
  };
  fakeAdmin.firestore.FieldValue = {
    serverTimestamp: () => 'serverTimestamp',
    increment: (n) => ({ __increment: n }),
  };
  return fakeAdmin;
});

const reservations = require('../integrations/reservations_integration');
const admin = require('firebase-admin');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const RESERVATION_ID = 'res_001';
const BIZ_PHONE = '573054169969';
const REQUEST_ID = 'req_001';

beforeEach(() => {
  admin.firestore()._resetStore();
});

function setupReservation(status = 'pending') {
  admin.firestore()._store.set(
    `users/${VALID_UID}/miia_reservations/${RESERVATION_ID}`,
    {
      type: 'restaurant',
      businessName: 'Mock Resto',
      status,
      createdAt: 'serverTimestamp',
    }
  );
}

function setupReceivedReservation(status = 'pending') {
  admin.firestore()._store.set(
    `miia_network/${BIZ_PHONE}/reservation_requests/${REQUEST_ID}`,
    {
      fromPhone: '573161234567',
      status,
      createdAt: 'serverTimestamp',
    }
  );
}

// ════════════════════════════════════════════════════════════════════
// §A — _isValidReservationTransition (state machine puro)
// ════════════════════════════════════════════════════════════════════

describe('C-460-RESERVATIONS-TX §A — state machine', () => {
  test('A.1 — pending -> confirmed: VALIDO', () => {
    expect(reservations._isValidReservationTransition('pending', 'confirmed')).toBe(true);
  });

  test('A.2 — pending -> cancelled: VALIDO', () => {
    expect(reservations._isValidReservationTransition('pending', 'cancelled')).toBe(true);
  });

  test('A.3 — confirmed -> completed: VALIDO', () => {
    expect(reservations._isValidReservationTransition('confirmed', 'completed')).toBe(true);
  });

  test('A.4 — completed -> pending: INVALIDO (terminal)', () => {
    expect(reservations._isValidReservationTransition('completed', 'pending')).toBe(false);
  });

  test('A.5 — cancelled -> confirmed: INVALIDO (terminal)', () => {
    expect(reservations._isValidReservationTransition('cancelled', 'confirmed')).toBe(false);
  });

  test('A.6 — pending -> pending: VALIDO (idempotente)', () => {
    expect(reservations._isValidReservationTransition('pending', 'pending')).toBe(true);
  });

  test('A.7 — sin status (partial update) → VALIDO', () => {
    expect(reservations._isValidReservationTransition('pending', null)).toBe(true);
    expect(reservations._isValidReservationTransition(null, 'confirmed')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — updateReservation atomic
// ════════════════════════════════════════════════════════════════════

describe('C-460-RESERVATIONS-TX §B — updateReservation atomic', () => {
  test('B.1 — pending → confirmed atomico OK', async () => {
    setupReservation('pending');
    const r = await reservations.updateReservation(VALID_UID, RESERVATION_ID, {
      status: 'confirmed',
    });
    expect(r.reservationId).toBe(RESERVATION_ID);
    expect(r.status).toBe('confirmed');
    const data = admin.firestore()._store.get(`users/${VALID_UID}/miia_reservations/${RESERVATION_ID}`);
    expect(data.status).toBe('confirmed');
    expect(data.confirmedAt).toBe('serverTimestamp');
  });

  test('B.2 — completed → pending throws RESERVATION_INVALID_TRANSITION', async () => {
    setupReservation('completed');
    await expect(reservations.updateReservation(VALID_UID, RESERVATION_ID, {
      status: 'pending',
    })).rejects.toMatchObject({
      code: 'RESERVATION_INVALID_TRANSITION',
      from: 'completed',
      to: 'pending',
    });
  });

  test('B.3 — reservation not found → throws RESERVATION_NOT_FOUND', async () => {
    await expect(reservations.updateReservation(VALID_UID, 'res_missing', {
      status: 'confirmed',
    })).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
  });

  test('B.4 — partial update sin status (ej: notes) → OK sin transition check', async () => {
    setupReservation('pending');
    const r = await reservations.updateReservation(VALID_UID, RESERVATION_ID, {
      notes: 'Nota nueva',
    });
    expect(r.notes).toBe('Nota nueva');
    const data = admin.firestore()._store.get(`users/${VALID_UID}/miia_reservations/${RESERVATION_ID}`);
    expect(data.status).toBe('pending'); // unchanged
  });

  test('B.5 — uid invalid → throws', async () => {
    await expect(reservations.updateReservation(null, RESERVATION_ID, { status: 'confirmed' }))
      .rejects.toThrow(/uid invalid/);
  });

  test('B.6 — updates invalid → throws', async () => {
    await expect(reservations.updateReservation(VALID_UID, RESERVATION_ID, null))
      .rejects.toThrow(/updates invalid/);
  });

  test('B.7 — secuencial: pending → confirmed → completed', async () => {
    setupReservation('pending');
    await reservations.updateReservation(VALID_UID, RESERVATION_ID, { status: 'confirmed' });
    const r = await reservations.updateReservation(VALID_UID, RESERVATION_ID, { status: 'completed' });
    expect(r.status).toBe('completed');
  });

  test('B.8 — confirmed → completed despues otra → completed throws (terminal)', async () => {
    setupReservation('completed');
    await expect(reservations.updateReservation(VALID_UID, RESERVATION_ID, {
      status: 'cancelled',
    })).rejects.toMatchObject({ code: 'RESERVATION_INVALID_TRANSITION' });
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — updateReceivedReservation atomic
// ════════════════════════════════════════════════════════════════════

describe('C-460-RESERVATIONS-TX §C — updateReceivedReservation atomic', () => {
  test('C.1 — pending → confirmed OK', async () => {
    setupReceivedReservation('pending');
    await reservations.updateReceivedReservation(BIZ_PHONE, REQUEST_ID, 'confirmed');
    const data = admin.firestore()._store.get(`miia_network/${BIZ_PHONE}/reservation_requests/${REQUEST_ID}`);
    expect(data.status).toBe('confirmed');
  });

  test('C.2 — request not found → throws RESERVATION_NOT_FOUND', async () => {
    await expect(reservations.updateReceivedReservation(BIZ_PHONE, 'req_missing', 'confirmed'))
      .rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
  });

  test('C.3 — completed → pending throws INVALID_TRANSITION', async () => {
    setupReceivedReservation('completed');
    await expect(reservations.updateReceivedReservation(BIZ_PHONE, REQUEST_ID, 'pending'))
      .rejects.toMatchObject({ code: 'RESERVATION_INVALID_TRANSITION' });
  });

  test('C.4 — bizPhone invalid → throws', async () => {
    await expect(reservations.updateReceivedReservation('', REQUEST_ID, 'confirmed'))
      .rejects.toThrow(/bizPhone invalid/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — Source markers
// ════════════════════════════════════════════════════════════════════

describe('C-460-RESERVATIONS-TX §D — source markers', () => {
  const SRC_PATH = path.resolve(__dirname, '../integrations/reservations_integration.js');
  const SOURCE = fsNode.readFileSync(SRC_PATH, 'utf8');

  test('D.1 — usa runTransaction', () => {
    expect(SOURCE).toMatch(/\.runTransaction\(/);
  });

  test('D.2 — comentario C-460-RESERVATIONS-TX presente', () => {
    expect(SOURCE).toContain('C-460-RESERVATIONS-TX');
  });

  test('D.3 — _RESERVATION_VALID_TRANSITIONS map presente', () => {
    expect(SOURCE).toMatch(/_RESERVATION_VALID_TRANSITIONS\s*=/);
  });

  test('D.4 — exports _isValidReservationTransition', () => {
    expect(SOURCE).toMatch(/_isValidReservationTransition,/);
  });
});
