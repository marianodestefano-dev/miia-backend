/**
 * mod_voice_v2.js — Módulo de inyección de Voice DNA V2 en PROMPT_MODULAR.
 *
 * Origen: CARTA_C-397 §5 + ANEXO 2026-04-23 (firma Wi+Mariano). COMMIT 2 A1.
 *
 * Función principal: buildVoiceV2Block({chatType, ownerProfile, context})
 *   → { block: string, meta: {...} } | null
 *
 * Diseño:
 *   - Branching CENTER vs Personal por marcador MIIA_SALES_PROFILE del ownerProfile.
 *   - 4 capas de fallback (cualquiera retorna null → caller usa V1 puro):
 *     1) Loader fail / bloque vacío → null
 *     2) chatType no soportado en COMMIT actual → null
 *     3) ownerProfile inválido (null/no-object) → null + warn
 *     4) try/catch envuelto a toda la función → null + error
 *
 * Scope COMMIT 2 (A1 item 2):
 *   - SOLO responde a chatType === 'miia_lead'.
 * Scope COMMIT 4 (A1 item 4):
 *   - Agrega chatType === 'miia_client' (CENTER §2.2 clientes_medilink).
 *
 * Branching general (vigente COMMIT 4):
 *   - CENTER (ownerProfile marker) + chatType soportado → voice_seed_center.md §2.x.
 *   - Personal owner → null (ETAPA 1 C-388 D.1: Personal corre V1 puro).
 *   - Otros chatTypes (selfchat/family/medilink_team) → null todavía.
 *
 * Scope posteriores commits (A1 items 5-7):
 *   - COMMIT 5: extender a chatType='selfchat' (owner_selfchat snapshot).
 *   - COMMIT 6-7: wire-in en C-311 zone (friend_broadcast + medilink_team) —
 *     paths Personal, usan loadVoiceDNAForGroup (voice_seed.md).
 *
 * Reglas duras:
 *   - NO mutates ownerProfile ni context.
 *   - NO lanza excepciones (todo envuelto en try/catch).
 *   - Todo log viene con prefijo [V2][mod_voice_v2].
 */

'use strict';

const {
  loadVoiceDNAForGroup,
  loadVoiceDNAForCenter,
  isV2EligibleUid
} = require('./voice_v2_loader');

/**
 * Detecta si un ownerProfile es el perfil MIIA_SALES_PROFILE (MIIA CENTER).
 * Marker: name === 'MIIA' && businessName === 'MIIA'.
 * Equivalente al guardia integridad de prompt_modules.js L629-642.
 *
 * @param {object} profile
 * @returns {boolean}
 */
function isMiiaCenterProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return profile.name === 'MIIA' && profile.businessName === 'MIIA';
}

/**
 * Construye el bloque V2 de Voice DNA para inyectar en el system prompt
 * (post mod_personality) vía assemblePrompt(). Retorna null → caller no inyecta.
 *
 * @param {object} args
 * @param {string} args.chatType — 'miia_lead' en COMMIT 2 (otros en commits siguientes)
 * @param {object} args.ownerProfile — perfil del owner (MIIA_SALES_PROFILE | userProfile)
 * @param {object} [args.context] — { uid, contactName, basePhone, countryCode }
 * @returns {{block: string, meta: {source: string, subregistro: string, chatType: string, owner: string}} | null}
 */
// Mapping chatType entrada → subregistro V2 CENTER.
// COMMIT 2 → 'miia_lead'. COMMIT 4 → 'miia_client'. COMMIT 5 → 'selfchat'.
// Próximos commits amplían: 'family_chat' (6), 'medilink_team' (7) en paths Personal.
const V2_CHATTYPE_TO_CENTER_SUBREG = {
  miia_lead: 'lead',
  miia_client: 'client',
  selfchat: 'owner_selfchat'
};

function buildVoiceV2Block(args) {
  try {
    // Destructuring tolerante (args=null/undefined → defaults).
    const { chatType, ownerProfile, context } = args || {};

    // CAPA 2 — chatType no soportado en este commit.
    // Soportados hasta COMMIT 5: miia_lead + miia_client + selfchat. Otros retornan null.
    const centerSubreg = V2_CHATTYPE_TO_CENTER_SUBREG[chatType];
    if (!centerSubreg) {
      return null;
    }

    // CAPA 3 — ownerProfile inválido.
    if (!ownerProfile || typeof ownerProfile !== 'object') {
      console.warn('[V2][mod_voice_v2] ⚠️ ownerProfile inválido (null/no-object) — fallback V1');
      return null;
    }

    // Detección CENTER: jerarquía de señales.
    //   1. Si context.uid presente → señal primaria (isV2EligibleUid).
    //      * Motivo: en selfchat CENTER el ownerProfile puede estar mergeado
    //        con userProfile del admin y pisar el name (rompe el marker).
    //        context.uid (OWNER_UID) viene directo de la infra y es confiable.
    //   2. Si context.uid ausente → fallback al marker del profile.
    //      * Motivo: en paths tipo miia_lead el caller pasa MIIA_SALES_PROFILE
    //        directo, sin merge. El marker es confiable ahí.
    let isCenter;
    if (context && typeof context.uid === 'string' && context.uid.length > 0) {
      // Señal primaria: uid
      if (!isV2EligibleUid(context.uid)) {
        return null; // guard ETAPA 1 C-388 D.1
      }
      isCenter = true;
    } else {
      // Fallback: marker del profile
      isCenter = isMiiaCenterProfile(ownerProfile);
    }

    if (isCenter) {
      // CENTER → voice_seed_center.md §2.x según centerSubreg
      const dna = loadVoiceDNAForCenter(centerSubreg, {
        contactName: context && context.contactName
      });
      // CAPA 1 — loader falló o bloque vacío.
      if (!dna || dna.fallback || !dna.systemBlock) {
        return null;
      }
      return {
        block: dna.systemBlock,
        meta: {
          source: dna.source,
          subregistro: dna.subregistro,
          chatType,
          owner: 'center'
        }
      };
    }

    // Personal owner → ETAPA 1 NO elegible (C-388 D.1 firma Mariano 2026-04-22).
    // Retornar null → caller usa V1 puro (buildOwnerLeadPrompt clásico).
    return null;
  } catch (err) {
    // CAPA 4 — cualquier excepción = fallback a V1, nunca crashear el pipeline.
    console.error(`[V2][mod_voice_v2] ❌ Error en buildVoiceV2Block: ${err.message} — fallback V1`);
    return null;
  }
}

module.exports = {
  buildVoiceV2Block,
  isMiiaCenterProfile
};
