/**
 * v2_auditor.js — Auditor post-generación V2 con 10 red flags (C-386 A.4)
 *
 * Especificación: prompts/v2/mode_detectors.md §3 + §8.
 *
 * Pipeline (mode_detectors §4):
 *   ... → Gemini/Sonnet/Opus genera respuesta candidato
 *      ↓
 *   [5] auditV2Response(candidate, chatType, ctx) ← ESTE MÓDULO
 *      ↓
 *   [6] Si flagged crítico → regenerar UNA VEZ con hint inyectado
 *      ↓
 *   [7] Si segunda generación también flagged → fallback §8 por chatType
 *      ↓
 *   [8] split_smart_heuristic
 *      ↓
 *   [9] emoji_injector
 *      ↓
 *   safeSendMessage
 *
 * Contrato:
 *   - El auditor NO llama a Gemini/Sonnet — solo audita.
 *   - Devuelve { ok, flagged, criticalFlags[], warningFlags[], hint, fallback }
 *   - El caller (TMH) decide si re-llamar a aiGateway con hint, o enviar fallback.
 *   - 2 prioridades: CRÍTICO (#7 ale + #8 no_ia) → regenerar SIEMPRE.
 *                    NORMAL (#1 #2 #5 #6 #10) → regenerar si peakLevel/contexto pertinente.
 *                    WARNING (#3 #4 #9) → log + continuar (no regenera por defecto).
 *
 * Cubre los bugs CLAUDE.md §6.2 (queja malinterpretada), §6.23 (PROMESA ROTA cotización),
 * §6.24 (metadata sistema visible al lead) — vía detección directa por regex.
 */

'use strict';

// Phone constants (mismo set que voice_v2_loader)
const ALE_PHONE = '573137501884';

// chatTypes que CUENTAN como "lead-like" para flag #8 (no IA)
const LEAD_LIKE = new Set(['lead', 'enterprise_lead', 'client']);

// chatTypes que SÍ permiten admitir IA si preguntan (mode_detectors §3 RF#8 excepción familia)
const FAMILY_LIKE = new Set(['family', 'ale_pareja']);

// chatTypes que cuentan como "informal argentino" para RF#9
const ARGENTINO = new Set(['friend_argentino', 'family', 'ale_pareja', 'owner_selfchat']);

// chatTypes colombianos para RF#6 (diminutivos suavizadores)
const COLOMBIANO = new Set(['friend_colombiano']);

// chatTypes formales (lead/client medilink) donde vocativo informal súbito = flag #9
const FORMAL_PRO = new Set(['lead', 'enterprise_lead', 'client', 'medilink_team']);

/* ============================================================================
 *  RED FLAG DETECTORS — mode_detectors.md §3
 * ============================================================================ */

/**
 * RF#1 — auto_promesa_sin_cumplimiento (PROMESA ROTA, §6.23)
 * Detecta verbos cerrados sobre cosas que NO dependen 100% de MIIA.
 */
function detectAutoPromesa(text) {
  if (!text) return null;
  const patterns = [
    /\bte\s+lo\s+consig(o|uo)\b/i,
    /\beso\s+est[áa]\s+hecho\b/i,
    /\bya\s+lo\s+arreglo\b/i,
    /\blo\s+ten[ée]s\s+(mañana|hoy|el\s+\w+)\s+sin\s+falta\b/i,
    /\b(ya\s+te\s+lo\s+(envi[éo]|mand[éo]))\b/i,
    /\b(en\s+un\s+momento|en\s+breve|enseguida)\s+te\s+(env[íi]o|paso|mando)\b/i,
    /\bte\s+(env[íi]o|paso|mando|tengo)\s+(la|el)\s+\w+\s+(ya|en\s+un\s+rato)\b/i,
    /\bmañana\s+(sin\s+falta\s+)?lo\s+ten[ée]s\b/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) {
      return { match: m[0], pattern: rx.source };
    }
  }
  return null;
}

/**
 * RF#2 — transparencia_limite_negociacion
 * Requiere ctx.hasMargin (caller sabe si hay margen restante).
 */
