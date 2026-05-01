'use strict';

const {
  synthesizeAudio, getOwnerVoiceId, setOwnerVoiceId,
  AVAILABLE_VOICE_IDS, DEFAULT_VOICE_ID, MAX_TEXT_LENGTH, DEFAULT_MODEL,
  __setHttpClientForTests,
} = require('../core/audio_synthesizer');

const VALID_TEXT = 'Hola, soy MIIA, tu asistente virtual.';
const FAKE_BUFFER = Buffer.from('fake_mp3_data');

function makeMockClient({ buffer = FAKE_BUFFER, throwErr = null } = {}) {
  return {
    post: async (url, body, opts) => {
      if (throwErr) throw new Error(throwErr);
      return buffer;
    },
  };
}

function makeMockDb({ voiceId = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => {
          if (throwGet) throw new Error('get error');
          if (!voiceId) return { exists: false, data: () => ({}) };
          return { exists: true, data: () => ({ miiaVoiceId: voiceId }) };
        },
        set: async () => {
          if (throwSet) throw new Error('set error');
        },
      }),
    }),
  };
}

beforeEach(() => { __setHttpClientForTests(null); });
afterEach(() => { __setHttpClientForTests(null); });

describe('AVAILABLE_VOICE_IDS y constants', () => {
  test('AVAILABLE_VOICE_IDS tiene 9 voces', () => {
    expect(AVAILABLE_VOICE_IDS.length).toBe(9);
  });
  test('AVAILABLE_VOICE_IDS es frozen', () => {
    expect(() => { AVAILABLE_VOICE_IDS.push('x'); }).toThrow();
  });
  test('DEFAULT_VOICE_ID esta en AVAILABLE_VOICE_IDS', () => {
    expect(AVAILABLE_VOICE_IDS).toContain(DEFAULT_VOICE_ID);
  });
  test('MAX_TEXT_LENGTH es 5000', () => {
    expect(MAX_TEXT_LENGTH).toBe(5000);
  });
  test('DEFAULT_MODEL es eleven_multilingual_v2', () => {
    expect(DEFAULT_MODEL).toBe('eleven_multilingual_v2');
  });
});

describe('synthesizeAudio — validacion', () => {
  test('lanza si text es null', async () => {
    await expect(synthesizeAudio(null)).rejects.toThrow('text requerido');
  });
  test('lanza si text no es string', async () => {
    await expect(synthesizeAudio(123)).rejects.toThrow('text requerido');
  });
  test('lanza si text vacio', async () => {
    await expect(synthesizeAudio('   ')).rejects.toThrow('vacio');
  });
  test('lanza si text supera MAX_TEXT_LENGTH', async () => {
    const long = 'a'.repeat(MAX_TEXT_LENGTH + 1);
    await expect(synthesizeAudio(long)).rejects.toThrow('largo');
  });
  test('lanza si voiceId invalido', async () => {
    __setHttpClientForTests(makeMockClient());
    await expect(synthesizeAudio(VALID_TEXT, { voiceId: 'fake_voice', apiKey: 'k' })).rejects.toThrow('voiceId invalido');
  });
  test('lanza si no hay apiKey ni env', async () => {
    __setHttpClientForTests(makeMockClient());
    const prev = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    await expect(synthesizeAudio(VALID_TEXT)).rejects.toThrow('ELEVENLABS_API_KEY');
    if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
  });
});

describe('synthesizeAudio — resultado', () => {
  test('retorna buffer mp3 con voiceId y modelId', async () => {
    __setHttpClientForTests(makeMockClient({ buffer: FAKE_BUFFER }));
    const r = await synthesizeAudio(VALID_TEXT, { apiKey: 'k' });
    expect(Buffer.isBuffer(r.buffer)).toBe(true);
    expect(r.voiceId).toBe(DEFAULT_VOICE_ID);
    expect(r.modelId).toBe(DEFAULT_MODEL);
    expect(r.format).toBe('mp3');
  });
  test('usa voiceId personalizado del opts', async () => {
    __setHttpClientForTests(makeMockClient());
    const r = await synthesizeAudio(VALID_TEXT, { apiKey: 'k', voiceId: AVAILABLE_VOICE_IDS[1] });
    expect(r.voiceId).toBe(AVAILABLE_VOICE_IDS[1]);
  });
  test('propaga error si cliente lanza', async () => {
    __setHttpClientForTests(makeMockClient({ throwErr: 'ElevenLabs down' }));
    await expect(synthesizeAudio(VALID_TEXT, { apiKey: 'k' })).rejects.toThrow('ElevenLabs down');
  });
  test('lanza si cliente retorna no-Buffer', async () => {
    __setHttpClientForTests({ post: async () => 'not a buffer' });
    await expect(synthesizeAudio(VALID_TEXT, { apiKey: 'k' })).rejects.toThrow('no es Buffer');
  });
  test('usa ELEVENLABS_API_KEY del environment', async () => {
    __setHttpClientForTests(makeMockClient());
    process.env.ELEVENLABS_API_KEY = 'env_key';
    const r = await synthesizeAudio(VALID_TEXT);
    expect(r.buffer).toBeDefined();
    delete process.env.ELEVENLABS_API_KEY;
  });
});

describe('getOwnerVoiceId', () => {
  test('lanza si uid undefined', async () => {
    await expect(getOwnerVoiceId(undefined, makeMockDb())).rejects.toThrow('uid requerido');
  });
  test('lanza si db undefined', async () => {
    await expect(getOwnerVoiceId('uid1', undefined)).rejects.toThrow('db requerido');
  });
  test('retorna DEFAULT si doc no existe', async () => {
    const r = await getOwnerVoiceId('uid1', makeMockDb({ voiceId: null }));
    expect(r).toBe(DEFAULT_VOICE_ID);
  });
  test('retorna voiceId guardado si es valido', async () => {
    const r = await getOwnerVoiceId('uid1', makeMockDb({ voiceId: AVAILABLE_VOICE_IDS[2] }));
    expect(r).toBe(AVAILABLE_VOICE_IDS[2]);
  });
  test('retorna DEFAULT si voiceId guardado no es valido', async () => {
    const r = await getOwnerVoiceId('uid1', makeMockDb({ voiceId: 'invalid_voice' }));
    expect(r).toBe(DEFAULT_VOICE_ID);
  });
  test('fail-open retorna DEFAULT si Firestore falla', async () => {
    const r = await getOwnerVoiceId('uid1', makeMockDb({ throwGet: true }));
    expect(r).toBe(DEFAULT_VOICE_ID);
  });
});

describe('setOwnerVoiceId', () => {
  test('lanza si uid undefined', async () => {
    await expect(setOwnerVoiceId(undefined, DEFAULT_VOICE_ID, makeMockDb())).rejects.toThrow('uid requerido');
  });
  test('lanza si voiceId invalido', async () => {
    await expect(setOwnerVoiceId('uid1', 'invalid', makeMockDb())).rejects.toThrow('voiceId invalido');
  });
  test('lanza si db undefined', async () => {
    await expect(setOwnerVoiceId('uid1', DEFAULT_VOICE_ID, undefined)).rejects.toThrow('db requerido');
  });
  test('guarda correctamente sin lanzar', async () => {
    await expect(setOwnerVoiceId('uid1', DEFAULT_VOICE_ID, makeMockDb())).resolves.toBeUndefined();
  });
  test('propaga error si Firestore falla', async () => {
    await expect(setOwnerVoiceId('uid1', DEFAULT_VOICE_ID, makeMockDb({ throwSet: true }))).rejects.toThrow('set error');
  });
});
