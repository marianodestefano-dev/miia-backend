'use strict';

/**
 * VI-BACKEND-COVERAGE: core/feature_announcer.js — 100% branches
 */

const fa = require('../core/feature_announcer');

// ── Helpers para mock Firestore ───────────────────────────────

function makeAdmin({ version = null, brainContent = null, brainExists = false } = {}) {
  const metaRef = {
    get: jest.fn().mockResolvedValue({
      exists: version !== null,
      data: () => ({ version }),
    }),
    set: jest.fn().mockResolvedValue({}),
  };
  const brainRef = {
    get: jest.fn().mockResolvedValue({
      exists: brainExists,
      data: () => ({ content: brainContent }),
    }),
    set: jest.fn().mockResolvedValue({}),
  };
  return {
    firestore: () => ({
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockImplementation((docId) => {
              if (docId === 'feature_version') return metaRef;
              return brainRef;
            }),
          }),
        }),
      }),
    }),
  };
}

// ── isCapabilitiesQuery ───────────────────────────────────────
describe('isCapabilitiesQuery', () => {
  test('null → false (branch !message)', () => {
    expect(fa.isCapabilitiesQuery(null)).toBe(false);
    expect(fa.isCapabilitiesQuery('')).toBe(false);
  });

  test('"que podes hacer" → true', () => {
    expect(fa.isCapabilitiesQuery('que podes hacer?')).toBe(true);
  });

  test('"ayuda" → true', () => {
    expect(fa.isCapabilitiesQuery('ayuda')).toBe(true);
  });

  test('"tus funciones" → true', () => {
    expect(fa.isCapabilitiesQuery('tus funciones')).toBe(true);
  });

  test('texto random → false', () => {
    expect(fa.isCapabilitiesQuery('hola como estas hoy')).toBe(false);
  });
});

// ── isCategoryDetailQuery ─────────────────────────────────────
describe('isCategoryDetailQuery', () => {
  test('null → false (branch !message)', () => {
    expect(fa.isCategoryDetailQuery(null)).toBe(false);
    expect(fa.isCategoryDetailQuery('')).toBe(false);
  });

  test('"contame de agenda" → true (regex 1)', () => {
    expect(fa.isCategoryDetailQuery('contame de agenda')).toBe(true);
  });

  test('"detalle de seguridad" → true (regex 1)', () => {
    expect(fa.isCategoryDetailQuery('detalle de seguridad')).toBe(true);
  });

  test('"2" → true (regex number)', () => {
    expect(fa.isCategoryDetailQuery('2')).toBe(true);
  });

  test('texto random → false', () => {
    expect(fa.isCategoryDetailQuery('hola')).toBe(false);
  });
});

// ── buildCapabilitiesMessage ──────────────────────────────────
describe('buildCapabilitiesMessage', () => {
  test('returns string with all categories', () => {
    const msg = fa.buildCapabilitiesMessage();
    expect(typeof msg).toBe('string');
    expect(msg).toContain('Todo lo que puedo hacer');
    expect(msg).toContain(fa.CURRENT_VERSION);
  });
});

// ── buildCapabilitiesSummary ──────────────────────────────────
describe('buildCapabilitiesSummary', () => {
  test('returns string with numbered areas', () => {
    const msg = fa.buildCapabilitiesSummary();
    expect(typeof msg).toBe('string');
    expect(msg).toContain('1.');
    expect(msg).toContain('trabajo');
  });
});

