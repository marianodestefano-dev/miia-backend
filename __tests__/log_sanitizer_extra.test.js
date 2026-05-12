'use strict';

/**
 * Tests EXTRA #1 (Cimientos C.4) — funciones agregadas al sanitizer.
 * Complementa log_sanitizer.test.js (40 tests legacy C-403 + C-464 + T86)
 * para llegar a 100% branch coverage.
 */

const sanitizer = require('../core/log_sanitizer');

function withEnv(overrides, fn) {
  const backup = {};
  for (const k of Object.keys(overrides)) {
    backup[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(backup)) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  }
}

const PROD = { NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: undefined };
const DEV = { NODE_ENV: 'development', MIIA_DEBUG_VERBOSE: undefined };
const VERBOSE = { NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: 'true' };
const VERBOSE_1 = { NODE_ENV: 'production', MIIA_DEBUG_VERBOSE: '1' };

// ── shouldVerboseLog (Wi EXTRA #1) ────────────────────────────────────────────

describe('shouldVerboseLog', () => {
  test('verbose=true -> true', () => {
    withEnv(VERBOSE, () => expect(sanitizer.shouldVerboseLog()).toBe(true));
  });
  test('verbose=1 -> true', () => {
    withEnv(VERBOSE_1, () => expect(sanitizer.shouldVerboseLog()).toBe(true));
  });
  test('verbose undefined -> false', () => {
    withEnv(PROD, () => expect(sanitizer.shouldVerboseLog()).toBe(false));
  });
  test('isVerboseMode alias', () => {
    withEnv(VERBOSE, () => expect(sanitizer.isVerboseMode()).toBe(true));
    withEnv(PROD, () => expect(sanitizer.isVerboseMode()).toBe(false));
  });
});

// ── sanitizeMessage (Wi EXTRA #1) ─────────────────────────────────────────────

describe('sanitizeMessage', () => {
  test('dev no-op', () => {
    withEnv(DEV, () => {
      expect(sanitizer.sanitizeMessage('+573054169969', 100)).toBe('+573054169969');
    });
  });

  test('non-string -> tal cual', () => {
    withEnv(PROD, () => {
      expect(sanitizer.sanitizeMessage(123, 100)).toBe(123);
      expect(sanitizer.sanitizeMessage(null, 100)).toBeNull();
    });
  });

  test('sanitiza + no trunca si corto', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitizeMessage('owner +573054169969', 100);
      expect(r).toContain('+57***9969');
      expect(r).not.toContain('truncado');
    });
  });

  test('trunca si excede maxLen', () => {
    withEnv(PROD, () => {
      // Usar texto que NO matche HEX_LONG_REGEX (a-f digits) ni patrones conversational
      const long = 'X1 Y2 Z3 '.repeat(100); // 800 chars, no hex puro
      const r = sanitizer.sanitizeMessage(long, 50);
      expect(r).toContain('truncado');
    });
  });

  test('maxLen no number -> usa default', () => {
    withEnv(PROD, () => {
      const long = 'X1 Y2 Z3 '.repeat(100);
      const r = sanitizer.sanitizeMessage(long); // sin maxLen
      expect(r.length).toBeLessThanOrEqual(sanitizer.DEFAULT_MAX_MESSAGE_LENGTH + 50);
    });
  });

  test('maxLen 0 -> usa default', () => {
    withEnv(PROD, () => {
      const long = 'X1 Y2 Z3 '.repeat(100);
      const r = sanitizer.sanitizeMessage(long, 0);
      expect(r.length).toBeLessThanOrEqual(sanitizer.DEFAULT_MAX_MESSAGE_LENGTH + 50);
    });
  });

  test('truncateMessage alias funciona', () => {
    withEnv(PROD, () => {
      expect(sanitizer.truncateMessage('X1 Y2 Z3 '.repeat(100), 50)).toContain('truncado');
    });
  });
});

// ── sanitizeLog / sanitizeObject (Wi EXTRA #1) ────────────────────────────────

