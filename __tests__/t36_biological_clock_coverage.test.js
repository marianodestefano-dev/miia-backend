'use strict';

/**
 * Tests: T36 — biological_clock.js coverage push.
 *
 * Origen: Wi mail [171] [LISTA-MEGA-EXPANDIDA-VI] — "T36 Test coverage
 * push to 85%+ miia-backend (de baseline actual)".
 *
 * Modulo seleccionado: core/biological_clock.js (sin tests previos,
 * funciones puras facilmente testeables).
 *
 * §A — classifyLeadState: 7 estados + edge cases
 * §B — buildFollowupPrompt: 7 ramas switch case
 * §C — exports + signal arrays sanity
 */

'use strict';

const bc = require('../core/biological_clock');

describe('T36 §A — classifyLeadState', () => {
  test('A.1 — postponed: "después" detecta later signal 24h', () => {
    const r = bc.classifyLeadState('lo voy a pensar después', '', {});
    expect(r.state).toBe('postponed');
    expect(r.signal).toBe('later');
    expect(r.suggestedDelayHours).toBe(24);
  });

  test('A.2 — postponed: "te aviso" detecta', () => {
    const r = bc.classifyLeadState('te aviso luego', '', {});
    expect(r.state).toBe('postponed');
  });

  test('A.3 — quote_sent: lead pidió "cotización" → 48h', () => {
    const r = bc.classifyLeadState('necesito cotización', '', {});
    expect(r.state).toBe('quote_sent');
    expect(r.suggestedDelayHours).toBe(48);
  });

  test('A.4 — quote_sent: MIIA mando "presupuesto" tambien dispara', () => {
    const r = bc.classifyLeadState('ok', 'Acá te paso el presupuesto', {});
    expect(r.state).toBe('quote_sent');
  });

  test('A.5 — referral_given: "te paso el numero" → 72h', () => {
    const r = bc.classifyLeadState('te paso el número de mi amigo', '', {});
    expect(r.state).toBe('referral_given');
    expect(r.suggestedDelayHours).toBe(72);
  });

  test('A.6 — interested: "me interesa" → 4h', () => {
    const r = bc.classifyLeadState('me interesa saber más', '', {});
    expect(r.state).toBe('interested');
    expect(r.suggestedDelayHours).toBe(4);
  });

  test('A.7 — cold: "estoy bien así" → Infinity', () => {
    const r = bc.classifyLeadState('estoy bien así, gracias', '', {});
    expect(r.state).toBe('cold');
    expect(r.suggestedDelayHours).toBe(Infinity);
  });

  test('A.7b — cold: "no me interesa" NO matchea INTEREST (fix T37 orden COLD>INTEREST)', () => {
    // Bug T36: "no me interesa" contenia "me interesa" como substring → matcheaba INTEREST antes que COLD.
    // Fix T37: COLD_SIGNALS se evalua ANTES que INTEREST_SIGNALS en classifyLeadState().
    const r = bc.classifyLeadState('no me interesa', '', {});
    expect(r.state).toBe('cold');
    expect(r.signal).toBe('cold');
    expect(r.suggestedDelayHours).toBe(Infinity);
  });

  test('A.7c — interest: "me interesa" sin negacion → interested (no regresion)', () => {
    const r = bc.classifyLeadState('me interesa', '', {});
    expect(r.state).toBe('interested');
    expect(r.signal).toBe('interest');
  });

  test('A.8 — cold: "no me escribas" tambien dispara', () => {
    const r = bc.classifyLeadState('por favor no me escribas más', '', {});
    expect(r.state).toBe('cold');
  });

  test('A.9 — no_response default: msg sin signals → 24h', () => {
    const r = bc.classifyLeadState('hola, ¿cómo estás?', '', {});
    expect(r.state).toBe('no_response');
    expect(r.signal).toBe('silent');
  });

  test('A.10 — input null/undefined no throw', () => {
    expect(() => bc.classifyLeadState(null, null, {})).not.toThrow();
    expect(() => bc.classifyLeadState(undefined, undefined, undefined)).not.toThrow();
    const r = bc.classifyLeadState(null, null);
    expect(r.state).toBe('no_response');
  });

  test('A.11 — case insensitive: "DESPUÉS" mayusculas matchea', () => {
    const r = bc.classifyLeadState('LO PIENSO DESPUÉS', '', {});
    expect(r.state).toBe('postponed');
  });
});