function detectFalsoLimite(text, ctx) {
  if (!text || !ctx || ctx.hasMargin !== true) return null;
  const patterns = [
    /\b[úu]ltimo\s+precio\b/i,
    /\bprecio\s+final\b/i,
    /\bmi\s+mejor\s+oferta\b/i,
    /\bno\s+puedo\s+bajar\s+m[áa]s\b/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) return { match: m[0], pattern: rx.source };
  }
  return null;
}

/**
 * RF#3 — escalamiento_a_soporte
 * Si el contacto preguntó algo técnico/facturación y la respuesta NO escala.
 */
function detectFaltaEscalamiento(text, ctx) {
  if (!text || !ctx || !ctx.lastContactMessage) return null;
  const lastMsg = String(ctx.lastContactMessage).toLowerCase();
  const askedSupport = /\b(factura|facturaci[óo]n|comprobante|recibo|cobr[oa]|movimiento|cargo|reembolso|cuenta\s+t[ée]cnica)\b/.test(lastMsg);
  if (!askedSupport) return null;
  const hasEscalation = /\b(soporte|hello@medilinkgroup|email|escrib[íi]\s+a|te\s+ayudan\s+con)\b/i.test(text);
  const hasInventedAnswer = /\b(tu\s+factura\s+es|tu\s+saldo\s+es|tu\s+cargo\s+fue)\b/i.test(text);
  if (!hasEscalation || hasInventedAnswer) {
    return { askedSupport: true, hasEscalation, hasInventedAnswer };
  }
  return null;
}

/**
 * RF#4 — referencia_a_incidentes_publicos (uso correcto)
 * Solo flag si lead pregunta seguridad/privacidad/certificación y respuesta no ancla a caso.
 */
function detectFaltaAnclaje(text, ctx) {
  if (!text || !ctx || !ctx.lastContactMessage) return null;
  const lastMsg = String(ctx.lastContactMessage).toLowerCase();
  const askedSecurity = /\b(seguridad|privacidad|datos\s+confidenciales|certificaci[óo]n|hipaa|gdpr|encriptaci[óo]n|filtraci[óo]n|hackeo|brecha)\b/.test(lastMsg);
  if (!askedSecurity) return null;
  const hasAnchor = /\b(shakira|ISO\s*27001|hospital\s+privado\s+de\s+per[úu]|multa)\b/i.test(text);
  if (!hasAnchor) {
    return { askedSecurity: true, hasAnchor: false };
  }
  return null;
}

/**
 * RF#5 — empatia_cancelacion
 * Cliente anuncia baja → respuesta NO debe defender ni ofrecer descuento inmediato.
 */
function detectMalaCancelacion(text, ctx) {
  if (!text || !ctx || !ctx.lastContactMessage) return null;
  const lastMsg = String(ctx.lastContactMessage).toLowerCase();
  const announcesCancel = /\b(cancelar|dar\s+de\s+baja|no\s+continu[oa]|me\s+voy|no\s+sigo|me\s+doy\s+de\s+baja|baja\s+(la\s+)?cuenta)\b/.test(lastMsg);
  if (!announcesCancel) return null;
  const hasDefense = /\b(pero\s+por\s+qu[ée]|si\s+funciona\s+bien|justo\s+ahora|date\s+cuenta\s+que)\b/i.test(text);
  const hasInstantDiscount = /\b(te\s+(doy|hago)\s+(un\s+)?\d+%|descuento\s+(de\s+)?\d+%)\b/i.test(text);
  const hasEmpathy = /\b(comprendo|entiendo|gracias\s+por\s+(decirme|contarme|el\s+feedback))\b/i.test(text);
  if (hasDefense || hasInstantDiscount || !hasEmpathy) {
    return { announcesCancel: true, hasDefense, hasInstantDiscount, hasEmpathy };
  }
  return null;
}

/**
 * RF#6 — diminutivos_suavizadores
 * En chat colombiano sin diminutivos → flag.
 * En chat argentino con diminutivos colombianos forzados → flag inverso.
 */
