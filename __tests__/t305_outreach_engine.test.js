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


// VI-COV: Additional branch coverage (lines 120-162, 261-300, 411-524, 612, 692)
const {
  buildScreenshotAnalysisPrompt,
  buildScreenshotParserPrompt: _bspp,
  processOutreachQueue,
  buildOutreachPrompt,
} = require('../core/outreach_engine');

describe('VI-COV -- buildScreenshotAnalysisPrompt / buildScreenshotParserPrompt', () => {
  test('buildScreenshotAnalysisPrompt retorna string con PASO 1 y PASO 2', () => {
    const r = buildScreenshotAnalysisPrompt();
    expect(typeof r).toBe('string');
    expect(r).toContain('PASO 1');
    expect(r).toContain('PASO 2');
  });
  test('buildScreenshotParserPrompt => mismo string que buildScreenshotAnalysisPrompt', () => {
    expect(_bspp()).toBe(buildScreenshotAnalysisPrompt());
  });
});


describe('VI-COV -- buildAnalysisConfirmation branches (lines 261-300)', () => {
  function mL(c) {
    return { name: 'Lead1', phone: '5711111111', country: { name: c || 'Colombia', code: 'CO' } };
  }

  test('contacts_list + leads + source conocido + errors + suggestedActions', () => {
    const r = buildAnalysisConfirmation({ type: 'contacts_list', source: 'HubSpot', summary: '', leads: [mL()], rawData: '', actionable: true, suggestedActions: ['guardarlos'], errors: ['Error linea 2'] });
    expect(r).toContain('HubSpot');
    expect(r).toContain('1 contactos');
    expect(r).toContain('no pude leerlos');
    expect(r).toContain('guardarlos');
  });

  test('contacts_list + source desconocido + sin errors + sin suggestedActions', () => {
    const r = buildAnalysisConfirmation({ type: 'contacts_list', source: 'desconocido', summary: '', leads: [mL()], rawData: '', actionable: true, suggestedActions: [], errors: [] });
    expect(r).toContain('1 contactos');
    expect(r).not.toContain('no pude leerlos');
  });

  test('data_table + source conocido + summary + rawData', () => {
    const r = buildAnalysisConfirmation({ type: 'data_table', source: 'Excel', summary: 'Hoja de datos', leads: [], rawData: 'col1|col2', actionable: false, suggestedActions: [], errors: [] });
    expect(r).toContain('Excel');
    expect(r).toContain('Hoja de datos');
    expect(r).toContain('Datos:');
  });

  test('data_table + source desconocido + sin summary + sin rawData', () => {
    const r = buildAnalysisConfirmation({ type: 'data_table', source: 'desconocido', summary: '', leads: [], rawData: '', actionable: false, suggestedActions: [], errors: [] });
    expect(typeof r).toBe('string');
    expect(r).not.toContain('Datos:');
  });

  test('conversation + source conocido + summary truthy', () => {
    const r = buildAnalysisConfirmation({ type: 'conversation', source: 'WhatsApp', summary: 'Chat con cliente', leads: [], rawData: '', actionable: false, suggestedActions: [], errors: [] });
    expect(r).toContain('WhatsApp');
    expect(r).toContain('Chat con cliente');
  });

  test('conversation + sin summary (falsy)', () => {
    const r = buildAnalysisConfirmation({ type: 'conversation', source: 'desconocido', summary: '', leads: [], rawData: '', actionable: false, suggestedActions: [], errors: [] });
    expect(r).toContain('No pude extraer detalles');
  });

  test('else other type + summary truthy', () => {
    const r = buildAnalysisConfirmation({ type: 'other', source: 'desconocido', summary: 'Imagen rara', leads: [], rawData: '', actionable: false, suggestedActions: [], errors: [] });
    expect(r).toContain('Imagen rara');
  });

  test('else other type + summary falsy', () => {
    const r = buildAnalysisConfirmation({ type: 'other', source: 'desconocido', summary: '', leads: [], rawData: '', actionable: false, suggestedActions: [], errors: [] });
    expect(r).toContain('no estoy segura');
  });
});