// ── buildCategoryDetail ───────────────────────────────────────
describe('buildCategoryDetail', () => {
  test('null → null (branch !query)', () => {
    expect(fa.buildCategoryDetail(null)).toBeNull();
    expect(fa.buildCategoryDetail('')).toBeNull();
  });

  test('numero valido → devuelve detalle de categoria (branch numMatch + valid idx)', () => {
    const r = fa.buildCategoryDetail('1');
    expect(r).not.toBeNull();
    expect(typeof r).toBe('string');
  });

  test('numero invalido (>length) → null (branch valid idx false)', () => {
    const r = fa.buildCategoryDetail('999');
    expect(r).toBeNull();
  });

  test('nombre de categoria → devuelve detalle (branch name match found)', () => {
    const r = fa.buildCategoryDetail('productividad');
    expect(r).not.toBeNull();
  });

  test('nombre no existente → null (branch name match not found)', () => {
    const r = fa.buildCategoryDetail('zzz-no-existe');
    expect(r).toBeNull();
  });
});

// ── getVersion ────────────────────────────────────────────────
describe('getVersion', () => {
  test('returns CURRENT_VERSION', () => {
    expect(fa.getVersion()).toBe(fa.CURRENT_VERSION);
  });
});

// ── init ─────────────────────────────────────────────────────
describe('init', () => {
  test('sin opciones → no error', () => {
    expect(() => fa.init({})).not.toThrow();
  });

  test('con todas las opciones', () => {
    expect(() => fa.init({}, {
      ttsEngine: {},
      safeSendMessage: jest.fn(),
      generateAI: jest.fn(),
    })).not.toThrow();
  });
});

