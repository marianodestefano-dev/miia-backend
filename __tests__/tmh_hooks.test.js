'use strict';

const tmhHooks = require('../core/tmh_hooks');
const forgetPipeline = require('../core/mmc/forget_pipeline');
const ownerVoiceLib = require('../core/owner_voice_library');
const embeddingRetrieval = require('../core/mmc/embedding_retrieval');

const MIIA_CENTER = tmhHooks.MIIA_CENTER_UID;
const OTHER_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3'; // Personal

function makeFirestoreDualMock(ownerVoiceData, forgetEpisodes) {
  // Para owner_voice_library: owners/{uid}/voice_audios/{context}
  // Para forget_pipeline: users/{uid}/miia_memory/...
  const _episodes = forgetEpisodes || [];
  const docFactory = (collectionName, parentDoc, subColl) => {
    return {
      get: jest.fn().mockResolvedValue({
        exists: false,
        data: () => ({}),
      }),
      set: jest.fn().mockResolvedValue({}),
    };
  };

  // owners/{uid}/voice_audios/{context}
  const ownerVoiceDocs = ownerVoiceData || {};
  const voiceDocFn = jest.fn((context) => ({
    get: jest.fn().mockResolvedValue({
      exists: !!ownerVoiceDocs[context],
      data: () => ownerVoiceDocs[context] || {},
    }),
    set: jest.fn().mockResolvedValue({}),
  }));

  // users/{uid}/miia_memory/...
  function makeQuery() {
    return {
      where: jest.fn(function () { return this; }),
      get: jest.fn().mockResolvedValue({
        docs: _episodes.filter(e => e.contradicted === false && e.deletedByOwnerAt === null)
          .map(e => ({
            id: e.episodeId,
            ref: { set: jest.fn().mockResolvedValue({}) },
            data: () => e,
          })),
      }),
    };
  }

  const memoryCol = Object.assign({
    doc: jest.fn(() => ({
      get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      set: jest.fn().mockResolvedValue({}),
    })),
  }, makeQuery());

  const subCollFn = jest.fn((name) => {
    if (name === 'voice_audios') return { doc: voiceDocFn };
    if (name === 'miia_memory') return memoryCol;
    return { doc: jest.fn() };
  });

  const ownerDocFn = jest.fn(() => ({ collection: subCollFn }));
  return { collection: jest.fn(() => ({ doc: ownerDocFn })) };
}

beforeEach(() => {
  delete process.env.TMH_HOOKS_ALL_UIDS;
  ownerVoiceLib.__setFirestoreForTests(null);
  forgetPipeline.__setFirestoreForTests(null);
  embeddingRetrieval.__setFirestoreForTests(null);
  embeddingRetrieval.__setEmbedForTests(null);
});

// ── _isEligibleUid ──────────────────────────────────────────────────────────

describe('_isEligibleUidForTests', () => {
  test('uid null -> false', () => {
    expect(tmhHooks._isEligibleUidForTests(null)).toBe(false);
  });
  test('MIIA CENTER UID -> true', () => {
    expect(tmhHooks._isEligibleUidForTests(MIIA_CENTER)).toBe(true);
  });
  test('Personal UID -> false (ETAPA 1)', () => {
    expect(tmhHooks._isEligibleUidForTests(OTHER_UID)).toBe(false);
  });
  test('TMH_HOOKS_ALL_UIDS=true -> habilita cualquier uid', () => {
    process.env.TMH_HOOKS_ALL_UIDS = 'true';
    expect(tmhHooks._isEligibleUidForTests(OTHER_UID)).toBe(true);
    delete process.env.TMH_HOOKS_ALL_UIDS;
  });
});

// ── maybeSendOwnerVoice ─────────────────────────────────────────────────────

