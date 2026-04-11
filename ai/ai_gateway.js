// ════════════════════════════════════════════════════════════════════════════
// MIIA — AI Gateway (P5.3)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Router inteligente que decide qué modelo/proveedor usar según contexto.
// ESTRATEGIA B+ (Sesión 28):
// - Temperature + Thinking calibrados POR CONTEXTO (12 contextos)
// - Claude Opus: Owner chat (temp 0.7, think 4096), Familia (0.8, think 2048), Nightly (0.6, think 8192)
// - Claude Sonnet: Auditor (temp 0.2, think 512), Admin audit (0.5, think 1024)
// - Gemini Flash: Leads (temp 0.4, think 2048), Classification (0.1), Sports (0.9), etc.
// - Gemini thinking = GRATIS en free tier → calidad pro a $0
// - Claude thinking = paga pero mejora calidad → menos regeneraciones
// - Failover cross-provider: Gemini → OpenAI → Claude (nunca sin respuesta)
// - OWNER KEY PRIORITY: si el owner tiene su propia key → usarla primero
// - OPUS MAX ($149/mes): TODO pasa por Opus
//
// Incluye failover cross-provider (P5.4): si Gemini falla → OpenAI → Claude.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { callAI, callAIChat, keyPool } = require('./ai_client');

// Contextos de uso
const CONTEXTS = {
  ADMIN_AUDIT: 'admin_audit',       // Auditoría profunda para admin
  OWNER_CHAT: 'owner_chat',         // Self-chat del owner (OPUS HYBRID: Director)
  LEAD_RESPONSE: 'lead_response',   // Respuesta a leads
  FAMILY_CHAT: 'family_chat',       // Chat con familia
  CLASSIFICATION: 'classification', // Clasificación de contacto
  SPORT_MESSAGE: 'sport_message',   // Mensaje deportivo
  LEARNING: 'learning',             // Extracción de aprendizaje
  SUMMARY: 'summary',              // Resumen de conversación
  AUDITOR: 'auditor',              // OPUS HYBRID: Auditor de calidad (Sonnet)
  NIGHTLY_BRAIN: 'nightly_brain',  // OPUS HYBRID: Análisis nocturno (Opus)
  TRANSCRIPTION: 'transcription',  // P8.3: Transcripción de audio/media
  GENERAL: 'general'               // General
};

