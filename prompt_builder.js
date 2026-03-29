/**
 * PROMPT BUILDER — Unified system prompt generator for MIIA
 *
 * Two modes:
 * - Owner (Mariano): family prompts + Medilink lead prompts with full context
 * - Tenant (SaaS clients): generic sales AI with tenant-specific training data
 *
 * Also provides buildTenantBrainString() to reconstruct a tenant's full
 * training data from structured sources (products, sessions, contact rules).
 */

'use strict';

// ─── Owner mode: family prompt ──────────────────────────────────────────────

function buildOwnerFamilyPrompt(contactName, familyData) {
  return `Eres MIIA, la asistente personal de Mariano de Stefano.

Estás hablando con ${contactName}, ${familyData?.relation || 'familiar'} de Mariano.

IMPORTANTE:
- Habla desde el cariño que Mariano siente por su familia
- Usa el "vínculo heredado": "Siento que ya te conozco por lo que Mariano me cuenta de ti"
- NUNCA menciones "LOBSTERS" - eres la "Asistente Personal" de Mariano
- Tono: Cercano, afectuoso, familiar
- Usa emojis con moderación: ${familyData?.emoji || '😊'}
${familyData?.personality ? `- Personalidad de ${contactName}: ${familyData.personality}` : ''}

Responde naturalmente manteniendo este vínculo familiar.`;
}

// ─── Owner mode: lead/client prompt ─────────────────────────────────────────

function buildOwnerLeadPrompt(contactName, trainingData) {
  return `Eres MIIA, una IA avanzada de Medilink.

IDENTIDAD:
- Tono: Profesional, cercano y resolutivo
- Objetivo: Ayudar a leads a mejorar su gestión médica
- Producto: Sistema de gestión para clínicas (Medilink)

REGLAS:
- NUNCA uses diminutivos no autorizados
- NUNCA menciones "NumRot" - di "Facturador Electrónico"
- Si te piden cotización, genera tabla profesional
- Mantén respuestas concisas (máximo 3-4 oraciones)

${trainingData ? `[LO QUE HE APRENDIDO]:\n${trainingData}\n` : ''}

Estás hablando con ${contactName}.

Responde de forma natural y profesional.`;
}

// ─── Tenant mode: SaaS client prompt ────────────────────────────────────────

function buildTenantPrompt(contactName, trainingData, conversationHistory) {
  const history = (conversationHistory || [])
    .slice(-20)
    .map(m => `${m.role === 'user' ? 'Cliente' : 'MIIA'}: ${m.content}`)
    .join('\n');

  return `Eres MIIA, una asistente de ventas inteligente por WhatsApp.
Respondes con el estilo y conocimiento del negocio de tu cliente.
Eres cálida, profesional y efectiva cerrando ventas.

${trainingData ? `[LO QUE HE APRENDIDO DE ESTE NEGOCIO]:\n${trainingData}\n` : ''}

[HISTORIAL DE CONVERSACIÓN]:
${history || 'Sin historial previo.'}

Responde al último mensaje del cliente de forma natural y útil (máximo 3 oraciones). No uses emojis en exceso.`;
}

// ─── Test mode: identical to tenant but with test header ────────────────────

function buildTestPrompt(trainingData) {
  return `Eres MIIA, una asistente de ventas inteligente por WhatsApp.
Respondes con el estilo y conocimiento del negocio de tu cliente.
Eres cálida, profesional y efectiva cerrando ventas.

${trainingData ? `[LO QUE HE APRENDIDO DE ESTE NEGOCIO]:\n${trainingData}\n` : ''}

Estás en modo de prueba. El usuario es el dueño del negocio probando cómo responderías a un cliente real.
Responde exactamente como lo harías con un cliente real (máximo 3 oraciones). No uses emojis en exceso.`;
}

// ─── Build training data string from structured sources ─────────────────────

/**
 * Reconstruct the full brain string for a tenant from its components.
 *
 * @param {string}   baseDNA       - The base MIIA DNA (shared across all tenants)
 * @param {Array}    products      - Array of { name, description, price, pricePromo, stock, extras }
 * @param {Array}    sessions      - Array of { trainingBlock }
 * @param {object}   contactRules  - { lead_keywords: string[], client_keywords: string[] }
 * @returns {string} Full training data string
 */
function buildTenantBrainString(baseDNA, products, sessions, contactRules) {
  const parts = [];

  if (baseDNA) {
    parts.push(`[ADN BASE MIIA]\n${baseDNA}`);
  }

  if (products && products.length > 0) {
    const productLines = products.map(p => {
      let line = `- ${p.name}: ${p.description || 'Sin descripción'}`;
      if (p.price) line += ` · Precio: ${p.price}`;
      if (p.pricePromo) line += ` · Promo: ${p.pricePromo}`;
      if (p.stock) line += ` · Stock: ${p.stock}`;
      if (p.extras) {
        for (const [k, v] of Object.entries(p.extras)) {
          if (v) line += ` · ${k}: ${v}`;
        }
      }
      return line;
    });
    parts.push(`[PRODUCTOS Y SERVICIOS]\n${productLines.join('\n')}`);
  }

  if (contactRules) {
    if (contactRules.lead_keywords && contactRules.lead_keywords.length > 0) {
      parts.push(`[CÓMO IDENTIFICAR LEADS]\nKeywords: ${contactRules.lead_keywords.join(', ')}`);
    }
    if (contactRules.client_keywords && contactRules.client_keywords.length > 0) {
      parts.push(`[CÓMO IDENTIFICAR CLIENTES YA ACTIVOS]\nKeywords: ${contactRules.client_keywords.join(', ')}`);
    }
  }

  if (sessions && sessions.length > 0) {
    const sessionBlocks = sessions
      .filter(s => s.trainingBlock)
      .map(s => s.trainingBlock);
    if (sessionBlocks.length > 0) {
      parts.push(`[HISTORIAL DE ENTRENAMIENTO]\n${sessionBlocks.join('\n\n')}`);
    }
  }

  return parts.join('\n\n');
}

// ─── Main dispatcher ────────────────────────────────────────────────────────

/**
 * Build a system prompt.
 *
 * @param {object} opts
 * @param {string} opts.mode           - 'owner_family' | 'owner_lead' | 'tenant' | 'test'
 * @param {string} opts.contactName    - Name of the person MIIA is talking to
 * @param {string} [opts.trainingData] - Training data string
 * @param {Array}  [opts.conversationHistory] - For tenant mode: conversation messages array
 * @param {object} [opts.familyData]   - For owner_family mode: { relation, emoji, personality }
 * @returns {string} The system prompt
 */
function buildPrompt(opts) {
  switch (opts.mode) {
    case 'owner_family':
      return buildOwnerFamilyPrompt(opts.contactName, opts.familyData);
    case 'owner_lead':
      return buildOwnerLeadPrompt(opts.contactName, opts.trainingData);
    case 'tenant':
      return buildTenantPrompt(opts.contactName, opts.trainingData, opts.conversationHistory);
    case 'test':
      return buildTestPrompt(opts.trainingData);
    default:
      return buildTenantPrompt(opts.contactName, opts.trainingData, opts.conversationHistory);
  }
}

module.exports = {
  buildPrompt,
  buildTenantBrainString,
  // Export individual builders for direct use if needed
  buildOwnerFamilyPrompt,
  buildOwnerLeadPrompt,
  buildTenantPrompt,
  buildTestPrompt
};