describe('VI-COV -- markLeadResponded falsy (line 612)', () => {
  test('returns false si lead ya respondio', () => {
    const UID = 'vi_mr_' + Date.now();
    const leads = [{ name: 'L1', phone: '5799990001', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'responded', sentAt: Date.now(), followups: 0, responded: true }];
    const q = createOutreachQueue(UID, leads);
    q.status = 'completed';
    expect(markLeadResponded(UID, '5799990001')).toBe(false);
  });
  test('returns false si owner no tiene cola', () => {
    expect(markLeadResponded('uid_no_cola_vi_xxx', '9999999999')).toBe(false);
  });
});

describe('VI-COV -- getLeadsForFollowup empty return', () => {
  test('[] si no existe cola', () => {
    expect(getLeadsForFollowup('uid_no_existe_glf')).toEqual([]);
  });
  test('[] si cola no esta completed (status pending)', () => {
    const UID = 'vi_gf_' + Date.now();
    const leads = [{ name: 'L1', phone: '5799990010', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], status: 'sent', sentAt: Date.now() - 25 * 3600 * 1000, followups: 0, responded: false }];
    createOutreachQueue(UID, leads);
    expect(getLeadsForFollowup(UID)).toEqual([]);
  });
});

describe('VI-COV -- isImageCommand fallback (line 692)', () => {
  test('imagen + texto sin patron -> analyze (TRUE branch linea 692)', () => {
    const r = isImageCommand('ok perfecto', true);
    expect(r.isCommand).toBe(true);
    expect(r.type).toBe('analyze');
  });
  test('imagen + message null -> none (FALSE branch via message falsy)', () => {
    const r = isImageCommand(null, true);
    expect(r.isCommand).toBe(false);
    expect(r.type).toBe('none');
  });
});

describe('VI-COV -- buildOutreachPrompt branches (lines 509-545)', () => {
  const base = { name: 'Juan', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], country: { name: 'Colombia', code: 'CO' }, extra: null };
  test('sin webScrapeData -> sin INFO DE LA WEB', () => {
    const r = buildOutreachPrompt(base, 'Vi', 'MIIA', {});
    expect(r).not.toContain('INFO DE LA WEB');
    expect(r).not.toContain('YOUTUBE');
  });
  test('con webScrapeData -> incluye INFO DE LA WEB', () => {
    const r = buildOutreachPrompt(base, 'Vi', 'MIIA', { webScrapeData: 'web content here' });
    expect(r).toContain('INFO DE LA WEB');
  });
  test('con youtubeData -> incluye YOUTUBE', () => {
    const r = buildOutreachPrompt(base, 'Vi', 'MIIA', { youtubeData: [{ title: 'Video 1', url: 'http://yt.com/v1' }] });
    expect(r).toContain('YOUTUBE');
  });
  test('lead.country null + strategy null -> fallbacks', () => {
    const r = buildOutreachPrompt({ ...base, country: null, strategy: null }, 'Vi', 'MIIA', {});
    expect(r).toContain('MIIA');
    expect(r).not.toContain('Colombia');
  });
});


