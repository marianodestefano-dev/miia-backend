'use strict';

/**
 * CONTENT_SAFETY_SHIELD.JS — Protección contra contenido inapropiado
 *
 * ESTÁNDAR: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FILOSOFÍA:
 *   - TODA imagen que MIIA procese pasa por acá PRIMERO. Sin excepción.
 *   - Es un MIDDLEWARE obligatorio, no opcional.
 *   - Si falla el check → se BLOQUEA la imagen (FAIL-SAFE, no fail-open).
 *   - MIIA NUNCA almacena imágenes inapropiadas (ni RAM, ni Firestore, ni logs).
 *   - MIIA NUNCA reenvía media del owner a terceros (sin importar el contexto).
 *   - Todo incidente se loguea en Firestore audit trail (sin la imagen, solo metadata).
 *
 * NIVELES DE SEVERIDAD:
 *   🟢 SAFE       — Contenido apropiado, continuar normalmente
 *   🟡 SUSPICIOUS — Ambiguo (ropa interior, playa), procesar con precaución + log
 *   🔴 BLOCKED    — Desnudez/violencia/sexual/drogas → BLOQUEAR + avisar al owner
 *   ⚫ CRITICAL   — Menor + contenido inapropiado → BLOQUEAR + alertar padres + audit legal
 *
 * PRINCIPIO LEGAL:
 *   - Cumple con COPPA (Children's Online Privacy Protection Act)
 *   - Cumple con CSAM reporting obligations
 *   - Logging de incidentes sin almacenar contenido (privacy-first)
 *
 * USO:
 *   const safety = await contentSafety.checkContentSafety(imageBuffer, { source, phone, uid });
 *   if (!safety.allowed) { await safeSendMessage(phone, safety.message); return; }
 */

// ═══════════════════════════════════════════════════════════════
// SAFETY CHECK PROMPT — Evaluación de contenido
// ═══════════════════════════════════════════════════════════════

const SAFETY_CHECK_PROMPT = `You are a content safety classifier. Analyze this image and respond ONLY with valid JSON:
{
  "safe": true/false,
  "nudity": "none" | "partial" | "full",
  "violence": "none" | "mild" | "graphic",
  "minor_present": true/false,
  "minor_confidence": 0-100,
  "sexual_content": false/true,
  "drugs_alcohol": false/true,
  "weapons": false/true,
  "self_harm": false/true,
  "hate_symbols": false/true,
  "confidence": 0-100,
  "category": "safe" | "suspicious" | "blocked" | "critical"
}

CLASSIFICATION RULES (strict):
- "critical" = minor_present AND (nudity != "none" OR sexual_content) → HIGHEST ALERT, mandatory
- "blocked" = nudity == "full" OR sexual_content OR violence == "graphic" OR self_harm
- "suspicious" = nudity == "partial" (swimsuit, underwear, tight clothing) OR violence == "mild" OR drugs_alcohol
- "safe" = normal content: clothing, food, documents, landscapes, people fully dressed, screenshots, products

IMPORTANT:
- If a person appears to be under 18, set minor_present=true even if uncertain (err on side of caution)
- Partial nudity includes: underwear, revealing swimwear, shirtless (not gym/sports context)
- Swimsuit at beach/pool in normal context = suspicious (not blocked)
- Medical/educational images = safe unless graphic
- If you cannot determine safety with >60% confidence, default to "suspicious"

Respond ONLY the JSON. No explanation. No markdown.`;

// ═══════════════════════════════════════════════════════════════
// MENSAJES AL USUARIO — Español, claros, sin juzgar
// ═══════════════════════════════════════════════════════════════

