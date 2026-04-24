'use strict';

/**
 * CANARY TEST — Aislamiento contextual cross-contact (C-404 Cimientos §3 C.5).
 *
 * Spec: §E.4.3 DOC_PRIVACY_LEGAL_ENCRIPCION + regla verbatim Mariano C-368:
 *   "jamás MIIA puede decirle a otro contacto algo de otro contacto."
 *
 * Estrategia:
 *   1. Construir 2 contextos aislados:
 *      - ctxA: lleva marker secreto UNICORNIO_FUCSIA_42 en contactName/contactPrefs/notes
 *      - ctxB: contexto limpio sin marker
 *   2. Para cada chatType real (selfchat, lead, miia_lead, family, equipo, group, default):
 *      - Sanity: assemblePrompt(ctxA) DEBE contener marker (evita que el test pase
 *        por culpa de mock vacío que jamás incluiría el marker tampoco si existiera leak)
 *      - Canary: assemblePrompt(ctxB) NO DEBE contener marker (regresión cross-contact
 *        si algún módulo cachea state global o fugó info de otra llamada anterior)
 *   3. Cross-call sequencing: ctxA llamado ANTES que ctxB en el mismo describe.
 *      Si algún módulo guarda state cross-call (ej: WeakMap mal configurado, cache
 *      compartido entre invocaciones), la llamada ctxB hereda info de ctxA → leak.
 *
 * Si el test falla → regresión CRÍTICA del aislamiento → bloquea deploy.
 */

const { assemblePrompt } = require('../core/prompt_modules');

const SECRET_MARKER = 'UNICORNIO_FUCSIA_42';

// ChatTypes reales según selectModules() en prompt_modules.js:538-595
const CHAT_TYPES = [
  'selfchat',
  'lead',
  'miia_lead',
  'family',
  'equipo',
  'group',
  'unknown', // hits default branch
];

// Owner profile mock — usa el guardia de integridad miia_lead
// Para chatType='miia_lead' el profile DEBE ser MIIA CENTER, sino degrada a 'lead'
function buildOwnerProfile() {
  return {
    name: 'MIIA',
    businessName: 'MIIA',
    role: 'ventas y atención',
    country: 'CO',
    countryCode: 'CO',
    timezone: 'America/Bogota',
    languageHint: 'español',
    pronouns: { miia: 'femenino', owner: 'él' },
  };
}

// Context con marker injectado
function buildCtxWithMarker(phone) {
  return {
    contactName: `Mama ${SECRET_MARKER}`,
    contactPhone: phone,
    contactPrefs: {
      notes: `Esta contacto mencionó ${SECRET_MARKER} en conversación privada secreta`,
      lastTopic: SECRET_MARKER,
    },
    affinityStage: 'familia_intima',
    trainingData: `Notes per-contact: ${SECRET_MARKER} es info privada que NUNCA debe leakar.`,
  };
}

// Context limpio sin marker
function buildCtxClean(phone) {
  return {
    contactName: 'Lead Anónimo',
    contactPhone: phone,
    contactPrefs: {
      notes: 'Sin info per-contact relevante',
      lastTopic: 'cotizacion',
    },
    affinityStage: 'frio',
    trainingData: 'Genérico training data sin info personal.',
  };
}

const PHONE_A = '+5491164431700'; // mamá Silvia
const PHONE_B = '+573054169969'; // contacto distinto

describe('C-404 Canary — Aislamiento contextual UNICORNIO_FUCSIA_42', () => {

  describe.each(CHAT_TYPES)('chatType=%s', (chatType) => {
    test('SANITY: ctxA con marker → prompt SÍ contiene marker (mock validado)', () => {
      const result = assemblePrompt({
        chatType,
        messageBody: 'hola',
        ownerProfile: buildOwnerProfile(),
        context: buildCtxWithMarker(PHONE_A),
      });

      // Si esto falla, el módulo de ese chatType no usa contactName/contactPrefs/etc.
      // → el test canary tampoco detectaría leak real porque mock vacío.
      // Solución: agregar más superficies donde inyectar marker hasta que sanity pase.
      const promptText = typeof result === 'string'
        ? result
        : (result && result.prompt) || JSON.stringify(result);

      expect(promptText).toContain(SECRET_MARKER);
    });

    test('CANARY: ctxA llamado ANTES, después ctxB limpio → prompt B NO contiene marker', () => {
      // Llamada A primero (ctx con marker)
      assemblePrompt({
        chatType,
        messageBody: 'hola',
        ownerProfile: buildOwnerProfile(),
        context: buildCtxWithMarker(PHONE_A),
      });

      // Llamada B después (ctx limpio, phone distinto)
      const resultB = assemblePrompt({
        chatType,
        messageBody: 'hola',
        ownerProfile: buildOwnerProfile(),
        context: buildCtxClean(PHONE_B),
      });

      const promptTextB = typeof resultB === 'string'
        ? resultB
        : (resultB && resultB.prompt) || JSON.stringify(resultB);

      // Si esto falla → algún módulo cacheó info de phoneA y la inyectó al prompt de phoneB
      // = leak cross-contact = regresión CRÍTICA. Reportar a Mariano.
      expect(promptTextB).not.toContain(SECRET_MARKER);
      expect(promptTextB).not.toContain('Mama UNICORNIO');
      expect(promptTextB).not.toContain('conversación privada secreta');
    });
  });

  // Test cross-chatType: marker injectado en chatType='family', después llamada con
  // chatType='lead' (otro chatType, otro contacto). Detecta si state se filtra cross-chatType.
  test('CROSS-CHATTYPE: marker en family-ctxA, después lead-ctxB → no leak', () => {
    assemblePrompt({
      chatType: 'family',
      messageBody: 'hola mamá',
      ownerProfile: buildOwnerProfile(),
      context: buildCtxWithMarker(PHONE_A),
    });

    const resultLead = assemblePrompt({
      chatType: 'lead',
      messageBody: 'cotización por favor',
      ownerProfile: buildOwnerProfile(),
      context: buildCtxClean(PHONE_B),
    });

    const promptText = typeof resultLead === 'string'
      ? resultLead
      : (resultLead && resultLead.prompt) || JSON.stringify(resultLead);

    expect(promptText).not.toContain(SECRET_MARKER);
  });
});