// ═══════════════════════════════════════════════════════════════════
// ═══ OPUS HYBRID STRATEGY (P7) ═══
// Director (Opus): Owner self-chat — máxima calidad para el dueño
// Auditor (Sonnet): Verifica calidad de CADA respuesta antes de enviar
// Nightly Brain (Opus): Análisis nocturno de conversaciones (1x/día)
// Todo lo demás → Gemini Flash (GRATIS, 18 keys de respaldo en pool)
// Failover: si falla → OpenAI → Claude (nunca sin respuesta)
// Costo estimado: ~$22/mes extra vs solo Sonnet
// ═══════════════════════════════════════════════════════════════════
// ═══ ESTRATEGIA B+ (Sesión 28): Temperature + Thinking en TODOS los contextos ═══
// Antes: temperature DEFAULT (1.0) en TODO = caos, respuestas impredecibles
// Ahora: cada contexto tiene temperature calibrada + thinking budget optimizado
// Gemini Flash thinking = GRATIS (no cobra thinking tokens en free tier)
// Claude thinking = paga pero mejora calidad → menos regeneraciones → ahorra
const CONTEXT_CONFIG = {
  [CONTEXTS.ADMIN_AUDIT]: {
    preferred: 'claude',
    model: 'claude-sonnet-4-6',
    fallbacks: ['openai', 'gemini'],
    maxTokens: 4096,
    temperature: 0.5,       // Detallado pero consistente
    thinking: 1024,         // Sonnet piensa antes de auditar
    description: 'Auditoría admin — Sonnet 4.6 + thinking 1024'
  },
  [CONTEXTS.OWNER_CHAT]: {
    preferred: 'claude',
    model: 'claude-opus-4-6',
    fallbacks: ['claude', 'gemini', 'openai'],
    maxTokens: 4096,
    temperature: 0.7,       // Natural pero coherente para el jefe
    thinking: 4096,         // Opus PIENSA mucho antes de responder al owner
    description: 'OPUS Director — Opus 4.6 + thinking 4096 (máxima calidad)'
  },
  [CONTEXTS.LEAD_RESPONSE]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 2048,
    temperature: 0.4,       // Preciso, profesional, NO improvisar con leads
    topP: 0.85,
    topK: 40,
    thinkingBudget: 2048,   // Flash piensa GRATIS → calidad pro a $0
    description: 'Leads — Flash + thinking 2048 (GRATIS, calidad pro)'
  },
  [CONTEXTS.FAMILY_CHAT]: {
    preferred: 'claude',
    model: 'claude-opus-4-6',
    fallbacks: ['claude', 'gemini', 'openai'],
    maxTokens: 4096,
    temperature: 0.8,       // Cálido, natural, más libertad creativa con familia
    thinking: 2048,         // Pensar para dar respuestas con cariño real
    description: 'OPUS Familia — Opus 4.6 + thinking 2048 (calidez máxima)'
  },
  [CONTEXTS.CLASSIFICATION]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 128,
    temperature: 0.1,       // DETERMINÍSTICO — siempre clasificar igual
    topP: 0.8,
    topK: 20,
    thinkingBudget: 1024,   // Mínimo Claude API = 1024 (antes 512, ya no válido)
    description: 'Clasificación — Flash temp 0.1 (determinístico)'
  },
  [CONTEXTS.SPORT_MESSAGE]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 512,
    temperature: 0.9,       // EMOTIVO, creativo — cada gol se celebra distinto
    topP: 0.95,
    thinkingBudget: 1024,   // Pensar en el contexto emocional del contacto
    description: 'Deportes — Flash temp 0.9 (emotivo, creativo)'
  },
  [CONTEXTS.LEARNING]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 1024,
    temperature: 0.2,       // Extracción factual, NO inventar datos
    topP: 0.85,
    topK: 40,
    thinkingBudget: 1024,   // Pensar qué es realmente importante
    description: 'Learning — Flash temp 0.2 (factual, no inventar)'
  },
  [CONTEXTS.SUMMARY]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 512,
    temperature: 0.3,       // Resumen preciso, sin variación
    topP: 0.85,
    topK: 40,
    thinkingBudget: 1024,   // Mínimo Claude API = 1024
    description: 'Resumen — Flash temp 0.3 (preciso)'
  },
  [CONTEXTS.AUDITOR]: {
    preferred: 'claude',
    model: 'claude-sonnet-4-6',
    fallbacks: ['gemini', 'openai'],
    maxTokens: 1024,
    temperature: 0.2,       // Juicio firme, consistente, no creativo
    thinking: 1024,         // Mínimo Claude API = 1024
    description: 'Auditor — Sonnet 4.6 + thinking 1024 (juicio firme)'
  },
  [CONTEXTS.NIGHTLY_BRAIN]: {
    preferred: 'claude',
    model: 'claude-opus-4-6',
    fallbacks: ['claude', 'gemini'],
    maxTokens: 8192,
    temperature: 0.6,       // Análisis profundo, algo de creatividad para insights
    thinking: 8192,         // MÁXIMO thinking — 1 vez al día, vale la inversión
    description: 'Nightly — Opus 4.6 + thinking 8192 (análisis profundo diario)'
  },
  [CONTEXTS.TRANSCRIPTION]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 2048,
    temperature: 0.1,       // Lo más fiel posible al audio
    topP: 0.8,
    topK: 30,
    thinkingBudget: 0,      // No necesita pensar, solo transcribir
    description: 'Transcripción — Flash temp 0.1 (fidelidad máxima)'
  },
  [CONTEXTS.GENERAL]: {
    preferred: 'gemini',
    model: 'gemini-2.5-flash',
    fallbacks: ['openai', 'claude'],
    maxTokens: 4096,
    temperature: 0.5,       // Balance general
    topP: 0.9,
    thinkingBudget: 1024,
    description: 'General — Flash temp 0.5 + thinking 1024'
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

  // ══════════════════════════════════════════════════════════════════
  // 🛡️ INTEGRITY GUARD: GOOGLE SEARCH → GEMINI OBLIGATORIO
  // ══════════════════════════════════════════════════════════════════
  // google_search es una tool de Gemini. Claude y OpenAI la IGNORAN.
  // Si enableSearch=true y el proveedor NO es Gemini → MIIA dice
  // "no tengo los datos actualizados" porque literalmente no puede buscar.
  //
  // ⚠️ PROHIBIDO ELIMINAR ESTE BLOQUE — Sin esto, self-chat con search
  // se enruta a Claude Opus que ignora enableSearch. MIIA parece pelotuda
  // porque dice que no puede buscar cuando el owner le pregunta cosas
  // en tiempo real (clima, deportes, noticias, etc.).
  // Verificado en logs del 10-Abr-2026: Claude recibía search=true,
  // lo ignoraba, y respondía "no tengo esa info".
  // ══════════════════════════════════════════════════════════════════
  const searchForceGemini = opts.enableSearch && !forceProvider && config.preferred !== 'gemini';
  if (searchForceGemini) {
    console.log(`[AI-GW] 🔍 SEARCH-GUARD: enableSearch=true + preferred=${config.preferred} → forzando Gemini (ÚNICO proveedor con google_search)`);
  }
  // Log de auditoría: si search está activo, SIEMPRE registrar qué proveedor se usa
  if (opts.enableSearch) {
    const finalSearchProvider = forceProvider || (searchForceGemini ? 'gemini' : config.preferred);
    if (finalSearchProvider !== 'gemini') {
      // ⚠️ ALERTA: Esto NO debería pasar. Si llega aquí, algo rompió el guard.
      console.error(`[AI-GW] 🚨 SEARCH-INTEGRITY-VIOLATION: enableSearch=true pero proveedor=${finalSearchProvider} (NO es Gemini). Search será IGNORADO. forceProvider=${forceProvider}, preferred=${config.preferred}`);
    }
  }

  // Si el owner tiene un proveedor específico configurado, respetar (excepto si search fuerza gemini)
  const ownerProvider = forceProvider || (searchForceGemini ? 'gemini' : null) || ownerConfig?.aiProvider;
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

    // ═══ B+ Strategy: inyectar temperature + thinking desde CONTEXT_CONFIG ═══
    const baseMaxTokens = opts.maxTokens || config.maxTokens;
    // Claude: max_tokens es TOTAL (thinking + respuesta), así que sumamos ambos
    const claudeThinking = (provider === 'claude' && config.thinking) ? config.thinking : 0;
    const effectiveMaxTokens = claudeThinking > 0 ? baseMaxTokens + claudeThinking : baseMaxTokens;

    const callOpts = {
      ...opts,
      maxTokens: effectiveMaxTokens,
      model: modelForProvider,
      temperature: opts.temperature ?? config.temperature,
      // Claude: extended thinking budget
      ...(claudeThinking > 0 && { thinking: config.thinking }),
      // Gemini: generationConfig params
      ...(provider === 'gemini' && {
        topP: opts.topP ?? config.topP ?? 0.9,
        topK: opts.topK ?? config.topK,
        thinkingBudget: opts.thinkingBudget ?? config.thinkingBudget ?? (searchForceGemini ? 2048 : undefined)
      })
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

    // ═══ B+ Strategy: inyectar temperature + thinking desde CONTEXT_CONFIG ═══
    const baseMaxTokens = opts.maxTokens || config.maxTokens;
    const claudeThinking = (provider === 'claude' && config.thinking) ? config.thinking : 0;
    const effectiveMaxTokens = claudeThinking > 0 ? baseMaxTokens + claudeThinking : baseMaxTokens;

    const callOpts = {
      ...opts,
      maxTokens: effectiveMaxTokens,
      model: chatModel,
      temperature: opts.temperature ?? config.temperature,
      ...(claudeThinking > 0 && { thinking: config.thinking }),
      ...(provider === 'gemini' && {
        topP: opts.topP ?? config.topP,
        topK: opts.topK ?? config.topK,
        thinkingBudget: opts.thinkingBudget ?? config.thinkingBudget
      })
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
