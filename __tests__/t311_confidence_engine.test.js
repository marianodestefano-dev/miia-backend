'use strict';

/**
 * T311 -- confidence_engine unit tests (20/20)
 * Note: confidence_engine usa fs.readFileSync para cargar patterns.
 * Los tests cubren funciones puras sin persistencia en disco.
 */

const {
  decideAction,
  findSimilarPatterns,
  recordFeedback,
  getPatterns,
  loadPatterns,
} = require('../core/confidence_engine');

describe('T311 -- confidence_engine (20 tests)', () => {

  beforeEach(() => {
    // Limpiar patterns en memoria antes de cada test
    const state = getPatterns();
    state.patterns = [];
    state.feedback_history = [];
    state.thresholds = { auto_save: 85, ask: 70, ignore: 0 };
  });

  // decideAction

  test('decideAction: score >= 85 (auto_save) retorna action=save', () => {
    const result = decideAction(90, 'regla importante de precios para todos los clientes');
    expect(result.action).toBe('save');
    expect(result.confidence).toBeGreaterThanOrEqual(85);
    expect(result.reason).toContain('guardar');
  });

  test('decideAction: score 70-84 retorna action=ask', () => {
    const result = decideAction(75, 'dato moderadamente relevante');
    expect(result.action).toBe('ask');
    expect(result.confidence).toBeGreaterThanOrEqual(70);
    expect(result.confidence).toBeLessThan(85);
    expect(result.reason).toContain('preguntar');
  });

  test('decideAction: score < 70 retorna action=ignore', () => {
    const result = decideAction(50, 'hola como estas hoy');
    expect(result.action).toBe('ignore');
    expect(result.confidence).toBeLessThan(70);
    expect(result.reason).toContain('Confianza baja');
  });

  test('decideAction: score exactamente en 85 es save', () => {
    const result = decideAction(85, 'texto de prueba para boundary');
    expect(result.action).toBe('save');
  });

  test('decideAction: score exactamente en 70 es ask', () => {
    const result = decideAction(70, 'texto para boundary ask');
    expect(result.action).toBe('ask');
  });

  test('decideAction: score 0 es ignore', () => {
    const result = decideAction(0, 'hola');
    expect(result.action).toBe('ignore');
  });

  test('decideAction: score 100 es save', () => {
    const result = decideAction(100, 'regla maxima');
    expect(result.action).toBe('save');
    expect(result.confidence).toBe(100);
  });

  // findSimilarPatterns

  test('findSimilarPatterns: retorna array vacio si no hay patterns', () => {
    const results = findSimilarPatterns('cualquier texto');
    expect(results).toEqual([]);
  });

  test('findSimilarPatterns: encuentra patterns con alta similitud', () => {
    // Agregar un pattern manualmente
    const state = getPatterns();
    state.patterns.push({
      text: 'precio del plan esencial es 50 dolares por mes',
      importanceScore: 90,
      feedback: 'yes',
      timestamp: new Date().toISOString(),
    });

    // Texto muy similar
    const results = findSimilarPatterns('precio del plan esencial es 50 dolares por mes', 0.7);
    expect(results.length).toBe(1);
  });

  test('findSimilarPatterns: no retorna patterns con baja similitud', () => {
    const state = getPatterns();
    state.patterns.push({
      text: 'precio del plan esencial es 50 dolares',
      importanceScore: 90,
      feedback: 'yes',
      timestamp: new Date().toISOString(),
    });

    const results = findSimilarPatterns('hola buenos dias como estas?', 0.7);
    expect(results.length).toBe(0);
  });

  test('findSimilarPatterns: respeta minSimilarity custom', () => {
    const state = getPatterns();
    state.patterns.push({
      text: 'precio plan esencial mensual',
      importanceScore: 85,
      feedback: 'yes',
      timestamp: new Date().toISOString(),
    });

    // Con minSimilarity muy alta (0.99) no deberia encontrar nada si no es identico
    const resultsHigh = findSimilarPatterns('precio plan esencial anual', 0.99);
    // Con minSimilarity baja (0.3) deberia encontrar algo
    const resultsLow = findSimilarPatterns('precio plan esencial anual', 0.3);
    expect(resultsHigh.length).toBe(0);
    expect(resultsLow.length).toBe(1);
  });

  // recordFeedback

  test('recordFeedback: agrega pattern al historico', () => {
    const stateBefore = getPatterns();
    const countBefore = stateBefore.patterns.length;

    recordFeedback('el cliente prefiere pagar mensual', 'yes', 80);

    const stateAfter = getPatterns();
    expect(stateAfter.patterns.length).toBe(countBefore + 1);
    expect(stateAfter.patterns[stateAfter.patterns.length - 1].feedback).toBe('yes');
  });

  test('recordFeedback: trunca texto a 300 chars', () => {
    const longText = 'a'.repeat(500);
    recordFeedback(longText, 'no', 30);
    const state = getPatterns();
    const last = state.patterns[state.patterns.length - 1];
    expect(last.text.length).toBeLessThanOrEqual(300);
  });

  test('recordFeedback: guarda importanceScore y timestamp', () => {
    recordFeedback('dato importante del negocio', 'yes', 90);
    const state = getPatterns();
    const last = state.patterns[state.patterns.length - 1];
    expect(last.importanceScore).toBe(90);
    expect(typeof last.timestamp).toBe('string');
  });

  // Boost desde historial de confirmaciones

  test('decideAction: 3+ confirmaciones similares suben confianza a save', () => {
    const state = getPatterns();
    const text = 'precio plan mensual costo por usuario activo';

    // Agregar 3 confirmaciones con feedback yes
    for (let i = 0; i < 3; i++) {
      state.patterns.push({
        text,
        importanceScore: 80,
        feedback: 'yes',
        timestamp: new Date().toISOString(),
      });
    }

    // Con 80 de importancia + 3*5=15 boost = 95 → save
    const result = decideAction(80, text);
    expect(result.action).toBe('save');
    expect(result.confidence).toBeGreaterThanOrEqual(85);
  });

  // getPatterns

  test('getPatterns: retorna objeto con patterns, thresholds, feedback_history', () => {
    const state = getPatterns();
    expect(Array.isArray(state.patterns)).toBe(true);
    expect(typeof state.thresholds).toBe('object');
    expect(typeof state.thresholds.auto_save).toBe('number');
    expect(typeof state.thresholds.ask).toBe('number');
  });

  test('getPatterns: thresholds default son 85 auto_save y 70 ask', () => {
    const state = getPatterns();
    expect(state.thresholds.auto_save).toBe(85);
    expect(state.thresholds.ask).toBe(70);
  });

  // loadPatterns

  test('loadPatterns: no lanza si el archivo no existe (silencia error)', () => {
    expect(() => loadPatterns()).not.toThrow();
  });

  test('decideAction: retorna objeto con action, confidence, reason siempre', () => {
    const cases = [
      [0, 'texto corto'],
      [50, 'texto medio relevante para la empresa'],
      [100, 'regla critica de sistema permanente'],
    ];
    for (const [score, text] of cases) {
      const result = decideAction(score, text);
      expect(typeof result.action).toBe('string');
      expect(typeof result.confidence).toBe('number');
      expect(typeof result.reason).toBe('string');
    }
  });
});