describe('T36 §B — buildFollowupPrompt', () => {
  const profile = { businessName: 'TestBiz' };

  test('B.1 — postponed: incluye nombre + ultimo msg', () => {
    const p = bc.buildFollowupPrompt('postponed', 'Mariano', 'lo pienso', 'ofrezco demo', 1, profile);
    expect(p).toContain('Mariano');
    expect(p).toContain('TestBiz');
    expect(p).toMatch(/postergad|despues|pensab/i);
  });

  test('B.2 — quote_sent: pregunta si reviso cotizacion', () => {
    const p = bc.buildFollowupPrompt('quote_sent', 'Ana', '', '', 0, profile);
    expect(p).toMatch(/cotizaci|presupuesto|reviso|dudas/i);
  });

  test('B.3 — referral_given: agradecimiento por contacto', () => {
    const p = bc.buildFollowupPrompt('referral_given', 'Pedro', '', '', 0, profile);
    expect(p).toMatch(/contacto|agradec|referido/i);
  });

  test('B.4 — interested: ofrece demo/ejemplo', () => {
    const p = bc.buildFollowupPrompt('interested', 'Lucia', '', '', 0, profile);
    expect(p).toMatch(/demo|ejemplo|caso/i);
  });

  test('B.5 — cold: despedida respetuosa, prohibido insistir', () => {
    const p = bc.buildFollowupPrompt('cold', 'Juan', '', '', 0, profile);
    expect(p).toMatch(/despedi|gusto|respeto/i);
    expect(p).toMatch(/PROHIBIDO insistir|sin presi/i);
  });

  test('B.6 — farewell_recontact: tono fresco sin carga', () => {
    const p = bc.buildFollowupPrompt('farewell_recontact', 'Carlos', '', '', 0, profile);
    expect(p).toMatch(/fresco|valor|UNA ULTIMA VEZ|ULTIMA/i);
  });

  test('B.7 — default no_response (followupCount<2): mensaje retomar', () => {
    const p = bc.buildFollowupPrompt('no_response', 'Luis', 'mensaje del lead', 'respuesta MIIA', 0, profile);
    expect(p).toMatch(/retom|natural|valor/i);
    expect(p).toContain('Follow-up');
  });

  test('B.8 — default last attempt (followupCount>=2): despedida con gracia', () => {
    const p = bc.buildFollowupPrompt('no_response', 'Maria', 'msg', 'resp', 2, profile);
    expect(p).toMatch(/ULTIMO intento|despedi/i);
    expect(p).toMatch(/PROHIBIDO presi|gracia/i);
  });

  test('B.9 — sin businessName usa "el negocio"', () => {
    const p = bc.buildFollowupPrompt('postponed', 'X', '', '', 0, {});
    expect(p).toContain('el negocio');
  });
});

describe('T36 §C — exports + signal arrays sanity', () => {
  test('C.1 — exporta classifyLeadState + buildFollowupPrompt', () => {
    expect(typeof bc.classifyLeadState).toBe('function');
    expect(typeof bc.buildFollowupPrompt).toBe('function');
  });

  test('C.2 — exporta arrays de signals (no vacios)', () => {
    expect(Array.isArray(bc.LATER_SIGNALS)).toBe(true);
    expect(bc.LATER_SIGNALS.length).toBeGreaterThan(0);
    expect(Array.isArray(bc.QUOTE_SIGNALS)).toBe(true);
    expect(bc.QUOTE_SIGNALS.length).toBeGreaterThan(0);
    expect(Array.isArray(bc.REFERRAL_SIGNALS)).toBe(true);
    expect(Array.isArray(bc.INTEREST_SIGNALS)).toBe(true);
    expect(Array.isArray(bc.COLD_SIGNALS)).toBe(true);
  });

  test('C.3 — LATER_SIGNALS incluye variantes con/sin tildes', () => {
    expect(bc.LATER_SIGNALS).toContain('después');
    expect(bc.LATER_SIGNALS).toContain('despues');
  });

  test('C.4 — COLD_SIGNALS incluye señales de bloqueo', () => {
    expect(bc.COLD_SIGNALS.some(s => s.includes('no me interesa'))).toBe(true);
    expect(bc.COLD_SIGNALS.some(s => s.includes('bloquear') || s.includes('spam'))).toBe(true);
  });
});
