'use strict';

/**
 * T76 — circuit_breaker_alerts.js coverage + behavior tests
 */

const cba = require('../core/circuit_breaker_alerts');

beforeEach(() => {
  cba._resetForTests();
});

describe('T76 §A — pollState transitions', () => {
  test('estado inicial closed → poll closed: no transition', () => {
    const r = cba.pollState(false, 'gemini');
    expect(r.transition).toBeNull();
    expect(r.notified).toBe(false);
  });

  test('closed → open: transition opened + notified', () => {
    const r = cba.pollState(true, 'gemini');
    expect(r.transition).toBe('opened');
    expect(r.notified).toBe(true);
  });

  test('open → open (sin cambio): no transition', () => {
    cba.pollState(true, 'gemini');
    const r = cba.pollState(true, 'gemini');
    expect(r.transition).toBeNull();
    expect(r.notified).toBe(false);
  });

  test('open → closed: transition closed + notified', () => {
    cba.pollState(true, 'gemini');
    // Avanzar tiempo para evitar cooldown
    const origNow = Date.now;
    Date.now = () => origNow() + cba.COOLDOWN_BETWEEN_NOTIFY_MS + 1000;
    try {
      const r = cba.pollState(false, 'gemini');
      expect(r.transition).toBe('closed');
      expect(r.notified).toBe(true);
    } finally { Date.now = origNow; }
  });

  test('system null/undefined → no-op', () => {
    expect(cba.pollState(true, null).transition).toBeNull();
    expect(cba.pollState(true, undefined).transition).toBeNull();
  });
});

describe('T76 §B — anti-spam cooldown', () => {
  test('open → close → open en <60s: 2da open NO notifica', () => {
    cba.pollState(true, 'gemini'); // notified
    cba.pollState(false, 'gemini'); // close (dentro cooldown, NO notifica)
    const r = cba.pollState(true, 'gemini'); // open de nuevo (dentro cooldown)
    expect(r.transition).toBe('opened');
    expect(r.notified).toBe(false); // cooldown activo
  });

  test('open → close > 60s después: SI notifica close', () => {
    const origNow = Date.now;
    const t0 = origNow();
    Date.now = () => t0;
    try {
      cba.pollState(true, 'gemini'); // open notified
      Date.now = () => t0 + cba.COOLDOWN_BETWEEN_NOTIFY_MS + 5000;
      const r = cba.pollState(false, 'gemini');
      expect(r.transition).toBe('closed');
      expect(r.notified).toBe(true);
    } finally { Date.now = origNow; }
  });
});

describe('T76 §C — onOpen / onClosed callbacks', () => {
  test('onOpen invocado con system + meta en transition', async () => {
    const captured = [];
    cba.onOpen((sys, meta) => { captured.push({ sys, meta }); });
    cba.pollState(true, 'gemini', { statusCode: 503 });
    await new Promise(r => setImmediate(r));
    expect(captured.length).toBe(1);
    expect(captured[0].sys).toBe('gemini');
    expect(captured[0].meta.statusCode).toBe(503);
    expect(captured[0].meta.openCount24h).toBe(1);
  });

  test('onClosed invocado con downtime_ms', async () => {
    const captured = [];
    cba.onClosed((sys, meta) => { captured.push({ sys, meta }); });
    const origNow = Date.now;
    const t0 = origNow();
    Date.now = () => t0;
    cba.pollState(true, 'gemini');
    Date.now = () => t0 + 90_000; // 90s open
    cba.pollState(false, 'gemini');
    Date.now = origNow;
    await new Promise(r => setImmediate(r));
    expect(captured.length).toBe(1);
    expect(captured[0].meta.downtime_ms).toBeGreaterThanOrEqual(89_000);
  });

  test('callback que tira excepcion no rompe pollState', async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      cba.onOpen(() => { throw new Error('boom'); });
      const r = cba.pollState(true, 'gemini');
      expect(r.notified).toBe(true);
      await new Promise(resolve => setImmediate(resolve));
    } finally { console.error = orig; }
  });

  test('multiples callbacks: todos invocados', async () => {
    const counts = { a: 0, b: 0 };
    cba.onOpen(() => counts.a++);
    cba.onOpen(() => counts.b++);
    cba.pollState(true, 'gemini');
    await new Promise(r => setImmediate(r));
    expect(counts.a).toBe(1);
    expect(counts.b).toBe(1);
  });

  test('onOpen con non-function tira', () => {
    expect(() => cba.onOpen('string')).toThrow(/function/);
    expect(() => cba.onOpen(null)).toThrow(/function/);
  });

  test('onClosed con non-function tira', () => {
    expect(() => cba.onClosed(123)).toThrow(/function/);
  });
});

