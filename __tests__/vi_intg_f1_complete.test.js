'use strict';

/**
 * VI-INTG-F1-COMPLETE -- tests f1-companion-integration.js
 * 100% branches en el modulo wrapper.
 */

const FCI = require('../../miia-frontend/assets/f1-companion-integration');

function makeSectorsPanel(opts) {
  opts = opts || {};
  return {
    element: { tag: 'div', children: [], appendChild: function(c) { this.children.push(c); } },
    loadSectors: opts.fail
      ? function() { return Promise.reject(new Error('sectors_fail')); }
      : (opts.noLoad ? undefined : function() { return Promise.resolve({ ok: true }); }),
  };
}

function makeGapPanel(opts) {
  opts = opts || {};
  return {
    element: { tag: 'div', children: [], appendChild: function(c) { this.children.push(c); } },
    loadIntervals: opts.fail
      ? function() { return Promise.reject(new Error('gap_fail')); }
      : (opts.noLoad ? undefined : function() { return Promise.resolve({ ok: true }); }),
  };
}

function makeTelemetryPanel(opts) {
  opts = opts || {};
  return {
    element: { tag: 'div', children: [], appendChild: function(c) { this.children.push(c); } },
    loadTelemetry: opts.fail
      ? function() { return Promise.reject(new Error('telemetry_fail')); }
      : (opts.noLoad ? undefined : function() { return Promise.resolve({ ok: true }); }),
  };
}

function makeMount() {
  return { innerHTML: '', children: [], appendChild: function(c) { this.children.push(c); } };
}

function makeFactories(sectorsOpts, gapOpts, telemetryOpts) {
  return {
    createSectorsPanel:   function() { return makeSectorsPanel(sectorsOpts); },
    createGapPanel:       function() { return makeGapPanel(gapOpts); },
    createTelemetryPanel: function() { return makeTelemetryPanel(telemetryOpts); },
  };
}

beforeEach(function() { FCI._resetForTest(); });

// ======== §A — init() ========

describe('VI-INTG-F1-COMPLETE §A -- init()', function() {
  test('A.1 sin opts: retorna initialized=true', function() {
    expect(FCI.init()).toEqual({ initialized: true });
  });

  test('A.2 con opts: almacena config', function() {
    const sm = makeMount(), gm = makeMount(), tm = makeMount();
    const r = FCI.init({ sectorsMount: sm, gapMount: gm, telemetryMount: tm, apiBase: 'http://x' });
    expect(r).toEqual({ initialized: true });
  });
});

// ======== §B — mountPanels() ========

describe('VI-INTG-F1-COMPLETE §B -- mountPanels()', function() {
  test('B.1 sin init: devuelve null/null/null', function() {
    expect(FCI.mountPanels()).toEqual({ sectors: null, gap: null, telemetry: null });
  });

  test('B.2 factories validas: monta los 3 panels', function() {
    const sm = makeMount(), gm = makeMount(), tm = makeMount();
    FCI.init(Object.assign({ sectorsMount: sm, gapMount: gm, telemetryMount: tm }, makeFactories()));
    const r = FCI.mountPanels();
    expect(r.sectors).not.toBeNull();
    expect(r.gap).not.toBeNull();
    expect(r.telemetry).not.toBeNull();
    expect(sm.children.length).toBe(1);
    expect(gm.children.length).toBe(1);
    expect(tm.children.length).toBe(1);
  });

  test('B.3 factory null: retorna null para ese panel', function() {
    FCI.init({ createSectorsPanel: null, createGapPanel: null, createTelemetryPanel: null });
    const r = FCI.mountPanels();
    expect(r.sectors).toBeNull();
    expect(r.gap).toBeNull();
    expect(r.telemetry).toBeNull();
  });

  test('B.4 factory lanza: retorna null (rama catch)', function() {
    FCI.init({
      createSectorsPanel:   function() { throw new Error('boom_s'); },
      createGapPanel:       function() { throw new Error('boom_g'); },
      createTelemetryPanel: function() { throw new Error('boom_t'); },
    });
    const r = FCI.mountPanels();
    expect(r.sectors).toBeNull();
    expect(r.gap).toBeNull();
    expect(r.telemetry).toBeNull();
  });

  test('B.5 host null: no lanza aunque factory sea valida', function() {
    FCI.init(Object.assign({ sectorsMount: null, gapMount: null, telemetryMount: null }, makeFactories()));
    expect(function() { FCI.mountPanels(); }).not.toThrow();
  });

  test('B.6 panel.element null: no lanza con host', function() {
    const sm = makeMount();
    const factNoElement = function() { return { element: null, loadSectors: function() { return Promise.resolve(); } }; };
    FCI.init({ sectorsMount: sm, createSectorsPanel: factNoElement });
    expect(function() { FCI.mountPanels(); }).not.toThrow();
  });

  test('B.7 panel sin metodo load: no lanza', function() {
    FCI.init(Object.assign({}, makeFactories({noLoad:true}, {noLoad:true}, {noLoad:true})));
    expect(function() { FCI.mountPanels(); }).not.toThrow();
  });

  test('B.8 panel.load falla: warn, no lanza', async function() {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(function() {});
    FCI.init(Object.assign({}, makeFactories({fail:true}, {fail:true}, {fail:true})));
    FCI.mountPanels();
    await new Promise(function(res) { setTimeout(res, 20); });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sectors'), 'sectors_fail');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gap'), 'gap_fail');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('telemetry'), 'telemetry_fail');
    warnSpy.mockRestore();
  });
});

// ======== §C — refreshAll() ========

describe('VI-INTG-F1-COMPLETE §C -- refreshAll()', function() {
  test('C.1 sin panels montados: no lanza', function() {
    FCI.init({});
    expect(function() { FCI.refreshAll(); }).not.toThrow();
  });

  test('C.2 panels montados: llama load en los 3', function() {
    const calls = { s: 0, g: 0, t: 0 };
    FCI.init({
      createSectorsPanel:   function() { return { element: null, loadSectors:   function() { calls.s++; return Promise.resolve(); } }; },
      createGapPanel:       function() { return { element: null, loadIntervals: function() { calls.g++; return Promise.resolve(); } }; },
      createTelemetryPanel: function() { return { element: null, loadTelemetry: function() { calls.t++; return Promise.resolve(); } }; },
    });
    FCI.mountPanels(); // mounts + first load
    FCI.refreshAll();
    expect(calls.s).toBe(2); // mountPanels + refreshAll
    expect(calls.g).toBe(2);
    expect(calls.t).toBe(2);
  });

  test('C.3 refresh falla: warn, no lanza', async function() {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(function() {});
    FCI.init(Object.assign({}, makeFactories({fail:true}, {fail:true}, {fail:true})));
    FCI.mountPanels();
    FCI.refreshAll();
    await new Promise(function(res) { setTimeout(res, 20); });
    // warn called al menos 2 veces por canal (mount + refresh)
    expect(warnSpy.mock.calls.some(function(c) { return c[0].includes('sectors'); })).toBe(true);
    warnSpy.mockRestore();
  });
});
