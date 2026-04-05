/**
 * Registro y orquestador de integraciones MIIA.
 * Auto-carga adapters desde ./adapters/
 */
const fs = require('fs');
const path = require('path');

const registry = {};

// Auto-cargar adapters
const adaptersDir = path.join(__dirname, 'adapters');
if (fs.existsSync(adaptersDir)) {
  for (const file of fs.readdirSync(adaptersDir)) {
    if (!file.endsWith('_integration.js')) continue;
    try {
      const AdapterClass = require(path.join(adaptersDir, file));
      const instance = new AdapterClass();
      registry[instance.type] = instance;
      console.log(`[INTEGRATIONS] ✅ ${instance.emoji} ${instance.displayName} registrado`);
    } catch (e) {
      console.error(`[INTEGRATIONS] ❌ Error cargando ${file}:`, e.message);
    }
  }
}

module.exports = {
  get: (type) => registry[type],
  all: () => Object.values(registry),
  types: () => Object.keys(registry),
  registry
};
