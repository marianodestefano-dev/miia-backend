'use strict';

/**
 * T54 — coverage gap fix: miia_validator.js (era 56.89%)
 */

const v = require('../core/miia_validator');

describe('T54 §A — validatePreSend basics', () => {
  test('mensaje null → fallback', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend(null, {});
      expect(r.message).toMatch(/🤷‍♀️/);
      expect(r.issues).toContain('empty_message');
      expect(r.wasModified).toBe(true);
    } finally { console.error = orig; }
  });

  test('mensaje no-string → fallback', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend(123, {});
      expect(r.message).toMatch(/🤷‍♀️/);
    } finally { console.error = orig; }
  });

  test('mensaje empty string → fallback', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('', {});
      expect(r.issues).toContain('empty_message');
    } finally { console.error = orig; }
  });

  test('mensaje normal sin issues → pasa intacto', () => {
    const r = v.validatePreSend('Hola, todo bien?', { chatType: 'lead' });
    expect(r.message).toBe('Hola, todo bien?');
    expect(r.issues).toEqual([]);
    expect(r.wasModified).toBe(false);
  });
});

describe('T54 §B — Tags residuales', () => {
  test('tag inventado → eliminado + issue', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const r = v.validatePreSend('hola [TAG_INVENTADO:foo] mundo', {});
      expect(r.message).not.toContain('TAG_INVENTADO');
      expect(r.issues.some(i => i.startsWith('residual_tag:'))).toBe(true);
      expect(r.wasModified).toBe(true);
    } finally { console.warn = orig; }
  });

  test('multiples tags residuales → todos eliminados', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      // R-Vi-2: regex requiere [A-Z][A-Z_]+ (>=2 chars mayusculas)
      const r = v.validatePreSend('a [FOO:1] b [BAR:2] c', {});
      expect(r.message).not.toContain('[FOO:');
      expect(r.message).not.toContain('[BAR:');
      expect(r.issues.length).toBeGreaterThanOrEqual(2);
    } finally { console.warn = orig; }
  });

  test('tag sin payload → eliminado', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const r = v.validatePreSend('foo [BARE_TAG] bar', {});
      expect(r.message).not.toContain('[BARE_TAG]');
    } finally { console.warn = orig; }
  });
});

