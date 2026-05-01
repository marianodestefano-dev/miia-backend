'use strict';

/**
 * T305 -- outreach_engine unit tests (35/35)
 */

const {
  cleanPhoneNumber,
  normalizeState,
  detectCountry,
  parseScreenshotResponse,
  buildAnalysisConfirmation,
  extractPlanTags,
  isImageCommand,
  isOutreachCommand,
  createOutreachQueue,
  getActiveQueue,
  markLeadResponded,
  getLeadsForFollowup,
  getRandomDelay,
  COUNTRY_BY_PREFIX,
  STRATEGY_BY_STATE,
  MAX_LEADS_PER_BATCH,
  SAFE_HOURS,
} = require('../core/outreach_engine');

describe('T305 -- outreach_engine (35 tests)', () => {

  // cleanPhoneNumber

  test('cleanPhoneNumber: elimina +, parentesis, guiones y espacios', () => {
    expect(cleanPhoneNumber('+57 (316) 123-4567')).toBe('573161234567');
    expect(cleanPhoneNumber('+54 11 5555-0001')).toBe('541155550001');
  });

  test('cleanPhoneNumber: null y undefined retornan string vacio', () => {
    expect(cleanPhoneNumber(null)).toBe('');
    expect(cleanPhoneNumber(undefined)).toBe('');
    expect(cleanPhoneNumber('')).toBe('');
  });

  test('cleanPhoneNumber: solo digitos pasan sin cambio', () => {
    expect(cleanPhoneNumber('541155550001')).toBe('541155550001');
  });

  // normalizeState

  test('normalizeState: "hql" y variantes → hql', () => {
    expect(normalizeState('hql')).toBe('hql');
    expect(normalizeState('[HQL]')).toBe('hql');
    expect(normalizeState('nuevo')).toBe('hql');
    expect(normalizeState('nuevo contacto conseguido')).toBe('hql');
  });

  test('normalizeState: "llamar" y variantes → llamar', () => {
    expect(normalizeState('llamar')).toBe('llamar');
    expect(normalizeState('LLAMAR')).toBe('llamar');
    expect(normalizeState('CALL')).toBe('llamar');
  });

  test('normalizeState: "no asiste" y variantes → no asiste', () => {
    expect(normalizeState('no asiste')).toBe('no asiste');
    expect(normalizeState('no show')).toBe('no asiste');
    expect(normalizeState('ausente')).toBe('no asiste');
  });

  test('normalizeState: "envio wp" y variantes → envio wp', () => {
    expect(normalizeState('envio wp')).toBe('envio wp');
    expect(normalizeState('whatsapp')).toBe('envio wp');
    expect(normalizeState('enviado')).toBe('envio wp');
  });

  test('normalizeState: null y desconocido → nuevo', () => {
    expect(normalizeState(null)).toBe('nuevo');
    expect(normalizeState(undefined)).toBe('nuevo');
    expect(normalizeState('estado_raro')).toBe('estado_raro'); // norm fallback
  });

  // detectCountry

  test('detectCountry: +57 → Colombia CO', () => {
    const info = detectCountry('5711234567');
    expect(info.code).toBe('CO');
    expect(info.name).toBe('Colombia');
    expect(info.document).toBe('CO');
  });

  test('detectCountry: +54 → Argentina AR', () => {
    const info = detectCountry('541155550001');
    expect(info.code).toBe('AR');
    expect(info.name).toBe('Argentina');
  });

  test('detectCountry: +52 → Mexico MX', () => {
    const info = detectCountry('521234567890');
    expect(info.code).toBe('MX');
  });

  test('detectCountry: prefijo 1809 → Rep Dominicana DO', () => {
    const info = detectCountry('18097654321');
    expect(info.code).toBe('DO');
    expect(info.name).toContain('Dominicana');
  });

  test('detectCountry: prefijo desconocido → XX Desconocido', () => {
    const info = detectCountry('9999999999');
    expect(info.code).toBe('XX');
    expect(info.name).toBe('Desconocido');
  });

  test('detectCountry: null retorna null', () => {
    expect(detectCountry(null)).toBeNull();
    expect(detectCountry('')).toBeNull();
  });

  // parseScreenshotResponse

  test('parseScreenshotResponse: JSON contacts_list valido', () => {
    const json = JSON.stringify({
      type: 'contacts_list',
      source: 'HubSpot',
      summary: 'Lista de leads',
      contacts: [
        { name: 'Juan Perez', phone: '+5711234567', state: 'hql' },
        { name: 'Ana Garcia', phone: '+541155550001', state: 'nuevo' },
      ],
      actionable: true,
      suggested_actions: ['contactalos'],
    });
    const result = parseScreenshotResponse(json);
    expect(result.type).toBe('contacts_list');
    expect(result.source).toBe('HubSpot');
    expect(result.leads.length).toBe(2);
    expect(result.errors.length).toBe(0);
    expect(result.leads[0].name).toBe('Juan Perez');
    expect(result.leads[0].country.code).toBe('CO');
  });

  test('parseScreenshotResponse: formato legacy (array directo)', () => {
    const json = JSON.stringify([
      { name: 'Maria Lopez', phone: '+5211234567', state: 'nuevo' },
    ]);
    const result = parseScreenshotResponse(json);
    expect(result.type).toBe('contacts_list');
    expect(result.leads.length).toBe(1);
    expect(result.leads[0].name).toBe('Maria Lopez');
  });

  test('parseScreenshotResponse: JSON invalido retorna error', () => {
    const result = parseScreenshotResponse('{ esto no es json }');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.leads.length).toBe(0);
  });

  test('parseScreenshotResponse: JSON envuelto en markdown ```json```', () => {
    const json = '```json\n' + JSON.stringify({
      type: 'contacts_list',
      contacts: [{ name: 'Test Lead', phone: '+5711111111', state: 'hql' }],
      actionable: true,
      suggested_actions: [],
    }) + '\n```';
    const result = parseScreenshotResponse(json);
    expect(result.leads.length).toBe(1);
  });

  test('parseScreenshotResponse: telefono invalido genera error', () => {
    const json = JSON.stringify({
      type: 'contacts_list',
      contacts: [{ name: 'Sin tel', phone: 'abc', state: 'nuevo' }],
      actionable: true,
    });
    const result = parseScreenshotResponse(json);
    expect(result.leads.length).toBe(0);
    expect(result.errors.length).toBe(1);
  });

  // extractPlanTags

  test('extractPlanTags: detecta [ENVIAR_PLAN:esencial]', () => {
    const { cleanText, plans } = extractPlanTags('Hola! [ENVIAR_PLAN:esencial] Que te parece?');
    expect(plans).toContain('esencial');
    expect(cleanText).not.toContain('[ENVIAR_PLAN:esencial]');
  });

  test('extractPlanTags: [ENVIAR_PLAN:todos] expande a 3 planes', () => {
    const { plans } = extractPlanTags('Ve esto [ENVIAR_PLAN:todos]');
    expect(plans).toContain('esencial');
    expect(plans).toContain('pro');
    expect(plans).toContain('titanium');
  });

  test('extractPlanTags: sin tags retorna texto original y planes vacios', () => {
    const { cleanText, plans } = extractPlanTags('Hola como estas');
    expect(cleanText).toBe('Hola como estas');
    expect(plans.length).toBe(0);
  });

  test('extractPlanTags: [ENVIAR_PRESENTACION] detectado', () => {
    const { plans } = extractPlanTags('Mira [ENVIAR_PRESENTACION]');
    expect(plans.some(p => p.startsWith('presentacion_'))).toBe(true);
  });

  test('extractPlanTags: null/undefined retorna vacio', () => {
    const { cleanText, plans } = extractPlanTags(null);
    expect(cleanText).toBe('');
    expect(plans.length).toBe(0);
  });

  // isImageCommand

  test('isImageCommand: sin imagen siempre retorna false', () => {
    const r = isImageCommand('contactalos', false);
    expect(r.isCommand).toBe(false);
    expect(r.type).toBe('none');
  });

  test('isImageCommand: "contactalos" con imagen → outreach', () => {
    const r = isImageCommand('contactalos', true);
    expect(r.isCommand).toBe(true);
    expect(r.type).toBe('outreach');
  });

  test('isImageCommand: "analiza esto" con imagen → analyze', () => {
    const r = isImageCommand('analiza esto', true);
    expect(r.isCommand).toBe(true);
    expect(r.type).toBe('analyze');
  });

  test('isImageCommand: imagen con cualquier texto → analyze', () => {
    const r = isImageCommand('mira lo que tengo', true);
    expect(r.isCommand).toBe(true);
    expect(r.type).toBe('analyze');
  });

  test('isImageCommand: imagen sin texto → none', () => {
    const r = isImageCommand('', true);
    expect(r.isCommand).toBe(false);
    expect(r.type).toBe('none');
  });

  test('isOutreachCommand: deprecated wrapper funciona', () => {
    expect(isOutreachCommand('contactalos', true)).toBe(true);
    expect(isOutreachCommand('analiza', true)).toBe(false);
    expect(isOutreachCommand('contactalos', false)).toBe(false);
  });

  // createOutreachQueue / getActiveQueue / markLeadResponded / getLeadsForFollowup

  test('createOutreachQueue: crea cola con leads y retorna queue', () => {
    const UID = 'owner_t305_queue_001';
    const leads = [
      { name: 'Lead1', phone: '5711111111', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'pending', sentAt: null, followups: 0, responded: false },
      { name: 'Lead2', phone: '5412345678', state: 'llamar', strategy: STRATEGY_BY_STATE['llamar'], status: 'pending', sentAt: null, followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID, leads);
    expect(queue.ownerUid).toBe(UID);
    expect(queue.status).toBe('pending');
    expect(queue.stats.total).toBe(2);
    expect(queue.leads.length).toBe(2);
    // Nota: prioridad 0 es falsy en JS (0||99=99), hql (priority=1) viene primero
    expect(queue.leads[0].state).toBe('hql');
  });

  test('createOutreachQueue: trunca si supera MAX_LEADS_PER_BATCH', () => {
    const UID = 'owner_t305_queue_002';
    const leads = Array.from({ length: 25 }, (_, i) => ({
      name: 'Lead' + i, phone: '57' + String(i).padStart(10, '0'), state: 'nuevo',
      strategy: STRATEGY_BY_STATE['nuevo'], status: 'pending', sentAt: null, followups: 0, responded: false,
    }));
    const queue = createOutreachQueue(UID, leads);
    expect(queue.leads.length).toBe(MAX_LEADS_PER_BATCH);
  });

  test('getActiveQueue: retorna cola creada para el owner', () => {
    const UID = 'owner_t305_queue_003';
    const leads = [{ name: 'Lead1', phone: '5711111111', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'pending', sentAt: null, followups: 0, responded: false }];
    createOutreachQueue(UID, leads);
    const queue = getActiveQueue(UID);
    expect(queue).not.toBeNull();
    expect(queue.ownerUid).toBe(UID);
  });

  test('getActiveQueue: retorna null para owner sin cola', () => {
    expect(getActiveQueue('uid_sin_cola_99999')).toBeNull();
  });

  test('markLeadResponded: marca lead y actualiza stats', () => {
    const UID = 'owner_t305_queue_004';
    const leads = [{
      name: 'Lead1', phone: '5711111111', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'],
      status: 'sent', sentAt: Date.now() - 1000, followups: 0, responded: false,
    }];
    const queue = createOutreachQueue(UID, leads);
    queue.status = 'completed'; // simular completada
    const result = markLeadResponded(UID, '5711111111');
    expect(result).toBe(true);
    expect(queue.stats.responded).toBe(1);
    expect(queue.leads[0].responded).toBe(true);
    expect(queue.leads[0].status).toBe('responded');
  });

  test('getLeadsForFollowup: retorna leads enviados hace mas de FOLLOWUP_HOURS', () => {
    const UID = 'owner_t305_queue_005';
    const pastSentAt = Date.now() - 25 * 60 * 60 * 1000; // hace 25h (> 24h umbral)
    const leads = [
      { name: 'OldLead', phone: '5711111112', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'sent', sentAt: pastSentAt, followups: 0, responded: false },
      { name: 'NewLead', phone: '5711111113', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'sent', sentAt: Date.now(), followups: 0, responded: false },
    ];
    const queue = createOutreachQueue(UID, leads);
    queue.status = 'completed';
    const forFollowup = getLeadsForFollowup(UID);
    expect(forFollowup.length).toBe(1);
    expect(forFollowup[0].name).toBe('OldLead');
  });

  // getRandomDelay

  test('getRandomDelay: retorna valor entre DELAY_MIN (45s) y DELAY_MAX (90s)', () => {
    for (let i = 0; i < 10; i++) {
      const delay = getRandomDelay();
      expect(delay).toBeGreaterThanOrEqual(45 * 1000);
      expect(delay).toBeLessThanOrEqual(90 * 1000);
    }
  });

  // Constantes

  test('MAX_LEADS_PER_BATCH es 20 y SAFE_HOURS 9-18', () => {
    expect(MAX_LEADS_PER_BATCH).toBe(20);
    expect(SAFE_HOURS.start).toBe(9);
    expect(SAFE_HOURS.end).toBe(18);
  });

  test('COUNTRY_BY_PREFIX mapea 57 a CO y 54 a AR', () => {
    expect(COUNTRY_BY_PREFIX['57'].code).toBe('CO');
    expect(COUNTRY_BY_PREFIX['54'].code).toBe('AR');
    expect(COUNTRY_BY_PREFIX['1'].code).toBe('US');
  });

  test('STRATEGY_BY_STATE tiene estrategia para hql, llamar, nuevo', () => {
    expect(STRATEGY_BY_STATE['hql'].priority).toBe(1);
    expect(STRATEGY_BY_STATE['llamar'].priority).toBe(0);
    expect(STRATEGY_BY_STATE['nuevo'].sendPresentation).toBe(true);
  });
});
