'use strict';

const featureFlags = require('../core/feature_flags');
const aio = require('../core/audio_io');

const FLAG = 'PISO3_AUDIO_IN_ENABLED';

beforeEach(() => { delete process.env[FLAG]; });
afterEach(() => { delete process.env[FLAG]; });

describe('VI-WIRE-3 audio incoming', () => {
  test('flag default OFF', () => {
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(false);
  });
  test('flag ON -> wire ejecutaria', () => {
    process.env[FLAG] = '1';
    expect(featureFlags.isFlagEnabled(FLAG)).toBe(true);
  });
  test('audio_io transcribe simulado retorna text', async () => {
    const r = await aio.transcribeIncomingAudio(Buffer.from('mock'), {
      format: 'ogg',
      transcriber: async () => 'hola, queria saber el precio',
    });
    expect(r.text).toContain('precio');
  });
  test('transcriber throw -> retorna fail-soft', async () => {
    const r = await aio.transcribeIncomingAudio(Buffer.from('mock'), {
      format: 'ogg',
      transcriber: async () => { throw new Error('whisper down'); },
    });
    expect(r.text).toBe('');
    expect(r.error).toContain('whisper');
  });
});
