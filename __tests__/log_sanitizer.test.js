'use strict';

/**
 * Tests de log_sanitizer.js — C-403 Cimientos §3 C.4.
 *
 * Cases per carta C-403 §3(c):
 *   - sanitize phones/emails/tokens/messages
 *   - no false positive en strings sin PII
 *   - installConsoleOverride + console.log sanitiza
 *   - guards NODE_ENV + MIIA_DEBUG_VERBOSE (no-op cuando corresponde)
 */

const sanitizer = require('../core/log_sanitizer');

// Helper para ejecutar un test bajo un env específico
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

// ═══════════════════════════════════════════════════════════════
// §1 — Sanitización en modo ACTIVO (NODE_ENV=production, no debug)
// ═══════════════════════════════════════════════════════════════

describe('log_sanitizer — modo activo (production)', () => {
  const PROD_ENV = { NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined };

  test('sanitize phone E.164 → primeros 3 chars + *** + últimos 4', () => {
    withEnv(PROD_ENV, () => {
      expect(sanitizer.sanitize('+573054169969')).toBe('+57***9969');
    });
  });

  test('sanitize phone AR (+54)', () => {
    withEnv(PROD_ENV, () => {
      expect(sanitizer.sanitize('+5491164431700')).toBe('+54***1700');
    });
  });

  test('sanitize phone dentro de string más largo', () => {
    withEnv(PROD_ENV, () => {
      const out = sanitizer.sanitize('lead +573163937365 escribió');
      expect(out).toMatch(/\+57\*\*\*7365/);
      expect(out).not.toMatch(/573163937365/);
    });
  });

  test('sanitize email → primera letra + TLD', () => {
    withEnv(PROD_ENV, () => {
      expect(sanitizer.sanitize('mariano@gmail.com')).toBe('m***@***.com');
    });
  });

  test('sanitize email dentro de string', () => {
    withEnv(PROD_ENV, () => {
      const out = sanitizer.sanitize('owner=mariano.destefano@gmail.com activo');
      expect(out).toContain('m***@***.com');
      expect(out).not.toContain('mariano.destefano@gmail.com');
    });
  });

  test('sanitize Bearer token → [token:REDACTED]', () => {
    withEnv(PROD_ENV, () => {
      const out = sanitizer.sanitize('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123');
      expect(out).toContain('Bearer [token:REDACTED]');
      expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });
  });

  test('sanitize hex largo ≥32 chars → [token:REDACTED]', () => {
    withEnv(PROD_ENV, () => {
      const hash = 'f1ad844edd15d1e45f1727448d0ea3f19eee973fb95554ad56357c2c255872b8';
      const out = sanitizer.sanitize(`hash integrity: ${hash}`);
      expect(out).toContain('[token:REDACTED]');
      expect(out).not.toContain(hash);
    });
  });

  test('sanitize api_key assignment', () => {
    withEnv(PROD_ENV, () => {
      const out = sanitizer.sanitize('api_key=sk_live_abc123xyz456');
      expect(out).toContain('[token:REDACTED]');
    });
  });

  test('sanitize mensaje conversacional → [msg:<hex8>]', () => {
    withEnv(PROD_ENV, () => {
      const out = sanitizer.sanitize('Hola mama como estás');
      expect(out).toMatch(/^\[msg:[a-f0-9]{8}\]$/);
    });
  });

  test('sanitize texto normal sin PII → preservado (no false positive)', () => {
    withEnv(PROD_ENV, () => {
      expect(sanitizer.sanitize('texto normal sin PII')).toBe('texto normal sin PII');
    });
  });

  test('sanitize log técnico → preservado', () => {
    withEnv(PROD_ENV, () => {
      expect(sanitizer.sanitize('[AGENDA] T42 tick start')).toBe('[AGENDA] T42 tick start');
      expect(sanitizer.sanitize('HTTP 200 OK')).toBe('HTTP 200 OK');
    });
  });

  test('sanitize combo phone + email + mensaje', () => {
    withEnv(PROD_ENV, () => {
      const out = sanitizer.sanitize('lead +573163937365 (admin@test.com) dijo hola mama');
      expect(out).toMatch(/\+57\*\*\*7365/);
      expect(out).toMatch(/a\*\*\*@\*\*\*\.com/);
      // mensaje hasheado al final
      expect(out).not.toContain('573163937365');
      expect(out).not.toContain('admin@test.com');
    });
  });

  test('isActive() true en production sin debug flag', () => {
    withEnv(PROD_ENV, () => {
      expect(sanitizer.isActive()).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §2 — Guards: no-op en dev local o con MIIA_DEBUG_VERBOSE
// ═══════════════════════════════════════════════════════════════

describe('log_sanitizer — guards (no-op)', () => {
  test('MIIA_DEBUG_VERBOSE=true → no-op aunque sea production', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: 'true' }, () => {
      expect(sanitizer.sanitize('+573054169969')).toBe('+573054169969');
      expect(sanitizer.sanitize('Hola mama como estás')).toBe('Hola mama como estás');
      expect(sanitizer.isActive()).toBe(false);
    });
  });

  test('NODE_ENV=development → no-op (dev local safe sin flag)', () => {
    withEnv({ NODE_ENV: 'development', MIIA_DEBUG_VERBOSE: undefined }, () => {
      expect(sanitizer.sanitize('+573054169969')).toBe('+573054169969');
      expect(sanitizer.isActive()).toBe(false);
    });
  });

  test('NODE_ENV undefined → no-op', () => {
    withEnv({ NODE_ENV: undefined, MIIA_DEBUG_VERBOSE: undefined }, () => {
      expect(sanitizer.sanitize('+573054169969')).toBe('+573054169969');
      expect(sanitizer.isActive()).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §3 — installConsoleOverride: capturar output real
// ═══════════════════════════════════════════════════════════════

describe('log_sanitizer — installConsoleOverride', () => {
  test('console.log sanitiza phone en log estructural (phone visible sanitizado, contenido conversacional preservado)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.join(' '));

      try {
        sanitizer.installConsoleOverride();
        // Log estructural tipo "lead X dijo Y" — queremos phone sanitizado visible
        console.log('lead +573054169969 dijo hola mama como estás');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      const output = captured.join('\n');
      expect(output).not.toContain('573054169969');
      expect(output).toMatch(/\+57\*\*\*9969/);
      // El contenido conversacional queda visible porque el string ya tiene
      // marca de sanitización (PII crítica protegida). Policy: no hashear
      // strings con PII ya sanitizada — preserva observabilidad de logs.
    });
  });

  test('console.log hashea mensaje conversacional standalone (sin PII sanitizada previa)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.join(' '));

      try {
        sanitizer.installConsoleOverride();
        // String conversacional puro (sin PII previa) → hashear completo
        console.log('Hola mama como estás');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      const output = captured.join('\n');
      expect(output).not.toContain('Hola mama');
      expect(output).toMatch(/\[msg:[a-f0-9]{8}\]/);
    });
  });

  test('console.warn también sanitiza', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalWarn = console.warn;
      console.warn = (...args) => captured.push(args.join(' '));

      try {
        sanitizer.installConsoleOverride();
        console.warn('rate limit for +573163937365 exceeded');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.warn = originalWarn;
      }

      expect(captured.join('\n')).toMatch(/\+57\*\*\*7365/);
    });
  });

  test('override es idempotente — doble install no rompe', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.join(' '));

      try {
        sanitizer.installConsoleOverride();
        sanitizer.installConsoleOverride(); // segunda vez debería ser no-op
        console.log('check +573054169969');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      expect(captured.join('\n')).toMatch(/\+57\*\*\*9969/);
      expect(captured.length).toBe(1); // NO doble-loguea
    });
  });

  test('console.log con objeto pasa el objeto tal cual (v1 no toca objetos)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args);

      try {
        sanitizer.installConsoleOverride();
        console.log('ctx:', { phone: '+573054169969' });
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      // El objeto se pasa sin modificar (spec §3(a) punto 3 v1)
      expect(captured[0][1]).toEqual({ phone: '+573054169969' });
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §4 — slog wrapper
// ═══════════════════════════════════════════════════════════════

describe('log_sanitizer — slog()', () => {
  test('slog sanitiza label + args', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.join(' '));

      try {
        sanitizer.installConsoleOverride();
        sanitizer.slog('[TEST]', 'owner +573054169969 logged in');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      expect(captured.join('\n')).toMatch(/\+57\*\*\*9969/);
      expect(captured.join('\n')).not.toContain('573054169969');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// §5 — slog.msgContent() — Opción C híbrida (firmada Mariano 2026-04-24)
// Hashea text SIEMPRE si sanitizer activo, sin importar contenido.
// ═══════════════════════════════════════════════════════════════

describe('log_sanitizer — slog.msgContent()', () => {
  test('text sin vocativo → hasheado SIEMPRE (no depende de looksLikeMessage)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.map((x) => String(x)).join(' '));

      try {
        sanitizer.installConsoleOverride();
        // "quiero agendar lunes" NO tiene vocativo — Policy A no lo hashearía;
        // msgContent SÍ debe hashearlo porque es contenido de mensaje explícito.
        sanitizer.slog.msgContent('[MSG IN]', 'quiero agendar lunes');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      const output = captured.join('\n');
      expect(output).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(output).not.toContain('quiero agendar');
    });
  });

  test('text con vocativo → hasheado también', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.map((x) => String(x)).join(' '));

      try {
        sanitizer.installConsoleOverride();
        sanitizer.slog.msgContent('[MSG IN]', 'Hola mama');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      const output = captured.join('\n');
      expect(output).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(output).not.toContain('Hola mama');
    });
  });

  test('MIIA_DEBUG_VERBOSE=true → text pasa tal cual (no-op)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: 'true' }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.map((x) => String(x)).join(' '));

      try {
        sanitizer.installConsoleOverride();
        sanitizer.slog.msgContent('[MSG IN]', 'quiero agendar lunes');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      const output = captured.join('\n');
      expect(output).toContain('quiero agendar lunes');
      expect(output).not.toMatch(/\[msg:[a-f0-9]{8}\]/);
    });
  });

  test('extra args pasan por sanitize() normal (phone en extra queda sanitizado)', () => {
    withEnv({ NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined }, () => {
      const captured = [];
      const originalLog = console.log;
      console.log = (...args) => captured.push(args.map((x) => String(x)).join(' '));

      try {
        sanitizer.installConsoleOverride();
        sanitizer.slog.msgContent('[MSG IN]', 'quiero agendar', 'from +573054169969');
      } finally {
        sanitizer.restoreConsoleOriginal();
        console.log = originalLog;
      }

      const output = captured.join('\n');
      expect(output).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(output).toMatch(/\+57\*\*\*9969/);
      expect(output).not.toContain('573054169969');
      expect(output).not.toContain('quiero agendar');
    });
  });
});