describe('maybeSendOwnerVoice', () => {
  test('uid no elegible -> shouldSend=false', async () => {
    const r = await tmhHooks.maybeSendOwnerVoice(OTHER_UID, 'saludo_inicial_calido', true);
    expect(r.shouldSend).toBe(false);
  });

  test('uid MIIA CENTER + audio existente + leadIsNew -> shouldSend=true', async () => {
    ownerVoiceLib.__setFirestoreForTests(makeFirestoreDualMock({
      saludo_inicial_calido: { fileUrl: 'https://s/a.mp3', active: true, durationSec: 10 },
    }, []));
    const r = await tmhHooks.maybeSendOwnerVoice(MIIA_CENTER, 'saludo_inicial_calido', true);
    expect(r.shouldSend).toBe(true);
    expect(r.audio.fileUrl).toBe('https://s/a.mp3');
  });

  test('uid MIIA CENTER + lead NO nuevo -> shouldSend=false', async () => {
    ownerVoiceLib.__setFirestoreForTests(makeFirestoreDualMock({
      saludo_inicial_calido: { fileUrl: 'a', active: true, durationSec: 5 },
    }, []));
    const r = await tmhHooks.maybeSendOwnerVoice(MIIA_CENTER, 'saludo_inicial_calido', false);
    expect(r.shouldSend).toBe(false);
  });

  test('context invalido -> shouldSend=false', async () => {
    ownerVoiceLib.__setFirestoreForTests(makeFirestoreDualMock({}, []));
    const r = await tmhHooks.maybeSendOwnerVoice(MIIA_CENTER, 'context_imaginario', true);
    expect(r.shouldSend).toBe(false);
  });
});

// ── maybeHandleForget ───────────────────────────────────────────────────────

describe('maybeHandleForget', () => {
  test('uid no elegible -> handled=false', async () => {
    const r = await tmhHooks.maybeHandleForget(OTHER_UID, 'MIIA olvidate eso');
    expect(r.handled).toBe(false);
  });

  test('ownerMessage null -> handled=false', async () => {
    const r = await tmhHooks.maybeHandleForget(MIIA_CENTER, null);
    expect(r.handled).toBe(false);
  });

  test('ownerMessage no string -> handled=false', async () => {
    const r = await tmhHooks.maybeHandleForget(MIIA_CENTER, 123);
    expect(r.handled).toBe(false);
  });

  test('mensaje sin forget pattern -> handled=false', async () => {
    const r = await tmhHooks.maybeHandleForget(MIIA_CENTER, 'hola que tal');
    expect(r.handled).toBe(false);
  });

  test('forget pattern + sin episodios match -> handled=true con summary 0/0', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    forgetPipeline.__setFirestoreForTests(makeFirestoreDualMock({}, []));
    const r = await tmhHooks.maybeHandleForget(MIIA_CENTER, 'MIIA olvidate eso');
    expect(r.handled).toBe(true);
    expect(r.summary.episodiosBorrados).toBe(0);
    expect(r.summary.lessonsBorradas).toBe(0);
    expect(r.injectionText).toContain('FORGET-NOOP');
  });

  test('forget pattern + embedding null -> handled=true con noEmbedding', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => null);
    forgetPipeline.__setFirestoreForTests(makeFirestoreDualMock({}, []));
    const r = await tmhHooks.maybeHandleForget(MIIA_CENTER, 'borra eso por favor');
    expect(r.handled).toBe(true);
    expect(r.summary.noEmbedding).toBe(true);
  });

  test('forget pattern + episodio match -> handled=true con borrados>0', async () => {
    embeddingRetrieval.__setEmbedForTests(async () => [1, 0, 0]);
    forgetPipeline.__setFirestoreForTests(makeFirestoreDualMock({}, [
      {
        episodeId: 'e1',
        contradicted: false, deletedByOwnerAt: null,
        vector: [1, 0, 0],
        lecciones: [{ id: 'l1', text: 'X' }],
      },
    ]));
    const r = await tmhHooks.maybeHandleForget(MIIA_CENTER, 'olvidate lo que dije');
    expect(r.handled).toBe(true);
    expect(r.summary.episodiosBorrados).toBe(1);
    expect(r.injectionText).toContain('FORGET-DONE');
  });
});
