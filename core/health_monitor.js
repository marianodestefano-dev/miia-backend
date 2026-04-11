/**
 * MIIA Health Monitor — Auto-diagnóstico y recovery desde logs internos.
 *
 * Detecta patrones problemáticos en los logs recientes y:
 * 1. Alerta al owner por self-chat con diagnóstico claro
 * 2. Auto-restart de módulos que crashearon (sport engine, followup engine)
 * 3. Detecta leads sin respuesta y notifica
 *
 * NO modifica código, configuración, tokens ni sesiones WhatsApp.
 * Solo DIAGNOSTICA y SUGIERE (o ejecuta recovery safe).
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

'use strict';

// ═══ LOG RING BUFFER ═══
// Últimos N logs para análisis de patrones
const LOG_BUFFER_SIZE = 500;
const _logBuffer = [];
let _lastAnalysis = 0;
const ANALYSIS_INTERVAL_MS = 15 * 60 * 1000; // Analizar cada 15 min

// Counters para detección de patrones
const _patternCounters = {
  vetosSeguidos: {},    // phone → count
  regeneraciones: {},   // phone → count
  badMac: 0,
  cannotAttribute: 0,
  aiErrors: 0,
  leadsNoResponse: {},  // phone → { firstSeen, count }
  lastReset: Date.now()
};

/**
 * Capturar un log entry para análisis posterior.
 * Llamar desde console.log/error wrapper.
 */
function captureLog(level, message) {
  _logBuffer.push({
    level,
    message: typeof message === 'string' ? message : String(message),
    timestamp: Date.now()
  });
  if (_logBuffer.length > LOG_BUFFER_SIZE) {
    _logBuffer.shift();
  }

  // Contadores rápidos (sin regex pesado)
  const msg = typeof message === 'string' ? message : '';
  if (msg.includes('Bad MAC')) _patternCounters.badMac++;
  if (msg.includes('cannot attribute')) _patternCounters.cannotAttribute++;
  if (msg.includes('[VETO]')) {
    const phoneMatch = msg.match(/(\d{10,15})/);
    if (phoneMatch) {
      const p = phoneMatch[1];
      _patternCounters.vetosSeguidos[p] = (_patternCounters.vetosSeguidos[p] || 0) + 1;
    }
  }
  if (msg.includes('REGENERACIÓN') || msg.includes('regeneración')) {
    const phoneMatch = msg.match(/(\d{10,15})/);
    if (phoneMatch) {
      const p = phoneMatch[1];
      _patternCounters.regeneraciones[p] = (_patternCounters.regeneraciones[p] || 0) + 1;
    }
  }
  if (msg.includes('[AI-GW]') && msg.includes('❌')) _patternCounters.aiErrors++;
}

/**
 * Ejecutar análisis de salud. Devuelve diagnóstico.
 * @param {object} opts - { safeSendMessage, ownerPhone, ownerUid }
 * @returns {object} { issues: [], healthy: boolean }
 */
