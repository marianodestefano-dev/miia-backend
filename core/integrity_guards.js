// ════════════════════════════════════════════════════════════════════════════
// MIIA — INTEGRITY GUARDS (Monitor de regresiones)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Este módulo verifica al arrancar que los fixes críticos siguen intactos.
// Si alguien borra o rompe un guard, el log GRITA y el health endpoint
// reporta el problema.
//
// ⚠️ PROHIBIDO ELIMINAR ESTE MÓDULO — Es el watchdog de regresiones.
// Cada guard protege un bug real que mató funcionalidad en producción.
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const GUARD_STATUS = {
  checks: [],
  lastRun: null,
  allPassed: false
};

/**
 * Ejecuta todas las verificaciones de integridad.
 * Se llama al arrancar el servidor y opcionalmente cada N horas.
 */
function runIntegrityChecks() {
  console.log('[INTEGRITY] 🛡️ Ejecutando verificaciones de integridad...');
  GUARD_STATUS.checks = [];
  GUARD_STATUS.lastRun = new Date().toISOString();

  // GUARD 1: Google Search → Gemini obligatorio
  _checkFileContains(
    'SEARCH-GUARD',
    path.join(__dirname, '..', 'ai', 'ai_gateway.js'),
    'searchForceGemini',
    'Google Search se enruta a Gemini cuando enableSearch=true. Sin esto, Claude ignora search y MIIA dice "no tengo esa info".'
  );

  // GUARD 2: LID-FASTPATH para tenants con 1 negocio
  _checkFileContains(
    'LID-FASTPATH',
    path.join(__dirname, '..', 'whatsapp', 'tenant_manager.js'),
    'LID-FASTPATH',
    'Leads con @lid en tenants de 1 negocio se procesan directo sin clasificación. Sin esto, MIIA CENTER no responde leads.'
  );

  // GUARD 3: Leads summary en self-chat (server.js)
  _checkFileContains(
    'LEADS-SUMMARY-SERVER',
    path.join(__dirname, '..', 'server.js'),
    'leadsSummaryStr',
    'Self-chat de MIIA CENTER inyecta resumen de leads. Sin esto, MIIA dice "no tengo visibilidad de leads".'
  );

  // GUARD 4: Leads summary en self-chat (TMH)
  _checkFileContains(
    'LEADS-SUMMARY-TMH',
    path.join(__dirname, '..', 'whatsapp', 'tenant_message_handler.js'),
    'leadsSummaryStr',
    'Self-chat de tenants inyecta resumen de contactos. Sin esto, MIIA no sabe quién escribió.'
  );

  // GUARD 5: Weekend mode hora fija 19:00
  _checkFileContains(
    'WEEKEND-19H',
    path.join(__dirname, 'weekend_mode.js'),
    'hour === 19',
    'Modo finde se pregunta a las 19:00 local. Sin esto, se envía a las 17:00 (5PM) que confunde al owner.'
  );

  // GUARD 6: SEARCH-INTEGRITY-VIOLATION log de auditoría
  _checkFileContains(
    'SEARCH-AUDIT-LOG',
    path.join(__dirname, '..', 'ai', 'ai_gateway.js'),
    'SEARCH-INTEGRITY-VIOLATION',
    'Log de auditoría que detecta si search se enruta a proveedor que no es Gemini. Alerta temprana de regresión.'
  );

  const passed = GUARD_STATUS.checks.filter(c => c.ok).length;
  const failed = GUARD_STATUS.checks.filter(c => !c.ok).length;
  GUARD_STATUS.allPassed = failed === 0;

  if (failed > 0) {
    console.error(`[INTEGRITY] 🚨🔴 ${failed} GUARD(S) FALLARON:`);
    GUARD_STATUS.checks.filter(c => !c.ok).forEach(c => {
      console.error(`[INTEGRITY] 🚨 ${c.name}: ${c.description}`);
    });
  } else {
    console.log(`[INTEGRITY] ✅ ${passed}/${passed} guards OK — Sistema íntegro`);
  }

  return GUARD_STATUS;
}

function _checkFileContains(name, filePath, searchString, description) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const found = content.includes(searchString);
    GUARD_STATUS.checks.push({
      name,
      ok: found,
      description: found ? 'OK' : `⚠️ FALTA "${searchString}" en ${path.basename(filePath)}. ${description}`,
      file: path.basename(filePath),
      checkedAt: new Date().toISOString()
    });
    if (!found) {
      console.error(`[INTEGRITY] 🚨 GUARD ${name} FALLÓ: "${searchString}" no encontrado en ${path.basename(filePath)}`);
      console.error(`[INTEGRITY] 🚨 → ${description}`);
    }
  } catch (e) {
    GUARD_STATUS.checks.push({
      name,
      ok: false,
      description: `Error leyendo ${path.basename(filePath)}: ${e.message}`,
      file: path.basename(filePath),
      checkedAt: new Date().toISOString()
    });
    console.error(`[INTEGRITY] 🚨 GUARD ${name}: Error leyendo archivo: ${e.message}`);
  }
}

/**
 * Retorna el estado actual de los guards (para health endpoint).
 */
function getGuardStatus() {
  return GUARD_STATUS;
}

module.exports = {
  runIntegrityChecks,
  getGuardStatus
};
