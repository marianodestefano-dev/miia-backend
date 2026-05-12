'use strict';

/**
 * Tests R13-B — core/voice_handler.js
 * 100% branch coverage.
 */

let _dailyCount = 0;
let _snapExists = true;

// ── Firestore mock ─────────────────────────────────────────────────────────
const makeFs = () => ({
  collection: () => ({
    doc: () => ({
      collection: () => ({
        doc: () => ({
          get: () => {
            if (!_snapExists) return Promise.resolve({ exists: false });
            return Promise.resolve({ exists: true, data: () => ({ count: _dailyCount, updatedAt: 0 }) });
          },
          set: () => Promise.resolve(),
        }),
      }),
    }),
  }),
});

// ── firebase-admin mock ────────────────────────────────────────────────────
jest.mock('firebase-admin', () => ({ firestore: () => makeFs() }));

// ── fetch global mock ──────────────────────────────────────────────────────
let _fetchOk = true;
let _fetchStatus = 200;
let _fetchText = 'Gemini error body';
let _fetchAbort = false;
let _fetchGeminiText = 'Hola mundo transcripto';
let _fetchBodyOk = true;
let _fetchNetworkError = false;

function makeFetch() {
  return jest.fn(async (_url, _opts) => {
    if (_fetchNetworkError) throw new Error('NETWORK-ERROR');
    if (_fetchAbort) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (!_fetchOk) {
      return {
        ok: false,
        status: _fetchStatus,
        text: async () => _fetchText,
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => (_fetchBodyOk
        ? { candidates: [{ content: { parts: [{ text: _fetchGeminiText }] } }] }
        : { candidates: null }),
    };
  });
}

const {
  transcribeAudio,
  buildVoiceResponse,
  isSupportedMime,
  getDailyCount,
  DAILY_LIMIT,
  __setFirestoreForTests,
} = require('../core/voice_handler');

beforeAll(() => {
  __setFirestoreForTests(makeFs());
});

beforeEach(() => {
  _dailyCount = 0;
  _snapExists = true;
  _fetchOk = true;
  _fetchAbort = false;
  _fetchBodyOk = true;
  _fetchNetworkError = false;
  _fetchGeminiText = 'Hola mundo transcripto';
  global.fetch = makeFetch();
});

// ── isSupportedMime ────────────────────────────────────────────────────────
describe('isSupportedMime', () => {
  it('null -> false', () => { expect(isSupportedMime(null)).toBe(false); });
  it('number -> false', () => { expect(isSupportedMime(123)).toBe(false); });
  it('audio/ogg -> true (full match)', () => { expect(isSupportedMime('audio/ogg')).toBe(true); });
  it('audio/ogg; codecs=opus -> true (full match con parametro)', () => {
    expect(isSupportedMime('audio/ogg; codecs=opus')).toBe(true);
  });
  it('AUDIO/MPEG uppercase -> true via base lower', () => {
    expect(isSupportedMime('AUDIO/MPEG')).toBe(true);
  });
  it('text/plain -> false', () => { expect(isSupportedMime('text/plain')).toBe(false); });
  it('audio/wav -> true', () => { expect(isSupportedMime('audio/wav')).toBe(true); });
});

// ── getDailyCount ──────────────────────────────────────────────────────────
describe('getDailyCount', () => {
  it('snap exists -> count real', async () => {
    _dailyCount = 7;
    _snapExists = true;
    const { count } = await getDailyCount('uid1');
    expect(count).toBe(7);
  });

  it('snap not exists -> count 0', async () => {
    _snapExists = false;
    const { count } = await getDailyCount('uid2');
    expect(count).toBe(0);
  });
});

// ── transcribeAudio ────────────────────────────────────────────────────────
describe('transcribeAudio', () => {
  const buf = Buffer.from('fake-audio-data');

  it('lanza si uid es null', async () => {
    await expect(transcribeAudio(buf, 'audio/ogg', null)).rejects.toThrow('uid requerido');
  });

  it('lanza si uid no es string (number)', async () => {
    await expect(transcribeAudio(buf, 'audio/ogg', 123)).rejects.toThrow('uid requerido');
  });

  it('lanza si audioBuffer no es Buffer (string)', async () => {
    await expect(transcribeAudio('str', 'audio/ogg', 'uid1')).rejects.toThrow('audioBuffer debe ser Buffer');
  });

  it('lanza si audioBuffer es null', async () => {
    await expect(transcribeAudio(null, 'audio/ogg', 'uid1')).rejects.toThrow('audioBuffer debe ser Buffer');
  });

  it('lanza si mimeType no soportado', async () => {
    await expect(transcribeAudio(buf, 'text/plain', 'uid1')).rejects.toThrow('mimeType no soportado');
  });

  it('lanza rate_limit_exceeded si count >= DAILY_LIMIT', async () => {
    _dailyCount = DAILY_LIMIT;
    await expect(transcribeAudio(buf, 'audio/ogg', 'uid_limit')).rejects.toThrow('rate_limit_exceeded');
  });

  it('OK - devuelve text y durationMs', async () => {
    _dailyCount = 2;
    const result = await transcribeAudio(buf, 'audio/ogg', 'uid_ok');
    expect(result.text).toBe('Hola mundo transcripto');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('OK - candidates null -> text vacio string', async () => {
    _dailyCount = 0;
    _fetchBodyOk = false;
    const result = await transcribeAudio(buf, 'audio/mpeg', 'uid_nobody');
    expect(result.text).toBe('');
  });

  it('lanza cuando fetch responde !ok (status 500)', async () => {
    _dailyCount = 0;
    _fetchOk = false;
    _fetchStatus = 500;
    _fetchText = 'Internal server error';
    await expect(transcribeAudio(buf, 'audio/wav', 'uid_err')).rejects.toThrow('Gemini error 500');
  });

  it('lanza transcription_timeout en AbortError', async () => {
    _dailyCount = 0;
    _fetchAbort = true;
    await expect(transcribeAudio(buf, 'audio/ogg', 'uid_abort')).rejects.toThrow('transcription_timeout');
  });

  it('lanza error generico de red', async () => {
    _dailyCount = 0;
    _fetchNetworkError = true;
    await expect(transcribeAudio(buf, 'audio/ogg', 'uid_netfail')).rejects.toThrow('NETWORK-ERROR');
  });
});

// ── buildVoiceResponse ─────────────────────────────────────────────────────
describe('buildVoiceResponse', () => {
  it('string vacio -> mensaje fallback', () => {
    expect(buildVoiceResponse('')).toContain('No pude entender');
  });

  it('null -> mensaje fallback', () => {
    expect(buildVoiceResponse(null)).toContain('No pude entender');
  });

  it('solo espacios -> mensaje fallback', () => {
    expect(buildVoiceResponse('   ')).toContain('No pude entender');
  });

  it('lang != es (en) -> respuesta en ingles', () => {
    const r = buildVoiceResponse('hello world', { language: 'en' });
    expect(r).toContain('Received:');
    expect(r).toContain('hello world');
  });

  it('lang es sin ownerName -> respuesta en espanol sin nombre', () => {
    const r = buildVoiceResponse('hola', { language: 'es' });
    expect(r).toContain('hola');
    expect(r).not.toContain('Mariano');
    expect(r.toLowerCase()).toContain('escuch');
  });

  it('lang es con ownerName -> respuesta incluye nombre', () => {
    const r = buildVoiceResponse('hola', { language: 'es', ownerName: 'Mariano' });
    expect(r).toContain('Mariano');
  });

  it('context null -> usa defaults (es)', () => {
    const r = buildVoiceResponse('test input', null);
    expect(r).toContain('test input');
    expect(r.toLowerCase()).toContain('escuch');
  });

  it('context undefined -> usa defaults (es)', () => {
    const r = buildVoiceResponse('x', undefined);
    expect(r.toLowerCase()).toContain('escuch');
  });
});
