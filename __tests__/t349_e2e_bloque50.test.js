'use strict';

/**
 * T349 -- E2E Bloque 50
 * Pipeline: tag_extractor -> response_cache -> template_engine
 */

const { extractTags, extractTagsOfType, hasTags, stripTags } = require('../core/tag_extractor');
const { ResponseCache, buildCacheKey } = require('../core/response_cache');
const { buildTemplateRecord, renderTemplate, validateTemplate } = require('../core/template_engine');

const UID = 'owner_bloque50_001';

describe('T349 -- E2E Bloque 50: tag_extractor + response_cache + template_engine', () => {

  test('Paso 1 -- tag AGENDAR_EVENTO extraido de respuesta LLM', () => {
    const llmResponse = 'Claro, te agendo la reunion! [AGENDAR_EVENTO:Carlos|2026-05-10T10:00|Demo MIIA]';
    const { tags, clean } = extractTags(llmResponse);
    expect(tags.length).toBe(1);
    expect(tags[0].type).toBe('AGENDAR_EVENTO');
    expect(tags[0].payload).toContain('Demo MIIA');
    expect(clean).toContain('Claro');
    expect(clean).not.toContain('[AGENDAR_EVENTO:');
  });

  test('Paso 2 -- response cache hit/miss', () => {
    const cache = new ResponseCache({ ttlMs: 60000 });
    const key = buildCacheKey('precio del plan pro', 'ctx_lead_001');
    expect(cache.get(key)).toBeNull(); // miss

    cache.set(key, 'El plan pro cuesta $99/mes');
    const hit = cache.get(key);
    expect(hit).toBe('El plan pro cuesta $99/mes');
  });

  test('Paso 3 -- template appointment_reminder renderizado', () => {
    const tpl = buildTemplateRecord(UID, {
      name: 'Recordatorio de Turno',
      type: 'appointment_reminder',
      body: 'Hola {{name}}, te recordamos tu turno el {{date}} a las {{time}}. Nos vemos!',
    });
    const { rendered, complete } = renderTemplate(tpl, {
      name: 'Ana Gomez', date: '10 de mayo', time: '10:00 AM',
    });
    expect(complete).toBe(true);
    expect(rendered).toContain('Ana Gomez');
    expect(rendered).toContain('10 de mayo');
    expect(rendered).toContain('10:00 AM');
  });

  test('Paso 4 -- extractTagsOfType APRENDER filtra solo ese tipo', () => {
    const text = '[AGENDAR_EVENTO:Ana|2026-05-10|demo] Los precios cambian en junio. [APRENDER:precio_plan_pro=$99/mes]';
    const aprenderTags = extractTagsOfType(text, 'APRENDER');
    expect(aprenderTags.length).toBe(1);
    expect(aprenderTags[0].payload).toContain('$99/mes');
  });

  test('Paso 5 -- buildCacheKey + cache set/get round-trip', () => {
    const cache = new ResponseCache({ ttlMs: 30000 });
    const key = buildCacheKey('cuanto cuesta plan basico', 'uid_001');
    expect(key).not.toBeNull();
    expect(key.length).toBe(16);

    cache.set(key, 'El plan basico cuesta $49/mes');
    expect(cache.get(key)).toBe('El plan basico cuesta $49/mes');
    expect(cache.size).toBe(1);
  });

  test('Paso 6 -- validateTemplate + renderTemplate con variables', () => {
    const tpl = buildTemplateRecord(UID, {
      name: 'Bienvenida',
      type: 'welcome',
      body: 'Bienvenido {{name}}! Somos {{business}} y te ayudaremos con {{service}}.',
    });
    const valid = validateTemplate(tpl);
    expect(valid.valid).toBe(true);

    const { rendered, complete } = renderTemplate(tpl, {
      name: 'Luis', business: 'Restaurante ACME', service: 'reservas',
    });
    expect(complete).toBe(true);
    expect(rendered).toContain('Luis');
    expect(rendered).toContain('Restaurante ACME');
    expect(rendered).toContain('reservas');
  });

  test('Pipeline completo -- extract tags + cache + template', () => {
    const cache = new ResponseCache({ ttlMs: 60000 });

    // A: Generar clave de cache para mensaje del lead
    const msg = 'quiero saber cuanto cuesta el plan pro para mi negocio';
    const cacheKey = buildCacheKey(msg, UID);
    expect(cacheKey).not.toBeNull();

    // B: Cache miss -> "generar" respuesta LLM (simulada)
    let response = cache.get(cacheKey);
    expect(response).toBeNull();

    const llmResponse = 'El plan pro cuesta $99/mes e incluye automatizacion completa. [APRENDER:precio_plan_pro=$99]';
    cache.set(cacheKey, llmResponse);

    // C: Extraer tags de la respuesta LLM
    const { tags, clean } = extractTags(llmResponse);
    expect(tags.some(t => t.type === 'APRENDER')).toBe(true);
    expect(clean).toContain('$99/mes');

    // D: Cache hit para mismo mensaje
    const cached = cache.get(cacheKey);
    expect(cached).toBe(llmResponse);

    // E: Usar template para respuesta formateada
    const tpl = buildTemplateRecord(UID, {
      name: 'Precio Plan',
      body: 'Hola {{name}}! El plan pro cuesta $99/mes.',
    });
    const { rendered } = renderTemplate(tpl, { name: 'Carlos' });
    expect(rendered).toContain('Carlos');
    expect(rendered).toContain('$99/mes');
  });
});
