/**
 * voice_v2_loader.js — Loader del DNA lingüístico V2 de MIIA Personal
 *
 * Origen: CARTA_C-386 (sesión 3 plan V2 cuatro sesiones) componente A.1.
 * Specs fuente: miia-backend/prompts/v2/voice_seed.md + mode_detectors.md
 *
 * Función principal: loadVoiceDNAForGroup(chatType, opts) → { systemBlock, subregistro, fallback }
 *
 * Scope: SOLO MIIA Personal (UID bq2BbtCVF8cZo30tum584zrGATJ3, +573163937365).
 *        MIIA CENTER (UID A5pMESWlfmPWCoCPRbwy85EzUzy2) NO usa este loader.
 *
 * Resolución chatType → subregistro V2 (voice_seed §2):
 *   - 'owner_selfchat'        → todos los subregistros disponibles (snapshot completo §2.1-§2.8)
 *   - 'family'                → §2.4 familia
 *   - 'friend_argentino'      → §2.5 amigos_argentinos
 *   - 'friend_colombiano'     → §2.6 amigos_colombianos
 *   - 'ale_pareja'            → §2.7 (override por phone +573137501884)
 *   - 'medilink_team'         → §2.8 vivi_team_medilink (fallback §2.2)
 *   - 'client'                → §2.2 clientes_medilink
 *   - 'lead'                  → §2.1 leads_medilink
 *   - 'follow_up_cold'        → §2.3 follow_up_cold_medilink
 *   - cualquier otro          → null (caller usa V1 prompts)
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
const MODE_DETECTORS_PATH = path.join(__dirname, '..', 'prompts', 'v2', 'mode_detectors.md');

let _voiceSeedCache = null;
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
    console.error(`[V2][voice_v2_loader] ❌ FAIL leyendo voice_seed.md: ${err.message}`);
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
    console.error(`[V2][voice_v2_loader] ❌ FAIL leyendo mode_detectors.md: ${err.message}`);
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
 * @param {string} fullText
 * @returns {string}
 */
function extractIdentidadBaseComun(fullText) {
  const start = fullText.indexOf('## §1 IDENTIDAD BASE COMÚN');
  if (start === -1) return '';
  const end = fullText.indexOf('## §2 LOS 7 SUBREGISTROS', start);
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
 * Resuelve el chatType V2 a partir de señales del caller.
 * @param {object} opts
 * @param {boolean} opts.isSelfChat
 * @param {string}  opts.contactType — valor crudo de TMH ('lead'|'client'|'familia'|'equipo'|'group'|'enterprise_lead'|...)
 * @param {string}  opts.basePhone — sin '@' ni sufijo ':NN'
 * @param {string}  [opts.countryCode] — 'AR'|'CO'|... opcional para distinguir friend_argentino vs friend_colombiano
 * @returns {string} chatType V2 estandarizado, o 'unknown' si no resuelve
 */
function resolveV2ChatType(opts) {
  const { isSelfChat, contactType, basePhone, countryCode } = opts || {};

  // PASO 1: Override Ale por phone (voice_seed §2.7 — partición rígida)
  if (basePhone && basePhone.replace(/\D/g, '').endsWith(ALE_PHONE)) {
    return 'ale_pareja';
  }

  // PASO 2: Self-chat owner
  if (isSelfChat) return 'owner_selfchat';

  // PASO 3: Mapping desde contactType crudo TMH
  switch (contactType) {
    case 'lead':
    case 'enterprise_lead':
      return 'lead';
    case 'client':
      return 'client';
    case 'familia':
      return 'family';
    case 'equipo':
      return 'medilink_team';
    case 'group': {
      // Sin más señal, default a friend_argentino si countryCode AR, friend_colombiano si CO,
      // si no hay countryCode → friend_argentino (Mariano AR es default cultural).
      if (countryCode === 'CO') return 'friend_colombiano';
      return 'friend_argentino';
    }
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
    console.warn(`[V2][voice_v2_loader] ⚠️ FALLBACK V1 — voice_seed no disponible (intento #${_loadAttempts}, fallos #${_loadFailures})`);
    return { systemBlock: '', subregistro: null, fallback: true, source: 'none' };
  }

  // owner_selfchat carga el archivo entero §0-§8 (Mariano necesita ver todos los registros para auto-monitoreo)
  if (chatType === 'owner_selfchat') {
    const block = `\n\n[VOICE DNA V2 — SNAPSHOT COMPLETO MIIA PERSONAL]\nFuente: prompts/v2/voice_seed.md\nUso: en self-chat tenés visibilidad de cómo MIIA habla en TODOS los subregistros.\n\n${seed}`;
    console.log(`[V2][voice_v2_loader] ✅ Loaded SNAPSHOT completo para owner_selfchat (${seed.length} chars, ${Date.now() - t0}ms)`);
    return { systemBlock: block, subregistro: 'owner_selfchat_snapshot', fallback: false, source: 'voice_seed.md §0-§8' };
  }

  // Resto: identidad base común §1 + subregistro específico §2.x
  const baseHeader = SUBREGISTRO_HEADERS[chatType];
  if (!baseHeader) {
    console.warn(`[V2][voice_v2_loader] ⚠️ chatType desconocido: '${chatType}' — fallback V1`);
    return { systemBlock: '', subregistro: null, fallback: true, source: 'unknown_chattype' };
  }

  const baseIdentidad = opts.skipBaseIdentidad ? '' : extractIdentidadBaseComun(seed);
  const subSection = extractSubregistro(seed, baseHeader);

  if (!subSection) {
    console.warn(`[V2][voice_v2_loader] ⚠️ Subregistro NO encontrado en voice_seed.md para chatType='${chatType}' (header buscado='${baseHeader}') — fallback V1`);
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
  _modeDetectorsCache = null;
}

module.exports = {
  loadVoiceDNAForGroup,
  resolveV2ChatType,
  readVoiceSeed,
  readModeDetectors,
  extractByHeader,
  getLoaderStats,
  resetCache,
  // Constantes exportadas para reutilización por A.2/A.3/A.4
  ALE_PHONE,
  OWNER_PERSONAL_UID,
  MIIA_CENTER_UID,
  SUBREGISTRO_HEADERS
};
