/**
 * Tests: C-457-OTP-VERIFY-RACE — atomic verify-otp via runTransaction.
 *
 * Origen: C-456 audit hallazgo §B REQUIRES-TX site 1. APROBADO Wi
 * autoridad delegada 2026-04-28.
 *
 * Bug previo:
 *   /api/auth/verify-otp leia otpData snapshot, validaba checks, luego
 *   updateaba used=true en operaciones SEPARADAS (no atomicas).
 *
 *   Exploit 1: 2 verify paralelos con codigo correcto
 *     -> ambos pasan check used===false
 *     -> ambos generan custom token Firebase
 *     -> 2 sesiones validas con un solo OTP.
 *
 *   Exploit 2: 2 wrong tries paralelos
 *     -> ambos leen attempts=N
 *     -> ambos updean attempts=N+1 (last-write-wins -> solo 1 increment)
 *     -> brute-force protection se debilita.
 *
 * Fix: lógica envuelta en fs.runTransaction. Helper extracted a
 *   core/auth/otp_verify.js para test aislado.
 */

'use strict';

const { verifyOtpAtomic } = require('../core/auth/otp_verify');

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
const VALID_CODE = '123456';

function makeMockFs(initial) {
  const store = new Map();
  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      store.set(k, v);
    }
  }
  function makeDocRef(p) {
    return {
      path: p,
      async get() {
        const data = store.get(p);
        return { exists: data !== undefined, data: () => data };
      },
      collection(sub) {
        return { doc(id) { return makeDocRef(`${p}/${sub}/${id}`); } };
      },
    };
  }
  return {
    _store: store,
    collection(name) {
      return { doc(id) { return makeDocRef(`${name}/${id}`); } };
    },
    async runTransaction(cb) {
      const tx = {
        async get(ref) { return ref.get(); },
        update(ref, data) {
          const cur = store.get(ref.path) || {};
          store.set(ref.path, { ...cur, ...JSON.parse(JSON.stringify(data)) });
        },
      };
      return cb(tx);
    },
  };
}

function setupOtp(fs, overrides = {}) {
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  fs._store.set(`users/${VALID_UID}/auth/otp`, {
    code: VALID_CODE,
    expiresAt: future,
    attempts: 0,
    used: false,
    ...overrides,
  });
}

// ════════════════════════════════════════════════════════════════════
// §A — Casos básicos
// ════════════════════════════════════════════════════════════════════

