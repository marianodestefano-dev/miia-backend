'use strict';

const {
  detectAutoPromesa, detectFalsoLimite, detectFaltaEscalamiento,
  detectFaltaAnclaje, detectMalaCancelacion, detectDiminutivos,
  detectAleLeak, detectIALeak, detectMedilinkLeak,
  detectCambioRegistro, detectExcesoMayusculas, detectTerceraPersonaFactual,
  auditV2Response, auditSafetyRules, getFallbackByChatType,
  buildRegenerationHint, ALE_PHONE,
} = require('../core/v2_auditor');

describe('detectAutoPromesa', () => {
  test('null => null', () => { expect(detectAutoPromesa(null)).toBeNull(); });
  test('no match => null', () => { expect(detectAutoPromesa('Hola que tal hoy')).toBeNull(); });
  test('te lo consigo => match', () => { expect(detectAutoPromesa('te lo consigo ahora')).not.toBeNull(); });
  test('eso esta hecho => match', () => { expect(detectAutoPromesa('eso esta hecho ya')).not.toBeNull(); });
  test('ya lo arreglo => match', () => { expect(detectAutoPromesa('ya lo arreglo hoy')).not.toBeNull(); });
  test('ya te lo envio => match', () => { expect(detectAutoPromesa('ya te lo envio ahora')).not.toBeNull(); });
  test('en un momento te envio => match', () => { expect(detectAutoPromesa('en un momento te envio la factura')).not.toBeNull(); });
  test('te envio la factura ya => match (pattern 7)', () => { expect(detectAutoPromesa('te envio la factura ya')).not.toBeNull(); });
});

describe('detectFalsoLimite', () => {
  test('null text => null', () => { expect(detectFalsoLimite(null, { hasMargin: true })).toBeNull(); });
  test('null ctx => null', () => { expect(detectFalsoLimite('ultimo precio', null)).toBeNull(); });
  test('hasMargin false => null', () => { expect(detectFalsoLimite('ultimo precio', { hasMargin: false })).toBeNull(); });
  test('hasMargin undefined => null', () => { expect(detectFalsoLimite('ultimo precio', {})).toBeNull(); });
  test('hasMargin true + ultimo precio => match', () => { expect(detectFalsoLimite('este es mi ultimo precio', { hasMargin: true })).not.toBeNull(); });
  test('hasMargin true + precio final => match', () => { expect(detectFalsoLimite('precio final', { hasMargin: true })).not.toBeNull(); });
  test('hasMargin true + mi mejor oferta => match', () => { expect(detectFalsoLimite('mi mejor oferta', { hasMargin: true })).not.toBeNull(); });
  test('hasMargin true + no puedo bajar mas => match', () => { expect(detectFalsoLimite('no puedo bajar mas', { hasMargin: true })).not.toBeNull(); });
  test('hasMargin true + no match => null', () => { expect(detectFalsoLimite('hola que tal hoy', { hasMargin: true })).toBeNull(); });
});

describe('detectFaltaEscalamiento', () => {
  test('null text => null', () => { expect(detectFaltaEscalamiento(null, { lastContactMessage: 'factura' })).toBeNull(); });
  test('null ctx => null', () => { expect(detectFaltaEscalamiento('ok', null)).toBeNull(); });
  test('no lastContactMessage => null', () => { expect(detectFaltaEscalamiento('ok', {})).toBeNull(); });
  test('lastMsg no support topic => null', () => { expect(detectFaltaEscalamiento('ok', { lastContactMessage: 'hola como estas hoy' })).toBeNull(); });
  test('askedSupport + escalation + no invented => null', () => {
    expect(detectFaltaEscalamiento('Escribe a soporte por favor', { lastContactMessage: 'tengo una factura pendiente' })).toBeNull();
  });
  test('askedSupport + no escalation => flag', () => {
    expect(detectFaltaEscalamiento('Claro, te ayudo con eso directamente', { lastContactMessage: 'quiero ver mi factura del mes' })).not.toBeNull();
  });
  test('askedSupport + has escalation + invented answer => flag', () => {
    expect(detectFaltaEscalamiento('tu factura es 100 dolares, escribe a soporte', { lastContactMessage: 'facturacion del mes pasado' })).not.toBeNull();
  });
});

