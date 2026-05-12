'use strict';
/**
 * R16-B — onboarding_module.test.js
 * 100% branch coverage: startOnboarding + processAnswer + getOnboardingStatus + _otorgarNivel
 */

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockFaseDocs = {};      // 'fase1'..'fase6' -> { exists, data }
let mockGamDoc = null;      // null | object (data when exists=true)
let mockFaseGetThrows = false;
let mockFaseSetThrows = false;
let mockGamGetThrows = false;
let mockGamSetThrows = false;

const mockFs = {
  collection: () => ({
    doc: () => ({
      collection: (sub) => ({
        doc: (docId) => ({
          get: () => {
            if (sub === 'onboarding') {
              if (mockFaseGetThrows) return Promise.reject(new Error('FASE-GET-FAIL'));
              const entry = mockFaseDocs[docId];
              if (!entry) return Promise.resolve({ exists: false, data: () => ({}) });
              return Promise.resolve({ exists: true, data: () => entry });
            }
            if (sub === 'gamification') {
              if (mockGamGetThrows) return Promise.reject(new Error('GAM-GET-FAIL'));
              if (mockGamDoc === null) return Promise.resolve({ exists: false, data: () => ({}) });
              return Promise.resolve({ exists: true, data: () => mockGamDoc });
            }
            return Promise.resolve({ exists: false, data: () => ({}) });
          },
          set: (data, opts) => {
            if (sub === 'onboarding') {
              if (mockFaseSetThrows) return Promise.reject(new Error('FASE-SET-FAIL'));
              const prev = mockFaseDocs[docId] || {};
              mockFaseDocs[docId] = Object.assign({}, prev, data);
              return Promise.resolve();
            }
            if (sub === 'gamification') {
              if (mockGamSetThrows) return Promise.reject(new Error('GAM-SET-FAIL'));
              mockGamDoc = Object.assign({}, mockGamDoc || {}, data);
              return Promise.resolve();
            }
            return Promise.resolve();
          },
        }),
      }),
    }),
  }),
};

const {
  startOnboarding,
  processAnswer,
  getOnboardingStatus,
  FASES,
  PREGUNTAS_FASE1,
  NIVELES,
  CERTIFICATION_PASS_SCORE,
  CERTIFICATION_TOTAL,
  __setFirestoreForTests,
} = require('../core/mod_onboarding');
__setFirestoreForTests(mockFs);

function allFasesCompletado(upTo = 6) {
  for (let f = 1; f <= upTo; f++) {
    mockFaseDocs['fase' + f] = { completado: true, respuestas: [] };
  }
}

beforeEach(() => {
  mockFaseDocs = {};
  mockGamDoc = null;
  mockFaseGetThrows = false;
  mockFaseSetThrows = false;
  mockGamGetThrows = false;
  mockGamSetThrows = false;
});

