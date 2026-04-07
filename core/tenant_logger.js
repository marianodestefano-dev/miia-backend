'use strict';

/**
 * TENANT_LOGGER.JS — Logger centralizado con identificación por tenant
 *
 * ESTÁNDAR: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * PROPÓSITO:
 *   Cada línea de log incluye el UID del tenant (abreviado a 8 chars para legibilidad).
 *   Cuando haya 500 tenants, podés buscar "uid:bq2BbtCV" y ver solo lo de ese cliente.
 *
 * USO:
 *   const { tlog, terror, twarn, tmetric } = require('./core/tenant_logger');
 *   tlog(uid, 'MIIA', 'Respuesta enviada a lead');          → [uid:bq2BbtCV] [MIIA] Respuesta enviada a lead
 *   terror(uid, 'MIIA', 'Error generando respuesta', err);  → [uid:bq2BbtCV] [MIIA] ❌ Error generando respuesta: ...
 *   twarn(uid, 'WA', 'Reconexión necesaria');                → [uid:bq2BbtCV] [WA] ⚠️ Reconexión necesaria
 *   tmetric(uid, 'message_processed', { phone, responseMs }); → Registra métrica sin loguear
 *
 * MÉTRICAS EN MEMORIA:
 *   Acumula contadores por tenant. Cada 60s se flushean a Firestore.
 *   Esto permite: errores/hora, mensajes/día, tokens/día, reconexiones, tiempos de respuesta.
 *
 * COMPATIBLE CON:
 *   - Railway logs (buscar por "uid:XXXX")
 *   - Better Stack / Datadog (parsean el tag automáticamente)
 *   - Admin dashboard (endpoint /api/admin/tenant-health)
 *
 * REGLA: NUNCA loguear datos sensibles del usuario (mensajes, teléfonos completos, API keys)
 */

const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

const UID_DISPLAY_LENGTH = 8;       // Chars del UID a mostrar en logs (legibilidad)
const METRICS_FLUSH_INTERVAL = 60_000;  // Flush cada 60s
const METRICS_COLLECTION = 'miia_metrics';
const DAILY_DOC_PREFIX = 'daily_';

// ═══════════════════════════════════════════════════════════════
// MÉTRICAS EN MEMORIA
// ═══════════════════════════════════════════════════════════════

/**
 * Estructura de métricas por tenant:
 * {
 *   'bq2BbtCV...': {
 *     messagesProcessed: 47,
 *     messagesFromLeads: 30,
 *     messagesFromFamily: 10,
 *     messagesFromOwner: 7,
 *     aiCalls: 40,
 *     aiTokensEstimated: 15000,
 *     errors: 2,
 *     errorDetails: ['processMiiaResponse: msg undefined', 'Gemini timeout'],
 *     warnings: 5,
 *     whatsappReconnections: 1,
 *     safetyCritical: 0,
 *     safetyBlocked: 0,
 *     outreachSent: 0,
 *     agendaEvents: 3,
 *     responseTimesMs: [2100, 3400, 1800, ...],
 *     lastActivity: 1775592284000,
 *     lastError: null,
 *     whatsappConnected: true,
 *     _dirty: true,  // Tiene datos no flusheados
 *   }
 * }
 */
const metrics = {};

// Mapeo uid → nombre del owner (para el dashboard)
const tenantNames = {};

// Timer de auto-flush
let _flushTimer = null;

// ═══════════════════════════════════════════════════════════════
// FUNCIONES DE LOGGING
// ═══════════════════════════════════════════════════════════════

/**
 * Abreviar UID para legibilidad en logs
 */
function shortUid(uid) {
  if (!uid) return 'SYSTEM';
  return uid.substring(0, UID_DISPLAY_LENGTH);
}

/**
 * Obtener fecha actual como string YYYY-MM-DD (para key de métricas diarias)
 */
function todayKey() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Inicializar métricas para un tenant si no existen
 */
