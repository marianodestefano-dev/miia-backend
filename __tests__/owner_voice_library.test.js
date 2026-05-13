'use strict';

const {
  listAvailableContexts,
  registerAudio,
  getAudiosForOwner,
  getAudioForContext,
  deactivateAudio,
  shouldSendAudio,
  CONTEXTS,
  VALID_CONTEXTS,
  MAX_DURATION_SEC,
  MAX_TRANSCRIPT_CHARS,
  __setFirestoreForTests,
} = require('../core/owner_voice_library');

// ── Mock ──────────────────────────────────────────────────────────────────────

function makeDb(opts) {
  const o = opts || {};
  const audios = o.audios || {};
  const captures = { sets: [] };

  const docFn = jest.fn((context) => ({
    get: jest.fn().mockResolvedValue({
      exists: !!audios[context],
      data: () => audios[context] || {},
    }),
    set: jest.fn((payload, mergeOpts) => {
      captures.sets.push({ context, payload, merge: mergeOpts });
      if (mergeOpts && mergeOpts.merge) {
        audios[context] = { ...(audios[context] || {}), ...payload };
      } else {
        audios[context] = payload;
      }
      return Promise.resolve({});
    }),
  }));

  const colObj = {
    doc: docFn,
    get: jest.fn().mockResolvedValue({
      docs: Object.entries(audios).map(function ([ctx, data]) {
        return { id: ctx, data: () => data };
      }),
    }),
  };

  const subCollFn = jest.fn(() => colObj);
  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  const db = { collection: jest.fn(() => ({ doc: ownerDocFn })) };
  return { db, captures };
}

beforeEach(() => {
  __setFirestoreForTests(null);
});

// ── listAvailableContexts ─────────────────────────────────────────────────────

describe('listAvailableContexts', () => {
  test('retorna los 4 contextos predefinidos del spec', () => {
    const ctxs = listAvailableContexts();
    expect(ctxs).toHaveLength(4);
    const keys = ctxs.map(function (c) { return c.key; });
    expect(keys).toContain(CONTEXTS.SALUDO_INICIAL);
    expect(keys).toContain(CONTEXTS.ESTOY_MANEJANDO);
    expect(keys).toContain(CONTEXTS.EXPLICACION_PLAN_BASICO);
    expect(keys).toContain(CONTEXTS.AGRADECIMIENTO_POST_CIERRE);
  });

  test('cada contexto tiene label y suggestedScript', () => {
    const ctxs = listAvailableContexts();
    for (const c of ctxs) {
      expect(typeof c.label).toBe('string');
      expect(typeof c.suggestedScript).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});

// ── registerAudio ─────────────────────────────────────────────────────────────

describe('registerAudio', () => {
  test('uid null -> throw', async () => {
    await expect(registerAudio(null, CONTEXTS.SALUDO_INICIAL, 'url', 't', 5)).rejects.toThrow('uid_requerido');
  });
  test('context invalido -> throw', async () => {
    await expect(registerAudio('u1', 'foo', 'url', 't', 5)).rejects.toThrow('context_invalido');
  });
  test('fileUrl null -> throw', async () => {
    await expect(registerAudio('u1', CONTEXTS.SALUDO_INICIAL, null, 't', 5)).rejects.toThrow('fileUrl_requerido');
  });
  test('fileUrl no string -> throw', async () => {
    await expect(registerAudio('u1', CONTEXTS.SALUDO_INICIAL, 123, 't', 5)).rejects.toThrow('fileUrl_requerido');
  });
  test('durationSec no number -> throw', async () => {
    await expect(registerAudio('u1', CONTEXTS.SALUDO_INICIAL, 'url', 't', 'cinco')).rejects.toThrow('durationSec_invalido');
  });
  test('durationSec 0 -> throw', async () => {
    await expect(registerAudio('u1', CONTEXTS.SALUDO_INICIAL, 'url', 't', 0)).rejects.toThrow('durationSec_invalido');
  });
  test('durationSec excede MAX -> throw', async () => {
    await expect(registerAudio('u1', CONTEXTS.SALUDO_INICIAL, 'url', 't', MAX_DURATION_SEC + 1))
      .rejects.toThrow('duracion_excede_max');
  });

  test('OK - registra con transcript', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const r = await registerAudio('uid12345', CONTEXTS.SALUDO_INICIAL, 'https://storage/a.mp3', 'Hola soy Mariano', 8);
    expect(r.ok).toBe(true);
    expect(r.active).toBe(true);
    expect(captures.sets[0].payload.transcript).toBe('Hola soy Mariano');
    expect(captures.sets[0].payload.durationSec).toBe(8);
  });

  test('transcript no string -> ""', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await registerAudio('uid12345', CONTEXTS.SALUDO_INICIAL, 'url', 123, 5);
    expect(captures.sets[0].payload.transcript).toBe('');
  });

  test('transcript largo -> truncado a MAX_TRANSCRIPT_CHARS', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    const long = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 100);
    await registerAudio('uid12345', CONTEXTS.SALUDO_INICIAL, 'url', long, 5);
    expect(captures.sets[0].payload.transcript.length).toBe(MAX_TRANSCRIPT_CHARS);
  });

  test('transcript con whitespace -> trim', async () => {
    const { db, captures } = makeDb({});
    __setFirestoreForTests(db);
    await registerAudio('uid12345', CONTEXTS.SALUDO_INICIAL, 'url', '   hola   ', 5);
    expect(captures.sets[0].payload.transcript).toBe('hola');
  });
});

// ── getAudiosForOwner ─────────────────────────────────────────────────────────

