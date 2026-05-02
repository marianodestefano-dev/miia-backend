'use strict';

const path = require('path');
const integration = require(path.resolve(__dirname, '../../miia-frontend/assets/ludomiia-integration.js'));

class FakeElement {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.firstChild = null;
    this.style = {};
    this.dataset = {};
    this._innerHTML = '';
    this.className = '';
  }
  appendChild(child) {
    this.children.push(child);
    if (!this.firstChild) this.firstChild = child;
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    if (this.children.length === 0) this.firstChild = null;
    else this.firstChild = this.children[0];
    return child;
  }
  set innerHTML(v) { this._innerHTML = v; }
  get innerHTML() { return this._innerHTML; }
}

const fakeDoc = { createElement: (tag) => new FakeElement(tag) };
function makeHost() { return new FakeElement('div'); }

describe('showUpgradeCard', () => {
  test('crea card con CTA Contratar', () => {
    const host = makeHost();
    integration.showUpgradeCard(host, { document: fakeDoc });
    expect(host.children.length).toBe(1);
    expect(host.children[0].dataset.testid).toBe('ludomiia-upgrade-card');
    expect(host.children[0].innerHTML).toContain('precios.html#ludomiia');
  });
  test('host null no rompe', () => {
    expect(() => integration.showUpgradeCard(null)).not.toThrow();
  });
  test('limpia children previos', () => {
    const host = makeHost();
    host.appendChild(new FakeElement('p'));
    host.appendChild(new FakeElement('span'));
    integration.showUpgradeCard(host, { document: fakeDoc });
    expect(host.children.length).toBe(1);
  });
  test('usa global document si no hay opts.document', () => {
    global.document = fakeDoc;
    const host = makeHost();
    integration.showUpgradeCard(host);
    expect(host.children.length).toBe(1);
    delete global.document;
  });
});

describe('_clearHost', () => {
  test('null host noop', () => {
    expect(() => integration._clearHost(null)).not.toThrow();
  });
  test('borra children', () => {
    const host = makeHost();
    host.appendChild(new FakeElement('a'));
    host.appendChild(new FakeElement('b'));
    integration._clearHost(host);
    expect(host.children.length).toBe(0);
    expect(host.firstChild).toBe(null);
  });
});

describe('mountSelector', () => {
  test('throw sin host', async () => {
    await expect(integration.mountSelector(null, {})).rejects.toThrow('host');
  });
  test('throw sin createSelectorJuegoPanel', async () => {
    await expect(integration.mountSelector(makeHost(), {})).rejects.toThrow('selector-juego.js');
  });
  test('monta y refresh', async () => {
    const host = makeHost();
    let refreshed = false;
    const factory = jest.fn(() => ({ element: new FakeElement('div'), refresh: async () => { refreshed = true; } }));
    await integration.mountSelector(host, {
      createSelectorJuegoPanel: factory,
      fetchGames: async () => [],
      getToken: async () => 'tok',
      isOwner: true,
    });
    expect(factory).toHaveBeenCalled();
    expect(host.children.length).toBe(1);
    expect(refreshed).toBe(true);
  });
  test('panel sin refresh no falla', async () => {
    const host = makeHost();
    await integration.mountSelector(host, {
      createSelectorJuegoPanel: () => ({ element: new FakeElement('div') }),
      fetchGames: async () => [],
      getToken: async () => 'tok',
    });
    expect(host.children.length).toBe(1);
  });
  test('refresh throw es swallowed', async () => {
    const host = makeHost();
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await integration.mountSelector(host, {
      createSelectorJuegoPanel: () => ({ element: new FakeElement('div'), refresh: async () => { throw new Error('boom'); } }),
      fetchGames: async () => [],
      getToken: async () => 'tok',
    });
    expect(host.children.length).toBe(1);
    spy.mockRestore();
  });
  test('onSelect default es noop', async () => {
    let cap;
    const factory = jest.fn((opts) => { cap = opts; return { element: new FakeElement('div') }; });
    await integration.mountSelector(makeHost(), {
      createSelectorJuegoPanel: factory,
      fetchGames: async () => [],
      getToken: async () => 'tok',
    });
    expect(() => cap.onSelect({ id: 'g1' })).not.toThrow();
  });
  test('onSelect custom invocado', async () => {
    let cap; const fn = jest.fn();
    const factory = jest.fn((opts) => { cap = opts; return { element: new FakeElement('div') }; });
    await integration.mountSelector(makeHost(), {
      createSelectorJuegoPanel: factory, fetchGames: async () => [], getToken: async () => 'tok', onSelect: fn,
    });
    cap.onSelect({ id: 'g1' });
    expect(fn).toHaveBeenCalled();
  });
  test('onAddGame default usa locationHash', async () => {
    let cap; const hashFn = jest.fn();
    const factory = jest.fn((opts) => { cap = opts; return { element: new FakeElement('div') }; });
    await integration.mountSelector(makeHost(), {
      createSelectorJuegoPanel: factory, fetchGames: async () => [], getToken: async () => 'tok', locationHash: hashFn,
    });
    cap.onAddGame();
    expect(hashFn).toHaveBeenCalledWith('#ludomiia/add-game');
  });
  test('onAddGame default sin locationHash noop', async () => {
    let cap;
    const factory = jest.fn((opts) => { cap = opts; return { element: new FakeElement('div') }; });
    await integration.mountSelector(makeHost(), {
      createSelectorJuegoPanel: factory, fetchGames: async () => [], getToken: async () => 'tok',
    });
    expect(() => cap.onAddGame()).not.toThrow();
  });
  test('onAddGame custom invocado', async () => {
    let cap; const fn = jest.fn();
    const factory = jest.fn((opts) => { cap = opts; return { element: new FakeElement('div') }; });
    await integration.mountSelector(makeHost(), {
      createSelectorJuegoPanel: factory, fetchGames: async () => [], getToken: async () => 'tok', onAddGame: fn,
    });
    cap.onAddGame();
    expect(fn).toHaveBeenCalled();
  });
});