async function runAnalysis(opts = {}) {
  const now = Date.now();
  if (now - _lastAnalysis < ANALYSIS_INTERVAL_MS) {
    return { issues: [], healthy: true, skipped: true };
  }
  _lastAnalysis = now;

  const issues = [];
  const windowMs = 15 * 60 * 1000; // Últimos 15 min

  // Reset counters if too old (1 hour)
  if (now - _patternCounters.lastReset > 60 * 60 * 1000) {
    _patternCounters.badMac = 0;
    _patternCounters.cannotAttribute = 0;
    _patternCounters.aiErrors = 0;
    _patternCounters.vetosSeguidos = {};
    _patternCounters.regeneraciones = {};
    _patternCounters.leadsNoResponse = {};
    _patternCounters.lastReset = now;
  }

  // ═══ PATRÓN 1: Demasiados Bad MAC → sesión corrupta ═══
  if (_patternCounters.badMac > 50) {
    issues.push({
      severity: 'high',
      type: 'crypto_errors',
      message: `${_patternCounters.badMac} errores Bad MAC en la última hora. Posible sesión corrupta. Considerar reconexión.`,
      autoRecovery: false // No auto-reconectar — riesgoso
    });
  }

  // ═══ PATRÓN 2: Vetos seguidos al mismo lead (>5) ═══
  for (const [phone, count] of Object.entries(_patternCounters.vetosSeguidos)) {
    if (count >= 5) {
      issues.push({
        severity: 'medium',
        type: 'veto_loop',
        message: `Lead ${phone} recibió ${count} vetos seguidos. MIIA no puede responderle correctamente.`,
        autoRecovery: false,
        data: { phone, count }
      });
    }
  }

  // ═══ PATRÓN 3: Muchas regeneraciones → prompt/postprocess demasiado estricto ═══
  for (const [phone, count] of Object.entries(_patternCounters.regeneraciones)) {
    if (count >= 10) {
      issues.push({
        severity: 'low',
        type: 'regen_excess',
        message: `${count} regeneraciones para ${phone}. El postprocess puede estar demasiado estricto.`,
        autoRecovery: false
      });
    }
  }

  // ═══ PATRÓN 4: Errores de IA frecuentes ═══
  if (_patternCounters.aiErrors > 10) {
    issues.push({
      severity: 'high',
      type: 'ai_failures',
      message: `${_patternCounters.aiErrors} errores de IA en la última hora. Posible problema con API keys o rate limiting.`,
      autoRecovery: false
    });
  }

  // ═══ NOTIFICAR AL OWNER si hay issues high/medium ═══
  const criticalIssues = issues.filter(i => i.severity === 'high' || i.severity === 'medium');
  if (criticalIssues.length > 0 && opts.safeSendMessage && opts.ownerPhone) {
    const alertLines = criticalIssues.map(i => {
      const icon = i.severity === 'high' ? '🔴' : '🟡';
      return `${icon} ${i.message}`;
    });
    const alertMsg = `🏥 *MIIA Health Monitor*\n\nDetecté ${criticalIssues.length} problema(s):\n\n${alertLines.join('\n\n')}\n\n_Análisis automático cada 15 min_`;
    try {
      await opts.safeSendMessage(`${opts.ownerPhone}@s.whatsapp.net`, alertMsg, { isSelfChat: true, skipEmoji: true });
      console.log(`[HEALTH-MONITOR] 🏥 Alerta enviada al owner (${criticalIssues.length} issues)`);
    } catch (e) {
      console.error(`[HEALTH-MONITOR] ❌ Error enviando alerta: ${e.message}`);
    }
  }

  const healthy = issues.filter(i => i.severity === 'high').length === 0;
  console.log(`[HEALTH-MONITOR] ${healthy ? '✅' : '🚨'} Análisis: ${issues.length} issues (${criticalIssues.length} críticos)`);

  return { issues, healthy };
}

/**
 * Auto-restart de módulos que crashearon.
 * Solo para módulos safe: sport engine, followup engine.
 * @param {object} modules - { sportEngine, followupEngine }
 */
function attemptModuleRestart(modules = {}) {
  const restarted = [];

  if (modules.sportEngine) {
    try {
      const stats = modules.sportEngine.getStats();
      // Si el engine está inicializado pero no ha polled en >30 min → posible crash
      if (stats && stats.lastPollAt && Date.now() - new Date(stats.lastPollAt).getTime() > 30 * 60 * 1000) {
        console.log(`[HEALTH-MONITOR] ♻️ Sport Engine parece muerto — reiniciando...`);
        modules.sportEngine.start();
        restarted.push('sportEngine');
      }
    } catch (e) {
      console.error(`[HEALTH-MONITOR] ❌ Error restart sportEngine: ${e.message}`);
    }
  }

  if (restarted.length > 0) {
    console.log(`[HEALTH-MONITOR] ♻️ Módulos reiniciados: ${restarted.join(', ')}`);
  }
  return restarted;
}

/**
 * Get current health stats (for dashboard/health endpoint).
 */
function getStats() {
  return {
    logBufferSize: _logBuffer.length,
    lastAnalysis: _lastAnalysis ? new Date(_lastAnalysis).toISOString() : null,
    counters: {
      badMac: _patternCounters.badMac,
      cannotAttribute: _patternCounters.cannotAttribute,
      aiErrors: _patternCounters.aiErrors,
      vetosActivos: Object.keys(_patternCounters.vetosSeguidos).length,
      regeneracionesActivas: Object.keys(_patternCounters.regeneraciones).length,
    },
    lastReset: new Date(_patternCounters.lastReset).toISOString()
  };
}

module.exports = {
  captureLog,
  runAnalysis,
  attemptModuleRestart,
  getStats,
  LOG_BUFFER_SIZE
};