// ── checkAndAnnounce ──────────────────────────────────────────
describe('checkAndAnnounce — branches', () => {

  test('!uid → return inmediato (branch !uid)', async () => {
    const sendFn = jest.fn();
    fa.init(makeAdmin());
    await fa.checkAndAnnounce('', sendFn, null);
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('!_admin → return inmediato (branch !_admin)', async () => {
    const sendFn = jest.fn();
    fa.init(null); // _admin = null
    await fa.checkAndAnnounce('uid-no-admin', sendFn, null);
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('ya anunciado → return inmediato (branch _announcedUids.has)', async () => {
    const uid = 'uid-already-announced-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null }); // new version to announce
    fa.init(admin);
    // Primera llamada → anuncia
    await fa.checkAndAnnounce(uid, sendFn, null);
    sendFn.mockClear();
    // Segunda llamada → ya anunciado → return
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('version ya vista → return sin anuncio (branch lastSeenVersion === CURRENT_VERSION)', async () => {
    const uid = 'uid-version-seen-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: fa.CURRENT_VERSION }); // ya vio esta version
    fa.init(admin);
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('version nueva + sin IA → usa template fallback (branch !_generateAI + !msg)', async () => {
    const uid = 'uid-template-fallback-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: 'old-version', brainExists: true, brainContent: 'brain content' });
    fa.init(admin, {}); // sin generateAI
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).toHaveBeenCalled();
    const msg = sendFn.mock.calls[0][0];
    expect(msg).toContain('Tengo novedades');
  });

  test('version nueva + IA OK (msg > 30) → usa mensaje IA (branch aiMsg truthy)', async () => {
    const uid = 'uid-ai-ok-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null, brainExists: false });
    const generateAI = jest.fn().mockResolvedValue('Este es un mensaje largo generado por IA con mas de treinta caracteres');
    fa.init(admin, { generateAI });
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).toHaveBeenCalled();
    expect(sendFn.mock.calls[0][0]).toContain('Este es un mensaje largo');
  });

  test('version nueva + IA retorna string corto (<31) → fallback template (branch aiMsg.trim().length > 30 false)', async () => {
    const uid = 'uid-ai-short-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null, brainExists: false });
    const generateAI = jest.fn().mockResolvedValue('corto');
    fa.init(admin, { generateAI });
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).toHaveBeenCalled();
    expect(sendFn.mock.calls[0][0]).toContain('Tengo novedades');
  });

  test('IA lanza error → catch + fallback template (branch try/catch aiErr)', async () => {
    const uid = 'uid-ai-error-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null, brainExists: false });
    const generateAI = jest.fn().mockRejectedValue(new Error('AI timeout'));
    fa.init(admin, { generateAI });
    await expect(fa.checkAndAnnounce(uid, sendFn, null)).resolves.not.toThrow();
    expect(sendFn).toHaveBeenCalled(); // fallback template
  });

  test('TTS disponible + OK → sentAsAudio=true (branch _ttsEngine truthy)', async () => {
    const uid = 'uid-tts-ok-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null, brainExists: false });
    const ttsResult = { buffer: Buffer.from('audio'), mimetype: 'audio/ogg' };
    const ttsEngine = {
      generateTTS: jest.fn().mockResolvedValue(ttsResult),
      sendAudioMessage: jest.fn().mockResolvedValue({}),
    };
    const safeSendMessage = jest.fn();
    fa.init(admin, { ttsEngine, safeSendMessage });
    await fa.checkAndAnnounce(uid, sendFn, 'target-jid');
    expect(ttsEngine.generateTTS).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalled(); // texto tambien siempre
  });

  test('TTS lanza error → catch ttsErr + envio texto (branch try/catch ttsErr)', async () => {
    const uid = 'uid-tts-error-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null, brainExists: false });
    const ttsEngine = {
      generateTTS: jest.fn().mockRejectedValue(new Error('TTS failed')),
      sendAudioMessage: jest.fn(),
    };
    const safeSendMessage = jest.fn();
    fa.init(admin, { ttsEngine, safeSendMessage });
    await expect(fa.checkAndAnnounce(uid, sendFn, 'target-jid')).resolves.not.toThrow();
    expect(sendFn).toHaveBeenCalled(); // fallback texto
  });

  test('brain no existe → currentBrain="" (branch brainDoc.exists false)', async () => {
    const uid = 'uid-brain-noexist-' + Date.now();
    const sendFn = jest.fn();
    const admin = makeAdmin({ version: null, brainExists: false, brainContent: null });
    fa.init(admin, {});
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).toHaveBeenCalled();
  });

  test('brain falla → catch brainErr + no bloquea (branch try/catch brainErr)', async () => {
    const uid = 'uid-brain-error-' + Date.now();
    const sendFn = jest.fn();
    // Admin con brain que falla en set
    const metaRef = {
      get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      set: jest.fn().mockResolvedValue({}),
    };
    const brainRef = {
      get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ content: 'old brain' }) }),
      set: jest.fn().mockRejectedValue(new Error('Firestore error')),
    };
    const admin = {
      firestore: () => ({
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({
            collection: jest.fn().mockReturnValue({
              doc: jest.fn().mockImplementation((docId) => {
                if (docId === 'feature_version') return metaRef;
                return brainRef;
              }),
            }),
          }),
        }),
      }),
    };
    fa.init(admin, {});
    await expect(fa.checkAndAnnounce(uid, sendFn, null)).resolves.not.toThrow();
    expect(sendFn).toHaveBeenCalled(); // no bloqueado por brain error
  });

  test('brain existe pero content=null → || "" branch (line 222)', async () => {
    const uid = 'uid-brain-null-content-' + Date.now();
    const sendFn = jest.fn();
    // brainExists=true, brainContent=null → content || '' = ''
    const admin = makeAdmin({ version: null, brainExists: true, brainContent: null });
    fa.init(admin, {});
    await fa.checkAndAnnounce(uid, sendFn, null);
    expect(sendFn).toHaveBeenCalled();
  });

  test('Firestore principal falla → catch err (branch try/catch outer)', async () => {
    const uid = 'uid-outer-error-' + Date.now();
    const sendFn = jest.fn();
    const admin = {
      firestore: () => ({
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({
            collection: jest.fn().mockReturnValue({
              doc: jest.fn().mockReturnValue({
                get: jest.fn().mockRejectedValue(new Error('Firestore unavailable')),
              }),
            }),
          }),
        }),
      }),
    };
    fa.init(admin, {});
    await expect(fa.checkAndAnnounce(uid, sendFn, null)).resolves.not.toThrow();
  });
});
