'use strict';

/**
 * VI-BACKEND-COVERAGE: core/miia_postprocess.js — 100% branches
 */

jest.mock('../core/integrity_engine', () => ({
  attemptAutoRepair: jest.fn(),
}));

const { attemptAutoRepair } = require('../core/integrity_engine');
const pp = require('../core/miia_postprocess');

beforeEach(() => {
  jest.clearAllMocks();
  attemptAutoRepair.mockReturnValue(null);
});

// ── auditPromesa ──────────────────────────────────────────────────────
describe('auditPromesa', () => {
  test('mensaje sin acción confirmada → ok', () => {
    const r = pp.auditPromesa('¿En qué más te puedo ayudar hoy?');
    expect(r.pass).toBe(true);
    expect(r.action).toBe('ok');
  });

  test('confirma agendar con tag correcto → ok', () => {
    const r = pp.auditPromesa('Ya te agendé la reunión [AGENDAR_EVENTO:Reunión|2024-01-01|09:00|60|trabajo]');
    expect(r.pass).toBe(true);
    expect(r.action).toBe('ok');
  });

  test('confirma agendar sin tag + autoRepair exitoso → repair (actionType=agendar)', () => {
    attemptAutoRepair.mockReturnValue('[AGENDAR_EVENTO:Reunión|2024-01-01|09:00|60|trabajo]');
    const r = pp.auditPromesa('Ya te agendé la reunión para mañana');
    expect(r.pass).toBe(true);
    expect(r.action).toBe('repair');
    expect(r.repairedTag).toContain('AGENDAR_EVENTO');
  });

  test('confirma agendar sin tag + autoRepair falla → veto (actionType=agendar)', () => {
    attemptAutoRepair.mockReturnValue(null);
    const r = pp.auditPromesa('Ya te agendé la cita para mañana');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('veto');
    expect(r.reason).toContain('PROMESA ROTA');
  });

  test('confirma email sin tag → veto (actionType=email)', () => {
    const r = pp.auditPromesa('Ya te mandé el correo con la info completa');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('veto');
  });

  test('confirma cancelar sin tag → veto (actionType=cancelar)', () => {
    const r = pp.auditPromesa('Ya lo cancelé el evento de mañana en la agenda');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('veto');
  });

  test('confirma mover sin tag → veto (actionType=mover)', () => {
    const r = pp.auditPromesa('Ya lo moví a otra hora el turno del médico');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('veto');
  });

  test('confirma cotización sin tag → veto (actionType=otro)', () => {
    const r = pp.auditPromesa('Listo, ya te mandé la cotización completa');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('veto');
  });
});

// ── auditIdentidad ─────────────────────────────────────────────────────
describe('auditIdentidad', () => {
  test('selfchat → ok (exempt)', () => {
    expect(pp.auditIdentidad('soy una inteligencia artificial', 'selfchat').pass).toBe(true);
  });

  test('self → ok (exempt)', () => {
    expect(pp.auditIdentidad('soy una inteligencia artificial', 'self').pass).toBe(true);
  });

  test('family → ok (exempt)', () => {
    expect(pp.auditIdentidad('soy una IA', 'family').pass).toBe(true);
  });

  test('miia_lead → ok (exempt — MIIA se vende a sí misma)', () => {
    expect(pp.auditIdentidad('soy una IA', 'miia_lead').pass).toBe(true);
  });

  test('miia_client → ok (exempt)', () => {
    expect(pp.auditIdentidad('soy una IA', 'miia_client').pass).toBe(true);
  });

  test('team → ok (exempt)', () => {
    expect(pp.auditIdentidad('soy una IA', 'team').pass).toBe(true);
  });

  test('revealAsAI=true → ok (owner configuró reveal)', () => {
    expect(pp.auditIdentidad('soy una inteligencia artificial', 'lead', true).pass).toBe(true);
  });

  test('lead + patrón IA detectado → veto', () => {
    const r = pp.auditIdentidad('Hola, soy una inteligencia artificial, ¿en qué te ayudo?', 'lead', false);
    expect(r.pass).toBe(false);
    expect(r.action).toBe('veto');
    expect(r.reason).toContain('IDENTIDAD COMPROMETIDA');
  });

  test('lead + sin patrón IA → ok', () => {
    expect(pp.auditIdentidad('¿En qué te puedo ayudar hoy?', 'lead', false).pass).toBe(true);
  });
});

