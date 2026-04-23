'use strict';

/**
 * MIIA Proposal Scheduler — B.10 (C-398.E)
 *
 * Orquesta propuestas proactivas de MIIA al owner en self-chat.
 * "MIIA propone nada" era el bug: la asistente nunca sugería por sí misma
 * (cenas, outings, reconectar con contactos lejanos, recordatorios blandos).
 *
 * Arquitectura de plugins: cada tipo de propuesta implementa una interfaz
 * común (evaluate → maybePropose). El scheduler recolecta señales y decide
 * cuándo + qué proponer respetando rate limiting y safe hours.
 *
 * NO ACTIVO por default — server.js debe llamar a initProposalScheduler +
 * scheduleTick explícitamente. Sin wiring el módulo no hace nada.
 *
 * Standard: Google + Amazon + Apple + NASA — fail loudly, observable.
 */

const admin = require('firebase-admin');

// ═══ CONSTANTES ═══
const MAX_PROPOSALS_PER_DAY = 3;              // Rate limit: máx 3 propuestas/día al owner
const MIN_HOURS_BETWEEN_PROPOSALS = 4;         // Mín 4h entre propuestas
const STATE_SYNC_DEBOUNCE_MS = 60 * 1000;      // Sync estado a Firestore cada 60s

// ═══ ESTADO EN MEMORIA ═══
const schedulerState = {
  /** @type {string|null} */
  ownerUid: null,
  /** @type {boolean} */
  isRunning: false,
  /** @type {Array<ProposalPlugin>} */
  plugins: [],
  /** @type {number|null} */
  lastTickAt: null,
  /** @type {number|null} */
  lastStateSyncAt: null,
  /** @type {Object.<string, number>} */
  lastProposalByType: {},                       // type → timestamp
  /** @type {Array<{type:string, at:number}>} */
  dailyHistory: [],                             // propuestas lanzadas en las últimas 24h
};

// Contador monotónico de ticks para observabilidad (paridad B.1/B.9)
let _proposalTickCount = 0;

// ═══ DEPENDENCIAS INYECTADAS ═══
const _deps = {
  sendToOwner: null,        // async (text) => void  — envía al self-chat del owner
  generateAIContent: null,  // async (prompt, opts) => string
  isWithinSchedule: null,   // (config) => boolean
  isSystemPaused: null,     // () => boolean
  getScheduleConfig: null,  // async (uid) => object
  getOwnerProfile: null,    // async (uid) => object
};

/**
 * @typedef {object} ProposalPlugin
 * @property {string} type — identificador único (ej: 'stale_contact', 'friday_night')
 * @property {string} displayName
 * @property {number} cooldownHours — horas mínimas entre propuestas del mismo tipo
 * @property {function(ctx): Promise<{shouldPropose:boolean, payload?:any, reason?:string}>} evaluate
 * @property {function(ctx, payload): Promise<{message:string, generated:boolean}>} buildProposal
 */

/**
 * Registra un plugin de propuesta.
 * @param {ProposalPlugin} plugin
 */
function registerProposal(plugin) {
  if (!plugin || !plugin.type || typeof plugin.evaluate !== 'function' || typeof plugin.buildProposal !== 'function') {
    throw new Error('[PROPOSAL-SCHEDULER] plugin inválido: requiere {type, evaluate, buildProposal}');
  }
  if (schedulerState.plugins.find(p => p.type === plugin.type)) {
    console.warn(`[PROPOSAL-SCHEDULER] ⚠️ plugin duplicado ignorado: ${plugin.type}`);
    return;
  }
  plugin.cooldownHours = plugin.cooldownHours || 24;
  schedulerState.plugins.push(plugin);
  console.log(`[PROPOSAL-SCHEDULER] ✅ plugin registrado: ${plugin.type} (${plugin.displayName || '—'}) cooldown=${plugin.cooldownHours}h`);
}

/**
 * Inicializa el scheduler con dependencias y restaura estado desde Firestore.
 * @param {string} ownerUid
 * @param {object} deps
 */
