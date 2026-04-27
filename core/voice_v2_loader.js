/**
 * voice_v2_loader.js — Loader del DNA lingüístico V2
 *
 * Origen: CARTA_C-386 (sesión 3 plan V2 cuatro sesiones) componente A.1.
 *         Re-scope: CARTA_C-388 (corrección scope MIIA CENTER, NO MIIA Personal).
 * Specs fuente: miia-backend/prompts/v2/voice_seed.md + mode_detectors.md
 *
 * Función principal: loadVoiceDNAForGroup(chatType, opts) → { systemBlock, subregistro, fallback }
 *
 * Scope ETAPA 1 (pruebas, firmado Mariano C-388 D.1 verbatim):
 *   - SOLO MIIA CENTER (UID A5pMESWlfmPWCoCPRbwy85EzUzy2, +573054169969).
 *   - MIIA Personal (UID bq2BbtCVF8cZo30tum584zrGATJ3) corre V1 puro hasta etapa 2.
 *
 * Subregistros activos en MIIA CENTER (etapa 1):
 *   - 'lead'                  → §2.1 leads_medilink (vendedor Mariano para leads MIIA-producto)
 *   - 'client'                → §2.2 clientes_medilink (atención clientes pagantes MIIA-producto)
 *   - 'follow_up_cold'        → §2.3 follow_up_cold_medilink (leads cold MIIA-producto)
 *   - 'owner_selfchat'        → snapshot completo (cuando Mariano usa "PRESENTATE CONMIGO" desde self-chat MIIA CENTER)
 *
 * Subregistros INACTIVOS en MIIA CENTER (etapa 1):
 *   - family / friend_argentino / friend_colombiano / ale_pareja / medilink_team
 *   - Razón: MIIA CENTER no habla con familia/amigos/Ale/Vivi — esos contactos viven en MIIA Personal (etapa 2/3).
 *   - Resolución: retornan 'unknown' → caller usa V1.
 *
 * Comportamiento de fallback (try/catch a nivel caller):
 *   - Si voice_seed.md no se puede leer → loader devuelve { systemBlock: '', fallback: true }
 *   - Caller (prompt_builder.js) trata fallback === true como "no inyectar V2",
 *     mantiene el activeSystemPrompt V1 intacto y loguea WARN.
 *
 * Cache: contenido del .md cacheado en memoria al primer llamado.
 *        Hot-reload: process.env.V2_VOICE_NO_CACHE === 'true' fuerza re-lectura.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VOICE_SEED_PATH = path.join(__dirname, '..', 'prompts', 'v2', 'voice_seed.md');
const VOICE_SEED_CENTER_PATH = path.join(__dirname, '..', 'prompts', 'v2', 'voice_seed_center.md');
const MODE_DETECTORS_PATH = path.join(__dirname, '..', 'prompts', 'v2', 'mode_detectors.md');

let _voiceSeedCache = null;
let _voiceSeedCenterCache = null;
let _modeDetectorsCache = null;
let _loadAttempts = 0;
let _loadFailures = 0;

const ALE_PHONE = '573137501884'; // voice_seed §2.7 — partición rígida
const OWNER_PERSONAL_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3';
const MIIA_CENTER_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

// Mapping chatType → header name del subregistro en voice_seed.md (para extraer sección)
const SUBREGISTRO_HEADERS = {
  lead: '### 2.1 `leads_medilink`',
  client: '### 2.2 `clientes_medilink`',
  follow_up_cold: '### 2.3 `follow_up_cold_medilink`',
  family: '### 2.4 `familia`',
  friend_argentino: '### 2.5 `amigos_argentinos`',
  friend_colombiano: '### 2.6 `amigos_colombianos`',
  ale_pareja: '### 2.7 `ale_pareja`',
  medilink_team: '### 2.8 (PARCIAL) `vivi_team_medilink`'
};

// C-397 §5 — Mapping chatType → header en voice_seed_center.md (MIIA CENTER)
// CENTER solo tiene subregistros de producto (venta + soporte). No hay familia/amigos/ale.
const SUBREGISTRO_HEADERS_CENTER = {
  lead: '### 2.1 `leads_medilink`',
  client: '### 2.2 `clientes_medilink`',
  follow_up_cold: '### 2.3 `follow_up_cold_medilink`',
  soporte_producto_miia: '### 2.4 `soporte_producto_miia`'
};

/**
 * Lee voice_seed.md desde disco (con cache).
 * @returns {string|null} contenido completo, o null si no se puede leer.
 */
