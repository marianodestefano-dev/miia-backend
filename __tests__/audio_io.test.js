'use strict';

const aio = require('../core/audio_io');

const UID = 'test_uid';

function makeMockDb({ existing = null } = {}) {
  let stored = existing;
  return {
    collection: () => ({ doc: () => ({ collection: () => ({
      doc: () => ({
        get: async () => ({ exists: !!stored, data: () => stored }),
        set: async (data, opts) => { stored = Object.assign(stored || {}, data); },
      }),
    })})})
  };
}

beforeEach(() => { aio.__setFirestoreForTests(null); });

describe('SUPPORTED_INPUT_FORMATS frozen', () => {
  test('frozen', () => { expect(() => { aio.SUPPORTED_INPUT_FORMATS.push('x'); }).toThrow(); });
  test('contiene ogg', () => { expect(aio.SUPPORTED_INPUT_FORMATS).toContain('ogg'); });
});

describe('transcribeIncomingAudio', () => {
  test('audio undefined throw', async () => {
    await expect(aio.transcribeIncomingAudio(undefined, {})).rejects.toThrow('audio');
  });
  test('format no soportado throw', async () => {
    await expect(aio.transcribeIncomingAudio('audio', { format: 'aiff' })).rejects.toThrow('format');
  });
  test('sin transcriber throw', async () => {
    await expect(aio.transcribeIncomingAudio('audio', {})).rejects.toThrow('transcriber');
  });
  test('transcriber retorna string', async () => {
    const r = await aio.transcribeIncomingAudio('audio', {
      transcriber: async () => 'hola que tal',
    });
    expect(r.text).toBe('hola que tal');
    expect(r.confidence).toBe(0.8);
  });
  test('transcriber retorna objeto', async () => {
    const r = await aio.transcribeIncomingAudio('audio', {
      transcriber: async () => ({ text: 'hola', language: 'es', confidence: 0.95 }),
    });
    expect(r.text).toBe('hola');
    expect(r.language).toBe('es');
    expect(r.confidence).toBe(0.95);
  });
  test('transcriber retorna objeto sin text', async () => {
    const r = await aio.transcribeIncomingAudio('audio', {
      transcriber: async () => ({ language: 'es' }),
    });
    expect(r.text).toBe('');
  });
  test('transcriber retorna objeto sin confidence default 0.8', async () => {
    const r = await aio.transcribeIncomingAudio('audio', {
      transcriber: async () => ({ text: 'hola', language: 'es' }),
    });
    expect(r.confidence).toBe(0.8);
  });
  test('transcriber throws -> retorna error en resultado', async () => {
    const r = await aio.transcribeIncomingAudio('audio', {
      transcriber: async () => { throw new Error('whisper down'); },
    });
    expect(r.text).toBe('');
    expect(r.confidence).toBe(0);
    expect(r.error).toContain('whisper');
  });
  test('languageHint pasado al transcriber', async () => {
    let receivedLang = null;
    await aio.transcribeIncomingAudio('audio', {
      languageHint: 'es',
      transcriber: async (a, f, l) => { receivedLang = l; return 'hola'; },
    });
    expect(receivedLang).toBe('es');
  });
});

describe('shouldUseAudioOutput', () => {
  test('uid undefined throw', async () => {
    await expect(aio.shouldUseAudioOutput(undefined, '+1', {})).rejects.toThrow('uid');
  });
  test('sin settings -> false', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);
  });
  test('audioOutputEnabled false -> false', async () => {
    aio.__setFirestoreForTests(makeMockDb({ existing: { audioOutputEnabled: false } }));
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);
  });
  test('audioOutputEnabled true -> true', async () => {
    aio.__setFirestoreForTests(makeMockDb({ existing: { audioOutputEnabled: true } }));
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(true);
  });
  test('per-contact override false -> false aunque global true', async () => {
    aio.__setFirestoreForTests(makeMockDb({ existing: {
      audioOutputEnabled: true,
      perContact: { '+1': false },
    }}));
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);
  });
  test('sin contactPhone usa solo flag global', async () => {
    aio.__setFirestoreForTests(makeMockDb({ existing: { audioOutputEnabled: true } }));
    expect(await aio.shouldUseAudioOutput(UID)).toBe(true);
  });
  test('doc.exists pero data null', async () => {
    aio.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true, data: () => null })
      })})})})
    });
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);
  });
  test('doc.exists pero sin data fn', async () => {
    aio.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true })
      })})})})
    });
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);
  });
});