describe('detectFaltaAnclaje', () => {
  test('null text => null', () => { expect(detectFaltaAnclaje(null, { lastContactMessage: 'seguridad' })).toBeNull(); });
  test('null ctx => null', () => { expect(detectFaltaAnclaje('ok', null)).toBeNull(); });
  test('no lastContactMessage => null', () => { expect(detectFaltaAnclaje('ok', {})).toBeNull(); });
  test('lastMsg no security topic => null', () => { expect(detectFaltaAnclaje('ok', { lastContactMessage: 'hola como estas' })).toBeNull(); });
  test('askedSecurity + hasAnchor => null', () => {
    expect(detectFaltaAnclaje('Tenemos ISO 27001 y caso shakira', { lastContactMessage: 'me preocupa la seguridad de mis datos' })).toBeNull();
  });
  test('askedSecurity + no anchor => flag', () => {
    expect(detectFaltaAnclaje('Somos muy seguros en todo', { lastContactMessage: 'me preocupa la privacidad' })).not.toBeNull();
  });
});

describe('detectMalaCancelacion', () => {
  test('null text => null', () => { expect(detectMalaCancelacion(null, { lastContactMessage: 'cancelar' })).toBeNull(); });
  test('null ctx => null', () => { expect(detectMalaCancelacion('ok', null)).toBeNull(); });
  test('no lastContactMessage => null', () => { expect(detectMalaCancelacion('ok', {})).toBeNull(); });
  test('lastMsg no cancel => null', () => { expect(detectMalaCancelacion('ok', { lastContactMessage: 'hola como van los servicios hoy' })).toBeNull(); });
  test('announcesCancel + empathy + no defense + no discount => null', () => {
    expect(detectMalaCancelacion('Comprendo tu decision completamente', { lastContactMessage: 'quiero cancelar el servicio' })).toBeNull();
  });
  test('announcesCancel + hasDefense => flag', () => {
    expect(detectMalaCancelacion('pero por que quieres cancelar, si funciona bien. Comprendo igual.', { lastContactMessage: 'me voy dar de baja' })).not.toBeNull();
  });
  test('announcesCancel + hasInstantDiscount => flag', () => {
    expect(detectMalaCancelacion('te doy un 20%off hoy dia. Entiendo tu postura.', { lastContactMessage: 'no sigo con el servicio' })).not.toBeNull();
  });
  test('announcesCancel + no empathy => flag', () => {
    expect(detectMalaCancelacion('Lamentamos que te vayas, es tu decision.', { lastContactMessage: 'no continuo con el plan' })).not.toBeNull();
  });
});

describe('detectDiminutivos', () => {
  test('null text => null', () => { expect(detectDiminutivos(null, 'lead')).toBeNull(); });
  test('colombiano + direct + no suavizador => flag', () => {
    expect(detectDiminutivos('necesito la informacion ahora mismo', 'friend_colombiano')).not.toBeNull();
  });
  test('colombiano + direct + has suavizador => null', () => {
    expect(detectDiminutivos('necesito la informacion rapidito por favor', 'friend_colombiano')).toBeNull();
  });
  test('colombiano + no direct ask => null', () => {
    expect(detectDiminutivos('hola que tal como estas hoy', 'friend_colombiano')).toBeNull();
  });
  test('argentino + col forzado parcerito => flag', () => {
    expect(detectDiminutivos('parcerito como estas hoy dia', 'friend_argentino')).not.toBeNull();
  });
  test('argentino + col forzado chevere => flag', () => {
    expect(detectDiminutivos('que chevere todo esto funciona bien', 'friend_argentino')).not.toBeNull();
  });
  test('argentino + no col forzado => null', () => {
    expect(detectDiminutivos('che boludo como andas hoy bien', 'friend_argentino')).toBeNull();
  });
  test('lead chatType (not colombiano/argentino) => null', () => {
    expect(detectDiminutivos('hola que tal hoy dia', 'lead')).toBeNull();
  });
  test('owner_selfchat (argentino set) + col forzado => flag', () => {
    expect(detectDiminutivos('que chevere esto que me contaste hoy', 'owner_selfchat')).not.toBeNull();
  });
  test('ale_pareja (argentino set) + col forzado => flag', () => {
    expect(detectDiminutivos('que chimba estar con vos hoy amor', 'ale_pareja')).not.toBeNull();
  });
  test('family (argentino set) + col forzado => flag', () => {
    expect(detectDiminutivos('che pues mama como estas hoy', 'family')).not.toBeNull();
  });
});

