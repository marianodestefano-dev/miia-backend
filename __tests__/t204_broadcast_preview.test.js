'use strict';

const {
  validateBroadcastMessage, personalizeMessage, generatePreview,
  estimateSendCost, validateRecipients,
  MAX_MESSAGE_LENGTH, MAX_PREVIEW_RECIPIENTS, PREVIEW_PLACEHOLDER,
} = require('../core/broadcast_preview');

describe('validateBroadcastMessage', function() {
  test('lanza si message undefined', function() {
    expect(function() { validateBroadcastMessage(undefined); }).toThrow('requerido');
  });
  test('lanza si message vacio', function() {
    expect(function() { validateBroadcastMessage('   '); }).toThrow('vacio');
  });
  test('lanza si message muy largo', function() {
    var long = 'a'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(function() { validateBroadcastMessage(long); }).toThrow(String(MAX_MESSAGE_LENGTH));
  });
  test('acepta mensaje valido', function() {
    var r = validateBroadcastMessage('Hola como estas');
    expect(r.valid).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('personalizeMessage', function() {
  test('reemplaza [NOMBRE] con nombre del contacto', function() {
    var r = personalizeMessage('Hola [NOMBRE]!', { name: 'Juan' });
    expect(r).toBe('Hola Juan!');
  });
  test('usa Cliente si no hay nombre', function() {
    var r = personalizeMessage('Hola [NOMBRE]!', {});
    expect(r).toBe('Hola Cliente!');
  });
  test('reemplaza multiples placeholders', function() {
    var r = personalizeMessage('Hola [NOMBRE] tu numero es [PHONE]', { name: 'Maria', phone: '+54111' });
    expect(r).toContain('Maria');
    expect(r).toContain('+54111');
  });
  test('retorna string vacio si message null', function() {
    expect(personalizeMessage(null, {})).toBe('');
  });
});

describe('generatePreview', function() {
  test('lanza si message undefined', function() {
    expect(function() { generatePreview(undefined, []); }).toThrow('requerido');
  });
  test('lanza si recipients no es array', function() {
    expect(function() { generatePreview('hola', 'no-array'); }).toThrow('array');
  });
  test('genera preview con campos correctos', function() {
    var recipients = [
      { phone: '+1111', name: 'Ana' },
      { phone: '+2222', name: 'Bob' },
    ];
    var r = generatePreview('Hola [NOMBRE]', recipients);
    expect(r.originalMessage).toBe('Hola [NOMBRE]');
    expect(r.totalRecipients).toBe(2);
    expect(r.hasPersonalization).toBe(true);
    expect(r.previews.length).toBe(2);
    expect(r.previews[0].personalizedMessage).toBe('Hola Ana');
  });
  test('limita previews a MAX_PREVIEW_RECIPIENTS', function() {
    var recipients = Array.from({ length: 10 }, function(_, i) { return { phone: '+' + (1000000 + i) }; });
    var r = generatePreview('Hola', recipients);
    expect(r.previewCount).toBe(MAX_PREVIEW_RECIPIENTS);
    expect(r.totalRecipients).toBe(10);
  });
  test('detecta ausencia de personalizacion', function() {
    var r = generatePreview('Mensaje sin placeholders', [{ phone: '+1111' }]);
    expect(r.hasPersonalization).toBe(false);
  });
  test('incluye estimatedSendTimeMs', function() {
    var r = generatePreview('Hola', [{ phone: '+1111' }, { phone: '+2222' }]);
    expect(r.estimatedSendTimeMs).toBe(2 * 1500);
  });
});

describe('estimateSendCost', function() {
  test('lanza si recipientCount negativo', function() {
    expect(function() { estimateSendCost(-1); }).toThrow('>= 0');
  });
  test('calcula costo basico', function() {
    var r = estimateSendCost(100);
    expect(r.estimatedCost).toBe(1.00);
    expect(r.recipientCount).toBe(100);
    expect(r.currency).toBe('USD');
  });
  test('multiplica por 1.5 si hay media', function() {
    var r = estimateSendCost(100, true);
    expect(r.estimatedCost).toBe(1.50);
    expect(r.hasMedia).toBe(true);
  });
  test('costo 0 para 0 recipients', function() {
    var r = estimateSendCost(0);
    expect(r.estimatedCost).toBe(0);
  });
});

describe('validateRecipients', function() {
  test('lanza si recipients no es array', function() {
    expect(function() { validateRecipients('no-array'); }).toThrow('array');
  });
  test('separa validos de invalidos', function() {
    var recipients = ['+541155667788', 'numero-invalido', '+1234567890'];
    var r = validateRecipients(recipients);
    expect(r.validCount).toBe(2);
    expect(r.invalidCount).toBe(1);
  });
  test('acepta objetos con phone', function() {
    var recipients = [{ phone: '+541155667788', name: 'Juan' }];
    var r = validateRecipients(recipients);
    expect(r.validCount).toBe(1);
  });
  test('retorna todos invalidos si ningun formato correcto', function() {
    var r = validateRecipients(['abc', '123']);
    expect(r.invalidCount).toBe(2);
    expect(r.validCount).toBe(0);
  });
});

describe('PREVIEW constants', function() {
  test('MAX_MESSAGE_LENGTH es 4096', function() { expect(MAX_MESSAGE_LENGTH).toBe(4096); });
  test('MAX_PREVIEW_RECIPIENTS es 5', function() { expect(MAX_PREVIEW_RECIPIENTS).toBe(5); });
  test('PREVIEW_PLACEHOLDER es [NOMBRE]', function() { expect(PREVIEW_PLACEHOLDER).toBe('[NOMBRE]'); });
});
