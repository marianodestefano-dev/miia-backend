// ════════════════════════════════════════════════════════════════════════════
// MIIA — Opus Cerebro Generator (P5.6)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Opus piensa 1 vez → Flash ejecuta 1000 veces gratis.
//
// Cuando el owner entrena a MIIA (guarda cerebro/productos), Opus 4.6
// procesa ese texto crudo UNA VEZ y genera 7 artefactos premium:
//   1. System prompt optimizado para leads
//   2. System prompt optimizado para familia
//   3. FAQ auto-generado (20 preguntas comunes)
//   4. Guía de tono y personalidad
//   5. Reglas de negocio extraídas
//   6. Objeciones comunes + cómo responderlas
//   7. Keywords de clasificación por negocio
//
// Flash usa estos artefactos para dar respuestas de calidad Opus a costo $0.
// Costo por generación: ~$0.03 (una vez al entrenar).
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const aiGateway = require('./ai_gateway');
const { CONTEXTS } = aiGateway;

/**
 * Genera los 7 artefactos del cerebro premium usando Claude Opus.
 *
 * @param {string} uid - Owner UID
 * @param {Object} businessData - { name, description, ownerRole, products[], cerebro, contactRules, paymentMethods }
 * @param {Object} ownerProfile - { name, shortName, passions, miiaPersonality, miiaStyle }
 * @param {Object} [ownerConfig] - { aiProvider, aiApiKey } para fallback
 * @returns {Promise<Object|null>} Los 7 artefactos o null si falla
 */