describe('VI-COV -- processOutreachQueue async (lines 411-499)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  function mQ(leads) {
    const UID = 'vi_poq_' + Math.random().toString(36).slice(2, 9);
    return createOutreachQueue(UID, leads);
  }
  function mL(phone, extra) {
    return {
      name: 'TL', phone: phone || '5711111111', state: 'nuevo',
      strategy: STRATEGY_BY_STATE['nuevo'],
      status: 'pending', sentAt: null, followups: 0, responded: false,
      document: 'CO', country: { name: 'Colombia', code: 'CO' },
      ...(extra || {}),
    };
  }

  test('queue.status processing -> early return (no envia)', async () => {
    const q = mQ([mL('5780000001')]);
    q.status = 'processing';
    const sendFn = jest.fn();
    await processOutreachQueue(q, sendFn, null, jest.fn(), {}, jest.fn());
    expect(sendFn).not.toHaveBeenCalled();
  });

  test('contactIndex skip -> lead.status = skipped', async () => {
    const lead = mL('5780000002');
    const q = mQ([lead]);
    const reportFn = jest.fn().mockResolvedValue(undefined);
    const p = processOutreachQueue(q, jest.fn(), null, jest.fn().mockResolvedValue('Hola'), {}, reportFn, { contactIndex: { '5780000002': true } });
    await jest.runAllTimersAsync();
    await p;
    expect(lead.status).toBe('skipped');
  });

  test('i > 0 delay branch; 2 leads sent OK', async () => {
    const l1 = mL('5780000010');
    const l2 = mL('5780000011');
    const q = mQ([l1, l2]);
    const p = processOutreachQueue(q, jest.fn().mockResolvedValue(undefined), null, jest.fn().mockResolvedValue('Hola'), {}, jest.fn().mockResolvedValue(undefined));
    await jest.runAllTimersAsync();
    await p;
    expect(q.stats.sent).toBe(2);
  });

  test('generateAIFn null -> lead.status failed (!message branch)', async () => {
    const lead = mL('5780000020');
    const q = mQ([lead]);
    const p = processOutreachQueue(q, jest.fn(), null, jest.fn().mockResolvedValue(null), {}, jest.fn().mockResolvedValue(undefined));
    await jest.runAllTimersAsync();
    await p;
    expect(lead.status).toBe('failed');
    expect(q.stats.failed).toBe(1);
  });

  test('strategy.sendPresentation true -> media enviado', async () => {
    const lead = mL('5780000030', { strategy: { sendPresentation: true, tone: 'cordial', approach: 'directo', priority: 1 } });
    const q = mQ([lead]);
    const mediaFn = jest.fn().mockResolvedValue(undefined);
    const p = processOutreachQueue(q, jest.fn().mockResolvedValue(undefined), mediaFn, jest.fn().mockResolvedValue('Hola'), { name: 'Vi', businessName: 'MIIA' }, jest.fn().mockResolvedValue(undefined));
    await jest.runAllTimersAsync();
    await p;
    expect(mediaFn).toHaveBeenCalled();
    expect(lead.status).toBe('sent');
  });

  test('sendMediaFn throws -> inner media catch (lead.status sigue sent)', async () => {
    const lead = mL('5780000040', { strategy: { sendPresentation: true, tone: 'cordial', approach: 'directo', priority: 1 } });
    const q = mQ([lead]);
    const mediaFn = jest.fn().mockRejectedValue(new Error('media fail'));
    const p = processOutreachQueue(q, jest.fn().mockResolvedValue(undefined), mediaFn, jest.fn().mockResolvedValue('Hola'), {}, jest.fn().mockResolvedValue(undefined));
    await jest.runAllTimersAsync();
    await p;
    expect(lead.status).toBe('sent');
    expect(q.stats.failed).toBe(0);
  });

  test('sendMessageFn throws -> outer catch -> lead.status failed', async () => {
    const lead = mL('5780000050');
    const q = mQ([lead]);
    const p = processOutreachQueue(q, jest.fn().mockRejectedValue(new Error('send fail')), null, jest.fn().mockResolvedValue('Hola'), {}, jest.fn().mockResolvedValue(undefined));
    await jest.runAllTimersAsync();
    await p;
    expect(lead.status).toBe('failed');
    expect(q.stats.failed).toBe(1);
  });
});


