'use strict';

/**
 * MIIA — Persona Switcher (T140)
 * Selecciona el modo/persona de respuesta segun el tipo de contacto y contexto.
 * Materializacion de la logica de modos: owner_selfchat, lead, client, family, miia_lead.
 */

const PERSONA_MODES = Object.freeze([
  'owner_selfchat',  // Mariano hablando con su propia MIIA
  'lead',            // Prospecto de otro negocio
  'client',          // Cliente activo de otro negocio
  'miia_lead',       // Lead de MIIA CENTER (puede revelar que es IA)
  'miia_client',     // Cliente de MIIA CENTER
  'family',          // Familia de Mariano (sabe que es IA)
  'group',           // Grupo de WhatsApp
  'unknown',         // No clasificado
]);

const PERSONA_RULES = Object.freeze({
  owner_selfchat: {
    revealAI: true,
    useOwnerVoice: false,
    humanDelay: false,
    canLearnFromChat: true,
    priority: 'high',
  },
  lead: {
    revealAI: false,
    useOwnerVoice: true,
    humanDelay: true,
    canLearnFromChat: false,
    priority: 'normal',
  },
  client: {
    revealAI: false,
    useOwnerVoice: true,
    humanDelay: true,
    canLearnFromChat: false,
    priority: 'high',
  },
  miia_lead: {
    revealAI: true,
    useOwnerVoice: false,
    humanDelay: true,
    canLearnFromChat: false,
    priority: 'normal',
  },
  miia_client: {
    revealAI: true,
    useOwnerVoice: false,
    humanDelay: false,
    canLearnFromChat: false,
    priority: 'high',
  },
  family: {
    revealAI: true,
    useOwnerVoice: false,
    humanDelay: false,
    canLearnFromChat: false,
    priority: 'high',
  },
  group: {
    revealAI: false,
    useOwnerVoice: true,
    humanDelay: false,
    canLearnFromChat: false,
    priority: 'low',
  },
  unknown: {
    revealAI: false,
    useOwnerVoice: true,
    humanDelay: true,
    canLearnFromChat: false,
    priority: 'low',
  },
});

/**
 * Determina el modo de persona segun el contexto del mensaje.
 * @param {{ isSelfChat, isGroup, chatType, uid, isMiiaCenterUid }} ctx
 * @returns {{ mode: string, rules: object }}
 */
function resolvePersona(ctx = {}) {
  const { isSelfChat, isGroup, chatType, isMiiaCenterUid } = ctx || {};

  let mode;

  if (isSelfChat) {
    mode = 'owner_selfchat';
  } else if (isGroup) {
    mode = 'group';
  } else if (chatType === 'miia_lead') {
    mode = 'miia_lead';
  } else if (chatType === 'miia_client') {
    mode = 'miia_client';
  } else if (chatType === 'lead') {
    mode = isMiiaCenterUid ? 'miia_lead' : 'lead';
  } else if (chatType === 'client') {
    mode = isMiiaCenterUid ? 'miia_client' : 'client';
  } else if (chatType === 'family') {
    mode = 'family';
  } else {
    mode = 'unknown';
  }

  return { mode, rules: PERSONA_RULES[mode] };
}

/**
 * Verifica si MIIA puede revelar que es una IA en este contexto.
 */
function canRevealAI(ctx) {
  const { rules } = resolvePersona(ctx);
  return rules.revealAI;
}

/**
 * Verifica si debe aplicar human delay en este contexto.
 */
function shouldApplyHumanDelay(ctx) {
  const { rules } = resolvePersona(ctx);
  return rules.humanDelay;
}

module.exports = {
  resolvePersona,
  canRevealAI,
  shouldApplyHumanDelay,
  PERSONA_MODES,
  PERSONA_RULES,
};