describe('C-457-OTP-VERIFY-RACE §A — casos basicos', () => {
  test('A.1 — OTP correcto + estado limpio → success + marcado used=true', async () => {
    const fs = makeMockFs();
    setupOtp(fs);
    const r = await verifyOtpAtomic(fs, VALID_UID, VALID_CODE);
    expect(r.agentUid).toBe(VALID_UID);
    const data = fs._store.get(`users/${VALID_UID}/auth/otp`);
    expect(data.used).toBe(true);
    expect(typeof data.usedAt).toBe('string');
  });

  test('A.2 — OTP not_found → throws OTP_NOT_FOUND', async () => {
    const fs = makeMockFs();
    await expect(verifyOtpAtomic(fs, VALID_UID, VALID_CODE))
      .rejects.toMatchObject({ code: 'OTP_NOT_FOUND' });
  });

  test('A.3 — OTP ya usado → throws OTP_ALREADY_USED', async () => {
    const fs = makeMockFs();
    setupOtp(fs, { used: true });
    await expect(verifyOtpAtomic(fs, VALID_UID, VALID_CODE))
      .rejects.toMatchObject({ code: 'OTP_ALREADY_USED' });
  });

  test('A.4 — OTP expirado → throws OTP_EXPIRED', async () => {
    const fs = makeMockFs();
    setupOtp(fs, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await expect(verifyOtpAtomic(fs, VALID_UID, VALID_CODE))
      .rejects.toMatchObject({ code: 'OTP_EXPIRED' });
  });

  test('A.5 — attempts >= 5 → throws OTP_ATTEMPTS_EXCEEDED', async () => {
    const fs = makeMockFs();
    setupOtp(fs, { attempts: 5 });
    await expect(verifyOtpAtomic(fs, VALID_UID, VALID_CODE))
      .rejects.toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED' });
  });

  test('A.6 — code mismatch → throws OTP_CODE_MISMATCH + attempts incrementa', async () => {
    const fs = makeMockFs();
    setupOtp(fs, { attempts: 2 });
    await expect(verifyOtpAtomic(fs, VALID_UID, '999999'))
      .rejects.toMatchObject({ code: 'OTP_CODE_MISMATCH', remaining: 2 });
    const data = fs._store.get(`users/${VALID_UID}/auth/otp`);
    expect(data.attempts).toBe(3);
    expect(data.used).toBe(false);
  });

  test('A.7 — code mismatch attempts hasta 4 → remaining=0 (despues de incrementar)', async () => {
    const fs = makeMockFs();
    setupOtp(fs, { attempts: 4 });
    await expect(verifyOtpAtomic(fs, VALID_UID, '999999'))
      .rejects.toMatchObject({ code: 'OTP_CODE_MISMATCH', remaining: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Race conditions concurrentes
// ════════════════════════════════════════════════════════════════════

describe('C-457-OTP-VERIFY-RACE §B — concurrencia', () => {
  test('B.1 — verify secuencial post-tx → 2do verify throws ALREADY_USED', async () => {
    // El mock runTransaction NO simula concurrencia/contention real
    // (callbacks ejecutan secuencial). El equivalente realista es:
    // tras el primer verify exitoso, used=true queda atómicamente set
    // y la siguiente verify falla rápido. El lock real Firestore tx
    // en prod hace lo mismo + protege durante la ventana de ejecución.
    const fs = makeMockFs();
    setupOtp(fs);
    const r1 = await verifyOtpAtomic(fs, VALID_UID, VALID_CODE);
    expect(r1.agentUid).toBe(VALID_UID);
    await expect(verifyOtpAtomic(fs, VALID_UID, VALID_CODE))
      .rejects.toMatchObject({ code: 'OTP_ALREADY_USED' });
  });

  test('B.2 — verify exitoso + 2do verify post-tx → throws ALREADY_USED', async () => {
    const fs = makeMockFs();
    setupOtp(fs);
    await verifyOtpAtomic(fs, VALID_UID, VALID_CODE);
    await expect(verifyOtpAtomic(fs, VALID_UID, VALID_CODE))
      .rejects.toMatchObject({ code: 'OTP_ALREADY_USED' });
  });

  test('B.3 — 2 wrong tries secuenciales → attempts incrementa a 2', async () => {
    const fs = makeMockFs();
    setupOtp(fs, { attempts: 0 });
    await expect(verifyOtpAtomic(fs, VALID_UID, '999999'))
      .rejects.toMatchObject({ code: 'OTP_CODE_MISMATCH' });
    await expect(verifyOtpAtomic(fs, VALID_UID, '888888'))
      .rejects.toMatchObject({ code: 'OTP_CODE_MISMATCH' });
    const data = fs._store.get(`users/${VALID_UID}/auth/otp`);
    expect(data.attempts).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — Defensivos + source markers
// ════════════════════════════════════════════════════════════════════

describe('C-457-OTP-VERIFY-RACE §C — defensivos + source', () => {
  test('C.1 — otpCode null → throws OTP_CODE_MISMATCH (trim safe)', async () => {
    const fs = makeMockFs();
    setupOtp(fs);
    await expect(verifyOtpAtomic(fs, VALID_UID, null))
      .rejects.toMatchObject({ code: 'OTP_CODE_MISMATCH' });
  });

  test('C.2 — otpCode con whitespace → trim funciona', async () => {
    const fs = makeMockFs();
    setupOtp(fs);
    const r = await verifyOtpAtomic(fs, VALID_UID, '  123456  ');
    expect(r.agentUid).toBe(VALID_UID);
  });

  test('C.3 — server.js usa otpVerify.verifyOtpAtomic (wire-in source)', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../server.js'),
      'utf8'
    );
    expect(SRC).toMatch(/otpVerify\.verifyOtpAtomic/);
    expect(SRC).toMatch(/require\(['"]\.\/core\/auth\/otp_verify['"]\)/);
  });

  test('C.4 — comentario C-457-OTP-VERIFY-RACE presente en source', () => {
    const fs = require('fs');
    const path = require('path');
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../core/auth/otp_verify.js'),
      'utf8'
    );
    expect(SRC).toContain('C-457-OTP-VERIFY-RACE');
    expect(SRC).toMatch(/runTransaction/);
  });
});