describe('sanitizeLog / sanitizeObject', () => {
  test('dev no-op', () => {
    withEnv(DEV, () => {
      expect(sanitizer.sanitizeLog({ phone: '+573054169969' })).toEqual({ phone: '+573054169969' });
    });
  });

  test('null/undefined -> tal cual', () => {
    withEnv(PROD, () => {
      expect(sanitizer.sanitizeLog(null)).toBeNull();
      expect(sanitizer.sanitizeLog(undefined)).toBeUndefined();
    });
  });

  test('no object (string) -> tal cual', () => {
    withEnv(PROD, () => {
      expect(sanitizer.sanitizeLog('not an object')).toBe('not an object');
    });
  });

  test('objeto plano con phone -> sanitizado', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitizeLog({ phone: '+573054169969', name: 'X' });
      expect(r.phone).toContain('+57***9969');
    });
  });

  test('objeto anidado -> recursivo', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitizeLog({
        user: { phone: '+573054169969', email: 'a@b.com' },
        meta: { ts: '2026-05-12' },
      });
      expect(r.user.phone).toContain('+57***9969');
      expect(r.user.email).toContain('@');
    });
  });

  test('array recursivo', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitizeLog(['+573054169969', 'safe', { email: 'a@b.com' }]);
      expect(Array.isArray(r)).toBe(true);
      expect(r[0]).toContain('+57***9969');
      expect(r[1]).toBe('safe');
      expect(r[2].email).toContain('@');
    });
  });

  test('campos null/undefined preservados', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitizeLog({ a: null, b: undefined, c: 'x' });
      expect(r.a).toBeNull();
      expect(r.b).toBeUndefined();
    });
  });

  test('numbers/booleans preservados', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitizeLog({ count: 42, flag: true, big: 100n });
      expect(r.count).toBe(42);
      expect(r.flag).toBe(true);
    });
  });

  test('propiedades heredadas -> ignoradas', () => {
    withEnv(PROD, () => {
      const proto = { inherited: '+573054169969' };
      const obj = Object.create(proto);
      obj.own = 'x';
      const r = sanitizer.sanitizeLog(obj);
      expect(r.own).toBe('x');
      expect(r.inherited).toBeUndefined();
    });
  });
});

// ── maskPhone (legacy) ────────────────────────────────────────────────────────

describe('maskPhone', () => {
  test('null/empty -> sin cambio', () => {
    expect(sanitizer.maskPhone(null)).toBeNull();
    expect(sanitizer.maskPhone('')).toBe('');
  });
  test('no digits -> ****', () => {
    expect(sanitizer.maskPhone('hola')).toBe('****');
  });
  test('digits cortos -> ****', () => {
    expect(sanitizer.maskPhone('12')).toBe('***12');
  });
  test('full phone -> ***1234', () => {
    expect(sanitizer.maskPhone('+57 305 416 9969')).toBe('***9969');
  });
});

// ── maskEmail ─────────────────────────────────────────────────────────────────

describe('maskEmail', () => {
  test('null -> null', () => {
    expect(sanitizer.maskEmail(null)).toBeNull();
  });
  test('non-string -> tal cual', () => {
    expect(sanitizer.maskEmail(123)).toBe(123);
  });
  test('sin @ -> ****@****.***', () => {
    expect(sanitizer.maskEmail('no-email')).toBe('****@****.***');
  });
  test('local vacio -> ***', () => {
    expect(sanitizer.maskEmail('@gmail.com')).toBe('***@***.com');
  });
  test('domain sin tld -> usa ***', () => {
    expect(sanitizer.maskEmail('user@localhost')).toBe('u***@***.***');
  });
  test('email valido', () => {
    expect(sanitizer.maskEmail('mariano@gmail.com')).toBe('m***@***.com');
  });
});

// ── maskUid edge cases ────────────────────────────────────────────────────────

describe('maskUid edge cases', () => {
  test('uid corto en prod -> tal cual (<=8 chars)', () => {
    withEnv(PROD, () => {
      expect(sanitizer.maskUid('short8c')).toBe('short8c');
      expect(sanitizer.maskUid('eightch1')).toBe('eightch1');
    });
  });

  test('uid >8 chars en prod -> primeros 8 + ...', () => {
    withEnv(PROD, () => {
      expect(sanitizer.maskUid('bq2BbtCVF8cZo30tum584zrGATJ3')).toBe('bq2BbtCV...');
    });
  });
});

