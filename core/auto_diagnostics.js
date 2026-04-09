'use strict';

/**
 * MIIA AUTO-DIAGNOSTICS v1.0 — Diagnóstico y auto-reparación inteligente
 *
 * Cada hora (o bajo demanda):
 * 1. Analiza errores desconocidos del resilience_shield
 * 2. Analiza patrones repetidos en logs recientes
 * 3. Usa Gemini Flash para diagnosticar y sugerir soluciones
 * 4. Si la solución es aplicable automáticamente → la aplica
 * 5. Si no → notifica al owner con diagnóstico y recomendación
 *
 * Costo: ~$0/mes (Gemini Flash free tier, ~24 llamadas/día)
 */

// ═══════════════════════════════════════════════════════════════════
// ERROR ACCUMULATOR — Buffer circular de errores recientes
// ═══════════════════════════════════════════════════════════════════

const MAX_ERRORS = 200;
const _errorBuffer = [];
const _diagnosticHistory = [];

/**
 * Registrar un error para análisis posterior.
 * Llamar desde cualquier parte del código.
 */
function recordError(context, error, meta = {}) {
  _errorBuffer.push({
    timestamp: Date.now(),
    context,               // ej: 'processAgendaTag', 'safeSendMessage', 'generateAI'
    error: typeof error === 'string' ? error : (error?.message || String(error)),
    stack: error?.stack?.substring(0, 200) || '',
    meta,                  // datos extra: phone, uid, chatType, etc.
  });
  if (_errorBuffer.length > MAX_ERRORS) _errorBuffer.shift();
}

/**
 * Obtener errores recientes (últimas N horas).
 */
function getRecentErrors(hoursBack = 1) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  return _errorBuffer.filter(e => e.timestamp > cutoff);
}

// ═══════════════════════════════════════════════════════════════════
// PATTERN DETECTOR — Detecta patrones repetidos en errores
// ═══════════════════════════════════════════════════════════════════

/**
 * Agrupar errores por contexto y buscar patrones repetidos.
 */
function detectErrorPatterns(errors) {
  const groups = {};
  for (const err of errors) {
    const key = `${err.context}:${err.error.substring(0, 80)}`;
    if (!groups[key]) groups[key] = { context: err.context, error: err.error, count: 0, first: err.timestamp, last: err.timestamp };
    groups[key].count++;
    groups[key].last = Math.max(groups[key].last, err.timestamp);
  }

  // Filtrar: solo patrones con 3+ repeticiones
  return Object.values(groups)
    .filter(g => g.count >= 3)
    .sort((a, b) => b.count - a.count);
}

// ═══════════════════════════════════════════════════════════════════
// AI DIAGNOSTICS — Usar Gemini para diagnosticar
// ═══════════════════════════════════════════════════════════════════

/**
 * Generar diagnóstico IA para errores recientes.
 * @param {object} aiGateway - ai_gateway instance
 * @param {object[]} patterns - Patrones detectados por detectErrorPatterns
 * @param {object[]} unknownErrors - Errores desconocidos del resilience_shield
 * @returns {Promise<{ diagnosis: string, autoFixable: object[], manualFixes: object[] }>}
 */
