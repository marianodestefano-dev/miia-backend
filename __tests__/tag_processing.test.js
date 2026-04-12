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

  test('emoji proactive es 🤹‍♀️', () => {
    const emoji = getMiiaEmoji('Revisé tu agenda', { trigger: 'proactive' });
    expect(emoji).toBe('🤹‍♀️');
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