function readVoiceSeed() {
  if (_voiceSeedCache && process.env.V2_VOICE_NO_CACHE !== 'true') return _voiceSeedCache;
  try {
    _voiceSeedCache = fs.readFileSync(VOICE_SEED_PATH, 'utf8');
    return _voiceSeedCache;
  } catch (err) {
    console.error('[V2-ALERT]', { context: 'voice_v2_loader.readVoiceSeed', error: err.message, path: VOICE_SEED_PATH, code: err.code, stack: err.stack });
    _loadFailures++;
    return null;
  }
}

/**
 * Lee voice_seed_center.md desde disco (con cache).
 * C-397 §5 — semilla de voz específica de MIIA CENTER (voz del producto).
 * @returns {string|null} contenido completo, o null si no se puede leer.
 */
function readVoiceSeedCenter() {
  if (_voiceSeedCenterCache && process.env.V2_VOICE_NO_CACHE !== 'true') return _voiceSeedCenterCache;
  try {
    _voiceSeedCenterCache = fs.readFileSync(VOICE_SEED_CENTER_PATH, 'utf8');
    return _voiceSeedCenterCache;
  } catch (err) {
    console.error('[V2-ALERT]', { context: 'voice_v2_loader.readVoiceSeedCenter', error: err.message, path: VOICE_SEED_CENTER_PATH, code: err.code, stack: err.stack });
    _loadFailures++;
    return null;
  }
}

/**
 * Lee mode_detectors.md desde disco (con cache).
 * Reservado para A.4 auditor (no usado en A.1 directamente).
 * @returns {string|null}
 */
function readModeDetectors() {
  if (_modeDetectorsCache && process.env.V2_VOICE_NO_CACHE !== 'true') return _modeDetectorsCache;
  try {
    _modeDetectorsCache = fs.readFileSync(MODE_DETECTORS_PATH, 'utf8');
    return _modeDetectorsCache;
  } catch (err) {
    console.error('[V2-ALERT]', { context: 'voice_v2_loader.readModeDetectors', error: err.message, path: MODE_DETECTORS_PATH, code: err.code, stack: err.stack });
    _loadFailures++;
    return null;
  }
}

/**
 * Extrae una sección §2.x del voice_seed por su header exacto.
 * @param {string} fullText
 * @param {string} headerLine — ej "### 2.4 `familia`"
 * @returns {string} sección hasta el próximo "### " o "## " o EOF.
 */
function extractSubregistro(fullText, headerLine) {
  const idx = fullText.indexOf(headerLine);
  if (idx === -1) return '';
  const after = fullText.slice(idx);
  // Busca el próximo "---" seguido de un nuevo "### " (separador entre subregistros)
  const sepRx = /\n---\n+###\s/;
  const sepMatch = sepRx.exec(after);
  if (sepMatch) {
    return after.slice(0, sepMatch.index).trim();
  }
  // Si no hay separador, busca "## §3" o EOF
  const nextSection = after.indexOf('\n## §3');
  if (nextSection !== -1) return after.slice(0, nextSection).trim();
  return after.trim();
}

/**
 * Extrae la "IDENTIDAD BASE COMÚN" (§1) que aplica a TODOS los subregistros.
 * Busca el cierre por el próximo "## §2 " (tolera distintos títulos: LOS 7 SUBREGISTROS,
 * SUBREGISTROS CENTER, etc.).
 * @param {string} fullText
 * @returns {string}
 */
function extractIdentidadBaseComun(fullText) {
  const start = fullText.indexOf('## §1 IDENTIDAD BASE COMÚN');
  if (start === -1) return '';
  // Busca el próximo "## §2 " (cualquier título: "LOS 7 SUBREGISTROS" o "SUBREGISTROS CENTER")
  const end = fullText.indexOf('## §2 ', start + 1);
  if (end === -1) return fullText.slice(start).trim();
  return fullText.slice(start, end).trim();
}