function ensureMetrics(uid) {
  if (!uid) return;
  if (!metrics[uid]) {
    metrics[uid] = {
      messagesProcessed: 0,
      messagesFromLeads: 0,
      messagesFromFamily: 0,
      messagesFromOwner: 0,
      aiCalls: 0,
      aiTokensEstimated: 0,
      errors: 0,
      errorDetails: [],
      warnings: 0,
      whatsappReconnections: 0,
      safetyCritical: 0,
      safetyBlocked: 0,
      outreachSent: 0,
      agendaEvents: 0,
      responseTimesMs: [],
      lastActivity: Date.now(),
      lastError: null,
      whatsappConnected: false,
      _dirty: false,
      _date: todayKey(),
    };
  }
  // Reset diario: si cambió el día, guardar métricas del día anterior y resetear
  const today = todayKey();
  if (metrics[uid]._date !== today) {
    // Flush del día anterior ocurrirá en el próximo ciclo de auto-flush
    metrics[uid]._dirty = true;
    // Después resetear para el nuevo día
    const prevDate = metrics[uid]._date;
    console.log(`[TENANT-LOG] 📅 Nuevo día detectado para ${shortUid(uid)}: ${prevDate} → ${today}`);
  }
}

/**
 * Log info con tag de tenant
 * @param {string} uid - UID del tenant (null = sistema)
 * @param {string} module - Módulo origen (MIIA, WA, OUTFIT, etc.)
 * @param {string} message - Mensaje
 * @param {...any} args - Argumentos adicionales
 */
function tlog(uid, module, message, ...args) {
  const tag = uid ? `[uid:${shortUid(uid)}]` : '[SYSTEM]';
  if (args.length > 0) {
    console.log(`${tag} [${module}] ${message}`, ...args);
  } else {
    console.log(`${tag} [${module}] ${message}`);
  }
  if (uid) {
    ensureMetrics(uid);
    metrics[uid].lastActivity = Date.now();
  }
}

/**
 * Log error con tag de tenant — SIEMPRE loguea, NUNCA silencia
 * @param {string} uid
 * @param {string} module
 * @param {string} message
 * @param {Error|string} [error]
 */
function terror(uid, module, message, error) {
  const tag = uid ? `[uid:${shortUid(uid)}]` : '[SYSTEM]';
  const errMsg = error instanceof Error ? error.message : (error || '');
  const errStack = error instanceof Error ? error.stack : '';
  console.error(`${tag} [${module}] ❌ ${message}${errMsg ? ': ' + errMsg : ''}`);
  if (errStack) console.error(`${tag} [${module}] Stack: ${errStack}`);

  if (uid) {
    ensureMetrics(uid);
    metrics[uid].errors++;
    metrics[uid].lastError = {
      module,
      message: `${message}${errMsg ? ': ' + errMsg : ''}`,
      timestamp: Date.now(),
    };
    // Guardar últimos 20 errores (no infinito)
    metrics[uid].errorDetails.push(`${module}: ${message}${errMsg ? ' — ' + errMsg : ''}`);
    if (metrics[uid].errorDetails.length > 20) metrics[uid].errorDetails.shift();
    metrics[uid]._dirty = true;
  }
}

/**
 * Log warning con tag de tenant
 */
function twarn(uid, module, message, ...args) {
  const tag = uid ? `[uid:${shortUid(uid)}]` : '[SYSTEM]';
  if (args.length > 0) {
    console.warn(`${tag} [${module}] ⚠️ ${message}`, ...args);
  } else {
    console.warn(`${tag} [${module}] ⚠️ ${message}`);
  }
  if (uid) {
    ensureMetrics(uid);
    metrics[uid].warnings++;
    metrics[uid]._dirty = true;
  }
}

/**
 * Registrar una métrica específica sin loguear al stdout
 * Uso: tmetric(uid, 'message_processed', { type: 'lead', responseMs: 3200 })
 */