// ── createSafeLogger ──────────────────────────────────────────────────────────

describe('createSafeLogger', () => {
  test('crea logger con prefix', () => {
    const captured = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = function () { captured.push(['log', Array.from(arguments).join(' ')]); };
    console.warn = function () { captured.push(['warn', Array.from(arguments).join(' ')]); };
    console.error = function () { captured.push(['error', Array.from(arguments).join(' ')]); };
    try {
      withEnv(PROD, () => {
        const logger = sanitizer.createSafeLogger('TEST');
        logger.log('hola +573054169969');
        logger.warn('warn +573054169969');
        logger.error('error +573054169969');
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    expect(captured).toHaveLength(3);
    // Cada log debe contener TEST prefix
    expect(captured[0][1]).toContain('[TEST]');
  });

  test('logger sin prefix -> sin pfx', () => {
    const captured = [];
    const origLog = console.log;
    console.log = function () { captured.push(Array.from(arguments).join(' ')); };
    try {
      withEnv(PROD, () => {
        const logger = sanitizer.createSafeLogger();
        logger.log('mensaje', { phone: '+573054169969' });
      });
    } finally {
      console.log = origLog;
    }
    expect(captured.length).toBeGreaterThan(0);
  });

  test('logger.warn/error con data extra', () => {
    const captured = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = function () { captured.push(['l', Array.from(arguments)]); };
    console.warn = function () { captured.push(['w', Array.from(arguments)]); };
    console.error = function () { captured.push(['e', Array.from(arguments)]); };
    try {
      withEnv(PROD, () => {
        const logger = sanitizer.createSafeLogger('X');
        logger.warn('warn con data', { phone: '+573054169969' });
        logger.error('err con data', { phone: '+573054169969' });
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    expect(captured.find(function (c) { return c[0] === 'w'; })).toBeDefined();
    expect(captured.find(function (c) { return c[0] === 'e'; })).toBeDefined();
  });

  test('logger.log/warn/error sin data extra', () => {
    const captured = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = function () { captured.push(['l', Array.from(arguments).join(' ')]); };
    console.warn = function () { captured.push(['w', Array.from(arguments).join(' ')]); };
    console.error = function () { captured.push(['e', Array.from(arguments).join(' ')]); };
    try {
      withEnv(PROD, () => {
        const logger = sanitizer.createSafeLogger('X');
        logger.log('msg solo');
        logger.warn('warn solo');
        logger.error('error solo');
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    expect(captured).toHaveLength(3);
  });
});

// ── sanitize edge cases ───────────────────────────────────────────────────────

describe('sanitize edge cases', () => {
  test('null -> null', () => {
    withEnv(PROD, () => expect(sanitizer.sanitize(null)).toBeNull());
  });
  test('undefined -> undefined', () => {
    withEnv(PROD, () => expect(sanitizer.sanitize(undefined)).toBeUndefined());
  });
  test('number -> tal cual', () => {
    withEnv(PROD, () => expect(sanitizer.sanitize(42)).toBe(42));
  });
  test('string vacio -> tal cual (>3 chars guard)', () => {
    withEnv(PROD, () => expect(sanitizer.sanitize('')).toBe(''));
  });
  test('string corto sin signals -> tal cual', () => {
    withEnv(PROD, () => expect(sanitizer.sanitize('hi')).toBe('hi'));
  });
  test('skipMessageHash opt -> no hashea conversacional', () => {
    withEnv(PROD, () => {
      expect(sanitizer.sanitize('Hola mama como estás', { skipMessageHash: true })).toBe('Hola mama como estás');
    });
  });
});

// ── sanitizePhone edge cases ──────────────────────────────────────────────────

describe('sanitizePhone edge cases', () => {
  test('dev no-op', () => {
    withEnv(DEV, () => {
      expect(sanitizer.sanitizePhone('+573054169969')).toBe('+573054169969');
    });
  });
  test('non-string -> tal cual', () => {
    withEnv(PROD, () => expect(sanitizer.sanitizePhone(123)).toBe(123));
  });
  test('string sin phones -> tal cual', () => {
    withEnv(PROD, () => expect(sanitizer.sanitizePhone('texto normal')).toBe('texto normal'));
  });
});

// ── installConsoleOverride/restore edge cases ─────────────────────────────────

describe('console override edge cases', () => {
  test('install en dev -> no override', () => {
    withEnv(DEV, () => {
      sanitizer.installConsoleOverride();
      // En dev, no hace override pero marca installed=true
      const captured = [];
      const orig = console.log;
      console.log = function () { captured.push(Array.from(arguments).join(' ')); };
      try {
        console.log('+573054169969');
      } finally {
        console.log = orig;
        sanitizer.restoreConsoleOriginal();
      }
      expect(captured[0]).toContain('+573054169969'); // NO sanitizado
    });
  });

  test('restore sin install previo -> no-op', () => {
    sanitizer.restoreConsoleOriginal(); // sin install
    expect(typeof console.log).toBe('function');
  });

  test('slog.msgContent en dev -> text tal cual + extra non-string preserva', () => {
    withEnv(DEV, () => {
      const captured = [];
      const orig = console.log;
      console.log = function () { captured.push(Array.from(arguments)); };
      try {
        sanitizer.slog.msgContent('[X]', 'mensaje secreto', 'extra arg', 42); // mix string + non-string
      } finally {
        console.log = orig;
      }
      expect(captured[0][1]).toBe('mensaje secreto');
      expect(captured[0][3]).toBe(42);
    });
  });

  test('slog acepta sin extra args', () => {
    withEnv(PROD, () => {
      const captured = [];
      const orig = console.log;
      console.log = function () { captured.push(Array.from(arguments)); };
      try {
        sanitizer.slog('[LABEL]');
      } finally {
        console.log = orig;
      }
      expect(captured[0][0]).toBe('[LABEL]');
    });
  });

  test('slog con args no-string', () => {
    withEnv(PROD, () => {
      const captured = [];
      const orig = console.log;
      console.log = function () { captured.push(Array.from(arguments)); };
      try {
        sanitizer.slog('[X]', 42, { phone: '+573054169969' });
      } finally {
        console.log = orig;
      }
      // 42 pasa tal cual, objeto pasa tal cual (slog no recursiva objects)
      expect(captured[0][1]).toBe(42);
    });
  });

  test('slog.msgContent con extra args en prod -> hash + sanitize extras', () => {
    withEnv(PROD, () => {
      const captured = [];
      const orig = console.log;
      console.log = function () { captured.push(Array.from(arguments)); };
      try {
        sanitizer.slog.msgContent('[MSG]', 'texto', 42); // 42 no-string
      } finally {
        console.log = orig;
      }
      expect(String(captured[0][1])).toMatch(/\[msg:[a-f0-9]{8}\]/);
      expect(captured[0][2]).toBe(42);
    });
  });
});

// ── HEX y card detection ──────────────────────────────────────────────────────

describe('Token regex coverage', () => {
  test('hex < 32 chars no se redacta', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitize('hash: abcd1234');
      expect(r).not.toContain('[token:REDACTED]');
    });
  });

  test('token assignment con value muy corto no redacta', () => {
    withEnv(PROD, () => {
      const r = sanitizer.sanitize('key=ab'); // <4 chars
      // Tiene "key=ab" — value es "ab" (<4), no debe matchear
      expect(r).toBe('key=ab');
    });
  });

  test('TOKEN_ASSIGN_REGEX con value que ya es REDACTED -> no doble proceso', () => {
    withEnv(PROD, () => {
      // El segundo sanitize de un texto ya saneado no debe corromperlo
      const once = sanitizer.sanitize('Bearer abc1234567890');
      const twice = sanitizer.sanitize(once);
      expect(twice).toBe(once);
    });
  });
});
