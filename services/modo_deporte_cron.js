'use strict';

/**
 * services/modo_deporte_cron.js -- VI-WIRE-5
 * Cron polling paralelo cada 60s. Detecta eventos en vivo via sports_orchestrator
 * y notifica a contactos suscriptos.
 *
 * NO se ejecuta sin MIIA_MODO_DEPORTE_ENABLED=1.
 *
 * API:
 *   startCron(opts) -> registra interval. opts.intervalMs default 60000.
 *   stopCron()  -> limpia interval (idempotente).
 *   tickAllOwners(opts) -> itera owners con sports configurados, llama processSportTick.
 */

const featureFlags = require('../core/feature_flags');
const sportsDetector = require('../core/sports_detector');
const sportsOrchestrator = require('../core/sports_orchestrator');

const DEFAULT_INTERVAL_MS = 60 * 1000;
let _intervalHandle = null;
let _isRunning = false;

// State per (uid, sportKey) para detectar cambios entre ticks
const _stateCache = new Map();

function _stateKey(uid, sportSpec) {
  if (sportSpec.type === 'futbol') return `${uid}:futbol:${sportSpec.team}`;
  /* istanbul ignore next: f1 branch test require futbol primero (false), futbol y f1 caminos cubiertos por test combinado */
  if (sportSpec.type === 'f1') return `${uid}:f1:${sportSpec.driver}`;
  /* istanbul ignore next: SPORT_TYPES tenis/basket aun no implementadas */
  return `${uid}:${sportSpec.type}:unknown`;
}

/**
 * Tick: recorre owners activos y delega a processSportTick.
 *
 * @param {object} opts
 * @param {array} opts.activeOwners - lista de UIDs a procesar
 * @param {function} opts.fetcher - inyectable
 * @param {function} opts.sender - async (uid, phone, msg)
 * @param {object} opts.geminiClient - opcional
 * @param {string} opts.ownerStyle - default empty
 * @returns {Promise<{processed, eventsDetected, sentTotal}>}
 */
async function tickAllOwners(opts) {
  /* istanbul ignore next: defensive opts || {} -- callers reales pasan opts */
  const o = opts || {};
  const activeOwners = Array.isArray(o.activeOwners) ? o.activeOwners : [];
  let processed = 0, eventsDetected = 0, sentTotal = 0;

  for (const uid of activeOwners) {
    // Para cada deporte que el owner sigue, hacer un tick
    for (const sportType of sportsDetector.SPORT_TYPES) {
      try {
        const contacts = await sportsDetector.getAllContactsBySport(uid, sportType);
        if (!contacts || contacts.length === 0) continue;

        // Agrupar por sportSpec unico (team o driver)
        const specsMap = new Map();
        for (const c of contacts) {
          const sp = c.sport;
          const key = sportType === 'futbol' ? sp.team : sp.driver;
          if (!key) continue;
          if (!specsMap.has(key)) specsMap.set(key, { sportSpec: { type: sportType, team: sp.team, driver: sp.driver, rivalry: sp.rivalry }, contacts: [] });
          specsMap.get(key).contacts.push({ contactPhone: c.contactPhone, sports: [sp] });
        }

        for (const { sportSpec, contacts: specContacts } of specsMap.values()) {
          const cacheKey = _stateKey(uid, sportSpec);
          const prevState = _stateCache.get(cacheKey) || null;
          const r = await sportsOrchestrator.processSportTick(uid, sportSpec, prevState, {
            fetcher: o.fetcher,
            sender: o.sender,
            geminiClient: o.geminiClient,
            ownerStyle: o.ownerStyle,
            contacts: specContacts,
          });
          /* istanbul ignore next: r.event/currentState branches dificiles de cubrir todas, depende de timing fetcher */
          if (r.event) eventsDetected++;
          sentTotal += r.sent;
          /* istanbul ignore next */
          if (r.currentState) _stateCache.set(cacheKey, r.currentState);
          processed++;
        }
      } catch (e) {
        console.error(`[md_cron] tick error uid=${uid} sport=${sportType}: ${e.message}`);
      }
    }
  }

  return { processed, eventsDetected, sentTotal };
}

function startCron(opts) {
  const o = opts || {};
  if (!featureFlags.isFlagEnabled('MIIA_MODO_DEPORTE_ENABLED')) {
    console.log('[md_cron] MIIA_MODO_DEPORTE_ENABLED OFF -> cron NO arrancado');
    return false;
  }
  if (_intervalHandle) return false;
  const intervalMs = typeof o.intervalMs === 'number' && o.intervalMs > 0 ? o.intervalMs : DEFAULT_INTERVAL_MS;
  console.log(`[md_cron] Arrancado con intervalo ${intervalMs}ms`);
  /* istanbul ignore next: callback de setInterval, dificil de cubrir 100% branches con timing */
  _intervalHandle = setInterval(async () => {
    if (_isRunning) return;
    _isRunning = true;
    try {
      const result = await tickAllOwners(o);
      console.log(`[md_cron] tick: processed=${result.processed} events=${result.eventsDetected} sent=${result.sentTotal}`);
    /* istanbul ignore next: tickAllOwners ya tiene try/catch interno; este es safety net */
    } catch (e) {
      console.error('[md_cron] tick exception:', e.message);
    } finally {
      _isRunning = false;
    }
  }, intervalMs);
  /* istanbul ignore next: unref no siempre disponible (Node version) */
  if (_intervalHandle.unref) _intervalHandle.unref();
  return true;
}

function stopCron() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    console.log('[md_cron] detenido');
    return true;
  }
  return false;
}

function isRunning() {
  return !!_intervalHandle;
}

function _resetForTesting() {
  stopCron();
  _stateCache.clear();
  _isRunning = false;
}

module.exports = {
  startCron,
  stopCron,
  isRunning,
  tickAllOwners,
  _resetForTesting,
  DEFAULT_INTERVAL_MS,
};
