'use strict';

/**
 * C-355 FAMILY_BROADCAST FIXES — Validación conjunta (Wi → Vi, F.5).
 *
 * Valida los 4 fixes aplicados en CONJUNTO tras Bloque 1 "MIIA PRESENTATE CONMIGO":
 *
 *   BUG A (IA leak en BASE del prompt):
 *     buildFriendBroadcastPrompt/buildMedilinkTeamPrompt NO declaran "IA" en la línea
 *     de identidad. La declaración queda reservada a la capa 1 reactiva (3-capas).
 *
 *   BUG B (Capa 1 sanitize "Hola Mariano"):
 *     resolveOwnerFirstName descarta tokens tipo "Hola", "Buenos", "Soy" y retorna
 *     el primer token real del name. Evita que un Firestore corrupto (shortName="Hola")
 *     contamine prompts con "Hola armó para acompañar...".
 *
 *   BUG C (dialecto AR voseo, no CO tuteo):
 *     buildFriendBroadcastPrompt con countryCode='AR' genera bloque "AR voseo
 *     rioplatense" con "vos/contame/decime". Con 'CO' usa tuteo.
 *
 *   BUG D (bypass 🎨 spurious):
 *     applyMiiaEmoji con { isAutoPresentation: true } retorna DEFAULT_EMOJI fijo
 *     y limpia emojis-objeto sueltos del cuerpo (🎨🎮📚📸⚙️).
 *
 * Test NO llama Gemini. El smoke log del smartCall se ejecuta por separado
 * (ver scripts/smoke_c355_broadcast.js) con enableSearch=false para ver la
 * respuesta cruda sin enviar por WhatsApp.
 */

const {
  buildFriendBroadcastPrompt,
  buildMedilinkTeamPrompt,
  resolveOwnerFirstName,
} = require('../core/prompt_builder');
const { applyMiiaEmoji } = require('../core/miia_emoji');

// ═══════════════════════════════════════════════════════════════════
// BUG B — resolveOwnerFirstName sanitize
// ═══════════════════════════════════════════════════════════════════

describe('C-355 BUG B — resolveOwnerFirstName sanitize', () => {
  test('name="Hola Mariano" shortName="" → "Mariano" (descarta greeting)', () => {
    const out = resolveOwnerFirstName({ name: 'Hola Mariano', shortName: '' });
    expect(out).toBe('Mariano');
  });

  test('name="Mariano De Stefano" shortName="Mariano" → "Mariano" (OK)', () => {
    const out = resolveOwnerFirstName({ name: 'Mariano De Stefano', shortName: 'Mariano' });
    expect(out).toBe('Mariano');
  });

  test('shortName="Hola" name="Mariano De Stefano" → "Mariano" (fallback por greeting)', () => {
    const out = resolveOwnerFirstName({ name: 'Mariano De Stefano', shortName: 'Hola' });
    expect(out).toBe('Mariano');
  });

  test('shortName="Buenos" name="Buenos Mariano" → "Mariano" (greeting en shortName Y en name[0])', () => {
    const out = resolveOwnerFirstName({ name: 'Buenos Mariano', shortName: 'Buenos' });
    expect(out).toBe('Mariano');
  });

  test('perfil vacío → "Mariano" (fallback final)', () => {
    expect(resolveOwnerFirstName({})).toBe('Mariano');
    expect(resolveOwnerFirstName(null)).toBe('Mariano');
    expect(resolveOwnerFirstName(undefined)).toBe('Mariano');
  });

  test('tokens case-insensitive: "HOLA Mariano" → "Mariano"', () => {
    const out = resolveOwnerFirstName({ name: 'HOLA Mariano' });
    expect(out).toBe('Mariano');
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG A — BASE del prompt NO declara IA
// ═══════════════════════════════════════════════════════════════════

describe('C-355 BUG A — buildFriendBroadcastPrompt BASE sin "inteligencia artificial"', () => {
  const corruptProfile = { name: 'Hola Mariano', shortName: 'Hola' };
  const cleanProfile = { name: 'Mariano De Stefano', shortName: 'Mariano' };

  test('BASE AR no contiene "inteligencia artificial" ni "asistente de IA"', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', 'AR', cleanProfile);
    // Extraer solo el encabezado — hasta la línea "SI ... TE PREGUNTA"
    const baseSection = prompt.split(/SI .+ TE PREGUNTA/)[0];
    expect(baseSection).not.toMatch(/inteligencia artificial/i);
    expect(baseSection).not.toMatch(/asistente de ia/i);
    expect(baseSection).not.toMatch(/soy una ia/i);
  });

  test('BASE arranca con "Sos MIIA, una compañera que Mariano armó..."', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', 'AR', cleanProfile);
    expect(prompt).toMatch(/^Sos MIIA, una compañera que Mariano armó/);
  });

  test('Con perfil corrupto "Hola Mariano" — BASE NO dice "Hola armó"', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', 'AR', corruptProfile);
    expect(prompt).not.toMatch(/Hola armó/);
    expect(prompt).toMatch(/Mariano armó/);
  });

  test('Capa 1 reactiva SÍ declara "una IA que se conecta al WhatsApp"', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', 'AR', cleanProfile);
    expect(prompt).toMatch(/una IA que se conecta al WhatsApp/);
  });
});

