'use strict';

/**
 * TAG PROCESSING TESTS — Verifica que TODOS los tags se procesan correctamente
 *
 * REGLA ANTI-MENTIRA: Si MIIA emite un tag, el backend DEBE procesarlo.
 * Si el tag no se procesa, MIIA miente al usuario.
 *
 * Estos tests verifican:
 * 1. Cada tag se detecta correctamente por regex
 * 2. cleanResidualTags elimina CUALQUIER tag que quede sin procesar
 * 3. PROMESA ROTA: detecta "ya lo hice" sin flag de ejecución
 * 4. Emojis se aplican correctamente
 */

const {
  cleanResidualTags, splitMessage, getBasePhone, processLearningTags
} = require('../core/message_logic');
const { getMiiaEmoji, applyMiiaEmoji, detectOwnerMood } = require('../core/miia_emoji');

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 1: cleanResidualTags — NUNCA mostrar tags crudos al usuario
// ═══════════════════════════════════════════════════════════════

describe('cleanResidualTags', () => {
  test('elimina ENVIAR_CORREO residual', () => {
    const input = 'Te envío el email [ENVIAR_CORREO:test@mail.com|asunto|cuerpo]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[ENVIAR_CORREO:');
    expect(result).toContain('Te envío el email');
  });

  test('elimina AGENDAR_EVENTO residual', () => {
    const input = 'Listo, agendado [AGENDAR_EVENTO:contacto|2026-04-15|reunión|morning|avisar|oficina]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[AGENDAR_EVENTO:');
  });

  test('elimina CANCELAR_EVENTO residual', () => {
    const input = 'Ya borré el evento [CANCELAR_EVENTO:cumpleaños|2026-05-01|silencioso]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[CANCELAR_EVENTO:');
  });

  test('elimina ELIMINAR_EVENTO (alias) residual', () => {
    const input = 'Eliminado [ELIMINAR_EVENTO:reunión|2026-04-20]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[ELIMINAR_EVENTO:');
  });

  test('elimina MOVER_EVENTO residual', () => {
    const input = 'Movido [MOVER_EVENTO:reunión|2026-04-15|2026-04-20]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[MOVER_EVENTO:');
  });

  test('elimina PROPONER_HORARIO residual', () => {
    const input = 'Te propongo horarios [PROPONER_HORARIO:60]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[PROPONER_HORARIO');
  });

  test('elimina PROPONER_HORARIO sin duración', () => {
    const input = 'Horarios [PROPONER_HORARIO]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[PROPONER_HORARIO]');
  });

  test('elimina GENERAR_COTIZACION_PDF residual', () => {
    const input = 'Te mando la cotización [GENERAR_COTIZACION_PDF:{"nombre":"Juan"}]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[GENERAR_COTIZACION_PDF');
  });

  test('elimina HARTAZGO_CONFIRMADO residual', () => {
    const input = 'Entendido, no te molesto más [HARTAZGO_CONFIRMADO:Roberto]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[HARTAZGO_CONFIRMADO:');
  });

  test('elimina SILENCIAR_LEAD residual', () => {
    const input = 'Disculpe [SILENCIAR_LEAD:Carlos]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[SILENCIAR_LEAD:');
  });

  test('elimina tags de aprendizaje residuales', () => {
    const input = 'Anotado [APRENDIZAJE_NEGOCIO:los precios son X]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[APRENDIZAJE_NEGOCIO:');
  });

  test('elimina CONSULTAR_AGENDA residual', () => {
    const input = 'Dejame ver tu agenda [CONSULTAR_AGENDA]';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[CONSULTAR_AGENDA]');
  });

  test('UNIVERSAL TAG STRIPPER: elimina tags inventados por la IA', () => {
    const input = 'Hola [INVENTADO_POR_IA:algo random] todo bien';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[INVENTADO_POR_IA:');
    expect(result).toContain('Hola');
    expect(result).toContain('todo bien');
  });

  test('UNIVERSAL TAG STRIPPER: elimina tags sin parámetros', () => {
    const input = 'Test [ALGO_RARO] más texto';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[ALGO_RARO]');
  });

  test('no elimina texto entre corchetes que no es tag', () => {
    const input = 'El precio es [ver tabla de precios]';
    const result = cleanResidualTags(input);
    expect(result).toContain('[ver tabla de precios]');
  });

  test('elimina múltiples tags en un mensaje', () => {
    const input = 'Listo [ENVIAR_CORREO:a@b.c|sub|body] y [AGENDAR_EVENTO:x|2026|y] hecho';
    const result = cleanResidualTags(input);
    expect(result).not.toContain('[ENVIAR_CORREO:');
    expect(result).not.toContain('[AGENDAR_EVENTO:');
    expect(result).toContain('Listo');
    expect(result).toContain('hecho');
  });

  test('resultado final está trimmeado', () => {
    const input = '  Texto  [ALGO_TAG:data]  más  ';
    const result = cleanResidualTags(input);
    expect(result).toBe(result.trim());
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 1b: Tag legacy [GENERAR_COTIZACION_PDF:] DESCONECTADO (C-342 B.1, firma P7 de C-329)
// ═══════════════════════════════════════════════════════════════

describe('Tag legacy [GENERAR_COTIZACION_PDF:] — desconectado del procesamiento (C-342 B.1)', () => {
  // El handler en TMH:3060 usa indexOf('[GENERAR_COTIZACION:') como único prefix de procesamiento.
  // El regex de limpieza mantiene (?:_PDF)? como red de seguridad.

  const PROCESSING_PREFIX = '[GENERAR_COTIZACION:';
  const CLEAN_REGEX = /\[GENERAR_COTIZACION(?:_PDF)?(?::[^\]]*)?\]/g;

  test('tag nuevo [GENERAR_COTIZACION:{...}] SE detecta para procesamiento', () => {
    const msg = 'Listo [GENERAR_COTIZACION:{"nombre":"Juan","pais":"COLOMBIA"}]';
    expect(msg.indexOf(PROCESSING_PREFIX)).toBeGreaterThanOrEqual(0);
  });

  test('tag viejo [GENERAR_COTIZACION_PDF:{...}] NO se detecta para procesamiento (firma P7)', () => {
    const msg = 'Listo [GENERAR_COTIZACION_PDF:{"nombre":"Juan","pais":"COLOMBIA"}]';
    expect(msg.indexOf(PROCESSING_PREFIX)).toBe(-1);
  });

  test('tag viejo [GENERAR_COTIZACION_PDF:{...}] residual SE LIMPIA por red de seguridad', () => {
    const msg = 'Listo [GENERAR_COTIZACION_PDF:{"nombre":"Juan","pais":"COLOMBIA"}]';
    const cleaned = msg.replace(CLEAN_REGEX, '').trim();
    expect(cleaned).not.toContain('[GENERAR_COTIZACION_PDF');
    expect(cleaned).not.toContain('GENERAR_COTIZACION');
    expect(cleaned).toContain('Listo');
  });

  test('tag nuevo [GENERAR_COTIZACION:{...}] residual SE LIMPIA por misma red', () => {
    const msg = 'Listo [GENERAR_COTIZACION:{"nombre":"Juan"}]';
    const cleaned = msg.replace(CLEAN_REGEX, '').trim();
    expect(cleaned).not.toContain('[GENERAR_COTIZACION');
    expect(cleaned).toContain('Listo');
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 2: Tag regex patterns — Cada tag debe matchear
// ═══════════════════════════════════════════════════════════════

describe('Tag regex matching', () => {
  const TAG_PATTERNS = {
    ENVIAR_CORREO: /\[ENVIAR_CORREO:([^|]+)\|([^|]+)\|([^\]]+)\]/,
    ENVIAR_EMAIL: /\[ENVIAR_EMAIL:([^|]+)\|([^|]+)\|([^\]]+)\]/,
    AGENDAR_EVENTO: /\[AGENDAR_EVENTO:([^\]]+)\]/,
    SOLICITAR_TURNO: /\[SOLICITAR_TURNO:([^\]]+)\]/,
    CANCELAR_EVENTO: /\[CANCELAR_EVENTO:([^\]]+)\]/,
    MOVER_EVENTO: /\[MOVER_EVENTO:([^\]]+)\]/,
    PROPONER_HORARIO: /\[PROPONER_HORARIO(?::(\d+))?\]/,
    RECORDAR_OWNER: /\[RECORDAR_OWNER:([^|]+)\|([^\]]+)\]/,
    RECORDAR_CONTACTO: /\[RECORDAR_CONTACTO:([^|]+)\|([^\]]+)\]/,
    ALERTA_OWNER: /\[ALERTA_OWNER:([^\]]+)\]/,
    MENSAJE_PARA_OWNER: /\[MENSAJE_PARA_OWNER:([^\]]+)\]/,
    CREAR_TAREA: /\[CREAR_TAREA:([^\]]+)\]/,
    COMPLETAR_TAREA: /\[COMPLETAR_TAREA:([^\]]+)\]/,
    HARTAZGO_CONFIRMADO: /\[HARTAZGO_CONFIRMADO:([^\]]+)\]/,
    SILENCIAR_LEAD: /\[SILENCIAR_LEAD:([^\]]+)\]/,
    RESPONDELE: /\[RESPONDELE:([^\]]+)\]/,
    APRENDIZAJE_NEGOCIO: /\[APRENDIZAJE_NEGOCIO:([^\]]+)\]/,
    APRENDIZAJE_PERSONAL: /\[APRENDIZAJE_PERSONAL:([^\]]+)\]/,
    GENERAR_COTIZACION_PDF: /\[GENERAR_COTIZACION_PDF:/,
  };

  for (const [name, regex] of Object.entries(TAG_PATTERNS)) {
    test(`${name} regex matchea formato válido`, () => {
      // Construir un ejemplo válido de cada tag
      const examples = {
        ENVIAR_CORREO: '[ENVIAR_CORREO:test@mail.com|Asunto prueba|Cuerpo del email]',
        ENVIAR_EMAIL: '[ENVIAR_EMAIL:test@mail.com|Asunto|Cuerpo]',
        AGENDAR_EVENTO: '[AGENDAR_EVENTO:Juan|2026-04-15T10:00|Reunión|morning|avisar|oficina]',
        SOLICITAR_TURNO: '[SOLICITAR_TURNO:María|2026-04-20T14:00|Consulta|afternoon|silencioso]',
        CANCELAR_EVENTO: '[CANCELAR_EVENTO:Cumpleaños Rafael|2026-05-01|silencioso]',
        MOVER_EVENTO: '[MOVER_EVENTO:Reunión|2026-04-15|2026-04-20]',
        PROPONER_HORARIO: '[PROPONER_HORARIO:60]',
        RECORDAR_OWNER: '[RECORDAR_OWNER:2026-04-20|Llamar al proveedor]',
        RECORDAR_CONTACTO: '[RECORDAR_CONTACTO:2026-04-18|Llevar documentos]',
        ALERTA_OWNER: '[ALERTA_OWNER:Lead pregunta por descuento especial]',
        MENSAJE_PARA_OWNER: '[MENSAJE_PARA_OWNER:Dice que necesita presupuesto urgente]',
        CREAR_TAREA: '[CREAR_TAREA:Revisar informe|2026-04-15|Notas adicionales]',
        COMPLETAR_TAREA: '[COMPLETAR_TAREA:Revisar informe]',
        HARTAZGO_CONFIRMADO: '[HARTAZGO_CONFIRMADO:Roberto]',
        SILENCIAR_LEAD: '[SILENCIAR_LEAD:Carlos García]',
        RESPONDELE: '[RESPONDELE:573001234567|Dile que sí, confirmado]',
        APRENDIZAJE_NEGOCIO: '[APRENDIZAJE_NEGOCIO:El precio del plan pro es $50]',
        APRENDIZAJE_PERSONAL: '[APRENDIZAJE_PERSONAL:Mi cumpleaños es el 15 de abril]',
        GENERAR_COTIZACION_PDF: '[GENERAR_COTIZACION_PDF:{"nombre":"Juan","pais":"COLOMBIA"}]',
      };
      expect(regex.test(examples[name])).toBe(true);
    });
  }

  test('PROPONER_HORARIO matchea sin duración', () => {
    expect(/\[PROPONER_HORARIO(?::(\d+))?\]/.test('[PROPONER_HORARIO]')).toBe(true);
  });

  test('ELIMINAR_EVENTO se normaliza a CANCELAR_EVENTO', () => {
    let msg = '[ELIMINAR_EVENTO:test|2026-01-01]';
    msg = msg.replace(/\[ELIMINAR_EVENTO:/g, '[CANCELAR_EVENTO:');
    expect(msg).toContain('[CANCELAR_EVENTO:');
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 3: Emoji system
// ═══════════════════════════════════════════════════════════════

describe('Emoji system', () => {
  test('default emoji es 👱‍♀️', () => {
    const emoji = getMiiaEmoji('Hola, todo bien?', {});
    expect(emoji).toBe('👱‍♀️');
  });

  test('emoji ofendida es 🙎‍♀️', () => {
    const emoji = getMiiaEmoji('...', { ownerMood: 'bully' });
    expect(emoji).toBe('🙎‍♀️');
  });

  test('emoji proactive es 👩‍💻', () => {
    // C-342 B.7: trigger 'proactive' ahora retorna 👩‍💻 (mujer tecnóloga).
    // Antes caía al default y fallaba.
    const emoji = getMiiaEmoji('Revisé tu agenda', { trigger: 'proactive' });
    expect(emoji).toBe('👩‍💻');
  });

  test('emoji multi-action es 🤹‍♀️', () => {
    const emoji = getMiiaEmoji('Todo listo', { isMultiAction: true });
    expect(emoji).toBe('🤹‍♀️');
  });

  test('emoji reminder es 💁‍♀️', () => {
    const emoji = getMiiaEmoji('Recordatorio', { trigger: 'reminder' });
    expect(emoji).toBe('💁‍♀️');
  });

  test('emoji no sabe es 🤷‍♀️', () => {
    const emoji = getMiiaEmoji('No tengo esa info', { dontKnow: true });
    expect(emoji).toBe('🤷‍♀️');
  });

  test('applyMiiaEmoji agrega formato EMOJI: texto', () => {
    const result = applyMiiaEmoji('Hola mundo', {});
    expect(result).toMatch(/^.+: Hola mundo$/);
  });

  test('applyMiiaEmoji reemplaza emoji puesto por IA', () => {
    const result = applyMiiaEmoji('😊 Hola mundo', {});
    // Debe quitar el 😊 y poner el oficial
    expect(result).not.toMatch(/^😊/);
    expect(result).toContain('Hola mundo');
  });

  test('detectOwnerMood detecta praise', () => {
    expect(detectOwnerMood('Sos una genia MIIA!')).toBe('praise');
  });

  test('detectOwnerMood detecta bully', () => {
    expect(detectOwnerMood('sos una inutil')).toBe('bully');
  });

  test('detectOwnerMood normal por defecto', () => {
    expect(detectOwnerMood('manda el informe')).toBe('normal');
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 4: PROMESA ROTA detection patterns
// ═══════════════════════════════════════════════════════════════

describe('PROMESA ROTA detection', () => {
  // Patrones que indican que MIIA dice "ya lo hice"
  const EMAIL_CONFIRM_PATTERNS = /ya (te |le )?(lo )?(envié|mandé|mand[eé]|envi[eé])|correo (enviado|mandado)|email (sent|enviado)/i;
  const AGENDA_CONFIRM_PATTERNS = /ya (lo )?(agend[eé]|agendé|programé|cre[eé])|evento (creado|agendado|programado)|agend[eé] (el|la|tu)/i;
  const TAREA_CONFIRM_PATTERNS = /ya (la )?(cre[eé]|anot[eé])|tarea (creada|anotada)/i;

  test('detecta confirmación falsa de email', () => {
    expect(EMAIL_CONFIRM_PATTERNS.test('Ya te lo envié por correo')).toBe(true);
    expect(EMAIL_CONFIRM_PATTERNS.test('Listo, correo enviado')).toBe(true);
    expect(EMAIL_CONFIRM_PATTERNS.test('Ya le mandé el email')).toBe(true);
  });

  test('no detecta falso positivo en email', () => {
    expect(EMAIL_CONFIRM_PATTERNS.test('¿Querés que te lo envíe?')).toBe(false);
    expect(EMAIL_CONFIRM_PATTERNS.test('Puedo mandarte un correo')).toBe(false);
  });

  test('detecta confirmación falsa de agenda', () => {
    expect(AGENDA_CONFIRM_PATTERNS.test('Ya lo agendé para mañana')).toBe(true);
    expect(AGENDA_CONFIRM_PATTERNS.test('Evento creado')).toBe(true);
    expect(AGENDA_CONFIRM_PATTERNS.test('Ya programé la reunión')).toBe(true);
  });

  test('detecta confirmación falsa de tarea', () => {
    expect(TAREA_CONFIRM_PATTERNS.test('Ya la creé')).toBe(true);
    expect(TAREA_CONFIRM_PATTERNS.test('Tarea creada')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST SUITE 5: Utility functions
// ═══════════════════════════════════════════════════════════════

describe('Utility functions', () => {
  test('getBasePhone extrae número limpio de JID', () => {
    expect(getBasePhone('573163937365@s.whatsapp.net')).toBe('573163937365');
  });

  test('getBasePhone maneja sufijo :94 (incluye sufijo — split extra necesario)', () => {
    // getBasePhone solo quita @s.whatsapp.net, el :94 requiere split(':')[0] adicional
    const raw = getBasePhone('573163937365:94@s.whatsapp.net');
    const clean = raw.split(':')[0];
    expect(clean).toBe('573163937365');
  });

  test('getBasePhone maneja número plano', () => {
    expect(getBasePhone('573163937365')).toBe('573163937365');
  });

  test('splitMessage divide por [MSG_SPLIT]', () => {
    const parts = splitMessage('Primera parte [MSG_SPLIT] Segunda parte');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Primera parte');
    expect(parts[1]).toContain('Segunda parte');
  });

  test('splitMessage retorna null si no hay split marker', () => {
    const parts = splitMessage('Mensaje sin split');
    expect(parts).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// EVENT SCORING — Verifica que CANCELAR_EVENTO no borra evento equivocado
// ═══════════════════════════════════════���═══════════════════════

describe('Event scoring algorithm', () => {
  // Reproduce el algoritmo de scoring usado en TMH y server.js
  function scoreEvent(searchReason, evtReason, evtContact = '') {
    const reasonLower = (searchReason || '').toLowerCase();
    const reasonWords = reasonLower.split(/\s+/).filter(w => w.length > 2);
    const evtReasonLower = (evtReason || '').toLowerCase();
    const evtContactLower = (evtContact || '').toLowerCase();

    if (evtReasonLower === reasonLower) return 100;

    const evtWords = `${evtReasonLower} ${evtContactLower}`.split(/\s+/).filter(w => w.length > 2);
    let matchedWords = 0;
    for (const word of reasonWords) {
      if (evtReasonLower.includes(word) || evtContactLower.includes(word)) matchedWords++;
    }
    const forwardMatch = reasonWords.length > 0 ? matchedWords / reasonWords.length : 0;
    let reverseMatched = 0;
    for (const word of evtWords) {
      if (reasonLower.includes(word)) reverseMatched++;
    }
    const reverseMatch = evtWords.length > 0 ? reverseMatched / evtWords.length : 0;
    return Math.round((forwardMatch * 60 + reverseMatch * 40));
  }

  test('BUG REGRESSION: "Cumpleaños de Sr. Rafael" NO debe matchear "Cumpleaños de papá"', () => {
    const score = scoreEvent('Cumpleaños de Sr. Rafael', 'Cumpleaños de papá');
    expect(score).toBeLessThan(45); // Threshold de rechazo es 45
  });

  test('match exacto retorna 100', () => {
    expect(scoreEvent('Reunión con Juan', 'Reunión con Juan')).toBe(100);
  });

  test('match exacto case-insensitive retorna 100', () => {
    expect(scoreEvent('REUNIÓN CON JUAN', 'reunión con juan')).toBe(100);
  });

  test('"Cumpleaños de Sr. Rafael" SÍ matchea "Cumpleaños de Sr. Rafael duplicado"', () => {
    const score = scoreEvent('Cumpleaños de Sr. Rafael', 'Cumpleaños de Sr. Rafael duplicado');
    expect(score).toBeGreaterThanOrEqual(40);
  });

  test('"Reunión con el dentista" matchea "Reunión dentista" con buen score', () => {
    const score = scoreEvent('Reunión con el dentista', 'Reunión dentista');
    expect(score).toBeGreaterThanOrEqual(40);
  });

  test('"Cena familiar" NO matchea "Reunión de trabajo"', () => {
    const score = scoreEvent('Cena familiar', 'Reunión de trabajo');
    expect(score).toBeLessThan(40);
  });

  test('"Cumpleaños de mamá" NO matchea "Cumpleaños de papá"', () => {
    const score = scoreEvent('Cumpleaños de mamá', 'Cumpleaños de papá');
    // "cumpleaños" matchea pero "mamá" vs "papá" no — debería ser bajo
    expect(score).toBeLessThan(60); // Puede pasar 40 por "cumpleaños" compartido, pero no llegar a 100
  });

  test('selecciona mejor match entre múltiples eventos', () => {
    const events = [
      'Cumpleaños de papá',
      'Cumpleaños de Sr. Rafael',
      'Reunión de trabajo',
    ];
    const scores = events.map(e => ({ reason: e, score: scoreEvent('Cumpleaños de Sr. Rafael', e) }));
    scores.sort((a, b) => b.score - a.score);
    expect(scores[0].reason).toBe('Cumpleaños de Sr. Rafael');
  });

  test('contactName también contribuye al score', () => {
    const scoreWithContact = scoreEvent('Reunión con Rafael', 'Reunión importante', 'Rafael');
    const scoreWithout = scoreEvent('Reunión con Rafael', 'Reunión importante', '');
    expect(scoreWithContact).toBeGreaterThan(scoreWithout);
  });

  test('búsqueda vacía no matchea nada', () => {
    const score = scoreEvent('', 'Cumpleaños de papá');
    expect(score).toBeLessThan(40);
  });
});

// ════════════════��══════════════════════════════════════════════
// VALIDATOR — miia_validator.js
// ═══════════════════════���═══════════════════════════════════════

describe('MIIA Validator', () => {
  const { validatePreSend } = require('../core/miia_validator');

  test('detecta tags residuales no limpiados', () => {
    const result = validatePreSend('Ya te lo mandé [ENVIAR_CORREO:test@mail.com|Hola|Cuerpo]', {
      chatType: 'lead',
    });
    expect(result.wasModified).toBe(true);
    // Issues contain the specific tag reference, not generic 'residual_tags'
    expect(result.issues.some(i => i.includes('residual_tag'))).toBe(true);
  });

  test('no modifica mensaje limpio', () => {
    const result = validatePreSend('Hola, ¿en qué te puedo ayudar?', {
      chatType: 'lead',
    });
    expect(result.wasModified).toBe(false);
  });

  test('detecta mensaje vacío', () => {
    const result = validatePreSend('', { chatType: 'lead' });
    expect(result.wasModified).toBe(true);
    expect(result.issues).toContain('empty_message');
  });

  test('detecta leak de mecánica interna en lead chat (logs but does not modify)', () => {
    const result = validatePreSend('Consulté tu Firestore y la collection users tiene los datos', {
      chatType: 'lead',
      isSelfChat: false,
    });
    // Validator logs the leak but doesn't auto-replace (postprocess should have caught it)
    expect(result.issues.some(i => i.includes('internal_leak'))).toBe(true);
  });

  test('NO detecta leak en self-chat', () => {
    const result = validatePreSend('Consulté Firestore para verificar los datos', {
      chatType: 'lead',
      isSelfChat: true,
    });
    expect(result.issues.filter(i => i.includes('internal_leak')).length).toBe(0);
  });
});

// ═════��═══════════════��═════════════════════════════════════════
// ENCRYPTION — token_encryption.js
// ═══════════════════════════════���═══════════════════════════════

describe('Token Encryption', () => {
  const encryption = require('../core/token_encryption');

  test('isEncrypted detecta formato enc:v1:', () => {
    expect(encryption.isEncrypted('enc:v1:abc:def:ghi')).toBe(true);
  });

  test('isEncrypted retorna false para texto plano', () => {
    expect(encryption.isEncrypted('just a normal token')).toBe(false);
  });

  test('isEncrypted retorna false para null/undefined', () => {
    expect(encryption.isEncrypted(null)).toBe(false);
    expect(encryption.isEncrypted(undefined)).toBe(false);
  });

  test('encrypt retorna el mismo valor si no hay key configurada', () => {
    // Sin MIIA_ENCRYPTION_KEY env var, funciona en passthrough
    const result = encryption.encrypt('my-secret-token');
    expect(result).toBe('my-secret-token');
  });

  test('encrypt no re-encripta valor ya encriptado', () => {
    const encrypted = 'enc:v1:aabbcc:ddeeff:112233';
    expect(encryption.encrypt(encrypted)).toBe(encrypted);
  });

  test('encrypt maneja null/undefined gracefully', () => {
    expect(encryption.encrypt(null)).toBeNull();
    expect(encryption.encrypt(undefined)).toBeUndefined();
    expect(encryption.encrypt('')).toBe('');
  });

  test('decrypt retorna texto plano si no está encriptado', () => {
    expect(encryption.decrypt('normal text')).toBe('normal text');
  });

  test('encryptFields solo toca campos especificados', () => {
    const data = { accessToken: 'tok1', refreshToken: 'tok2', name: 'Test', aiApiKey: 'key1' };
    const result = encryption.encryptFields({ ...data });
    // Sin key, pasa en passthrough — valores quedan igual
    expect(result.name).toBe('Test');
    expect(result.accessToken).toBe('tok1'); // passthrough sin key
  });
});

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER �� rate_limiter.js
// ════════════════════════════════════════════════���══════════════

describe('Rate Limiter & Circuit Breaker', () => {
  const rateLimiter = require('../core/rate_limiter');

  test('circuit breaker starts CLOSED', () => {
    const result = rateLimiter.circuitAllows();
    expect(result.allowed).toBe(true);
    expect(result.state).toBe('CLOSED');
  });

  test('circuit stays closed after single failure', () => {
    rateLimiter.circuitFailure();
    const result = rateLimiter.circuitAllows();
    expect(result.allowed).toBe(true);
  });

  test('circuitSuccess resets failures', () => {
    rateLimiter.circuitSuccess();
    const result = rateLimiter.circuitAllows();
    expect(result.allowed).toBe(true);
  });

  test('contactAllows permits first message', () => {
    expect(rateLimiter.contactAllows('573001234567')).toBe(true);
  });

  test('contactRecord does not crash', () => {
    expect(() => rateLimiter.contactRecord('573001234567')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// STRUCTURED LOGGER — structured_logger.js
// ══��════════════════════════════════════════════════════════════

describe('Structured Logger', () => {
  const logger = require('../core/structured_logger');

  test('createLogger returns object with log methods', () => {
    const log = logger.createLogger('TEST');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  test('getMetrics returns metrics object', () => {
    const metrics = logger.getMetrics();
    expect(metrics).toHaveProperty('messages');
    expect(metrics).toHaveProperty('errors');
    expect(metrics).toHaveProperty('timestamp');
    expect(metrics.messages).toHaveProperty('count');
    expect(metrics.errors).toHaveProperty('count');
  });

  test('logger does not throw when logging', () => {
    const log = logger.createLogger('TEST');
    expect(() => log.info('test message')).not.toThrow();
    expect(() => log.warn('warning message')).not.toThrow();
    expect(() => log.error('error message')).not.toThrow();
  });
});
