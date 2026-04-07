// ════════════════════════════════════════════════════════════════════════════
// MIIA — AI Gateway (P5.3)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Router inteligente que decide qué modelo/proveedor usar según contexto.
// ESTRATEGIA HÍBRIDA (Opción B + Tier System):
// - Admin audit → Claude Sonnet 4.6 (calidad suficiente, 80% ahorro vs Opus)
// - Owner self-chat → Claude Sonnet 4.6 (calidad + economía)
// - Todo lo demás → Gemini Flash (GRATIS, 18 keys en pool)
// - OWNER KEY PRIORITY: si el owner tiene su propia Gemini key → usarla primero
// - OPUS MAX ($149/mes): TODO pasa por Opus
// - Failover: Gemini → OpenAI → Claude (nunca sin respuesta)
//
// Incluye failover cross-provider (P5.4): si Gemini falla → OpenAI → Claude.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { callAI, callAIChat, keyPool } = require('./ai_client');

// Contextos de uso
const CONTEXTS = {
  ADMIN_AUDIT: 'admin_audit',       // Auditoría profunda para admin
  OWNER_CHAT: 'owner_chat',         // Self-chat del owner
  LEAD_RESPONSE: 'lead_response',   // Respuesta a leads
  FAMILY_CHAT: 'family_chat',       // Chat con familia
  CLASSIFICATION: 'classification', // Clasificación de contacto
  SPORT_MESSAGE: 'sport_message',   // Mensaje deportivo
  LEARNING: 'learning',             // Extracción de aprendizaje
  SUMMARY: 'summary',              // Resumen de conversación
  GENERAL: 'general'               // General
};

// ═══════════════════════════════════════════════════════════════════
// ESTRATEGIA HÍBRIDA:
// - OWNER_CHAT + ADMIN_AUDIT → Claude Sonnet 4.6 (~$6-12/mes vs $40+ con Opus)
// - Si owner tiene su Gemini key → priorizar esa (costo $0 para MIIA)
// - TODO lo demás → Gemini Flash (GRATIS, 18 keys de respaldo en pool)
// - Failover: si Gemini falla → OpenAI → Claude (nunca sin respuesta)
// ═══════════════════════════════════════════════════════════════════
const CONTEXT_CONFIG = {
  [CONTEXTS.ADMIN_AUDIT]: {
    preferred: 'claude',
    model: 'claude-sonnet-4-6',
    fallbacks: ['openai', 'gemini'],
    maxTokens: 8192,
    description: 'Auditoría — Claude Sonnet 4.6 (calidad suficiente, 80% ahorro vs Opus)'
  },
  [CONTEXTS.OWNER_CHAT]: {
    preferred: 'claude',
    model: 'claude-sonnet-4-6',
    fallbacks: ['gemini', 'openai'],
    maxTokens: 4096,
    description: 'Self-chat del owner — Claude Sonnet 4.6 (calidad + economía)'
  },
  [CONTEXTS.LEAD_RESPONSE]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 4096,
    description: 'Respuesta a leads — Gemini Flash (GRATIS)'
  },
  [CONTEXTS.FAMILY_CHAT]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 2048,
    description: 'Chat familiar — Gemini Flash (GRATIS)'
  },
  [CONTEXTS.CLASSIFICATION]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 256,
    description: 'Clasificación de contacto — Gemini Flash (GRATIS, rápido)'
  },
  [CONTEXTS.SPORT_MESSAGE]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 512,
    description: 'Mensaje deportivo — Gemini Flash (GRATIS)'
  },
  [CONTEXTS.LEARNING]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 2048,
    description: 'Extracción de aprendizaje — Gemini Flash (GRATIS)'
  },
  [CONTEXTS.SUMMARY]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 1024,
    description: 'Resumen de conversación — Gemini Flash (GRATIS)'
  },
  [CONTEXTS.GENERAL]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 4096,
    description: 'Uso general — Gemini Flash (GRATIS)'
  }
};

// ═══════════════════════════════════════════════════════════════════
// TIER SYSTEM — Cada plan tiene diferente nivel de IA
// Planes MIIA reales: Mensual $15, Trimestral $39, Semestral $69, Anual $99, Familiar $19.99
// Todos incluyen: Opus Cerebro (genera artefactos 1 vez) + Flash para ejecución
// aiTier en Firestore:
//   'standard' (default): self-chat Opus, resto Flash
//   'opus_max' (+33% del plan): TODO Opus — calidad máxima en cada mensaje
// ═══════════════════════════════════════════════════════════════════
const TIER_OVERRIDES = {
  opus_max: {
    // Todo pasa por Opus — add-on +33% del plan del owner
    allContexts: { preferred: 'claude', model: 'claude-opus-4-6' }
  }
  // standard (default): self-chat Opus, resto Flash (config por defecto arriba)
};