/**
 * Extrae un bloque arbitrario por header (para reglas duras como §1.10 no-IA con leads).
 * No usado en A.1 — reservado para A.4 auditor.
 */
function extractByHeader(fullText, header) {
  const idx = fullText.indexOf(header);
  if (idx === -1) return '';
  const after = fullText.slice(idx);
  const next = after.search(/\n###?\s/);
  if (next === -1) return after.trim();
  return after.slice(0, next).trim();
}

/**
 * Determina si el UID es elegible para V2 wire-in (etapa 1: SOLO MIIA CENTER).
 * Firma C-388 D.1: ETAPA 1 = MIIA CENTER. ETAPA 2 (firma futura "pasá V2 a mi personal")
 * cambiará este guard a aceptar también OWNER_PERSONAL_UID.
 *
 * @param {string} uid
 * @returns {boolean}
 */
function isV2EligibleUid(uid) {
  return uid === MIIA_CENTER_UID;
}

/**
 * Resuelve el chatType V2 a partir de señales del caller.
 *
 * En MIIA CENTER (etapa 1, scope C-388): solo lead / client / follow_up_cold / owner_selfchat
 * son válidos. Cualquier otro contactType (familia/equipo/group/ale_pareja por phone)
 * retorna 'unknown' — caller debe correr V1 sin V2.
 *
 * @param {object} opts
 * @param {string}  opts.uid — owner UID (para guard MIIA CENTER scope C-388)
 * @param {boolean} opts.isSelfChat
 * @param {string}  opts.contactType — valor crudo de TMH ('lead'|'client'|'familia'|'equipo'|'group'|'enterprise_lead'|'follow_up_cold'|...)
 * @param {string}  opts.basePhone — sin '@' ni sufijo ':NN'
 * @param {string}  [opts.countryCode] — 'AR'|'CO'|... reservado para etapa 2 (MIIA Personal)
 * @returns {string} chatType V2 estandarizado, o 'unknown' si no resuelve
 */
function resolveV2ChatType(opts) {
  const { uid, isSelfChat, contactType } = opts || {};

  // GUARD CRÍTICO C-388 D.1: solo MIIA CENTER usa V2 en etapa 1
  if (!isV2EligibleUid(uid)) return 'unknown';

  // PASO 1: Self-chat owner (Mariano usando self-chat de MIIA CENTER, ej "PRESENTATE CONMIGO")
  if (isSelfChat) return 'owner_selfchat';

  // PASO 2: Mapping desde contactType crudo TMH (solo subregistros profesionales válidos en MIIA CENTER)
  switch (contactType) {
    case 'lead':
    case 'enterprise_lead':
    case 'miia_lead':           // MIIA CENTER usa miia_lead postprocess (CLAUDE.md §2)
      return 'lead';
    case 'client':
    case 'miia_client':
      return 'client';
    case 'follow_up_cold':
    case 'cold':
      return 'follow_up_cold';
    // family / equipo / group / ale_pareja: NO aplican en MIIA CENTER (etapa 1)
    // → retornar 'unknown' para que caller use V1 (12 reglas MIIA_SALES_PROFILE)
    default:
      return 'unknown';
  }
}

/**
 * Función principal — devuelve el bloque de texto a inyectar en el system prompt.
 *
 * @param {string} chatType — uno de los chatTypes V2 (ver SUBREGISTRO_HEADERS) o 'owner_selfchat'/'unknown'
 * @param {object} [opts]
 * @param {string} [opts.contactName] — para logging
 * @param {boolean} [opts.skipBaseIdentidad] — si true, omite §1 (no recomendado)
 * @returns {{systemBlock: string, subregistro: string|null, fallback: boolean, source: string}}
 */
function loadVoiceDNAForGroup(chatType, opts = {}) {
  _loadAttempts++;
  const t0 = Date.now();

  const seed = readVoiceSeed();
  if (!seed) {
    console.warn('[V2-ALERT]', { context: 'loadVoiceDNAForGroup', reason: 'voice_seed_unavailable', chatType, attempts: _loadAttempts, failures: _loadFailures, fallback_to: 'V1' });
    return { systemBlock: '', subregistro: null, fallback: true, source: 'none' };
  }

  // owner_selfchat carga el archivo entero §0-§8 (Mariano necesita ver todos los registros para auto-monitoreo)
  if (chatType === 'owner_selfchat') {
    const block = `\n\n[VOICE DNA V2 — SNAPSHOT COMPLETO MIIA CENTER]\nFuente: prompts/v2/voice_seed.md\nUso: en self-chat MIIA CENTER tenés visibilidad de cómo MIIA habla en TODOS los subregistros profesionales (etapa 1 C-388).\n\n${seed}`;
    console.log(`[V2][voice_v2_loader] ✅ Loaded SNAPSHOT completo para owner_selfchat MIIA CENTER (${seed.length} chars, ${Date.now() - t0}ms)`);
    return { systemBlock: block, subregistro: 'owner_selfchat_snapshot', fallback: false, source: 'voice_seed.md §0-§8' };
  }

  // Resto: identidad base común §1 + subregistro específico §2.x
  const baseHeader = SUBREGISTRO_HEADERS[chatType];
  if (!baseHeader) {
    console.warn('[V2-ALERT]', { context: 'loadVoiceDNAForGroup', reason: 'unknown_chattype', chatType, fallback_to: 'V1' });
    return { systemBlock: '', subregistro: null, fallback: true, source: 'unknown_chattype' };
  }

  const baseIdentidad = opts.skipBaseIdentidad ? '' : extractIdentidadBaseComun(seed);
  const subSection = extractSubregistro(seed, baseHeader);

  if (!subSection) {
    console.warn('[V2-ALERT]', { context: 'loadVoiceDNAForGroup', reason: 'subregistro_missing_in_seed', chatType, baseHeader, fallback_to: 'V1' });
    return { systemBlock: '', subregistro: null, fallback: true, source: 'subregistro_missing' };
  }

  const block = `

[VOICE DNA V2 — chatType=${chatType}]
Fuente: prompts/v2/voice_seed.md (subregistro ${baseHeader.replace('### ', '').replace(/`/g, '')})
Instrucción: usá EXACTAMENTE el tono, vocativos, aperturas, frases-firma y emojis del subregistro siguiente. NO mezclar con otros subregistros. Reglas de voice_seed §1 (IDENTIDAD BASE COMÚN) aplican siempre.