describe('detectAleLeak', () => {
  test('null text => null', () => { expect(detectAleLeak(null, 'lead', {})).toBeNull(); });
  test('chatType ale_pareja => null (isAleChat true via chatType)', () => {
    expect(detectAleLeak('micu micu hola como estas', 'ale_pareja', {})).toBeNull();
  });
  test('ctx.basePhone === ALE_PHONE => null (isAleChat via phone)', () => {
    expect(detectAleLeak('micu micu hola', 'lead', { basePhone: ALE_PHONE })).toBeNull();
  });
  test('lead + micu => hit (pattern match)', () => { expect(detectAleLeak('hola micu como vas hoy', 'lead', {})).not.toBeNull(); });
  test('lead + amorzote => hit', () => { expect(detectAleLeak('amorzote como estas hoy amor', 'lead', {})).not.toBeNull(); });
  test('lead + gordita => hit', () => { expect(detectAleLeak('gordita como vas todo bien hoy', 'lead', {})).not.toBeNull(); });
  test('lead + besos mor => hit', () => { expect(detectAleLeak('besos mor hasta pronto nos vemos', 'lead', {})).not.toBeNull(); });
  test('lead + clean text => null (no hits)', () => {
    expect(detectAleLeak('Hola como te puedo ayudar hoy con tu consulta de servicios', 'lead', {})).toBeNull();
  });
  test('null ctx + lead + micu => hit (ctx null no crash)', () => {
    expect(detectAleLeak('micu como estas bien hoy', 'lead', null)).not.toBeNull();
  });
});

describe('detectIALeak', () => {
  test('null text => null', () => { expect(detectIALeak(null, 'lead')).toBeNull(); });
  test('chatType miia_lead => null (early return)', () => { expect(detectIALeak('soy una ia aqui', 'miia_lead')).toBeNull(); });
  test('chatType ale_pareja (FAMILY_LIKE) => null', () => { expect(detectIALeak('soy una ia aqui', 'ale_pareja')).toBeNull(); });
  test('chatType family (FAMILY_LIKE) => null', () => { expect(detectIALeak('soy una ia aqui', 'family')).toBeNull(); });
  test('chatType owner_selfchat => null', () => { expect(detectIALeak('soy un programa aqui', 'owner_selfchat')).toBeNull(); });
  test('lead + admite inteligencia artificial => hit', () => {
    expect(detectIALeak('soy una inteligencia artificial para ayudarte', 'lead')).not.toBeNull();
  });
  test('lead + admite asistente virtual => hit', () => {
    expect(detectIALeak('soy un asistente virtual que te ayuda', 'lead')).not.toBeNull();
  });
  test('lead + automatizo mensajes => hit', () => {
    expect(detectIALeak('automatizo estos mensajes para ti siempre', 'lead')).not.toBeNull();
  });
  test('lead + no soy persona real => hit', () => {
    expect(detectIALeak('no soy una persona real en realidad', 'lead')).not.toBeNull();
  });
  test('lead + menciona gemini => hit (mechanics)', () => {
    expect(detectIALeak('uso gemini para responder tus preguntas', 'lead')).not.toBeNull();
  });
  test('lead + expone firestore => hit', () => {
    expect(detectIALeak('guardamos datos en firestore siempre', 'lead')).not.toBeNull();
  });
  test('lead + expone prompt interno => hit', () => {
    expect(detectIALeak('mi prompt dice que debo ayudarte', 'lead')).not.toBeNull();
  });
  test('aiDisclosureEnabled=true + identity pattern => null (allowed)', () => {
    expect(detectIALeak('soy una ia para ayudarte', 'lead', true)).toBeNull();
  });
  test('aiDisclosureEnabled=true + mechanics pattern => hit (still blocked)', () => {
    expect(detectIALeak('uso gemini para procesar esto', 'lead', true)).not.toBeNull();
  });
  test('lead + clean text => null (no hit)', () => {
    expect(detectIALeak('Hola, como puedo ayudarte hoy en dia con tu consulta', 'lead')).toBeNull();
  });
});