// ── auditLeadTriggers (vía runPostprocess — función interna no exportada) ─
// Los branches de auditLeadTriggers se cubren a través del orquestador.
// Ver tests en runPostprocess: 'lead + trigger', 'allowedTriggerTypes'.

// ── auditTono ─────────────────────────────────────────────────────────
describe('auditTono', () => {
  test('lead + revealAsAI=false → skipOpenerCheck=true → opener no cuenta → ok', () => {
    const r = pp.auditTono('Perfecto! Te ayudo en lo que necesites.', null, 'lead', false);
    expect(r.pass).toBe(true);
  });

  test('client + revealAsAI=false → skipOpenerCheck=true → ok aunque haya opener', () => {
    const r = pp.auditTono('Claro! Con mucho gusto te ayudo.', null, 'client', false);
    expect(r.pass).toBe(true);
  });

  test('lead + revealAsAI=true → skipOpenerCheck=false → opener detectado → regenerate', () => {
    const r = pp.auditTono('Perfecto, te explico todo.', null, 'lead', true);
    expect(r.pass).toBe(false);
    expect(r.action).toBe('regenerate');
  });

  test('selfchat + bot opener → regenerate', () => {
    const r = pp.auditTono('Perfecto, te ayudo con eso.', null, 'selfchat', false);
    expect(r.pass).toBe(false);
    expect(r.action).toBe('regenerate');
  });

  test('miia_lead + bot opener → regenerate (skipOpenerCheck=false)', () => {
    const r = pp.auditTono('Perfecto, te explico todo sobre MIIA.', null, 'miia_lead', false);
    expect(r.pass).toBe(false);
    expect(r.action).toBe('regenerate');
  });

  test('selfchat + bot closer → regenerate', () => {
    const r = pp.auditTono('Te comento, no dudes en escribirme si necesitás algo.', null, 'selfchat', false);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('TONO');
  });

  test('nombre repetido >2 veces → issue', () => {
    const r = pp.auditTono('Hola Juan, Juan te cuento que Juan ya está listo.', 'Juan', 'selfchat', false);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('repetido');
  });

  test('nombre largo exactamente 2 veces → sin issue de nombre', () => {
    const r = pp.auditTono('Pedro te cuento algo importante, Pedro.', 'Pedro', 'selfchat', false);
    expect(r.pass).toBe(true);
  });

  test('contactName null/sin nombre → sin check de nombre', () => {
    const r = pp.auditTono('Te cuento algo importante.', null, 'selfchat', false);
    expect(r.pass).toBe(true);
  });

  test('contactName corto (<=2 chars) → sin check de nombre', () => {
    const r = pp.auditTono('Al Al Al te digo que Al lo sabe bien.', 'Al', 'selfchat', false);
    expect(r.pass).toBe(true);
  });

  test('nombre en mensaje solo 1 vez → sin issue', () => {
    const r = pp.auditTono('Buenos días, te cuento algo importante hoy.', 'Ana', 'selfchat', false);
    expect(r.pass).toBe(true);
  });

  test('respuesta muy larga sin tags → issue de longitud', () => {
    const longMsg = 'x'.repeat(900);
    const r = pp.auditTono(longMsg, null, 'selfchat', false);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('larga');
  });

  test('miia_lead + respuesta >1200 chars sin tags → issue', () => {
    const longMsg = 'x'.repeat(1300);
    const r = pp.auditTono(longMsg, null, 'miia_lead', false);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('larga');
  });

  test('respuesta larga CON tags de sistema → sin issue de longitud', () => {
    const longMsg = '[GENERAR_COTIZACION:json] ' + 'x'.repeat(900);
    const r = pp.auditTono(longMsg, null, 'selfchat', false);
    expect(r.pass).toBe(true);
  });
});