// ── getOnboardingStatus ───────────────────────────────────────────────────────
describe('getOnboardingStatus', () => {
  test('uid falsy retorna zeros', async () => {
    const r = await getOnboardingStatus('');
    expect(r).toEqual({ fase_actual: 0, progreso_pct: 0, completado: false, gamification: null });
  });

  test('fase 1 no existe => fase_actual=1, progreso=0', async () => {
    const r = await getOnboardingStatus('uid-abc');
    expect(r.fase_actual).toBe(1);
    expect(r.progreso_pct).toBe(0);
    expect(r.completado).toBe(false);
  });

  test('fase 1 existe pero no completado => fase_actual=1', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: ['r1'] };
    const r = await getOnboardingStatus('uid-abc');
    expect(r.fase_actual).toBe(1);
    expect(r.completado).toBe(false);
  });

  test('fases 1-5 completadas, fase 6 no existe => fase_actual=6, progreso=83, completado=false', async () => {
    allFasesCompletado(5);
    const r = await getOnboardingStatus('uid-abc');
    expect(r.fase_actual).toBe(6);
    expect(r.completado).toBe(false);
    expect(r.progreso_pct).toBe(83);
  });

  test('todas 6 fases completadas => completado=true, progreso=100', async () => {
    allFasesCompletado(6);
    const r = await getOnboardingStatus('uid-abc');
    expect(r.fase_actual).toBe(6);
    expect(r.completado).toBe(true);
    expect(r.progreso_pct).toBe(100);
  });

  test('gamification snap existe => retorna datos', async () => {
    mockGamDoc = { nivel: 'Bronze', score: 80, racha_dias: 0, logros: ['Bronze'] };
    const r = await getOnboardingStatus('uid-abc');
    expect(r.gamification).not.toBeNull();
    expect(r.gamification.nivel).toBe('Bronze');
  });

  test('gamification snap no existe => gamification null', async () => {
    mockGamDoc = null;
    const r = await getOnboardingStatus('uid-abc');
    expect(r.gamification).toBeNull();
  });

  test('gamification throws => silenciado, gamification null', async () => {
    mockGamGetThrows = true;
    const r = await getOnboardingStatus('uid-abc');
    expect(r.gamification).toBeNull();
    expect(r.fase_actual).toBe(1);
  });

  test('fase get throws => outer catch, retorna zeros', async () => {
    mockFaseGetThrows = true;
    const r = await getOnboardingStatus('uid-abc');
    expect(r).toEqual({ fase_actual: 0, progreso_pct: 0, completado: false, gamification: null });
  });

  test('fase 2 incompleta => progreso=17', async () => {
    mockFaseDocs['fase1'] = { completado: true, respuestas: ['r1', 'r2', 'r3', 'r4', 'r5'] };
    mockFaseDocs['fase2'] = { completado: false, respuestas: ['material'] };
    const r = await getOnboardingStatus('uid-abc');
    expect(r.fase_actual).toBe(2);
    expect(r.progreso_pct).toBe(17);
  });
});

// ── startOnboarding ───────────────────────────────────────────────────────────
describe('startOnboarding', () => {
  test('uid falsy lanza uid_requerido', async () => {
    await expect(startOnboarding('')).rejects.toThrow('uid_requerido');
  });

  test('completado=true retorna {fase:6, completado:true}', async () => {
    allFasesCompletado(6);
    const r = await startOnboarding('uid-abc');
    expect(r.completado).toBe(true);
    expect(r.fase).toBe(6);
    expect(r.siguientePregunta).toBeNull();
  });

  test('fase 1 snap no existe: crea doc y retorna primera pregunta', async () => {
    mockFaseDocs = {};
    const r = await startOnboarding('uid-abc');
    expect(r.fase).toBe(1);
    expect(r.siguientePregunta).toBe(PREGUNTAS_FASE1[0]);
    expect(r.completado).toBe(false);
  });

  test('fase 1 snap existe con 0 respuestas => retorna pregunta[0]', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: [] };
    const r = await startOnboarding('uid-abc');
    expect(r.siguientePregunta).toBe(PREGUNTAS_FASE1[0]);
  });

  test('fase 1 snap existe con 2 respuestas => retorna pregunta[2]', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: ['r1', 'r2'] };
    const r = await startOnboarding('uid-abc');
    expect(r.siguientePregunta).toBe(PREGUNTAS_FASE1[2]);
  });

  test('fase 1 snap existe con respuestas sin array (no-array) => usa [] => pregunta[0]', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: null };
    const r = await startOnboarding('uid-abc');
    expect(r.siguientePregunta).toBe(PREGUNTAS_FASE1[0]);
  });

  test('idx >= PREGUNTAS => {siguientePregunta:null, completado:false}', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: ['r1', 'r2', 'r3', 'r4', 'r5'] };
    const r = await startOnboarding('uid-abc');
    expect(r.siguientePregunta).toBeNull();
    expect(r.completado).toBe(false);
  });

  test('fase_actual=2 (fase != 1) => {fase:2, siguientePregunta:null}', async () => {
    mockFaseDocs['fase1'] = { completado: true, respuestas: ['r1', 'r2', 'r3', 'r4', 'r5'] };
    const r = await startOnboarding('uid-abc');
    expect(r.fase).toBe(2);
    expect(r.siguientePregunta).toBeNull();
    expect(r.completado).toBe(false);
  });

  test('getOnboardingStatus error => fase_actual=0 => ||1 right arm => lanza al acceder fase', async () => {
    mockFaseGetThrows = true;
    await expect(startOnboarding('uid-abc')).rejects.toThrow('FASE-GET-FAIL');
  });
});