async function generateCerebro(uid, businessData, ownerProfile = {}, ownerConfig = {}) {
  const startTime = Date.now();
  const bizName = businessData.name || 'Negocio';

  console.log(`[OPUS-CEREBRO] 🧠 Generando cerebro premium para "${bizName}" (owner: ${uid})`);

  // Construir el input para Opus
  const rawInput = buildRawInput(businessData, ownerProfile);

  const prompt = `Eres un experto en diseño de asistentes virtuales de WhatsApp para negocios.

Te doy la información cruda de un negocio. Tu trabajo: generar 7 artefactos que un modelo de IA más pequeño (Gemini Flash) usará para responder mensajes de WhatsApp con calidad profesional.

## INFORMACIÓN DEL NEGOCIO
${rawInput}

## TU TAREA
Generá los 7 artefactos en formato JSON. Cada uno debe ser un string listo para inyectar como system prompt.

RESPONDE SOLO CON JSON VÁLIDO, sin markdown, sin backticks, sin explicación. El JSON debe tener esta estructura exacta:

{
  "lead_prompt": "System prompt completo para responder leads (clientes potenciales). Incluir: quién sos, qué vendés, cómo respondés, qué datos pedís, tono comercial. Máximo 500 tokens.",
  "family_prompt": "System prompt para responder familia/amigos del owner. Tono cercano, informal. Qué sabés del owner, cómo ayudás. Máximo 300 tokens.",
  "faq": "20 preguntas frecuentes con respuestas cortas basadas en los datos del negocio. Formato: Q1: pregunta\\nA1: respuesta\\n\\nQ2: ... Máximo 800 tokens.",
  "tone_guide": "Guía de tono y personalidad: cómo hablar, qué palabras usar, qué evitar, nivel de formalidad, emojis. Máximo 200 tokens.",
  "business_rules": "Reglas de negocio extraídas: horarios, precios, políticas, limitaciones, excepciones. Lo que NUNCA se debe hacer. Máximo 300 tokens.",
  "objections": "10 objeciones comunes de leads y cómo responderlas naturalmente sin ser insistente. Máximo 400 tokens.",
  "classification_keywords": "Keywords para clasificar contactos: lead_keywords (palabras que indican interés comercial), client_keywords (palabras de cliente existente), spam_keywords (palabras para ignorar). JSON string."
}

IMPORTANTE:
- Escribí en español neutro latinoamericano
- Sé conciso pero completo
- Si falta información, inferí lo razonable basándote en el tipo de negocio
- Los prompts deben ser DIRECTAMENTE usables, no instrucciones genéricas
- NO inventes precios ni datos específicos que no están en la información
- El tono debe ser profesional pero cálido, NUNCA robótico`;

  try {
    // Usar ADMIN_AUDIT context (Claude Opus) para generar el cerebro
    const result = await aiGateway.smartCall(
      CONTEXTS.ADMIN_AUDIT,
      prompt,
      ownerConfig,
      { maxTokens: 4096 }
    );

    if (!result.text) {
      console.error(`[OPUS-CEREBRO] 🔴 No se obtuvo respuesta de Opus para "${bizName}"`);
      return null;
    }

    // Parsear JSON
    const cerebro = parseOpusResponse(result.text);
    if (!cerebro) {
      console.error(`[OPUS-CEREBRO] 🔴 Respuesta de Opus no es JSON válido para "${bizName}"`);
      console.error(`[OPUS-CEREBRO] Respuesta raw (200 chars): ${result.text.substring(0, 200)}`);
      return null;
    }

    // Validar que tiene los 7 campos
    const requiredFields = ['lead_prompt', 'family_prompt', 'faq', 'tone_guide', 'business_rules', 'objections', 'classification_keywords'];
    const missing = requiredFields.filter(f => !cerebro[f]);
    if (missing.length > 0) {
      console.warn(`[OPUS-CEREBRO] ⚠️ Campos faltantes en cerebro de "${bizName}": ${missing.join(', ')}`);
      // No fallar — usar lo que hay
    }

    const latencyMs = Date.now() - startTime;
    const tokenEstimate = Math.round(result.text.length / 4);

    cerebro._meta = {
      generatedAt: new Date().toISOString(),
      generatedBy: result.provider,
      model: 'claude-opus-4-6',
      latencyMs,
      estimatedTokens: tokenEstimate,
      estimatedCost: `$${(tokenEstimate * 0.000075).toFixed(4)}`,
      businessName: bizName,
      ownerUid: uid
    };

    console.log(`[OPUS-CEREBRO] ✅ Cerebro premium generado para "${bizName}" en ${latencyMs}ms (~${tokenEstimate} tokens, ~${cerebro._meta.estimatedCost})`);
    return cerebro;

  } catch (err) {
    const latencyMs = Date.now() - startTime;
    console.error(`[OPUS-CEREBRO] 🔴 Error generando cerebro para "${bizName}" (${latencyMs}ms): ${err.message}`);
    return null;
  }
}

/**
 * Construye el input crudo para Opus a partir de los datos del negocio.
 */
function buildRawInput(businessData, ownerProfile) {
  const sections = [];

  // Info básica del negocio
  sections.push(`### Negocio: ${businessData.name || 'Sin nombre'}`);
  if (businessData.description) sections.push(`Descripción: ${businessData.description}`);
  if (businessData.ownerRole) sections.push(`Rol del owner: ${businessData.ownerRole}`);
  if (businessData.email) sections.push(`Email: ${businessData.email}`);
  if (businessData.website) sections.push(`Web: ${businessData.website}`);
  if (businessData.address) sections.push(`Dirección: ${businessData.address}`);
  if (businessData.whatsapp_number) sections.push(`WhatsApp: ${businessData.whatsapp_number}`);
  if (businessData.demoLink) sections.push(`Demo: ${businessData.demoLink}`);

  // Owner
  if (ownerProfile.name) sections.push(`\n### Owner: ${ownerProfile.name}`);
  if (ownerProfile.passions) sections.push(`Pasiones: ${ownerProfile.passions}`);
  if (ownerProfile.miiaPersonality) sections.push(`Personalidad MIIA: ${ownerProfile.miiaPersonality}`);
  if (ownerProfile.miiaStyle) sections.push(`Estilo: ${ownerProfile.miiaStyle}`);

  // Cerebro existente (texto crudo del owner)
  if (businessData.cerebro) {
    sections.push(`\n### Cerebro del negocio (entrenamiento del owner):\n${businessData.cerebro}`);
  }

  // Productos
  if (businessData.products && businessData.products.length > 0) {
    sections.push('\n### Productos/Servicios:');
    for (const p of businessData.products) {
      const price = p.price ? ` — $${p.price}` : '';
      sections.push(`- ${p.name}${price}${p.description ? ': ' + p.description : ''}`);
    }
  }

  // Reglas de contacto
  if (businessData.contactRules) {
    const cr = businessData.contactRules;
    if (cr.lead_keywords?.length) sections.push(`\n### Keywords de leads: ${cr.lead_keywords.join(', ')}`);
    if (cr.client_keywords?.length) sections.push(`Keywords de clientes: ${cr.client_keywords.join(', ')}`);
  }

  // Métodos de pago
  if (businessData.paymentMethods?.methods?.length) {
    sections.push(`\n### Métodos de pago: ${businessData.paymentMethods.methods.join(', ')}`);
  }

  return sections.join('\n');
}

