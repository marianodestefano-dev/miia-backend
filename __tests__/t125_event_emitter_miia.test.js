'use strict';
const { MiiaEventEmitter, VALID_EVENTS, MAX_LISTENERS } = require('../core/event_emitter_miia');

describe('VALID_EVENTS y MAX_LISTENERS', () => {
  test('tiene al menos 10 eventos validos', () => {
    expect(VALID_EVENTS.length).toBeGreaterThanOrEqual(10);
    expect(VALID_EVENTS).toContain('message:received');
    expect(VALID_EVENTS).toContain('lead:classified');
  });
  test('MAX_LISTENERS = 20', () => {
    expect(MAX_LISTENERS).toBe(20);
  });
});

describe('on — validacion', () => {
  let ee;
  beforeEach(() => { ee = new MiiaEventEmitter(); });

  test('lanza con evento invalido', () => {
    expect(() => ee.on('evento:inexistente', () => {})).toThrow('evento invalido');
  });
  test('lanza con fn no funcion', () => {
    expect(() => ee.on('message:received', 'no soy funcion')).toThrow('listener debe ser funcion');
  });
  test('retorna id numerico', () => {
    const id = ee.on('message:received', () => {});
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });
  test('lanza si se superan MAX_LISTENERS', () => {
    for (let i = 0; i < MAX_LISTENERS; i++) {
      ee.on('message:received', () => {});
    }
    expect(() => ee.on('message:received', () => {})).toThrow('max listeners');
  });
});

describe('emit', () => {
  let ee;
  beforeEach(() => { ee = new MiiaEventEmitter(); });

  test('llama al listener con data', () => {
    const fn = jest.fn();
    ee.on('lead:classified', fn);
    ee.emit('lead:classified', { phone: '+1234' });
    expect(fn).toHaveBeenCalledWith({ phone: '+1234' });
  });
  test('retorna 0 si no hay listeners', () => {
    expect(ee.emit('owner:connected')).toBe(0);
  });
  test('retorna cantidad de listeners invocados', () => {
    ee.on('message:sent', () => {});
    ee.on('message:sent', () => {});
    expect(ee.emit('message:sent')).toBe(2);
  });
  test('no lanza si listener lanza (error aislado)', () => {
    ee.on('health:degraded', () => { throw new Error('boom'); });
    expect(() => ee.emit('health:degraded')).not.toThrow();
  });
  test('evento invalido lanza', () => {
    expect(() => ee.emit('no:existe')).toThrow('evento invalido');
  });
});

describe('once', () => {
  let ee;
  beforeEach(() => { ee = new MiiaEventEmitter(); });

  test('se invoca solo una vez', () => {
    const fn = jest.fn();
    ee.once('broadcast:completed', fn);
    ee.emit('broadcast:completed');
    ee.emit('broadcast:completed');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  test('listener once se elimina despues del primer emit', () => {
    ee.once('consent:changed', () => {});
    ee.emit('consent:changed');
    expect(ee.listenerCount('consent:changed')).toBe(0);
  });
});

describe('off y listenerCount', () => {
  let ee;
  beforeEach(() => { ee = new MiiaEventEmitter(); });

  test('off elimina listener por id', () => {
    const id = ee.on('message:received', () => {});
    expect(ee.listenerCount('message:received')).toBe(1);
    ee.off(id);
    expect(ee.listenerCount('message:received')).toBe(0);
  });
  test('off con id inexistente no lanza', () => {
    expect(() => ee.off(9999)).not.toThrow();
  });
  test('listenerCount 0 para evento sin listeners', () => {
    expect(ee.listenerCount('owner:connected')).toBe(0);
  });
});

describe('removeAllListeners', () => {
  let ee;
  beforeEach(() => { ee = new MiiaEventEmitter(); });

  test('remueve todos los listeners de un evento', () => {
    ee.on('lead:updated', () => {});
    ee.on('lead:updated', () => {});
    ee.removeAllListeners('lead:updated');
    expect(ee.listenerCount('lead:updated')).toBe(0);
  });
  test('removeAllListeners sin arg limpia todo', () => {
    ee.on('message:received', () => {});
    ee.on('lead:classified', () => {});
    ee.removeAllListeners();
    expect(ee.listenerCount('message:received')).toBe(0);
    expect(ee.listenerCount('lead:classified')).toBe(0);
  });
});