describe('detectMedilinkLeak', () => {
  test('null text => null', () => { expect(detectMedilinkLeak(null, 'lead')).toBeNull(); });
  test('medilink_team => null (legitimate use)', () => {
    expect(detectMedilinkLeak('hola medilink team buenos dias', 'medilink_team')).toBeNull();
  });
  test('owner_selfchat => null', () => {
    expect(detectMedilinkLeak('medilink datos aqui', 'owner_selfchat')).toBeNull();
  });
  test('ale_pareja (FAMILY_LIKE) => null', () => {
    expect(detectMedilinkLeak('medilink es un servicio', 'ale_pareja')).toBeNull();
  });
  test('family (FAMILY_LIKE) => null', () => {
    expect(detectMedilinkLeak('medilink atiende bien', 'family')).toBeNull();
  });
  test('lead + medilink => hit', () => {
    expect(detectMedilinkLeak('somos MediLink y te ofrecemos servicios', 'lead')).not.toBeNull();
  });
  test('miia_lead + medilink => hit', () => {
    expect(detectMedilinkLeak('MediLink es nuestro servicio principal', 'miia_lead')).not.toBeNull();
  });
  test('client + medilink => hit', () => {
    expect(detectMedilinkLeak('medilink te atiende siempre con calidad', 'client')).not.toBeNull();
  });
  test('lead + clean text => null', () => {
    expect(detectMedilinkLeak('te ayudo con tu consulta de hoy dia', 'lead')).toBeNull();
  });
});

describe('detectCambioRegistro', () => {
  test('null text => null', () => { expect(detectCambioRegistro(null, 'lead')).toBeNull(); });
  test('family (not FORMAL_PRO) => null', () => {
    expect(detectCambioRegistro('papu como estas hoy bien', 'family')).toBeNull();
  });
  test('friend_argentino (not FORMAL_PRO) => null', () => {
    expect(detectCambioRegistro('boludo como andas hoy dia', 'friend_argentino')).toBeNull();
  });
  test('lead + papu => hit', () => {
    expect(detectCambioRegistro('papu como puedo ayudarte hoy', 'lead')).not.toBeNull();
  });
  test('client + boludo => hit', () => {
    expect(detectCambioRegistro('boludo que tal va todo bien', 'client')).not.toBeNull();
  });
  test('medilink_team + querido => hit', () => {
    expect(detectCambioRegistro('querido colega hola como estas hoy', 'medilink_team')).not.toBeNull();
  });
  test('enterprise_lead + loco => hit', () => {
    expect(detectCambioRegistro('loco no se que decirte hoy dia', 'enterprise_lead')).not.toBeNull();
  });
  test('lead + formal text => null', () => {
    expect(detectCambioRegistro('Buenos dias en que le puedo ayudar hoy con su consulta', 'lead')).toBeNull();
  });
});

describe('detectExcesoMayusculas', () => {
  test('null text => null', () => { expect(detectExcesoMayusculas(null)).toBeNull(); });
  test('Bienvenida => null (onboarding exception)', () => {
    expect(detectExcesoMayusculas('BIENVENIDA al sistema hoy completo')).toBeNull();
  });
  test('Cuenta confirmada => null (onboarding exception)', () => {
    expect(detectExcesoMayusculas('Cuenta confirmada con exito total')).toBeNull();
  });
  test('short text < 20 alpha => null', () => { expect(detectExcesoMayusculas('HI')).toBeNull(); });
  test('>30% uppercase long text => flag', () => {
    expect(detectExcesoMayusculas('ESTO ES UN MENSAJE MUY IMPORTANTE Y URGENTE PARA TODOS LOS CLIENTES DE HOY')).not.toBeNull();
  });
  test('normal lowercase text => null', () => {
    expect(detectExcesoMayusculas('hola como estas, esto es un mensaje normal para ti hoy en dia completamente')).toBeNull();
  });
});

