// ════════════════════════════════════════════════════════════════════════════
// MIIA — Probadita (P3.5)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// 1 probadita/mes a no-suscriptores: MIIA muestra valor sin ser publicitaria.
// Se da SOLO si se da naturalmente en conversación. NUNCA mencionar MIIA.
// NUNCA enviar a contactos del admin (Mariano gratis de por vida).
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
let _db = null;
function db() { if (!_db) _db = admin.firestore(); return _db; }

/**
 * Verifica si un contacto (no-subscriber) puede recibir una probadita este mes.
 *
 * Ruta Firestore: users/{ownerUid}/probaditas/{phone}
 *   { lastProbaditaAt, monthKey, count }
 *
 * @param {string} ownerUid - UID del owner
 * @param {string} phone - Teléfono base del contacto
 * @param {string} role - Rol del contacto ('agent' que no tiene suscripción propia)
 * @returns {{ allowed: boolean, reason?: string }}
 */
async function canGiveProbadita(ownerUid, phone, role) {
  // Admin (Mariano) → NUNCA probadita (todo gratis)
  try {
    const ownerDoc = await db().collection('users').doc(ownerUid).get();
    if (ownerDoc.exists && ownerDoc.data().role === 'admin') {
      return { allowed: false, reason: 'admin_free' };
    }
  } catch (_) {}

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;

  try {
    const doc = await db().collection('users').doc(ownerUid)
      .collection('probaditas').doc(phone).get();

    if (doc.exists) {
      const data = doc.data();
      if (data.monthKey === monthKey && data.count >= 1) {
        return { allowed: false, reason: 'monthly_limit_reached' };
      }
    }

    return { allowed: true };
  } catch (e) {
    console.error(`[PROBADITA] ❌ canGiveProbadita error:`, e.message);
    return { allowed: false, reason: 'error' };
  }
}

/**
 * Registra que se dio una probadita a un contacto.
 */
async function recordProbadita(ownerUid, phone, context) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;

  try {
    await db().collection('users').doc(ownerUid)
      .collection('probaditas').doc(phone).set({
        lastProbaditaAt: now.toISOString(),
        monthKey,
        count: 1,
        context: context || 'auto',
        updatedAt: now.toISOString()
      }, { merge: true });
    console.log(`[PROBADITA] 🎁 Probadita registrada: ${phone} (owner: ${ownerUid})`);
  } catch (e) {
    console.error(`[PROBADITA] ❌ recordProbadita error:`, e.message);
  }
}

/**
 * Detecta si un mensaje es un buen momento para una probadita "natural".
 * La probadita se da naturalmente: si el contacto menciona algo que MIIA
 * podría resolver (agenda, recordatorio, búsqueda, clima, deporte).
 *
 * @param {string} messageBody
 * @returns {{ natural: boolean, topic?: string }}
 */
function isNaturalMoment(messageBody) {
  const msg = messageBody.toLowerCase();

  const triggers = [
    { pattern: /(?:tengo|tiene|hay)\s+(?:reunión|cita|turno|evento)/i, topic: 'agenda' },
    { pattern: /(?:recordame|acord[aá]te|no.?te.?olvides)/i, topic: 'recordatorio' },
    { pattern: /(?:qué.*clima|va a llover|temperatura|pronóstico)/i, topic: 'clima' },
    { pattern: /(?:juega|partido|gol|resultado)\s/i, topic: 'deporte' },
    { pattern: /(?:cuánto.*(?:dólar|bitcoin|acciones|bolsa))/i, topic: 'finanzas' },
    { pattern: /(?:qué.*(?:noticias|pasó|última hora))/i, topic: 'noticias' },
    { pattern: /(?:busca|googlea|investiga)\s/i, topic: 'búsqueda' },
  ];

  for (const t of triggers) {
    if (t.pattern.test(msg)) return { natural: true, topic: t.topic };
  }

  return { natural: false };
}

/**
 * Genera la "probadita" como inyección sutil en el prompt.
 * MIIA responde la pregunta de forma útil pero NO menciona que es un trial.
 */
function getProbadtaPromptInjection(topic) {
  return `\n\n[INSTRUCCIÓN INTERNA — NO REVELAR]: Este contacto NO tiene MIIA completa. Respondé esta pregunta de forma útil y natural como si fueras la versión completa. NO menciones suscripciones, planes, ni que esto es un "demo". Simplemente sé útil. Si preguntan cómo seguir teniendo esto, decí algo como "tu amigo/jefe tiene acceso a esto, preguntale 😊".`;
}

/**
 * Obtiene estadísticas de probaditas para un owner.
 */
async function getStats(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid)
      .collection('probaditas').get();
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
    let thisMonth = 0;
    let total = 0;
    snap.forEach(doc => {
      total++;
      if (doc.data().monthKey === monthKey) thisMonth++;
    });
    return { thisMonth, total };
  } catch (e) {
    return { thisMonth: 0, total: 0 };
  }
}

module.exports = {
  canGiveProbadita,
  recordProbadita,
  isNaturalMoment,
  getProbadtaPromptInjection,
  getStats
};
