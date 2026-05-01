'use strict';
/**
 * MIIA — Session Analytics (T117)
 * Agrupa mensajes en sesiones (gap > 30min = nueva sesión).
 * Calcula métricas: count, avgDuration, avgMessagesPerSession.
 */

const SESSION_GAP_MS = 30 * 60 * 1000; // 30 minutos

/**
 * Agrupa mensajes en sesiones basado en gaps temporales.
 * @param {Array<{timestamp?: number}>} messages
 * @param {number} [gapMs]
 */
function groupIntoSessions(messages, gapMs = SESSION_GAP_MS) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const sorted = messages
    .filter(m => typeof m.timestamp === 'number')
    .sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) return [];

  const sessions = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].timestamp - sorted[i-1].timestamp;
    if (gap > gapMs) {
      sessions.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  sessions.push(current);
  return sessions;
}

/**
 * Calcula métricas de sesiones.
 */
function calculateSessionMetrics(messages, gapMs = SESSION_GAP_MS) {
  if (!Array.isArray(messages)) return { sessionCount: 0, avgDurationMs: 0, avgMessagesPerSession: 0 };
  const sessions = groupIntoSessions(messages, gapMs);
  if (sessions.length === 0) return { sessionCount: 0, avgDurationMs: 0, avgMessagesPerSession: 0 };

  const durations = sessions.map(s => {
    if (s.length < 2) return 0;
    return s[s.length - 1].timestamp - s[0].timestamp;
  });

  const avgDurationMs = Math.round(durations.reduce((s, d) => s + d, 0) / sessions.length);
  const avgMessages = Math.round(sessions.reduce((s, sess) => s + sess.length, 0) / sessions.length);

  return {
    sessionCount: sessions.length,
    avgDurationMs,
    avgMessagesPerSession: avgMessages,
  };
}

module.exports = { groupIntoSessions, calculateSessionMetrics, SESSION_GAP_MS };