describe('T54 §C — PROMESA ROTA', () => {
  test('"ya te lo envié" + flag email=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Listo, ya te lo envié', {
        chatType: 'lead',
        executionFlags: { email: false },
      });
      expect(r.message).toMatch(/No pude enviar el correo/);
      expect(r.issues.some(i => i.startsWith('promesa_rota:email'))).toBe(true);
      expect(r.wasModified).toBe(true);
    } finally { console.error = orig; }
  });

  test('"ya lo agendé" + flag agenda=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Listo, ya lo agendé para mañana', {
        chatType: 'lead',
        executionFlags: { agenda: false },
      });
      expect(r.message).toMatch(/No pude agendar/);
      expect(r.issues.some(i => i.startsWith('promesa_rota:agenda'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('"ya la creé" + flag tarea=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Ya la creé', {
        executionFlags: { tarea: false },
      });
      expect(r.issues.some(i => i.startsWith('promesa_rota:tarea'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('"ya lo borré" + flag cancel=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Ya lo borré del calendario', {
        executionFlags: { cancel: false },
      });
      expect(r.issues.some(i => i.startsWith('promesa_rota:cancel'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('"ya lo moví" + flag move=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Ya lo moví al lunes', {
        executionFlags: { move: false },
      });
      expect(r.issues.some(i => i.startsWith('promesa_rota:move'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('"ya te la envié" cotización + flag cotizacion=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Listo, ya te la envié', {
        executionFlags: { cotizacion: false },
      });
      expect(r.issues.some(i => i.startsWith('promesa_rota:cotizacion'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('flag=true → confirmacion legitima sin issue', () => {
    const r = v.validatePreSend('Listo, ya te lo envié', {
      executionFlags: { email: true },
    });
    expect(r.issues.some(i => i.startsWith('promesa_rota'))).toBe(false);
  });

  test('logOnly=true → log error pero NO modifica msg', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('ya te lo envié', {
        chatType: 'lead',
        executionFlags: { email: false },
        logOnly: true,
      });
      expect(r.issues.some(i => i.startsWith('promesa_rota_logonly:email'))).toBe(true);
      expect(r.message).toContain('ya te lo envié'); // No modificado
    } finally { console.error = orig; }
  });

  test('sin executionFlags → no chequea promesa', () => {
    const r = v.validatePreSend('Ya te lo envié', { chatType: 'lead' });
    expect(r.issues.some(i => i.startsWith('promesa_rota'))).toBe(false);
  });
});

describe('T54 §D — Mecánica interna expuesta (lead/cliente)', () => {
  test('"firestore" en mensaje a lead → log issue', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('uso firestore para guardar tus datos', {
        chatType: 'lead',
        isSelfChat: false,
      });
      expect(r.issues.some(i => i.startsWith('internal_leak:'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('"baileys" en mensaje a lead → log issue', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('mi backend usa baileys', {
        chatType: 'miia_lead',
        isSelfChat: false,
      });
      expect(r.issues.some(i => i.startsWith('internal_leak:baileys'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('"backend" en self-chat → NO leak (owner allowed)', () => {
    const r = v.validatePreSend('el backend está caído', {
      chatType: 'owner',
      isSelfChat: true,
    });
    expect(r.issues.some(i => i.startsWith('internal_leak'))).toBe(false);
  });

  test('"firestore" en mensaje a familia → NO leak', () => {
    const r = v.validatePreSend('uso firestore', {
      chatType: 'familia',
      isSelfChat: false,
    });
    expect(r.issues.some(i => i.startsWith('internal_leak'))).toBe(false);
  });

  test('mensaje sin terminos prohibidos → no issue', () => {
    const r = v.validatePreSend('hola, todo bien? te escribo de parte de Acme', {
      chatType: 'lead',
    });
    expect(r.issues.some(i => i.startsWith('internal_leak'))).toBe(false);
  });
});

describe('T54 §E — Mensaje vacío post-sanitización', () => {
  test('solo tags → vacio post-strip → fallback owner', () => {
    const orig1 = console.warn;
    const orig2 = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      // R-Vi-2: regex requiere [A-Z][A-Z_]+ (>=2 chars mayusculas)
      const r = v.validatePreSend('[FOO:1][BAR:2]', { isSelfChat: true });
      expect(r.message).toMatch(/✅ Listo/);
      expect(r.issues).toContain('empty_after_sanitize');
    } finally {
      console.warn = orig1;
      console.error = orig2;
    }
  });

  test('solo tags → vacio post-strip → fallback lead', () => {
    const orig1 = console.warn;
    const orig2 = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      const r = v.validatePreSend('[FOO:1]', { chatType: 'lead', isSelfChat: false });
      expect(r.message).toMatch(/🤷‍♀️/);
    } finally {
      console.warn = orig1;
      console.error = orig2;
    }
  });
});

describe('T54 §F — Mensaje demasiado largo', () => {
  test('mensaje > 4000 chars → truncado', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const longMsg = 'A'.repeat(3000) + '. ' + 'B'.repeat(2000) + '.';
      const r = v.validatePreSend(longMsg, {});
      expect(r.message.length).toBeLessThanOrEqual(v.MAX_MESSAGE_LENGTH + 1);
      expect(r.issues).toContain('truncated');
      expect(r.wasModified).toBe(true);
    } finally { console.warn = orig; }
  });

  test('mensaje justo en limite → no trunca', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const exactMsg = 'A'.repeat(v.MAX_MESSAGE_LENGTH);
      const r = v.validatePreSend(exactMsg, {});
      expect(r.issues).not.toContain('truncated');
    } finally { console.warn = orig; }
  });

  test('mensaje muy largo sin punto → cuts at MAX', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const longNoStop = 'X'.repeat(v.MAX_MESSAGE_LENGTH + 500);
      const r = v.validatePreSend(longNoStop, {});
      expect(r.message.length).toBeLessThanOrEqual(v.MAX_MESSAGE_LENGTH + 1);
    } finally { console.warn = orig; }
  });
});

describe('T54 §G — logPrefix custom', () => {
  test('logPrefix custom aparece en logs', () => {
    const captured = [];
    const orig = console.warn;
    console.warn = (...a) => captured.push(a.join(' '));
    try {
      v.validatePreSend('hola [TAG:1] mundo', { logPrefix: '[TEST-PREFIX]' });
      expect(captured.some(l => l.includes('[TEST-PREFIX]'))).toBe(true);
    } finally { console.warn = orig; }
  });
});

describe('T54 §H — Constantes exportadas', () => {
  test('MAX_MESSAGE_LENGTH = 4000', () => {
    expect(v.MAX_MESSAGE_LENGTH).toBe(4000);
  });
  test('ACTION_CONFIRMATIONS tiene 6 acciones', () => {
    const keys = Object.keys(v.ACTION_CONFIRMATIONS);
    expect(keys).toContain('email');
    expect(keys).toContain('agenda');
    expect(keys).toContain('tarea');
    expect(keys).toContain('cancel');
    expect(keys).toContain('move');
    expect(keys).toContain('cotizacion');
  });
  test('INTERNAL_MECHANICS array no vacio', () => {
    expect(Array.isArray(v.INTERNAL_MECHANICS)).toBe(true);
    expect(v.INTERNAL_MECHANICS.length).toBeGreaterThan(5);
    expect(v.INTERNAL_MECHANICS).toContain('firestore');
    expect(v.INTERNAL_MECHANICS).toContain('baileys');
  });
});
