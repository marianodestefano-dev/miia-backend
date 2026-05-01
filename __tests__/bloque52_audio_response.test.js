const { buildTTSRequest, getVoiceForOwner, cacheKey, TTS_TIMEOUT_MS, DEFAULT_VOICE_ID, __setFirestoreForTests } = require('../core/audio_response');

function makeDb() {
  const store = {};
  function makeDoc(p) {
    return {
      get: async () => { const d = store[p]; return { exists: !!d, data: () => d }; },
      set: async (data, opts) => {
        if (opts && opts.merge) store[p] = Object.assign({}, store[p] || {}, data);
        else store[p] = Object.assign({}, data);
      },
      collection: (sub) => makeCol(p + '/' + sub),
    };
  }
  function makeCol(p) {
    return {
      doc: (id) => makeDoc(p + '/' + id),
      where: (f, op, v) => ({
        where: (f2, op2, v2) => ({
          get: async () => {
            const prefix = p + '/';
            const docs = Object.entries(store)
              .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v && d[f2] === v2)
              .map(([, d]) => ({ data: () => d }));
            return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
          }
        }),
        get: async () => {
          const prefix = p + '/';
          const docs = Object.entries(store)
            .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v)
            .map(([, d]) => ({ data: () => d }));
          return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
        }
      }),
    };
  }
  return { collection: (col) => makeCol(col) };
}

let db;
beforeEach(() => { db = makeDb(); __setFirestoreForTests(db); });
afterAll(() => { __setFirestoreForTests(null); });

describe('T353 - audio_response', () => {
  test('buildTTSRequest returns request with correct fields', () => {
    const req = buildTTSRequest('Hola Mariano', 'voice123');
    expect(req.url).toContain('voice123');
    expect(req.url).toContain('elevenlabs.io');
    const body = JSON.parse(req.body);
    expect(body.text).toBe('Hola Mariano');
    expect(body.voice_settings).toBeDefined();
  });

  test('buildTTSRequest throws if no text', () => {
    expect(() => buildTTSRequest(null, 'v1')).toThrow('text required');
  });

  test('buildTTSRequest uses DEFAULT_VOICE_ID when voiceId is null', () => {
    const req = buildTTSRequest('Hello', null);
    expect(req.url).toContain(DEFAULT_VOICE_ID);
  });

  test('TTS_TIMEOUT_MS is 8000', () => {
    expect(TTS_TIMEOUT_MS).toBe(8000);
  });

  test('getVoiceForOwner returns DEFAULT_VOICE_ID when no owner config', async () => {
    const voice = await getVoiceForOwner('uid_unknown');
    expect(voice).toBe(DEFAULT_VOICE_ID);
  });

  test('getVoiceForOwner returns configured voice', async () => {
    await db.collection('owners').doc('uid1').set({ elevenlabs_voice_id: 'custom_voice_123' });
    const voice = await getVoiceForOwner('uid1');
    expect(voice).toBe('custom_voice_123');
  });

  test('cacheKey returns SHA256 hex string', () => {
    const key = cacheKey('hello world', 'voice_v1');
    expect(typeof key).toBe("string");
    expect(key.length).toBe(64);
    const key2 = cacheKey('hello world', 'voice_v1');
    expect(key).toBe(key2);
    const key3 = cacheKey('different text', 'voice_v1');
    expect(key).not.toBe(key3);
  });

  test('getVoiceForOwner throws if no uid', async () => {
    await expect(getVoiceForOwner(null)).rejects.toThrow('uid required');
  });
});