function detectDiminutivos(text, chatType) {
  if (!text) return null;
  if (COLOMBIANO.has(chatType)) {
    const hasSuavizador = /\b(cosita|ratico|momentito|ratito|cositita|rapidito|prontito)\b/i.test(text);
    const hasDirectAsk = /\b(necesito|mand[áa]me|pas[áa]me|hac[éé]me|envi[áa]me)\b/i.test(text);
    if (hasDirectAsk && !hasSuavizador) {
      return { kind: 'colombiano_sin_suavizador', hasDirectAsk: true };
    }
  }
  if (ARGENTINO.has(chatType)) {
    const hasColForzado = /\b(parcerito|chevere|che\s+pues|qu[ée]\s+chimba)\b/i.test(text);
    if (hasColForzado) {
      return { kind: 'argentino_con_forzado_colombiano' };
    }
  }
  return null;
}

/**
 * RF#7 — exclusividad_lenguaje_ale ⚠️ CRÍTICO
 * Vocablos exclusivos de Ale en chat de OTRO contacto = veto inmediato.
 */
function detectAleLeak(text, chatType, ctx) {
  if (!text) return null;
  // Si el chat ES con Ale, no hay leak posible
  const isAleChat = chatType === 'ale_pareja' || (ctx && ctx.basePhone === ALE_PHONE);
  if (isAleChat) return null;

  const patterns = [
    { rx: /\bmicu(\s+micu)?\b/i, label: 'micu' },
    { rx: /\bamorzote\b/i, label: 'amorzote' },
    { rx: /\bgordit[ao]\b/i, label: 'gordita' },
    { rx: /\bmor\b(?!\s*[a-záéíóúñ])/i, label: 'mor' }, // "mor" como vocativo (no parte de "amor", "memorable", etc)
    { rx: /\bbesos\s+mor\b/i, label: 'besos mor' },
    { rx: /🥰/u, label: 'emoji 🥰' },
    { rx: /😘/u, label: 'emoji 😘' },
  ];
  const hits = [];
  for (const p of patterns) {
    const m = text.match(p.rx);
    if (m) hits.push({ label: p.label, match: m[0] });
  }
  if (hits.length > 0) {
    return { hits };
  }
  return null;
}

/**
 * RF#8 — no_ia_con_leads ⚠️ CRÍTICO
 * Respuesta a lead/client revela ser IA o expone mecánica interna.
 * Excepción: family/ale_pareja (familia sabe que existe MIIA).
 * Excepción: chatType === 'miia_lead' (MIIA CENTER tiene reglas distintas).
 */
function detectIALeak(text, chatType) {
  if (!text) return null;
  if (chatType === 'miia_lead') return null; // MIIA CENTER permite admitir IA
  if (FAMILY_LIKE.has(chatType)) return null; // familia sabe — no flag
  if (chatType === 'owner_selfchat') return null; // self-chat = Mariano consigo

  // Solo aplicamos a leads, clients, medilink_team, follow_up_cold, group desconocido
  const patterns = [
    { rx: /\bsoy\s+(una?|el|la)\s+(ia|i\.a\.|inteligencia\s+artificial)\b/i, label: 'admite IA' },
    { rx: /\bsoy\s+(una?|el|la)\s+\w+(\s+\w+)?\s+(de|con)\s+(ia|i\.a\.|inteligencia\s+artificial)\b/i, label: 'admite "de IA" (asistente de IA, etc)' },
    { rx: /\bsoy\s+un?a?\s+(asistente\s+virtual|bot|chatbot|asistente\s+autom[áa]tic[ao]|asistente\s+digital)\b/i, label: 'admite asistente virtual/bot' },
    { rx: /\b(automatiza|automatizo|automatic[ao])\s+(estos\s+)?mensajes?\b/i, label: 'admite automatización de mensajes' },
    { rx: /\b(no\s+soy\s+una\s+persona\s+real|soy\s+un\s+programa)\b/i, label: 'admite no-persona' },
    { rx: /\bmi\s+(sistema|algoritmo|modelo\s+de\s+lenguaje|prompt|backend)\b/i, label: 'expone mecánica' },
    { rx: /\b(gemini|gpt|claude|openai|anthropic|llama|mistral)\b/i, label: 'menciona modelo IA' },
    { rx: /\b(firestore|baileys|whatsapp\s+api|google\s+cloud|railway)\b/i, label: 'expone infraestructura' },
    { rx: /\b(prompt|cron|pipeline|tag|webhook)\b/i, label: 'expone término técnico' },
  ];
  const hits = [];
  for (const p of patterns) {
    const m = text.match(p.rx);
    if (m) hits.push({ label: p.label, match: m[0] });
  }
  if (hits.length > 0) {
    return { hits };
  }
  return null;
}