${baseIdentidad ? baseIdentidad + '\n\n' : ''}${subSection}`;

  console.log(`[V2][voice_v2_loader] ✅ Loaded chatType='${chatType}' subregistro='${baseHeader}' (${block.length} chars, ${Date.now() - t0}ms) contact='${opts.contactName || '?'}'`);
  return {
    systemBlock: block,
    subregistro: chatType,
    fallback: false,
    source: `voice_seed.md ${baseHeader}`
  };
}

/**
 * C-397 §5 — Función paralela a loadVoiceDNAForGroup pero lee voice_seed_center.md.
 *
 * Uso: MIIA CENTER en cualquiera de sus 4 subregistros de producto
 * (leads_medilink, clientes_medilink, follow_up_cold_medilink, soporte_producto_miia).
 *
 * Comportamiento:
 *   - chatType='owner_selfchat' → snapshot completo del voice_seed_center.md
 *     (equivalente a loadVoiceDNAForGroup para CENTER self-chat de Mariano).
 *   - chatType en SUBREGISTRO_HEADERS_CENTER → identidad base §1 + subregistro §2.x
 *   - chatType no soportado → fallback=true, caller usa V1.
 *   - voice_seed_center.md no legible → fallback=true, caller usa V1.
 *
 * NO ROMPE loadVoiceDNAForGroup — es una función paralela independiente.
 *
 * @param {string} chatType
 * @param {object} [opts]
 * @param {string} [opts.contactName]
 * @param {boolean} [opts.skipBaseIdentidad]
 * @returns {{systemBlock: string, subregistro: string|null, fallback: boolean, source: string}}
 */
function loadVoiceDNAForCenter(chatType, opts = {}) {
  _loadAttempts++;
  const t0 = Date.now();

  const seed = readVoiceSeedCenter();
  if (!seed) {
    console.warn('[V2-ALERT]', { context: 'loadVoiceDNAForCenter', reason: 'voice_seed_center_unavailable', chatType, attempts: _loadAttempts, failures: _loadFailures, fallback_to: 'V1' });
    return { systemBlock: '', subregistro: null, fallback: true, source: 'none' };
  }

  // owner_selfchat de MIIA CENTER → snapshot completo
  if (chatType === 'owner_selfchat') {
    const block = `\n\n[VOICE DNA V2 — SNAPSHOT COMPLETO MIIA CENTER (CENTER seed)]\nFuente: prompts/v2/voice_seed_center.md\nUso: self-chat owner MIIA CENTER. Visibilidad completa de los 4 subregistros de producto (etapa 1 C-397).\n\n${seed}`;
    console.log(`[V2][voice_v2_loader] ✅ Loaded CENTER SNAPSHOT para owner_selfchat (${seed.length} chars, ${Date.now() - t0}ms)`);
    return { systemBlock: block, subregistro: 'owner_selfchat_snapshot_center', fallback: false, source: 'voice_seed_center.md §0-§8' };
  }

  const baseHeader = SUBREGISTRO_HEADERS_CENTER[chatType];
  if (!baseHeader) {
    console.warn('[V2-ALERT]', { context: 'loadVoiceDNAForCenter', reason: 'unknown_chattype_center', chatType, fallback_to: 'V1' });
    return { systemBlock: '', subregistro: null, fallback: true, source: 'unknown_chattype_center' };
  }

  const baseIdentidad = opts.skipBaseIdentidad ? '' : extractIdentidadBaseComun(seed);
  const subSection = extractSubregistro(seed, baseHeader);

  if (!subSection) {
    console.warn('[V2-ALERT]', { context: 'loadVoiceDNAForCenter', reason: 'subregistro_missing_center', chatType, baseHeader, fallback_to: 'V1' });
    return { systemBlock: '', subregistro: null, fallback: true, source: 'subregistro_missing_center' };
  }

  const block = `

