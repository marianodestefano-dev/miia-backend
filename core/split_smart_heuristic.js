/**
 * split_smart_heuristic.js — Splitter heurístico por subregistro V2 (C-386 A.2)
 *
 * Reglas (voice_seed §6 — patrón paredón vs split):
 *
 *   ┌──────────────────────────┬───────────────────────────────────┐
 *   │ chatType                 │ Modo                              │
 *   ├──────────────────────────┼───────────────────────────────────┤
 *   │ lead / enterprise_lead   │ PAREDÓN único 400-900 chars       │
 *   │ client                   │ MEZCLA según contexto             │
 *   │ follow_up_cold           │ PAREDÓN 3 párrafos fijos          │
 *   │ family                   │ SPLIT multi-burst                 │
 *   │ friend_argentino         │ SPLIT multi-burst ultra-corto     │
 *   │ friend_colombiano        │ SPLIT moderado                    │
 *   │ ale_pareja               │ SPLIT con vocales prolongadas     │
 *   │ medilink_team            │ SPLIT moderado (operativo)        │
 *   │ owner_selfchat           │ SPLIT moderado (Mariano lee)      │
 *   └──────────────────────────┴───────────────────────────────────┘
 *
 * Decisión: respeta el splitter existente (splitMessage por tag [MSG_SPLIT] +
 * autoSplitByLength) — este módulo NO lo reemplaza, lo PRECEDE como guía.
 * Si la IA marcó [MSG_SPLIT] explícitamente o no hay nada que splittear, devuelve
 * el array tal cual. Solo sobre-actúa cuando el chatType pide modo específico.
 *
 * Caso PAREDÓN: si recibe array de N partes para chatType lead/follow_up_cold,
 * concatena y devuelve [textoÚnico] con saltos preservados. Garantiza paredón.
 *
 * Caso SPLIT: si recibe texto largo monolítico para chatType family/friend/ale,
 * intenta dividir por dobles saltos de línea, luego oraciones cortas, luego
 * chunks de máximo N chars (variable por chatType).
 */

'use strict';

// Tope máximo por chunk para chatTypes de split agresivo (chars)
const SPLIT_LIMITS = {
  ale_pareja:        80,    // ultra-corto
  friend_argentino:  100,   // ultra-corto
  family:            140,   // breve
  friend_colombiano: 220,   // moderado
  medilink_team:     280,   // operativo
  owner_selfchat:    400,   // mediano (Mariano puede leer más)
  client:            600,   // mezcla — paredón pequeño
  lead:              900,   // paredón único
  enterprise_lead:   900,
  follow_up_cold:    9999   // un solo bloque (3 párrafos juntos)
};

// chatTypes que NUNCA se splitean (se compactan a un único bloque)
const FORCE_PAREDON = new Set(['lead', 'enterprise_lead', 'follow_up_cold']);

// chatTypes que sí permiten múltiples burbujas
const ALLOW_SPLIT = new Set([
  'family', 'friend_argentino', 'friend_colombiano',
  'ale_pareja', 'medilink_team', 'owner_selfchat', 'client'
]);

/**
 * Une un array de partes en un solo string respetando saltos.
 */
function joinParts(parts) {
  if (!Array.isArray(parts)) return String(parts || '');
  return parts.filter(Boolean).map(p => String(p).trim()).filter(Boolean).join('\n\n');
}

/**
 * Divide texto en oraciones por puntuación dura (.!?), preservando los signos.
 */
function splitBySentence(text) {
  if (!text) return [];
  const out = [];
  const rx = /[^.!?\n]+[.!?]+|[^.!?\n]+$/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : [text];
}

/**
 * Divide por dobles saltos de línea (párrafos).
 */
function splitByParagraph(text) {
  if (!text) return [];
  return text.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Empaqueta una lista de fragmentos en chunks que no superen `limit` chars.
 * Mantiene el orden y une fragmentos contiguos cuando caben.
 */
function packIntoLimit(fragments, limit) {
  const out = [];
  let buf = '';
  for (const frag of fragments) {
    const candidate = buf ? `${buf}\n${frag}` : frag;
    if (candidate.length <= limit) {
      buf = candidate;
    } else {
      if (buf) out.push(buf);
      // Si el fragmento solo ya excede limit, lo dejamos pasar (no truncamos contenido).
      buf = frag;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * splitBySubregistro — punto de entrada principal.
 *
 * @param {string|string[]} input — texto monolítico O array ya splitteado por la IA / splitter previo
 * @param {string} chatType — chatType V2 resuelto (ver SUBREGISTRO_HEADERS en voice_v2_loader)
 * @param {object} [opts]
 * @param {boolean} [opts.respectExistingSplit] — si true (default) y `input` ya es array con N>1,
 *                  respeta la decisión del splitter previo SALVO que chatType ∈ FORCE_PAREDON.
 *                  Si false, reagrupa según política del subregistro.
 * @returns {string[]} array de burbujas finales (1 o más).
 */
function splitBySubregistro(input, chatType, opts = {}) {
  const respectExistingSplit = opts.respectExistingSplit !== false; // default true
  const limit = SPLIT_LIMITS[chatType] || SPLIT_LIMITS.client; // default conservador

  // Normaliza input a array
  let parts;
  if (Array.isArray(input)) {
    parts = input.filter(Boolean).map(p => String(p).trim()).filter(Boolean);
  } else {
    parts = [String(input || '').trim()].filter(Boolean);
  }

  if (parts.length === 0) return [];

  // CASO 1: PAREDÓN forzado (lead, enterprise_lead, follow_up_cold)
  if (FORCE_PAREDON.has(chatType)) {
    const single = joinParts(parts);
    return single ? [single] : [];
  }

  // CASO 2: respeta split existente si ya viene splitteado y chatType permite split
  if (respectExistingSplit && parts.length > 1 && ALLOW_SPLIT.has(chatType)) {
    return parts;
  }

  // CASO 3: chatType desconocido o caller pide reagrupación → aplicar heurística
  const monolithic = joinParts(parts);

  // 3a) Si cabe en un chunk, no splittear
  if (monolithic.length <= limit) return [monolithic];

  // 3b) Intentar dividir por párrafos
  let frags = splitByParagraph(monolithic);
  if (frags.length === 1) {
    // 3c) Sin párrafos → dividir por oraciones
    frags = splitBySentence(monolithic);
  }

  // 3d) Empaquetar dentro del límite
  const packed = packIntoLimit(frags, limit);
  return packed.length ? packed : [monolithic];
}

/**
 * Helper: clasifica el modo del subregistro (string semántico para logging).
 */
function getSplitMode(chatType) {
  if (FORCE_PAREDON.has(chatType)) return 'paredon';
  if (chatType === 'ale_pareja' || chatType === 'friend_argentino') return 'split_ultra_corto';
  if (chatType === 'family') return 'split_breve';
  if (chatType === 'friend_colombiano' || chatType === 'medilink_team' || chatType === 'owner_selfchat') return 'split_moderado';
  if (chatType === 'client') return 'mezcla';
  return 'default_conservador';
}

module.exports = {
  splitBySubregistro,
  getSplitMode,
  SPLIT_LIMITS,
  FORCE_PAREDON,
  ALLOW_SPLIT,
  // helpers exportados para tests
  splitByParagraph,
  splitBySentence,
  packIntoLimit,
  joinParts
};