/**
 * Aplica overrides de tier al config de un contexto.
 * @param {string} aiTier - 'starter'|'pro'|'business'|'enterprise'|'opus_max'
 * @param {string} context - El contexto de la llamada
 * @param {Object} config - El CONTEXT_CONFIG original
 * @returns {Object} Config posiblemente modificado
 */
function applyTierOverride(aiTier, context, config) {
  if (!aiTier) return config;

  // OPUS MAX: todo Opus
  if (aiTier === 'opus_max') {
    return {
      ...config,
      preferred: 'claude',
      model: 'claude-opus-4-6',
      fallbacks: ['gemini', 'openai']
    };
  }

  // standard o cualquier otro: config default (Opus para self-chat, Flash para resto)
  return config;
}

// Métricas por proveedor
const providerMetrics = {
  gemini: { calls: 0, failures: 0, totalLatencyMs: 0, lastCallAt: null },
  openai: { calls: 0, failures: 0, totalLatencyMs: 0, lastCallAt: null },
  claude: { calls: 0, failures: 0, totalLatencyMs: 0, lastCallAt: null },
  groq: { calls: 0, failures: 0, totalLatencyMs: 0, lastCallAt: null },
  mistral: { calls: 0, failures: 0, totalLatencyMs: 0, lastCallAt: null }
};

// Failover metrics
let failoverCount = 0;
let totalCalls = 0;

/**
 * Obtiene la API key para un proveedor, priorizando: owner config → env var → key pool.
 */
function getApiKey(provider, ownerConfig) {
  // 1. Owner tiene su propia key configurada
  if (ownerConfig?.aiProvider === provider && ownerConfig?.aiApiKey) {
    return ownerConfig.aiApiKey;
  }

  // 2. Key pool (rotación automática)
  if (keyPool.hasKeys(provider)) {
    return keyPool.getKey(provider);
  }

  // 3. Variables de entorno
  const envMap = {
    gemini: 'GEMINI_API_KEY',
    openai: 'OPENAI_API_KEY',
    claude: 'CLAUDE_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY'
  };
  return process.env[envMap[provider]] || null;
}

/**
 * Llama a la IA usando el contexto para decidir proveedor.
 * Con failover automático cross-provider (P5.4).
 *
 * @param {string} context - CONTEXTS.OWNER_CHAT, etc.
 * @param {string} prompt - Prompt de texto
 * @param {Object} [ownerConfig] - { aiProvider, aiApiKey } del owner
 * @param {Object} [opts] - Opciones adicionales
 * @returns {Promise<{text: string|null, provider: string, failedOver: boolean, latencyMs: number}>}
 */
async function smartCall(context, prompt, ownerConfig = {}, opts = {}) {
  const baseConfig = CONTEXT_CONFIG[context] || CONTEXT_CONFIG[CONTEXTS.GENERAL];
  const config = applyTierOverride(ownerConfig?.aiTier, context, baseConfig);
  totalCalls++;

  // forceProvider: override para regeneración (ej: forzar gemini con google_search)
  const forceProvider = opts.forceProvider;
  // Si el owner tiene un proveedor específico configurado, respetar
  const ownerProvider = forceProvider || ownerConfig?.aiProvider;
  const providers = ownerProvider
    ? [ownerProvider, ...config.fallbacks.filter(f => f !== ownerProvider)]
    : [config.preferred, ...config.fallbacks];

  let failedOver = false;
  const startTime = Date.now();

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const apiKey = getApiKey(provider, ownerConfig);
    if (!apiKey) {
      console.log(`[AI-GW] ⏭️ ${provider} sin API key, saltando`);
      continue;
    }

    // Cada proveedor usa SU modelo default — NUNCA pasar modelo de Gemini a Claude ni viceversa
    const PROVIDER_DEFAULT_MODELS = {
      gemini: 'gemini-2.5-flash',
      openai: 'gpt-4o-mini',
      claude: 'claude-sonnet-4-6',
      groq: 'llama-3.1-70b-versatile',
      mistral: 'mistral-large-latest'
    };
    const modelForProvider = (provider === config.preferred)
      ? (opts.model || config.model)  // Proveedor principal: usar modelo del contexto
      : PROVIDER_DEFAULT_MODELS[provider] || config.model;  // Failover: usar default del proveedor

    const callOpts = {
      ...opts,
      maxTokens: opts.maxTokens || config.maxTokens,
      model: modelForProvider
    };

    try {
      const pm = providerMetrics[provider];
      pm.calls++;
      pm.lastCallAt = new Date().toISOString();

      const result = await callAI(provider, apiKey, prompt, callOpts);
      const latencyMs = Date.now() - startTime;
      pm.totalLatencyMs += latencyMs;

      if (failedOver) {
        failoverCount++;
        console.log(`[AI-GW] 🔄 FAILOVER exitoso: ${providers[0]} → ${provider} (${latencyMs}ms) [ctx: ${context}]`);
      } else {
        console.log(`[AI-GW] ✅ ${provider} OK (${latencyMs}ms) [ctx: ${context}]`);
      }

      // Track si estamos usando backup de MIIA (owner tenía key pero falló)
      const usedOwnerKey = (i === 0 && ownerConfig?.aiApiKey && ownerConfig?.aiProvider === provider);
      const usedMiiaBackup = failedOver && ownerConfig?.aiApiKey && !usedOwnerKey;

      return { text: result, provider, failedOver, latencyMs, usedMiiaBackup };
    } catch (err) {
      providerMetrics[provider].failures++;
      console.error(`[AI-GW] ❌ ${provider} falló [ctx: ${context}]: ${err.message}`);
      failedOver = true;
    }
  }

  const latencyMs = Date.now() - startTime;
  console.error(`[AI-GW] 🔴 TODOS los proveedores fallaron [ctx: ${context}] (${latencyMs}ms)`);
  return { text: null, provider: 'none', failedOver: true, latencyMs, usedMiiaBackup: false };
}

