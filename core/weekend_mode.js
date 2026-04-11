// ════════════════════════════════════════════════════════════════════════════
// MIIA — Weekend Mode / Modo Finde (P3.4)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// MIIA pregunta al owner "¿trabajás mañana?" el viernes/sábado.
// Si el owner dice NO → leads reciben respuesta automática + delay hasta lunes.
// Familia/equipo: siempre responde. Owner self-chat: siempre.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
let _db = null;
function db() { if (!_db) _db = admin.firestore(); return _db; }

// In-memory state por owner: { uid: { weekendOff: boolean, resumeAt: Date, askedAt: Date } }
const weekendState = {};

// ══════════════════════════════════════════════════════════════════
// 🛡️ INTEGRITY GUARD: HORA FIJA 19:00 LOCAL DEL OWNER
// ══════════════════════════════════════════════════════════════════
// El mensaje de modo finde se envía a las 19:00 hora LOCAL del owner.
// Cada país tiene su timezone → 19:00 en Argentina, 19:00 en Colombia,
// 19:00 donde sea. NUNCA antes, NUNCA después.
//
// ⚠️ PROHIBIDO cambiar la hora sin aprobación de Mariano.
// Bug original: ventana 17-19h causaba envío a las 5:03PM.
// Mariano quiere 7PM (19:00) exacto. Fix del 11-Abr-2026.
// ══════════════════════════════════════════════════════════════════
/**
 * Verifica si es momento de preguntar al owner sobre el finde.
 * Lógica: viernes a las 19:00 hora LOCAL del owner (timezone).
 * Solo pregunta una vez por finde.
 */
function shouldAskWeekendQuestion(ownerUid, timezone) {
  const tz = timezone || 'America/Bogota';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const day = now.getDay(); // 0=dom, 5=vie, 6=sáb
  const hour = now.getHours();

  // HORA FIJA: viernes a las 19:00 local (ventana 19:00-19:59 para que el setInterval de 30min lo atrape)
  const isQuestionTime = (day === 5 && hour === 19);
  if (!isQuestionTime) return false;

  // ¿Ya preguntó este finde?
  const state = weekendState[ownerUid];
  if (state?.askedAt) {
    const askedDate = new Date(state.askedAt);
    const diffHours = (now.getTime() - askedDate.getTime()) / (1000 * 60 * 60);
    if (diffHours < 48) return false; // Ya preguntó hace menos de 48h
  }

  console.log(`[WEEKEND] ⏰ Hora de preguntar modo finde a ${ownerUid} (${hour}:00 ${tz}, viernes)`);
  return true;
}

/**
 * Genera el mensaje de pregunta para el owner.
 */
function getWeekendQuestion() {
  const variants = [
    '🏖️ ¡Viernes! ¿Trabajás mañana o te tomás el finde? Si me decís "finde off", les digo a los leads que el lunes te contactamos.',
    '😎 Se viene el finde... ¿Querés que les avise a los leads que el lunes arrancamos? Decime "finde off" y yo me encargo.',
    '🌴 ¿Modo finde? Si querés descansar, decime "finde off" y les respondo a los leads que el lunes seguimos.',
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

/**
 * Procesa respuesta del owner al modo finde.
 * Detecta: "finde off", "finde on", "trabajo mañana", "no trabajo"
 * @returns {{ handled: boolean, response?: string }}
 */
function processWeekendResponse(ownerUid, messageBody, timezone) {
  const msg = messageBody.toLowerCase().trim();
  const tz = timezone || 'America/Bogota';

  if (msg.includes('finde off') || msg.includes('modo finde') || msg.includes('no trabajo')) {
    // Calcular próximo lunes 8:00
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const daysUntilMonday = ((8 - now.getDay()) % 7) || 7; // Próximo lunes
    const monday = new Date(now);
    monday.setDate(monday.getDate() + daysUntilMonday);
    monday.setHours(8, 0, 0, 0);

    weekendState[ownerUid] = {
      weekendOff: true,
      resumeAt: monday.toISOString(),
      askedAt: new Date().toISOString()
    };

    console.log(`[WEEKEND] 🏖️ Owner ${ownerUid} activó modo finde. Resume: ${monday.toISOString()}`);
    return {
      handled: true,
      response: `🏖️ ¡Perfecto! Modo finde activado. A los leads que escriban les voy a decir que el lunes los contactamos. Familia y equipo siguen con atención normal. ¡Descansá tranquilo!`
    };
  }

  if (msg.includes('finde on') || msg.includes('trabajo mañana') || msg.includes('sí trabajo') || msg.includes('si trabajo')) {
    weekendState[ownerUid] = { weekendOff: false, resumeAt: null, askedAt: new Date().toISOString() };
    console.log(`[WEEKEND] 💼 Owner ${ownerUid} trabaja el finde.`);
    return {
      handled: true,
      response: `💼 ¡Anotado! Sigo atendiendo leads normalmente. ¡A darle!`
    };
  }

  return { handled: false };
}

/**
 * Verifica si un lead debe recibir respuesta de "modo finde" en lugar de la normal.
 * @returns {{ blocked: boolean, autoResponse?: string }}
 */
function isWeekendBlocked(ownerUid) {
  const state = weekendState[ownerUid];
  if (!state?.weekendOff) return { blocked: false };

  const resumeAt = state.resumeAt ? new Date(state.resumeAt) : null;
  if (resumeAt && new Date() >= resumeAt) {
    // Ya pasó el lunes → desactivar automáticamente
    weekendState[ownerUid] = { weekendOff: false, resumeAt: null, askedAt: state.askedAt };
    console.log(`[WEEKEND] 🔄 Modo finde desactivado automáticamente para ${ownerUid} (lunes llegó)`);
    return { blocked: false };
  }

  return {
    blocked: true,
    autoResponse: '¡Hola! Gracias por escribir 😊 En este momento estamos fuera de horario. El lunes a primera hora te contactamos. ¡Buen fin de semana!'
  };
}

/**
 * Marca que ya se preguntó este finde (para no repetir).
 */
function markAsked(ownerUid) {
  if (!weekendState[ownerUid]) weekendState[ownerUid] = {};
  weekendState[ownerUid].askedAt = new Date().toISOString();
}

/**
 * Obtiene estado actual del modo finde para un owner.
 */
function getWeekendState(ownerUid) {
  return weekendState[ownerUid] || { weekendOff: false, resumeAt: null, askedAt: null };
}

module.exports = {
  shouldAskWeekendQuestion,
  getWeekendQuestion,
  processWeekendResponse,
  isWeekendBlocked,
  markAsked,
  getWeekendState
};
