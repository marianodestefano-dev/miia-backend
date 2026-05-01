'use strict';
const { extractTags, extractTagsOfType, hasTags, stripTags, VALID_TAGS } = require('../core/tag_extractor');

describe('VALID_TAGS', () => {
  test('contiene los tags principales', () => {
    expect(VALID_TAGS).toContain('AGENDAR_EVENTO');
    expect(VALID_TAGS).toContain('SOLICITAR_TURNO');
    expect(VALID_TAGS).toContain('GENERAR_COTIZACION');
    expect(VALID_TAGS).toContain('RECORDATORIO');
    expect(VALID_TAGS).toContain('APRENDER');
  });
});

describe('extractTags — validacion', () => {
  test('null retorna tags vacio', () => {
    const r = extractTags(null);
    expect(r.tags).toEqual([]);
    expect(r.clean).toBe('');
  });
  test('texto sin tags retorna array vacio', () => {
    const r = extractTags('hola como estas?');
    expect(r.tags).toEqual([]);
    expect(r.clean).toBe('hola como estas?');
  });
});

describe('extractTags — AGENDAR_EVENTO', () => {
  test('extrae tag AGENDAR_EVENTO', () => {
    const text = 'Perfecto! [AGENDAR_EVENTO:+573001234567|2024-05-01T10:00|consulta] listo!';
    const r = extractTags(text);
    expect(r.tags.length).toBe(1);
    expect(r.tags[0].type).toBe('AGENDAR_EVENTO');
    expect(r.tags[0].payload).toBe('+573001234567|2024-05-01T10:00|consulta');
  });
  test('clean no contiene el tag', () => {
    const text = 'ok [AGENDAR_EVENTO:payload] confirmado';
    const r = extractTags(text);
    expect(r.clean).not.toContain('[AGENDAR_EVENTO');
  });
});

describe('extractTags — multiples tags', () => {
  test('extrae dos tags diferentes', () => {
    const text = '[AGENDAR_EVENTO:p1] texto [RECORDATORIO:p2]';
    const r = extractTags(text);
    expect(r.tags.length).toBe(2);
    const types = r.tags.map(t => t.type);
    expect(types).toContain('AGENDAR_EVENTO');
    expect(types).toContain('RECORDATORIO');
  });
  test('extrae dos tags del mismo tipo', () => {
    const text = '[APRENDER:instruccion1] [APRENDER:instruccion2]';
    const r = extractTags(text);
    const aprender = r.tags.filter(t => t.type === 'APRENDER');
    expect(aprender.length).toBe(2);
  });
});

describe('extractTags — SOLICITAR_TURNO y CANCELAR_EVENTO', () => {
  test('extrae SOLICITAR_TURNO', () => {
    const r = extractTags('[SOLICITAR_TURNO:phone|fecha|motivo]');
    expect(r.tags[0].type).toBe('SOLICITAR_TURNO');
  });
  test('extrae CANCELAR_EVENTO', () => {
    const r = extractTags('[CANCELAR_EVENTO:eventId123]');
    expect(r.tags[0].type).toBe('CANCELAR_EVENTO');
  });
  test('extrae MOVER_EVENTO', () => {
    const r = extractTags('[MOVER_EVENTO:id|nuevaFecha]');
    expect(r.tags[0].type).toBe('MOVER_EVENTO');
  });
});

describe('extractTagsOfType', () => {
  test('lanza si tagType invalido', () => {
    expect(() => extractTagsOfType('texto', 'NO_EXISTE')).toThrow('tagType invalido');
  });
  test('filtra por tipo correctamente', () => {
    const text = '[APRENDER:a] [AGENDAR_EVENTO:b] [APRENDER:c]';
    const r = extractTagsOfType(text, 'APRENDER');
    expect(r.length).toBe(2);
    expect(r.every(t => t.type === 'APRENDER')).toBe(true);
  });
});

describe('hasTags', () => {
  test('true si hay tag', () => {
    expect(hasTags('texto [APRENDER:algo] mas')).toBe(true);
  });
  test('false si no hay tag', () => {
    expect(hasTags('texto sin tags')).toBe(false);
  });
  test('null retorna false', () => {
    expect(hasTags(null)).toBe(false);
  });
});

describe('stripTags', () => {
  test('remueve todos los tags', () => {
    const text = 'Mensaje [AGENDAR_EVENTO:payload] enviado [APRENDER:algo]';
    const clean = stripTags(text);
    expect(clean).not.toContain('[AGENDAR_EVENTO');
    expect(clean).not.toContain('[APRENDER');
    expect(clean).toContain('Mensaje');
  });
});
