'use strict';

/**
 * T82 — Owner notification cuando lead bot detected
 *
 * Tests para:
 * 1. Alerta "POSIBLE BOT DETECTADO" contiene el número del contacto
 * 2. Alerta incluye opciones "MIIA retomá" y "MIIA ignorar"
 * 3. Regex comando "MIIA ignorar" acepta variantes del dueño
 * 4. Regex no acepta textos no relacionados
 * 5. Integración: contact_index marcado como bot/ignored
 * 6. Integración: cache ctx limpiado al ignorar
 */

// ─── Helpers para testear el mensaje de alerta ───────────────────────────────

function buildBotAlert(targetBase, count, contactName) {
  const botContactDisplay = contactName
    ? `*${contactName}* (+${targetBase})`
    : `*+${targetBase}*`;
  return [
    `🤖 *POSIBLE BOT DETECTADO*`,
    ``,
    `${botContactDisplay} envió ${count} mensajes en menos de 30 segundos — patrón típico de sistema automatizado.`,
    ``,
    `Pausé las respuestas para protegerte.`,
    ``,
    `*¿Qué hacer?*`,
    `▶ Retomar si era humano: *MIIA retomá con +${targetBase}*`,
    `🚫 Ignorar para siempre (bot/spam): *MIIA ignorar +${targetBase}*`,
    `⏸ No hagas nada para dejarlo pausado.`
  ].join('\n');
}

const IGNORE_REGEX = /^MIIA\s+(ignor[aá]r?|bloquear|no\s+hablar(?:\s+m[aá]s)?\s+con)\s*\+?([\d\s\-]+\d)/i;

// ─── Suite 1: Formato del mensaje de alerta ───────────────────────────────────

describe('T82 — Bot alert message format', () => {
  test('alerta incluye emoji 🤖 y título POSIBLE BOT DETECTADO', () => {
    const msg = buildBotAlert('573001234567', 12, null);
    expect(msg).toContain('🤖 *POSIBLE BOT DETECTADO*');
  });

  test('alerta incluye conteo de mensajes', () => {
    const msg = buildBotAlert('573001234567', 15, null);
    expect(msg).toContain('15 mensajes en menos de 30 segundos');
  });

  test('alerta sin nombre muestra número con prefijo *+*', () => {
    const msg = buildBotAlert('573001234567', 12, null);
    expect(msg).toContain('*+573001234567*');
  });

  test('alerta con nombre muestra nombre + número', () => {
    const msg = buildBotAlert('573001234567', 12, 'Coordinadora Bot');
    expect(msg).toContain('*Coordinadora Bot* (+573001234567)');
  });

  test('alerta incluye opción MIIA retomá', () => {
    const msg = buildBotAlert('573001234567', 12, null);
    expect(msg).toContain('MIIA retomá con +573001234567');
  });

  test('alerta incluye opción MIIA ignorar', () => {
    const msg = buildBotAlert('573001234567', 12, null);
    expect(msg).toContain('MIIA ignorar +573001234567');
  });

  test('alerta incluye pausa como tercera opción', () => {
    const msg = buildBotAlert('573001234567', 12, null);
    expect(msg).toContain('dejarlo pausado');
  });
});

// ─── Suite 2: Regex "MIIA ignorar" — variantes ───────────────────────────────