async function initProposalScheduler(ownerUid, deps = {}) {
  schedulerState.ownerUid = ownerUid;
  Object.assign(_deps, deps);

  try {
    const stateDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_proposals_state').doc('scheduler')
      .get();
    if (stateDoc.exists) {
      const saved = stateDoc.data();
      schedulerState.lastProposalByType = saved.lastProposalByType || {};
      schedulerState.dailyHistory = Array.isArray(saved.dailyHistory) ? saved.dailyHistory : [];
    }
  } catch (err) {
    console.error(`[PROPOSAL-SCHEDULER] error restaurando estado: ${err.message}`);
  }

  console.log(`[PROPOSAL-SCHEDULER] ✅ inicializado uid=${ownerUid} plugins=${schedulerState.plugins.length}`);
}

/**
 * Limpia propuestas antiguas (>24h) de dailyHistory.
 */
function _pruneDailyHistory() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  schedulerState.dailyHistory = schedulerState.dailyHistory.filter(p => p.at >= cutoff);
}

/**
 * Verifica si el scheduler puede proponer ahora (rate limits globales).
 * @returns {{ok:boolean, reason?:string}}
 */
function _canProposeNow() {
  _pruneDailyHistory();
  if (schedulerState.dailyHistory.length >= MAX_PROPOSALS_PER_DAY) {
    return { ok: false, reason: 'daily_limit_reached' };
  }
  if (schedulerState.dailyHistory.length > 0) {
    const last = schedulerState.dailyHistory[schedulerState.dailyHistory.length - 1];
    const hoursSince = (Date.now() - last.at) / (60 * 60 * 1000);
    if (hoursSince < MIN_HOURS_BETWEEN_PROPOSALS) {
      return { ok: false, reason: `cooldown_global_${hoursSince.toFixed(1)}h` };
    }
  }
  return { ok: true };
}

/**
 * Verifica si el plugin respeta su cooldown individual.
 */
function _pluginCooldownOk(plugin) {
  const last = schedulerState.lastProposalByType[plugin.type];
  if (!last) return true;
  const hoursSince = (Date.now() - last) / (60 * 60 * 1000);
  return hoursSince >= plugin.cooldownHours;
}

/**
 * Tick principal — evalúa todos los plugins y potencialmente lanza UNA propuesta.
 * NUNCA lanza excepción — todo error se logea y continúa.
 */
