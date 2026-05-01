'use strict';

const {
  extractTags, extractTagsOfType, hasTags, stripTags,
  TAG_PATTERNS, VALID_TAGS,
} = require('../core/tag_extractor');

const { ResponseCache, buildCacheKey, DEFAULT_TTL_MS, DEFAULT_MAX_SIZE } = require('../core/response_cache');

const {
  buildTemplateRecord, renderTemplate, validateTemplate,
  extractVariables,
  TEMPLATE_TYPES, TEMPLATE_CHANNELS, TEMPLATE_LANGUAGES,
  MAX_BODY_LENGTH, MAX_VARIABLES_PER_TEMPLATE,
} = require('../core/template_engine');

const UID = 'uid_t348';

describe('T348 -- tag_extractor + response_cache + template_engine (30 tests)', () => {

  // VALID_TAGS
  test('VALID_TAGS frozen, contiene los tipos de tag soportados', () => {
    expect(() => { VALID_TAGS.push('HACK'); }).toThrow();
    expect(VALID_TAGS).toContain('AGENDAR_EVENTO');
    expect(VALID_TAGS).toContain('SOLICITAR_TURNO');
    expect(VALID_TAGS).toContain('APRENDER');
    expect(VALID_TAGS).toContain('RECORDATORIO');
    expect(VALID_TAGS).toContain('GENERAR_COTIZACION');
  });

  // extractTags
  test('extractTags: null/empty -> {tags:[], clean:""}', () => {
    const r1 = extractTags(null);
    expect(r1.tags).toEqual([]);
    expect(r1.clean).toBe('');
    const r2 = extractTags('');
    expect(r2.tags).toEqual([]);
  });

  test('extractTags: texto sin tags -> {tags:[], clean:texto}', () => {
    const r = extractTags('hola como estas necesito informacion');
    expect(r.tags).toEqual([]);
    expect(r.clean).toBe('hola como estas necesito informacion');
  });

  test('extractTags: [AGENDAR_EVENTO:params] -> tag tipo AGENDAR_EVENTO extraido', () => {
    const text = 'Perfecto, te agendo! [AGENDAR_EVENTO:Juan|2026-05-10|reunion de ventas]';
    const r = extractTags(text);
    expect(r.tags.length).toBe(1);
    expect(r.tags[0].type).toBe('AGENDAR_EVENTO');
    expect(r.tags[0].payload).toBe('Juan|2026-05-10|reunion de ventas');
    expect(r.clean).not.toContain('[AGENDAR_EVENTO:');
  });

  test('extractTags: [APRENDER:instruccion] -> tag tipo APRENDER', () => {
    const text = 'Recordado. [APRENDER:Los pedidos se entregan en 3 dias habiles]';
    const r = extractTags(text);
    const aprender = r.tags.find(t => t.type === 'APRENDER');
    expect(aprender).toBeDefined();
    expect(aprender.payload).toContain('3 dias habiles');
  });

  test('extractTags: multiples tags -> todos extraidos', () => {
    const text = '[AGENDAR_EVENTO:Ana|2026-05-10|demo] Voy a aprender esto. [APRENDER:precio=$99]';
    const r = extractTags(text);
    expect(r.tags.length).toBe(2);
    const tipos = r.tags.map(t => t.type);
    expect(tipos).toContain('AGENDAR_EVENTO');
    expect(tipos).toContain('APRENDER');
  });

  // extractTagsOfType
  test('extractTagsOfType: tagType invalido lanza', () => {
    expect(() => extractTagsOfType('texto', 'HACK_TAG')).toThrow('tagType invalido');
  });

  test('extractTagsOfType: filtra correctamente por tipo', () => {
    const text = '[AGENDAR_EVENTO:A|2026-05-10|demo] [APRENDER:algo util]';
    const agendarTags = extractTagsOfType(text, 'AGENDAR_EVENTO');
    expect(agendarTags.length).toBe(1);
    expect(agendarTags[0].type).toBe('AGENDAR_EVENTO');
    const aprenderTags = extractTagsOfType(text, 'APRENDER');
    expect(aprenderTags.length).toBe(1);
  });

  // hasTags
  test('hasTags: texto sin tags -> false', () => {
    expect(hasTags('hola como estas')).toBe(false);
    expect(hasTags(null)).toBe(false);
  });

  test('hasTags: texto con tag -> true', () => {
    expect(hasTags('[AGENDAR_EVENTO:params]')).toBe(true);
    expect(hasTags('[APRENDER:algo]')).toBe(true);
  });

  // stripTags
  test('stripTags: texto con tag -> texto limpio', () => {
    const r = stripTags('Perfecto! [AGENDAR_EVENTO:A|2026-05-10|demo] Hasta pronto.');
    expect(r).not.toContain('[AGENDAR_EVENTO:');
    expect(r).toContain('Perfecto');
  });

  // ResponseCache constants
  test('DEFAULT_TTL_MS = 5 minutos, DEFAULT_MAX_SIZE = 500', () => {
    expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_MAX_SIZE).toBe(500);
  });

  // ResponseCache constructor
  test('ResponseCache: ttlMs<=0 lanza, maxSize<=0 lanza', () => {
    expect(() => new ResponseCache({ ttlMs: 0 })).toThrow('ttlMs debe ser > 0');
    expect(() => new ResponseCache({ maxSize: 0 })).toThrow('maxSize debe ser > 0');
  });

  // buildCacheKey
  test('buildCacheKey: null prompt -> null', () => {
    expect(buildCacheKey(null)).toBeNull();
  });

  test('buildCacheKey: mismo prompt -> mismo key (deterministico)', () => {
    const k1 = buildCacheKey('hola como estas', 'ctx123');
    const k2 = buildCacheKey('hola como estas', 'ctx123');
    expect(k1).toBe(k2);
    expect(typeof k1).toBe('string');
    expect(k1.length).toBe(16);
  });

  // ResponseCache.set/get
  test('ResponseCache.set: key null lanza', () => {
    const cache = new ResponseCache();
    expect(() => cache.set(null, 'respuesta')).toThrow('key requerida');
  });

  test('ResponseCache.set: response null lanza', () => {
    const cache = new ResponseCache();
    expect(() => cache.set('key1', null)).toThrow('response requerida');
  });

  test('ResponseCache.get: key no existente -> null', () => {
    const cache = new ResponseCache();
    expect(cache.get('nonexistent_key')).toBeNull();
  });

  test('ResponseCache.get: key existente dentro TTL -> respuesta', () => {
    const cache = new ResponseCache({ ttlMs: 60000 });
    const NOW = 1000000;
    cache.set('key1', 'hola, soy MIIA', NOW);
    const r = cache.get('key1', NOW + 1000);
    expect(r).toBe('hola, soy MIIA');
  });

  test('ResponseCache.get: key expirada -> null', () => {
    const cache = new ResponseCache({ ttlMs: 5000 });
    const NOW = 1000000;
    cache.set('key1', 'respuesta', NOW);
    const r = cache.get('key1', NOW + 6000); // 6s > 5s TTL
    expect(r).toBeNull();
  });

  test('ResponseCache.size + getStats()', () => {
    const cache = new ResponseCache();
    cache.set('k1', 'resp1');
    cache.set('k2', 'resp2');
    expect(cache.size).toBe(2);
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.maxSize).toBe(DEFAULT_MAX_SIZE);
    expect(typeof stats.totalHits).toBe('number');
  });

  test('ResponseCache.clear: vacia todo', () => {
    const cache = new ResponseCache();
    cache.set('k1', 'resp1');
    cache.set('k2', 'resp2');
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  // template_engine
  test('TEMPLATE_TYPES/CHANNELS/LANGUAGES frozen', () => {
    expect(() => { TEMPLATE_TYPES.push('hack'); }).toThrow();
    expect(() => { TEMPLATE_CHANNELS.push('hack'); }).toThrow();
    expect(() => { TEMPLATE_LANGUAGES.push('hack'); }).toThrow();
    expect(TEMPLATE_TYPES).toContain('greeting');
    expect(TEMPLATE_TYPES).toContain('appointment_reminder');
    expect(TEMPLATE_CHANNELS).toContain('whatsapp');
    expect(TEMPLATE_LANGUAGES).toContain('es');
  });

  test('extractVariables: texto con {{var1}} {{var2}} -> [var1, var2]', () => {
    const vars = extractVariables('Hola {{name}}, tu turno es el {{date}} a las {{time}}');
    expect(vars).toContain('name');
    expect(vars).toContain('date');
    expect(vars).toContain('time');
    expect(vars.length).toBe(3);
  });

  test('extractVariables: sin variables -> []', () => {
    expect(extractVariables('Hola como estas')).toEqual([]);
    expect(extractVariables(null)).toEqual([]);
  });

  test('buildTemplateRecord: genera templateId con variables extraidas', () => {
    const r = buildTemplateRecord(UID, {
      name: 'Recordatorio de turno',
      type: 'appointment_reminder',
      channel: 'whatsapp',
      body: 'Hola {{name}}, tu turno es el {{date}}',
    });
    expect(r.templateId).toBeDefined();
    expect(r.variables).toContain('name');
    expect(r.variables).toContain('date');
    expect(r.active).toBe(true);
    expect(r.uid).toBe(UID);
  });

  test('buildTemplateRecord: type invalido -> custom, channel invalido -> whatsapp', () => {
    const r = buildTemplateRecord(UID, {
      name: 'Test',
      type: 'hack_type',
      channel: 'fax',
      body: 'hola',
    });
    expect(r.type).toBe('custom');
    expect(r.channel).toBe('whatsapp');
  });

  test('renderTemplate: template invalido lanza', () => {
    expect(() => renderTemplate(null, {})).toThrow('template invalido');
    expect(() => renderTemplate({}, {})).toThrow('template invalido');
  });

  test('renderTemplate: variables completas -> rendered + complete=true', () => {
    const tpl = buildTemplateRecord(UID, {
      name: 'Greeting',
      body: 'Hola {{name}}, bienvenido a {{business}}!',
    });
    const { rendered, missing, complete } = renderTemplate(tpl, { name: 'Ana', business: 'MIIA' });
    expect(rendered).toBe('Hola Ana, bienvenido a MIIA!');
    expect(missing).toEqual([]);
    expect(complete).toBe(true);
  });

  test('renderTemplate: variable faltante -> missing + complete=false', () => {
    const tpl = buildTemplateRecord(UID, {
      name: 'Reminder',
      body: 'Tu turno {{date}} a las {{time}}',
    });
    const { rendered, missing, complete } = renderTemplate(tpl, { date: '2026-05-10' });
    expect(missing).toContain('time');
    expect(complete).toBe(false);
  });

  test('validateTemplate: name vacio -> invalid, body vacio -> invalid', () => {
    expect(validateTemplate({ name: '', body: 'algo' }).valid).toBe(false);
    expect(validateTemplate({ name: 'Test', body: '' }).valid).toBe(false);
  });

  test('validateTemplate: template valido -> {valid:true, errors:[]}', () => {
    const r = validateTemplate({ name: 'Turno', body: 'Tu turno es {{date}}', variables: ['date'] });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