describe('T76 §D — buildOpenMessage / buildClosedMessage', () => {
  test('open gemini → mensaje user-friendly', () => {
    const msg = cba.buildOpenMessage('gemini', { openCount24h: 1 });
    expect(msg).toContain('IA en recovery');
    expect(msg).not.toContain('1ª vez'); // si count=1 no agrega recurrence
  });

  test('open gemini con count > 1 → marca recurrence', () => {
    const msg = cba.buildOpenMessage('gemini', { openCount24h: 3 });
    expect(msg).toContain('3ª vez');
  });

  test('open firestore → label "base de datos"', () => {
    const msg = cba.buildOpenMessage('firestore', {});
    expect(msg).toContain('base de datos');
  });

  test('open whatsapp → label "WhatsApp"', () => {
    const msg = cba.buildOpenMessage('whatsapp', {});
    expect(msg).toContain('WhatsApp');
  });

  test('open system desconocido → label = system name', () => {
    const msg = cba.buildOpenMessage('weirdsys', {});
    expect(msg).toContain('weirdsys');
  });

  test('closed con downtime <60s → segundos', () => {
    const msg = cba.buildClosedMessage('gemini', { downtime_ms: 45_000 });
    expect(msg).toContain('45s');
    expect(msg).toContain('IA OK');
  });

  test('closed con downtime >60s → minutos', () => {
    const msg = cba.buildClosedMessage('gemini', { downtime_ms: 180_000 });
    expect(msg).toContain('3min');
  });

  test('closed sin downtime → 0s', () => {
    const msg = cba.buildClosedMessage('gemini', {});
    expect(msg).toContain('0s');
  });
});

describe('T76 §E — getStats / getAllStats', () => {
  test('system sin tracking → null', () => {
    expect(cba.getStats('inexistente')).toBeNull();
  });

  test('system con transition → stats correctos', () => {
    cba.pollState(true, 'gemini');
    const s = cba.getStats('gemini');
    expect(s.system).toBe('gemini');
    expect(s.lastIsOpen).toBe(true);
    expect(s.openTransitions).toBe(1);
    expect(s.openCount24h).toBe(1);
  });

  test('multiples systems en getAllStats', () => {
    cba.pollState(true, 'gemini');
    cba.pollState(true, 'firestore');
    const all = cba.getAllStats();
    expect(all.length).toBe(2);
  });
});

describe('T76 §F — E2E escenario realista (regression test)', () => {
  test('Gemini quota exhausted: open → 5 polls open (no spam) → close 2min', async () => {
    const opens = [];
    const closes = [];
    cba.onOpen((sys, meta) => opens.push({ sys, meta }));
    cba.onClosed((sys, meta) => closes.push({ sys, meta }));

    const origNow = Date.now;
    const t0 = origNow();
    let now = t0;
    Date.now = () => now;
    try {
      // 1. Circuit abre con 503 quota
      cba.pollState(true, 'gemini', { statusCode: 503, reason: 'quota_exhausted' });
      // 2. 5 polls consecutivos en estado open (cada 30s)
      for (let i = 0; i < 5; i++) {
        now += 30_000;
        cba.pollState(true, 'gemini');
      }
      // 3. Cierre tras 2min
      now += 30_000; // total 3min open
      cba.pollState(false, 'gemini');
      await new Promise(r => setImmediate(r));

      // SOLO 1 open notificado (no spam) + 1 close notificado
      expect(opens.length).toBe(1);
      expect(closes.length).toBe(1);
      expect(opens[0].meta.statusCode).toBe(503);
      expect(closes[0].meta.downtime_ms).toBeGreaterThanOrEqual(170_000);
    } finally { Date.now = origNow; }
  });
});

describe('T76 §G — Constantes', () => {
  test('COOLDOWN_BETWEEN_NOTIFY_MS = 60s', () => {
    expect(cba.COOLDOWN_BETWEEN_NOTIFY_MS).toBe(60_000);
  });
  test('STATE_PURGE_24H_MS = 24h', () => {
    expect(cba.STATE_PURGE_24H_MS).toBe(24 * 60 * 60 * 1000);
  });
});
