'use strict';

/**
 * T180 - Tests E2E Bloque 3
 * Flujos completos que combinan modulos del Piso 3 + Piso 4 base.
 * Cada test simula un escenario real de principio a fin.
 */

const { detectSector } = require('../core/sector_detector');
const { calculateScore, INTERACTION_WEIGHTS } = require('../core/lead_scorer');
const { detectLanguage } = require('../core/language_detector');
const { buildOOOResponse } = require('../core/out_of_office');
const { filterDueNotifications } = require('../core/availability_notifier');
const { suggestReplies } = require('../core/quick_replies');
const { segmentAudience, calculateOptimalSendTime } = require('../core/broadcast_v2');

const NOW = new Date('2026-05-04T15:00:00.000Z').getTime();

describe('E2E: Flujo lead sector food con scoring', () => {
  test('detecta sector + calcula score lead activo', () => {
    const sectorResult = detectSector('tenemos un restaurante de pizza y hamburguesas con delivery');
    expect(sectorResult.sector).toBe('food');

    const interactions = [
      { type: 'message_sent', timestamp: new Date(NOW - 1000).toISOString() },
      { type: 'price_inquiry', timestamp: new Date(NOW - 2000).toISOString() },
      { type: 'appointment_request', timestamp: new Date(NOW - 3000).toISOString() },
      { type: 'catalog_view', timestamp: new Date(NOW - 4000).toISOString() },
    ];
    const scoreResult = calculateScore(interactions, NOW);
    expect(scoreResult.score).toBeGreaterThanOrEqual(15);
    expect(scoreResult.level).not.toBe('cold');
  });

  test('lead cold decay correcto', () => {
    const oldTs = new Date(NOW - 35 * 24 * 60 * 60 * 1000).toISOString();
    const interactions = [{ type: 'catalog_purchase', timestamp: oldTs }];
    const r = calculateScore(interactions, NOW);
    expect(r.score).toBe(0);
    expect(r.level).toBe('cold');
  });

  test('compra sube a hot rapidamente', () => {
    const interactions = Array.from({ length: 4 }, () => ({
      type: 'catalog_purchase',
      timestamp: new Date(NOW).toISOString(),
    }));
    const r = calculateScore(interactions, NOW);
    expect(r.level).toBe('hot');
  });
});

describe('E2E: Flujo notificaciones de disponibilidad', () => {
  test('filtra notificaciones vencidas correctamente', () => {
    const pending = [
      { nextOpenAt: '2026-05-04T14:00', phone: '+1111111111' },
      { nextOpenAt: '2026-05-04T16:00', phone: '+2222222222' },
      { nextOpenAt: '2026-05-04T13:00', phone: '+3333333333' },
    ];
    const due = filterDueNotifications(pending, NOW);
    expect(due.length).toBe(2);
    const phones = due.map(d => d.phone);
    expect(phones).toContain('+1111111111');
    expect(phones).toContain('+3333333333');
    expect(phones).not.toContain('+2222222222');
  });

  test('retorna vacio si ninguna vencio', () => {
    const pending = [{ nextOpenAt: '2026-05-04T20:00', phone: '+1111111111' }];
    expect(filterDueNotifications(pending, NOW)).toEqual([]);
  });

  test('ignora entradas sin nextOpenAt', () => {
    const pending = [
      { phone: '+1111111111' },
      { nextOpenAt: '2026-05-04T14:00', phone: '+2222222222' },
    ];
    const due = filterDueNotifications(pending, NOW);
    expect(due.length).toBe(1);
    expect(due[0].phone).toBe('+2222222222');
  });
});


describe('E2E: Flujo deteccion idioma + respuesta quick replies', () => {
  test('detecta ingles correctamente para texto de lead', () => {
    const r = detectLanguage('hello how are you good morning what is the price please help me');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThan(0);
  });

  test('detecta espanol para texto en espanol', () => {
    const r = detectLanguage('hola como estas buenas tardes quiero saber el precio por favor ayuda');
    expect(r.language).toBe('es');
    expect(r.confidence).toBeGreaterThan(0);
  });

  test('sugiere respuesta rapida segun mensaje del lead', () => {
    const replies = [
      { id: '1', shortcut: '/precio', text: 'Nuestros precios son...', tags: ['pricing'], active: true },
      { id: '2', shortcut: '/horario', text: 'Abrimos de lunes a viernes...', tags: ['hours'], active: true },
      { id: '3', shortcut: '/hola', text: 'Bienvenido!', tags: ['greeting'], active: true },
    ];
    const suggested = suggestReplies(replies, 'hola como estas');
    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested[0].shortcut).toBe('/hola');
  });

  test('no sugiere respuestas inactivas', () => {
    const replies = [
      { id: '1', shortcut: '/precio', text: 'Nuestros precios son...', active: false },
    ];
    const suggested = suggestReplies(replies, 'precio');
    expect(suggested.length).toBe(0);
  });
});

