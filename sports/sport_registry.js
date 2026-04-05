/**
 * MIIA Sport Registry
 * Registra y despacha todos los adapters deportivos.
 * Patrón plugin: cada adapter se auto-registra al ser requerido.
 *
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const adapters = new Map();

/**
 * Registra un adapter deportivo.
 * @param {string} sportType — Clave única del deporte
 * @param {BaseSportAdapter} adapterInstance — Instancia del adapter
 */
function register(sportType, adapterInstance) {
  if (adapters.has(sportType)) {
    console.warn(`[SPORT-REGISTRY] Adapter '${sportType}' ya registrado, sobreescribiendo`);
  }
  adapters.set(sportType, adapterInstance);
  console.log(`[SPORT-REGISTRY] ✅ Registrado: ${sportType} (${adapterInstance.displayName})`);
}

/**
 * Obtiene un adapter por tipo de deporte.
 * @param {string} sportType
 * @returns {BaseSportAdapter|null}
 */
function get(sportType) {
  return adapters.get(sportType) || null;
}

/**
 * Retorna todos los adapters registrados.
 * @returns {BaseSportAdapter[]}
 */
function all() {
  return Array.from(adapters.values());
}

/**
 * Retorna todos los tipos de deporte registrados.
 * @returns {string[]}
 */
function types() {
  return Array.from(adapters.keys());
}

/**
 * Retorna un resumen de adapters para logging.
 * @returns {object[]}
 */
function summary() {
  return all().map(a => ({
    type: a.sportType,
    name: a.displayName,
    emoji: a.emoji,
    pollMs: a.pollIntervalMs,
  }));
}

// ═══ AUTO-REGISTRO DE ADAPTERS ═══
// Cada require crea la instancia y la registramos.
// Si un adapter falla al cargar, NO crashea el sistema — solo logea.

const ADAPTERS_TO_LOAD = [
  { file: './adapters/futbol_adapter', type: 'futbol' },
  { file: './adapters/f1_adapter', type: 'f1' },
  { file: './adapters/tenis_adapter', type: 'tenis' },
  { file: './adapters/nba_adapter', type: 'nba' },
  { file: './adapters/mlb_adapter', type: 'mlb' },
  { file: './adapters/ufc_adapter', type: 'ufc' },
  { file: './adapters/rugby_adapter', type: 'rugby' },
  { file: './adapters/boxeo_adapter', type: 'boxeo' },
  { file: './adapters/golf_adapter', type: 'golf' },
  { file: './adapters/ciclismo_adapter', type: 'ciclismo' },
];

function loadAll() {
  let loaded = 0;
  let failed = 0;

  for (const { file, type } of ADAPTERS_TO_LOAD) {
    try {
      const AdapterClass = require(file);
      const instance = new AdapterClass();
      register(type, instance);
      loaded++;
    } catch (err) {
      console.error(`[SPORT-REGISTRY] ❌ Error cargando ${type}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[SPORT-REGISTRY] Carga completa: ${loaded} OK, ${failed} fallidos de ${ADAPTERS_TO_LOAD.length}`);
}

// Cargar todos al inicializar el módulo
loadAll();

module.exports = { register, get, all, types, summary };