/**
 * Parsea la respuesta de Opus, tolerando markdown code blocks.
 */
function parseOpusResponse(text) {
  try {
    // Intento directo
    return JSON.parse(text);
  } catch (_) {
    // Intentar extraer JSON de markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (_2) {
        // Intentar limpiar
      }
    }

    // Intentar encontrar { ... } en el texto
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(text.substring(braceStart, braceEnd + 1));
      } catch (_3) {
        return null;
      }
    }

    return null;
  }
}

/**
 * Genera un cerebro FALLBACK sin Opus (texto crudo formateado).
 * Se usa si Opus falla, para que Flash tenga algo mejor que nada.
 */
function generateFallbackCerebro(businessData, ownerProfile = {}) {
  console.log(`[OPUS-CEREBRO] ⚠️ Generando cerebro FALLBACK (sin Opus) para "${businessData.name}"`);

  const bizName = businessData.name || 'el negocio';
  const ownerName = ownerProfile.name || 'el owner';
  const description = businessData.description || '';
  const products = (businessData.products || []).map(p => `${p.name}${p.price ? ' ($' + p.price + ')' : ''}`).join(', ');

  return {
    lead_prompt: `Sos la asistente de ${ownerName} en ${bizName}. ${description}. Respondé consultas de clientes potenciales con profesionalismo y calidez. ${products ? 'Productos/servicios: ' + products + '.' : ''} Si no sabés algo, decí que consultás con ${ownerName}.`,
    family_prompt: `Sos MIIA, asistente personal de ${ownerName}. Con familia y amigos: tono cercano, informal, cálido. Ayudás con agenda, recordatorios y lo que necesiten.`,
    faq: '',
    tone_guide: `Español neutro latinoamericano. Profesional pero cálida. Sin emojis excesivos. No robótica.`,
    business_rules: businessData.cerebro || '',
    objections: '',
    classification_keywords: JSON.stringify({
      lead_keywords: (businessData.contactRules?.lead_keywords || []),
      client_keywords: (businessData.contactRules?.client_keywords || []),
      spam_keywords: []
    }),
    _meta: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'fallback',
      model: 'none',
      latencyMs: 0,
      estimatedCost: '$0',
      businessName: bizName,
      isFallback: true
    }
  };
}

/**
 * Genera o regenera el cerebro premium, con fallback automático.
 * Esta es la función principal que se llama desde los endpoints.
 */
async function generateOrFallback(uid, businessData, ownerProfile = {}, ownerConfig = {}) {
  const cerebro = await generateCerebro(uid, businessData, ownerProfile, ownerConfig);
  if (cerebro) return cerebro;

  // Opus falló → generar fallback
  return generateFallbackCerebro(businessData, ownerProfile);
}

module.exports = {
  generateCerebro,
  generateFallbackCerebro,
  generateOrFallback
};