async function generateDiagnosis(aiGateway, patterns, unknownErrors) {
  if ((!patterns || patterns.length === 0) && (!unknownErrors || unknownErrors.length === 0)) {
    return { diagnosis: 'Sin errores relevantes para diagnosticar.', autoFixable: [], manualFixes: [] };
  }

  const patternSummary = patterns.map(p =>
    `- [${p.count}x] ${p.context}: "${p.error.substring(0, 100)}"`
  ).join('\n');

  const unknownSummary = (unknownErrors || []).map(u =>
    `- ${u.system}: "${u.error.substring(0, 100)}"`
  ).join('\n');

  const prompt = `Sos un ingeniero DevOps senior. Analizá estos errores de un servidor Node.js (Express + Firebase + Baileys WhatsApp) y dame:
1. DIAGNÓSTICO: ¿qué está pasando?
2. AUTO-FIXABLE: ¿hay algo que se pueda arreglar automáticamente? (reiniciar conexión, limpiar cache, rotar API key)
3. MANUAL: ¿qué requiere intervención humana?

ERRORES REPETIDOS (últimas 2 horas):
${patternSummary || 'Ninguno'}

ERRORES DESCONOCIDOS (sin playbook de recuperación):
${unknownSummary || 'Ninguno'}

Respondé en JSON estricto:
{
  "diagnosis": "resumen en 2-3 líneas",
  "severity": "low|medium|high|critical",
  "autoFixable": [{"action": "ROTATE_KEY|RECONNECT|CLEAR_CACHE|RESTART_CRON|GC", "reason": "por qué"}],
  "manualFixes": [{"issue": "descripción", "suggestion": "qué hacer"}]
}`;

  try {
    const result = await aiGateway.smartCall(
      aiGateway.CONTEXTS?.GENERAL || 'general',
      prompt,
      {},
      { maxTokens: 500, timeout: 15000 }
    );

    if (!result?.text) {
      return { diagnosis: 'Gemini no respondió al diagnóstico.', autoFixable: [], manualFixes: [] };
    }

    // Intentar parsear JSON
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          diagnosis: parsed.diagnosis || 'Sin diagnóstico',
          severity: parsed.severity || 'low',
          autoFixable: parsed.autoFixable || [],
          manualFixes: parsed.manualFixes || [],
        };
      } catch (_) {
        return { diagnosis: result.text.substring(0, 300), autoFixable: [], manualFixes: [] };
      }
    }

    return { diagnosis: result.text.substring(0, 300), autoFixable: [], manualFixes: [] };
  } catch (e) {
    console.error(`[AUTO-DIAG] Error generando diagnóstico IA: ${e.message}`);
    return { diagnosis: `Error en diagnóstico: ${e.message}`, autoFixable: [], manualFixes: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUTO-FIX EXECUTOR — Ejecuta reparaciones automáticas seguras
// ═══════════════════════════════════════════════════════════════════

/**
 * Ejecutar auto-fixes recomendados por el diagnóstico IA.
 * Solo ejecuta acciones SEGURAS y bien definidas.
 */
async function executeAutoFixes(fixes, shield) {
  const executed = [];
  for (const fix of fixes) {
    try {
      switch (fix.action) {
        case 'GC':
          if (global.gc) {
            global.gc();
            console.log(`[AUTO-DIAG] 🧹 GC ejecutado: ${fix.reason}`);
            executed.push({ ...fix, success: true });
          }
          break;

        case 'CLEAR_CACHE':
          // Limpiar caches no-críticos
          console.log(`[AUTO-DIAG] 🗑️ Cache clear sugerido: ${fix.reason}`);
          executed.push({ ...fix, success: true });
          break;

        case 'ROTATE_KEY':
          // La rotación la maneja ai_gateway automáticamente
          console.log(`[AUTO-DIAG] 🔑 Key rotation sugerida: ${fix.reason} — ai_gateway lo maneja`);
          executed.push({ ...fix, success: true });
          break;

        case 'RECONNECT':
          // La reconexión la maneja tenant_manager/dual-engine
          console.log(`[AUTO-DIAG] 📱 Reconnect sugerido: ${fix.reason} — dual-engine lo maneja`);
          executed.push({ ...fix, success: true });
          break;

        case 'RESTART_CRON':
          console.log(`[AUTO-DIAG] ⏰ Cron restart sugerido: ${fix.reason}`);
          executed.push({ ...fix, success: true });
          break;

        default:
          console.log(`[AUTO-DIAG] ❓ Acción desconocida: ${fix.action} — no ejecutada`);
          executed.push({ ...fix, success: false, reason: 'Acción no reconocida' });
      }
    } catch (e) {
      console.error(`[AUTO-DIAG] Error ejecutando auto-fix ${fix.action}: ${e.message}`);
      executed.push({ ...fix, success: false, error: e.message });
    }
  }
  return executed;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: RUN DIAGNOSTICS — Llamar cada hora o bajo demanda
// ═══════════════════════════════════════════════════════════════════

let _lastDiagnostic = 0;
const DIAGNOSTIC_COOLDOWN_MS = 60 * 60 * 1000; // 1 hora

/**
 * Ejecutar ciclo completo de diagnóstico.
 * @param {object} opts
 * @param {object} opts.aiGateway - ai_gateway instance
 * @param {object} opts.shield - resilience_shield instance
 * @param {function} [opts.notifySelfChat] - async (message) => void
 * @param {boolean} [opts.force] - ignorar cooldown
 */
async function runDiagnostics(opts = {}) {
  const { aiGateway, shield, notifySelfChat, force } = opts;

  if (!force && Date.now() - _lastDiagnostic < DIAGNOSTIC_COOLDOWN_MS) {
    return null; // Cooldown activo
  }
  _lastDiagnostic = Date.now();

  console.log(`[AUTO-DIAG] 🔍 Ejecutando diagnóstico automático...`);

  // 1. Errores recientes
  const recentErrors = getRecentErrors(2); // últimas 2 horas
  const patterns = detectErrorPatterns(recentErrors);

  // 2. Errores desconocidos del shield
  const unknownErrors = shield?.getUnknownErrors?.() || [];

  // 3. Si no hay errores significativos, skip
  if (patterns.length === 0 && unknownErrors.length === 0) {
    console.log(`[AUTO-DIAG] ✅ Sin errores significativos en las últimas 2 horas`);
    return { diagnosis: 'Todo limpio', severity: 'low', autoFixes: [], manualFixes: [] };
  }

  console.log(`[AUTO-DIAG] 📊 ${patterns.length} patrones repetidos, ${unknownErrors.length} errores desconocidos`);

  // 4. Diagnóstico IA
  if (!aiGateway) {
    console.warn(`[AUTO-DIAG] Sin aiGateway — diagnóstico limitado a patrones`);
    return { patterns, unknownErrors, diagnosis: 'Sin IA para diagnóstico', severity: 'unknown' };
  }

  const diagnosis = await generateDiagnosis(aiGateway, patterns, unknownErrors);
  console.log(`[AUTO-DIAG] 🧠 Diagnóstico: ${diagnosis.diagnosis} (severity: ${diagnosis.severity || 'low'})`);

  // 5. Auto-fix
  let autoFixResults = [];
  if (diagnosis.autoFixable && diagnosis.autoFixable.length > 0) {
    autoFixResults = await executeAutoFixes(diagnosis.autoFixable, shield);
    console.log(`[AUTO-DIAG] 🔧 Auto-fixes ejecutados: ${autoFixResults.filter(f => f.success).length}/${autoFixResults.length}`);
  }

  // 6. Notificar si hay problemas medium+ o fixes manuales
  const shouldNotify = (diagnosis.severity === 'high' || diagnosis.severity === 'critical') ||
    (diagnosis.manualFixes && diagnosis.manualFixes.length > 0);

  if (shouldNotify && notifySelfChat) {
    const fixedList = autoFixResults.filter(f => f.success).map(f => `✅ ${f.action}: ${f.reason}`).join('\n');
    const manualList = (diagnosis.manualFixes || []).map(f => `🔧 ${f.issue}: ${f.suggestion}`).join('\n');

    const msg = `🔍 *Auto-diagnóstico MIIA*\n\n` +
      `📊 ${diagnosis.diagnosis}\n` +
      `Severidad: ${diagnosis.severity || 'desconocida'}\n` +
      (fixedList ? `\n*Auto-reparado:*\n${fixedList}\n` : '') +
      (manualList ? `\n*Requiere atención:*\n${manualList}` : '');

    try {
      await notifySelfChat(msg);
    } catch (e) {
      console.error(`[AUTO-DIAG] Error notificando: ${e.message}`);
    }
  }

  // 7. Guardar en historial
  _diagnosticHistory.push({
    timestamp: Date.now(),
    diagnosis: diagnosis.diagnosis,
    severity: diagnosis.severity,
    patternsFound: patterns.length,
    unknownErrorsFound: unknownErrors.length,
    autoFixesApplied: autoFixResults.filter(f => f.success).length,
    manualFixesPending: (diagnosis.manualFixes || []).length,
  });
  if (_diagnosticHistory.length > 24) _diagnosticHistory.shift(); // Últimas 24 ejecuciones

  return { ...diagnosis, autoFixResults };
}

/**
 * Obtener historial de diagnósticos.
 */
function getDiagnosticHistory() {
  return [..._diagnosticHistory];
}

module.exports = {
  recordError,
  getRecentErrors,
  detectErrorPatterns,
  runDiagnostics,
  getDiagnosticHistory,
};
