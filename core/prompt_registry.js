/**
 * PROMPT REGISTRY v1.0 — Modular prompt system with Firestore-backed versioning + checkpoints
 *
 * Problem: prompt_builder.js has all prompts hardcoded. If a prompt change breaks something,
 * there's no way to know which version was running or roll back.
 *
 * Solution:
 *   - Each prompt section is a "module" stored in Firestore with version tracking
 *   - Checkpoints = named snapshots of all module versions at a point in time
 *   - Assembler combines modules into final prompt, logging which versions were used
 *   - Rollback restores a checkpoint (all modules revert to snapshot versions)
 *
 * Firestore structure:
 *   prompt_registry/
 *   ├── modules/{moduleId}         ← { content, version, updatedAt, updatedBy, description }
 *   ├── checkpoints/{checkpointId} ← { name, modules: { moduleId: version }, createdAt, note }
 *   └── logs/{logId}               ← { assembled prompt metadata, not full text }
 *
 * Usage:
 *   const registry = require('./prompt_registry');
 *
 *   // Save/update a module
 *   await registry.saveModule('adn_miia', 'El ADN completo...', { description: 'Identidad base MIIA' });
 *
 *   // Create checkpoint before deploying changes
 *   await registry.createCheckpoint('pre-v6.1', 'Antes de cambiar protocolo cotización');
 *
 *   // Assemble prompt from modules
 *   const prompt = await registry.assemble(['adn_miia', 'vademecum', 'cotizacion'], { ownerName: 'Mariano' });
 *
 *   // Something broke? Roll back
 *   await registry.rollback('pre-v6.1');
 *
 * Standard: Google + Amazon + NASA
 */

'use strict';

const admin = require('firebase-admin');

const COLLECTION = 'prompt_registry';

// ═══════════════════════════════════════════════════════════════════
// MODULE CRUD
// ═══════════════════════════════════════════════════════════════════

/**
 * Save or update a prompt module. Auto-increments version.
 * @param {string} moduleId - Unique module name (e.g. 'adn_miia', 'vademecum', 'cotizacion_chile')
 * @param {string} content - The prompt text content
 * @param {object} [opts] - { description, updatedBy }
 * @returns {Promise<{ version: number }>}
 */
async function saveModule(moduleId, content, opts = {}) {
  const db = admin.firestore();
  const ref = db.collection(COLLECTION).doc('modules').collection('items').doc(moduleId);

  const existing = await ref.get();
  const currentVersion = existing.exists ? (existing.data()?.version || 0) : 0;
  const newVersion = currentVersion + 1;

  // Keep previous version as history
  if (existing.exists) {
    await ref.collection('history').doc(`v${currentVersion}`).set({
      content: existing.data().content,
      version: currentVersion,
      archivedAt: new Date()
    });
  }

  await ref.set({
    content,
    version: newVersion,
    description: opts.description || existing.data()?.description || '',
    updatedAt: new Date(),
    updatedBy: opts.updatedBy || 'system'
  });

  console.log(`[PROMPT-REGISTRY] Module "${moduleId}" saved (v${newVersion})`);
  return { version: newVersion };
}

/**
 * Get a module's current content and version.
 * @param {string} moduleId
 * @param {number} [version] - Specific version (null = latest)
 * @returns {Promise<{ content: string, version: number } | null>}
 */
async function getModule(moduleId, version = null) {
  const db = admin.firestore();
  const ref = db.collection(COLLECTION).doc('modules').collection('items').doc(moduleId);

  if (version) {
    const histDoc = await ref.collection('history').doc(`v${version}`).get();
    if (histDoc.exists) return { content: histDoc.data().content, version };
    // If requested version IS current, return current
    const current = await ref.get();
    if (current.exists && current.data().version === version) {
      return { content: current.data().content, version };
    }
    return null;
  }

  const doc = await ref.get();
  if (!doc.exists) return null;
  return { content: doc.data().content, version: doc.data().version };
}

/**
 * List all registered modules with their versions.
 * @returns {Promise<Array<{ id, version, description, updatedAt }>>}
 */
async function listModules() {
  const db = admin.firestore();
  const snap = await db.collection(COLLECTION).doc('modules').collection('items').get();
  return snap.docs.map(d => ({
    id: d.id,
    version: d.data().version,
    description: d.data().description,
    updatedAt: d.data().updatedAt
  }));
}

/**
 * Delete a module entirely (use with caution).
 */
async function deleteModule(moduleId) {
  const db = admin.firestore();
  await db.collection(COLLECTION).doc('modules').collection('items').doc(moduleId).delete();
  console.log(`[PROMPT-REGISTRY] Module "${moduleId}" DELETED`);
}

