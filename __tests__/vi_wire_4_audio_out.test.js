'use strict';

const featureFlags = require('../core/feature_flags');
const aio = require('../core/audio_io');

const FLAG = 'PISO3_AUDIO_OUT_ENABLED';
const UID = 'test_uid_vw4';

beforeEach(() => { delete process.env[FLAG]; aio.__setFirestoreForTests(null); });
afterEach(() => { delete process.env[FLAG]; });

function makeMockDb({ existing = null } = {}) {
  let stored = existing;
  return {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
      get: async () => ({ exists: !!stored, data: () => stored }),
      set: async (data) => { stored = Object.assign(stored || {}, data); },
    })})})})
  };
}

describe('VI-WIRE-4 audio outgoing', () => {
  test('flag default OFF', () => {
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(false);
  });
  test('flag ON + shouldUseAudioOutput false -> no audio', async () => {
    process.env[FLAG] = '1';
    aio.__setFirestoreForTests(makeMockDb({ existing: { audioOutputEnabled: false } }));
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);
  });
  test('flag ON + shouldUseAudioOutput true -> synthesize', async () => {
    process.env[FLAG] = '1';
    aio.__setFirestoreForTests(makeMockDb({ existing: { audioOutputEnabled: true } }));
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(true);
    const audio = await aio.synthesizeAudioOutput('hola que tal', {
      synthesizer: async (text) => Buffer.from('audio:' + text),
    });
    expect(audio).toBeDefined();
    expect(audio.toString()).toContain('hola');
  });
  test('synthesizer fail -> tira error en synthesize', async () => {
    await expect(aio.synthesizeAudioOutput('hola', {
      synthesizer: async () => null,
    })).rejects.toThrow('vacio');
  });
});