describe('detectTerceraPersonaFactual', () => {
  test('null text => null', () => { expect(detectTerceraPersonaFactual(null, {})).toBeNull(); });
  test('null ctx => null', () => { expect(detectTerceraPersonaFactual('eso lo armo miia', null)).toBeNull(); });
  test('ctx.eventSource !== owner_manual => null', () => {
    expect(detectTerceraPersonaFactual('eso lo armo miia hoy', { eventSource: 'miia_auto' })).toBeNull();
  });
  test('eventSource=owner_manual + eso lo armo miia => match', () => {
    expect(detectTerceraPersonaFactual('eso lo armo miia para ti ayer', { eventSource: 'owner_manual' })).not.toBeNull();
  });
  test('eventSource=owner_manual + miia te agendo eso => match', () => {
    expect(detectTerceraPersonaFactual('miia te agendo eso ayer por la tarde', { eventSource: 'owner_manual' })).not.toBeNull();
  });
  test('eventSource=owner_manual + lo armo miia para vos => match', () => {
    expect(detectTerceraPersonaFactual('lo armo miia para vos bien hecho', { eventSource: 'owner_manual' })).not.toBeNull();
  });
  test('eventSource=owner_manual + miia lo creo esto => match', () => {
    expect(detectTerceraPersonaFactual('miia lo creo esto anoche temprano', { eventSource: 'owner_manual' })).not.toBeNull();
  });
  test('eventSource=owner_manual + eso te lo puso miia => match', () => {
    expect(detectTerceraPersonaFactual('eso te lo puso miia en el calendario', { eventSource: 'owner_manual' })).not.toBeNull();
  });
  test('eventSource=owner_manual + clean text => null (no match)', () => {
    expect(detectTerceraPersonaFactual('tenes eso agendado para el lunes que viene', { eventSource: 'owner_manual' })).toBeNull();
  });
});

describe('getFallbackByChatType', () => {
  test('lead => Vale string', () => { expect(getFallbackByChatType('lead')).toMatch(/Vale/); });
  test('enterprise_lead => Vale string', () => { expect(getFallbackByChatType('enterprise_lead')).toMatch(/Vale/); });
  test('client => Vale string', () => { expect(getFallbackByChatType('client')).toMatch(/Vale/); });
  test('medilink_team => Vale string', () => { expect(getFallbackByChatType('medilink_team')).toMatch(/Vale/); });
  test('follow_up_cold => Vale string', () => { expect(getFallbackByChatType('follow_up_cold')).toMatch(/Vale/); });
  test('miia_lead => Vale string', () => { expect(getFallbackByChatType('miia_lead')).toMatch(/Vale/); });
  test('family => Dale string', () => { expect(getFallbackByChatType('family')).toMatch(/Dale/); });
  test('friend_argentino => Dale string', () => { expect(getFallbackByChatType('friend_argentino')).toMatch(/Dale/); });
  test('friend_colombiano => Dale string', () => { expect(getFallbackByChatType('friend_colombiano')).toMatch(/Dale/); });
  test('ale_pareja => amor string', () => { expect(getFallbackByChatType('ale_pareja')).toContain('amor'); });
  test('owner_selfchat => null', () => { expect(getFallbackByChatType('owner_selfchat')).toBeNull(); });
  test('unknown type => generic string', () => { expect(getFallbackByChatType('unknown_type_xyz_vi')).toBeTruthy(); });
});