/**
 * RF#9 — cambio_registro_inter_conversacional
 * Vocativo informal en chat formal (lead/client/medilink_team).
 * NO regenera automáticamente — solo WARN.
 *
 * C-388 SEC-B.4: en MIIA CENTER (etapa 1, scope V2), 'lead' y 'client' provienen de
 * chatType MIIA_SALES_PROFILE (miia_lead/miia_client mapeados por resolveV2ChatType).
 * V2 AMPLIFICA MIIA_SALES_PROFILE — RF#9 sigue warn-only para no pisar las 12 reglas
 * que el sales profile ya impone. Si MIIA CENTER deja escapar "papu" a un lead, queda
 * en log para revisión humana, NO se regenera.
 */
function detectCambioRegistro(text, chatType) {
  if (!text || !FORMAL_PRO.has(chatType)) return null;
  const informalVocativos = /\b(papu|querido|che(?!\s)|boludo|mi\s+hermano|loco|chabón|amigo\s+mio)\b/i;
  const m = text.match(informalVocativos);
  if (m) {
    return { match: m[0] };
  }
  return null;
}

/**
 * RF#10 — uso_exceso_mayusculas
 * >30% caracteres alfabéticos en MAYÚSCULAS sostenidas, excepto onboarding/énfasis controlado.
 */
function detectExcesoMayusculas(text) {
  if (!text) return null;
  // Excepciones legítimas
  const isOnboardingCelebration = /Bienvenid[@oa]|Cuenta\s+confirmada|¡Listo!/i.test(text);
  if (isOnboardingCelebration) return null;
  // Énfasis controlado *MUY IMPORTANTE* o palabras sueltas en mayúsculas dentro de contexto normal
  const stripped = text.replace(/[^A-Za-záéíóúÁÉÍÓÚñÑ]/g, '');
  if (stripped.length < 20) return null; // texto muy corto, ignorar
  const upper = stripped.replace(/[^A-ZÁÉÍÓÚÑ]/g, '');
  const ratio = upper.length / stripped.length;
  if (ratio > 0.3) {
    return { ratio: Number(ratio.toFixed(3)), upperCount: upper.length, totalAlpha: stripped.length };
  }
  return null;
}

/* ============================================================================
 *  AUDITOR — orquestador
 * ============================================================================ */

/**
 * auditV2Response — punto de entrada principal.
 *
 * @param {string} candidate — respuesta generada por IA, pre-envío
 * @param {string} chatType — chatType V2 resuelto
 * @param {object} [ctx]
 * @param {string} [ctx.basePhone] — teléfono del contacto (para detección Ale leak)
 * @param {string} [ctx.lastContactMessage] — último mensaje del contacto (para flags #3 #4 #5)
 * @param {boolean} [ctx.hasMargin] — true si hay margen restante (para flag #2)
 * @param {number} [ctx.attemptNumber] — 1=primer intento, 2=segundo (post-regenerate)
 * @returns {{
 *   ok: boolean,
 *   flagged: boolean,
 *   criticalFlags: Array<{code, label, detail}>,
 *   warningFlags: Array<{code, label, detail}>,
 *   hint: string|null,
 *   fallback: string|null,
 *   shouldRegenerate: boolean,
 *   shouldUseFallback: boolean
 * }}
 */