[VOICE DNA V2 — chatType=${chatType} (MIIA CENTER)]
Fuente: prompts/v2/voice_seed_center.md (subregistro ${baseHeader.replace('### ', '').replace(/`/g, '')})
Instrucción: usá EXACTAMENTE el tono, aperturas, frases-firma y emojis del subregistro siguiente. NO mezclar con otros subregistros. Reglas de voice_seed_center §1 (IDENTIDAD BASE COMÚN CENTER) aplican siempre. CENTER SÍ puede decir que es IA — es su propuesta de valor. NUNCA menciona owner narrativo (Mariano, dueño, jefe).

${baseIdentidad ? baseIdentidad + '\n\n' : ''}${subSection}`;

  console.log(`[V2][voice_v2_loader] ✅ Loaded CENTER chatType='${chatType}' subregistro='${baseHeader}' (${block.length} chars, ${Date.now() - t0}ms) contact='${opts.contactName || '?'}'`);
  return {
    systemBlock: block,
    subregistro: chatType,
    fallback: false,
    source: `voice_seed_center.md ${baseHeader}`
  };
}

/**
 * Devuelve métricas operacionales (para health checks).
 */
function getLoaderStats() {
  return {
    attempts: _loadAttempts,
    failures: _loadFailures,
    cacheHit: !!_voiceSeedCache,
    voiceSeedPath: VOICE_SEED_PATH,
    modeDetectorsPath: MODE_DETECTORS_PATH
  };
}

/**
 * Reinicia cache (para tests / hot reload).
 */
function resetCache() {
  _voiceSeedCache = null;
  _voiceSeedCenterCache = null;
  _modeDetectorsCache = null;
}

module.exports = {
  loadVoiceDNAForGroup,
  loadVoiceDNAForCenter,
  resolveV2ChatType,
  isV2EligibleUid,
  readVoiceSeed,
  readVoiceSeedCenter,
  readModeDetectors,
  extractByHeader,
  getLoaderStats,
  resetCache,
  // Constantes exportadas para reutilización por A.2/A.3/A.4
  ALE_PHONE,
  OWNER_PERSONAL_UID,
  MIIA_CENTER_UID,
  SUBREGISTRO_HEADERS,
  SUBREGISTRO_HEADERS_CENTER
};
