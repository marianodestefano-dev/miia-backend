'use strict';

const baseline = require('../core/mmc/baseline');
const {
  getOrCreateBaseline,
  getBaseline,
  updateBaseline,
  recordMessagesAnalyzed,
  setTonada,
  disableTonadaAdaptation,
  tryRetroactiveBootstrapComplete,
  TONADAS_SOPORTADAS,
  BOOTSTRAP_DAYS,
  BOOTSTRAP_MIN_MESSAGES,
  __setFirestoreForTests,
} = baseline;

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(initialData) {
  let docData = initialData; // null | object
  const captures = { sets: [] };
  const docRef = {
    get: jest.fn().mockImplementation(() => Promise.resolve({
      exists: docData !== null && docData !== undefined,
      data: () => docData || {},
    })),
    set: jest.fn().mockImplementation((payload, opts) => {
      captures.sets.push({ payload, merge: !!(opts && opts.merge) });
      if (opts && opts.merge) {
        docData = { ...(docData || {}), ...payload };
      } else {
        docData = payload;
      }
      return Promise.resolve({});
    }),
  };
  const docFn = jest.fn(() => docRef);
  const subcollFn = jest.fn(() => ({ doc: docFn }));
  const ownerDocFn = jest.fn(() => ({ collection: subcollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, docRef, captures, getDocData: () => docData };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── getOrCreateBaseline ───────────────────────────────────────────────────────

describe('getOrCreateBaseline', () => {
  test('uid null -> throw', async () => {
    await expect(getOrCreateBaseline(null)).rejects.toThrow('uid_requerido');
  });

  test('no existe -> crea con defaults', async () => {
    const { db, captures } = makeDb(null);
    __setFirestoreForTests(db);
    const r = await getOrCreateBaseline('uid123456789012345');
    expect(r.bootstrapComplete).toBe(false);
    expect(r.idiomaBase).toBe('es');
    expect(r.tonadaRegional).toBe('neutro');
    expect(r.adaptacionActiva).toBe(false);
    expect(captures.sets).toHaveLength(1);
  });

  test('existe -> retorna sin crear', async () => {
    const existing = { uid: 'uid1', tonadaRegional: 'argentina', bootstrapComplete: true };
    const { db, captures } = makeDb(existing);
    __setFirestoreForTests(db);
    const r = await getOrCreateBaseline('uid123456789012345');
    expect(r.tonadaRegional).toBe('argentina');
    expect(captures.sets).toHaveLength(0);
  });
});

// ── getBaseline ───────────────────────────────────────────────────────────────

describe('getBaseline', () => {
  test('uid null -> throw', async () => {
    await expect(getBaseline(null)).rejects.toThrow('uid_requerido');
  });

  test('no existe -> null', async () => {
    const { db } = makeDb(null);
    __setFirestoreForTests(db);
    expect(await getBaseline('uid123456789012345')).toBeNull();
  });

  test('existe -> retorna data', async () => {
    const { db } = makeDb({ uid: 'uid1', idiomaBase: 'es' });
    __setFirestoreForTests(db);
    const r = await getBaseline('uid123456789012345');
    expect(r.idiomaBase).toBe('es');
  });
});

// ── updateBaseline ────────────────────────────────────────────────────────────

describe('updateBaseline', () => {
  test('uid null -> throw', async () => {
    await expect(updateBaseline(null, {})).rejects.toThrow('uid_requerido');
  });
  test('updates null -> throw', async () => {
    await expect(updateBaseline('uid1', null)).rejects.toThrow('updates_invalido');
  });
  test('updates no objeto -> throw', async () => {
    await expect(updateBaseline('uid1', 'string')).rejects.toThrow('updates_invalido');
  });

  test('actualiza solo campos validos (tipos correctos)', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await updateBaseline('uid123456789012345', {
      intensidadLenguaje: 7,
      tonoPreferido: ['casual', 'directo'],
      idiomaBase: 'es',
      tonadaRegional: 'colombia',
      tonadaConfidence: 'high',
      adaptacionActiva: true,
      bootstrapComplete: true,
      mensajesAnalizados: 100,
      seededManually: true,
      tonadaDetectadaAt: '2026-05-12',
    });
    expect(r.ok).toBe(true);
    expect(captures.sets[0].payload.intensidadLenguaje).toBe(7);
    expect(captures.sets[0].payload.tonadaRegional).toBe('colombia');
    expect(captures.sets[0].payload.adaptacionActiva).toBe(true);
    expect(captures.sets[0].payload.updatedAt).toBeDefined();
  });

  test('ignora tipos invalidos', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateBaseline('uid123456789012345', {
      intensidadLenguaje: 'siete',
      tonoPreferido: 'no_array',
      idiomaBase: 123,
      tonadaRegional: 'imaginaria',
      tonadaConfidence: 'extrema',
      adaptacionActiva: 'yes',
      bootstrapComplete: 1,
      mensajesAnalizados: 'cien',
      seededManually: 'true',
    });
    const p = captures.sets[0].payload;
    expect(p.intensidadLenguaje).toBeUndefined();
    expect(p.tonoPreferido).toBeUndefined();
    expect(p.tonadaRegional).toBeUndefined();
    expect(p.tonadaConfidence).toBeUndefined();
    expect(p.adaptacionActiva).toBeUndefined();
  });

  test('actualiza horariosEnergia objeto', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateBaseline('uid123456789012345', {
      horariosEnergia: { madrugada: 1, manana: 5, tarde: 8, noche: 3 },
    });
    expect(captures.sets[0].payload.horariosEnergia.tarde).toBe(8);
  });

  test('horariosEnergia no objeto -> ignorado', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateBaseline('uid123456789012345', { horariosEnergia: 'string' });
    expect(captures.sets[0].payload.horariosEnergia).toBeUndefined();
  });

  test('palabrasConfianza array OK', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateBaseline('uid123456789012345', { palabrasConfianza: ['posta', 'dale', 'bondi'] });
    expect(captures.sets[0].payload.palabrasConfianza).toEqual(['posta', 'dale', 'bondi']);
  });

  test('frecuenciaDisculpa, latenciaMediaRespuesta, duracionSesionTipica numbers', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await updateBaseline('uid123456789012345', {
      frecuenciaDisculpa: 2.5,
      latenciaMediaRespuesta: 45,
      duracionSesionTipica: 12,
      toleranciaBully: 3,
    });
    const p = captures.sets[0].payload;
    expect(p.frecuenciaDisculpa).toBe(2.5);
    expect(p.latenciaMediaRespuesta).toBe(45);
    expect(p.duracionSesionTipica).toBe(12);
    expect(p.toleranciaBully).toBe(3);
  });
});

