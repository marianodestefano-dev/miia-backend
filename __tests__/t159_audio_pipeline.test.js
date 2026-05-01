'use strict';

const {
  detectAudioLanguage, buildAudioResponse, processVoiceMessage,
  SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE,
  __setTranscriberForTests, __setSynthesizerForTests,
} = require('../core/audio_pipeline');

const VALID_BUFFER = Buffer.alloc(1024, 0xAA);
const FAKE_AUDIO_RESPONSE = Buffer.from('fake_mp3');

function makeMockTranscriber({ text = 'hola mundo como estas hoy aqui', lang = 'es', throwErr = null } = {}) {
  return {
    transcribeAudio: async (buf, opts) => {
      if (throwErr) throw new Error(throwErr);
      return { text, language: lang, duration: 2.0, format: 'ogg' };
    },
    detectLanguageFromText: (t) => {
      if (!t) return 'unknown';
      const lo = t.toLowerCase();
      const es = (lo.match(/\b(el|la|los|como|hola|aqui|esta)\b/g) || []).length;
      const en = (lo.match(/\b(the|is|are|hello|here|this)\b/g) || []).length;
      if (es > en) return 'es';
      if (en > es) return 'en';
      return 'unknown';
    },
  };
}

function makeMockSynthesizer({ buffer = FAKE_AUDIO_RESPONSE, throwErr = null } = {}) {
  return {
    synthesizeAudio: async (text, opts) => {
      if (throwErr) throw new Error(throwErr);
      return { buffer, voiceId: 'voice123', modelId: 'model1', format: 'mp3' };
    },
  };
}

beforeEach(() => {
  __setTranscriberForTests(null);
  __setSynthesizerForTests(null);
});
afterEach(() => {
  __setTranscriberForTests(null);
  __setSynthesizerForTests(null);
});

describe('SUPPORTED_LANGUAGES y constants', () => {
  test('SUPPORTED_LANGUAGES contiene es/en/pt', () => {
    expect(SUPPORTED_LANGUAGES).toContain('es');
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('pt');
  });
  test('SUPPORTED_LANGUAGES es frozen', () => {
    expect(() => { SUPPORTED_LANGUAGES.push('fr'); }).toThrow();
  });
  test('DEFAULT_LANGUAGE es es', () => {
    expect(DEFAULT_LANGUAGE).toBe('es');
  });
});

describe('detectAudioLanguage — validacion', () => {
  test('lanza si buffer es null', async () => {
    await expect(detectAudioLanguage(null)).rejects.toThrow('buffer requerido');
  });
  test('lanza si buffer no es Buffer', async () => {
    await expect(detectAudioLanguage('texto')).rejects.toThrow('buffer requerido');
  });
});

describe('detectAudioLanguage — resultado', () => {
  test('detecta idioma espanol', async () => {
    __setTranscriberForTests(makeMockTranscriber({ text: 'hola como estas aqui hoy todo bien' }));
    const r = await detectAudioLanguage(VALID_BUFFER);
    expect(r.language).toBe('es');
    expect(typeof r.transcript).toBe('string');
    expect(typeof r.confidence).toBe('number');
  });
  test('detecta idioma ingles', async () => {
    __setTranscriberForTests(makeMockTranscriber({ text: 'hello how are you here today this is fine' }));
    const r = await detectAudioLanguage(VALID_BUFFER);
    expect(r.language).toBe('en');
  });
  test('fallback a DEFAULT si idioma unknown', async () => {
    __setTranscriberForTests(makeMockTranscriber({ text: '' }));
    const r = await detectAudioLanguage(VALID_BUFFER);
    expect(r.language).toBe(DEFAULT_LANGUAGE);
  });
  test('propaga error si transcriber falla', async () => {
    __setTranscriberForTests(makeMockTranscriber({ throwErr: 'transcribe fail' }));
    await expect(detectAudioLanguage(VALID_BUFFER)).rejects.toThrow('transcribe fail');
  });
  test('confidence alta para texto largo', async () => {
    __setTranscriberForTests(makeMockTranscriber({ text: 'hola buenos dias como estas muy bien gracias aqui todo genial' }));
    const r = await detectAudioLanguage(VALID_BUFFER);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });
  test('confidence baja para texto muy corto', async () => {
    __setTranscriberForTests(makeMockTranscriber({ text: 'hola la el' }));
    const r = await detectAudioLanguage(VALID_BUFFER);
    expect(r.confidence).toBeLessThanOrEqual(0.7);
  });
});

describe('buildAudioResponse — validacion', () => {
  test('lanza si textResponse undefined', async () => {
    await expect(buildAudioResponse(undefined, 'es')).rejects.toThrow('textResponse requerido');
  });
  test('lanza si language undefined', async () => {
    __setSynthesizerForTests(makeMockSynthesizer());
    await expect(buildAudioResponse('texto', undefined)).rejects.toThrow('language requerido');
  });
});

describe('buildAudioResponse — resultado', () => {
  test('retorna buffer y language correctos', async () => {
    __setSynthesizerForTests(makeMockSynthesizer({ buffer: FAKE_AUDIO_RESPONSE }));
    const r = await buildAudioResponse('Hola, soy MIIA', 'es');
    expect(Buffer.isBuffer(r.buffer)).toBe(true);
    expect(r.language).toBe('es');
    expect(r.format).toBe('mp3');
  });
  test('normaliza idioma desconocido a DEFAULT', async () => {
    __setSynthesizerForTests(makeMockSynthesizer());
    const r = await buildAudioResponse('Hola', 'fr');
    expect(r.language).toBe(DEFAULT_LANGUAGE);
  });
  test('propaga error si synthesizer falla', async () => {
    __setSynthesizerForTests(makeMockSynthesizer({ throwErr: 'synth fail' }));
    await expect(buildAudioResponse('Hola', 'es')).rejects.toThrow('synth fail');
  });
});

describe('processVoiceMessage', () => {
  test('lanza si inputBuffer no es Buffer', async () => {
    await expect(processVoiceMessage('no buffer', 'Hola')).rejects.toThrow('inputBuffer requerido');
  });
  test('lanza si textResponse undefined', async () => {
    await expect(processVoiceMessage(VALID_BUFFER, undefined)).rejects.toThrow('textResponse requerido');
  });
  test('pipeline completo retorna todos los campos', async () => {
    __setTranscriberForTests(makeMockTranscriber({ text: 'hola como estas aqui todo bien' }));
    __setSynthesizerForTests(makeMockSynthesizer({ buffer: FAKE_AUDIO_RESPONSE }));
    const r = await processVoiceMessage(VALID_BUFFER, 'Muy bien gracias');
    expect(typeof r.transcript).toBe('string');
    expect(r.language).toBe('es');
    expect(typeof r.confidence).toBe('number');
    expect(Buffer.isBuffer(r.responseBuffer)).toBe(true);
    expect(r.voiceId).toBeDefined();
    expect(r.format).toBe('mp3');
  });
  test('propaga error de transcriber en pipeline', async () => {
    __setTranscriberForTests(makeMockTranscriber({ throwErr: 'audio error' }));
    __setSynthesizerForTests(makeMockSynthesizer());
    await expect(processVoiceMessage(VALID_BUFFER, 'respuesta')).rejects.toThrow('audio error');
  });
});