// ── auditAprendizaje ──────────────────────────────────────────────────
describe('auditAprendizaje', () => {
  test('lead + APRENDIZAJE_NEGOCIO → strip', () => {
    const r = pp.auditAprendizaje('Dato [APRENDIZAJE_NEGOCIO:precio secreto]', 'lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
    expect(r.reason).toContain('APRENDIZAJE_NEGOCIO');
  });

  test('miia_lead + APRENDIZAJE_NEGOCIO → strip', () => {
    const r = pp.auditAprendizaje('[APRENDIZAJE_NEGOCIO:x]', 'miia_lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
  });

  test('lead + APRENDIZAJE_PERSONAL → strip', () => {
    const r = pp.auditAprendizaje('[APRENDIZAJE_PERSONAL:dato personal]', 'lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
    expect(r.reason).toContain('APRENDIZAJE_PERSONAL');
  });

  test('miia_lead + APRENDIZAJE_PERSONAL → strip', () => {
    const r = pp.auditAprendizaje('[APRENDIZAJE_PERSONAL:x]', 'miia_lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
  });

  test('family + APRENDIZAJE_NEGOCIO → strip', () => {
    const r = pp.auditAprendizaje('[APRENDIZAJE_NEGOCIO:x]', 'family');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
  });

  test('equipo + APRENDIZAJE_NEGOCIO → strip', () => {
    const r = pp.auditAprendizaje('[APRENDIZAJE_NEGOCIO:x]', 'equipo');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
  });

  test('lead + AGENDAR_EVENTO directo → strip', () => {
    const r = pp.auditAprendizaje('[AGENDAR_EVENTO:test|2024-01-01|09:00|60|x]', 'lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
    expect(r.reason).toContain('AGENDAR_EVENTO');
  });

  test('miia_lead + AGENDAR_EVENTO directo → strip', () => {
    const r = pp.auditAprendizaje('[AGENDAR_EVENTO:test]', 'miia_lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('strip');
  });

  test('selfchat + tags → ok (selfchat no está en los checks)', () => {
    const r = pp.auditAprendizaje('[APRENDIZAJE_NEGOCIO:x][APRENDIZAJE_PERSONAL:y][AGENDAR_EVENTO:z]', 'selfchat');
    expect(r.pass).toBe(true);
    expect(r.action).toBe('ok');
  });

  test('lead + mensaje limpio → ok', () => {
    const r = pp.auditAprendizaje('¿En qué te ayudo?', 'lead');
    expect(r.pass).toBe(true);
  });
});

// ── auditMecanicaInterna ──────────────────────────────────────────────
describe('auditMecanicaInterna', () => {
  test('selfchat → ok (exempt)', () => {
    expect(pp.auditMecanicaInterna('el backend procesa todo', 'selfchat').pass).toBe(true);
  });

  test('family → ok (exempt)', () => {
    expect(pp.auditMecanicaInterna('el backend', 'family').pass).toBe(true);
  });

  test('equipo → ok (exempt)', () => {
    expect(pp.auditMecanicaInterna('el backend', 'equipo').pass).toBe(true);
  });

  test('miia_lead + "el backend" (keyword "backend" en filtro) → regenerate', () => {
    const r = pp.auditMecanicaInterna('Te consulto el backend para ver tu cuenta', 'miia_lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('regenerate');
  });

  test('miia_lead + "el servidor" (NO en keywords del filtro) → ok', () => {
    // "el servidor" pattern source no contiene firestore|baileys|backend|prompt|cron|pipeline|tags
    const r = pp.auditMecanicaInterna('El servidor está funcionando bien hoy', 'miia_lead');
    expect(r.pass).toBe(true);
  });

  test('lead + "el servidor" → regenerate (full pattern check)', () => {
    const r = pp.auditMecanicaInterna('El servidor procesa tu solicitud directamente', 'lead');
    expect(r.pass).toBe(false);
    expect(r.action).toBe('regenerate');
    expect(r.reason).toContain('MECÁNICA INTERNA EXPUESTA');
  });

  test('lead + mensaje limpio → ok', () => {
    expect(pp.auditMecanicaInterna('¿En qué te ayudo hoy?', 'lead').pass).toBe(true);
  });
});

// ── auditVerdad ───────────────────────────────────────────────────────
describe('auditVerdad', () => {
  test('selfchat (trustedChat) + score deportivo → ok (exempt)', () => {
    expect(pp.auditVerdad('Van 2-1 en el partido de Boca River', false, 'selfchat').pass).toBe(true);
  });

  test('miia_lead (trustedChat) + score deportivo → ok (exempt)', () => {
    expect(pp.auditVerdad('Van 2-1 en el partido de fútbol', false, 'miia_lead').pass).toBe(true);
  });

  test('lead + con search + score deportivo → ok (hasSearchData=true)', () => {
    expect(pp.auditVerdad('Boca va ganando 2-1 en el partido', true, 'lead').pass).toBe(true);
  });

  test('lead + sin search + score deportivo con "partido" → veto', () => {
    const r = pp.auditVerdad('Boca va ganando 2-1 en el partido de ayer', false, 'lead');
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('VERDAD');
  });

  test('lead + sin search + "primer tiempo" + partido → veto', () => {
    const r = pp.auditVerdad('En el primer tiempo están empatados en el partido', false, 'lead');
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('VERDAD');
  });

  test('lead + sin search + temperatura (grados) sin sugerencia → veto', () => {
    const r = pp.auditVerdad('Hoy hay 30° y está soleado todo el día', false, 'lead');
    expect(r.pass).toBe(false);
  });

  test('lead + sin search + temperatura con "podría" → ok (sugerencia)', () => {
    const r = pp.auditVerdad('Podría hacer 30° hoy según el pronóstico', false, 'lead');
    expect(r.pass).toBe(true);
  });

  test('"te mando un video" sin cotización → veto', () => {
    const r = pp.auditVerdad('Te mando un video explicativo ahora mismo', false, 'lead');
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('VERDAD');
  });

  test('"te mando un video" con cotización → ok (excepción PDF)', () => {
    const r = pp.auditVerdad('Te mando un video de la cotización PDF del plan', false, 'lead');
    expect(r.pass).toBe(true);
  });

  test('mensaje limpio → ok', () => {
    expect(pp.auditVerdad('¿En qué te puedo ayudar hoy?', false, 'lead').pass).toBe(true);
  });
});

// ── getFallbackMessage ────────────────────────────────────────────────
describe('getFallbackMessage', () => {
  test('IDENTIDAD + selfchat', () => {
    expect(pp.getFallbackMessage('IDENTIDAD COMPROMETIDA', 'selfchat')).toContain('procesar');
  });

  test('IDENTIDAD + lead (non-selfchat)', () => {
    expect(pp.getFallbackMessage('IDENTIDAD COMPROMETIDA', 'lead')).toContain('Hola');
  });

  test('PROMESA + selfchat', () => {
    expect(pp.getFallbackMessage('PROMESA ROTA: acción sin tag', 'selfchat')).toContain('verificar');
  });

  test('PROMESA + lead', () => {
    expect(pp.getFallbackMessage('PROMESA ROTA: falta tag', 'lead')).toContain('confirmar');
  });

  test('VERDAD + selfchat', () => {
    expect(pp.getFallbackMessage('VERDAD: dato sin respaldo', 'selfchat')).toContain('confirmado');
  });

  test('VERDAD + lead', () => {
    expect(pp.getFallbackMessage('VERDAD: score sin búsqueda', 'lead')).toContain('averiguar');
  });

  test('MECÁNICA + selfchat (via "self")', () => {
    expect(pp.getFallbackMessage('MECÁNICA INTERNA EXPUESTA', 'self')).toContain('falló');
  });

  test('MECÁNICA + lead', () => {
    expect(pp.getFallbackMessage('MECÁNICA INTERNA EXPUESTA', 'lead')).toContain('revisar');
  });

  test('LEAD_TRIGGERS → respuesta genérica (sin diferencia selfchat)', () => {
    const msg = pp.getFallbackMessage('LEAD_TRIGGERS: trigger prohibido', 'lead');
    expect(msg).toContain('Hola');
  });

  test('DEFAULT + selfchat', () => {
    expect(pp.getFallbackMessage('TONO: muletillas detectadas', 'selfchat')).toContain('procesar');
  });

  test('DEFAULT + lead', () => {
    expect(pp.getFallbackMessage('TONO: muletillas detectadas', 'lead')).toContain('Hola');
  });
});

// ── parseAuditResponse ────────────────────────────────────────────────
describe('parseAuditResponse', () => {
  test('texto sin JSON → {pass:true, issues:[], severity:"ok"}', () => {
    const r = pp.parseAuditResponse('No hay JSON aquí, solo texto plano');
    expect(r.pass).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.severity).toBe('ok');
  });

  test('JSON válido → parseado correctamente', () => {
    const r = pp.parseAuditResponse('{"pass":false,"issues":["promesa rota"],"severity":"major"}');
    expect(r.pass).toBe(false);
    expect(r.issues).toEqual(['promesa rota']);
    expect(r.severity).toBe('major');
  });

  test('JSON sin severity → severity="ok" por default', () => {
    const r = pp.parseAuditResponse('{"pass":true,"issues":[]}');
    expect(r.severity).toBe('ok');
  });

  test('JSON con issues no-array → issues=[]', () => {
    const r = pp.parseAuditResponse('{"pass":false,"issues":"string","severity":"minor"}');
    expect(r.issues).toEqual([]);
  });

  test('JSON malformado → catch → fail-open {pass:true}', () => {
    const r = pp.parseAuditResponse('{malformed: json here}');
    expect(r.pass).toBe(true);
    expect(r.severity).toBe('ok');
  });
});

// ── buildAuditPrompt ──────────────────────────────────────────────────
describe('buildAuditPrompt', () => {
  test('lead → incluye aviso de no revelar IA', () => {
    const p = pp.buildAuditPrompt('respuesta', 'pregunta del lead', 'lead', 'Juan', false);
    expect(typeof p).toBe('string');
    expect(p).toContain('lead');
    expect(p).toContain('Juan');
    expect(p).toContain('JAMÁS');
  });

  test('selfchat → incluye texto del creador', () => {
    const p = pp.buildAuditPrompt('resp', 'msg del owner', 'selfchat', null, true);
    expect(p).toContain('selfchat');
    expect(p).toContain('SÍ'); // hasSearchData=true
  });

  test('family/equipo → rama else del ternario (ni lead ni selfchat)', () => {
    const p = pp.buildAuditPrompt('resp', 'msg', 'family', 'Mamá', false);
    expect(p).toContain('familiar');
    expect(p).toContain('NO'); // hasSearchData=false
  });
});

// ── runPostprocess ────────────────────────────────────────────────────
describe('runPostprocess', () => {
  test('miia_lead sin _fromMiiaCenter → GUARDIA degrada a lead', () => {
    // Siendo lead ahora, identidad check aplica pero mensaje limpio → ok
    const r = pp.runPostprocess('¿En qué te ayudo?', { chatType: 'miia_lead' });
    expect(r.approved).toBe(true);
  });

  test('miia_client sin _fromMiiaCenter → GUARDIA degrada a lead', () => {
    const r = pp.runPostprocess('¿En qué te ayudo?', { chatType: 'miia_client' });
    expect(r.approved).toBe(true);
  });

  test('miia_lead con _fromMiiaCenter → no degrada (IA reveal permitido)', () => {
    const r = pp.runPostprocess('¡Soy MIIA, una IA! ¿En qué te ayudo?', {
      chatType: 'miia_lead',
      _fromMiiaCenter: true,
    });
    expect(r.approved).toBe(true); // miia_lead está exempt en auditIdentidad
  });

  test('mensaje limpio → approved=true, action=ok, repairedTags=[]', () => {
    const r = pp.runPostprocess('¿En qué te ayudo hoy?', { chatType: 'selfchat' });
    expect(r.approved).toBe(true);
    expect(r.action).toBe('ok');
    expect(r.repairedTags).toEqual([]);
    expect(r.vetoReason).toBeNull();
    expect(r.regenerateHint).toBeNull();
  });

  test('repair: tag inyectado en finalMessage → approved=true', () => {
    attemptAutoRepair.mockReturnValue('[AGENDAR_EVENTO:Reunión|2024-01-01|09:00|60|trabajo]');
    const r = pp.runPostprocess('Ya te agendé la reunión para mañana', {
      chatType: 'selfchat',
      contactPhone: '+5491234567890',
      contactName: 'Juan',
    });
    expect(r.repairedTags.length).toBeGreaterThan(0);
    expect(r.finalMessage).toContain('AGENDAR_EVENTO');
  });

  test('strip: tag prohibido removido → approved=true, action=strip', () => {
    const r = pp.runPostprocess('Info: [APRENDIZAJE_NEGOCIO:precio secreto] Aquí va el texto.', {
      chatType: 'lead',
    });
    expect(r.approved).toBe(true);
    expect(r.action).toBe('strip');
    expect(r.finalMessage).not.toContain('APRENDIZAJE_NEGOCIO');
  });

  test('veto → approved=false, action=veto, vetoReason set', () => {
    const r = pp.runPostprocess('Hola, soy una inteligencia artificial, ¿en qué te ayudo?', {
      chatType: 'lead',
      revealAsAI: false,
    });
    expect(r.approved).toBe(false);
    expect(r.action).toBe('veto');
    expect(r.vetoReason).toBeTruthy();
    expect(r.regenerateHint).toBeNull();
  });

  test('regenerate → approved=false, regenerateHint set, vetoReason=null', () => {
    const r = pp.runPostprocess('Perfecto! ¿Hay algo más en lo que te pueda ayudar?', {
      chatType: 'selfchat',
    });
    expect(r.approved).toBe(false);
    expect(r.action).toBe('regenerate');
    expect(r.regenerateHint).toBeTruthy();
    expect(r.vetoReason).toBeNull();
  });

  test('veto gana sobre regenerate (severity más alta)', () => {
    // identidad (veto=3) > tono (regenerate=2) → worst=veto
    const r = pp.runPostprocess('Perfecto! Soy una inteligencia artificial. ¿Hay algo más?', {
      chatType: 'lead',
      revealAsAI: false,
    });
    expect(r.action).toBe('veto');
  });

  test('lead + trigger "hola miia" → veto via auditLeadTriggers (línea 204)', () => {
    const r = pp.runPostprocess('hola miia, ¿podés ayudarme con algo hoy?', {
      chatType: 'lead',
      allowedTriggerTypes: [],
    });
    expect(r.approved).toBe(false);
    expect(r.action).toBe('veto');
  });

  test('family en allowedTriggerTypes → trigger permitido (línea 190)', () => {
    // "chau miia" trigger pasa porque family está en allowedTriggerTypes
    // (no usa "hola miia" que matchearía BOT_OPENERS)
    const r = pp.runPostprocess('chau miia, nos vemos después.', {
      chatType: 'family',
      allowedTriggerTypes: ['family'],
    });
    expect(r.approved).toBe(true);
  });
});

// ── runAIAudit ────────────────────────────────────────────────────────
describe('runAIAudit', () => {
  test('sin generateAI → fail-open: approved=true inmediato', async () => {
    const r = await pp.runAIAudit('cualquier mensaje', {});
    expect(r.approved).toBe(true);
    expect(r.severity).toBe('ok');
    expect(r.action).toBe('ok');
  });

  test('generateAI retorna pass=true → approved=true, action=ok', async () => {
    const generateAI = jest.fn().mockResolvedValue('{"pass":true,"issues":[],"severity":"ok"}');
    const r = await pp.runAIAudit('mensaje limpio', { generateAI, chatType: 'lead' });
    expect(r.approved).toBe(true);
    expect(r.action).toBe('ok');
  });

  test('severity=minor → approved=true (solo logear, no bloquear)', async () => {
    const generateAI = jest.fn().mockResolvedValue('{"pass":false,"issues":["muletilla"],"severity":"minor"}');
    const r = await pp.runAIAudit('Perfecto!', { generateAI, chatType: 'lead' });
    expect(r.approved).toBe(true);
    expect(r.action).toBe('ok');
  });

  test('severity=major → approved=false, action=regenerate', async () => {
    const generateAI = jest.fn().mockResolvedValue('{"pass":false,"issues":["dato inventado"],"severity":"major"}');
    const r = await pp.runAIAudit('mensaje', { generateAI, chatType: 'lead', hasSearchData: false });
    expect(r.approved).toBe(false);
    expect(r.action).toBe('regenerate');
  });

  test('severity=critical → approved=false, action=veto', async () => {
    const generateAI = jest.fn().mockResolvedValue('{"pass":false,"issues":["se delata como IA"],"severity":"critical"}');
    const r = await pp.runAIAudit('mensaje', { generateAI, chatType: 'lead' });
    expect(r.approved).toBe(false);
    expect(r.action).toBe('veto');
  });

  test('selfchat + hasSearch + major + issues fácticos → override → approved=true', async () => {
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({ pass: false, issues: ['dato deportivo sin búsqueda'], severity: 'major' })
    );
    const r = await pp.runAIAudit('Boca va 2-1', {
      generateAI,
      chatType: 'selfchat',
      hasSearchData: true,
    });
    expect(r.approved).toBe(true);
  });

  test('selfchat + hasSearch + major + issues NO fácticos → sin override → approved=false', async () => {
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({ pass: false, issues: ['promesa rota de acción'], severity: 'major' })
    );
    const r = await pp.runAIAudit('ya te agendé', {
      generateAI,
      chatType: 'selfchat',
      hasSearchData: true,
    });
    expect(r.approved).toBe(false);
  });

  test('lead + hasSearch + major → no es trustedWithSearch → sin override', async () => {
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({ pass: false, issues: ['dato fáctico inventado'], severity: 'major' })
    );
    const r = await pp.runAIAudit('mensaje', {
      generateAI,
      chatType: 'lead',
      hasSearchData: true,
    });
    expect(r.approved).toBe(false);
  });

  test('severity desconocida → action=ok via severityToAction fallback (|| ok branch)', async () => {
    // severity='unknown_val' → severityToAction['unknown_val'] = undefined → || 'ok'
    const generateAI = jest.fn().mockResolvedValue('{"pass":false,"issues":["test"],"severity":"unknown_val"}');
    const r = await pp.runAIAudit('mensaje', { generateAI, chatType: 'lead', hasSearchData: false });
    expect(r.action).toBe('ok');
    expect(r.approved).toBe(false); // 'unknown_val' !== 'ok' && !== 'minor'
  });

  test('generateAI lanza error → fail-open: approved=true', async () => {
    const generateAI = jest.fn().mockRejectedValue(new Error('Gemini timeout'));
    const r = await pp.runAIAudit('mensaje', { generateAI, chatType: 'lead' });
    expect(r.approved).toBe(true);
    expect(r.severity).toBe('ok');
    expect(r.action).toBe('ok');
  });
});