/**
 * Chat multi-turn con failover cross-provider.
 */
async function smartChat(context, messages, systemPrompt, ownerConfig = {}, opts = {}) {
  const baseConfig = CONTEXT_CONFIG[context] || CONTEXT_CONFIG[CONTEXTS.GENERAL];
  const config = applyTierOverride(ownerConfig?.aiTier, context, baseConfig);
  totalCalls++;

  const ownerProvider = ownerConfig?.aiProvider;
  const providers = ownerProvider
    ? [ownerProvider, ...config.fallbacks.filter(f => f !== ownerProvider)]
    : [config.preferred, ...config.fallbacks];

  let failedOver = false;
  const startTime = Date.now();

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const apiKey = getApiKey(provider, ownerConfig);
    if (!apiKey) continue;

    // Cada proveedor usa SU modelo default en failover
    const PROVIDER_DEFAULTS = {
      gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini', claude: 'claude-sonnet-4-6',
      groq: 'llama-3.1-70b-versatile', mistral: 'mistral-large-latest'
    };
    const chatModel = (provider === config.preferred)
      ? (opts.model || config.model)
      : PROVIDER_DEFAULTS[provider] || config.model;

    const callOpts = {
      ...opts,
      maxTokens: opts.maxTokens || config.maxTokens,
      model: chatModel
    };

    try {
      providerMetrics[provider].calls++;
      providerMetrics[provider].lastCallAt = new Date().toISOString();

      const result = await callAIChat(provider, apiKey, messages, systemPrompt, callOpts);
      const latencyMs = Date.now() - startTime;
      providerMetrics[provider].totalLatencyMs += latencyMs;

      if (failedOver) {
        failoverCount++;
        console.log(`[AI-GW] 🔄 FAILOVER chat: ${providers[0]} → ${provider} (${latencyMs}ms)`);
      }

      return { text: result, provider, failedOver, latencyMs };
    } catch (err) {
      providerMetrics[provider].failures++;
      console.error(`[AI-GW] ❌ ${provider} chat falló: ${err.message}`);
      failedOver = true;
    }
  }

  const latencyMs = Date.now() - startTime;
  console.error(`[AI-GW] 🔴 TODOS los proveedores fallaron (chat) (${latencyMs}ms)`);
  return { text: null, provider: 'none', failedOver: true, latencyMs };
}

/**
 * Health check del AI Gateway.
 */
function healthCheck() {
  const providerHealth = {};
  for (const [name, m] of Object.entries(providerMetrics)) {
    const avgLatency = m.calls > 0 ? Math.round(m.totalLatencyMs / m.calls) : 0;
    const failRate = m.calls > 0 ? Math.round((m.failures / m.calls) * 100) : 0;
    providerHealth[name] = {
      calls: m.calls,
      failures: m.failures,
      failRate: `${failRate}%`,
      avgLatencyMs: avgLatency,
      lastCallAt: m.lastCallAt,
      hasKey: !!getApiKey(name, {})
    };
  }

  return {
    totalCalls,
    failoverCount,
    failoverRate: totalCalls > 0 ? `${Math.round((failoverCount / totalCalls) * 100)}%` : '0%',
    providers: providerHealth,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  CONTEXTS,
  CONTEXT_CONFIG,
  TIER_OVERRIDES,
  applyTierOverride,
  smartCall,
  smartChat,
  healthCheck,
  getApiKey
};
