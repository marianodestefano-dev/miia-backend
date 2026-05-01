'use strict';
const { buildTTSRequest, buildTTSUrl, getVoiceId, VOICE_MAP, TTS_DEFAULTS, MAX_TEXT_LENGTH } = require('../core/tts_request_builder');

describe('VOICE_MAP y TTS_DEFAULTS', () => {
  test('tiene voice default', () => {
    expect(VOICE_MAP.default).toBeDefined();
    expect(VOICE_MAP.lead).toBeDefined();
    expect(VOICE_MAP.family).toBeDefined();
  });
  test('TTS_DEFAULTS tiene model_id y voice_settings', () => {
    expect(TTS_DEFAULTS.model_id).toBeDefined();
    expect(TTS_DEFAULTS.voice_settings.stability).toBeDefined();
  });
  test('MAX_TEXT_LENGTH = 5000', () => {
    expect(MAX_TEXT_LENGTH).toBe(5000);
  });
});

describe('getVoiceId', () => {
  test('modo valido retorna voice correcto', () => {
    expect(getVoiceId('lead')).toBe(VOICE_MAP.lead);
    expect(getVoiceId('family')).toBe(VOICE_MAP.family);
  });
  test('modo desconocido retorna default', () => {
    expect(getVoiceId('unknown_mode')).toBe(VOICE_MAP.default);
  });
  test('undefined retorna default', () => {
    expect(getVoiceId(undefined)).toBe(VOICE_MAP.default);
  });
});

describe('buildTTSRequest — validacion', () => {
  test('lanza si text falta', () => {
    expect(() => buildTTSRequest(null)).toThrow('text requerido');
  });
  test('lanza si text es solo espacios', () => {
    expect(() => buildTTSRequest('   ')).toThrow('text no puede ser vacio');
  });
  test('no lanza si numero se pasa', () => {
    expect(() => buildTTSRequest(42)).toThrow('text requerido');
  });
});

describe('buildTTSRequest — resultado', () => {
  test('retorna voiceId, payload, textLength', () => {
    const r = buildTTSRequest('hola mundo');
    expect(r.voiceId).toBeDefined();
    expect(r.payload.text).toBe('hola mundo');
    expect(r.textLength).toBe(10);
    expect(r.wasTruncated).toBe(false);
  });
  test('usa voiceId de opts si se pasa', () => {
    const r = buildTTSRequest('hola', { voiceId: 'custom_voice_id' });
    expect(r.voiceId).toBe('custom_voice_id');
  });
  test('usa voice del modo si se pasa', () => {
    const r = buildTTSRequest('hola', { mode: 'family' });
    expect(r.voiceId).toBe(VOICE_MAP.family);
  });
  test('texto largo se trunca', () => {
    const longText = 'x'.repeat(6000);
    const r = buildTTSRequest(longText);
    expect(r.wasTruncated).toBe(true);
    expect(r.payload.text.length).toBe(MAX_TEXT_LENGTH);
    expect(r.textLength).toBe(MAX_TEXT_LENGTH);
  });
  test('payload tiene model_id default', () => {
    const r = buildTTSRequest('test');
    expect(r.payload.model_id).toBe(TTS_DEFAULTS.model_id);
  });
  test('voice_settings merge con override', () => {
    const r = buildTTSRequest('test', { voiceSettings: { stability: 0.9 } });
    expect(r.payload.voice_settings.stability).toBe(0.9);
    expect(r.payload.voice_settings.similarity_boost).toBe(TTS_DEFAULTS.voice_settings.similarity_boost);
  });
  test('output_format override funciona', () => {
    const r = buildTTSRequest('test', { output_format: 'mp3_22050_32' });
    expect(r.payload.output_format).toBe('mp3_22050_32');
  });
});

describe('buildTTSUrl', () => {
  test('lanza si voiceId falta', () => {
    expect(() => buildTTSUrl(null)).toThrow('voiceId requerido');
  });
  test('construye URL correcta', () => {
    const url = buildTTSUrl('abc123');
    expect(url).toContain('abc123');
    expect(url).toContain('text-to-speech');
  });
  test('respeta baseUrl custom', () => {
    const url = buildTTSUrl('v1', 'https://custom.api/v2');
    expect(url.startsWith('https://custom.api/v2')).toBe(true);
  });
});