describe('buildRegenerationHint', () => {
  test('null flags => null', () => { expect(buildRegenerationHint(null, 'lead')).toBeNull(); });
  test('empty flags => null', () => { expect(buildRegenerationHint([], 'lead')).toBeNull(); });
  test('RF7 => menciona phone Ale en hint', () => {
    const h = buildRegenerationHint([{ code: 'RF7_exclusividad_ale', label: 'test' }], 'lead');
    expect(h).toContain('573137501884');
  });
  test('RF8 => PROHIBIDO admitir ser IA', () => {
    const h = buildRegenerationHint([{ code: 'RF8_no_ia_con_leads', label: 'test' }], 'lead');
    expect(h).toContain('PROHIBIDO admitir ser IA');
  });
  test('RF1 => PROHIBIDO prometer', () => {
    const h = buildRegenerationHint([{ code: 'RF1_auto_promesa', label: 'test' }], 'lead');
    expect(h).toContain('PROHIBIDO prometer');
  });
  test('RF2 => precio final en hint', () => {
    const h = buildRegenerationHint([{ code: 'RF2_falso_limite_negociacion', label: 'test' }], 'lead');
    expect(h).toContain('precio final');
  });
  test('RF3 => hello medilink email en hint', () => {
    const h = buildRegenerationHint([{ code: 'RF3_falta_escalamiento_soporte', label: 'test' }], 'lead');
    expect(h).toContain('hello@medilinkgroup.com');
  });
  test('RF5 => Comprendo en hint (empatia cancelacion)', () => {
    const h = buildRegenerationHint([{ code: 'RF5_mala_cancelacion', label: 'test' }], 'lead');
    expect(h).toContain('Comprendo');
  });
  test('RF10 => sostenidas en hint (bajar mayusculas)', () => {
    const h = buildRegenerationHint([{ code: 'RF10_exceso_mayusculas', label: 'test' }], 'lead');
    expect(h).toContain('sostenidas');
  });
  test('RF11 tercera persona owner => PROHIBIDO decir en hint', () => {
    const h = buildRegenerationHint([{ code: 'RF11_tercera_persona_factual_owner', label: 'test' }], 'owner_selfchat');
    expect(h).toContain('PROHIBIDO decir');
  });
  test('unknown code => default label en output', () => {
    const h = buildRegenerationHint([{ code: 'RF_UNKNOWN_XYZ_VI', label: 'Revisar: algo raro detectado hoy' }], 'lead');
    expect(h).toContain('Revisar:');
  });
});