describe('mountJugar', () => {
  test('throw sin host', async () => {
    await expect(integration.mountJugar(null, {}, {})).rejects.toThrow('host');
  });
  test('throw sin createJugarConMiiaPanel', async () => {
    await expect(integration.mountJugar(makeHost(), {}, { id: 'g1' })).rejects.toThrow('jugar-con-miia');
  });
  test('throw sin game', async () => {
    await expect(integration.mountJugar(makeHost(), {
      createJugarConMiiaPanel: () => ({ element: new FakeElement('div') }),
    })).rejects.toThrow('game');
  });
  test('monta con session.id', async () => {
    let cap; let refreshed = false;
    await integration.mountJugar(makeHost(), {
      createJugarConMiiaPanel: (o) => { cap = o; return { element: new FakeElement('div'), refresh: async () => { refreshed = true; } }; },
      createSession: async () => ({ id: 'sess1' }),
      getToken: async () => 'tok',
    }, { id: 'g1' });
    expect(cap.sessionId).toBe('sess1');
    expect(refreshed).toBe(true);
  });
  test('usa sessionId si no hay id', async () => {
    let cap;
    await integration.mountJugar(makeHost(), {
      createJugarConMiiaPanel: (o) => { cap = o; return { element: new FakeElement('div') }; },
      createSession: async () => ({ sessionId: 'sess2' }),
      getToken: async () => 'tok',
    }, { id: 'g1' });
    expect(cap.sessionId).toBe('sess2');
  });
  test('refresh throw swallowed', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const host = makeHost();
    await integration.mountJugar(host, {
      createJugarConMiiaPanel: () => ({ element: new FakeElement('div'), refresh: async () => { throw new Error('boom'); } }),
      createSession: async () => ({ id: 's1' }),
      getToken: async () => 'tok',
    }, { id: 'g1' });
    expect(host.children.length).toBe(1);
    spy.mockRestore();
  });
  test('panel sin refresh no falla', async () => {
    const host = makeHost();
    await integration.mountJugar(host, {
      createJugarConMiiaPanel: () => ({ element: new FakeElement('div') }),
      createSession: async () => ({ id: 's1' }),
      getToken: async () => 'tok',
    }, { id: 'g1' });
    expect(host.children.length).toBe(1);
  });
  test('createSession throw -> fallback selector', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const host = makeHost();
    await integration.mountJugar(host, {
      createJugarConMiiaPanel: () => ({ element: new FakeElement('div') }),
      createSelectorJuegoPanel: () => ({ element: new FakeElement('div') }),
      createSession: async () => { throw new Error('500'); },
      fetchGames: async () => [],
      getToken: async () => 'tok',
    }, { id: 'g1' });
    expect(host.children.length).toBe(1);
    spy.mockRestore();
  });
  test('onEnd dispara mountSelector', async () => {
    let cap; let count = 0;
    await integration.mountJugar(makeHost(), {
      createJugarConMiiaPanel: (o) => { cap = o; return { element: new FakeElement('div') }; },
      createSelectorJuegoPanel: () => { count++; return { element: new FakeElement('div') }; },
      createSession: async () => ({ id: 's1' }),
      fetchGames: async () => [],
      getToken: async () => 'tok',
    }, { id: 'g1' });
    await cap.onEnd();
    expect(count).toBe(1);
  });
});

describe('init', () => {
  test('throw sin host', async () => {
    await expect(integration.init({})).rejects.toThrow('host');
  });
  test('product inactive -> upgrade', async () => {
    global.document = fakeDoc;
    const host = makeHost();
    const r = await integration.init({ host, isProductActive: async () => false });
    expect(r.mounted).toBe(false);
    expect(r.reason).toBe('product_inactive');
    expect(host.children.length).toBe(1);
    delete global.document;
  });
  test('isProductActive no funcion -> upgrade', async () => {
    global.document = fakeDoc;
    const host = makeHost();
    const r = await integration.init({ host });
    expect(r.mounted).toBe(false);
    delete global.document;
  });
  test('product active -> mountSelector', async () => {
    const host = makeHost();
    const r = await integration.init({
      host,
      isProductActive: async () => true,
      createSelectorJuegoPanel: () => ({ element: new FakeElement('div') }),
      fetchGames: async () => [],
      getToken: async () => 'tok',
    });
    expect(r.mounted).toBe(true);
    expect(host.children.length).toBe(1);
  });
});

describe('FINAL push 100 percent branches', () => {
  test('mountSelector onStart callback dispara mountJugar', async () => {
    let cap;
    let jugarCalled = false;
    await integration.mountSelector(makeHost(), {
      createSelectorJuegoPanel: (o) => { cap = o; return { element: new FakeElement('div') }; },
      createJugarConMiiaPanel: () => { jugarCalled = true; return { element: new FakeElement('div') }; },
      createSession: async () => ({ id: 'sess-onstart' }),
      fetchGames: async () => [],
      getToken: async () => 'tok',
    });
    await cap.onStart({ id: 'g1' });
    expect(jugarCalled).toBe(true);
  });
});

describe('init opts undefined branch', () => {
  test('init() sin args -> rechaza por host requerido', async () => {
    await expect(integration.init()).rejects.toThrow('host');
  });
});