// ── processAnswer ─────────────────────────────────────────────────────────────
describe('processAnswer', () => {
  test('uid falsy lanza uid_requerido', async () => {
    await expect(processAnswer('', 1, 'r')).rejects.toThrow('uid_requerido');
  });

  test('fase no-entero (1.5) lanza fase_invalida', async () => {
    await expect(processAnswer('uid', 1.5, 'r')).rejects.toThrow('fase_invalida');
  });

  test('fase 0 lanza fase_invalida', async () => {
    await expect(processAnswer('uid', 0, 'r')).rejects.toThrow('fase_invalida');
  });

  test('fase 7 lanza fase_invalida', async () => {
    await expect(processAnswer('uid', 7, 'r')).rejects.toThrow('fase_invalida');
  });

  test('respuesta null (!respuesta) lanza respuesta_requerida', async () => {
    await expect(processAnswer('uid', 1, null)).rejects.toThrow('respuesta_requerida');
  });

  test('respuesta numero (typeof branch) lanza respuesta_requerida', async () => {
    await expect(processAnswer('uid', 1, 123)).rejects.toThrow('respuesta_requerida');
  });

  test('respuesta solo espacios (trim branch) lanza respuesta_requerida', async () => {
    await expect(processAnswer('uid', 1, '   ')).rejects.toThrow('respuesta_requerida');
  });

  test('fase 1 snap no existe: guarda primera respuesta, retorna siguiente pregunta', async () => {
    mockFaseDocs = {};
    const r = await processAnswer('uid', 1, 'Peluquería');
    expect(r.completado).toBe(false);
    expect(r.fase).toBe(1);
    expect(r.siguiente).toBe(PREGUNTAS_FASE1[1]);
    expect(mockFaseDocs['fase1'].respuestas).toEqual(['Peluquería']);
  });

  test('fase 1 snap no existe: respuestas sin field usa [] (Array.isArray false branch)', async () => {
    mockFaseDocs['fase1'] = { completado: false };
    const r = await processAnswer('uid', 1, 'Mi respuesta');
    expect(r.completado).toBe(false);
    expect(mockFaseDocs['fase1'].respuestas).toHaveLength(1);
  });

  test('fase 1 prevCompletadoAt existente preservado (left arm ||)', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: ['r1'], completadoAt: '2026-05-12T00:00:00Z' };
    const r = await processAnswer('uid', 1, 'r2');
    expect(r.completado).toBe(false);
    expect(mockFaseDocs['fase1'].completadoAt).toBe('2026-05-12T00:00:00Z');
  });

  test('fase 1 sin prevCompletadoAt => null (right arm ||)', async () => {
    mockFaseDocs = {};
    await processAnswer('uid', 1, 'primera');
    expect(mockFaseDocs['fase1'].completadoAt).toBeNull();
  });

  test('fase 1 quinta respuesta => completado=true, siguiente=null', async () => {
    mockFaseDocs['fase1'] = { completado: false, respuestas: ['r1', 'r2', 'r3', 'r4'] };
    const r = await processAnswer('uid', 1, 'r5');
    expect(r.completado).toBe(true);
    expect(r.siguiente).toBeNull();
    expect(mockFaseDocs['fase1'].completado).toBe(true);
    expect(mockFaseDocs['fase1'].completadoAt).toBeTruthy();
  });

  test('fase 5 score=9 => aprobado=true', async () => {
    const r = await processAnswer('uid', 5, '9');
    expect(r.completado).toBe(true);
    expect(mockFaseDocs['fase5'].aprobado).toBe(true);
    expect(mockFaseDocs['fase5'].score).toBe(9);
  });

  test('fase 5 score=7 => aprobado=false, no gamification', async () => {
    const r = await processAnswer('uid', 5, '7');
    expect(r.completado).toBe(true);
    expect(mockFaseDocs['fase5'].aprobado).toBe(false);
    expect(mockGamDoc).toBeNull();
  });

  test('fase 5 score no-numerico => score=0, aprobado=false', async () => {
    const r = await processAnswer('uid', 5, 'abc');
    expect(mockFaseDocs['fase5'].score).toBe(0);
    expect(mockFaseDocs['fase5'].aprobado).toBe(false);
  });

  test('fase 5 aprobado + gamDoc no existe => crea gamification desde cero (score||0 right arm)', async () => {
    mockGamDoc = null;
    await processAnswer('uid', 5, '9');
    expect(mockGamDoc).not.toBeNull();
    expect(mockGamDoc.nivel).toBe('Bronze');
    expect(mockGamDoc.score).toBe(90);
    expect(mockGamDoc.racha_dias).toBe(0);
    expect(mockGamDoc.logros).toContain('Bronze');
  });

  test('fase 5 aprobado + gamDoc existe con score y racha (score||0 left arm)', async () => {
    mockGamDoc = { nivel: null, score: 50, racha_dias: 3, logros: [] };
    await processAnswer('uid', 5, '9');
    expect(mockGamDoc.score).toBe(140);
    expect(mockGamDoc.racha_dias).toBe(3);
  });

  test('fase 5 aprobado + logros ya incluye Bronze => no duplica', async () => {
    mockGamDoc = { nivel: 'Bronze', score: 90, racha_dias: 0, logros: ['Bronze'] };
    await processAnswer('uid', 5, '9');
    expect(mockGamDoc.logros.filter(l => l === 'Bronze')).toHaveLength(1);
  });

  test('fase 5 aprobado + logros no-array => usa [] (Array.isArray false branch)', async () => {
    mockGamDoc = { nivel: null, score: 0, racha_dias: 0, logros: null };
    await processAnswer('uid', 5, '9');
    expect(mockGamDoc.logros).toContain('Bronze');
  });

  test('fase 5 aprobado + gamification throws => processAnswer no lanza', async () => {
    mockGamGetThrows = true;
    const r = await processAnswer('uid', 5, '9');
    expect(r.completado).toBe(true);
  });

  test('fase 2 snap no existe => guarda respuesta, completado=false', async () => {
    const r = await processAnswer('uid', 2, 'material de negocio');
    expect(r.completado).toBe(false);
    expect(r.fase).toBe(2);
    expect(mockFaseDocs['fase2'].respuestas).toContain('material de negocio');
  });

  test('fase 3 snap existe => acumula respuestas', async () => {
    mockFaseDocs['fase3'] = { respuestas: ['prev'], completado: false };
    const r = await processAnswer('uid', 3, 'nueva');
    expect(mockFaseDocs['fase3'].respuestas).toHaveLength(2);
    expect(r.completado).toBe(false);
  });

  test('fase 6 (aprendizaje pasivo) registra respuesta', async () => {
    const r = await processAnswer('uid', 6, 'aprendizaje');
    expect(r.fase).toBe(6);
    expect(mockFaseDocs['fase6'].respuestas).toContain('aprendizaje');
  });
});

// ── constantes exportadas ─────────────────────────────────────────────────────
describe('constantes exportadas', () => {
  test('FASES tiene los 6 valores correctos', () => {
    expect(FASES.DESCUBRIMIENTO).toBe(1);
    expect(FASES.CARGA_MATERIAL).toBe(2);
    expect(FASES.PREGUNTAS_ADAPTATIVAS).toBe(3);
    expect(FASES.DETECCION_GRISES).toBe(4);
    expect(FASES.CERTIFICACION).toBe(5);
    expect(FASES.APRENDIZAJE_PASIVO).toBe(6);
  });

  test('PREGUNTAS_FASE1 tiene exactamente 5 preguntas', () => {
    expect(PREGUNTAS_FASE1).toHaveLength(5);
    expect(PREGUNTAS_FASE1[0]).toContain('negocio');
    expect(PREGUNTAS_FASE1[4]).toContain('NUNCA');
  });

  test('NIVELES y thresholds de certificacion', () => {
    expect(NIVELES).toEqual(['Bronze', 'Silver', 'Gold', 'Diamond']);
    expect(CERTIFICATION_PASS_SCORE).toBe(8);
    expect(CERTIFICATION_TOTAL).toBe(10);
  });
});