function tmetric(uid, eventType, data = {}) {
  if (!uid) return;
  ensureMetrics(uid);
  const m = metrics[uid];
  m._dirty = true;
  m.lastActivity = Date.now();

  switch (eventType) {
    case 'message_processed':
      m.messagesProcessed++;
      if (data.type === 'lead') m.messagesFromLeads++;
      else if (data.type === 'family') m.messagesFromFamily++;
      else if (data.type === 'owner') m.messagesFromOwner++;
      if (data.responseMs) {
        m.responseTimesMs.push(data.responseMs);
        // Mantener solo últimos 100 para cálculo de promedio
        if (m.responseTimesMs.length > 100) m.responseTimesMs.shift();
      }
      break;

    case 'ai_call':
      m.aiCalls++;
      if (data.tokensEstimated) m.aiTokensEstimated += data.tokensEstimated;
      break;

    case 'whatsapp_connected':
      m.whatsappConnected = true;
      break;

    case 'whatsapp_disconnected':
      m.whatsappConnected = false;
      m.whatsappReconnections++;
      break;

    case 'safety_blocked':
      m.safetyBlocked++;
      break;

    case 'safety_critical':
      m.safetyCritical++;
      break;

    case 'outreach_sent':
      m.outreachSent += (data.count || 1);
      break;

    case 'agenda_event':
      m.agendaEvents++;
      break;

    default:
      // Métrica genérica: guardar como key-value
      m[`custom_${eventType}`] = (m[`custom_${eventType}`] || 0) + 1;
      break;
  }
}

/**
 * Registrar nombre del tenant (para mostrar en dashboard)
 */
function registerTenantName(uid, name) {
  if (uid && name) tenantNames[uid] = name;
}

// ═══════════════════════════════════════════════════════════════
// FLUSH A FIRESTORE
// ═══════════════════════════════════════════════════════════════

/**
 * Flush de métricas acumuladas a Firestore.
 * Se guarda en: users/{uid}/miia_metrics/daily_YYYY-MM-DD
 */
