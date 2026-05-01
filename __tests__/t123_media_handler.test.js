'use strict';
const { detectMediaType, validateMedia, buildMediaMeta, MAX_SIZES_BYTES, SUPPORTED_MIMES } = require('../core/media_handler');

describe('detectMediaType', () => {
  test('null retorna null', () => { expect(detectMediaType(null)).toBeNull(); });
  test('undefined retorna null', () => { expect(detectMediaType(undefined)).toBeNull(); });
  test('mime desconocido retorna null', () => { expect(detectMediaType('application/unknown')).toBeNull(); });
  test('image/jpeg -> image', () => { expect(detectMediaType('image/jpeg')).toBe('image'); });
  test('audio/ogg -> audio', () => { expect(detectMediaType('audio/ogg')).toBe('audio'); });
  test('video/mp4 -> video', () => { expect(detectMediaType('video/mp4')).toBe('video'); });
  test('application/pdf -> document', () => { expect(detectMediaType('application/pdf')).toBe('document'); });
  test('case insensitive', () => { expect(detectMediaType('IMAGE/PNG')).toBe('image'); });
});

describe('MAX_SIZES_BYTES', () => {
  test('image max 5MB', () => { expect(MAX_SIZES_BYTES.image).toBe(5 * 1024 * 1024); });
  test('audio max 16MB', () => { expect(MAX_SIZES_BYTES.audio).toBe(16 * 1024 * 1024); });
  test('video max 64MB', () => { expect(MAX_SIZES_BYTES.video).toBe(64 * 1024 * 1024); });
  test('document max 10MB', () => { expect(MAX_SIZES_BYTES.document).toBe(10 * 1024 * 1024); });
});

describe('validateMedia', () => {
  test('null retorna invalid media_required', () => {
    const r = validateMedia(null);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('media_required');
  });
  test('mime desconocido = invalid', () => {
    const r = validateMedia({ mimeType: 'application/x-custom', sizeBytes: 1000 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch('unsupported_mime');
  });
  test('sizeBytes negativo = invalid', () => {
    const r = validateMedia({ mimeType: 'image/jpeg', sizeBytes: -1 });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_size');
  });
  test('tamano exactamente en limite = valid', () => {
    const r = validateMedia({ mimeType: 'image/jpeg', sizeBytes: MAX_SIZES_BYTES.image });
    expect(r.valid).toBe(true);
  });
  test('tamano sobre limite = invalid size_exceeded', () => {
    const r = validateMedia({ mimeType: 'image/jpeg', sizeBytes: MAX_SIZES_BYTES.image + 1 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch('size_exceeded');
  });
  test('audio valido', () => {
    const r = validateMedia({ mimeType: 'audio/ogg', sizeBytes: 1024 * 1024 });
    expect(r.valid).toBe(true);
    expect(r.mediaType).toBe('audio');
  });
  test('video valido', () => {
    const r = validateMedia({ mimeType: 'video/mp4', sizeBytes: 10 * 1024 * 1024 });
    expect(r.valid).toBe(true);
    expect(r.mediaType).toBe('video');
  });
});

describe('buildMediaMeta', () => {
  test('retorna campos requeridos', () => {
    const m = buildMediaMeta({ mimeType: 'image/png', sizeBytes: 500 });
    expect(m.mediaType).toBe('image');
    expect(m.mimeType).toBe('image/png');
    expect(m.sizeBytes).toBe(500);
    expect(m.filename).toBeNull();
    expect(m.duration).toBeNull();
    expect(typeof m.createdAt).toBe('string');
  });
  test('incluye filename y duration si se pasan', () => {
    const m = buildMediaMeta({ mimeType: 'audio/mp4', sizeBytes: 2048, filename: 'nota.mp4', duration: 45 });
    expect(m.filename).toBe('nota.mp4');
    expect(m.duration).toBe(45);
  });
  test('null input no lanza', () => {
    const m = buildMediaMeta(null);
    expect(m.mediaType).toBeNull();
    expect(m.sizeBytes).toBe(0);
  });
});

describe('SUPPORTED_MIMES', () => {
  test('incluye mimes comunes', () => {
    expect(SUPPORTED_MIMES).toContain('image/jpeg');
    expect(SUPPORTED_MIMES).toContain('audio/ogg');
    expect(SUPPORTED_MIMES).toContain('application/pdf');
  });
});