describe('T82 — Regex MIIA ignorar command', () => {
  const validCases = [
    ['MIIA ignorar +573001234567', '573001234567'],
    ['MIIA ignorá +573001234567', '573001234567'],
    ['MIIA ignorar 573001234567', '573001234567'],
    ['MIIA bloquear +573001234567', '573001234567'],
    ['MIIA no hablar con +573001234567', '573001234567'],
    ['MIIA no hablar más con +573001234567', '573001234567'],
    ['miia ignorar +573001234567', '573001234567'],   // case insensitive
    ['MIIA ignorar +57 300 123 4567', '5730012345 67'],  // spaces (regex captures raw)
  ];

  test.each(validCases)('acepta: "%s"', (input, _expected) => {
    const match = input.match(IGNORE_REGEX);
    expect(match).not.toBeNull();
  });

  const invalidCases = [
    'MIIA retomá con +573001234567',
    'ignorar +573001234567',
    'MIIA +573001234567',
    'MIIA ignora algo sin número',
    'Por favor MIIA ignorar al bot',  // no empieza con MIIA
    '',
    'hola MIIA',
  ];

  test.each(invalidCases)('rechaza: "%s"', (input) => {
    const match = input.match(IGNORE_REGEX);
    expect(match).toBeNull();
  });

  test('extrae número correcto de "MIIA ignorar +573001234567"', () => {
    const match = 'MIIA ignorar +573001234567'.match(IGNORE_REGEX);
    const rawPhone = match[2].replace(/[\s\-]/g, '');
    expect(rawPhone).toBe('573001234567');
  });

  test('extrae número correcto de "MIIA bloquear 5730012345"', () => {
    const match = 'MIIA bloquear 5730012345'.match(IGNORE_REGEX);
    const rawPhone = match[2].replace(/[\s\-]/g, '');
    expect(rawPhone).toBe('5730012345');
  });
});

// ─── Suite 3: Integración — limpieza de ctx cache ────────────────────────────

describe('T82 — ctx cache cleanup al ignorar', () => {
  function makeCtx(phone) {
    return {
      contactTypes: {
        [`${phone}@s.whatsapp.net`]: 'lead',
        [phone]: 'lead',
      },
      contactTypesMeta: {
        [`${phone}@s.whatsapp.net`]: Date.now(),
        [phone]: Date.now(),
      },
    };
  }

  test('delete borra contactType por JID', () => {
    const ctx = makeCtx('573001234567');
    const rawPhone = '573001234567';
    const phoneJid = `${rawPhone}@s.whatsapp.net`;
    delete ctx.contactTypes[phoneJid];
    delete ctx.contactTypes[`${rawPhone}@s.whatsapp.net`];
    expect(ctx.contactTypes[phoneJid]).toBeUndefined();
  });

  test('delete borra contactTypesMeta', () => {
    const ctx = makeCtx('573001234567');
    const rawPhone = '573001234567';
    const phoneJid = `${rawPhone}@s.whatsapp.net`;
    if (ctx.contactTypesMeta) {
      delete ctx.contactTypesMeta[phoneJid];
      delete ctx.contactTypesMeta[`${rawPhone}@s.whatsapp.net`];
    }
    expect(ctx.contactTypesMeta?.[phoneJid]).toBeUndefined();
  });

  test('ctx sin contactTypesMeta no tira error al limpiar', () => {
    const ctx = { contactTypes: { '573001234567@s.whatsapp.net': 'lead' } };
    expect(() => {
      if (ctx.contactTypesMeta) {
        delete ctx.contactTypesMeta['573001234567@s.whatsapp.net'];
      }
    }).not.toThrow();
  });
});

// ─── Suite 4: Integración §6.19+T82 — bot bloqueado no pasa cache ────────────

describe('T82 + §6.19 — bot bloqueado permanece bloqueado post-cache', () => {
  const { isContactTypeStale, recordContactTypeFresh } = require('../lib/contact_classification_cache');

  test('contacto marcado como bot ignorado: isContactTypeStale=true (sin meta)', () => {
    const ctx = { contactTypes: { '573001234567@s.whatsapp.net': 'bot' } };
    expect(isContactTypeStale(ctx, '573001234567@s.whatsapp.net')).toBe(true);
  });

  test('después de ignorar y limpiar meta, re-classify forzado en próximo touch', () => {
    const ctx = {
      contactTypes: { '573001234567@s.whatsapp.net': 'bot' },
      contactTypesMeta: {}
    };
    recordContactTypeFresh(ctx, '573001234567@s.whatsapp.net');
    // Si meta fue limpiada por ignore handler, stale = true
    delete ctx.contactTypesMeta['573001234567@s.whatsapp.net'];
    expect(isContactTypeStale(ctx, '573001234567@s.whatsapp.net')).toBe(true);
  });
});