describe('E2E: Flujo Out of Office', () => {
  test('construye respuesta OOO con mensaje default', () => {
    const oooState = { active: true, message: null };
    const resp = buildOOOResponse(oooState, { phone: '+541155667788' });
    expect(resp.length).toBeGreaterThan(0);
  });

  test('construye respuesta OOO con returnAt', () => {
    const returnAt = new Date(NOW + 4 * 60 * 60 * 1000).toISOString();
    const oooState = { active: true, message: 'Estoy fuera de la oficina.', returnAt };
    const resp = buildOOOResponse(oooState, {});
    expect(resp).toContain('Estoy fuera de la oficina.');
    expect(resp).toContain('disponible');
  });

  test('lanza si OOO no activo', () => {
    expect(() => buildOOOResponse({ active: false, message: 'test' }, {})).toThrow('no esta activo');
  });
});

describe('E2E: Flujo broadcast con segmentacion y timing', () => {
  test('segmenta audiencia por tags AND', () => {
    const contacts = [
      { phone: '+1111', tags: ['cliente', 'promo'] },
      { phone: '+2222', tags: ['cliente'] },
      { phone: '+3333', tags: ['promo', 'vip'] },
      { phone: '+4444', tags: ['cliente', 'promo', 'vip'] },
    ];
    const segmented = segmentAudience(contacts, ['cliente', 'promo']);
    expect(segmented.length).toBe(2);
    const phones = segmented.map(c => c.phone);
    expect(phones).toContain('+1111');
    expect(phones).toContain('+4444');
  });

  test('calcula horario optimo dentro de ventana', () => {
    const noonMs = new Date('2026-05-04T14:00:00.000Z').getTime();
    const r = calculateOptimalSendTime(noonMs, 'America/Argentina/Buenos_Aires');
    expect(r.isOptimal).toBe(true);
  });

  test('calcula horario optimo fuera de ventana nocturna', () => {
    const nightMs = new Date('2026-05-04T03:00:00.000Z').getTime();
    const r = calculateOptimalSendTime(nightMs, 'America/Argentina/Buenos_Aires');
    expect(r.isOptimal).toBe(false);
    expect(r.scheduledAt).toBeDefined();
  });

  test('broadcast sin tags devuelve todos los contactos', () => {
    const contacts = [
      { phone: '+1111', tags: ['a'] },
      { phone: '+2222', tags: ['b'] },
    ];
    expect(segmentAudience(contacts, [])).toEqual(contacts);
  });
});

describe('E2E: Scoring acumulativo multi-tipo', () => {
  test('INTERACTION_WEIGHTS tiene jerarquia correcta', () => {
    expect(INTERACTION_WEIGHTS.message_sent).toBeLessThan(INTERACTION_WEIGHTS.price_inquiry);
    expect(INTERACTION_WEIGHTS.price_inquiry).toBeLessThan(INTERACTION_WEIGHTS.appointment_request);
    expect(INTERACTION_WEIGHTS.appointment_request).toBeLessThan(INTERACTION_WEIGHTS.payment_initiated);
    expect(INTERACTION_WEIGHTS.payment_initiated).toBeLessThan(INTERACTION_WEIGHTS.catalog_purchase);
  });

  test('mix de interacciones genera score correcto', () => {
    const interactions = [
      { type: 'message_sent', timestamp: new Date(NOW).toISOString() },
      { type: 'catalog_view', timestamp: new Date(NOW).toISOString() },
      { type: 'price_inquiry', timestamp: new Date(NOW).toISOString() },
      { type: 'appointment_request', timestamp: new Date(NOW).toISOString() },
    ];
    const r = calculateScore(interactions, NOW);
    const expectedMin = INTERACTION_WEIGHTS.message_sent + INTERACTION_WEIGHTS.catalog_view +
      INTERACTION_WEIGHTS.price_inquiry + INTERACTION_WEIGHTS.appointment_request;
    expect(r.score).toBeGreaterThanOrEqual(expectedMin);
  });

  test('score cap a 100', () => {
    const interactions = Array.from({ length: 20 }, () => ({
      type: 'catalog_purchase', timestamp: new Date(NOW).toISOString(),
    }));
    expect(calculateScore(interactions, NOW).score).toBe(100);
  });
});