// ═══════════════════════════════════════════════════════════════════
// CHECKPOINTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a checkpoint = snapshot of all current module versions.
 * @param {string} name - Human-readable name (e.g. 'pre-v6.1', 'stable-2026-04-03')
 * @param {string} [note] - Why this checkpoint was created
 * @returns {Promise<{ id: string, modules: object }>}
 */
async function createCheckpoint(name, note = '') {
  const db = admin.firestore();
  const modules = await listModules();

  const moduleVersions = {};
  for (const m of modules) {
    moduleVersions[m.id] = m.version;
  }

  // C-449-IDS-RACE-FIX: random suffix evita colision si 2 checkpoints
  // con mismo name se crean en mismo ms (extension principio C-447).
  const checkpointId = `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.collection(COLLECTION).doc('checkpoints').collection('items').doc(checkpointId).set({
    name,
    note,
    modules: moduleVersions,
    createdAt: new Date(),
    moduleCount: modules.length
  });

  console.log(`[PROMPT-REGISTRY] Checkpoint "${name}" created (${modules.length} modules)`);
  return { id: checkpointId, modules: moduleVersions };
}

/**
 * List all checkpoints.
 * @returns {Promise<Array>}
 */
async function listCheckpoints() {
  const db = admin.firestore();
  const snap = await db.collection(COLLECTION).doc('checkpoints').collection('items')
    .orderBy('createdAt', 'desc').limit(20).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Rollback: restore all modules to the versions stored in a checkpoint.
 * @param {string} checkpointName - The checkpoint name (finds most recent with this name)
 * @returns {Promise<{ restored: number, errors: string[] }>}
 */
async function rollback(checkpointName) {
  const db = admin.firestore();

  // Find the most recent checkpoint with this name
  const snap = await db.collection(COLLECTION).doc('checkpoints').collection('items')
    .where('name', '==', checkpointName)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snap.empty) {
    throw new Error(`Checkpoint "${checkpointName}" not found`);
  }

  const checkpoint = snap.docs[0].data();
  const moduleVersions = checkpoint.modules;
  let restored = 0;
  const errors = [];

  // Create a "pre-rollback" checkpoint automatically
  await createCheckpoint(`pre-rollback-${checkpointName}`, `Auto-saved before rolling back to "${checkpointName}"`);

  for (const [moduleId, targetVersion] of Object.entries(moduleVersions)) {
    try {
      const mod = await getModule(moduleId, targetVersion);
      if (mod) {
        await saveModule(moduleId, mod.content, { updatedBy: `rollback:${checkpointName}` });
        restored++;
      } else {
        errors.push(`Module "${moduleId}" v${targetVersion} not found in history`);
      }
    } catch (e) {
      errors.push(`Error restoring "${moduleId}": ${e.message}`);
    }
  }

  console.log(`[PROMPT-REGISTRY] Rollback to "${checkpointName}": ${restored} modules restored, ${errors.length} errors`);
  return { restored, errors };
}

// ═══════════════════════════════════════════════════════════════════
// ASSEMBLER
// ═══════════════════════════════════════════════════════════════════

/**
 * Assemble a prompt from multiple modules.
 * Supports variable interpolation: {{ownerName}}, {{businessName}}, etc.
 *
 * @param {string[]} moduleIds - Ordered list of module IDs to concatenate
 * @param {object} [vars] - Variables to interpolate (e.g. { ownerName: 'Mariano' })
 * @param {object} [opts] - { logUsage: true, uid: 'user-id' }
 * @returns {Promise<{ prompt: string, versions: object }>}
 */
async function assemble(moduleIds, vars = {}, opts = {}) {
  const parts = [];
  const versions = {};

  for (const id of moduleIds) {
    const mod = await getModule(id);
    if (!mod) {
      console.warn(`[PROMPT-REGISTRY] Module "${id}" not found — skipping`);
      continue;
    }
    parts.push(mod.content);
    versions[id] = mod.version;
  }

  let prompt = parts.join('\n\n');

  // Variable interpolation
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  // Optional: log what versions were assembled (lightweight, no full prompt stored)
  if (opts.logUsage !== false) {
    const db = admin.firestore();
    db.collection(COLLECTION).doc('logs').collection('items').add({
      moduleIds,
      versions,
      vars: Object.keys(vars), // Only log var names, not values (privacy)
      uid: opts.uid || 'unknown',
      assembledAt: new Date(),
      promptLength: prompt.length
    }).catch(() => {}); // Best-effort logging, never fail
  }

  return { prompt, versions };
}

// ═══════════════════════════════════════════════════════════════════
// SEED — Initialize registry from current prompt_builder.js modules
// Run once to migrate existing prompts into the registry.
// ═══════════════════════════════════════════════════════════════════

/**
 * Seed the registry with modules extracted from prompt_builder.js.
 * Idempotent — skips modules that already exist.
 * @param {object} promptBuilder - The require('./prompt_builder') module
 */
async function seedFromPromptBuilder(promptBuilder) {
  const pb = promptBuilder;
  const modules = [
    { id: 'adn_miia_base', content: pb.ADN_MIIA_BASE, description: 'ADN genérico MIIA (sin datos personales)' },
    { id: 'adn_miia_mariano', content: pb.ADN_MIIA, description: 'ADN MIIA personalizado para Mariano' },
    { id: 'vademecum_mariano', content: pb.VADEMECUM_RULES, description: 'Reglas de comportamiento (Mariano)' },
    { id: 'cotizacion_protocol', content: pb.COTIZACION_PROTOCOL, description: 'Protocolo cotización Medilink completo' },
  ];

  let seeded = 0;
  for (const m of modules) {
    const existing = await getModule(m.id);
    if (existing) {
      console.log(`[PROMPT-REGISTRY] Module "${m.id}" already exists (v${existing.version}) — skipping`);
      continue;
    }
    await saveModule(m.id, m.content, { description: m.description, updatedBy: 'seed' });
    seeded++;
  }

  if (seeded > 0) {
    await createCheckpoint('initial-seed', `Seeded ${seeded} modules from prompt_builder.js`);
  }

  console.log(`[PROMPT-REGISTRY] Seed complete: ${seeded} new modules, ${modules.length - seeded} already existed`);
  return { seeded, total: modules.length };
}

// ═══════════════════════════════════════════════════════════════════
// DIFF — Compare two checkpoints or current vs checkpoint
// ═══════════════════════════════════════════════════════════════════

/**
 * Compare current module versions against a checkpoint.
 * @param {string} checkpointName
 * @returns {Promise<Array<{ module, current, checkpoint, changed }>>}
 */
async function diffFromCheckpoint(checkpointName) {
  const db = admin.firestore();
  const snap = await db.collection(COLLECTION).doc('checkpoints').collection('items')
    .where('name', '==', checkpointName)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snap.empty) throw new Error(`Checkpoint "${checkpointName}" not found`);

  const cpModules = snap.docs[0].data().modules;
  const currentModules = await listModules();
  const currentMap = {};
  for (const m of currentModules) currentMap[m.id] = m.version;

  const allIds = new Set([...Object.keys(cpModules), ...Object.keys(currentMap)]);
  const diff = [];

  for (const id of allIds) {
    const cpVer = cpModules[id] || 0;
    const curVer = currentMap[id] || 0;
    diff.push({
      module: id,
      current: curVer,
      checkpoint: cpVer,
      changed: cpVer !== curVer,
      status: cpVer === 0 ? 'new' : curVer === 0 ? 'deleted' : cpVer !== curVer ? 'modified' : 'unchanged'
    });
  }

  return diff;
}

// ═══════════════════════════════════════════════════════════════════
// TÉCNICA 7: Auto-sync precios del generator → prompt
// Genera el bloque de precios del prompt DESDE la misma fuente de verdad
// que usa services/cotizacion_link.js. SOLO LECTURA — nunca modifica la raíz.
// Los precios exclusivos por lead viven en el training data, no aquí.
// C-342 B.5: fuente migrada de cotizacion_generator.js (zombi retirado) a cotizacion_link.js.
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate pricing prompt text directly from cotizacion_link.js price matrices.
 * READ-ONLY: This NEVER modifies the source prices. It only READS and formats.
 * Per-lead pricing lives in training data (cerebro), not here.
 * @returns {string} The pricing block ready to inject into prompts
 */
function generatePricingFromSource() {
  let PRECIOS;
  try {
    const cg = require('../services/cotizacion_link');
    PRECIOS = cg.PRECIOS || cg.default?.PRECIOS;
    if (!PRECIOS) throw new Error('PRECIOS not exported from cotizacion_link');
  } catch (e) {
    console.error(`[PROMPT-REGISTRY] Cannot import cotizacion_link:`, e.message);
    return '## PRECIOS\n[ERROR: No se pudieron cargar precios desde cotizacion_link.js]';
  }

  const planLabels = { S: 'ESENCIAL', M: 'PRO', L: 'TITANIUM' };
  const monedaSymbol = { CLP: '$', COP: '$', MXN: '$', USD: '$', EUR: '€' };
  const monedaCountry = {
    CLP: 'CHILE (CLP)', COP: 'COLOMBIA (COP)', MXN: 'MÉXICO (MXN)',
    USD: 'INTERNACIONAL / ARGENTINA / RD (USD)', EUR: 'ESPAÑA (EUR) — SOLO ANUAL'
  };

  let output = '## PLANES Y PRECIOS (auto-generado desde fuente única)\n\n';

  for (const [moneda, p] of Object.entries(PRECIOS)) {
    const sym = monedaSymbol[moneda] || '$';
    output += `### ${monedaCountry[moneda] || moneda}\n`;
    for (const planKey of ['S', 'M', 'L']) {
      const base = p.planes[planKey];
      const adic = p.adic1[planKey];
      output += `${planLabels[planKey]} ${sym}${base} base | adic: ${sym}${adic}\n`;
    }
    if (p.bolsas) {
      for (const [mod, tiers] of Object.entries(p.bolsas)) {
        const tierStr = Object.entries(tiers).map(([t, v]) => `${t}:${sym}${v}`).join(' ');
        output += `${mod.toUpperCase()}: ${tierStr}\n`;
      }
    }
    output += '\n';
  }

  output += `### REGLAS POR PAÍS\n`;
  output += `- Argentina: SIN factura, CON Receta Digital ($3 USD/usuario/mes)\n`;
  output += `- España: SOLO modalidad anual. Precios ya son ×12 meses.\n`;
  output += `- México: IVA 16% se calcula automáticamente en el PDF.\n`;
  output += `- Rep. Dominicana: CON factura electrónica.\n`;
  output += `- Internacional: SIN factura.\n`;
  output += `\n### DESCUENTOS\n`;
  output += `- Mensual: 30% sobre subtotal básico (plan + adicionales). Módulos SIN descuento.\n`;
  output += `- Semestral: 15%\n`;
  output += `- Anual: 20%\n`;
  output += `- España: siempre anual (20%)\n`;

  return output;
}