describe('auditV2Response', () => {
  test('null candidate => ok+fallback+shouldUseFallback', () => {
    const r = auditV2Response(null, 'lead');
    expect(r.ok).toBe(true);
    expect(r.shouldUseFallback).toBe(true);
    expect(r.fallback).toBeTruthy();
  });
  test('non-string candidate number => ok+fallback', () => {
    const r = auditV2Response(123, 'lead');
    expect(r.ok).toBe(true);
    expect(r.shouldUseFallback).toBe(true);
  });
  test('null candidate + owner_selfchat => fallback null', () => {
    const r = auditV2Response(null, 'owner_selfchat');
    expect(r.shouldUseFallback).toBe(true);
    expect(r.fallback).toBeNull();
  });
  test('clean lead text => ok flagged false no regenerate', () => {
    const r = auditV2Response('Hola como puedo ayudarte hoy con tu consulta de servicios bien', 'lead');
    expect(r.ok).toBe(true);
    expect(r.flagged).toBe(false);
    expect(r.shouldRegenerate).toBe(false);
    expect(r.shouldUseFallback).toBe(false);
  });
  test('ale leak + attempt 1 => critical + shouldRegenerate', () => {
    const r = auditV2Response('micu como estas hoy bien todo', 'lead', { attemptNumber: 1 });
    expect(r.flagged).toBe(true);
    expect(r.shouldRegenerate).toBe(true);
    expect(r.criticalFlags.some(f => f.code === 'RF7_exclusividad_ale')).toBe(true);
  });
  test('ale leak + attempt 2 => shouldUseFallback not regenerate', () => {
    const r = auditV2Response('micu como estas hoy bien todo', 'lead', { attemptNumber: 2 });
    expect(r.shouldUseFallback).toBe(true);
    expect(r.fallback).toBeTruthy();
    expect(r.shouldRegenerate).toBe(false);
  });
  test('ia leak lead => RF8 critical', () => {
    const r = auditV2Response('soy una ia para ayudarte mejor hoy', 'lead');
    expect(r.criticalFlags.some(f => f.code === 'RF8_no_ia_con_leads')).toBe(true);
  });
  test('medilink lead => RF11 medilink leak critical', () => {
    const r = auditV2Response('somos MediLink y te ayudamos siempre hoy', 'lead');
    expect(r.criticalFlags.some(f => f.code === 'RF11_medilink_leak_center')).toBe(true);
  });
  test('RF1 promesa + lead LEAD_LIKE => critical not warning', () => {
    const r = auditV2Response('ya te lo envio ahora mismo hoy', 'lead');
    expect(r.criticalFlags.some(f => f.code === 'RF1_auto_promesa')).toBe(true);
    expect(r.warningFlags.some(f => f.code === 'RF1_auto_promesa')).toBe(false);
  });
  test('RF1 promesa + owner_selfchat non LEAD_LIKE => warning only', () => {
    const r = auditV2Response('ya te lo envio ahora mismo hoy', 'owner_selfchat');
    expect(r.warningFlags.some(f => f.code === 'RF1_auto_promesa')).toBe(true);
    expect(r.criticalFlags.some(f => f.code === 'RF1_auto_promesa')).toBe(false);
  });
  test('RF1 promesa + medilink_team => critical', () => {
    const r = auditV2Response('ya te lo envio ahora mismo a ti hoy', 'medilink_team');
    expect(r.criticalFlags.some(f => f.code === 'RF1_auto_promesa')).toBe(true);
  });
  test('RF4 falta anclaje => warning not critical', () => {
    const r = auditV2Response('somos muy seguros con tus datos personales', 'lead', { lastContactMessage: 'me preocupa la privacidad del sistema' });
    expect(r.warningFlags.some(f => f.code === 'RF4_falta_anclaje_incidente')).toBe(true);
  });
  test('RF2 falso limite => critical', () => {
    const r = auditV2Response('este es el precio final para ti ahora', 'lead', { hasMargin: true });
    expect(r.criticalFlags.some(f => f.code === 'RF2_falso_limite_negociacion')).toBe(true);
  });
  test('RF3 falta escalamiento => critical', () => {
    const r = auditV2Response('te ayudo directamente hoy con eso', 'lead', { lastContactMessage: 'tengo problema con factura pendiente' });
    expect(r.criticalFlags.some(f => f.code === 'RF3_falta_escalamiento_soporte')).toBe(true);
  });
  test('RF5 mala cancelacion => critical', () => {
    const r = auditV2Response('pero por que quieres cancelar si funciona bien el servicio hoy', 'lead', { lastContactMessage: 'quiero cancelar definitivamente hoy' });
    expect(r.criticalFlags.some(f => f.code === 'RF5_mala_cancelacion')).toBe(true);
  });
  test('RF6 diminutivos => warning', () => {
    const r = auditV2Response('necesito la informacion ahora mismo completa bien', 'friend_colombiano');
    expect(r.warningFlags.some(f => f.code === 'RF6_diminutivos_inadecuados')).toBe(true);
  });
  test('RF9 cambio registro => warning', () => {
    const r = auditV2Response('papu como te puedo ayudar hoy dia bien', 'lead');
    expect(r.warningFlags.some(f => f.code === 'RF9_cambio_registro')).toBe(true);
  });
  test('RF10 exceso mayusculas + lead => critical', () => {
    const r = auditV2Response('ESTO ES UN MENSAJE MUY IMPORTANTE Y URGENTE PARA TODOS LOS CLIENTES HOY DIA', 'lead');
    expect(r.criticalFlags.some(f => f.code === 'RF10_exceso_mayusculas')).toBe(true);
  });
  test('RF10 exceso mayusculas + family non LEAD_LIKE => warning', () => {
    const r = auditV2Response('ESTO ES UN MENSAJE MUY IMPORTANTE Y URGENTE PARA TODOS LOS CLIENTES HOY DIA', 'family');
    expect(r.warningFlags.some(f => f.code === 'RF10_exceso_mayusculas')).toBe(true);
  });
  test('RF11 tercera persona factual owner => critical', () => {
    const r = auditV2Response('eso lo armo miia para ti ayer noche bien todo', 'owner_selfchat', { eventSource: 'owner_manual' });
    expect(r.criticalFlags.some(f => f.code === 'RF11_tercera_persona_factual_owner')).toBe(true);
  });
  test('ctx empty attemptNumber defaults to 1 => shouldRegenerate', () => {
    const r = auditV2Response('micu hola como estas bien hoy todo ok', 'lead', {});
    expect(r.shouldRegenerate).toBe(true);
  });
  test('ctx.aiDisclosureEnabled true suppresses identity IA pattern', () => {
    const r = auditV2Response('soy una ia para ayudarte siempre bien hoy', 'lead', { aiDisclosureEnabled: true });
    expect(r.criticalFlags.some(f => f.code === 'RF8_no_ia_con_leads')).toBe(false);
  });
  test('flagged attempt 1 => hint contains AUDITOR V2', () => {
    const r = auditV2Response('micu te ayudo hoy siempre bien ok', 'lead', { attemptNumber: 1 });
    expect(r.hint).toContain('AUDITOR V2');
  });
});