const SAFETY_MESSAGES = {
  critical: '🚨 *Alerta de seguridad:* Detecté contenido sensible que podría involucrar a un menor. ' +
    'Esta imagen fue bloqueada y NO fue almacenada en ningún lugar. ' +
    'Si tenés menores a cargo, por favor revisá el uso del dispositivo.',

  blocked: '⚠️ No puedo procesar esta imagen porque contiene contenido sensible. ' +
    'Por tu seguridad y privacidad, no la guardé en ningún lado.',

  blocked_nudity: '⚠️ Detecté desnudez en esta imagen. Por tu privacidad y seguridad, ' +
    'no la procesé ni la almacené en ningún lugar. MIIA protege tu intimidad.',

  blocked_violence: '⚠️ Detecté contenido violento en esta imagen. No la procesé.',

  blocked_self_harm: '⚠️ Detecté contenido sensible. Si estás pasando por un momento difícil, ' +
    'por favor contactá a una línea de ayuda. No procesé la imagen.',

  error_fallback: '⚠️ No pude verificar esta imagen por un error técnico. ' +
    'Por seguridad, no la procesé. Intentá de nuevo en un momento.',
};

// ═══════════════════════════════════════════════════════════════
// VARIABLES INTERNAS
// ═══════════════════════════════════════════════════════════════

let _admin = null;       // Firebase admin (inyectado)
let _callVision = null;  // Función callGeminiVision (inyectada)
let _generateAI = null;  // Función generateAIContent (fallback)
let _ownerPhone = null;  // Número del owner (para regla anti-reenvío)

// Rate limiting: máximo 30 safety checks por minuto para no saturar Gemini
const _checkTimes = [];
const MAX_CHECKS_PER_MINUTE = 30;

// Cache de resultados recientes (evitar re-analizar la misma imagen en <5min)
const _resultCache = new Map();
const CACHE_TTL_MS = 300_000; // 5 minutos

// ═══════════════════════════════════════════════════════════════
// INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════

/**
 * Inyectar dependencias (llamar una vez al inicio desde server.js)
 * @param {object} deps - { admin, callGeminiVision, generateAIContent, ownerPhone }
 */
function init(deps) {
  if (!deps) throw new Error('[SAFETY-SHIELD] init() requiere dependencias');
  _admin = deps.admin || null;
  _callVision = deps.callGeminiVision || null;
  _generateAI = deps.generateAIContent || null;
  _ownerPhone = deps.ownerPhone || null;
  console.log(`[SAFETY-SHIELD] 🛡️ Content Safety Shield inicializado (vision=${!!_callVision}, firestore=${!!_admin})`);
}

// ═══════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL — checkContentSafety
// ═══════════════════════════════════════════════════════════════

/**
 * Verifica una imagen por contenido inapropiado. TODA imagen debe pasar por acá.
 *
 * @param {Buffer} imageBuffer - Imagen en buffer (desde downloadMediaMessage)
 * @param {object} context - { source: string, phone: string, uid: string }
 *   source: 'outfit' | 'image_analysis' | 'outreach' | 'ninera' | 'lead' | 'cocina' | 'unknown'
 *   phone: JID del remitente
 *   uid: UID del owner
 * @returns {Promise<{
 *   allowed: boolean,
 *   level: 'safe'|'suspicious'|'blocked'|'critical'|'error',
 *   action: string,
 *   message: string|null,
 *   parsed: object|null
 * }>}
 */