// ── recordMessagesAnalyzed ────────────────────────────────────────────────────

describe('recordMessagesAnalyzed', () => {
  test('uid null -> throw', async () => {
    await expect(recordMessagesAnalyzed(null, 5)).rejects.toThrow('uid_requerido');
  });
  test('delta no number -> throw', async () => {
    await expect(recordMessagesAnalyzed('uid1', 'cinco')).rejects.toThrow('delta_invalido');
  });
  test('delta negativo -> throw', async () => {
    await expect(recordMessagesAnalyzed('uid1', -1)).rejects.toThrow('delta_invalido');
  });

  test('primer registro - bootstrap incompleto, suma simple', async () => {
    const { db } = makeDb(null);
    __setFirestoreForTests(db);
    const r = await recordMessagesAnalyzed('uid123456789012345', 10);
    expect(r.mensajesAnalizados).toBe(10);
    expect(r.bootstrapComplete).toBe(false);
    expect(r.justCompleted).toBe(false);
  });

  test('suma alcanza BOOTSTRAP_MIN_MESSAGES -> completa', async () => {
    const { db } = makeDb({
      mensajesAnalizados: 49,
      bootstrapStartedAt: new Date().toISOString(),
      bootstrapComplete: false,
    });
    __setFirestoreForTests(db);
    const r = await recordMessagesAnalyzed('uid123456789012345', 1);
    expect(r.mensajesAnalizados).toBe(BOOTSTRAP_MIN_MESSAGES);
    expect(r.bootstrapComplete).toBe(true);
    expect(r.justCompleted).toBe(true);
  });

  test('bootstrapStartedAt > 14d atras -> completa por dias', async () => {
    const old = new Date(Date.now() - (BOOTSTRAP_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const { db } = makeDb({
      mensajesAnalizados: 5,
      bootstrapStartedAt: old,
      bootstrapComplete: false,
    });
    __setFirestoreForTests(db);
    const r = await recordMessagesAnalyzed('uid123456789012345', 1);
    expect(r.bootstrapComplete).toBe(true);
    expect(r.justCompleted).toBe(true);
  });

  test('ya estaba complete -> no justCompleted', async () => {
    const { db } = makeDb({
      mensajesAnalizados: 100,
      bootstrapStartedAt: new Date().toISOString(),
      bootstrapComplete: true,
    });
    __setFirestoreForTests(db);
    const r = await recordMessagesAnalyzed('uid123456789012345', 5);
    expect(r.bootstrapComplete).toBe(true);
    expect(r.justCompleted).toBe(false);
  });

  test('baseline sin bootstrapStartedAt -> usa now como fallback', async () => {
    const { db } = makeDb({ mensajesAnalizados: 5, bootstrapComplete: false });
    __setFirestoreForTests(db);
    const r = await recordMessagesAnalyzed('uid123456789012345', 1);
    expect(r.bootstrapComplete).toBe(false);
  });
});

// ── setTonada ─────────────────────────────────────────────────────────────────

describe('setTonada', () => {
  test('uid null -> throw', async () => {
    await expect(setTonada(null, 'argentina', 'medium')).rejects.toThrow('uid_requerido');
  });
  test('tonada invalida -> throw', async () => {
    await expect(setTonada('uid1', 'imaginaria', 'medium')).rejects.toThrow('tonada_invalida');
  });
  test('confidence invalida -> throw', async () => {
    await expect(setTonada('uid1', 'argentina', 'extrema')).rejects.toThrow('confidence_invalida');
  });

  test('bootstrap incompleto + tonada=argentina + conf=high -> adaptacionActiva=false', async () => {
    const { db } = makeDb({ bootstrapComplete: false });
    __setFirestoreForTests(db);
    const r = await setTonada('uid123456789012345', 'argentina', 'high');
    expect(r.adaptacionActiva).toBe(false);
  });

  test('bootstrap completo + tonada=argentina + conf=high -> adaptacionActiva=true', async () => {
    const { db } = makeDb({ bootstrapComplete: true });
    __setFirestoreForTests(db);
    const r = await setTonada('uid123456789012345', 'argentina', 'high');
    expect(r.adaptacionActiva).toBe(true);
  });

  test('bootstrap completo + tonada=argentina + conf=low -> adaptacionActiva=false', async () => {
    const { db } = makeDb({ bootstrapComplete: true });
    __setFirestoreForTests(db);
    const r = await setTonada('uid123456789012345', 'argentina', 'low');
    expect(r.adaptacionActiva).toBe(false);
  });

  test('bootstrap completo + tonada=neutro + conf=high -> adaptacionActiva=false', async () => {
    const { db } = makeDb({ bootstrapComplete: true });
    __setFirestoreForTests(db);
    const r = await setTonada('uid123456789012345', 'neutro', 'high');
    expect(r.adaptacionActiva).toBe(false);
  });

  test('bootstrap completo + tonada=colombia + conf=medium -> adaptacionActiva=true', async () => {
    const { db } = makeDb({ bootstrapComplete: true });
    __setFirestoreForTests(db);
    const r = await setTonada('uid123456789012345', 'colombia', 'medium');
    expect(r.adaptacionActiva).toBe(true);
  });
});

// ── disableTonadaAdaptation ───────────────────────────────────────────────────

describe('disableTonadaAdaptation', () => {
  test('uid null -> throw', async () => {
    await expect(disableTonadaAdaptation(null)).rejects.toThrow('uid_requerido');
  });

  test('OK', async () => {
    const { db, captures } = makeDb({ tonadaRegional: 'argentina', adaptacionActiva: true });
    __setFirestoreForTests(db);
    const r = await disableTonadaAdaptation('uid123456789012345');
    expect(r.ok).toBe(true);
    expect(captures.sets[0].payload.adaptacionActiva).toBe(false);
    expect(captures.sets[0].payload.tonadaRegional).toBe('neutro');
  });
});

// ── tryRetroactiveBootstrapComplete ───────────────────────────────────────────

describe('tryRetroactiveBootstrapComplete', () => {
  test('uid null -> throw', async () => {
    await expect(tryRetroactiveBootstrapComplete(null)).rejects.toThrow('uid_requerido');
  });

  test('baseline inexistente -> applied=false', async () => {
    const { db } = makeDb(null);
    __setFirestoreForTests(db);
    const r = await tryRetroactiveBootstrapComplete('uid123456789012345');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('baseline_inexistente');
  });

  test('ya complete -> applied=false reason=ya_complete', async () => {
    const { db } = makeDb({ bootstrapComplete: true, mensajesAnalizados: 100 });
    __setFirestoreForTests(db);
    const r = await tryRetroactiveBootstrapComplete('uid123456789012345');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('ya_complete');
  });

  test('mensajes insuficientes -> applied=false', async () => {
    const { db } = makeDb({ bootstrapComplete: false, mensajesAnalizados: 10 });
    __setFirestoreForTests(db);
    const r = await tryRetroactiveBootstrapComplete('uid123456789012345');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('insuficientes_mensajes');
  });

  test('mensajesAnalizados undefined -> usa 0 (rama falsy), applied=false', async () => {
    const { db } = makeDb({ bootstrapComplete: false });
    __setFirestoreForTests(db);
    const r = await tryRetroactiveBootstrapComplete('uid123456789012345');
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('insuficientes_mensajes');
  });

  test('mensajes >= 50 y no complete -> applied=true', async () => {
    const { db } = makeDb({ bootstrapComplete: false, mensajesAnalizados: 50 });
    __setFirestoreForTests(db);
    const r = await tryRetroactiveBootstrapComplete('uid123456789012345');
    expect(r.applied).toBe(true);
  });
});

// ── Constantes exportadas ─────────────────────────────────────────────────────

describe('Constantes', () => {
  test('TONADAS_SOPORTADAS', () => {
    expect(TONADAS_SOPORTADAS).toEqual(['neutro', 'argentina', 'colombia', 'mexico']);
  });
  test('BOOTSTRAP_DAYS = 14', () => {
    expect(BOOTSTRAP_DAYS).toBe(14);
  });
  test('BOOTSTRAP_MIN_MESSAGES = 50', () => {
    expect(BOOTSTRAP_MIN_MESSAGES).toBe(50);
  });
});
