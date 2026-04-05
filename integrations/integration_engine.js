/**
 * Motor de integraciones proactivas MIIA.
 * Corre periódicamente, chequea cada integración y envía mensajes al owner.
 */
const integrationRegistry = require('./integration_registry');

let engineState = {
  ownerUid: null,
  isRunning: false,
  lastRun: 0,
  messagesSent: 0,
  deps: {}
};

// Rate limit: máx 10 mensajes proactivos por hora de integraciones
const MAX_INTEGRATION_MSGS_PER_HOUR = 10;
let hourlyMsgCount = { hour: -1, count: 0 };

/**
 * Inicializar el motor de integraciones.
 * @param {string} ownerUid
 * @param {Object} deps - { admin, generateAIContent, safeSendMessage, isWithinSchedule, getScheduleConfig, getOwnerProfile, OWNER_PHONE }
 */
function initIntegrationEngine(ownerUid, deps) {
  engineState.ownerUid = ownerUid;
  engineState.deps = deps;

  // Inyectar dependencias a todos los adapters
  for (const adapter of integrationRegistry.all()) {
    adapter.setDeps(deps);
  }

  console.log(`[INTEGRATIONS-ENGINE] 🚀 Inicializado con ${integrationRegistry.types().length} integraciones: ${integrationRegistry.types().join(', ')}`);
}

/**
 * Ciclo principal — llamado por setInterval.
 */
async function runIntegrationEngine() {
  if (!engineState.ownerUid || engineState.isRunning) return;

  const { admin, isWithinSchedule, getScheduleConfig, safeSendMessage, OWNER_PHONE } = engineState.deps;
  if (!admin || !safeSendMessage) return;

  // Gate: horario seguro
  try {
    const scheduleConfig = await getScheduleConfig(engineState.ownerUid);
    const tz = scheduleConfig?.timezone || 'America/Bogota';
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const h = localNow.getHours();
    // Safe hours configurables — default 8am-10pm, owner puede cambiar desde dashboard
    const safeStart = scheduleConfig?.integrationSafeStart ?? 8;
    const safeEnd = scheduleConfig?.integrationSafeEnd ?? 22;
    if (h < safeStart || h >= safeEnd) return;
  } catch { return; }

  // Rate limit horario
  const currentHour = new Date().getHours();
  if (hourlyMsgCount.hour !== currentHour) {
    hourlyMsgCount = { hour: currentHour, count: 0 };
  }
  if (hourlyMsgCount.count >= MAX_INTEGRATION_MSGS_PER_HOUR) return;

  engineState.isRunning = true;

  try {
    const ctx = {
      ownerUid: engineState.ownerUid,
      ownerPhone: OWNER_PHONE,
      admin
    };

    for (const adapter of integrationRegistry.all()) {
      if (!adapter.shouldCheck()) continue;
      if (hourlyMsgCount.count >= MAX_INTEGRATION_MSGS_PER_HOUR) break;

      try {
        const prefs = await adapter.getPrefs(admin, engineState.ownerUid);
        if (!prefs || prefs.enabled === false) {
          adapter.markChecked();
          continue;
        }

        const results = await adapter.check(prefs, ctx);
        adapter.markChecked();

        if (!results || results.length === 0) continue;

        for (const result of results) {
          if (hourlyMsgCount.count >= MAX_INTEGRATION_MSGS_PER_HOUR) break;
          if (result.message && result.message.length > 5) {
            await safeSendMessage(`${OWNER_PHONE}@s.whatsapp.net`, result.message, { isSelfChat: true });
            hourlyMsgCount.count++;
            engineState.messagesSent++;
            adapter._log(`Mensaje enviado: "${result.message.substring(0, 60)}..."`);
            // Delay entre mensajes
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      } catch (e) {
        adapter._error('Error en check', e);
      }
    }

    engineState.lastRun = Date.now();
  } catch (e) {
    console.error('[INTEGRATIONS-ENGINE] ❌ Error general:', e.message);
  } finally {
    engineState.isRunning = false;
  }
}

function getStats() {
  return {
    adapters: integrationRegistry.types().length,
    messagesSent: engineState.messagesSent,
    lastRun: engineState.lastRun ? new Date(engineState.lastRun).toISOString() : 'never',
    hourlyMsgCount: hourlyMsgCount.count
  };
}

module.exports = { initIntegrationEngine, runIntegrationEngine, getStats };
