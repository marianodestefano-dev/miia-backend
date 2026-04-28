/**
 * Tests: C-446-FIX-ADN §B.2 — probadita REAL detector + opt-in.
 *
 * Origen: CARTA C-446-FIX-ADN [FIRMADA_VIVO_C446_FIX_ADN_MARIANO_2026-04-28].
 *
 * Cita Mariano: "PROBADITA ES PROBAR. Usar a MIIA y obtener lo que MIIA
 * ofrece. NO enviar imagen o gif — eso es mierda podrida."
 */

'use strict';

const {
  detectProbaditaFeatures,
  isOptInAccepted,
  buildProbaditaPromptContext,
  PROBADITA_FEATURES,
} = require('../core/probadita_real');

describe('C-446-FIX-ADN §B.2 — detectProbaditaFeatures', () => {
  test('A.1 — "soy hincha de Boca" → detecta deporte_seguimiento', () => {
    const r = detectProbaditaFeatures('soy hincha de Boca, me gusta mucho');
    expect(r.length).toBe(1);
    expect(r[0].feature).toBe('deporte_seguimiento');
  });

  test('A.2 — "me olvido de las cosas" → agenda_recordatorio', () => {
    const r = detectProbaditaFeatures('siempre me olvido las cosas importantes');
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r.some((d) => d.feature === 'agenda_recordatorio')).toBe(true);
  });

  test('A.3 — "tengo reunión mañana" → agenda_recordatorio', () => {
    const r = detectProbaditaFeatures('mañana tengo reunión con cliente importante');
    expect(r.some((d) => d.feature === 'agenda_recordatorio')).toBe(true);
  });

  test('A.4 — "sigo el dolar" → finanzas_alerta', () => {
    const r = detectProbaditaFeatures('me interesa el dólar, lo sigo');
    expect(r.some((d) => d.feature === 'finanzas_alerta')).toBe(true);
  });

  test('A.5 — "qué clima va a hacer?" → clima_diario', () => {
    const r = detectProbaditaFeatures('qué clima hay mañana en Buenos Aires?');
    expect(r.some((d) => d.feature === 'clima_diario')).toBe(true);
  });

  test('A.6 — "olvido pastilla 10am" → salud_recordatorio', () => {
    const r = detectProbaditaFeatures('siempre olvido la pastilla a las 10');
    expect(r.some((d) => d.feature === 'salud_recordatorio')).toBe(true);
  });

  test('A.7 — "Buenos días" → 0 features (saludo simple)', () => {
    const r = detectProbaditaFeatures('Buenos días, cómo estás?');
    expect(r.length).toBe(0);
  });

  test('A.8 — texto vacío / null → 0 features defensivo', () => {
    expect(detectProbaditaFeatures('').length).toBe(0);
    expect(detectProbaditaFeatures(null).length).toBe(0);
    expect(detectProbaditaFeatures(undefined).length).toBe(0);
  });

  test('A.9 — "quiero comprar laptop" → precios_seguimiento', () => {
    const r = detectProbaditaFeatures('quiero comprar una laptop');
    expect(r.some((d) => d.feature === 'precios_seguimiento')).toBe(true);
  });

  test('A.10 — "qué cocino hoy?" → cocina_receta', () => {
    const r = detectProbaditaFeatures('qué cocino esta noche?');
    expect(r.some((d) => d.feature === 'cocina_receta')).toBe(true);
  });

  test('A.11 — opt-in prompt presente para cada feature catálogo', () => {
    for (const [feature, def] of Object.entries(PROBADITA_FEATURES)) {
      expect(typeof def.optInPrompt).toBe('string');
      expect(def.optInPrompt.length).toBeGreaterThan(20);
      expect(typeof def.demoTag).toBe('string');
    }
  });
});

describe('C-446-FIX-ADN §B.2 — isOptInAccepted', () => {
  test('B.1 — "sí dale" → true', () => {
    expect(isOptInAccepted('sí dale')).toBe(true);
  });

  test('B.2 — "ok, perfecto" → true', () => {
    expect(isOptInAccepted('ok, perfecto')).toBe(true);
  });

  test('B.3 — "claro, me gustaría" → true', () => {
    expect(isOptInAccepted('claro, me gustaría')).toBe(true);
  });

  test('B.4 — "no, gracias" → false (rechazo, falla pattern accept)', () => {
    // Importante: "no" no debería cuadrar como aceptación
    expect(isOptInAccepted('no, gracias')).toBe(false);
  });

  test('B.5 — "tal vez después" → false', () => {
    expect(isOptInAccepted('tal vez después')).toBe(false);
  });

  test('B.6 — "buenísimo, listo" → true', () => {
    expect(isOptInAccepted('buenísimo, listo')).toBe(true);
  });

  test('B.7 — texto vacío → false defensivo', () => {
    expect(isOptInAccepted('')).toBe(false);
    expect(isOptInAccepted(null)).toBe(false);
  });
});

describe('C-446-FIX-ADN §B.2 — buildProbaditaPromptContext', () => {
  test('C.1 — features detectadas → block con instrucciones', () => {
    const features = [
      {
        feature: 'deporte_seguimiento',
        optInPrompt: 'Decime de qué equipo sos...',
        demoTag: 'deporte_seguimiento',
        matched: 'hincha de Boca',
      },
    ];
    const block = buildProbaditaPromptContext(features);
    expect(block).toContain('PROBADITA REAL');
    expect(block).toContain('deporte_seguimiento');
    expect(block).toContain('hincha de Boca');
    expect(block).toContain('NO menciones precio');
  });

  test('C.2 — array vacío → null', () => {
    expect(buildProbaditaPromptContext([])).toBeNull();
  });

  test('C.3 — null/undefined → null defensivo', () => {
    expect(buildProbaditaPromptContext(null)).toBeNull();
    expect(buildProbaditaPromptContext(undefined)).toBeNull();
  });

  test('C.4 — múltiples features → todas incluidas', () => {
    const features = [
      { feature: 'agenda_recordatorio', optInPrompt: 'qué tenés?', demoTag: 'agenda_recordatorio', matched: 'me olvido' },
      { feature: 'finanzas_alerta', optInPrompt: 'qué activos?', demoTag: 'finanzas_alerta', matched: 'dólar' },
    ];
    const block = buildProbaditaPromptContext(features);
    expect(block).toContain('agenda_recordatorio');
    expect(block).toContain('finanzas_alerta');
    expect(block).toContain('me olvido');
    expect(block).toContain('dólar');
  });
});

describe('C-446-FIX-ADN §B.2 — PROBADITA_FEATURES catálogo', () => {
  test('D.1 — catálogo tiene al menos 8 features', () => {
    expect(Object.keys(PROBADITA_FEATURES).length).toBeGreaterThanOrEqual(8);
  });

  test('D.2 — cada feature tiene keywords array no vacío', () => {
    for (const [feature, def] of Object.entries(PROBADITA_FEATURES)) {
      expect(Array.isArray(def.keywords)).toBe(true);
      expect(def.keywords.length).toBeGreaterThan(0);
      def.keywords.forEach((rx) => expect(rx instanceof RegExp).toBe(true));
    }
  });

  test('D.3 — features incluyen ejemplos de Mariano (boca, pastilla, recordame)', () => {
    expect(PROBADITA_FEATURES.deporte_seguimiento).toBeDefined();
    expect(PROBADITA_FEATURES.salud_recordatorio).toBeDefined();
    expect(PROBADITA_FEATURES.agenda_recordatorio).toBeDefined();
  });
});