async function runProposalScheduler() {
  if (schedulerState.isRunning) return;
  if (!schedulerState.ownerUid) return;

  // Gates globales
  if (_deps.isSystemPaused && _deps.isSystemPaused()) return;
  if (_deps.getScheduleConfig && _deps.isWithinSchedule) {
    try {
      const cfg = await _deps.getScheduleConfig(schedulerState.ownerUid);
      if (!_deps.isWithinSchedule(cfg)) return;
    } catch (err) {
      console.warn(`[PROPOSAL-SCHEDULER] no se pudo verificar schedule: ${err.message}`);
    }
  }

  schedulerState.isRunning = true;
  const tickStart = Date.now();
  _proposalTickCount++;
  const tickId = `PT${_proposalTickCount}`;

  const tally = {
    pluginsEvaluated: 0,
    pluginsSkippedCooldown: 0,
    pluginsMatched: 0,
    proposalsSent: 0,
    globalLimitHit: false,
    errored: 0,
  };

  try {
    const plugins = schedulerState.plugins;
    console.log(`[PROPOSAL-SCHEDULER][${tickId}] 🔍 tick start plugins=${plugins.length} dailyHistory=${schedulerState.dailyHistory.length}/${MAX_PROPOSALS_PER_DAY}`);

    const gate = _canProposeNow();
    if (!gate.ok) {
      tally.globalLimitHit = true;
      console.log(`[PROPOSAL-SCHEDULER][${tickId}] 🚫 gate global: ${gate.reason}`);
    } else {
      // Evaluar cada plugin hasta encontrar UNO que proponga (no spameamos al owner)
      for (const plugin of plugins) {
        tally.pluginsEvaluated++;

        if (!_pluginCooldownOk(plugin)) {
          tally.pluginsSkippedCooldown++;
          continue;
        }

        try {
          const ctx = {
            ownerUid: schedulerState.ownerUid,
            now: Date.now(),
            deps: _deps,
          };
          const evaluation = await plugin.evaluate(ctx);
          if (!evaluation || !evaluation.shouldPropose) continue;

          tally.pluginsMatched++;
          const built = await plugin.buildProposal(ctx, evaluation.payload);
          if (!built || !built.message || built.message.length < 3) continue;

          // Enviar al owner
          if (_deps.sendToOwner) {
            await _deps.sendToOwner(built.message);
            tally.proposalsSent++;
            schedulerState.lastProposalByType[plugin.type] = Date.now();
            schedulerState.dailyHistory.push({ type: plugin.type, at: Date.now() });
            console.log(`[PROPOSAL-SCHEDULER][${tickId}] 📩 propuesta enviada: ${plugin.type} (reason=${evaluation.reason || 'match'})`);
            break; // solo 1 por tick
          } else {
            console.warn(`[PROPOSAL-SCHEDULER][${tickId}] ⚠️ ${plugin.type} match pero sendToOwner no inyectado — skip`);
          }
        } catch (pluginErr) {
          tally.errored++;
          console.error(`[PROPOSAL-SCHEDULER][${tickId}] ❌ plugin ${plugin.type}: ${pluginErr.message}`);
        }
      }
    }

    // Sync debounced
    const now = Date.now();
    if (!schedulerState.lastStateSyncAt || now - schedulerState.lastStateSyncAt > STATE_SYNC_DEBOUNCE_MS) {
      await _syncState();
      schedulerState.lastStateSyncAt = now;
    }
  } catch (err) {
    console.error(`[PROPOSAL-SCHEDULER][${tickId}] ❌ error ciclo principal: ${err.message}`);
    tally.errored++;
  } finally {
    schedulerState.isRunning = false;
    schedulerState.lastTickAt = Date.now();
    const durationMs = Date.now() - tickStart;
    console.log(`[PROPOSAL-SCHEDULER][${tickId}] ✅ tick end duration=${durationMs}ms tally=${JSON.stringify(tally)}`);
  }
}

/**
 * Persiste estado a Firestore.
 */
async function _syncState() {
  if (!schedulerState.ownerUid) return;
  try {
    await admin.firestore()
      .collection('users').doc(schedulerState.ownerUid)
      .collection('miia_proposals_state').doc('scheduler')
      .set({
        lastProposalByType: schedulerState.lastProposalByType,
        dailyHistory: schedulerState.dailyHistory,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  } catch (err) {
    console.error(`[PROPOSAL-SCHEDULER] error sincronizando: ${err.message}`);
  }
}

/**
 * Estadísticas para debug.
 */
function getStats() {
  _pruneDailyHistory();
  return {
    ownerUid: schedulerState.ownerUid,
    pluginsRegistered: schedulerState.plugins.map(p => ({ type: p.type, cooldownHours: p.cooldownHours })),
    dailyHistoryCount: schedulerState.dailyHistory.length,
    lastProposalByType: { ...schedulerState.lastProposalByType },
    lastTickAt: schedulerState.lastTickAt,
    tickCount: _proposalTickCount,
  };
}

/**
 * Resetea estado in-memory (solo para tests).
 */
function _resetForTesting() {
  schedulerState.ownerUid = null;
  schedulerState.isRunning = false;
  schedulerState.plugins = [];
  schedulerState.lastTickAt = null;
  schedulerState.lastStateSyncAt = null;
  schedulerState.lastProposalByType = {};
  schedulerState.dailyHistory = [];
  _proposalTickCount = 0;
  for (const k of Object.keys(_deps)) _deps[k] = null;
}

module.exports = {
  initProposalScheduler,
  runProposalScheduler,
  registerProposal,
  getStats,
  // Exports para tests
  MAX_PROPOSALS_PER_DAY,
  MIN_HOURS_BETWEEN_PROPOSALS,
  _canProposeNow,
  _pluginCooldownOk,
  _resetForTesting,
};