function auditV2Response(candidate, chatType, ctx = {}) {
  const empty = {
    ok: false,
    flagged: false,
    criticalFlags: [],
    warningFlags: [],
    hint: null,
    fallback: null,
    shouldRegenerate: false,
    shouldUseFallback: false,
  };

  if (!candidate || typeof candidate !== 'string') {
    return { ...empty, ok: true, fallback: getFallbackByChatType(chatType), shouldUseFallback: true };
  }

  const attemptNumber = Number(ctx.attemptNumber) || 1;
  const criticalFlags = [];
  const warningFlags = [];

  // ===== CRÍTICOS (regenerar inmediato) =====
  const aleLeak = detectAleLeak(candidate, chatType, ctx);
  if (aleLeak) {
    criticalFlags.push({
      code: 'RF7_exclusividad_ale',
      label: '⚠️ CRÍTICO: vocablo exclusivo de Ale en chat de otro contacto',
      detail: aleLeak,
    });
  }

  const iaLeak = detectIALeak(candidate, chatType);
  if (iaLeak) {
    criticalFlags.push({
      code: 'RF8_no_ia_con_leads',
      label: '⚠️ CRÍTICO: respuesta a lead/client revela IA o expone mecánica',
      detail: iaLeak,
    });
  }

  // ===== NORMALES (regenerar si en lead/client/formal) =====
  const promesa = detectAutoPromesa(candidate);
  if (promesa) {
    const sev = LEAD_LIKE.has(chatType) || chatType === 'medilink_team' ? 'critical' : 'warning';
    (sev === 'critical' ? criticalFlags : warningFlags).push({
      code: 'RF1_auto_promesa',
      label: 'PROMESA ROTA: verbo cerrado sobre cosa no garantizada',
      detail: promesa,
    });
  }

  const falsoLimite = detectFalsoLimite(candidate, ctx);
  if (falsoLimite) {
    criticalFlags.push({
      code: 'RF2_falso_limite_negociacion',
      label: 'Dice "precio final" pero hay margen restante',
      detail: falsoLimite,
    });
  }

  const faltaEscalamiento = detectFaltaEscalamiento(candidate, ctx);
  if (faltaEscalamiento) {
    criticalFlags.push({
      code: 'RF3_falta_escalamiento_soporte',
      label: 'Pregunta de facturación/cobro sin escalar a soporte',
      detail: faltaEscalamiento,
    });
  }

  const faltaAnclaje = detectFaltaAnclaje(candidate, ctx);
  if (faltaAnclaje) {
    warningFlags.push({
      code: 'RF4_falta_anclaje_incidente',
      label: 'Pregunta de seguridad/privacidad sin anclaje a caso conocido',
      detail: faltaAnclaje,
    });
  }

  const malaCancel = detectMalaCancelacion(candidate, ctx);
  if (malaCancel) {
    criticalFlags.push({
      code: 'RF5_mala_cancelacion',
      label: 'Cliente anuncia baja: respuesta defensiva o sin empatía',
      detail: malaCancel,
    });
  }

  const diminutivos = detectDiminutivos(candidate, chatType);
  if (diminutivos) {
    warningFlags.push({
      code: 'RF6_diminutivos_inadecuados',
      label: diminutivos.kind,
      detail: diminutivos,
    });
  }

  const cambioRegistro = detectCambioRegistro(candidate, chatType);
  if (cambioRegistro) {
    warningFlags.push({
      code: 'RF9_cambio_registro',
      label: 'Vocativo informal en chat formal — revisar bucket',
      detail: cambioRegistro,
    });
  }

  const excesoMayus = detectExcesoMayusculas(candidate);
  if (excesoMayus) {
    const sev = LEAD_LIKE.has(chatType) ? 'critical' : 'warning';
    (sev === 'critical' ? criticalFlags : warningFlags).push({
      code: 'RF10_exceso_mayusculas',
      label: `>30% MAYÚSCULAS (ratio=${excesoMayus.ratio})`,
      detail: excesoMayus,
    });
  }

  // ===== Decisiones =====
  const flagged = criticalFlags.length > 0;

  // Política regenerate-once + fallback §8:
  // - Primer intento + crítico → regenerar
  // - Segundo intento + crítico → usar fallback
  // - Ningún crítico → ok, enviar tal cual
  let shouldRegenerate = false;
  let shouldUseFallback = false;
  let fallback = null;
  let hint = null;

  if (flagged) {
    if (attemptNumber >= 2) {
      shouldUseFallback = true;
      fallback = getFallbackByChatType(chatType);
    } else {
      shouldRegenerate = true;
      hint = buildRegenerationHint(criticalFlags, chatType);
    }
  }

  return {
    ok: true,
    flagged,
    criticalFlags,
    warningFlags,
    hint,
    fallback,
    shouldRegenerate,
    shouldUseFallback,
  };
}