describe('getAudiosForOwner', () => {
  test('uid null -> throw', async () => {
    await expect(getAudiosForOwner(null)).rejects.toThrow('uid_requerido');
  });

  test('sin audios -> []', async () => {
    const { db } = makeDb({ audios: {} });
    __setFirestoreForTests(db);
    expect(await getAudiosForOwner('uid12345')).toEqual([]);
  });

  test('filtra audios inactivos', async () => {
    const { db } = makeDb({
      audios: {
        saludo_inicial_calido: { context: 'saludo_inicial_calido', fileUrl: 'a', active: true },
        estoy_manejando: { context: 'estoy_manejando', fileUrl: 'b', active: false },
      },
    });
    __setFirestoreForTests(db);
    const r = await getAudiosForOwner('uid12345');
    expect(r).toHaveLength(1);
    expect(r[0].context).toBe('saludo_inicial_calido');
  });

  test('audios sin active explicito -> incluidos (active!==false)', async () => {
    const { db } = makeDb({
      audios: { saludo_inicial_calido: { context: 'saludo_inicial_calido' } },
    });
    __setFirestoreForTests(db);
    const r = await getAudiosForOwner('uid12345');
    expect(r).toHaveLength(1);
  });

  test('snap.docs undefined -> []', async () => {
    const customDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(),
            get: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
    };
    __setFirestoreForTests(customDb);
    expect(await getAudiosForOwner('uid12345')).toEqual([]);
  });
});

// ── getAudioForContext ────────────────────────────────────────────────────────

describe('getAudioForContext', () => {
  test('uid null -> throw', async () => {
    await expect(getAudioForContext(null, CONTEXTS.SALUDO_INICIAL)).rejects.toThrow('uid_requerido');
  });
  test('context invalido -> throw', async () => {
    await expect(getAudioForContext('u1', 'foo')).rejects.toThrow('context_invalido');
  });

  test('audio no existe -> null', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    expect(await getAudioForContext('uid12345', CONTEXTS.SALUDO_INICIAL)).toBeNull();
  });

  test('audio existe activo -> retorna', async () => {
    const { db } = makeDb({
      audios: { saludo_inicial_calido: { fileUrl: 'a', active: true } },
    });
    __setFirestoreForTests(db);
    const r = await getAudioForContext('uid12345', CONTEXTS.SALUDO_INICIAL);
    expect(r.fileUrl).toBe('a');
  });

  test('audio existe inactivo -> null', async () => {
    const { db } = makeDb({
      audios: { saludo_inicial_calido: { fileUrl: 'a', active: false } },
    });
    __setFirestoreForTests(db);
    expect(await getAudioForContext('uid12345', CONTEXTS.SALUDO_INICIAL)).toBeNull();
  });
});

// ── deactivateAudio ───────────────────────────────────────────────────────────

describe('deactivateAudio', () => {
  test('uid null -> throw', async () => {
    await expect(deactivateAudio(null, CONTEXTS.SALUDO_INICIAL)).rejects.toThrow('uid_requerido');
  });
  test('context invalido -> throw', async () => {
    await expect(deactivateAudio('u1', 'foo')).rejects.toThrow('context_invalido');
  });

  test('OK soft-delete', async () => {
    const { db, captures } = makeDb({
      audios: { saludo_inicial_calido: { fileUrl: 'a', active: true } },
    });
    __setFirestoreForTests(db);
    const r = await deactivateAudio('uid12345', CONTEXTS.SALUDO_INICIAL);
    expect(r.ok).toBe(true);
    expect(captures.sets[0].payload.active).toBe(false);
    expect(captures.sets[0].payload.deactivatedAt).toBeDefined();
  });
});

// ── shouldSendAudio ───────────────────────────────────────────────────────────

describe('shouldSendAudio', () => {
  test('uid null -> false', async () => {
    const r = await shouldSendAudio(null, CONTEXTS.SALUDO_INICIAL, true);
    expect(r.shouldSend).toBe(false);
    expect(r.audio).toBeNull();
  });

  test('context invalido -> false', async () => {
    const r = await shouldSendAudio('u1', 'foo', true);
    expect(r.shouldSend).toBe(false);
  });

  test('leadIsNew=false -> NO enviar (ya conoce al owner)', async () => {
    const { db } = makeDb({
      audios: { saludo_inicial_calido: { fileUrl: 'a', active: true } },
    });
    __setFirestoreForTests(db);
    const r = await shouldSendAudio('uid12345', CONTEXTS.SALUDO_INICIAL, false);
    expect(r.shouldSend).toBe(false);
  });

  test('audio no registrado -> NO enviar', async () => {
    const { db } = makeDb({});
    __setFirestoreForTests(db);
    const r = await shouldSendAudio('uid12345', CONTEXTS.SALUDO_INICIAL, true);
    expect(r.shouldSend).toBe(false);
    expect(r.audio).toBeNull();
  });

  test('lead nuevo + audio registrado -> SI enviar', async () => {
    const { db } = makeDb({
      audios: { saludo_inicial_calido: { fileUrl: 'https://s/a.mp3', active: true, durationSec: 8 } },
    });
    __setFirestoreForTests(db);
    const r = await shouldSendAudio('uid12345', CONTEXTS.SALUDO_INICIAL, true);
    expect(r.shouldSend).toBe(true);
    expect(r.audio.fileUrl).toBe('https://s/a.mp3');
  });
});

// ── Constantes ────────────────────────────────────────────────────────────────

describe('Constantes', () => {
  test('VALID_CONTEXTS tiene 4 entries', () => {
    expect(VALID_CONTEXTS).toHaveLength(4);
  });
  test('MAX_DURATION_SEC = 60', () => {
    expect(MAX_DURATION_SEC).toBe(60);
  });
  test('MAX_TRANSCRIPT_CHARS = 500', () => {
    expect(MAX_TRANSCRIPT_CHARS).toBe(500);
  });
});