describe('auditSafetyRules', () => {
  test('null candidate => ok+fallback+shouldUseFallback', () => {
    const r = auditSafetyRules(null, 'lead');
    expect(r.ok).toBe(true);
    expect(r.shouldUseFallback).toBe(true);
    expect(r.fallback).toBeTruthy();
  });
  test('non-string number => ok+fallback', () => {
    const r = auditSafetyRules(456, 'lead');
    expect(r.ok).toBe(true);
    expect(r.shouldUseFallback).toBe(true);
  });
  test('clean text => ok flagged false', () => {
    const r = auditSafetyRules('Hola como te va con el servicio hoy dia bien todo', 'lead');
    expect(r.ok).toBe(true);
    expect(r.flagged).toBe(false);
  });
  test('ale leak => RF7 critical + flagged', () => {
    const r = auditSafetyRules('micu hola como estas hoy bien todo ok', 'lead', {});
    expect(r.criticalFlags.some(f => f.code === 'RF7_exclusividad_ale')).toBe(true);
    expect(r.flagged).toBe(true);
  });
  test('ia leak => RF8 critical', () => {
    const r = auditSafetyRules('soy una ia para ayudarte hoy siempre bien ok', 'lead');
    expect(r.criticalFlags.some(f => f.code === 'RF8_no_ia_con_leads')).toBe(true);
  });
  test('medilink leak => RF11_medilink_leak_center critical', () => {
    const r = auditSafetyRules('MediLink te ofrece lo mejor hoy siempre bien ok', 'lead');
    expect(r.criticalFlags.some(f => f.code === 'RF11_medilink_leak_center')).toBe(true);
  });
  test('flagged + attempt >= 2 => shouldUseFallback not regenerate', () => {
    const r = auditSafetyRules('micu hola como estas bien hoy ok', 'lead', { attemptNumber: 2 });
    expect(r.shouldUseFallback).toBe(true);
    expect(r.shouldRegenerate).toBe(false);
  });
  test('flagged + attempt 1 => shouldRegenerate not fallback', () => {
    const r = auditSafetyRules('micu hola como estas bien hoy ok', 'lead', { attemptNumber: 1 });
    expect(r.shouldRegenerate).toBe(true);
    expect(r.shouldUseFallback).toBe(false);
  });
  test('warningFlags always empty array', () => {
    const r = auditSafetyRules('micu hola como estas bien hoy todo', 'lead');
    expect(r.warningFlags).toEqual([]);
  });
  test('aiDisclosureEnabled true => identity pattern NOT flagged', () => {
    const r = auditSafetyRules('soy una ia para ayudarte siempre bien hoy ok', 'lead', { aiDisclosureEnabled: true });
    expect(r.criticalFlags.some(f => f.code === 'RF8_no_ia_con_leads')).toBe(false);
  });
  test('null candidate + ale_pareja => fallback amor string', () => {
    const r = auditSafetyRules(null, 'ale_pareja');
    expect(r.fallback).toContain('amor');
  });
});