/**
 * Fallback genérico mínimo por chatType (mode_detectors §8).
 *
 * @param {string} chatType
 * @returns {string|null} mensaje fallback. NULL si owner_selfchat (no enviar — alertar).
 */
function getFallbackByChatType(chatType) {
  switch (chatType) {
    case 'lead':
    case 'enterprise_lead':
    case 'client':
    case 'medilink_team':
    case 'follow_up_cold':
    case 'miia_lead':
      return 'Vale, dejame revisarlo y vuelvo en un rato 🤗';
    case 'family':
    case 'friend_argentino':
    case 'friend_colombiano':
      return 'Dale, ahora te respondo';
    case 'ale_pareja':
      return 'Ahora te respondo amor 🥰';
    case 'owner_selfchat':
      return null; // NO ENVIAR — caller debe alertar a Mariano
    default:
      return 'Dale, te respondo en un rato';
  }
}

/**
 * buildRegenerationHint — construye texto a inyectar al modelo en re-generación.
 * Formato: instrucciones específicas según los flags críticos detectados.
 */
function buildRegenerationHint(criticalFlags, chatType) {
  if (!criticalFlags || criticalFlags.length === 0) return null;
  const lines = [
    'AUDITOR V2 — la respuesta anterior fue rechazada. Regenerá teniendo en cuenta:',
  ];
  for (const f of criticalFlags) {
    switch (f.code) {
      case 'RF7_exclusividad_ale':
        lines.push(`- PROHIBIDO usar lenguaje exclusivo de Ale (micu, amorzote, gorda, 🥰, 😘, "Besos mor") en chat con ${chatType}. Esos vocablos son SOLO para Ale (+573137501884).`);
        break;
      case 'RF8_no_ia_con_leads':
        lines.push('- PROHIBIDO admitir ser IA, asistente virtual, bot, ni mencionar Gemini/GPT/Claude/Firestore/Baileys/backend/prompt. Sos Mariano De Stefano, persona real.');
        break;
      case 'RF1_auto_promesa':
        lines.push('- PROHIBIDO prometer cosas cerradas que no dependen 100% de vos. Reformulá con verbos de gestión: "Voy a preguntar eso ya mismo", "Lo reviso y vuelvo".');
        break;
      case 'RF2_falso_limite_negociacion':
        lines.push('- NO digas "precio final" / "último precio" / "no puedo bajar más" — todavía hay margen. Usá la fórmula: "máximo máximo, me permiten bajarlo a [X] y condicionado a tomarlo antes del [fecha] 😬".');
        break;
      case 'RF3_falta_escalamiento_soporte':
        lines.push('- El contacto preguntó facturación/cobros. NO inventes datos. Escalá: "Puedes escribir a hello@medilinkgroup.com que ahí te ayudan con eso".');
        break;
      case 'RF5_mala_cancelacion':
        lines.push('- Cliente anuncia baja. NO defiendas el producto, NO ofrezcas descuento al toque. Empatía primero: "Comprendo [nombre]. Si ha sido por algo de mi asesoramiento, precio u otra cuestión, no dude en contarme. Tu respuesta me es muy útil."');
        break;
      case 'RF10_exceso_mayusculas':
        lines.push('- Bajá las MAYÚSCULAS sostenidas. Usalas SOLO para énfasis quirúrgico ("MUY IMPORTANTE" puntual). El resto en minúscula natural.');
        break;
      default:
        lines.push(`- Revisar: ${f.label}`);
    }
  }
  return lines.join('\n');
}

/* ============================================================================
 *  EXPORTS
 * ============================================================================ */

module.exports = {
  auditV2Response,
  getFallbackByChatType,
  buildRegenerationHint,
  // detectores individuales (para tests)
  detectAutoPromesa,
  detectFalsoLimite,
  detectFaltaEscalamiento,
  detectFaltaAnclaje,
  detectMalaCancelacion,
  detectDiminutivos,
  detectAleLeak,
  detectIALeak,
  detectCambioRegistro,
  detectExcesoMayusculas,
  // constantes
  ALE_PHONE,
  LEAD_LIKE,
  FAMILY_LIKE,
};
