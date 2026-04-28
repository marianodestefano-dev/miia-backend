/**
 * C-457-OTP-VERIFY-RACE — atomic verify via Firestore runTransaction.
 *
 * Origen: C-456 audit hallazgo §B REQUIRES-TX site 1.
 *
 * Fix: envolver la lectura del OTP doc + check (used/expired/attempts/
 * code) + mutación (used=true | attempts++) dentro de una sola
 * Firestore transaction. Garantiza atomicidad y elimina dos exploits:
 *
 *   Exploit 1: 2 verify paralelos con código correcto → 2 sesiones
 *     válidas con un solo OTP. Fix: tx.update(used=true) atómico,
 *     segundo runner ve used=true y throws "already used".
 *   Exploit 2: 2 wrong tries paralelos → ambos leen attempts=N,
 *     ambos updean attempts=N+1 (last-write-wins, solo 1 increment).
 *     Fix: tx.update(attempts=fresh+1) atómico dentro de tx, segundo
 *     runner re-lee attempts updated y aplica increment correcto.
 *
 * Cross-link: C-448 forget_me lock pattern + C-450 distill lock.
 *
 * El helper NO toca Firebase Auth (custom token generation queda en
 * el handler Express). NO toca users/{uid} (post-tx update queda en
 * handler). Solo lógica atómica de la verificación OTP.
 */

'use strict';

/**
 * Verifica un OTP atómicamente.
 *
 * @param {object} fs - Firestore instance (admin.firestore() o mock).
 * @param {string} agentUid - UID del agente a verificar.
 * @param {string} otpCode - Código OTP submitted.
 * @returns {Promise<{agentUid: string}>} Si OK; throws Error con err.code:
 *   OTP_NOT_FOUND | OTP_ATTEMPTS_EXCEEDED | OTP_EXPIRED |
 *   OTP_ALREADY_USED | OTP_CODE_MISMATCH (con err.remaining: number).
 */
async function verifyOtpAtomic(fs, agentUid, otpCode) {
  const otpRef = fs.collection('users').doc(agentUid).collection('auth').doc('otp');
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(otpRef);
    if (!snap.exists) {
      const err = new Error('otp_not_found');
      err.code = 'OTP_NOT_FOUND';
      throw err;
    }
    const otpData = snap.data() || {};

    if ((otpData.attempts || 0) >= 5) {
      const err = new Error('attempts_exceeded');
      err.code = 'OTP_ATTEMPTS_EXCEEDED';
      throw err;
    }
    if (new Date(otpData.expiresAt) < new Date()) {
      const err = new Error('expired');
      err.code = 'OTP_EXPIRED';
      throw err;
    }
    if (otpData.used) {
      const err = new Error('already_used');
      err.code = 'OTP_ALREADY_USED';
      throw err;
    }

    if (otpData.code !== String(otpCode || '').trim()) {
      const newAttempts = (otpData.attempts || 0) + 1;
      tx.update(otpRef, { attempts: newAttempts });
      const err = new Error('code_mismatch');
      err.code = 'OTP_CODE_MISMATCH';
      err.remaining = Math.max(0, 5 - newAttempts);
      throw err;
    }

    tx.update(otpRef, {
      used: true,
      usedAt: new Date().toISOString(),
    });
    return { agentUid };
  });
}

module.exports = {
  verifyOtpAtomic,
};