async function flushMetrics() {
  const today = todayKey();
  let flushed = 0;

  for (const [uid, m] of Object.entries(metrics)) {
    if (!m._dirty) continue;

    try {
      const avgResponseMs = m.responseTimesMs.length > 0
        ? Math.round(m.responseTimesMs.reduce((a, b) => a + b, 0) / m.responseTimesMs.length)
        : 0;

      const docRef = admin.firestore()
        .collection('users').doc(uid)
        .collection(METRICS_COLLECTION).doc(`${DAILY_DOC_PREFIX}${today}`);

      // Merge con datos existentes (otro worker podría estar escribiendo)
      await docRef.set({
        date: today,
        messagesProcessed: admin.firestore.FieldValue.increment(m.messagesProcessed),
        messagesFromLeads: admin.firestore.FieldValue.increment(m.messagesFromLeads),
        messagesFromFamily: admin.firestore.FieldValue.increment(m.messagesFromFamily),
        messagesFromOwner: admin.firestore.FieldValue.increment(m.messagesFromOwner),
        aiCalls: admin.firestore.FieldValue.increment(m.aiCalls),
        aiTokensEstimated: admin.firestore.FieldValue.increment(m.aiTokensEstimated),
        errors: admin.firestore.FieldValue.increment(m.errors),
        warnings: admin.firestore.FieldValue.increment(m.warnings),
        whatsappReconnections: admin.firestore.FieldValue.increment(m.whatsappReconnections),
        safetyBlocked: admin.firestore.FieldValue.increment(m.safetyBlocked),
        safetyCritical: admin.firestore.FieldValue.increment(m.safetyCritical),
        outreachSent: admin.firestore.FieldValue.increment(m.outreachSent),
        agendaEvents: admin.firestore.FieldValue.increment(m.agendaEvents),
        avgResponseMs,
        lastActivity: m.lastActivity,
        lastError: m.lastError,
        whatsappConnected: m.whatsappConnected,
        recentErrors: m.errorDetails.slice(-10), // Últimos 10 errores
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // Resetear contadores (no acumular entre flushes)
      m.messagesProcessed = 0;
      m.messagesFromLeads = 0;
      m.messagesFromFamily = 0;
      m.messagesFromOwner = 0;
      m.aiCalls = 0;
      m.aiTokensEstimated = 0;
      m.errors = 0;
      m.warnings = 0;
      m.whatsappReconnections = 0;
      m.safetyBlocked = 0;
      m.safetyCritical = 0;
      m.outreachSent = 0;
      m.agendaEvents = 0;
      m.errorDetails = [];
      m._dirty = false;
      m._date = today;
      flushed++;
    } catch (e) {
      console.error(`[TENANT-LOG] ❌ Error flushing metrics para ${shortUid(uid)}: ${e.message}`);
    }
  }

  if (flushed > 0) {
    console.log(`[TENANT-LOG] 📊 Métricas flusheadas: ${flushed} tenant(s)`);
  }
}

/**
 * Iniciar auto-flush periódico
 */
function startAutoFlush() {
  if (_flushTimer) clearInterval(_flushTimer);
  _flushTimer = setInterval(() => {
    flushMetrics().catch(e => console.error(`[TENANT-LOG] ❌ Auto-flush error: ${e.message}`));
  }, METRICS_FLUSH_INTERVAL);
  console.log(`[TENANT-LOG] 🟢 Auto-flush iniciado (cada ${METRICS_FLUSH_INTERVAL / 1000}s)`);
}

// ═══════════════════════════════════════════════════════════════
// CONSULTAS — Para admin dashboard y endpoint health
// ═══════════════════════════════════════════════════════════════

/**
 * Obtener salud de TODOS los tenants (para /api/admin/tenant-health)
 * @returns {object[]} Array de objetos con salud por tenant
 */
function getAllTenantsHealth() {
  const result = [];
  for (const [uid, m] of Object.entries(metrics)) {
    const avgResponseMs = m.responseTimesMs.length > 0
      ? Math.round(m.responseTimesMs.reduce((a, b) => a + b, 0) / m.responseTimesMs.length)
      : 0;

    // Determinar estado: 🟢 ok, 🟡 warning, 🔴 critical
    let status = 'ok';
    let statusEmoji = '🟢';
    if (!m.whatsappConnected) {
      status = 'critical';
      statusEmoji = '🔴';
    } else if (m.errors > 5 || m.safetyCritical > 0) {
      status = 'critical';
      statusEmoji = '🔴';
    } else if (m.errors > 0 || m.warnings > 10 || avgResponseMs > 10000) {
      status = 'warning';
      statusEmoji = '🟡';
    }

    result.push({
      uid,
      shortUid: shortUid(uid),
      name: tenantNames[uid] || shortUid(uid),
      status,
      statusEmoji,
      whatsappConnected: m.whatsappConnected,
      messagesProcessed: m.messagesProcessed,
      errors: m.errors,
      warnings: m.warnings,
      lastError: m.lastError,
      safetyCritical: m.safetyCritical,
      safetyBlocked: m.safetyBlocked,
      avgResponseMs,
      lastActivity: m.lastActivity,
      lastActivityAgo: Date.now() - m.lastActivity,
    });
  }

  // Ordenar: critical primero, luego warning, luego ok
  const order = { critical: 0, warning: 1, ok: 2 };
  result.sort((a, b) => order[a.status] - order[b.status]);
  return result;
}

/**
 * Obtener salud de UN tenant específico
 */
function getTenantHealth(uid) {
  if (!metrics[uid]) return null;
  return getAllTenantsHealth().find(t => t.uid === uid) || null;
}

/**
 * Obtener métricas históricas de un tenant (últimos N días desde Firestore)
 */
async function getTenantHistory(uid, days = 7) {
  try {
    const snap = await admin.firestore()
      .collection('users').doc(uid)
      .collection(METRICS_COLLECTION)
      .orderBy('date', 'desc')
      .limit(days)
      .get();
    return snap.docs.map(d => d.data());
  } catch (e) {
    console.error(`[TENANT-LOG] ❌ Error leyendo historial de ${shortUid(uid)}: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Logging
  tlog,
  terror,
  twarn,
  tmetric,

  // Config
  registerTenantName,
  ensureMetrics,
  shortUid,

  // Flush
  startAutoFlush,
  flushMetrics,

  // Consultas
  getAllTenantsHealth,
  getTenantHealth,
  getTenantHistory,
};
