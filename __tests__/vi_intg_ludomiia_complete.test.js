'use strict';

/**
 * VI-INTG-LUDOMIIA-COMPLETE -- tests ludomiia-companion-integration.js
 * 100% branches en el modulo wrapper.
 */

const LCI = require('../../miia-frontend/assets/ludomiia-companion-integration');

function makeDoc() {
  const doc = {
    createElement(tag) {
      const el = {
        tag, textContent: '', style: { cssText: '' }, children: [],
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k]; },
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) { this.children = this.children.filter(x => x !== c); },
        get firstChild() { return this.children[0] || null; },
      };
      return el;
    },
  };
  return doc;
}

function makeHost(doc) { return doc.createElement('div'); }

function makePanelFactory(opts) {
  opts = opts || {};
  return function createPanel() {
    const element = {
      tag: 'div', children: [],
      appendChild(c) { this.children.push(c); },
    };
    return {
      element,
      refresh: opts.refreshFail
        ? function() { return Promise.reject(new Error('refresh_fail')); }
        : function() { return Promise.resolve({ ok: true }); },
    };
  };
}

beforeEach(function() { LCI._resetForTest(); });

// ======== §A — init() ========

describe('VI-INTG-LUDOMIIA-COMPLETE §A -- init()', function() {
  test('A.1 sin opts: retorna initialized=true', function() {
    expect(LCI.init()).toEqual({ initialized: true });
  });

  test('A.2 con hosts: muestra placeholder en ambos', function() {
    const doc = makeDoc();
    const aiHost = makeHost(doc);
    const pHost = makeHost(doc);
    LCI.init({ aiCoachHost: aiHost, puntuacionHost: pHost, document: doc });
    expect(aiHost.children.length).toBe(1);
    expect(pHost.children.length).toBe(1);
    expect(aiHost.children[0]['data-testid']).toBe('companion-placeholder');
  });

  test('A.3 hosts null: no lanza', function() {
    expect(function() { LCI.init({ document: makeDoc() }); }).not.toThrow();
  });
});

// ======== §B — mountCompanions() ========

describe('VI-INTG-LUDOMIIA-COMPLETE §B -- mountCompanions()', function() {
  test('B.1 sin init: devuelve null/null', function() {
    expect(LCI.mountCompanions('s1')).toEqual({ aiCoach: null, puntuacion: null });
  });

  test('B.2 sessionId null: clearCompanions (placeholder)', function() {
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    LCI.init({ aiCoachHost: ai, puntuacionHost: pu, document: doc });
    const r = LCI.mountCompanions(null);
    expect(r).toEqual({ aiCoach: null, puntuacion: null });
    expect(ai.children[0]['data-testid']).toBe('companion-placeholder');
  });

  test('B.3 factories validas: monta ambos panels', function() {
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    LCI.init({
      aiCoachHost: ai, puntuacionHost: pu, document: doc,
      createAiCoachPanel: makePanelFactory(),
      createPuntuacionPanel: makePanelFactory(),
      getToken: function() { return Promise.resolve('tok'); },
      apiBase: 'http://localhost',
    });
    ai.children = []; pu.children = [];
    const r = LCI.mountCompanions('sess-abc');
    expect(r.aiCoach).not.toBeNull();
    expect(r.puntuacion).not.toBeNull();
    expect(ai.children.length).toBe(1);
    expect(pu.children.length).toBe(1);
  });

  test('B.4 factory lanza: placeholder error (rama catch)', function() {
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    LCI.init({
      aiCoachHost: ai, puntuacionHost: pu, document: doc,
      createAiCoachPanel: function() { throw new Error('factory_explode'); },
      createPuntuacionPanel: function() { throw new Error('factory_explode'); },
      getToken: function() { return Promise.resolve('tok'); },
      apiBase: '',
    });
    ai.children = []; pu.children = [];
    const r = LCI.mountCompanions('sess-fail');
    expect(r.aiCoach).toBeNull();
    expect(r.puntuacion).toBeNull();
    expect(ai.children[0]['data-testid']).toBe('companion-placeholder');
  });

  test('B.5 factory null: placeholder no disponible (rama else)', function() {
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    LCI.init({ aiCoachHost: ai, puntuacionHost: pu, document: doc });
    ai.children = []; pu.children = [];
    const r = LCI.mountCompanions('sess-nofactory');
    expect(r.aiCoach).toBeNull();
    expect(r.puntuacion).toBeNull();
    expect(ai.children[0]['data-testid']).toBe('companion-placeholder');
  });

  test('B.6 panel.refresh falla: warn, no lanza', async function() {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(function() {});
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    LCI.init({
      aiCoachHost: ai, puntuacionHost: pu, document: doc,
      createAiCoachPanel: makePanelFactory({ refreshFail: true }),
      createPuntuacionPanel: makePanelFactory({ refreshFail: true }),
      getToken: function() { return Promise.resolve('tok'); },
      apiBase: '',
    });
    ai.children = []; pu.children = [];
    LCI.mountCompanions('sess-refreshfail');
    await new Promise(function(res) { setTimeout(res, 20); });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refresh fail'), 'refresh_fail');
    warnSpy.mockRestore();
  });

  test('B.7 panel sin metodo refresh: no lanza', function() {
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    const factNoRefresh = function() {
      return { element: { tag: 'div', children: [], appendChild: function() {} } };
    };
    LCI.init({
      aiCoachHost: ai, puntuacionHost: pu, document: doc,
      createAiCoachPanel: factNoRefresh,
      createPuntuacionPanel: factNoRefresh,
    });
    ai.children = []; pu.children = [];
    expect(function() { LCI.mountCompanions('sess-norefresh'); }).not.toThrow();
  });

  test('B.8 hosts null con factories: no lanza', function() {
    LCI.init({
      aiCoachHost: null, puntuacionHost: null, document: makeDoc(),
      createAiCoachPanel: makePanelFactory(),
      createPuntuacionPanel: makePanelFactory(),
    });
    expect(function() { LCI.mountCompanions('sess-nullhost'); }).not.toThrow();
  });
});

// ======== §C — clearCompanions() ========

describe('VI-INTG-LUDOMIIA-COMPLETE §C -- clearCompanions()', function() {
  test('C.1 sin init: no lanza', function() {
    expect(function() { LCI.clearCompanions(); }).not.toThrow();
  });

  test('C.2 con hosts: pone placeholders en ambos', function() {
    const doc = makeDoc();
    const ai = makeHost(doc);
    const pu = makeHost(doc);
    LCI.init({ aiCoachHost: ai, puntuacionHost: pu, document: doc });
    ai.children = []; pu.children = [];
    LCI.clearCompanions();
    expect(ai.children[0]['data-testid']).toBe('companion-placeholder');
    expect(pu.children[0]['data-testid']).toBe('companion-placeholder');
  });
});

// ======== §D — _placeholder() ========

describe('VI-INTG-LUDOMIIA-COMPLETE §D -- _placeholder()', function() {
  test('D.1 host null: no lanza', function() {
    expect(function() { LCI._placeholder(null, 'test', makeDoc()); }).not.toThrow();
  });

  test('D.2 document null: no lanza', function() {
    const doc = makeDoc();
    const host = makeHost(doc);
    expect(function() { LCI._placeholder(host, 'test', null); }).not.toThrow();
  });

  test('D.3 normal: crea p con textContent correcto', function() {
    const doc = makeDoc();
    const host = makeHost(doc);
    LCI._placeholder(host, 'Sesion inactiva', doc);
    expect(host.children[0].textContent).toBe('Sesion inactiva');
  });
});