describe('C-355 BUG A — buildMedilinkTeamPrompt gemelo sin "inteligencia artificial"', () => {
  const cleanProfile = { name: 'Mariano De Stefano', shortName: 'Mariano' };

  test('BASE MEDILINK_TEAM no declara IA en encabezado', () => {
    const prompt = buildMedilinkTeamPrompt('Sol', cleanProfile, { isBoss: false });
    const baseSection = prompt.split(/SI .+ TE PREGUNTA/)[0];
    expect(baseSection).not.toMatch(/inteligencia artificial/i);
    expect(baseSection).not.toMatch(/asistente de ia/i);
  });

  test('BASE MEDILINK_TEAM arranca con "Sos MIIA, una compañera que Mariano armó para apoyar al equipo de MediLink"', () => {
    const prompt = buildMedilinkTeamPrompt('Sol', cleanProfile, { isBoss: false });
    expect(prompt).toMatch(/^Sos MIIA, una compañera que Mariano armó para apoyar al equipo de MediLink/);
  });

  test('Con perfil corrupto "Hola Mariano" — BASE MEDILINK_TEAM sanitiza', () => {
    const prompt = buildMedilinkTeamPrompt('Sol', { name: 'Hola Mariano' }, {});
    expect(prompt).not.toMatch(/Hola armó/);
    expect(prompt).toMatch(/Mariano armó/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG C — dialecto AR voseo vs CO tuteo
// ═══════════════════════════════════════════════════════════════════

describe('C-355 BUG C — dialecto por countryCode', () => {
  const p = { name: 'Mariano De Stefano', shortName: 'Mariano' };

  test('country="AR" → voseo rioplatense (contame/decime/vos)', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', 'AR', p);
    expect(prompt).toMatch(/AR voseo rioplatense/);
    expect(prompt).toMatch(/Tratamiento: "vos"/);
    expect(prompt).toMatch(/contame/);
  });

  test('country="CO" → tuteo colombiano (cuéntame/dime/tú)', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', 'CO', p);
    expect(prompt).toMatch(/CO tuteo colombiano/);
    expect(prompt).toMatch(/Tratamiento: "tú"/);
    expect(prompt).toMatch(/cuéntame/);
  });

  test('country=undefined → default CO tuteo (fallback neutro)', () => {
    const prompt = buildFriendBroadcastPrompt('Ana', undefined, p);
    expect(prompt).toMatch(/tuteo/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG D — applyMiiaEmoji bypass con isAutoPresentation
// ═══════════════════════════════════════════════════════════════════

describe('C-355 BUG D — applyMiiaEmoji({ isAutoPresentation: true })', () => {
  test('Mensaje con "el arte de acompañarte" → NO retorna 🎨, retorna DEFAULT_EMOJI 👱‍♀️', () => {
    const input = 'Hola Ana, soy MIIA. El arte de acompañarte es lo que me mueve.';
    const out = applyMiiaEmoji(input, { chatType: 'friend_broadcast', isFamily: true, isAutoPresentation: true });
    expect(out).toMatch(/^👱‍♀️: /);
    expect(out).not.toMatch(/^🎨/);
  });

  test('Strip de emojis-objeto sueltos 🎨🎮📚📸', () => {
    const input = 'Hola 🎨 soy MIIA 🎮 encantada 📚 de conocerte 📸';
    const out = applyMiiaEmoji(input, { isAutoPresentation: true });
    expect(out).not.toMatch(/🎨/);
    expect(out).not.toMatch(/🎮/);
    expect(out).not.toMatch(/📚/);
    expect(out).not.toMatch(/📸/);
    expect(out).toMatch(/^👱‍♀️: /);
  });

  test('Sin flag isAutoPresentation → flujo normal (puede disparar emoji por tópico)', () => {
    const input = 'Hablemos de arte y pintura.';
    const outNormal = applyMiiaEmoji(input, { chatType: 'friend_broadcast' });
    // Sin el flag, el flujo normal se ejecuta (emoji puede variar — solo validamos que hay prefijo)
    expect(outNormal).toMatch(/^.+: /);
  });
});

// ═══════════════════════════════════════════════════════════════════
// INTEGRACIÓN — 4 FIXES SIMULTÁNEOS (caso real del Bloque 1)
// ═══════════════════════════════════════════════════════════════════

describe('C-355 INTEGRACIÓN — 4 fixes simultáneos sobre caso real del Bloque 1', () => {
  test('Caso real: userProfile corrupto "Hola Mariano" + country AR + texto con "arte"', () => {
    const corruptProfile = { name: 'Hola Mariano', shortName: 'Hola' };

    // (1) BUG B: sanitize
    const ownerFirst = resolveOwnerFirstName(corruptProfile);
    expect(ownerFirst).toBe('Mariano');

    // (2) BUG A + BUG C: prompt AR sin IA leak en base + voseo
    const prompt = buildFriendBroadcastPrompt('Cata', 'AR', corruptProfile);
    const baseSection = prompt.split(/SI .+ TE PREGUNTA/)[0];
    expect(baseSection).toMatch(/Mariano armó/); // BUG B aplicado en prompt
    expect(baseSection).not.toMatch(/inteligencia artificial/i); // BUG A
    expect(prompt).toMatch(/AR voseo rioplatense/); // BUG C

    // (3) BUG D: emoji bypass sobre respuesta simulada de Gemini que incluye "arte"
    const geminiSimulatedOutput = 'Hola Cata, soy MIIA. Mariano me contó de vos — el arte de conocerte me entusiasma 🎨';
    const finalText = applyMiiaEmoji(geminiSimulatedOutput, {
      chatType: 'friend_broadcast',
      isFamily: true,
      isAutoPresentation: true,
    });
    expect(finalText).toMatch(/^👱‍♀️: /);
    expect(finalText).not.toMatch(/🎨/);
    expect(finalText).not.toMatch(/Hola armó/);
    expect(finalText).toMatch(/Mariano me contó/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// C-357 — Auto-presentación inicial (MMC) en primera interacción
// ═══════════════════════════════════════════════════════════════════

describe('AUTO-PRESENTACIÓN INICIAL (C-357)', () => {
  const cleanProfile = { name: 'Mariano De Stefano', shortName: 'Mariano' };

  it('isFirstInteraction=true inyecta el bloque protocolo', () => {
    const prompt = buildFriendBroadcastPrompt('Laura', 'AR', cleanProfile, true);
    expect(prompt).toContain('PROTOCOLO DE AUTO-PRESENTACIÓN INICIAL');
    expect(prompt).toContain('inteligencia Y memoria artificial');
    expect(prompt).toContain('no soy un robot que');
  });

  it('isFirstInteraction=false (default) NO inyecta el bloque', () => {
    const prompt = buildFriendBroadcastPrompt('Laura', 'AR', cleanProfile, false);
    expect(prompt).not.toContain('PROTOCOLO DE AUTO-PRESENTACIÓN INICIAL');
  });

  it('dialecto AR se mantiene en el bloque', () => {
    const prompt = buildFriendBroadcastPrompt('Laura', 'AR', cleanProfile, true);
    expect(prompt).toMatch(/"vos"/);
    expect(prompt).not.toMatch(/"tú"/);
  });
});