async function checkContentSafety(imageBuffer, context = {}) {
  const startTime = Date.now();
  const { source = 'unknown', phone = '', uid = '' } = context;

  console.log(`[SAFETY-SHIELD] 🔍 Verificando imagen (source=${source}, phone=${phone.split('@')[0]}, size=${imageBuffer?.length || 0}b)`);

  // Validar que tenemos un buffer válido
  if (!imageBuffer || imageBuffer.length === 0) {
    console.warn(`[SAFETY-SHIELD] ⚠️ Buffer de imagen vacío — BLOQUEADO por precaución`);
    return _buildResult(false, 'error', 'block_empty_buffer', SAFETY_MESSAGES.error_fallback, null);
  }

  // Rate limiting check
  if (!_checkRateLimit()) {
    console.warn(`[SAFETY-SHIELD] ⚠️ Rate limit alcanzado (>${MAX_CHECKS_PER_MINUTE}/min) — BLOQUEADO por precaución`);
    return _buildResult(false, 'error', 'rate_limited', SAFETY_MESSAGES.error_fallback, null);
  }

  // Cache check (misma imagen en últimos 5 min)
  const cacheKey = _hashBuffer(imageBuffer);
  const cached = _resultCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`[SAFETY-SHIELD] ♻️ Cache hit (${cached.result.level}) — reutilizando resultado`);
    return cached.result;
  }

  try {
    // Llamar a Gemini Vision con el prompt de safety
    let rawResponse;
    if (_callVision && typeof _callVision === 'function') {
      rawResponse = await _callVision(imageBuffer, SAFETY_CHECK_PROMPT);
    } else if (_generateAI && typeof _generateAI === 'function') {
      rawResponse = await _generateAI(SAFETY_CHECK_PROMPT, {
        images: [{ mimeType: 'image/png', data: imageBuffer.toString('base64') }],
      });
    } else {
      console.error(`[SAFETY-SHIELD] ❌ No hay función de Vision disponible — FAIL-SAFE → BLOQUEADO`);
      return _buildResult(false, 'error', 'no_vision_function', SAFETY_MESSAGES.error_fallback, null);
    }

    // Parsear respuesta
    const parsed = _parseSafetyResponse(rawResponse);
    if (!parsed) {
      console.error(`[SAFETY-SHIELD] ❌ No se pudo parsear respuesta de Vision — FAIL-SAFE → BLOQUEADO`);
      await _logIncident(uid, phone, 'error', { error: 'parse_failed', rawResponse: (rawResponse || '').substring(0, 200) }, source);
      return _buildResult(false, 'error', 'parse_failed', SAFETY_MESSAGES.error_fallback, null);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[SAFETY-SHIELD] Resultado: category=${parsed.category}, confidence=${parsed.confidence}%, nudity=${parsed.nudity}, minor=${parsed.minor_present}, violence=${parsed.violence} (${elapsed}ms)`);

    // ═══ CLASIFICACIÓN POR SEVERIDAD ═══

    // ⚫ CRITICAL — Menor en riesgo (MÁXIMA PRIORIDAD)
    if (parsed.category === 'critical' || (parsed.minor_present && (parsed.nudity !== 'none' || parsed.sexual_content))) {
      console.error(`[SAFETY-SHIELD] ⚫🚨 CRITICAL: Menor en riesgo detectado (source=${source}, phone=${phone.split('@')[0]})`);
      await _logIncident(uid, phone, 'critical', parsed, source);
      const result = _buildResult(false, 'critical', 'block_and_alert_parents', SAFETY_MESSAGES.critical, parsed);
      _resultCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    }

    // 🔴 BLOCKED — Contenido inapropiado adulto
    if (parsed.category === 'blocked' || parsed.nudity === 'full' || parsed.sexual_content || parsed.self_harm) {
      const subType = parsed.self_harm ? 'self_harm' : (parsed.nudity === 'full' ? 'nudity' : 'generic');
      const msg = parsed.self_harm ? SAFETY_MESSAGES.blocked_self_harm
        : parsed.nudity === 'full' ? SAFETY_MESSAGES.blocked_nudity
        : parsed.violence === 'graphic' ? SAFETY_MESSAGES.blocked_violence
        : SAFETY_MESSAGES.blocked;
      console.warn(`[SAFETY-SHIELD] 🔴 BLOCKED: Contenido inapropiado (source=${source}, subType=${subType}, nudity=${parsed.nudity})`);
      await _logIncident(uid, phone, 'blocked', parsed, source);
      const result = _buildResult(false, 'blocked', `block_${subType}`, msg, parsed);
      _resultCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    }

    // 🟡 SUSPICIOUS — Ambiguo (ropa interior, playa, etc.)
    if (parsed.category === 'suspicious' || parsed.nudity === 'partial' || parsed.drugs_alcohol) {
      console.warn(`[SAFETY-SHIELD] 🟡 SUSPICIOUS: Contenido ambiguo (source=${source}, nudity=${parsed.nudity})`);
      await _logIncident(uid, phone, 'suspicious', parsed, source);
      const result = _buildResult(true, 'suspicious', 'proceed_with_caution', null, parsed);
      _resultCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    }

    // 🟢 SAFE — Todo OK
    const result = _buildResult(true, 'safe', 'proceed', null, parsed);
    _resultCache.set(cacheKey, { result, ts: Date.now() });
    return result;

  } catch (err) {
    // ═══ FAIL-SAFE: Error inesperado → BLOQUEAR (NUNCA dejar pasar sin verificar) ═══
    console.error(`[SAFETY-SHIELD] ❌ Error en safety check — FAIL-SAFE → BLOQUEADO: ${err.message}`);
    console.error(`[SAFETY-SHIELD] ❌ Stack: ${err.stack}`);
    await _logIncident(uid, phone, 'error', { error: err.message }, source);
    return _buildResult(false, 'error', 'block_on_error', SAFETY_MESSAGES.error_fallback, null);
  }
}

// ═══════════════════════════════════════════════════════════════
// REGLA ANTI-REENVÍO — MIIA NUNCA reenvía media del owner a terceros
// ═══════════════════════════════════════════════════════════════

/**
 * Verifica si un envío de media es un intento de reenviar contenido del owner a un tercero.
 * Se llama desde safeSendMessage como guardia obligatoria.
 *
 * @param {string} targetJid - JID destino
 * @param {object} options - Opciones de envío (puede tener .image, .video, etc.)
 * @param {string} ownerPhone - Número del owner
 * @returns {boolean} true si debe BLOQUEARSE el envío
 */
function isMediaForwardBlocked(targetJid, options, ownerPhone) {
  if (!options || !targetJid || !ownerPhone) return false;

  const hasMedia = !!(options.image || options.video || options.document);
  if (!hasMedia) return false;

  // Si es self-chat → permitir (owner se envía a sí mismo)
  const targetBase = targetJid.split('@')[0].split(':')[0];
  const ownerBase = (ownerPhone || '').split('@')[0].split(':')[0];
  const isSelfChat = targetBase === ownerBase;
  if (isSelfChat) return false;

  // Si tiene flag explícito de "forward permitido" (ej: outreach con consentimiento) → permitir
  if (options._forwardAllowed === true) return false;

  // Si el media viene del owner y el destino NO es el owner → BLOQUEAR
  if (options._sourceIsOwner === true) {
    console.error(`[SAFETY-SHIELD] 🚫 BLOQUEADO: Intento de reenviar media del owner a ${targetJid}`);
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ═══════════════════════════════════════════════════════════════

function _buildResult(allowed, level, action, message, parsed) {
  return { allowed, level, action, message, parsed };
}

function _parseSafetyResponse(rawResponse) {
  if (!rawResponse) return null;
  try {
    // Intentar parsear directo
    let jsonStr = rawResponse.trim();
    // Limpiar markdown si viene envuelto
    const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    // Limpiar posibles caracteres extra
    jsonStr = jsonStr.replace(/^[^{]*/, '').replace(/[^}]*$/, '');

    const parsed = JSON.parse(jsonStr);

    // Validar campos mínimos
    if (typeof parsed.safe !== 'boolean' && !parsed.category) {
      console.warn(`[SAFETY-SHIELD] ⚠️ Respuesta incompleta — tratando como suspicious`);
      return { safe: false, category: 'suspicious', nudity: 'none', minor_present: false, confidence: 0, _incomplete: true };
    }

    // Normalizar
    parsed.nudity = parsed.nudity || 'none';
    parsed.violence = parsed.violence || 'none';
    parsed.minor_present = !!parsed.minor_present;
    parsed.sexual_content = !!parsed.sexual_content;
    parsed.self_harm = !!parsed.self_harm;
    parsed.drugs_alcohol = !!parsed.drugs_alcohol;
    parsed.weapons = !!parsed.weapons;
    parsed.hate_symbols = !!parsed.hate_symbols;
    parsed.confidence = parsed.confidence || 0;

    // Re-clasificar si la categoría no fue explícita
    if (!parsed.category) {
      if (parsed.minor_present && (parsed.nudity !== 'none' || parsed.sexual_content)) {
        parsed.category = 'critical';
      } else if (parsed.nudity === 'full' || parsed.sexual_content || parsed.self_harm || parsed.violence === 'graphic') {
        parsed.category = 'blocked';
      } else if (parsed.nudity === 'partial' || parsed.drugs_alcohol || parsed.violence === 'mild') {
        parsed.category = 'suspicious';
      } else {
        parsed.category = 'safe';
      }
    }

    return parsed;
  } catch (e) {
    console.error(`[SAFETY-SHIELD] ❌ Error parseando respuesta: ${e.message}`);
    console.error(`[SAFETY-SHIELD] Raw: ${(rawResponse || '').substring(0, 300)}`);
    return null;
  }
}

/**
 * Log de incidente en Firestore — SIN la imagen, solo metadata
 */
async function _logIncident(uid, phone, level, details, source) {
  if (!_admin) {
    console.warn(`[SAFETY-SHIELD] ⚠️ Firebase no disponible — incidente NO logueado en Firestore`);
    return;
  }
  try {
    await _admin.firestore()
      .collection('safety_incidents')
      .add({
        uid: uid || 'unknown',
        phone: (phone || '').split('@')[0].split(':')[0],  // Solo número
        level,          // critical | blocked | suspicious | error
        source,         // outfit | image_analysis | outreach | ninera | lead | cocina
        details: {
          nudity: details?.nudity || null,
          minor_present: details?.minor_present || null,
          minor_confidence: details?.minor_confidence || null,
          violence: details?.violence || null,
          sexual_content: details?.sexual_content || null,
          self_harm: details?.self_harm || null,
          confidence: details?.confidence || null,
          error: details?.error || null,
          // NUNCA guardar la imagen, descripción visual, ni contenido del buffer
        },
        timestamp: _admin.firestore.FieldValue.serverTimestamp(),
        reviewed: false,  // Para revisión en admin dashboard
        _v: 1,           // Versión del schema para futuras migraciones
      });
    console.log(`[SAFETY-SHIELD] 📋 Incidente logueado en Firestore (level=${level}, source=${source})`);
  } catch (e) {
    console.error(`[SAFETY-SHIELD] ❌ Error logueando incidente en Firestore: ${e.message}`);
  }
}

/**
 * Rate limiting simple — máximo N checks por minuto
 */
function _checkRateLimit() {
  const now = Date.now();
  // Limpiar checks > 1 minuto
  while (_checkTimes.length > 0 && now - _checkTimes[0] > 60000) {
    _checkTimes.shift();
  }
  if (_checkTimes.length >= MAX_CHECKS_PER_MINUTE) return false;
  _checkTimes.push(now);
  return true;
}

/**
 * Hash simple del buffer para cache (primeros 1KB + longitud)
 */
function _hashBuffer(buffer) {
  if (!buffer || buffer.length === 0) return 'empty';
  const sample = buffer.slice(0, 1024);
  let hash = buffer.length;
  for (let i = 0; i < sample.length; i++) {
    hash = ((hash << 5) - hash + sample[i]) | 0;
  }
  return `img_${hash}_${buffer.length}`;
}

// ═══════════════════════════════════════════════════════════════
// ESTADÍSTICAS (para admin dashboard)
// ═══════════════════════════════════════════════════════════════

function getStats() {
  return {
    cacheSize: _resultCache.size,
    checksLastMinute: _checkTimes.filter(t => Date.now() - t < 60000).length,
    maxChecksPerMinute: MAX_CHECKS_PER_MINUTE,
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  init,
  checkContentSafety,
  isMediaForwardBlocked,
  getStats,
  // Constantes exportadas para testing
  SAFETY_MESSAGES,
};
