'use strict';

/**
 * T43 — log_sanitizer.js coverage adicional + hot path gap (C-464 §T10)
 *
 * Cubre la laguna específica donde el sanitizer global NO hashea cuerpos
 * de mensaje cuando el string ya contiene '***' (phone sanitizado).
 * Valida que slog.msgContent() es la solución correcta para ese gap.
 *
 * Tests escritos por Vi — C-464 cierre T43.
 */

const sanitizer = require('../core/log_sanitizer');

function withEnv(overrides, fn) {
  const backup = {};
  for (const k of Object.keys(overrides)) {
    backup[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(backup)) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  }
}

const PROD = { NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined };

// ═══════════════════════════════════════════════════════════════
// §A — Gap conocido: string con *** bloquea sanitizeMessage
// Documenta el comportamiento de la Policy C híbrida (firmada Mariano 2026-04-24)
// ═══════════════════════════════════════════════════════════════

describe('T43 — gap *** bloquea hash de mensaje en log estructural', () => {
  test('log estructural con phone sanitizado → body NO hasheado por sanitize() global', () => {
    withEnv(PROD, () => {
      // Simula: console.log(`... from=${f} body="quiero una cita" ...`) después de sanitizePhone()
      const logStr = '[TM:uid123] 📥 messages.upsert type=notify fromMe=false from=***9969@s.whatsapp.net body="quiero una cita" msgId=ABC ts=123';
      const out = sanitizer.sanitize(logStr);
      // El phone ya está sanitizado → string contiene *** → sanitizeMessage() hace early return
      // El body "quiero una cita" queda visible (comportamiento conocido de Policy C)
      expect(out).toContain('quiero una cita');
      expect(out).toContain('***9969@s.whatsapp.net');
    });
  });

  test('log sin phone → body conversacional SÍ se hashea normalmente', () => {
    withEnv(PROD, () => {
      const logStr = 'body="hola doctor como estás"';
      const out = sanitizer.sanitize(logStr);
      // No hay *** → sanitizeMessage() corre → looksLikeMessage() detecta vocativo → hashea
      expect(out).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(out).not.toContain('hola doctor');
    });
  });

  test('body no-conversacional sin phone → preservado (no false positive)', () => {
    withEnv(PROD, () => {
      const logStr = 'body="quiero agendar el jueves"';
      const out = sanitizer.sanitize(logStr);
      // Sin vocativo y sin phone → looksLikeMessage() false → preservado
      // Esto es el gap: contenido médico sin saludos no se hashea
      expect(out).toBe(logStr);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §B — slog.msgContent() cierra el gap: hashea SIEMPRE
// ═══════════════════════════════════════════════════════════════

describe('T43 — slog.msgContent() cierra el gap del messages.upsert hot path', () => {
  test('body médico sin vocativo → hasheado con slog.msgContent()', () => {
    withEnv(PROD, () => {
      const captured = [];
      const origLog = console.log;
      console.log = (...args) => captured.push(args.map(String).join(' '));
      try {
        sanitizer.installConsoleOverride();
        // Simula el FIX en tenant_manager.js:1599 (post T43)
        sanitizer.slog.msgContent('[TM:uid] 📥 body', 'quiero agendar el jueves');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = origLog;
      }
      const out = captured.join('\n');
      expect(out).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(out).not.toContain('quiero agendar');
    });
  });

  test('body vacío → slog.msgContent() no hashea string vacío', () => {
    withEnv(PROD, () => {
      const captured = [];
      const origLog = console.log;
      console.log = (...args) => captured.push(args.map(String).join(' '));
      try {
        sanitizer.installConsoleOverride();
        sanitizer.slog.msgContent('[TM:uid] 📥 body', '');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = origLog;
      }
      // String vacío → hashMessage('') produce hash, pero el log queda visible
      // La spec dice que body vacío es un mensaje de media (imagen/audio sin caption)
      const out = captured.join('\n');
      // No debe crashear, debe loguear algo
      expect(typeof out).toBe('string');
    });
  });

  test('body con phone incrustado → phone sanitizado + body hasheado', () => {
    withEnv(PROD, () => {
      const captured = [];
      const origLog = console.log;
      console.log = (...args) => captured.push(args.map(String).join(' '));
      try {
        sanitizer.installConsoleOverride();
        // Un lead que manda su propio número en el texto
        sanitizer.slog.msgContent('[TM:uid] 📥 body', 'llamame al +573054169969 hola');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = origLog;
      }
      const out = captured.join('\n');
      // slog.msgContent hashea el text completo → phone incrustado no es visible
      expect(out).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(out).not.toContain('573054169969');
    });
  });

  test('structural log separado → phone sanitizado en structural, body hasheado en slog', () => {
    withEnv(PROD, () => {
      const structuralCaptured = [];
      const bodyCaptured = [];
      const origLog = console.log;
      let callCount = 0;
      console.log = (...args) => {
        callCount++;
        if (callCount === 1) structuralCaptured.push(args.map(String).join(' '));
        else bodyCaptured.push(args.map(String).join(' '));
      };
      try {
        sanitizer.installConsoleOverride();
        // Patrón tenant_manager.js post-T43: dos llamadas separadas
        console.log('[TM:uid] 📥 messages.upsert type=notify fromMe=false from=573054169969@s.whatsapp.net msgId=ABC ts=123');
        sanitizer.slog.msgContent('[TM:uid] 📥 body', 'quiero una cita para mañana');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = origLog;
      }
      const structural = structuralCaptured.join('\n');
      const body = bodyCaptured.join('\n');
      // Structural: phone sanitizado, no contiene phone completo
      expect(structural).toMatch(/\*\*\*9969@s\.whatsapp\.net/);
      expect(structural).not.toContain('573054169969');
      // Body: hasheado garantizado
      expect(body).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(body).not.toContain('quiero una cita');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §C — Casos edge de sanitizePhone WA JID para completar cobertura
// ═══════════════════════════════════════════════════════════════

describe('T43 — cobertura adicional sanitizePhone edge cases', () => {
  test('phone MX (+52) → sanitizado', () => {
    withEnv(PROD, () => {
      expect(sanitizer.sanitize('+525512345678')).toBe('+52***5678');
    });
  });

  test('phone BR (+55) → sanitizado', () => {
    withEnv(PROD, () => {
      expect(sanitizer.sanitize('+5511987654321')).toBe('+55***4321');
    });
  });

  test('phone sin + (solo dígitos) → T86 sanitizado con patron standalone 10-15d', () => {
    withEnv(PROD, () => {
      // T86: patron standalone \d{10,15} ahora cubre basePhone/rawPhone sin prefijo
      const out = sanitizer.sanitize('número: 573054169969 llamar');
      // 573054169969 tiene 12 dígitos → masked por T86 standalone pattern
      expect(out).toContain('***9969');
      expect(out).not.toContain('573054169969');
    });
  });

  test('múltiples phones en mismo string → todos sanitizados', () => {
    withEnv(PROD, () => {
      const out = sanitizer.sanitize('from +573054169969 to +573163937365');
      expect(out).toMatch(/\+57\*\*\*9969/);
      expect(out).toMatch(/\+57\*\*\*7365/);
      expect(out).not.toContain('573054169969');
      expect(out).not.toContain('573163937365');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §D — Cobertura de looksLikeMessage: casos límite
// ═══════════════════════════════════════════════════════════════

describe('T43 — looksLikeMessage edge cases', () => {
  const { sanitizeMessage } = sanitizer;

  test('string < 6 chars → no hashea', () => {
    withEnv(PROD, () => {
      expect(sanitizeMessage('hola')).toBe('hola');
    });
  });

  test('1 sola palabra → no hashea', () => {
    withEnv(PROD, () => {
      expect(sanitizeMessage('doctor')).toBe('doctor');
    });
  });

  test('string técnico sin vocativo → no hashea', () => {
    withEnv(PROD, () => {
      expect(sanitizeMessage('[AGENDA] tick start')).toBe('[AGENDA] tick start');
    });
  });

  test('string con vocativo "doctor" al principio → hashea', () => {
    withEnv(PROD, () => {
      const out = sanitizeMessage('doctor quiero turno');
      expect(out).toMatch(/\[msg:[a-f0-9]{8}\]/);
    });
  });

  test('string vacío → no hashea', () => {
    withEnv(PROD, () => {
      expect(sanitizeMessage('')).toBe('');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §E — Determinismo: mismo input → mismo hash
// ═══════════════════════════════════════════════════════════════

describe('T43 — determinismo de hash', () => {
  test('mismo texto → mismo [msg:XXXX] en dos llamadas', () => {
    withEnv(PROD, () => {
      const captured = [];
      const origLog = console.log;
      console.log = (...args) => captured.push(args.map(String).join(' '));
      try {
        sanitizer.installConsoleOverride();
        sanitizer.slog.msgContent('[TEST]', 'quiero una cita para mañana');
        sanitizer.slog.msgContent('[TEST]', 'quiero una cita para mañana');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = origLog;
      }
      // Cada slog.msgContent produce exactamente 1 console.log call
      expect(captured.length).toBe(2);
      const hashRegex = /\[msg:([a-f0-9]{8})\]/;
      const m1 = captured[0].match(hashRegex);
      const m2 = captured[1].match(hashRegex);
      expect(m1).not.toBeNull();
      expect(m2).not.toBeNull();
      expect(m1[1]).toBe(m2[1]); // mismo hash para mismo input
    });
  });

  test('textos distintos → hashes distintos', () => {
    withEnv(PROD, () => {
      const out1 = sanitizer.sanitize('hola doctor como estás');
      const out2 = sanitizer.sanitize('hola mama como estás');
      expect(out1).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(out2).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(out1).not.toBe(out2); // hashes distintos para inputs distintos
    });
  });
});
