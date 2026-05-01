'use strict';

const {
  transcribeAudio, detectLanguageFromText, getSupportedFormats,
  SUPPORTED_FORMATS, MAX_FILE_SIZE, DEFAULT_LANGUAGE,
  __setHttpClientForTests,
} = require('../core/audio_processor');

const VALID_BUFFER = Buffer.alloc(1024, 0xAA);

function makeMockClient({ text = 'hola mundo', duration = 2.5, throwErr = null } = {}) {
  return {
    post: async (url, buffer, opts) => {
      if (throwErr) throw new Error(throwErr);
      return { text, duration };
    },
  };
}

beforeEach(() => { __setHttpClientForTests(null); });
afterEach(() => { __setHttpClientForTests(null); });

describe('SUPPORTED_FORMATS y constants', () => {
  test('SUPPORTED_FORMATS contiene formatos comunes', () => {
    expect(SUPPORTED_FORMATS).toContain('ogg');
    expect(SUPPORTED_FORMATS).toContain('mp3');
    expect(SUPPORTED_FORMATS).toContain('wav');
    expect(SUPPORTED_FORMATS).toContain('m4a');
  });
  test('SUPPORTED_FORMATS es frozen', () => {
    expect(() => { SUPPORTED_FORMATS.push('xyz'); }).toThrow();
  });
  test('MAX_FILE_SIZE es 25MB', () => {
    expect(MAX_FILE_SIZE).toBe(25 * 1024 * 1024);
  });
  test('DEFAULT_LANGUAGE es es', () => {
    expect(DEFAULT_LANGUAGE).toBe('es');
  });
});

describe('getSupportedFormats', () => {
  test('retorna array mutable con mismos formatos', () => {
    const formats = getSupportedFormats();
    expect(Array.isArray(formats)).toBe(true);
    expect(formats).toContain('ogg');
    expect(() => { formats.push('xyz'); }).not.toThrow();
  });
});

describe('transcribeAudio — validacion', () => {
  test('lanza si buffer es null', async () => {
    await expect(transcribeAudio(null)).rejects.toThrow('buffer requerido');
  });
  test('lanza si buffer no es Buffer', async () => {
    await expect(transcribeAudio('cadena')).rejects.toThrow('buffer requerido');
  });
  test('lanza si buffer vacio', async () => {
    await expect(transcribeAudio(Buffer.alloc(0))).rejects.toThrow('vacio');
  });
  test('lanza si buffer mayor a 25MB', async () => {
    const big = Buffer.alloc(MAX_FILE_SIZE + 1);
    await expect(transcribeAudio(big)).rejects.toThrow('grande');
  });
  test('lanza si formato no soportado', async () => {
    __setHttpClientForTests(makeMockClient());
    await expect(transcribeAudio(VALID_BUFFER, { format: 'xyz', apiKey: 'k' })).rejects.toThrow('no soportado');
  });
  test('lanza si no hay apiKey ni variable de entorno', async () => {
    __setHttpClientForTests(makeMockClient());
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(transcribeAudio(VALID_BUFFER)).rejects.toThrow('OPENAI_API_KEY');
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });
});

describe('transcribeAudio — resultado', () => {
  test('retorna texto transcripto', async () => {
    __setHttpClientForTests(makeMockClient({ text: 'hola mundo' }));
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'test_key' });
    expect(r.text).toBe('hola mundo');
    expect(r.language).toBe('es');
    expect(r.format).toBe('ogg');
  });
  test('usa language del opts', async () => {
    __setHttpClientForTests(makeMockClient({ text: 'hello world' }));
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k', language: 'en' });
    expect(r.language).toBe('en');
  });
  test('retorna duration del API', async () => {
    __setHttpClientForTests(makeMockClient({ text: 'test', duration: 3.14 }));
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k' });
    expect(r.duration).toBe(3.14);
  });
  test('retorna null duration si API no la incluye', async () => {
    __setHttpClientForTests({ post: async () => ({ text: 'test' }) });
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k' });
    expect(r.duration).toBeNull();
  });
  test('trim whitespace del texto', async () => {
    __setHttpClientForTests(makeMockClient({ text: '  hola  ' }));
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k' });
    expect(r.text).toBe('hola');
  });
  test('retorna string vacio si API retorna texto vacio', async () => {
    __setHttpClientForTests(makeMockClient({ text: '' }));
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k' });
    expect(r.text).toBe('');
  });
  test('propaga error si cliente lanza', async () => {
    __setHttpClientForTests(makeMockClient({ throwErr: 'API timeout' }));
    await expect(transcribeAudio(VALID_BUFFER, { apiKey: 'k' })).rejects.toThrow('API timeout');
  });
  test('acepta formato mp3', async () => {
    __setHttpClientForTests(makeMockClient());
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k', format: 'mp3' });
    expect(r.format).toBe('mp3');
  });
  test('acepta formato wav', async () => {
    __setHttpClientForTests(makeMockClient());
    const r = await transcribeAudio(VALID_BUFFER, { apiKey: 'k', format: 'wav' });
    expect(r.format).toBe('wav');
  });
  test('usa OPENAI_API_KEY del environment si no se provee apiKey', async () => {
    __setHttpClientForTests(makeMockClient({ text: 'desde env' }));
    process.env.OPENAI_API_KEY = 'env_key_test';
    const r = await transcribeAudio(VALID_BUFFER);
    expect(r.text).toBe('desde env');
    delete process.env.OPENAI_API_KEY;
  });
});

describe('detectLanguageFromText', () => {
  test('retorna unknown para texto vacio', () => {
    expect(detectLanguageFromText('')).toBe('unknown');
  });
  test('retorna unknown para null', () => {
    expect(detectLanguageFromText(null)).toBe('unknown');
  });
  test('detecta espanol', () => {
    expect(detectLanguageFromText('el restaurante es muy bueno y la comida es deliciosa para todos')).toBe('es');
  });
  test('detecta ingles', () => {
    expect(detectLanguageFromText('the restaurant is very good and the food is delicious for all')).toBe('en');
  });
  test('retorna string para texto sin indicadores', () => {
    expect(typeof detectLanguageFromText('xyz abc')).toBe('string');
  });
});
