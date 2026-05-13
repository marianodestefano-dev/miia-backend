'use strict';

/**
 * EXTRA #4.b BUG-023 — Tercera persona self-chat sobre terceros.
 * Test anti-regresion: el prompt buildOwnerSelfChatPrompt debe contener
 * la REGLA CERO de SEGUNDA PERSONA OBLIGATORIA (fix BUG-023).
 *
 * Bug: MIIA respondia a Mariano "Ale es la esposa de Mariano..." en lugar
 * de "tu esposa Ale...". Fix: reforzar la directiva en el prompt al
 * principio + ejemplos negativos explicitos.
 */

const { buildOwnerSelfChatPrompt } = require('../core/prompt_builder');

const MARIANO_PROFILE = {
  uid: 'bq2BbtCVF8cZo30tum584zrGATJ3',
  name: 'Mariano',
  shortName: 'Mariano',
  businessName: 'MIIA',
  city: 'Bogotá',
  country: 'Colombia',
  whatsappOk: true,
  revealAsAI: true,
};

describe('BUG-023 — Tercera persona self-chat fix', () => {
  let prompt;
  beforeAll(() => {
    prompt = buildOwnerSelfChatPrompt(MARIANO_PROFILE, 'hola');
  });

  test('contiene REGLA CERO segunda persona obligatoria', () => {
    expect(prompt).toContain('REGLA CERO');
    expect(prompt).toContain('SEGUNDA PERSONA OBLIGATORIA');
    expect(prompt).toContain('BUG-023');
  });

  test('contiene ejemplo prohibido tipo "X es la/el Y de OWNER"', () => {
    expect(prompt).toContain('Ale es la esposa de Mariano');
    // PROHIBIDO + ejemplos negativos
    expect(prompt).toContain('PROHIBIDO al responderle');
  });

  test('contiene reformulacion correcta "tu esposa Ale"', () => {
    expect(prompt).toContain('tu esposa Ale');
    expect(prompt).toContain('OBLIGATORIO al responderle');
  });

  test('explica que reescribir mentalmente antes de emitir', () => {
    expect(prompt).toContain('reescribí mentalmente');
  });

  test('mantiene la seccion DETALLE con ejemplos especificos', () => {
    expect(prompt).toContain('SILVIA (MAMÁ');
    expect(prompt).toContain('RAFA (PAPÁ');
    expect(prompt).toContain('ALE (ESPOSA');
    expect(prompt).toContain('ANA (HERMANA');
  });

  test('regla universal de posesivos cubre cumpleaños / reunion / clientes', () => {
    expect(prompt).toContain('tu cumpleaños');
    expect(prompt).toContain('tu reunión');
    expect(prompt).toContain('tus clientes');
  });
});

describe('BUG-023 — perfil custom con shortName distinto', () => {
  test('shortName se interpola en TODAS las apariciones de la regla', () => {
    const profile = {
      uid: 'custom_uid_1',
      name: 'Pedro Perez',
      shortName: 'Pedro',
      businessName: 'Clinica Pedro',
      revealAsAI: false,
    };
    const prompt = buildOwnerSelfChatPrompt(profile, 'hola');
    expect(prompt).toContain('ESTÁS HABLANDO CON Pedro');
    // Las prohibiciones deben usar el shortName custom
    expect(prompt).toMatch(/esposa de Pedro/);
    expect(prompt).toMatch(/tenés una reunión/);
  });
});