// ═══════════════════════════════════════════════════════════════════
// TÉCNICA 8: Prompt freshness validation
// Before each AI call, verify the prompt modules haven't changed.
// READ-ONLY — only checks, never modifies anything.
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate that a prompt assembly is fresh (modules haven't been updated since).
 * @param {object} versions - { moduleId: version } from a previous assemble()
 * @returns {Promise<{ fresh: boolean, staleModules: string[] }>}
 */
async function validateFreshness(versions) {
  const staleModules = [];
  for (const [moduleId, assembledVersion] of Object.entries(versions)) {
    const current = await getModule(moduleId);
    if (current && current.version !== assembledVersion) {
      staleModules.push(`${moduleId}: assembled v${assembledVersion}, current v${current.version}`);
    }
  }
  return { fresh: staleModules.length === 0, staleModules };
}

// ═══════════════════════════════════════════════════════════════════
// TÉCNICA 9: Prompt size analyzer
// Gemini handles ~1M tokens but quality degrades with very long prompts.
// Track and warn when critical threshold is crossed.
// ═══════════════════════════════════════════════════════════════════

/**
 * Estimate token count and warn if prompt is too long.
 * ~4 chars per token for Spanish text.
 * @param {string} prompt
 * @returns {{ estimatedTokens: number, warning: string|null }}
 */
function analyzePromptSize(prompt) {
  const estimatedTokens = Math.ceil(prompt.length / 4);
  let warning = null;
  if (estimatedTokens > 12000) {
    warning = `CRITICAL: ~${estimatedTokens} tokens. Instrucciones después del token ~8000 pierden efectividad. Considerar split.`;
  } else if (estimatedTokens > 8000) {
    warning = `WARNING: ~${estimatedTokens} tokens. Priorizar instrucciones críticas al inicio del prompt.`;
  }
  if (warning) console.warn(`[PROMPT-REGISTRY] ${warning}`);
  return { estimatedTokens, warning };
}

module.exports = {
  // Module CRUD
  saveModule,
  getModule,
  listModules,
  deleteModule,

  // Checkpoints
  createCheckpoint,
  listCheckpoints,
  rollback,

  // Assembler
  assemble,

  // Diff
  diffFromCheckpoint,

  // Seed
  seedFromPromptBuilder,

  // Auto-sync pricing (READ-ONLY from generator)
  generatePricingFromSource,

  // Freshness validation
  validateFreshness,

  // Prompt analysis
  analyzePromptSize
};