describe('synthesizeAudioOutput', () => {
  test('text undefined throw', async () => {
    await expect(aio.synthesizeAudioOutput(undefined, {})).rejects.toThrow('text');
  });
  test('text no string throw', async () => {
    await expect(aio.synthesizeAudioOutput(123, {})).rejects.toThrow('text');
  });
  test('text demasiado largo throw', async () => {
    await expect(aio.synthesizeAudioOutput('a'.repeat(1001), {})).rejects.toThrow('demasiado');
  });
  test('sin synthesizer throw', async () => {
    await expect(aio.synthesizeAudioOutput('hola', {})).rejects.toThrow('synthesizer');
  });
  test('synthesizer retorna empty throw', async () => {
    await expect(aio.synthesizeAudioOutput('hola', {
      synthesizer: async () => null,
    })).rejects.toThrow('vacio');
  });
  test('synthesizer retorna buffer', async () => {
    const r = await aio.synthesizeAudioOutput('hola', {
      synthesizer: async () => Buffer.from('audio data'),
    });
    expect(r).toBeDefined();
  });
  test('voiceId custom pasado', async () => {
    let receivedVoice = null;
    await aio.synthesizeAudioOutput('hola', {
      voiceId: 'antoni',
      synthesizer: async (txt, voice) => { receivedVoice = voice; return Buffer.from('x'); },
    });
    expect(receivedVoice).toBe('antoni');
  });
  test('voiceId default cuando no se pasa', async () => {
    let receivedVoice = null;
    await aio.synthesizeAudioOutput('hola', {
      synthesizer: async (txt, voice) => { receivedVoice = voice; return Buffer.from('x'); },
    });
    expect(receivedVoice).toBe(aio.DEFAULT_VOICE_ID);
  });
});

describe('setAudioPreferences', () => {
  test('uid undefined throw', async () => {
    await expect(aio.setAudioPreferences(undefined, {})).rejects.toThrow('uid');
  });
  test('prefs null throw', async () => {
    await expect(aio.setAudioPreferences(UID, null)).rejects.toThrow('prefs');
  });
  test('prefs no object throw', async () => {
    await expect(aio.setAudioPreferences(UID, 'no')).rejects.toThrow('prefs');
  });
  test('default audioOutputEnabled false si no se pasa', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, {});
    expect(r.audioOutputEnabled).toBe(false);
  });
  test('audioOutputEnabled true preserved', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, { audioOutputEnabled: true });
    expect(r.audioOutputEnabled).toBe(true);
  });
  test('voiceId custom preserved', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, { voiceId: 'antoni' });
    expect(r.voiceId).toBe('antoni');
  });
  test('transcribeIncoming default true', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, {});
    expect(r.transcribeIncoming).toBe(true);
  });
  test('transcribeIncoming false respetado', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, { transcribeIncoming: false });
    expect(r.transcribeIncoming).toBe(false);
  });
  test('perContact con object respetado', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, { perContact: { '+1': false } });
    expect(r.perContact['+1']).toBe(false);
  });
  test('perContact no-object default {}', async () => {
    aio.__setFirestoreForTests(makeMockDb());
    const r = await aio.setAudioPreferences(UID, { perContact: 'no-object' });
    expect(r.perContact).toEqual({});
  });
});