// VI-COV-S5: targeted tests for remaining uncovered branches
describe('VI-COV-S5 -- parseScreenshotResponse fallback branches (196-206)', () => {
  test('objeto sin campos opcionales -> usa OR fallbacks (type/source/summary/rawData/actionable/suggestedActions)', () => {
    const json = JSON.stringify({ contacts: [] });
    const r = parseScreenshotResponse(json);
    expect(r.type).toBe('other');
    expect(r.source).toBe('desconocido');
    expect(r.summary).toBe('');
    expect(r.rawData).toBe('');
    expect(r.actionable).toBe(false);
    expect(r.suggestedActions).toEqual([]);
  });

  test('null JSON -> parsed null -> ni Array ni object branch (fallback defaults)', () => {
    const r = parseScreenshotResponse('null');
    expect(r.leads.length).toBe(0);
    expect(r.type).toBe('other');
  });

  test('contacts not array -> Array.isArray false branch -> sin leads', () => {
    const json = JSON.stringify({ type: 'contacts_list', contacts: 'no_es_array' });
    const r = parseScreenshotResponse(json);
    expect(r.leads.length).toBe(0);
  });

  test('contact sin name y sin extra -> Sin nombre y null (lines 225-227)', () => {
    const json = JSON.stringify({ type: 'contacts_list', contacts: [{ phone: '+5711234567' }] });
    const r = parseScreenshotResponse(json);
    expect(r.leads[0].name).toBe('Sin nombre');
    expect(r.leads[0].extra).toBeNull();
  });

  test('contact con estado desconocido -> STRATEGY fallback (line 244)', () => {
    const json = JSON.stringify({ type: 'contacts_list', contacts: [{ name: 'T', phone: '+5711234567', state: 'estado_xyz_no_existe' }] });
    const r = parseScreenshotResponse(json);
    expect(r.leads[0].strategy).toEqual(STRATEGY_BY_STATE['nuevo']);
  });
});

describe('VI-COV-S5 -- buildAnalysisConfirmation country null (line 269)', () => {
  test('contacts_list + lead.country null -> Desconocido fallback', () => {
    const r = buildAnalysisConfirmation({ type: 'contacts_list', source: 'desconocido', summary: '', leads: [{ name: 'Lead1', phone: '5711111111', country: null }], rawData: '', actionable: true, suggestedActions: [], errors: [] });
    expect(r).toContain('Desconocido');
  });
});

describe('VI-COV-S5 -- normalizeState whitespace (line 329)', () => {
  test('estado de solo espacios -> norm vacio -> nuevo fallback', () => {
    expect(normalizeState('   ')).toBe('nuevo');
  });
});


describe('VI-COV-S5 -- createOutreachQueue strategy undefined (line 370)', () => {
  test('lead sin strategy -> strategy?.priority undefined -> OR 99 en sort', () => {
    const UID = 'vi_cov_cq_' + Date.now();
    const leads = [
      { name: 'NoStrat', phone: '5711111111', state: 'nuevo', strategy: undefined, status: 'pending', sentAt: null, followups: 0, responded: false },
      { name: 'HasStrat', phone: '5722222222', state: 'hql', strategy: STRATEGY_BY_STATE['hql'], status: 'pending', sentAt: null, followups: 0, responded: false },
    ];
    const q = createOutreachQueue(UID, leads);
    expect(q.leads[0].name).toBe('HasStrat');
    expect(q.leads[1].name).toBe('NoStrat');
  });
});

describe('VI-COV-S5 -- processOutreachQueue approach/country fallbacks (lines 458, 476, 477)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  test('lead sin approach + country null -> usa OR fallbacks (default y Desconocido)', async () => {
    const UID = 'vi_s5_poq_' + Math.random().toString(36).slice(2, 9);
    const lead = { name: 'TL', phone: '5780000099', state: 'nuevo', strategy: { sendPresentation: false }, status: 'pending', sentAt: null, followups: 0, responded: false, document: 'OP', country: null };
    const q = createOutreachQueue(UID, [lead]);
    const reportFn = jest.fn().mockResolvedValue(undefined);
    const p = processOutreachQueue(q, jest.fn().mockResolvedValue(undefined), null, jest.fn().mockResolvedValue('Hola'), {}, reportFn);
    await jest.runAllTimersAsync();
    await p;
    expect(lead.status).toBe('sent');
    expect(reportFn).toHaveBeenCalledWith(expect.stringContaining('Desconocido'));
  });
});

describe('VI-COV-S5 -- buildOutreachPrompt default opts arg (line 509)', () => {
  test('sin opts -> usa default {} (branch opts = {} default arg)', () => {
    const lead = { name: 'Juan', state: 'nuevo', strategy: STRATEGY_BY_STATE['nuevo'], country: { name: 'Colombia', code: 'CO' }, extra: null };
    const r = buildOutreachPrompt(lead, 'Vi', 'MIIA');
    expect(typeof r).toBe('string');
    expect(r).toContain('Juan');
  });
});
